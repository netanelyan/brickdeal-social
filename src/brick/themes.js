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
// Keywords match WORDS, not substrings (see `hasWord`). That started here and
// went upstream on 2026-10-06, so the copies agree again: the substring match
// filed a Ford, a Concorde, every חייזר and every מזרקה under flowers, and the
// feed's own `theme` field carried those mistakes. brickdeal-automation's
// nightly refresh now re-derives every stored theme from the name, so a change
// to the keywords reaches the whole feed — make it in all three copies.
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
  // NO BARE 'עץ ' HERE, and it is the one keyword in this file that had to be
  // taken out rather than tuned.
  //
  // It read as "tree" and matched as "wood". One theme roundup came back as a
  // Christmas tree, a tree house and a wooden robot — three sets out of five,
  // none of them botanical, all of them matching 'עץ ' — under a cover that
  // said פרחים וצמחים. A theme deck carrying sets that are not of that theme
  // has told the viewer something false, which is the one thing themeRoundup
  // refuses to do by padding and must not do by detection either.
  //
  // What replaced it is the set of words that can only mean a plant. A
  // botanical tree still lands here through 'בונסאי' and through 'פורח',
  // because a tree this theme wants is always named as one that blossoms.
  ['flowers', ['פרח', 'פרחים', 'פריחה', 'פורח', 'זר ', 'בונסאי', 'סחלב', 'ורדים', 'ורד ', 'סאקורה', 'טוליפ', 'חבצלת', 'לבנדר', 'סוקולנט', 'צמח', 'עציץ', 'קקטוס', 'חמנייה', 'חמניות']],
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

// The letters Hebrew glues onto the front of a word: "and", "the", "in", "to",
// "from", "that", "as". One of them, optionally followed by ה, is still the
// same word — הוורד, בפרחים, והרכב — and anything else in front is a different
// word that happens to contain the keyword.
const PREFIX = /^(?:[והבלמשכ]ה?)?$/;

/**
 * Does `hay` contain `word` as a word, rather than as letters inside another?
 *
 * A bare substring test was what this used, and it filed things wrongly in
 * exactly the way the live feed shows: 'ורד ' (rose) inside פורד and קונקורד put
 * a Ford and a Concorde under flowers, and 'רכב' inside מורכב made anything
 * "complex" a vehicle. So a hit counts only at the start of a word, or behind
 * one of the prefixes above.
 *
 * `whole` also holds the END of the word, for the keywords written with a
 * trailing space ('זר ', 'ורד '). That space was always meant as "this word and
 * not a longer one", and was never honoured: fold() trims, so 'זר ' was matched
 * as 'זר' — inside חזרה, which is how חזרה לעתיד, a DeLorean, was filed under
 * flowers.
 */
function hasWord(hay, word, whole = false) {
  for (let i = hay.indexOf(word); i !== -1; i = hay.indexOf(word, i + 1)) {
    let start = i;
    while (start > 0 && /\p{L}/u.test(hay[start - 1])) start--;
    const run = hay.slice(start, i);
    // A prefix in front of a word that opens with ו doubles the ו in full
    // spelling: ה + ורד is הוורד.
    const doubled = word[0] === 'ו' && run.endsWith('ו') && PREFIX.test(run.slice(0, -1));
    if (!PREFIX.test(run) && !doubled) continue;
    const after = hay[i + word.length];
    if (whole && after !== undefined && /\p{L}/u.test(after)) continue;
    return true;
  }
  return false;
}

// Folded once, with the trailing-space intent kept beside each word.
const FOLDED = THEMES.map(([key, words]) => [key, words.map((w) => ({ word: fold(w), whole: /\s$/.test(w) }))]);

function keywordTheme(hay) {
  for (const [key, words] of FOLDED) {
    for (const { word, whole } of words) if (hasWord(hay, word, whole)) return key;
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

// Themes that are a licence rather than a kind of thing. A set is Star Wars
// because of whose ship it is, so the product half of the name often says
// nothing a keyword can catch — "R2-D2 רובוט", "הליכון AT-AT" — and the series
// prefix naming the franchise is the claim that matters.
const FRANCHISES = new Set(['star-wars', 'harry-potter', 'superheroes', 'minecraft', 'pokemon', 'anime', 'ninjago', 'disney']);

/**
 * May this deal stand on a slide in a deck titled with this theme?
 *
 * A stricter question than `detectTheme`, and it has to be. The feed's `theme`
 * field and its series prefix are written upstream, and both are guesses: the
 * live feed files a pinball machine as `מכוניות | מכונת פינבול קלאסית` with
 * theme `vehicles`, a DeLorean under flowers, and a Christmas tree and a tree
 * house under flowers too. A website filter can live with that. A deck cannot:
 * one went out titled as five car sets with a pinball machine as its cover,
 * and a post that says one thing and shows another loses the viewer on the
 * first frame.
 *
 * So the evidence has to be in the PRODUCT half, which describes the thing in
 * the photograph. For a category theme — vehicles, flowers, technic — the
 * product name itself has to say so. For a franchise the series naming the
 * licence is enough, unless the product names a different franchise. A deal
 * that fails is not mislabelled for anything else; it simply cannot anchor a
 * theme deck, and every other recipe still takes it.
 */
export function fitsTheme(deal, key) {
  if (!deal || !key) return false;
  const name = deal.name || [deal.series, deal.product].filter(Boolean).join(' | ');
  const product = deal.product ?? splitName(name).product;
  const own = keywordTheme(fold(product));
  if (own === key) return true;
  if (!FRANCHISES.has(key)) return false;
  return detectTheme(name) === key && !(own && FRANCHISES.has(own));
}
