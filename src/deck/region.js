// Where a deck is, said in one word.
//
// The cover has to name the place, and "the place" is a property of the slides
// rather than of the idea that asked for them. A deck proposed as "Iceland
// waterfalls" and a deck proposed as "Nordic waterfalls" can both come back
// with six Icelandic slides, and only the second one would have been titled
// wrongly — so the question is answered from what survived, not from what was
// requested.
//
// Three answers, in this order:
//
//   one country          — name it.                      "באיסלנד"
//   several, one region  — name the region.              "בסקנדינביה"
//   nothing in common    — name nowhere.                 (the cover says בעולם)
//
// The middle case is the whole reason this file exists. Norway, Sweden and
// Finland on one deck is not "a mix": every viewer reads it as one trip, and a
// cover that refuses to say so because the ISO codes differ is being precise
// about the wrong thing.

import { country as countryOf } from './flags.js';

/**
 * The groupings a Hebrew cover can name, smallest first in spirit and sorted
 * by size in practice.
 *
 * Deliberately overlapping. Germany is central Europe and western Europe both,
 * Croatia is the Balkans and southern Europe both, and which one a deck belongs
 * to depends on the other countries on it — Austria and Czechia make Germany
 * central, France and Belgium make it western. `deckPlace` resolves that by
 * taking the SMALLEST group that covers every country on the deck, which is the
 * one a person would have picked for the same reason.
 *
 * The continents at the bottom are the last resort before saying nothing. A
 * deck of Italian and Norwegian places has no region, but "באירופה" is still
 * true and still tells a viewer more than silence does.
 */
export const REGIONS = [
  { id: 'north-america', he: 'צפון אמריקה', isos: ['US', 'CA'] },
  { id: 'baltics', he: 'המדינות הבלטיות', isos: ['EE', 'LV', 'LT'] },
  { id: 'caucasus', he: 'הקווקז', isos: ['GE', 'AM', 'AZ'] },
  { id: 'nordics', he: 'סקנדינביה', isos: ['IS', 'NO', 'SE', 'FI', 'DK'] },
  { id: 'east-africa', he: 'מזרח אפריקה', isos: ['TZ', 'KE', 'UG', 'RW', 'ET'] },
  { id: 'north-africa', he: 'צפון אפריקה', isos: ['MA', 'EG', 'TN', 'DZ', 'LY'] },
  { id: 'central-asia', he: 'מרכז אסיה', isos: ['KZ', 'UZ', 'KG', 'TJ', 'TM'] },
  { id: 'east-asia', he: 'מזרח אסיה', isos: ['JP', 'KR', 'CN', 'TW', 'MN'] },

  // The one range named instead of the countries under it, and the only entry
  // that asks what the deck is about.
  //
  // "הכפרים הכי יפים באלפים" is right for a Swiss-and-Austrian mountain deck
  // and flatly wrong for a Swiss-and-Austrian museum deck, because a museum in
  // Vienna is not in the Alps. A geographic grouping does not have that problem
  // and therefore does not carry the gate.
  //
  // Smaller than every geographic grouping it overlaps — western, central and
  // southern Europe are all wider — so a summit deck across two alpine
  // countries gets the range, and the same two countries of museums get the
  // half-continent.
  { id: 'alps', he: 'האלפים', kinds: ['mountain', 'trail', 'waterfall'], isos: ['CH', 'AT', 'IT', 'FR', 'DE', 'SI'] },

  { id: 'west-europe', he: 'מערב אירופה', isos: ['FR', 'NL', 'BE', 'LU', 'GB', 'IE', 'DE'] },
  { id: 'south-europe', he: 'דרום אירופה', isos: ['IT', 'ES', 'PT', 'GR', 'MT', 'HR', 'CY'] },
  { id: 'central-europe', he: 'מרכז אירופה', isos: ['CZ', 'AT', 'HU', 'SK', 'PL', 'DE', 'CH', 'SI'] },
  { id: 'central-america', he: 'מרכז אמריקה', isos: ['MX', 'CR', 'PA', 'GT', 'BZ', 'NI', 'HN', 'SV'] },
  { id: 'se-asia', he: 'דרום מזרח אסיה', isos: ['TH', 'VN', 'ID', 'PH', 'MY', 'SG', 'KH', 'LA', 'MM'] },
  { id: 'south-america', he: 'דרום אמריקה', isos: ['BR', 'AR', 'CL', 'PE', 'CO', 'BO', 'EC', 'UY', 'PY', 'VE'] },
  { id: 'balkans', he: 'הבלקן', isos: ['HR', 'SI', 'RS', 'BA', 'ME', 'AL', 'MK', 'BG', 'RO', 'XK', 'GR'] },
  {
    id: 'middle-east',
    he: 'המזרח התיכון',
    isos: ['IL', 'JO', 'EG', 'AE', 'TR', 'OM', 'QA', 'SA', 'LB', 'BH', 'KW'],
  },

  // Continents. Larger than every region above on purpose, so they can only win
  // when nothing tighter covers the deck.
  {
    id: 'asia',
    he: 'אסיה',
    isos: [
      'JP', 'KR', 'CN', 'TW', 'MN', 'TH', 'VN', 'ID', 'PH', 'MY', 'SG', 'KH', 'LA', 'MM',
      'IN', 'NP', 'LK', 'BT', 'BD', 'KZ', 'UZ', 'KG', 'TJ', 'TM', 'GE', 'AM', 'AZ',
    ],
  },
  {
    id: 'europe',
    he: 'אירופה',
    isos: [
      'IT', 'FR', 'CH', 'AT', 'DE', 'ES', 'PT', 'GR', 'CZ', 'NL', 'BE', 'LU', 'NO', 'SE',
      'FI', 'IS', 'DK', 'PL', 'HU', 'HR', 'SI', 'SK', 'RO', 'BG', 'RS', 'BA', 'ME', 'AL',
      'MK', 'XK', 'EE', 'LV', 'LT', 'MT', 'CY', 'GB', 'IE',
    ],
  },
];

/** The ISO codes on a deck, deduplicated and upper-cased. */
const isosOf = (slides) =>
  new Set(
    (slides || [])
      .map((s) => String(s?.iso || '').trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c))
  );

/**
 * Where this deck is, for the cover to name.
 *
 * Returns `{ scope, he }` where scope is 'country', 'region' or 'none'. `he` is
 * null for 'none' and the caller then writes a cover that names nowhere — which
 * is the honest answer for six places on four continents and the wrong one for
 * anything else.
 *
 * `kind` is passed because one grouping depends on it; see the note on `alps`.
 */
export function deckPlace(slides = [], { kind = null } = {}) {
  const none = { scope: 'none', he: null, iso: null };

  const isos = isosOf(slides);

  // One country, and the Hebrew for it is preferably the string already on the
  // slides — the same one the flag was resolved from, so the cover and the
  // slides cannot disagree about what the country is called. The table is the
  // fallback for a place whose P17 resolved to an ISO code but to no Hebrew
  // label, which is a slide with a flag and no word next to it.
  if (isos.size === 1) {
    const [iso] = [...isos];
    const he =
      (slides || []).find((s) => String(s?.iso || '').toUpperCase() === iso && s.countryHe)?.countryHe ||
      countryOf(iso).he;
    return he ? { scope: 'country', he, iso } : none;
  }

  // No country codes at all — the route that builds from our own destination
  // page used to be in exactly this position. Fall back to the Hebrew country
  // name if every slide agrees on one, and otherwise say nothing.
  if (isos.size === 0) {
    const names = new Set((slides || []).map((s) => s?.countryHe).filter(Boolean));
    return names.size === 1 ? { scope: 'country', he: [...names][0], iso: null } : none;
  }

  const covering = REGIONS.filter(
    (r) => (!r.kinds || r.kinds.includes(kind)) && [...isos].every((c) => r.isos.includes(c))
  );
  if (!covering.length) return none;

  // Smallest wins. Two groups of the same size is a tie broken by declaration
  // order, which is why the list is written smallest-first.
  const best = covering.reduce((a, b) => (b.isos.length < a.isos.length ? b : a));
  return { scope: 'region', he: best.he, iso: null };
}

/**
 * Does this cover actually name the place it was given?
 *
 * A substring test, because the cover writes the place with a preposition on
 * it — "איסלנד" arrives as "באיסלנד" — and the preposition is the model's
 * business, not ours. Hebrew grammar has one wrinkle worth handling: ב absorbs
 * a definite ה, so "הפיליפינים" is written "בפיליפינים" and a plain
 * `includes` would call a perfectly good cover a failure. That form is checked
 * WITH the ב attached, so stripping the ה cannot accidentally match a country
 * whose name merely starts with one.
 */
/**
 * Do the slides actually sit where the deck says it went looking?
 *
 * Returns null when they agree or when either side is unknown, and a sentence
 * when they do not. Strict on purpose: a deck headed "United States" carrying
 * six Swiss peaks is not a cosmetic error. The header is wrong, the caption is
 * wrong, and `place` — which the geographic quota measures and the repeat
 * detector counts runs on — is wrong in a way that silently corrupts both.
 *
 * Compared on ISO codes rather than names, because the two sides get their
 * country from different places: the slides from each place's own P17 claim,
 * the region from geocoding the search string. Names disagree harmlessly
 * ("USA" / "United States"); codes do not.
 *
 * Unknown is not mismatch. A region that would not geocode, or slides with no
 * country claim, means there is nothing to check — and refusing a deck because
 * a geocoder timed out would trade a rare wrong label for a common missing
 * post.
 */
export function countryMismatch(slides = [], regionIso = null) {
  const region = String(regionIso || '').toUpperCase();
  if (!region) return null;

  const place = deckPlace(slides);
  if (place.scope !== 'country' || !place.iso) return null;

  const actual = String(place.iso).toUpperCase();
  if (actual === region) return null;

  return `the slides are in ${actual} but the deck searched a region in ${region}`;
}

export function namesPlace(title, he) {
  const t = String(title || '');
  const p = String(he || '').trim();
  if (!p) return true;
  if (t.includes(p)) return true;
  return /^ה./.test(p) && t.includes(`ב${p.slice(1)}`);
}
