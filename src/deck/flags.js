// Countries, in Hebrew, with their flag.
//
// Both reference accounts put "Dolomites, Italy 🇮🇹" on the slide and the flag
// on its own line under it, and that line is doing more work than it looks. It
// answers the only question a photograph of a mountain leaves open, it does it
// without a sentence, and it is what makes six slides read as one series.
//
// The Hebrew name and the ISO code both come off Wikidata when the place has a
// P17 — that is the authority, it covers everywhere, and it needs no
// maintenance. The table below is a fallback for the route that has no Wikidata
// entity to hand, and for the handful of countries whose Hebrew name Israelis
// write differently from the transliteration a model would produce.

/**
 * An ISO 3166-1 alpha-2 code to its flag emoji.
 *
 * A flag is two regional indicator symbols, which are the letters A-Z offset
 * into their own block. There is no table to keep up to date and no country
 * this cannot express.
 */
export function flagFor(iso) {
  const code = String(iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * The countries this channel actually posts about.
 *
 * Not a complete list of the world — a list of where Israelis fly, which is the
 * only reason it can be short enough to be checked by eye. Anything missing
 * still works through Wikidata; this is what makes the common cases right
 * without a lookup, and what `npm run fetch-emoji` reads to know which flags to
 * download.
 */
export const COUNTRIES = {
  IT: 'איטליה',
  FR: 'צרפת',
  CH: 'שווייץ',
  AT: 'אוסטריה',
  DE: 'גרמניה',
  ES: 'ספרד',
  PT: 'פורטוגל',
  GR: 'יוון',
  CZ: 'צ׳כיה',
  NL: 'הולנד',
  BE: 'בלגיה',
  LU: 'לוקסמבורג',
  NO: 'נורווגיה',
  SE: 'שוודיה',
  FI: 'פינלנד',
  IS: 'איסלנד',
  DK: 'דנמרק',
  PL: 'פולין',
  HU: 'הונגריה',
  HR: 'קרואטיה',
  SI: 'סלובניה',
  SK: 'סלובקיה',
  RO: 'רומניה',
  BG: 'בולגריה',
  RS: 'סרביה',
  BA: 'בוסניה',
  ME: 'מונטנגרו',
  AL: 'אלבניה',
  MK: 'מקדוניה',
  EE: 'אסטוניה',
  LV: 'לטביה',
  LT: 'ליטא',
  MT: 'מלטה',
  CY: 'קפריסין',
  GB: 'אנגליה',
  IE: 'אירלנד',
  TR: 'טורקיה',
  GE: 'גאורגיה',
  AM: 'ארמניה',
  AZ: 'אזרבייג׳ן',
  IL: 'ישראל',
  JO: 'ירדן',
  EG: 'מצרים',
  MA: 'מרוקו',
  AE: 'איחוד האמירויות',
  JP: 'יפן',
  KR: 'קוריאה',
  CN: 'סין',
  TH: 'תאילנד',
  VN: 'וייטנאם',
  ID: 'אינדונזיה',
  PH: 'הפיליפינים',
  IN: 'הודו',
  NP: 'נפאל',
  LK: 'סרי לנקה',
  US: 'ארצות הברית',
  CA: 'קנדה',
  MX: 'מקסיקו',
  BR: 'ברזיל',
  AR: 'ארגנטינה',
  CL: 'צ׳ילה',
  PE: 'פרו',
  CO: 'קולומביה',
  AU: 'אוסטרליה',
  NZ: 'ניו זילנד',
  ZA: 'דרום אפריקה',
  TZ: 'טנזניה',
  KE: 'קניה',
  KZ: 'קזחסטן',
  UZ: 'אוזבקיסטן',
};

/** Hebrew name and flag for a country code, or nulls. */
export function country(iso) {
  const code = String(iso || '').trim().toUpperCase();
  return { he: COUNTRIES[code] || null, flag: flagFor(code), iso: code || null };
}

/** Every flag the channel might draw, for the artwork fetcher. */
export const ALL_FLAGS = Object.keys(COUNTRIES).map(flagFor).filter(Boolean);
