import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Currency conversion, for the one number on a slide that is not already in
// shekels.
//
// The comparison price comes from Brickset, which reports what the original
// brand charges in Germany, Britain, Canada and the United States — and in none
// of those is the currency the one the viewer pays in. So a rate is needed, and
// a rate is a fact with a date on it.
//
// That date is why this module stores its answer on the deck rather than
// returning a bare number. A slide saying "מחיר מחירון: 269₪" is a claim, and
// six weeks later the only way to check whether it was a fair one is to know
// what the rate was on the morning it was rendered. The approval message prints
// it; the deck carries it; nothing recomputes it after the fact.
//
// The European Central Bank's reference rates, via frankfurter.dev. No key, no
// account, published once a working day. A commercial rate feed would be more
// precise and less citable, and precision is not the problem here — a slide
// rounds to the whole shekel.

// Overridable for the same reason STORE_PATH is: importing this module from
// the test suite must not touch the rate the VPS is actually publishing with.
const FILE = process.env.FX_CACHE_PATH
  ? resolve(process.env.FX_CACHE_PATH)
  : fileURLToPath(new URL('../../data/fx.json', import.meta.url));
const ENDPOINT = process.env.FX_ENDPOINT || 'https://api.frankfurter.dev/v1/latest';

export class FxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FxError';
  }
}

function read() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

/** Today, as the ECB dates its rates. */
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * One unit of `from` in shekels, with the rate's own date.
 *
 * Cached per currency per day on disk. The cache is a day old at worst and the
 * ECB publishes daily, so a deck built on a Sunday legitimately carries
 * Friday's rate — `date` says so, which is the whole point of returning it.
 *
 * Throws rather than falling back to a remembered rate of unknown age. A stale
 * rate silently reused is exactly the kind of quiet wrongness that this
 * pipeline's price rules exist to prevent, and the caller's fallback is already
 * written: no rate means no comparison line, and the slide still publishes.
 */
export async function rateToIls(from, { now = Date.now() } = {}) {
  const base = String(from || '').toUpperCase();
  if (base === 'ILS') return { rate: 1, date: today(now), base };
  if (!/^[A-Z]{3}$/.test(base)) throw new FxError(`not a currency code: ${from}`);

  const cache = read();
  const hit = cache[base];
  if (hit && hit.fetchedOn === today(now) && Number.isFinite(hit.rate)) return { ...hit, base };

  let payload;
  try {
    const url = `${ENDPOINT}?base=${base}&symbols=ILS`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    throw new FxError(`could not fetch ${base}/ILS: ${e.message}`);
  }

  const rate = Number(payload?.rates?.ILS);
  if (!Number.isFinite(rate) || rate <= 0) throw new FxError(`${base}/ILS came back as ${payload?.rates?.ILS}`);

  // `date` is the ECB's, `fetchedOn` is ours, and they are different questions:
  // the first is how old the rate is, the second is when the cache may be
  // re-read. Conflating them meant a weekend rate looked fresh on Monday.
  const entry = { rate, date: String(payload.date || today(now)), fetchedOn: today(now) };
  write({ ...cache, [base]: entry });
  return { ...entry, base };
}

/** For tests: the on-disk cache path, so a suite can point somewhere scratch. */
export const __file = FILE;
