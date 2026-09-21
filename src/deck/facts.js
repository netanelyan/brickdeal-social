// Numbers off Wikidata, for the slides where a number IS the slide.
//
// The pipeline's rule everywhere else is that a claim must be quotable, word
// for word, from a page published by the body that speaks for the place. That
// rule is right and it stays — but it cannot be met by a mountain. A summit has
// no official website, no operator and no opening hours; there is no page to
// quote, which is why summit decks came back as bare names when the one fact
// anybody wants is how high it is.
//
// Wikidata is the answer to that and it is a better one than prose would be.
// P2044 is a number with a unit attached, edited in public, with its own
// source: there is no sentence for a model to misread and no paraphrase for it
// to slip a digit into, because nothing is being written at all. The value is
// copied. The QID is recorded next to it, so every field on a slide can still
// be traced to where it came from.
//
// What this is NOT is a licence to put anything on a slide that Wikidata knows.
// The test for a field is the same as it ever was: would it change which one I
// pick. Height decides which summit; the year a mountain was first climbed is
// a lovely fact and decides nothing, so it is not here.

import { country as countryOf } from './flags.js';

/** Wikidata's unit QIDs, for the handful of units these fields come in. */
const UNITS = {
  Q11573: { he: 'מ׳', scale: 1 }, // metre
  Q828224: { he: 'ק"מ', scale: 1000 }, // kilometre
  Q3710: { he: 'מ׳', scale: 0.3048 }, // foot, normalised to metres
  Q253276: { he: 'ק"מ', scale: 1609.344 }, // mile, normalised to kilometres
};

/**
 * The fields each kind of deck carries, in the order they appear on every
 * slide of it.
 *
 * Short lists on purpose. The reference info slides carry four lines and they
 * are four lines you would actually use to choose between two hikes; a slide
 * with seven is a table, and nobody reads a table on a photograph.
 */
export const WIKIDATA_FIELDS = {
  mountain: [
    // ⛰️ rather than 🗻. The Fuji glyph is a blue-and-white mountain, and a
    // blue-and-white mountain over a blue sky above a snowfield — which is what
    // a summit photograph is — disappears. The brown one survives both.
    { key: 'elevation', labelHe: 'גובה', emoji: '⛰️', prop: 'P2044', as: 'length', unit: 'm' },
    { key: 'range', labelHe: 'רכס', emoji: '🧭', prop: 'P4552', as: 'entity' },
  ],
  waterfall: [{ key: 'drop', labelHe: 'גובה', emoji: '🌊', prop: 'P2044', as: 'length', unit: 'm' }],
  // `distance` / מרחק, NOT `length` / אורך — the same words fields.js uses.
  //
  // Both specs are live for a trail deck: a place with an official page gets
  // its fields drafted from that page (fields.js), a place without one gets
  // them from Wikidata (here). So one deck could carry "מרחק: 12.5 ק״מ" on one
  // slide and "אורך: 9 ק״מ" on the next — the same measurement, under two
  // names, with the same ruler emoji beside both. fields.js already says the
  // labels are fixed centrally because "a slide whose fields differ from its
  // neighbour's reads as improvised"; it was right, and this file was quietly
  // disagreeing with it.
  trail: [{ key: 'distance', labelHe: 'מרחק', emoji: '📏', prop: 'P2043', as: 'length', unit: 'km' }],
  museum: [{ key: 'inception', labelHe: 'נפתח', emoji: '📅', prop: 'P571', as: 'year' }],
  attraction: [{ key: 'inception', labelHe: 'נבנה', emoji: '📅', prop: 'P571', as: 'year' }],
};

/** Every Wikidata property any field spec asks for, plus the country. */
export const WANTED_PROPS = [
  ...new Set([
    'P17', // country — the flag and the Hebrew country name on every slide
    ...Object.values(WIKIDATA_FIELDS).flatMap((list) => list.map((f) => f.prop)),
  ]),
];

/** Entity-valued properties, whose QIDs need a second pass to become labels. */
export const ENTITY_PROPS = [
  'P17',
  ...new Set(
    Object.values(WIKIDATA_FIELDS)
      .flat()
      .filter((f) => f.as === 'entity')
      .map((f) => f.prop)
  ),
];

/** The first value of a claim, or null. Wikidata lists several for many props. */
const firstClaim = (claims, prop) => claims?.[prop]?.[0]?.mainsnak?.datavalue?.value ?? null;

/**
 * A Wikidata quantity to a Hebrew value string.
 *
 * Rounded, because a summit that reads 4,478.35 m is a database row and one
 * that reads 4,478 m is a fact. Units are normalised rather than trusted: a few
 * mountains are recorded in feet, and "14,692 מ׳" on a slide is worse than no
 * slide at all.
 */
export function lengthValue(value, want = 'm') {
  if (!value?.amount) return null;
  const raw = Number(String(value.amount).replace('+', ''));
  if (!Number.isFinite(raw)) return null;

  const unitQid = String(value.unit || '').split('/').pop();
  const unit = UNITS[unitQid];
  // An unrecognised unit is not a reason to guess. Wikidata's default for a
  // unitless quantity is "1", which for an elevation means metres often enough
  // to be tempting and not often enough to be safe.
  if (!unit && unitQid && unitQid !== '1') return null;

  const metres = raw * (unit?.scale ?? 1);
  if (want === 'km') {
    const km = metres / 1000;
    return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} ק"מ`;
  }
  return `${Math.round(metres).toLocaleString('en-US')} מ׳`;
}

/**
 * A Wikidata time to a year.
 *
 * Wikidata pads to four digits — a temple founded in 778 is stored as
 * "+0778-00-00T00:00:00Z" — and the padding went straight onto a slide as
 * "נבנה: 0778". Nobody writes a year that way.
 */
export function yearValue(value) {
  const m = String(value?.time || '').match(/^([+-])(\d{4})/);
  if (!m) return null;
  const year = Number(m[2]);
  if (!year) return null;
  // A negative time is BCE, which Hebrew writes with לפנה"ס rather than a minus
  // sign — and getting that wrong on a slide about an ancient site is worse
  // than leaving the year off.
  return m[1] === '-' ? `${year} לפנה"ס` : String(year);
}

/**
 * The country of a place, in Hebrew, with its flag.
 *
 * `labels` maps a country QID to what the second Wikidata pass found for it:
 * its Hebrew label and its ISO code. The local table in flags.js wins when it
 * has an entry, because Wikidata's Hebrew label for the United Kingdom is
 * "הממלכה המאוחדת" and no Israeli says that.
 */
export function countryFor(claims, labels = new Map()) {
  const qid = firstClaim(claims, 'P17')?.id;
  if (!qid) return { he: null, flag: null };

  const found = labels.get(qid) || {};
  const local = countryOf(found.iso);
  return {
    he: local.he || found.he || null,
    flag: local.flag || null,
    iso: found.iso || null,
  };
}

/**
 * The fields for one place, ready for a slide.
 *
 * Returns only the fields Wikidata actually states. A place missing one gets a
 * shorter list rather than a blank line — and a deck where most places are
 * missing most fields is a deck that should not use this style at all, which
 * is what `enoughFor` below is for.
 */
export function factsFor(kind, claims, { labels = new Map(), countryHe = null } = {}) {
  const spec = WIKIDATA_FIELDS[kind] || [];
  const out = [];

  for (const f of spec) {
    const raw = firstClaim(claims, f.prop);
    if (raw === null) continue;

    let value = null;
    if (f.as === 'length') value = lengthValue(raw, f.unit);
    else if (f.as === 'year') value = yearValue(raw);
    else if (f.as === 'entity') value = labels.get(raw?.id)?.he || null;

    if (!value) continue;
    out.push({ key: f.key, labelHe: f.labelHe, emoji: f.emoji, value, prop: f.prop });
  }

  // No country field, deliberately, even though it is available.
  //
  // The flag already sits beside the name on every info slide, which is how the
  // reference says it. "מדינה: שווייץ" under a Swiss flag is the same fact
  // twice, and on a deck where every place is in one country it is the same
  // fact five times — which is the point at which a slide stops being a slide
  // and starts being a form. `countryHe` stays in the signature because the
  // minimal style does want the word, just not as a field.
  return out.slice(0, 4);
}

/**
 * Does the country belong on the slides, or only the flag?
 *
 * "Tromsø, Norway" earns the word because the next slide says Finland and the
 * one after that says Sweden — the country is half the information. Six Swiss
 * summits in a row do not: the word is identical on every slide and reads as a
 * template filling itself in. The flag stays either way, exactly as the
 * reference does it, because it is an ornament rather than a fact and it is
 * what makes the set look like a set.
 *
 * Mutates in place; the slides are ours and were built moments ago.
 */
export function applyCountryVisibility(slides) {
  const countries = new Set(slides.map((s) => s.countryHe).filter(Boolean));
  if (countries.size > 1) return slides;
  for (const s of slides) s.countryHe = null;
  return slides;
}

/**
 * Is this deck worth setting in the info style?
 *
 * The info style promises the same fields on every slide, so it only works if
 * most slides have them. One hike with a distance and four without is not a
 * deck with fields, it is a deck with one odd slide — and the honest answer
 * there is the minimal style, where a name is the whole slide by design.
 */
export function enoughFor(slides, { need = 1, share = 0.6 } = {}) {
  if (!slides.length) return false;
  const withFields = slides.filter((s) => (s.fields || []).length >= need).length;
  return withFields / slides.length >= share;
}
