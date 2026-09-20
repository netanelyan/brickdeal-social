import { ALL_FLAGS } from './flags.js';

// The channel's emoji voice.
//
// Supplied by the team, and it is a personality rather than a palette: faces
// and hands doing the reacting, not pictograms labelling the noun. 🕘 next to
// an opening time is what a timetable does; 🫠 next to "closed Mondays" is what
// a person does.
//
// Kept in one place because two different steps draw on it — the score picks
// from it in code, and the drafting brief shows it to the model — and a voice
// that drifts between those two stops being a voice.

export const VOCAB = [
  '😍', '🤩', '🤓', '🥸', '🤯', '😶‍🌫️', '🥵', '🫠', '🫣', '🫨', '🥱', '😵‍💫',
  '👺', '👻', '👽', '🫶', '🙌', '👐', '💪', '🙏', '👌', '👣', '🫂', '🤷‍♂️',
];

// What each band of score should feel like. The low end is the important one:
// a page that never gives anything below 10/10 is a page nobody believes, and
// 🥱 next to 8.5/10 is the joke that makes the high scores mean something.
const BY_BAND = {
  high: ['🤯', '🤩', '😍'], // 12/10 and up
  good: ['😍', '🤩', '🫶'], // 11/10
  solid: ['👌', '🙌', '💪'], // 10/10
  fair: ['🥱', '🤷‍♂️', '😶‍🌫️'], // below 10
};

/** The emoji beside a score, keyed to how loud the number is. */
export function scoreEmoji(score) {
  const n = Number(String(score).split('/')[0]) || 10;
  const band = n >= 12 ? 'high' : n >= 11 ? 'good' : n >= 10 ? 'solid' : 'fair';
  const set = BY_BAND[band];
  // Varied within the band by the score itself, so five 10/10s in one deck do
  // not come back as five identical faces.
  return set[Math.round(n * 2) % set.length];
}

/** The line the drafting brief shows the model, so both steps sound alike. */
export const vocabForPrompt = () => VOCAB.join(' ');

// Everything a slide might reasonably ask for beyond the voice set.
//
// The brief tells the model to prefer VOCAB, but a train beside a train journey
// is sometimes genuinely the better pick, and an emoji with no artwork falls
// back to the system font — which is the inconsistency this whole set exists to
// remove. So the common pictograms are fetched too.
export const ALL_USED = [
  '🚆', '🚌', '🚶', '🧗', '⛰️', '🏔️', '🌊', '🏖️', '🌅', '🌃',
  '🎟️', '💸', '💰', '🕘', '📅', '🔒', '🍽️', '☕', '🍺', '🍷',
  '🛒', '🎨', '🏛️', '⛪', '🕍', '🏰', '📸', '🎧', '✨', '⭐',
  // The field set. These are the ones an info slide draws in a fixed order on
  // every slide of a deck, and they are the emoji the reference posts use for
  // exactly these facts — a boot for difficulty, a ruler for distance, a rising
  // chart for ascent, a stopwatch for time.
  '🥾', '📏', '📈', '⏱️', '🗻', '🧭', '🌡️', '🎿', '🚡', '🛤️',
];

/**
 * Is this string one we have artwork for?
 *
 * Used by the renderer to decide between an <img> and the raw character. A
 * character with no file still renders — it just renders in whatever the
 * machine has, which is the old behaviour and better than an empty box.
 */
export const KNOWN = new Set([...VOCAB, ...ALL_USED, ...ALL_FLAGS]);
