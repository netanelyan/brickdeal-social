import { THEME_KEYS } from './themes.js';

// The one emoji beside a set's name.
//
// The reference puts exactly one at the end of the name line — 🌸 on an orchid,
// 🏎️ on a Porsche — and it is doing real work: it is the only colour in a block
// of white-on-black type, and it tells you what kind of thing the slide is
// about before you have read a word of it.
//
// A FIXED MAP RATHER THAN A MODEL CALL, and the travel side of this repo
// explains why better than this comment can. Its rule is that a free choice of
// emoji "produces decoration rather than meaning — a sheaf of wheat turned up
// beside 'this is where the Velvet Revolution happened'". That objection is to
// a model picking freely for an arbitrary sentence. It does not apply to a
// fixed emoji tied to a fixed category, which is the same arrangement that file
// makes for its field set — a boot for difficulty, a ruler for distance — and
// endorses for exactly this reason.
//
// It is also free, deterministic, and cannot fail on the one deck where the
// model is having a bad day.

/** Theme key to its emoji. Every key in themes.js has one. */
export const THEME_EMOJI = {
  'star-wars': '🚀',
  'harry-potter': '🪄',
  superheroes: '🦸',
  minecraft: '⛏️',
  pokemon: '⚡',
  anime: '🗾',
  ninjago: '🐉',
  disney: '🏰',
  technic: '⚙️',
  architecture: '🏛️',
  trains: '🚂',
  boats: '⛵',
  space: '🚀',
  military: '🪖',
  dinosaurs: '🦖',
  castle: '🏰',
  fantasy: '🐉',
  vehicles: '🏎️',
  flowers: '🌸',
  friends: '☕',
  city: '🏙️',
  duplo: '🧸',
  creator: '🧩',
};

// The fallback, and the deck's own default.
//
// A brick. It says "this is a building set" and nothing more, which is the
// honest thing to say about a deal whose theme did not resolve — and a
// slideshow where one slide out of five has no emoji at all looks like the
// slide that broke.
export const DEFAULT_EMOJI = '🧱';

/**
 * A few names that beat their own theme.
 *
 * Kept deliberately short. The theme map is right almost always, and the
 * temptation here is to grow this into a second keyword matcher that disagrees
 * with themes.js — which is the bug the website's README warns about, where
 * three places derive a theme and quietly drift apart. These are only the cases
 * where the theme is correct and the emoji it implies is actively wrong: a
 * flower theme carrying a bonsai is not a blossom, a vehicles theme carrying a
 * motorbike is not a racing car.
 */
const OVERRIDES = [
  // Construct forms matter in Hebrew: a castle is טירה standing alone and טירת
  // in "טירת הוגוורטס", and matching only the first misses most real names.
  [/טיר[הת]/, '🏰'],
  [/רכבת|קטר/, '🚂'],
  [/ספינ|אוני[יה]|מפרשית/, '⛵'],
  [/חללית|מעבורת/, '🚀'],
  [/דרקון/, '🐉'],
  [/בונסאי|עץ /, '🌳'],
  [/אופנוע/, '🏍️'],
  [/משאית/, '🚚'],
  [/אוטובוס/, '🚌'],
  [/צוללת/, '🤿'],
  [/מסוק/, '🚁'],
  [/מטוס/, '✈️'],
  [/גיטרה/, '🎸'],
  [/פסנתר/, '🎹'],
  [/מצלמה/, '📸'],
  [/כדורגל/, '⚽'],
];

/** The emoji for one deal. */
export function emojiFor(deal) {
  const name = String(deal?.name || '');
  for (const [re, ch] of OVERRIDES) if (re.test(name)) return ch;
  return THEME_EMOJI[deal?.theme] || DEFAULT_EMOJI;
}

/**
 * Everything a BrickDeal slide might draw, for the artwork fetcher.
 *
 * The money bag is on every saving line and is not in either map above, so it
 * is named here — it is the single most-drawn emoji on the channel and the one
 * whose absence would be most obvious.
 */
export const ALL_USED = [
  ...new Set([...Object.values(THEME_EMOJI), ...OVERRIDES.map(([, ch]) => ch), DEFAULT_EMOJI, '💰', '⭐', '📦']),
];

/** A build-time check that no theme was added to themes.js without an emoji. */
export const missingThemes = () => THEME_KEYS.filter((k) => !THEME_EMOJI[k]);
