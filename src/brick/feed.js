import { readFileSync } from 'node:fs';
import { splitName, detectTheme, THEME_HE } from './themes.js';

// The deal feed, and what is allowed out of it onto a slide.
//
// Everything a slideshow says about a product comes from here. The feed is
// produced by brickdeal-automation and published by brickdeal-website, and its
// contract is documented in that repo's README under "Feed contract" — so the
// load rules below are that document, in code, plus the two extra rules a
// slideshow needs and a web page does not.
//
// The difference matters. A stale or placeholder record on the website renders
// with a warning band and a dimmed date: the reader can see something is wrong
// and the page is still honest. A slide has no band and no date. It is a price
// in white letters on a photograph, and once it is on TikTok it cannot be
// dimmed, corrected or taken down quietly. So this file refuses where the
// website merely warns.

const DAY_MS = 24 * 60 * 60 * 1000;

// How stale a price may be before it stops being publishable.
//
// Fourteen days is the website's own threshold — past it a card dims and its
// date turns red (brickdeal-website README, "Price freshness"). The same number
// here is not a coincidence to be tidied away later: if the nightly refresh job
// dies, the site greys out and this pipeline stops producing slides, and those
// two failures should become visible on the same day rather than a fortnight
// apart.
const maxAgeDays = () => Math.max(1, Number(process.env.FEED_MAX_AGE_DAYS ?? '14'));

/** Where the feed is looked up, in order. */
function sources() {
  const out = [];
  if (process.env.BRICKDEAL_FEED_URL) out.push({ kind: 'url', at: process.env.BRICKDEAL_FEED_URL });
  if (process.env.BRICKDEAL_FEED_FILE) out.push({ kind: 'file', at: process.env.BRICKDEAL_FEED_FILE });
  return out;
}

export class FeedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedError';
  }
}

/**
 * A placeholder affiliate link, as the website's fixture carries them.
 *
 * `deals.sample.json` is real product data behind `_PLACEHOLDER…` URLs that do
 * not resolve. The site detects these and shows a red band on every page —
 * which is a safety net, not permission, and the same words apply here. A
 * slideshow whose links are dead is worse than one that was never built: it
 * spends a post, the reach that post earned, and the viewer's trust, and none
 * of the three comes back.
 */
export const isPlaceholder = (deal) =>
  /_?PLACEHOLDER/i.test(String(deal?.link || '')) || /^PLACEHOLDER-/i.test(String(deal?.productId || ''));

/** How many days since this deal's price was last checked, or null if never. */
export function priceAgeDays(deal, now = Date.now()) {
  const at = Date.parse(deal?.priceCheckedAt || '');
  if (!Number.isFinite(at)) return null;
  return (now - at) / DAY_MS;
}

/**
 * Why this deal cannot go on a slide, or null if it can.
 *
 * Returns a reason rather than a boolean because every one of these is going to
 * be reported: the build prints what it dropped and why, exactly as the card
 * pipeline's reject digest does. A filter you cannot see is a filter you cannot
 * disagree with, and the most likely thing to go wrong here is this function
 * quietly eating a whole feed after a schema change upstream.
 */
export function unusable(deal, { now = Date.now() } = {}) {
  // The website's own load rules, first and in its order.
  if (deal?.dead === true) return 'marked dead';
  if (deal?.available === false) return 'marked unavailable';
  if (!String(deal?.name || '').trim()) return 'no name';
  if (!Number.isFinite(Number(deal?.price)) || Number(deal.price) <= 0) return 'no price';
  if (!String(deal?.link || '').trim()) return 'no link';

  // And the two a slide needs on top of them.
  if (isPlaceholder(deal)) return 'placeholder affiliate link';
  if (!String(deal?.image || deal?.sourceImage || '').trim()) return 'no image to build a photograph from';

  const age = priceAgeDays(deal, now);
  if (age === null) return 'price has never been checked';
  if (age > maxAgeDays()) return `price last checked ${Math.round(age)} days ago`;

  return null;
}

/**
 * One feed record in the shape the rest of this pipeline wants.
 *
 * The feed's own field names are kept where they exist — `productId`, `setId`,
 * `pieces` — because they are what brickdeal-automation writes and what a
 * person debugging this will grep for. What is added is derived, not renamed:
 * the series/product split and the theme, both computed exactly as the website
 * computes them so a deal is filed the same way in all three places.
 */
export function normalise(deal) {
  const { series, product } = splitName(deal.name);
  const theme = deal.theme || detectTheme(deal.name) || null;
  return {
    productId: String(deal.productId),
    name: String(deal.name).replace(/\s+/g, ' ').trim(),
    series: series || null,
    product,
    setId: deal.setId ? String(deal.setId).trim() : null,
    pieces: Number.isFinite(Number(deal.pieces)) ? Number(deal.pieces) : null,
    price: Number(deal.price),
    currency: deal.currency || 'ILS',
    stars: Number.isFinite(Number(deal.stars)) ? Number(deal.stars) : null,
    theme,
    themeHe: theme ? THEME_HE[theme] || null : null,
    link: String(deal.link),
    // Which of the two images is the product the link actually sells.
    //
    // `sourceImage` present means the bot swapped `image` for the official
    // render. The render is the prettier picture and the WRONG one to build a
    // photograph from: a clip showing one product while the link sells another
    // is what causes refunds and affiliate complaints, whatever the caption
    // says. So both travel, and images/homeShot.js prefers the seller's.
    image: deal.image ? String(deal.image) : null,
    sourceImage: deal.sourceImage ? String(deal.sourceImage) : null,
    postedAt: deal.postedAt || null,
    priceCheckedAt: deal.priceCheckedAt || null,
  };
}

/** An array of records, however the feed wrapped them. */
const unwrap = (raw) => (Array.isArray(raw) ? raw : Array.isArray(raw?.deals) ? raw.deals : null);

let cached = null;

/**
 * Every deal that may appear on a slide, newest first, with what was dropped.
 *
 * Cached for the life of the process by default. A deck build reads the feed
 * several times — once to propose, once to build — and those two reads must see
 * the same feed, or a proposal can name a deal the build then cannot find.
 * `fresh: true` re-reads, which is what the daily timer wants.
 */
export async function loadDeals({ fresh = false, now = Date.now() } = {}) {
  if (cached && !fresh) return cached;

  const tried = [];
  let raw = null;

  for (const src of sources()) {
    try {
      if (src.kind === 'url') {
        const res = await fetch(src.at, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
      } else {
        raw = JSON.parse(readFileSync(src.at, 'utf8'));
      }
      break;
    } catch (e) {
      tried.push(`${src.at}: ${e.message}`);
      raw = null;
    }
  }

  if (raw === null) {
    throw new FeedError(
      sources().length
        ? `the deal feed could not be read — ${tried.join('; ')}`
        : 'no deal feed configured — set BRICKDEAL_FEED_URL or BRICKDEAL_FEED_FILE'
    );
  }

  const records = unwrap(raw);
  if (!records) throw new FeedError('the deal feed is neither an array nor an object with a `deals` array');

  const deals = [];
  const dropped = [];
  for (const rec of records) {
    const why = unusable(rec, { now });
    if (why) {
      dropped.push({ id: rec?.productId || rec?.name || '(unidentifiable)', why });
      continue;
    }
    deals.push(normalise(rec));
  }

  deals.sort((a, b) => Date.parse(b.postedAt || 0) - Date.parse(a.postedAt || 0));

  // Loudly, and with the count, because the interesting failure is not "the
  // feed was unreachable" — that throws above — but "the feed was read and
  // everything in it was refused". A schema change upstream looks exactly like
  // a quiet day, and one of those is worth waking up for.
  cached = { deals, dropped, total: records.length };
  return cached;
}

/** For tests and for `--fresh`: forget the parsed feed. */
export const __reset = () => {
  cached = null;
};
