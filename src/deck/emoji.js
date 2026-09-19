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
