import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// brick-config.json, read once and checked on the way in.
//
// Same posture as postConfig.js, and for the same reason: read synchronously on
// first use, cached for the life of the process, and THROWING when the file is
// unusable. A silent fallback would publish a post with no hashtags and no
// caption, which looks exactly like a post that was never configured to have
// any — and the whole point of moving these decisions out of the code was to
// make them visible.
//
// Separate from post-config.json rather than merged into it. That file is the
// travel pipeline's and its numbers are asserted by the existing suite; this
// one is BrickDeal's. They come together when the travel half is stripped.

let cached = null;

/**
 * Where the file is.
 *
 * Overridable for the same reason STORE_PATH is (see src/store.js): the panel can
 * now WRITE this file, so the test that proves a broken save is rolled back has to
 * have its own copy to break. Pointing the suite at the live file would mean a
 * test that deliberately corrupts the account's caption rules.
 */
export const configPath = () =>
  process.env.BRICK_CONFIG_PATH
    ? resolve(process.env.BRICK_CONFIG_PATH)
    : fileURLToPath(new URL('../../brick-config.json', import.meta.url));

/** Everything in brick-config.json, validated. Throws once, loudly, if it can't. */
export function brickConfig() {
  if (cached) return cached;

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch (e) {
    throw new Error(`brick-config.json could not be read: ${e.message}`);
  }

  const labels = raw.labels || {};
  for (const k of ['ours', 'list', 'saving']) {
    if (!String(labels[k] || '').trim()) {
      throw new Error(`brick-config.json: labels.${k} is empty — every price line needs a label`);
    }
  }
  // The two a per-piece deck adds, defaulted rather than demanded. Same posture
  // as caption.engage and covers.priceLines: a config written before that
  // recipe existed is not a broken config, and throwing on it would take the
  // whole pipeline down over a deck shape nobody had asked for yet.
  const fallback = (v, or) => String(v || '').trim() || or;

  const captionLines = lines(raw.caption?.lines, 'caption.lines');
  // Optional, unlike the others: an empty pool means no engagement line, which
  // is the shape every caption had before this existed and still a valid one.
  const engageLines = Array.isArray(raw.caption?.engage)
    ? raw.caption.engage.map((l) => String(l).trim()).filter(Boolean)
    : [];
  // The reason to follow, same posture as engage: optional, drawn per post.
  const followLines = Array.isArray(raw.caption?.follow)
    ? raw.caption.follow.map((l) => String(l).trim()).filter(Boolean)
    : [];
  const coverLines = lines(raw.covers?.lines, 'covers.lines').map(coverLine);
  // The price-led covers. Optional, like the engage pool: an empty list means
  // no post ever leads with the number, which is the shape every post had
  // before this existed. Parsed through coverLine so they carry their emphasis
  // in stars exactly like the pool above — the substitution happens later, in
  // priceHook, on both halves.
  const priceLines = (Array.isArray(raw.covers?.priceLines) ? raw.covers.priceLines : [])
    .map((l) => String(l).trim())
    .filter(Boolean)
    .map(coverLine);
  // The whole-deck fraction covers, same posture again: optional, starred, and
  // filled in later — by ratioHook, with `{fraction}`.
  const ratioLines = (Array.isArray(raw.covers?.ratioLines) ? raw.covers.ratioLines : [])
    .map((l) => String(l).trim())
    .filter(Boolean)
    .map(coverLine);

  const hashtags = raw.hashtags || {};
  const broad = tags(hashtags.broad, 'hashtags.broad');
  const niche = tags(hashtags.niche, 'hashtags.niche');
  const broadCount = count(hashtags.broadCount, 2);
  const nicheCount = count(hashtags.nicheCount, 3);
  if (broad.length < broadCount) throw new Error(`brick-config.json: hashtags.broad has ${broad.length} tags, needs ${broadCount}`);
  if (niche.length < nicheCount) throw new Error(`brick-config.json: hashtags.niche has ${niche.length} tags, needs ${nicheCount}`);

  const ov = raw.overlay || {};
  const deck = raw.deck || {};

  const slides = count(deck.slides, 5);
  const minSlides = count(deck.minSlides, 3);
  // Eight, because the frame count is the set count plus the cover and the end
  // card, and Instagram refuses a carousel of more than ten.
  const maxSlides = count(deck.maxSlides, 8);
  // Caught here rather than at build time, where it would present as "only two
  // slides survived" on a deck that was never allowed to have more.
  if (!(minSlides <= slides && slides <= maxSlides)) {
    throw new Error(`brick-config.json: deck.slides (${slides}) must sit between minSlides (${minSlides}) and maxSlides (${maxSlides})`);
  }
  // And never past what Instagram will take. Above eight the carousel is cut to
  // ten frames at publish time, and what it cuts is the end card.
  if (slides > 8) {
    throw new Error(`brick-config.json: deck.slides (${slides}) plus the cover and the end card is more than Instagram's ten`);
  }

  cached = {
    copy: { allowTrademark: raw.copy?.allowTrademark === true },
    labels: {
      ours: labels.ours.trim(),
      list: labels.list.trim(),
      saving: labels.saving.trim(),
      pieces: fallback(labels.pieces, 'חלקים'),
      perPiece: fallback(labels.perPiece, 'לחלק'),
    },
    // The closing frame. Empty strings are a supported setup rather than a
    // misconfiguration: clear askHe and the deck simply ends on its last deal,
    // which is what it did before there was an end card.
    endCard: {
      askHe: String(raw.endCard?.askHe || '').trim(),
      whereHe: String(raw.endCard?.whereHe || '').trim(),
      siteHe: String(raw.endCard?.siteHe || '').trim(),
      // One fixed line rather than a pool, unlike the caption's. The end card is
      // the same frame on every post by design — that sameness is what makes it
      // recognisable — and a reason to follow that changed each time would be
      // the one thing on it that did not settle.
      followHe: String(raw.endCard?.followHe || '').trim(),
    },
    overlay: {
      sizeBasis: ov.sizeBasis === 'height' ? 'height' : 'width',
      align: ov.align === 'right' ? 'right' : 'center',
      namePct: num(ov.namePct, 0.041),
      linePct: num(ov.linePct, 0.031),
      coverPct: num(ov.coverPct, 0.035),
      weight: num(ov.weight, 700),
      strokePct: num(ov.strokePct, 0.0018),
      shadow: String(ov.shadow || '0 2px 10px rgba(0,0,0,0.42)'),
      opacity: num(ov.opacity, 0.96),
      lineHeight: num(ov.lineHeight, 1.16),
      maxNameLines: Math.max(1, count(ov.maxNameLines, 2)),
      topPct: num(ov.topPct, 0.145),
      // Where the cover's hook sits, which is NOT where a set name sits.
      //
      // The travel posts put their hook across the middle, and copying that
      // number put it straight across the model: a landscape fills the frame,
      // a product shot has its subject in the lower two thirds with room above
      // it. Which is precisely the objection the travel renderer raised against
      // centring in the first place - it is right about the subject and wrong
      // about where the subject is here.
      coverTopPct: num(ov.coverTopPct, 0.3),
      sidePct: num(ov.sidePct, 0.06),
      widthPct: num(ov.widthPct, 0.84),
      emphasis: String(ov.emphasis || '#F7E3A1'),
    },
    covers: {
      lines: coverLines,
      swipeHe: String(raw.covers?.swipeHe || '').trim(),
      // The swipe line for a cover that already printed both numbers. The
      // ordinary one offers to show what the set costs at the original brand,
      // which is the thing a price-led cover has just finished saying. Empty
      // falls back to the ordinary line.
      swipePriceHe: String(raw.covers?.swipePriceHe || '').trim(),
      priceLines,
      ratioLines,
      // How often a post leads with the number instead of asking for a guess.
      //
      // Clamped rather than validated, because the failure it guards against is
      // a typo in a hand-edited file: `1.5` read literally means every cover is
      // price-led forever and the guess-the-price shape silently stops being
      // used, which nobody would notice from the outside for a fortnight.
      priceLedShare: Math.min(1, Math.max(0, num(raw.covers?.priceLedShare, 0.4))),
    },
    caption: {
      lines: captionLines,
      engage: engageLines,
      follow: followLines,
      cta: String(raw.caption?.cta || '').trim(),
      separator: String(raw.caption?.separator || '- - - -'),
    },
    hashtags: { broad, niche, broadCount, nicheCount, useTheme: hashtags.useTheme !== false },
    deck: {
      slides,
      minSlides,
      maxSlides,
      priceCeilings: (deck.priceCeilings || [50, 100, 150, 200]).map(Number).filter((n) => Number.isFinite(n) && n > 0),
      // The per-piece deck's ceilings, IN AGOROT — a different unit from the
      // list above and therefore a different key. Walked upward the same way,
      // for the same reason: "עד 8 אגורות לחלק" is a tighter claim than "עד 20"
      // and a better hook, so the lowest one that can still fill a deck wins.
      agorotCeilings: (deck.agorotCeilings || [5, 8, 10, 15, 20]).map(Number).filter((n) => Number.isFinite(n) && n > 0),
      // Below this a per-piece figure flatters rather than informs: the metric
      // is an average over the box, and a box of forty big elements averages
      // low while being a worse buy than the number says. The bar is on the
      // recipe rather than on the feed because it is a rule about what this one
      // deck may claim, not about what may be sold.
      minPieces: count(deck.minPieces, 200),
    },
  };

  return cached;
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const count = (v, fallback) => Math.max(0, Math.round(num(v, fallback)));

/**
 * A cover line, with its emphasis taken out of the stars.
 *
 * `"איך אנשים עדיין משלמים *מחיר מלא*?"` becomes the plain sentence plus the
 * phrase to set in cream. Parsed here rather than in the renderer so that the
 * stars can never reach a slide: a config line with one unbalanced star would
 * otherwise publish an asterisk in white type across a photograph, which is
 * exactly the kind of thing nobody notices until it is on TikTok.
 *
 * An unmarked line is not an error - it simply has no emphasis and sets in one
 * colour, which is what a cover with nothing to shout should do.
 */
export function coverLine(raw) {
  const s = String(raw || '');
  const m = s.match(/^(.*?)\*([^*]+)\*(.*)$/);
  if (!m) return { text: s.replace(/\*/g, '').trim(), emphasis: null };
  const emphasis = m[2].trim();
  return { text: `${m[1]}${emphasis}${m[3]}`.replace(/\*/g, '').replace(/\s+/g, ' ').trim(), emphasis };
}

function lines(list, where) {
  const out = (list || []).map((s) => String(s).trim()).filter(Boolean);
  if (!out.length) throw new Error(`brick-config.json: ${where} is empty`);
  return out;
}

/**
 * A hashtag pool, normalised.
 *
 * The leading # is added here rather than required in the file, so an entry
 * written either way works and no post ever goes out with "fyp" as a word.
 */
function tags(list, where) {
  if (!Array.isArray(list)) throw new Error(`brick-config.json: ${where} must be an array`);
  const out = [];
  for (const t of list) {
    const clean = String(t || '').trim().replace(/^#+/, '');
    if (!clean) continue;
    const tag = `#${clean.replace(/\s+/g, '')}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** For tests: forget the parsed file so the next call re-reads it. */
export const __reset = () => {
  cached = null;
};
