// Pexels — commercial-license stock.
//
// Chosen over the alternatives on licence terms rather than catalogue size.
// The Pexels licence permits commercial use with no attribution required and,
// critically, does not require hotlinking back to their CDN — so the bytes can
// be inlined into the card at render time. Unsplash's API terms require both
// attribution and a download-tracking ping, which is fine but is a running
// obligation rather than a one-off integration.
//
// We record and print the photographer anyway. Not required, but a photograph
// on a published card should say whose it is.

import { CARD_W, CARD_H } from '../render/theme.js';

const API = 'https://api.pexels.com/v1/search';

// Bigger than the card, so downscaling is what happens rather than upscaling.
const MIN_WIDTH = 1080;

const MAX_BYTES = 8_000_000; // Instagram's own image limit, and a sanity bound

export const configured = () => Boolean(process.env.PEXELS_API_KEY);

/**
 * Find a photograph for a draft.
 *
 * Returns { src, provenance, credit } with `src` as a data URI, or null when
 * nothing suitable came back. Null is a completely ordinary outcome — the
 * caller falls back to a text-led layout, which is a fine card.
 *
 * Two passes. The first asks for portrait photographs, which fit a 4:5 card
 * without losing their subject. If that pass has nothing worth using, the
 * second asks for anything and takes the best-scoring result — a landscape
 * shot centre-cropped to 4:5 is a worse card than a portrait one, but it is a
 * far better card than the text fallback the post would otherwise get.
 */
export async function search(query, { timeoutMs = 15_000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;

  let photo = await bestOf(q, { orientation: 'portrait', timeoutMs });
  if (!photo) photo = await bestOf(q, { orientation: null, timeoutMs });
  if (!photo) return null;

  const href = cropUrl(photo);
  if (!href) return null;

  const bytes = await download(href, timeoutMs);
  if (!bytes) return null;

  return {
    // Inlined rather than hotlinked. The renderer runs with no network by
    // design (see render/index.js), and a card that silently renders without
    // its background because a CDN blipped is worse than one that fails loudly.
    src: `data:${bytes.type};base64,${bytes.buf.toString('base64')}`,
    provenance: 'stock',
    credit: photo.photographer ? `Pexels / ${photo.photographer}` : 'Pexels',
    sourceUrl: photo.url || null,
    alt: photo.alt || '',
    query: q,
  };
}

/**
 * A shortlist with thumbnails, for a caller that wants to look before choosing.
 *
 * Same contract as the Unsplash provider's. scorePhoto() still does the first
 * cut — it is good at refusing product shots and portraits from the alt text —
 * and what it cannot see (a cable across the frame, flat grey light) is what
 * the caller's own eyes are for.
 */
export async function candidates(query, { n = 6, timeoutMs = 15_000, w = 440, h = 780 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(`${API}?${new URLSearchParams({ query: q, per_page: '30' })}`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Pexels search failed: HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const ranked = (json.photos || [])
    .map((photo) => ({ photo, score: scorePhoto(photo, q) }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  const out = [];
  for (const { photo } of ranked) {
    // The thumbnail is cropped to the SAME shape the slide will use, not to
    // Pexels' own landscape preview. Judging a wide frame and then shipping a
    // centre-cropped tall one is how a curator approves a composition that
    // never reaches the slide: the subject it approved is outside the crop.
    const thumbUrl = cropUrl(photo, { w, h }) || photo?.src?.medium || photo?.src?.small;
    if (!thumbUrl) continue;
    const bytes = await download(thumbUrl, timeoutMs);
    if (!bytes) continue;
    out.push({
      library: 'pexels',
      photo,
      thumb: bytes.buf,
      // The library serves PNG for some thumbnails, and declaring the wrong
      // media type to a vision call is a 400 rather than a soft failure.
      thumbType: bytes.type && bytes.type.startsWith("image/") ? bytes.type.split(";")[0] : "image/jpeg",
      credit: photo.photographer ? `Pexels / ${photo.photographer}` : 'Pexels',
      key: String(photo.id),
      query: q,
    });
  }
  return out;
}

/** Download one candidate at the requested size, once it has been chosen. */
export async function fetchChosen(candidate, { w = CARD_W, h = CARD_H, timeoutMs = 15_000 } = {}) {
  const href = cropUrl(candidate.photo, { w, h });
  if (!href) return null;
  const bytes = await download(href, timeoutMs);
  if (!bytes) return null;
  return {
    src: `data:${bytes.type};base64,${bytes.buf.toString('base64')}`,
    provenance: 'stock',
    credit: candidate.credit,
    sourceUrl: candidate.photo.url || null,
    alt: candidate.photo.alt || '',
    query: candidate.query,
  };
}

async function bestOf(q, { orientation, timeoutMs }) {
  const params = { query: q, per_page: '30' };
  if (orientation) params.orientation = orientation;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(`${API}?${new URLSearchParams(params)}`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Pexels search failed: HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  return pickBest(json.photos || [], q);
}

// Not the first result — the best one.
//
// The first version took the first photograph wide enough for the card, and a
// query for "Reykjavik house" duly returned a red house on an ordinary street.
// Pexels ranks by its own relevance, which is decent, but the top hit is often
// a person posing in front of the place, a product shot, or a picture of
// somewhere else that shares a word with the query. The alt text the API
// returns is enough to tell those apart from the landscape the card wants.
//
// Exported so the ranking is testable without a key.
const PEOPLE =
  /\b(?:woman|women|man|men|girl|boy|person|people|couple|portrait|selfie|model|bride|groom|wedding|family|tourist|traveler|traveller|smiling|posing|fashion|dress|bikini|hand|hands|face|closeup|close-up)\b/i;
const NOT_A_PLACE =
  /\b(?:logo|text|sign|screenshot|illustration|drawing|render|3d|map|flag|passport|money|coins?|banknotes?|food|dish|plate|coffee|cup|laptop|phone|car|cars|dog|cat|toy|product|package|bottle|abstract|texture|pattern|background|mockup)\b/i;
const SCENERY =
  /\b(?:aerial|drone|landscape|skyline|panorama|sunset|sunrise|dusk|golden hour|night|lights|mountain|mountains|coast|coastline|cliff|cliffs|beach|island|lagoon|bay|harbou?r|sea|ocean|lake|river|waterfall|valley|glacier|snow|forest|desert|dunes|canyon|old town|street|alley|square|plaza|bridge|castle|palace|cathedral|church|temple|shrine|mosque|tower|dome|ruins|architecture|cityscape|view|vista|scenic|aurora|northern lights)\b/i;

export function scorePhoto(photo, query) {
  const alt = String(photo.alt || '').toLowerCase();
  const w = Number(photo.width) || 0;
  const h = Number(photo.height) || 0;
  let score = 0;

  // Resolution: at least the card, and comfortably above it is better.
  if (w < MIN_WIDTH || h < CARD_H) return -Infinity;
  score += Math.min(1, (Math.min(w, h) - 1080) / 2000) * 0.3;

  // Shape: a portrait fits the card, a square crops a little, a wide landscape
  // loses its sides.
  const ratio = h / w;
  if (ratio >= 1.15) score += 0.6;
  else if (ratio >= 0.9) score += 0.3;
  else if (ratio < 0.6) score -= 0.5;

  // Does the description mention what was asked for? Counted per query word,
  // so "Kyoto wooden bridge" wants to see kyoto, and a bridge, and not merely
  // wood.
  const words = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const hits = words.filter((t) => alt.includes(t)).length;
  if (words.length) score += (hits / words.length) * 1.5;

  // Sized so that a person or a product shot lands below zero on shape and
  // resolution alone - it is refused unless the description also matches the
  // query well, in which case it is at least a picture of the right place.
  if (SCENERY.test(alt)) score += 0.6;
  if (PEOPLE.test(alt)) score -= 2.0;
  if (NOT_A_PLACE.test(alt)) score -= 2.5;

  return score;
}

export function pickBest(photos, query) {
  let best = null;
  let bestScore = -Infinity;
  for (const p of photos) {
    const s = scorePhoto(p, query);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  // Below zero the "best" is a people shot or a product shot that happened to
  // be least bad. Say no, and let the caller try a broader query.
  return bestScore >= 0 ? best : null;
}

// The exact card size, cut by Pexels' own CDN.
//
// The API's ready-made `portrait` crop is 800x1200, which is smaller than the
// card in both directions — every photo card was being upscaled by a third
// before this. The CDN takes the same query parameters that crop generates,
// so asking for 1080x1350 directly returns a sharp, centre-cropped image at
// exactly the card's size. Falls back to the largest generic size if the
// original URL is missing.
// The size is a parameter because a card and a slide are different shapes. The
// card is 1080x1350; a TikTok slide is 1080x1920, and serving it the 4:5 crop
// meant the renderer covered a 4:5 image into a 9:16 box — throwing away a
// third of the width and upscaling what was left by 1.4. Every deck photograph
// was soft and over-cropped before this took an argument.
export function cropUrl(photo, { w = CARD_W, h = CARD_H } = {}) {
  const original = photo?.src?.original;
  if (original) {
    const u = new URL(original);
    u.searchParams.set('auto', 'compress');
    u.searchParams.set('cs', 'tinysrgb');
    u.searchParams.set('fit', 'crop');
    u.searchParams.set('w', String(w));
    u.searchParams.set('h', String(h));
    return u.toString();
  }
  return photo?.src?.large2x || photo?.src?.large || photo?.src?.portrait || null;
}

async function download(href, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(href, { signal: ctrl.signal });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\/(jpe?g|png|webp)$/i.test(type)) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;

    return { buf, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
