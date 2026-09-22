import { readFileSync } from 'node:fs';

// post-config.json, read once and checked on the way in.
//
// The file holds the editorial decisions that get changed after looking at a
// week of numbers — the caption pool, the hashtag mix, how big the type is on a
// slide, which countries the pipeline leans toward. None of it is structural,
// all of it is the sort of thing you want to edit without opening a module.
//
// Read the way sources.json and destinations.json are read: synchronously, on
// first use, cached for the life of the process, and THROWING when the file is
// unusable. That last part is deliberate. A silent fallback would publish a
// post with no hashtags and no caption line, which looks exactly like a post
// that was never configured to have any — and the whole point of moving these
// out of the code was to make them visible.

let cached = null;

/** Everything in post-config.json, validated. Throws once, loudly, if it can't. */
export function postConfig() {
  if (cached) return cached;

  let raw;
  try {
    raw = JSON.parse(readFileSync(new URL('../post-config.json', import.meta.url), 'utf8'));
  } catch (e) {
    throw new Error(`post-config.json could not be read: ${e.message}`);
  }

  const caption = raw.caption || {};
  const hashtags = raw.hashtags || {};
  const overlay = raw.overlay || {};
  const destinations = raw.destinations || {};

  const lines = (caption.lines || []).map((s) => String(s).trim()).filter(Boolean);
  if (!lines.length) throw new Error('post-config.json: caption.lines is empty — every post needs an opening line');

  const broad = tags(hashtags.broad, 'hashtags.broad');
  const niche = tags(hashtags.niche, 'hashtags.niche');
  const broadCount = count(hashtags.broadCount, 2);
  const nicheCount = count(hashtags.nicheCount, 3);
  if (broad.length < broadCount) throw new Error(`post-config.json: hashtags.broad has ${broad.length} tags, needs ${broadCount}`);
  if (niche.length < nicheCount) throw new Error(`post-config.json: hashtags.niche has ${niche.length} tags, needs ${nicheCount}`);

  cached = {
    caption: { lines },
    hashtags: {
      broad,
      niche,
      broadCount,
      nicheCount,
      // One of the niche slots is spent on the deck's own country rather than
      // added as a sixth tag — see the note in the file.
      useDestination: hashtags.useDestination !== false,
    },
    overlay: {
      sizePct: num(overlay.sizePct, 0.03),
      sizeBasis: overlay.sizeBasis === 'height' ? 'height' : 'width',
      coverSizePct: num(overlay.coverSizePct, 0.034),
      weight: num(overlay.weight, 400),
      opacity: num(overlay.opacity, 0.9),
      shadow: String(overlay.shadow || '0 1px 3px rgba(0,0,0,0.38)'),
      maxLines: Math.max(1, Math.round(num(overlay.maxLines, 2))),
      align: overlay.align === 'right' ? 'right' : 'left',
      x: num(overlay.x, 0.3),
      width: num(overlay.width, 0.44),
      bands: {
        upper: band(overlay.bands?.upper, [0.2, 0.36]),
        lower: band(overlay.bands?.lower, [0.6, 0.78]),
      },
      assist: overlay.assist !== false,
    },
    destinations: {
      defaultWeight: num(destinations.defaultWeight, 1),
      weights: { ...(destinations.weights || {}) },
    },
  };

  return cached;
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const count = (v, fallback) => Math.max(0, Math.round(num(v, fallback)));

/** A vertical band as [top, bottom] in frame fractions, or the default. */
function band(v, fallback) {
  if (!Array.isArray(v) || v.length !== 2) return fallback;
  const [a, b] = v.map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : fallback;
}

/**
 * A hashtag pool, normalised.
 *
 * The leading # is added here rather than required in the file, so an entry
 * written either way works and no post ever goes out with "fyp" as a word.
 */
function tags(list, where) {
  if (!Array.isArray(list)) throw new Error(`post-config.json: ${where} must be an array`);
  const out = [];
  for (const t of list) {
    const clean = String(t || '').trim().replace(/^#+/, '');
    if (!clean) continue;
    const tag = `#${clean.replace(/\s+/g, '')}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * How strongly this pipeline should prefer a destination.
 *
 * Keyed on the Hebrew country name, which is what destinations.json carries.
 * An unlisted country gets the default rather than zero — the weights say what
 * to lead with, not what is allowed.
 */
export function destinationWeight(dest) {
  const { defaultWeight, weights } = postConfig().destinations;
  const country = String(dest?.country || '').trim();
  return num(weights[country], defaultWeight);
}

/**
 * The same destinations, heaviest first, ties left exactly as they arrived.
 *
 * A stable sort rather than a weighted shuffle, and that is the right tool
 * here: both callers already have an ordering they want preserved inside a
 * tier — the climate adapter's day-of-year rotation, the idea generator's file
 * order — and randomising it would throw away the thing that stops the same
 * city coming up every day.
 */
export const byWeight = (dests) =>
  [...(dests || [])]
    .map((d, i) => ({ d, i, w: destinationWeight(d) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.d);

/** For tests: forget the parsed file so the next call re-reads it. */
export const __reset = () => {
  cached = null;
};
