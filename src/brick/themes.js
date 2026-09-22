// Theme detection and the Hebrew label for each theme.
//
// A port of `src/themes.js` in brickdeal-automation (delivered as `bot/themes.js`
// in brickdeal-website), kept deliberately identical rather than improved. The
// website's README names three places that must agree on these keys —
// the bot's detection, the site's chips, and build.js's deal pages — and a
// slideshow is now a fourth. A theme that means one thing on a slide and
// another in the grid is a bug nobody sees until a viewer follows the post to
// the site and finds a different set of deals under the same word.
//
// The feed usually carries `theme` already, so detection here is a fallback for
// legacy records. `THEME_HE` is the part this repo actually uses on every post:
// it names the deck on its cover and spends one of the five hashtag slots.

// The site-facing label for each theme, then the short forms the bot tends to
// use as a series prefix. The FIRST label is the display name.
const LABELS = {
  'star-wars': ['מלחמת הכוכבים', 'סטאר וורס'],
  'harry-potter': ['הארי פוטר'],
  superheroes: ['גיבורי על', 'גיבורי-על', 'מארוול', 'די סי'],
  minecraft: ['מיינקראפט'],
  pokemon: ['פוקימון'],
  anime: ['אנימה'],
  ninjago: ['נינג׳גו'],
  disney: ['דיסני'],
  technic: ['טכניק', 'טכני'],
  architecture: ['ארכיטקטורה', 'אדריכלות'],
  trains: ['רכבות'],
  boats: ['ספינות'],
  space: ['חלל'],
  military: ['צבאי'],
  dinosaurs: ['דינוזאורים'],
  castle: ['טירות ואבירים', 'טירות', 'אבירים'],
  fantasy: ['פנטזיה'],
  vehicles: ['רכבים', 'מכוניות'],
  flowers: ['פרחים וצמחים', 'פרחים', 'צמחים', 'בוטני'],
  friends: ['חברות'],
  city: ['עיר'],
  duplo: ['לפעוטות', 'פעוטות'],
  creator: ['קריאייטור'],
};

/** Theme key to the Hebrew label a post says out loud. */
export const THEME_HE = Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, v[0]]));

// Order matters: the first theme with a keyword hit wins, so the specific
// franchises sit above the generic categories that would otherwise swallow them
// — an X-Wing is star-wars, not space; a Batmobile is superheroes, not vehicles.
const THEMES = [
  ['star-wars', ['מלחמת הכוכבים', 'סטאר וורס', 'טיי פייטר', 'אקס ווינג', 'מילניום', 'פאלקון', 'דארת', 'ווידר', 'יודה', 'מנדלוריאן', 'סטורמטרופר', 'חרב אור', 'ג׳דיי', 'גדיי', 'קלון']],
  ['harry-potter', ['הארי פוטר', 'הוגוורטס', 'הוגוארטס', 'וולדמורט', 'הרמיוני', 'דמבלדור', 'קוידיץ', 'קווידיץ', 'הוגסמיד', 'תלתן']],
  ['superheroes', ['מארוול', 'מרוול', 'ספיידרמן', 'איש העכביש', 'אוונג׳רס', 'אוונג', 'איירון מן', 'איש הברזל', 'הענק הירוק', 'האלק', 'ת׳ור', 'קפטן אמריקה', 'ונום', 'גרוט', 'גיבור', 'באטמן', 'סופרמן', 'וונדר וומן', 'ג׳וקר', 'הג׳וקר', 'באטמוביל', 'גות׳אם', 'גותאם', 'אקווהמן', 'פלאש', 'גיבורי על']],
  ['minecraft', ['מיינקראפט', 'מיינקרפט', 'קריפר', 'סטיב ואלכס']],
  ['pokemon', ['פוקימון', 'פיקאצ׳ו', 'פיקאצו', 'צ׳ריזארד']],
  ['anime', ['אנימה', 'נארוטו', 'דרגון בול', 'וואן פיס', 'גונדם', 'סיילור מון']],
  ['ninjago', ['נינג׳גו', 'נינגגו', 'נינג׳ה', 'נינגה', 'דרקון נינ']],
  ['disney', ['דיסני', 'מיקי מאוס', 'פרוזן', 'אלזה', 'נסיכות', 'ארמון הנסיכות', 'ווינטר', 'סטיץ', 'טוי סטורי']],
  ['technic', ['טכניק', 'טכני', 'מנוע', 'שלט רחוק', 'גיר', 'מלגזה', 'מנוף', 'טרקטור', 'באגי', 'שנאי', 'הידראול']],
  ['architecture', ['ארכיטקטורה', 'אדריכלות', 'מגדל אייפל', 'טאג׳ מאהל', 'טאג מאהל', 'קולוסאום', 'קו רקיע', 'בית לבן', 'פסל החירות', 'נוטרדאם', 'ביג בן']],
  ['trains', ['רכבת', 'רכבות', 'קטר', 'מסילה', 'תחנת רכבת']],
  ['boats', ['ספינה', 'ספינת', 'אונייה', 'אוניית', 'פיראט', 'סירה', 'מפרשית', 'טיטאניק', 'נמל']],
  ['space', ['חללית', 'חלל', 'נאס״א', 'נאסא', 'אפולו', 'רקטה', 'טיל חלל', 'אסטרונאוט', 'מאדים', 'ירח', 'מעבורת']],
  ['military', ['טנק', 'צבאי', 'חייל', 'מסוק קרב', 'נגמ״ש', 'נגמש', 'מטוס קרב', 'צוללת', 'רובה']],
  ['dinosaurs', ['דינוזאור', 'דינוזאורים', 'טי רקס', 'טירנוזאורוס', 'רפטור', 'פארק היורה', 'עולם היורה', 'טרודון', 'ברכיוזאורוס']],
  ['castle', ['טירה', 'טירת', 'אביר', 'אבירים', 'ימי הביניים', 'מבצר', 'קסטל']],
  ['fantasy', ['דרקון', 'קוסם', 'קסם', 'אלף', 'גמד', 'שר הטבעות', 'הוביט', 'משחקי הכס', 'חד קרן', 'פיה', 'מכשפה']],
  ['vehicles', ['מכונית', 'מכוניות', 'רכב', 'פורשה', 'פרארי', 'למבורגיני', 'בוגאטי', 'מוסטנג', 'ג׳יפ', 'ג׳יפים', 'אופנוע', 'מרוץ', 'מרוצ', 'פורמולה', 'משאית', 'קורבט', 'מרצדס', 'ב.מ.וו', 'במוו', 'מכונית הזמן']],
  ['flowers', ['פרח', 'פרחים', 'זר ', 'בונסאי', 'סחלב', 'ורדים', 'צמח', 'עציץ', 'קקטוס', 'חמנייה', 'חמניות', 'עץ ']],
  ['friends', ['חברות', 'פרנדס', 'סלון יופי', 'בית קפה', 'חנות', 'קניון', 'מספרה', 'ספא']],
  ['city', ['עיר', 'תחנת משטרה', 'משטרה', 'מכבי אש', 'כבאית', 'אמבולנס', 'בית חולים', 'בניין', 'שדה תעופה', 'תחנת דלק', 'אוטובוס']],
  ['duplo', ['פעוטות', 'לפעוט', 'גיל הרך', 'קוביות גדולות', 'דופלו']],
  ['creator', ['קריאייטור', 'קריאטור', 'שלושה באחד', '3 באחד']],
];

// Longest keyword first inside each theme, so "מטוס קרב" beats a bare "מטוס".
for (const [, words] of THEMES) words.sort((a, b) => b.length - a.length);

/** Normalise Hebrew for matching: strip niqqud, unify the apostrophe variants. */
function fold(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/['`׳’]/g, '׳')
    .replace(/["״“”]/g, '״')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const LABEL_TO_KEY = new Map();
for (const [key, labels] of Object.entries(LABELS)) {
  for (const l of labels) LABEL_TO_KEY.set(fold(l), key);
}

/**
 * Split a structured name into its series and product.
 *
 * Names are stored `"<series> | <product>"` exactly as the channel post reads.
 * A legacy record with no pipe comes back with no series and the whole string
 * as the product, which is what the website does with one too.
 */
export function splitName(name) {
  const full = String(name || '').replace(/\s+/g, ' ').trim();
  const m = full.match(/^(.+?)\s*\|\s*(.+)$/);
  if (!m) return { series: undefined, product: full };
  return { series: m[1].trim(), product: m[2].trim() };
}

function keywordTheme(hay) {
  for (const [key, words] of THEMES) {
    for (const w of words) if (hay.includes(fold(w))) return key;
  }
  return undefined;
}

/**
 * The theme key for a Hebrew product name, or undefined.
 *
 * The series prefix is the bot stating the theme outright, so it is tried
 * first and alone — the product half can mention a Batmobile inside a Technic
 * set. No match is not an error: an unthemed deal still appears in a price
 * roundup, it simply cannot anchor a theme one. A wrong theme is worse than a
 * missing one, because it hides the deal from the filter it belongs to.
 */
export function detectTheme(name) {
  const { series } = splitName(name);
  if (series) {
    const s = fold(series);
    const exact = LABEL_TO_KEY.get(s);
    if (exact) return exact;
    const byWord = keywordTheme(s);
    if (byWord) return byWord;
  }
  const hay = fold(name);
  return hay ? keywordTheme(hay) : undefined;
}

export const THEME_KEYS = THEMES.map(([k]) => k);
