import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The comparison price, and the only claim on a slide that does not come from
// our own feed.
//
// The account this channel is modelled on writes three lines under every set
// name: what it costs in the community, what it costs at the original brand's
// own store, and the difference. The middle number is the one doing all the
// work — a saving is only impressive against a price somebody recognises — and
// the reference looks it up BY HAND, per set, because there is no API for it.
//
// There is one, nearly. Brickset records the original brand's recommended
// retail price per region, keyed by set number, and our feed already carries
// set numbers because the bot verifies them against Brickset to fetch official
// renders. So the number is reachable; what it is not is an Israeli shelf
// price, and the slide must not pretend otherwise. It is a list price in
// another currency, converted, and `מחיר מחירון` is what the slide calls it.
//
// THE RULE, AND IT IS ENFORCED BELOW RATHER THAN HOPED FOR: no RRP means no
// comparison line and no saving line. The slide falls back to a name and a
// price and publishes perfectly well. This is the same posture brickdeal-website
// takes with `originalPrice` — "an empty comparison beats an invented one" —
// and it is the whole reason the feed's own AliExpress list price was rejected
// for this job: that number is a marketplace's strike-through, not a price
// anyone ever charged.

const FILE = process.env.RRP_CACHE_PATH
  ? resolve(process.env.RRP_CACHE_PATH)
  : fileURLToPath(new URL('../../data/rrp.json', import.meta.url));

const ENDPOINT = process.env.BRICKSET_ENDPOINT || 'https://brickset.com/api/v3.asmx/getSets';
const DAY_MS = 24 * 60 * 60 * 1000;

// A recommended retail price does not move. Thirty days is not about accuracy,
// it is about the key quota — only getSets counts against it, and a deck of
// seven sets would otherwise spend seven calls every time it is rebuilt.
const ttlMs = () => Math.max(1, Number(process.env.RRP_TTL_DAYS ?? '30')) * DAY_MS;

// Which region's price to quote, in order of preference.
//
// Germany first, and the reason is tax rather than geography: the German price
// includes VAT and the American one does not. Israel has VAT, so a viewer
// comparing the slide's number against what they would actually be charged is
// comparing like with like only in the EUR case. Britain next for the same
// reason, then Canada, then the United States — which is better than nothing
// and is quietly about 17% flattering, so it is last.
const REGIONS = [
  ['DE', 'EUR'],
  ['UK', 'GBP'],
  ['CA', 'CAD'],
  ['US', 'USD'],
];

export class BricksetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BricksetError';
  }
}

export const configured = () => Boolean(process.env.BRICKSET_API_KEY);

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

/**
 * The set number as Brickset wants it.
 *
 * Brickset keys on "<number>-<variant>" and the feed carries only the number,
 * so "-1" is assumed — which is right for the overwhelming majority and wrong
 * in a way that fails safely: a variant that does not exist returns no match,
 * which this module reports as "no RRP", which drops the comparison line.
 */
export const setNumber = (setId) => {
  const id = String(setId || '').trim();
  if (!/^\d{3,7}(-\d+)?$/.test(id)) return null;
  return id.includes('-') ? id : `${id}-1`;
};

/**
 * The best available retail price for one set, as {amount, currency, region}.
 *
 * Reads `LEGOCom` in the order above and takes the first region that has a
 * usable number. A region present but priced at zero is treated as absent —
 * Brickset carries those for sets that were never sold in that market.
 */
export function pickPrice(legoCom) {
  for (const [region, currency] of REGIONS) {
    const amount = Number(legoCom?.[region]?.retailPrice);
    if (Number.isFinite(amount) && amount > 0) return { amount, currency, region };
  }
  return null;
}

/**
 * The set's longest side in centimetres, or null.
 *
 * Not a price, and here because it comes free in the same response and the
 * photograph step needs it. The product-shot prompt chooses how the model is
 * held from its real size, and its house rule is that the size is never
 * guessed silently — this is the reason that rule can be kept without a second
 * lookup per set.
 */
export function longestSideCm(dimensions) {
  const sides = ['height', 'width', 'depth'].map((k) => Number(dimensions?.[k])).filter((n) => Number.isFinite(n) && n > 0);
  return sides.length ? Math.max(...sides) : null;
}

async function ask(number) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('apiKey', process.env.BRICKSET_API_KEY);
  url.searchParams.set('userHash', '');
  url.searchParams.set('params', JSON.stringify({ setNumber: number }));

  let payload;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    throw new BricksetError(`Brickset lookup for ${number} failed: ${e.message}`);
  }

  // An invalid or exhausted key is a configuration problem and must not read as
  // "this set has no price" — that would silently strip the comparison from
  // every slide on the channel and look like a run of unlucky sets.
  if (payload?.status !== 'success') {
    throw new BricksetError(`Brickset refused: ${payload?.message || 'unknown error'}`);
  }

  return payload.sets?.[0] || null;
}

/**
 * What Brickset knows about one set number, cached on disk.
 *
 * Returns `{ price, sizeCm, name, found }`. A set Brickset has never heard of
 * is cached too, as `found: false` — the misses are the common case on a
 * marketplace where set numbers are scraped out of seller titles and are often
 * wrong, and re-asking about them every build is how a daily key quota gets
 * spent on nothing.
 */
export async function lookup(setId, { now = Date.now() } = {}) {
  const number = setNumber(setId);
  if (!number) return { found: false, why: 'not a set number' };
  if (!configured()) return { found: false, why: 'BRICKSET_API_KEY is not set' };

  const cache = read();
  const hit = cache[number];
  if (hit && now - (hit.at || 0) < ttlMs()) return hit.value;

  const set = await ask(number);
  const value = set
    ? {
        found: true,
        number,
        name: set.name || null,
        price: pickPrice(set.LEGOCom),
        sizeCm: longestSideCm(set.dimensions),
        pieces: Number.isFinite(Number(set.pieces)) ? Number(set.pieces) : null,
      }
    : { found: false, number, why: 'no such set on Brickset' };

  write({ ...cache, [number]: { at: now, value } });
  return value;
}

/**
 * The comparison, in shekels, or null with the reason it could not be made.
 *
 * `rate` is passed in rather than fetched here so that one deck converts every
 * slide at one rate on one date — seven slides each fetching their own would
 * be seven chances to straddle a publication boundary and produce a deck whose
 * numbers cannot be reproduced from a single stated rate.
 *
 * Every refusal below is a case where a comparison would be misleading rather
 * than merely absent, and each returns a reason the build prints.
 */
export function compare({ price, rrp, rate, minSaving = Number(process.env.MIN_SAVING_ILS ?? '20') }) {
  if (!rrp) return { ok: false, why: 'no retail price on Brickset' };
  if (!rate || !Number.isFinite(rate.rate)) return { ok: false, why: 'no exchange rate' };

  const listIls = Math.round(rrp.amount * rate.rate);
  const paid = Math.round(price);

  // A "saving" against a list price lower than ours is not a saving, and
  // printing it as one would be the invented comparison this whole module
  // exists to avoid. It happens: a clone of a long-discontinued set can
  // genuinely cost more than the original did at launch.
  if (listIls <= paid) return { ok: false, why: `retail (${listIls}₪) is not above our price (${paid}₪)` };

  const saving = listIls - paid;
  if (saving < minSaving) return { ok: false, why: `saving of ${saving}₪ is under the ${minSaving}₪ floor` };

  return {
    ok: true,
    paid,
    listIls,
    saving,
    // Carried so the approval message can print what the number was built from,
    // and so a slide can be argued with six weeks later.
    source: { amount: rrp.amount, currency: rrp.currency, region: rrp.region, rate: rate.rate, rateDate: rate.date },
  };
}

export const __test = { REGIONS, ttlMs };
