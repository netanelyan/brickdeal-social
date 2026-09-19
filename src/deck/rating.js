import { createHash } from 'node:crypto';

// The score on the corner of a slide.
//
// This is the one thing on a deck that is NOT sourced, and it has to stay that
// way on purpose. 11/10 is not a measurement — it is the format's way of saying
// "we loved this", and a viewer reads it as enthusiasm rather than as data. The
// moment it were derived from a real rating it would become a claim, and then
// it would need a quote like everything else.
//
// So it is generated here, it is labelled as ours in the approval message, and
// it never appears in the evidence list. What it must never be is a number that
// looks measured: 7.4/10 would read as a verdict. The scale below only goes up.

// Weighted by how often each should show up, and deliberately spread: a deck
// where four of five slides said 11/10 read as a rubber stamp rather than an
// opinion. Mostly 10/10, with the louder numbers rare enough to mean something.
const SCORES = [
  '10/10', '10/10', '10/10', '10/10', '10/10', '10/10', '10/10',
  '9/10', '9.5/10',
  '11/10', '11/10',
  '12/10',
  '8.5/10',
  '100/10',
  '10/10', '11/10',
];

/**
 * A stable score for a place.
 *
 * Derived from the place id rather than drawn at random, for a reason that
 * matters more than it sounds: a deck re-run after a copy change would
 * otherwise re-roll every score, and a place that was 100/10 on Monday and
 * 10/10 on Tuesday is a page that is obviously making it up.
 */
export function scoreFor(placeId, { top = false } = {}) {
  const h = createHash('sha1').update(String(placeId || '')).digest();
  // The best-rated place in a deck gets the loudest score. It is the one the
  // cover promised, so it should not be the one scored lowest.
  if (top) return h[1] % 3 === 0 ? '100/10' : '11/10';
  // Two bytes, not one: a single byte modulo a 16-long table clustered badly on
  // ids that share a prefix, which every place in one city does.
  return SCORES[((h[0] << 8) | h[3]) % SCORES.length];
}

/** How the score reads on a slide. Ours, and never presented as anyone else's. */
export const scoreLine = (score) => `הדירוג שלנו: ${score}`;
