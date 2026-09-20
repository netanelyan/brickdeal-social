// Which places a themed deck should be about — and nothing else.
//
// This module answers "what are the five best-known hiking routes in the
// Dolomites", "which museums in Prague", "where does Osaka eat". It does NOT
// answer what goes on the slides. That distinction is the whole design:
//
//   OpenStreetMap and Wikidata are crowd-sourced. They are excellent at
//   enumerating what exists and roughly how well known it is, and they are not
//   the publisher of any fact about it. So a place's OSM tags select it and
//   rank it, and then every SENTENCE that reaches a slide has to come from the
//   place's own official page, quoted verbatim, exactly as every other post in
//   this pipeline works.
//
//   The one documented exception is a structured measurement — an elevation, a
//   length, a founding year — read straight off a Wikidata property by
//   deck/facts.js. There is no page to quote for the height of a mountain, and
//   a summit deck with no heights on it was the result. A property is not
//   prose: nothing is written, the value is copied with its unit, and the QID
//   travels with it. Prose about a place still needs its official page.
//
// What travels out of here is therefore a shortlist: a name, a location, a
// Wikidata id, and — the part that matters downstream — the official website
// Wikidata records for it (P856), which is the domain a claim about that place
// is allowed to be quoted from.
//
// The precedent for a dataset source living alongside the feeds is climate.js:
// Open-Meteo is queried, not subscribed to, and it earns its place by answering
// a question no feed can. Same here.

// Mirrors, not one endpoint.
//
// The main instance is free, popular and rate-limited, and "429 Too Many
// Requests" arrives often enough that retrying the same host is not a strategy
// — it is the host telling you to go somewhere else. These run the same data
// and the same query language, so falling through costs nothing but a second.
const OVERPASS_MIRRORS = (process.env.OVERPASS_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .concat([
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ]);
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

// Which claims are worth keeping off each entity, declared where the slides
// that use them are declared rather than here.
import { WANTED_PROPS, ENTITY_PROPS } from '../deck/facts.js';

// Both services ask for a real user agent and mean it — Nominatim returns 403
// to the default fetch UA, and the failure looks like the place not existing.
const UA = process.env.PLACES_USER_AGENT || 'tiyul-plus/1.0 (travel content pipeline; contact via www.tiyulplus.com)';

export class PlacesError extends Error {
  constructor(message, { step } = {}) {
    super(message);
    this.step = step;
  }
}

/**
 * What kinds of deck we know how to gather candidates for.
 *
 * Each is a fragment of Overpass QL rather than a free-text query, because the
 * tags are what make the shortlist defensible: `route=hiking` is a thing OSM
 * has a definition for, "nice walks" is not.
 *
 * `needsWikidata` is where the standard bites. A place with no Wikidata entry
 * has no official-website record either, so nothing about it could be quoted
 * from an authority — it would be a slide with a name and no facts. Kinds
 * where that is common are still declared, so the shortfall is visible rather
 * than looking like an empty region.
 */
export const KINDS = {
  trail: {
    he: 'מסלולים',
    q: (bbox) => `relation["route"="hiking"]["name"]["wikidata"](${bbox});`,
  },
  museum: {
    he: 'מוזיאונים',
    q: (bbox) => `nwr["tourism"="museum"]["name"]["wikidata"](${bbox});`,
  },
  attraction: {
    he: 'אטרקציות',
    q: (bbox) =>
      `nwr["tourism"~"^(attraction|viewpoint|theme_park|zoo|aquarium)$"]["name"]["wikidata"](${bbox});` +
      `nwr["historic"~"^(castle|monument|memorial|ruins)$"]["name"]["wikidata"](${bbox});`,
  },
  beach: {
    he: 'חופים',
    q: (bbox) => `nwr["natural"="beach"]["name"]["wikidata"](${bbox});`,
  },
  food: {
    he: 'אוכל',
    // Restaurants are rarely in Wikidata, so this leans on markets and food
    // halls, which are — and which are what a "where to eat" slide should be
    // pointing at anyway rather than one restaurant's table.
    q: (bbox) =>
      `nwr["amenity"="marketplace"]["name"]["wikidata"](${bbox});` +
      `nwr["shop"="deli"]["name"]["wikidata"](${bbox});` +
      `nwr["amenity"="restaurant"]["name"]["wikidata"](${bbox});`,
  },
  mountain: {
    he: 'הרים',
    // Peaks, and the ranges themselves. A deck about "mountains in Italy" wants
    // the Dolomites as much as it wants any single summit, and OSM files a
    // range as a natural=ridge or a place=region rather than a peak.
    q: (bbox) =>
      `nwr["natural"="peak"]["name"]["wikidata"](${bbox});` +
      `nwr["natural"="ridge"]["name"]["wikidata"](${bbox});`,
  },
  waterfall: {
    he: 'מפלים',
    q: (bbox) => `nwr["waterway"="waterfall"]["name"]["wikidata"](${bbox});`,
  },
};

export const kindIds = () => Object.keys(KINDS);

// The public Overpass instance answers 429 when it is busy and 504 when a query
// outlives its slot, and both are routine rather than exceptional — a first
// attempt failing says nothing about whether the query is good. Wikidata and
// Nominatim are steadier but rate-limit the same way under a burst.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, { step, attempts = 3, ...init } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(Number(process.env.PLACES_TIMEOUT_MS || 45_000)),
      });
    } catch (e) {
      last = new PlacesError(`${step}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, { step });
      if (attempt < attempts) await wait(attempt * 5000);
      continue;
    }

    if (RETRY_STATUS.has(res.status) && attempt < attempts) {
      // Honour Retry-After when it is offered; it is the server telling us how
      // long it wants, and guessing shorter is how a caller gets banned.
      const after = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : attempt * 8000);
      last = new PlacesError(`${step}: HTTP ${res.status}`, { step });
      continue;
    }
    if (!res.ok) throw new PlacesError(`${step}: HTTP ${res.status}`, { step });

    try {
      return await res.json();
    } catch {
      throw new PlacesError(`${step}: response was not JSON`, { step });
    }
  }
  throw last;
}

/**
 * A free-text region ("the Dolomites", "Prague", "Kyoto") to a bounding box.
 *
 * Nominatim rather than a hardcoded table, so a deck can be asked for anywhere.
 * The box it returns for a mountain range is generous, which is correct here —
 * the ranking step is what narrows a wide box down to five known places.
 */
export async function resolveArea(name) {
  const url = `${NOMINATIM}?${new URLSearchParams({ q: name, format: 'jsonv2', limit: '1' })}`;
  const rows = await json(url, { step: 'resolve_area' });
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit?.boundingbox) throw new PlacesError(`no such place: ${name}`, { step: 'resolve_area' });

  // Nominatim gives [south, north, west, east]; Overpass wants s,w,n,e.
  const [s, n, w, e] = hit.boundingbox.map(Number);
  return {
    query: name,
    displayName: hit.display_name,
    bbox: `${s},${w},${n},${e}`,
    area: Number(hit.boundingbox[1]) - Number(hit.boundingbox[0]),
  };
}

/** Everything of one kind inside a box, as OSM knows it. */
export async function osmPlaces(bbox, kind) {
  const spec = KINDS[kind];
  if (!spec) throw new PlacesError(`unknown kind: ${kind}`, { step: 'overpass' });

  const ql = `[out:json][timeout:60];(${spec.q(bbox)});out tags center ${Number(process.env.PLACES_MAX || 200)};`;

  // Each mirror gets one attempt rather than three: a busy instance stays busy
  // for minutes, and the next host is a better bet than the next retry.
  //
  // An EMPTY answer is not an answer, and that distinction cost a whole deck.
  // The public instances were timing out, the query fell through to a regional
  // mirror, and that mirror replied 200 with zero elements because it does not
  // carry the part of the world being asked about. Nothing downstream could
  // tell that apart from "there is nothing in Santorini": the deck came back
  // with no places, a title already written for it, and no error anywhere.
  //
  // So an empty result is kept only as a last resort. A mirror that returns
  // something wins outright; if every mirror that answered returned nothing,
  // then the region really is empty and that is the honest answer.
  let data = null;
  let empty = null;
  let last = null;

  // Two sweeps of the mirrors, not one.
  //
  // The public instances go through patches of returning 504 and timing out —
  // it is their normal weather rather than an outage — and a single pass across
  // three of them during one of those patches loses the deck entirely. An
  // Iceland deck died that way with all three refusing inside ten seconds of
  // each other, which is exactly the shape of a transient.
  //
  // The pause matters more than the retry: coming straight back hits the same
  // busy instance in the same state. Skipped when the first sweep got a real
  // (if empty) answer, because that is a fact about the region rather than
  // about the server.
  const SWEEPS = Number(process.env.OVERPASS_SWEEPS || 2);
  for (let sweep = 0; sweep < SWEEPS && !data && !empty; sweep++) {
    if (sweep) {
      console.error(`places: every mirror refused, waiting before one more sweep`);
      await wait(Number(process.env.OVERPASS_RETRY_MS || 12_000));
    }

    for (const host of OVERPASS_MIRRORS) {
      try {
        const got = await json(host, {
          step: 'overpass',
          attempts: 1,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: ql }),
        });
        if (got?.elements?.length) {
          data = got;
          break;
        }
        empty ??= got;
        console.error(`places: ${new URL(host).hostname} — answered with nothing, trying the next mirror`);
      } catch (e) {
        last = e;
        console.error(`places: ${new URL(host).hostname} — ${e.message}`);
      }
    }
  }

  data ??= empty;
  if (!data) throw last || new PlacesError('every Overpass mirror refused', { step: 'overpass' });

  const seen = new Set();
  const out = [];
  for (const el of data.elements || []) {
    const qid = el.tags?.wikidata;
    const name = el.tags?.name;
    if (!qid || !name || seen.has(qid)) continue;
    seen.add(qid);
    out.push({
      qid,
      name,
      nameEn: el.tags['name:en'] || null,
      kind,
      osmType: el.type,
      osmId: el.id,
      lat: el.lat ?? el.center?.lat ?? null,
      lon: el.lon ?? el.center?.lon ?? null,
      // Kept for context only. None of it may be printed: OSM is not the
      // publisher of any of these facts, and the deck quotes an authority or
      // says nothing. They are here so a later step can tell whether the
      // official page's number agrees with the map's.
      osmTags: el.tags,
    });
  }
  return out;
}

/**
 * How well known each place is, and where its official page lives.
 *
 * Sitelink count — how many language Wikipedias have an article — is a blunt
 * instrument and the right kind of blunt: it is a property of the world rather
 * than of our taste, it cannot be gamed by whoever edited the map last week,
 * and "the five most written-about castles in Prague" is a claim we can defend
 * to somebody who disagrees with the list.
 *
 * P856 is the load-bearing field. It is the official website Wikidata records
 * for the place, and downstream it is the ONLY domain a fact about that place
 * may be quoted from.
 */
export async function enrich(places) {
  const out = [];
  // wbgetentities takes 50 ids a call, and asking for more silently truncates.
  for (let i = 0; i < places.length; i += 50) {
    const batch = places.slice(i, i + 50);
    const data = await json(
      `${WIKIDATA}?${new URLSearchParams({
        action: 'wbgetentities',
        ids: batch.map((p) => p.qid).join('|'),
        props: 'sitelinks|claims|labels',
        languages: 'he|en',
        format: 'json',
        origin: '*',
      })}`,
      { step: 'wikidata' }
    );

    for (const p of batch) {
      const ent = data.entities?.[p.qid];
      if (!ent || ent.missing !== undefined) {
        out.push({ ...p, sitelinks: 0, officialUrl: null, labelHe: null });
        continue;
      }
      const site = ent.claims?.P856?.[0]?.mainsnak?.datavalue?.value || null;

      // The measured properties, kept rather than discarded.
      //
      // This pass already downloads every claim on the entity and was throwing
      // all but four of them away, which is why a deck of summits had no
      // heights in it: P2044 was in the response and nothing read it. Narrowed
      // to the properties deck/facts.js actually draws with, so a place carries
      // its numbers without carrying its entire Wikidata record around.
      const wd = {};
      for (const prop of WANTED_PROPS) {
        if (ent.claims?.[prop]) wd[prop] = ent.claims[prop];
      }

      out.push({
        ...p,
        sitelinks: Object.keys(ent.sitelinks || {}).length,
        officialUrl: typeof site === 'string' ? site : null,
        claims: wd,
        // Who runs it (P137 operator) and what it is inside (P131 administrative
        // unit, P706 terrain feature). A waterfall has no website of its own and
        // never will, but the national park it sits in publishes about it — and
        // that park is the body whose word counts for a fact about the place.
        operatorQid: ent.claims?.P137?.[0]?.mainsnak?.datavalue?.value?.id || null,
        withinQid:
          ent.claims?.P131?.[0]?.mainsnak?.datavalue?.value?.id ||
          ent.claims?.P706?.[0]?.mainsnak?.datavalue?.value?.id ||
          null,
        labelHe: ent.labels?.he?.value || null,
        labelEn: ent.labels?.en?.value || p.nameEn || p.name,
      });
    }
  }
  return out;
}

/**
 * Official websites for the bodies that run or contain these places.
 *
 * A second Wikidata pass rather than a bigger first one: most places resolve
 * through their own P856 and never need this, and the ids to look up are not
 * known until the first pass has returned.
 */
export async function resolveAuthorities(places) {
  const ids = [...new Set(places.flatMap((p) => [p.operatorQid, p.withinQid]).filter(Boolean))];
  if (!ids.length) return places;

  const sites = new Map();
  const labels = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await json(
      `${WIKIDATA}?${new URLSearchParams({
        action: 'wbgetentities',
        ids: ids.slice(i, i + 50).join('|'),
        props: 'claims|labels',
        languages: 'he|en',
        format: 'json',
        origin: '*',
      })}`,
      { step: 'wikidata_authorities' }
    );
    for (const [qid, ent] of Object.entries(data.entities || {})) {
      const site = ent.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (typeof site === 'string') sites.set(qid, site);
      if (ent.labels?.en?.value) labels.set(qid, ent.labels.en.value);
    }
  }

  return places.map((p) => ({
    ...p,
    operatorUrl: p.operatorQid ? sites.get(p.operatorQid) || null : null,
    operatorName: p.operatorQid ? labels.get(p.operatorQid) || null : null,
    withinUrl: p.withinQid ? sites.get(p.withinQid) || null : null,
    withinName: p.withinQid ? labels.get(p.withinQid) || null : null,
  }));
}

/**
 * Hebrew labels for the entities the kept claims point AT.
 *
 * A claim like P17 or P4552 gives back a QID, not a word — "Q38" rather than
 * "איטליה" — so a slide that wants to name the country or the range needs one
 * more lookup. Batched across the whole deck, which makes it a single request
 * for a five-place deck rather than five.
 *
 * P297 comes back with it: the ISO code is what picks the flag, and deriving it
 * from a name would be a lookup table of every country spelled two ways.
 */
export async function resolveClaimLabels(places) {
  const ids = [
    ...new Set(
      places.flatMap((p) =>
        ENTITY_PROPS.map((prop) => p.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.id).filter(Boolean)
      )
    ),
  ];
  if (!ids.length) return new Map();

  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await json(
      `${WIKIDATA}?${new URLSearchParams({
        action: 'wbgetentities',
        ids: ids.slice(i, i + 50).join('|'),
        props: 'labels|claims',
        languages: 'he|en',
        format: 'json',
        origin: '*',
      })}`,
      { step: 'wikidata_claim_labels' }
    ).catch(() => null);

    for (const [qid, ent] of Object.entries(data?.entities || {})) {
      out.set(qid, {
        he: ent.labels?.he?.value || null,
        en: ent.labels?.en?.value || null,
        iso: ent.claims?.P297?.[0]?.mainsnak?.datavalue?.value || null,
      });
    }
  }
  return out;
}

/**
 * Every domain whose word counts for a fact about this place, best first.
 *
 * Order is the whole point. The place's own site is the publisher of its own
 * opening hours; the body that runs it is the publisher of facts about it; the
 * park or municipality that contains it is a weaker but still real authority.
 * A search engine is later asked to find a page on one of these, never to find
 * a page and then decide whether the domain was acceptable.
 */
export function authorityDomains(place) {
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const osmSite = place.osmTags?.website || place.osmTags?.['contact:website'] || null;
  return [...new Set([place.officialUrl, osmSite, place.operatorUrl, place.withinUrl].map(host).filter(Boolean))];
}

/**
 * The shortlist for one deck.
 *
 * Returns a POOL rather than a final five. Which places survive is not knowable
 * here: it depends on whether a page stating a fact can actually be found and
 * quoted, which happens two steps later. Over-fetching and reporting the counts
 * is what lets the deck builder drop places without the deck silently shrinking
 * for reasons nobody can see.
 */
export async function shortlist({ where, kind, want = 5, pool = 0, requireAuthority = true }) {
  const area = await resolveArea(where);
  const found = await osmPlaces(area.bbox, kind);
  const enriched = await resolveAuthorities(await enrich(found));

  const ranked = enriched.sort((a, b) => b.sitelinks - a.sitelinks);
  const withAuthority = ranked.filter((p) => authorityDomains(p).length);

  // Requiring an official website is right for a museum and fatal for a
  // mountain.
  //
  // A summit has no site, no operator and nothing that contains it with one, so
  // this filter emptied every mountain shortlist before it reached the deck —
  // which is exactly the "mountains in Italy came back with nothing" failure.
  // The requirement belongs to the KIND of claim a slide will make, not to the
  // shortlist: a deck drawing its numbers off Wikidata properties needs no page
  // to quote, and a deck drafting prose still does.
  const usable = requireAuthority ? withAuthority : ranked;

  // The labels behind the kept claims — the country, the range — resolved once
  // for the whole shortlist rather than per slide.
  const labels = await resolveClaimLabels(usable.slice(0, pool || want * 3)).catch(() => new Map());

  return {
    area,
    kind,
    want,
    labels,
    // Reported to the approval message verbatim: "75 known places, 52 with an
    // authority, 5 used" is the difference between a thin region and a region
    // where nobody records a website. Both happen, and they look identical
    // until someone prints the numbers.
    counts: {
      found: found.length,
      withWikidata: enriched.length,
      withAuthority: withAuthority.length,
    },
    places: usable.slice(0, pool || want * 3),
    rejected: requireAuthority
      ? ranked
          .filter((p) => !authorityDomains(p).length)
          .slice(0, 10)
          .map((p) => ({ name: p.name, qid: p.qid, why: 'no official site, operator or containing body with one' }))
      : [],
  };
}
