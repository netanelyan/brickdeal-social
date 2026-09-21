// Unsplash — the other commercial-license library, and the one that looks less
// like stock.
//
// Pexels was chosen first on licence terms: no attribution, no tracking, inline
// the bytes and forget it. That is still the simpler integration, and it stays.
// What it is not is authentic-looking: its travel catalogue leans towards clean,
// evenly-lit, obviously-commissioned photography, and a slideshow built from it
// reads as an advertisement no matter what the words say.
//
// Unsplash is where people put the photograph they actually took. The cost is
// two running obligations, both honoured here:
//
//   1. attribution — the photographer and Unsplash are credited, and the deck
//      caption carries them (see format.js).
//   2. a download ping — their terms require telling them when an image is
//      actually used, which is what trackDownload() does. It is fire and
//      forget; a failed ping must never cost us the photograph.
//
// Note what this is NOT: a way to use images from anywhere else. A photograph
// that turns up in a Pinterest search belongs to whoever took it, and a search
// engine's copy of it is not a licence. Everything here is licensed for
// commercial use by the library that serves it.

import { CARD_W, CARD_H } from '../render/theme.js';

const API = 'https://api.unsplash.com/search/photos';
const MIN_WIDTH = 1080;
const MAX_BYTES = 8_000_000;

export const configured = () => Boolean(process.env.UNSPLASH_ACCESS_KEY);

const auth = () => ({ authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` });

/**
 * Their terms require this whenever an image is used, not when it is searched.
 *
 * Deliberately not awaited by the caller and deliberately silent on failure:
 * the obligation is to make the call, and a library outage should not cost a
 * post its photograph.
 */
function trackDownload(photo) {
  const url = photo?.links?.download_location;
  if (!url) return;
  fetch(url, { headers: auth(), signal: AbortSignal.timeout(8000) }).catch(() => {});
}

/**
 * An exact crop at card size, from their imgix pipeline.
 *
 * Asking for the crop rather than the full image is the difference between a
 * 300KB download and a 6MB one, and it means the subject survives: `fit=crop`
 * with `crop=entropy` keeps the busy part of the frame rather than the middle,
 * which for a landscape shot squeezed into 9:16 is usually the point of it.
 */
function cropUrl(photo, { w = CARD_W, h = CARD_H } = {}) {
  const raw = photo?.urls?.raw;
  if (!raw) return null;
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}w=${w}&h=${h}&fit=crop&crop=entropy&q=80&fm=jpg`;
}

async function download(href, timeoutMs) {
  try {
    const res = await fetch(href, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, type };
  } catch {
    return null;
  }
}

async function bestOf(query, { orientation, timeoutMs }) {
  const params = new URLSearchParams({ query, per_page: '30', content_filter: 'high' });
  if (orientation) params.set('orientation', orientation);

  let json;
  try {
    const res = await fetch(`${API}?${params}`, { headers: auth(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    throw new Error(`unsplash search failed: ${e.message}`);
  }

  const usable = (json.results || []).filter((p) => (p.width || 0) >= MIN_WIDTH);
  if (!usable.length) return null;

  // Ranked by how much the library itself likes it. `likes` is a weak signal
  // and the right kind of weak: it is a property of the photograph rather than
  // of our query, so it breaks ties towards pictures people actually stopped on.
  return usable.sort((a, b) => (b.likes || 0) - (a.likes || 0))[0];
}

/**
 * Several candidates with thumbnails, for a caller that wants to LOOK before
 * choosing.
 *
 * The ranking this module can do on its own is popularity and resolution, and
 * neither knows whether a cable crosses the frame. So the expensive judgement
 * is handed upwards: this returns a shortlist with 200px thumbs, and
 * images/curate.js decides.
 */
export async function candidates(query, { n = 6, timeoutMs = 15_000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  // Portrait first — see the note in pexels.js. A slide is 1080x1920, and a
  // landscape frame cropped into that keeps its middle third and throws away
  // the composition that made it worth choosing.
  const search = async (orientation) => {
    const params = new URLSearchParams({ query: q, per_page: '24', content_filter: 'high' });
    if (orientation) params.set('orientation', orientation);
    const res = await fetch(`${API}?${params}`, { headers: auth(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let json;
  try {
    // See the note in pexels.js: compared against a small floor rather than
    // the ceiling, so a niche query does one search instead of two.
    const ENOUGH_PORTRAIT = Math.min(3, n);
    json = await search('portrait');
    if ((json.results || []).length < ENOUGH_PORTRAIT) {
      const wide = await search(null).catch(() => ({ results: [] }));
      const seen = new Set((json.results || []).map((p) => p.id));
      json = { results: [...(json.results || []), ...(wide.results || []).filter((p) => !seen.has(p.id))] };
    }
  } catch (e) {
    throw new Error(`unsplash search failed: ${e.message}`);
  }

  const usable = (json.results || [])
    .filter((p) => (p.width || 0) >= MIN_WIDTH)
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, n);

  const out = [];
  for (const photo of usable) {
    const thumbUrl = cropUrl(photo, { w: 440, h: 780 });
    const bytes = await download(thumbUrl, timeoutMs);
    if (!bytes) continue;
    out.push({
      library: 'unsplash',
      photo,
      thumb: bytes.buf,
      // The library serves PNG for some thumbnails, and declaring the wrong
      // media type to a vision call is a 400 rather than a soft failure.
      thumbType: bytes.type && bytes.type.startsWith("image/") ? bytes.type.split(";")[0] : "image/jpeg",
      credit: photo.user?.name ? `Unsplash / ${photo.user.name}` : 'Unsplash',
      key: photo.id,
      query: q,
    });
  }
  return out;
}

/** Download one candidate at card size, once it has been chosen. */
export async function fetchChosen(candidate, { w = CARD_W, h = CARD_H, timeoutMs = 15_000 } = {}) {
  const href = cropUrl(candidate.photo, { w, h });
  if (!href) return null;
  const bytes = await download(href, timeoutMs);
  if (!bytes) return null;

  trackDownload(candidate.photo);

  return {
    src: `data:${bytes.type};base64,${bytes.buf.toString('base64')}`,
    provenance: 'stock',
    credit: candidate.credit,
    creditUrl: candidate.photo.user?.links?.html || null,
    sourceUrl: candidate.photo.links?.html || null,
    alt: candidate.photo.alt_description || '',
    query: candidate.query,
  };
}

/** Same contract as the Pexels provider: { src, provenance, credit } or null. */
export async function search(query, { timeoutMs = 15_000, w = CARD_W, h = CARD_H } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;

  let photo = await bestOf(q, { orientation: 'portrait', timeoutMs });
  if (!photo) photo = await bestOf(q, { orientation: null, timeoutMs });
  if (!photo) return null;

  const href = cropUrl(photo, { w, h });
  if (!href) return null;

  const bytes = await download(href, timeoutMs);
  if (!bytes) return null;

  trackDownload(photo);

  return {
    src: `data:${bytes.type};base64,${bytes.buf.toString('base64')}`,
    provenance: 'stock',
    credit: photo.user?.name ? `Unsplash / ${photo.user.name}` : 'Unsplash',
    // Carried so the caption can attribute properly — their terms ask for a
    // link to the photographer, not just a name.
    creditUrl: photo.user?.links?.html || null,
    sourceUrl: photo.links?.html || null,
    alt: photo.alt_description || '',
    query: q,
  };
}
