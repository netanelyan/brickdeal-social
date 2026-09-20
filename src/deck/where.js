import { country as countryOf } from './flags.js';

// Which country a destination is in.
//
// The map route gets this per place off Wikidata's P17. The route that builds a
// deck from our own destination page does not: those entries are places inside
// one city, written in Hebrew, with no Wikidata entity and no country field —
// so every slide from that route went out with no flag on it, while the map
// route's slides had one. Two routes, one channel, and a visible difference
// between them on every post.
//
// The destination is a place name, and a geocoder's whole job is turning a
// place name into where it is. Nominatim is already the geocoder this pipeline
// uses for bounding boxes; asking it for the address details as well returns
// the ISO country code, which is what picks the flag. One request per deck, no
// model call, and nothing to keep up to date.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA =
  process.env.PLACES_USER_AGENT || 'tiyul-plus/1.0 (travel content pipeline; contact via www.tiyulplus.com)';

const cache = new Map();

/**
 * The country a destination sits in, as Hebrew and a flag.
 *
 * Returns nulls rather than throwing. A missing flag costs an ornament; a throw
 * here would cost the deck, and this is the least important thing on the slide.
 */
export async function countryOfDestination(where) {
  const key = String(where || '').trim().toLowerCase();
  if (!key) return { he: null, flag: null, iso: null };
  if (cache.has(key)) return cache.get(key);

  let got = { he: null, flag: null, iso: null };
  try {
    const url = `${NOMINATIM}?${new URLSearchParams({
      q: where,
      format: 'jsonv2',
      limit: '1',
      addressdetails: '1',
    })}`;
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.PLACES_TIMEOUT_MS || 20_000)),
    });
    if (res.ok) {
      const rows = await res.json();
      const iso = Array.isArray(rows) ? rows[0]?.address?.country_code : null;
      if (iso) got = countryOf(iso);
    }
  } catch {
    // Deliberately silent. A deck without a flag is a deck; a deck that failed
    // to build because a geocoder timed out is not.
  }

  cache.set(key, got);
  return got;
}
