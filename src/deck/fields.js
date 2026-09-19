// What, if anything, goes under a place's name.
//
// Three reference posts, two accounts, one rule: a slide carries the place NAME
// and nothing else — unless the category has a small set of numbers that ARE
// the decision, in which case it carries exactly those, in exactly the same
// order, on every slide.
//
//   "7 reasons to visit Wyoming"  ->  1. Grand Teton          (name only)
//   "Pettiest views on earth"     ->  Dolomites, Italy 🇮🇹     (name + country)
//   "10/10 hikes in the Dolomites"->  ALPE DI SIUSI 🇮🇹
//                                     🥾 Difficulty: Easy
//                                     📏 Distance: ~5.3 km
//                                     📈 Elevation Gain: ~208 m
//                                     ⏱️ Time: ~1.5 hours
//
// What none of them ever does is put a SENTENCE on a slide. Our decks did -
// "a baroque quarter of alleys and hidden courtyards" is prose, and prose is
// what made them read like a guidebook no matter how the type was set. That is
// the whole reason this file exists.
//
// The test for a field is not "is it true" but "would it change which one I
// pick". Distance and difficulty decide which hike; opening hours decide
// nothing, they are admin you look up after you have chosen.

/**
 * Field specs per deck kind.
 *
 * An empty list is the default and the common case: name only. Adding fields is
 * a deliberate act for a category where a number decides, and the labels are
 * fixed here rather than chosen per slide — the consistency is the point. A
 * slide whose fields differ from its neighbour's reads as improvised.
 */
export const FIELDS_BY_KIND = {
  trail: [
    { key: 'difficulty', labelHe: 'רמת קושי', emoji: '🥾' },
    { key: 'distance', labelHe: 'מרחק', emoji: '📏' },
    { key: 'ascent', labelHe: 'טיפוס', emoji: '📈' },
    { key: 'time', labelHe: 'זמן', emoji: '⏱️' },
  ],
  // A day trip out of a city is chosen on how far it is and how long it eats.
  daytrip: [
    { key: 'travel', labelHe: 'נסיעה', emoji: '🚆' },
    { key: 'time', labelHe: 'זמן', emoji: '⏱️' },
  ],
};

export const fieldsFor = (kind) => FIELDS_BY_KIND[kind] || [];
export const hasFields = (kind) => fieldsFor(kind).length > 0;

/**
 * Does this deck name the country on each slide?
 *
 * True when the deck spans countries — "the prettiest views on earth" needs
 * "Dolomites, Italy 🇮🇹" because the country is half the information. A deck
 * about one city does not: every slide would repeat the same word.
 */
export const showsCountry = (deck) => Boolean(deck?.spansCountries);
