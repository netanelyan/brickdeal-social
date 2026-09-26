import { readFileSync } from 'node:fs';

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

/** Everything in brick-config.json, validated. Throws once, loudly, if it can't. */
export function brickConfig() {
  if (cached) return cached;

  let raw;
  try {
    raw = JSON.parse(readFileSync(new URL('../../brick-config.json', import.meta.url), 'utf8'));
  } catch (e) {
    throw new Error(`brick-config.json could not be read: ${e.message}`);
  }

  const labels = raw.labels || {};
  for (const k of ['ours', 'list', 'saving']) {
    if (!String(labels[k] || '').trim()) {
      throw new Error(`brick-config.json: labels.${k} is empty — every price line needs a label`);
    }
  }

  const captionLines = lines(raw.caption?.lines, 'caption.lines');
  // Optional, unlike the others: an empty pool means no engagement line, which
  // is the shape every caption had before this existed and still a valid one.
  const engageLines = Array.isArray(raw.caption?.engage)
    ? raw.caption.engage.map((l) => String(l).trim()).filter(Boolean)
    : [];
  const coverLines = lines(raw.covers?.lines, 'covers.lines').map(coverLine);

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
  const maxSlides = count(deck.maxSlides, 7);
  // Caught here rather than at build time, where it would present as "only two
  // slides survived" on a deck that was never allowed to have more.
  if (!(minSlides <= slides && slides <= maxSlides)) {
    throw new Error(`brick-config.json: deck.slides (${slides}) must sit between minSlides (${minSlides}) and maxSlides (${maxSlides})`);
  }

  cached = {
    copy: { allowTrademark: raw.copy?.allowTrademark === true },
    labels: { ours: labels.ours.trim(), list: labels.list.trim(), saving: labels.saving.trim() },
    // The closing frame. Empty strings are a supported setup rather than a
    // misconfiguration: clear askHe and the deck simply ends on its last deal,
    // which is what it did before there was an end card.
    endCard: {
      askHe: String(raw.endCard?.askHe || '').trim(),
      whereHe: String(raw.endCard?.whereHe || '').trim(),
      siteHe: String(raw.endCard?.siteHe || '').trim(),
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
    covers: { lines: coverLines, swipeHe: String(raw.covers?.swipeHe || '').trim() },
    caption: {
      lines: captionLines,
      engage: engageLines,
      cta: String(raw.caption?.cta || '').trim(),
      separator: String(raw.caption?.separator || '- - - -'),
    },
    hashtags: { broad, niche, broadCount, nicheCount, useTheme: hashtags.useTheme !== false },
    deck: {
      slides,
      minSlides,
      maxSlides,
      priceCeilings: (deck.priceCeilings || [50, 100, 150, 200]).map(Number).filter((n) => Number.isFinite(n) && n > 0),
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
