import { buildDeck } from './build.js';
import { KINDS } from '../sources/places.js';

// Build an idea, and if it comes back too thin, try the next one.
//
// A deck of one slide is not a deck. Before this, a request for a region that
// happened to be badly mapped — or one asked for while Overpass was having a
// bad afternoon — answered with a failure message, and the person who typed it
// got nothing, even though the obvious neighbouring region or the obvious other
// category would have worked.
//
// The alternatives come from the same call that interpreted the request, so
// trying them costs only the build. They are genuinely different by
// construction: a different category in the same region, or the same category
// somewhere better supplied.
//
// Shared between the bot and scripts/deck-once.js deliberately. The script
// exists to answer "what would the bot have posted", and it cannot answer that
// if it gives up where the bot would have tried again.

/** How many slides before a deck counts as one. */
export const ENOUGH = () => Number(process.env.DECK_MIN_SLIDES || 3);

/**
 * @param idea          the first thing to try
 * @param alternatives  [{ where, kind }], best first
 * @param onAttempt     called with (attempt, index, whyPreviousFailed) before each try
 * @returns the first deck with enough slides, or the best of a bad set, or null
 */
export async function buildWithFallback(idea, alternatives = [], { onAttempt = () => {} } = {}) {
  const attempts = [idea, ...alternatives.map((a) => ({ ...idea, ...a, titleHe: '' }))];
  const enough = ENOUGH();
  // Regions the map turned out to know nothing about. A region that is empty
  // of attractions is empty of beaches and trails too, so once it has come back
  // with nothing there is no point spending three more Overpass round-trips on
  // the same bounding box — which is exactly what an Amalfi Coast request did,
  // twice over, before giving the same answer it already had.
  const barren = new Set();
  let best = null;
  let why = null;

  for (const [i, attempt] of attempts.entries()) {
    if (barren.has(attempt.where)) {
      console.error(`deck: skipping ${attempt.where}/${attempt.kind} — that region already came back empty`);
      continue;
    }

    await onAttempt(attempt, i, why);

    const built = await buildDeck(attempt).catch((e) => {
      console.error(`deck: ${attempt.where}/${attempt.kind} failed — ${e.message}`);
      why = e.message;
      return null;
    });

    const n = built?.slides?.length || 0;
    if (n >= enough) return built;

    // Nothing at all, and the map answered — the region itself is the problem,
    // not the category.
    if (!n && built) barren.add(attempt.where);

    why = n ? `only ${n} slide${n === 1 ? '' : 's'}` : why || 'no places found';
    if (n > (best?.slides?.length || 0)) best = built;
  }

  // Nothing reached the threshold. The best of a bad set still beats a failure
  // message, and the caller says how thin it is on the approval card.
  return best;
}

/** How an attempt reads in a status line, in Hebrew. */
export const describeAttempt = (attempt) =>
  `${attempt.where} / ${KINDS[attempt.kind]?.he || attempt.kind}`;
