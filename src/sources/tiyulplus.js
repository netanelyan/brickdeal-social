// Places from our own destination pages.
//
// This replaces the OpenStreetMap route for any city tiyulplus.com covers, and
// it is better in every way that matters to a slideshow:
//
//   - the names are already Hebrew, so nothing has to be transliterated
//   - the descriptions are written for travellers, which is exactly the
//     material a hook needs. "a chapel decorated with tens of thousands of
//     bones" is on the page; OSM could only ever say ossuary=yes.
//   - a rating, a price band and a visit duration come with each place
//   - the list is curated, so ranking is not a proxy problem
//
// What it gives up is independence: the authority for a fact about Charles
// Bridge is now our own site rather than the bridge's. That is a deliberate
// choice — these entries are verified before they are published there — and it
// is why the slide still quotes the page verbatim and the approval message
// still prints the URL. The mechanism is unchanged; only the publisher is.
//
// Parsed from the rendered HTML rather than an API, because there is no API.
// The JSON-LD block carries only a dozen attractions and none of the rating,
// price or category fields, so the cards themselves are the better source.

import { fetchReadable } from '../fetchPage.js';
// The registry of deck kinds, so this route can tell "a kind I have no category
// for" from "no kind was asked for". They are opposite situations and treating
// them alike is what put a market on a trail deck.
import { KINDS } from './places.js';

const BASE = process.env.TIYULPLUS_BASE || 'https://www.tiyulplus.com';

export class TiyulplusError extends Error {
  constructor(message, { step, slug } = {}) {
    super(message);
    this.step = step;
    this.slug = slug;
  }
}

/** "Prague" and "new york" both have to reach /destinations/new-york. */
export const slugFor = (where) =>
  String(where || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const strip = (s) =>
  String(s || '')
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Each place is one card, and the card opens with a stable id. Splitting on
// that marker rather than matching one big pattern means a change to any single
// field costs that field and not the whole parse.
const CARD = /data-place-id="([^"]+)"/g;

const FIELDS = {
  nameHe: /class="font-bold text-night">([^<]+)</,
  nameEn: /class="text-xs font-medium text-night\/40">([^<]+)</,
  category: /class="badge[^"]*"[^>]*>(?:<span[^>]*><\/span>)?([^<]+)</,
  description: /class="mt-2 text-sm leading-relaxed text-night\/70">([\s\S]*?)<\/p>/,
  rating: /⭐\s*(?:<!--\s*-->)?\s*([\d.]+)/,
  price: /title="רמת מחיר"[^>]*>([^<]*)</,
  image: /<img src="([^"]+)"/,
  geo: /query=(-?[\d.]+),(-?[\d.]+)/,
};

// The duration chip has no attribute of its own — it is the bare span between
// the price and the maps link. Matched by shape rather than by class, because
// the classes here are utility soup and change with any restyle.
const DURATION = /<span>(כ?[^<]{2,18}(?:שעה|שעות|דקות|יום)[^<]{0,8})<\/span>/;

/**
 * Every place on one destination page.
 *
 * Returns [] for a city we do not cover, rather than throwing: "no such
 * destination" is an ordinary answer that the deck builder handles by falling
 * back, and an exception would make a missing city look like a broken site.
 */
export async function destinationPlaces(where) {
  const slug = slugFor(where);
  if (!slug) throw new TiyulplusError('no destination given', { step: 'slug' });

  const url = `${BASE}/destinations/${slug}`;
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': process.env.PLACES_USER_AGENT || 'tiyul-plus/1.0 (own content)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return { slug, url, places: [], covered: false };
    if (!res.ok) throw new TiyulplusError(`HTTP ${res.status}`, { step: 'fetch', slug });
    html = await res.text();
  } catch (e) {
    if (e instanceof TiyulplusError) throw e;
    throw new TiyulplusError(`fetch failed: ${e.message}`, { step: 'fetch', slug });
  }

  // Card boundaries first, then each card is parsed on its own slice.
  const starts = [];
  for (const m of html.matchAll(CARD)) starts.push({ id: m[1], at: m.index });

  const places = [];
  for (const [i, s] of starts.entries()) {
    const chunk = html.slice(s.at, starts[i + 1]?.at ?? s.at + 4000);
    const get = (re) => chunk.match(re)?.[1];

    const nameHe = strip(get(FIELDS.nameHe));
    const description = strip(get(FIELDS.description));
    if (!nameHe || !description) continue;

    const geo = chunk.match(FIELDS.geo);
    places.push({
      id: s.id,
      nameHe,
      nameEn: strip(get(FIELDS.nameEn)) || nameHe,
      category: strip(get(FIELDS.category)),
      description,
      rating: Number(get(FIELDS.rating)) || null,
      price: strip(get(FIELDS.price)) || null,
      duration: strip(chunk.match(DURATION)?.[1]) || null,
      image: get(FIELDS.image) || null,
      lat: geo ? Number(geo[1]) : null,
      lon: geo ? Number(geo[2]) : null,
      sourceUrl: url,
    });
  }

  return { slug, url, places, covered: places.length > 0 };
}

// What a deck asks for, and what the site calls it. Several site categories can
// feed one deck kind — a deck about "what to eat" wants restaurants, cafes and
// markets, and the site files those separately.
//
// EVERY REGISTERED DECK KIND NEEDS A LINE HERE. trail, waterfall and beach had
// none, and the consequence was not an empty deck — it was the opposite. An
// unmapped kind fell through to the permissive branch in pick() below and took
// the ENTIRE destination page, so "trails in the Dolomites" shipped as a
// valley, two lakes, a town, a museum town and Piazza delle Erbe market, under
// a cover that called them the most beautiful mountains in Italy. A selftest
// now holds this table against the registry so the next kind added cannot
// repeat it.
//
// The site's own vocabulary is short — טבע, אתר היסטורי, תצפית, אטרקציה, אוכל,
// אוכל כשר, שופינג, שוק, מוזיאון, בית קפה — and it has no word for a hiking
// route at all. So the outdoor kinds all map onto טבע, which is coarse enough
// to return a lake for a mountain deck; keepVisitable in deck/shape.js is what
// closes that gap, because it sees the names rather than the filing.
export const CATEGORY_HE = {
  museum: ['מוזיאון', 'גלריה'],
  attraction: ['אתר היסטורי', 'אטרקציה', 'תצפית'],
  // 'אוכל' is a substring of 'אוכל כשר', so the kosher entries come along with
  // the plain ones rather than needing their own line.
  food: ['אוכל', 'בית קפה', 'מסעדה', 'שוק'],
  mountain: ['טבע', 'תצפית'],
  trail: ['טבע', 'תצפית'],
  waterfall: ['טבע'],
  beach: ['טבע'],
  // Not deck kinds, but things people type. `shopping` said 'קניות'; the site
  // says 'שופינג', so it had never matched anything.
  nature: ['טבע', 'פארק', 'גן'],
  view: ['תצפית'],
  shopping: ['שופינג', 'קניות', 'שוק'],
};

// What people actually type. "/deck Italy mountains" should not fail because
// the registry spells it in the singular, and "attractions" is the natural
// plural of a category nobody will type as "attraction".
const SYNONYMS = {
  mountains: 'mountain',
  peaks: 'mountain',
  hikes: 'trail',
  hiking: 'trail',
  trails: 'trail',
  tracks: 'trail',
  attractions: 'attraction',
  sights: 'attraction',
  museums: 'museum',
  galleries: 'museum',
  beaches: 'beach',
  views: 'view',
  viewpoints: 'view',
  waterfalls: 'waterfall',
  restaurants: 'food',
  markets: 'food',
  nature: 'nature',
  parks: 'nature',
};

/** The registry's name for whatever was typed. */
export const canonicalKind = (kind) => {
  const k = String(kind || '').trim().toLowerCase();
  return SYNONYMS[k] || k;
};

/**
 * The places for one deck, best-rated first.
 *
 * The permissive branch is the dangerous one and it is now narrow.
 *
 * "An unknown kind takes the whole city rather than nothing" is right for
 * exactly one case: a deck of "the best of Prague", where no category was asked
 * for and filtering to nothing would be pedantry. It is catastrophic for a kind
 * the registry DOES declare — a trail deck that falls through takes markets and
 * museums, which is not a permissive result, it is a wrong one.
 *
 * So a registered deck kind is strict: no category match means no places from
 * this route, and buildDeck falls through to the map, whose Overpass tags
 * cannot return a market for `natural=peak`. Only a kind that is not in the
 * registry at all gets the whole page.
 */
export function pick(places, { kind, want = 5 }) {
  const id = canonicalKind(kind);
  const wanted = CATEGORY_HE[id];
  const pool = wanted
    ? places.filter((p) => wanted.some((c) => (p.category || '').includes(c)))
    : KINDS[id]
      ? []
      : [...places];

  return pool
    .slice()
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, want);
}
