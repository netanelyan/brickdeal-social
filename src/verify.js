// The gate. Everything that publishes has to get through here first.
//
// Three separate rules from the brief live in this file, all enforced as code
// rather than as instructions in a prompt:
//
//   1. "No claim without a primary source. No source, no candidate."
//      -> the URL must be on an allowlisted authority domain AND the page must
//         actually be reachable right now.
//   2. Claims must come from that source, not from the model's memory.
//      -> the drafting step returns verbatim quotes; every one is checked to
//         literally appear in the fetched page text. A quote that isn't there
//         means the model wrote from recollection, and the candidate dies.
//   3. "Not in version one: flight prices."
//      -> a hard guard, not a note. A fare that reaches the draft is rejected.

import { primaryAuthority } from './sources/index.js';
import { fetchReadable, FetchError } from './fetchPage.js';

export class RejectedError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail;
  }
}

// How much text a page must carry before it is worth a drafting call.
//
// This bar was originally 200 characters, which only caught pages that were
// literally empty. Measuring a real run showed why that was too low: the
// press-release stubs on the wire carried 291 and 346 characters, sailed
// through, and were then correctly rejected by the model as "only a headline,
// no substantive details" — after the call was paid for. Three of eight calls
// in one run went that way. Everything genuinely usable that day carried 3,157
// characters or more, so there is a wide gap to put the bar in.
//
// The two floors exist because a character is not a constant unit of
// information. 300 characters of Japanese is a paragraph; 300 characters of
// English is a sentence and a half. Judging both by one number would either
// wave the stubs through or throw away real articles from the Japanese source.
//
// Tuned on a sample of one day's items, so both are env-overridable and the
// rejection reports the count it measured against the floor it used — if this
// ever starts eating good sources, the digest says so in numbers.
const THIN_FLOOR = Number(process.env.MIN_SOURCE_CHARS ?? 1200);
const THIN_FLOOR_SPACELESS = Number(process.env.MIN_SOURCE_CHARS_CJK ?? 700);

// A third floor, for content that arrived in a feed rather than on a page.
//
// The 1,200 figure was measured against fetched web pages, and a web page pays
// for its own furniture: menus, breadcrumbs, related links, the parts of a page
// that survive boilerplate stripping without saying anything. A feed item has
// none of that, so the same character count buys considerably more substance.
//
// Measured on the Smithsonian weekly report: a complete account of one
// volcano's activity — which agency observed it, what erupted, how far the lava
// travelled, over which dates — came to 779 characters. Judging that against a
// floor built for pages threw away the best item in the feed.
const THIN_FLOOR_FEED = Number(process.env.MIN_SOURCE_CHARS_FEED ?? 450);

export function minSourceChars(text, { fromFeed = false } = {}) {
  if (SPACELESS_SCRIPT.test(text)) return THIN_FLOOR_SPACELESS;
  return fromFeed ? THIN_FLOOR_FEED : THIN_FLOOR;
}
const thinFloor = minSourceChars;

/**
 * Stage 1 — before spending a drafting call on it.
 * Confirms the source is primary and the page is live, and returns its text.
 */
export async function verifySource(item) {
  const authority = primaryAuthority(item.url);
  if (!authority) {
    throw new RejectedError('not_primary_source', new URL(item.url).hostname);
  }

  // Some publications ARE the feed. The Smithsonian's weekly volcano report
  // puts each volcano's full report in its own feed item and links them all to
  // one landing page — and that landing page returns 403 to anything that is
  // not a browser, while the feed itself serves fine.
  //
  // Insisting on the page there would reject every item from the standing
  // global authority on volcanic activity, on the grounds that a *different*
  // document was unreachable. So a source may declare that its feed carries the
  // content, and then the feed text is what claims are grounded in.
  //
  // What this does NOT relax: the URL must still be on an allowlisted primary
  // domain (checked above), the text must still clear the thin-source floor
  // (below), and every quote is still checked verbatim against it. The live
  // fetch that proves the source is up already happened — it is how we got the
  // item. This drops one check, the reachability of a page we never quote.
  if (item.contentInFeed) {
    const combined = [item.title, item.summary].filter(Boolean).join('\n');
    const chars = combined.replace(/\s/g, '').length;
    const floor = minSourceChars(combined, { fromFeed: true });
    if (chars < floor) throw new RejectedError('source_too_thin', `${chars} chars, need ${floor}`);
    return { sourceText: combined, finalUrl: item.url, authority };
  }

  let page;
  try {
    page = await fetchReadable(item.url);
  } catch (e) {
    const code = e instanceof FetchError ? e.code : 'network';
    throw new RejectedError('source_unreachable', `${code} — ${e.message}`);
  }

  // A redirect off the allowlisted domain means the thing we actually read is
  // not the thing we vouched for. Re-check where we landed.
  const finalAuthority = primaryAuthority(page.finalUrl);
  if (!finalAuthority) {
    throw new RejectedError('redirected_off_allowlist', new URL(page.finalUrl).hostname);
  }

  // Feed items sometimes point at a page that has since been emptied. The
  // adapter's own summary is a legitimate part of the record, so it counts
  // toward the text a claim can be grounded in — it came from the same source.
  const combined = [item.title, item.summary, page.text].filter(Boolean).join('\n');
  const chars = combined.replace(/\s/g, '').length;
  const floor = thinFloor(combined);
  if (chars < floor) {
    throw new RejectedError('source_too_thin', `${chars} chars, need ${floor}`);
  }

  return { sourceText: combined, finalUrl: page.finalUrl, authority: finalAuthority };
}

// --- claim grounding --------------------------------------------------------

// Normalise for comparison only. Quote matching has to survive whitespace and
// punctuation drift between the feed's copy of a sentence and the page's, while
// staying strict enough that "close enough" prose doesn't pass.
function normalise(s) {
  return String(s || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

const MIN_QUOTE_WORDS = 4;

// ...but a word count is meaningless in a script that does not separate words
// with spaces. A perfectly substantial Japanese quote —
// 「最大44名対応の箸作り体験を渋谷で開始」— splits into exactly one "word" and was
// rejected as too short to be evidence. That made every Japanese-language
// source structurally incapable of producing a candidate, and blamed the
// drafting step for it in the rejection reason.
//
// Found by running a real JNTO item through the pipeline. JNTO is one of four
// enabled sources, so this quietly disabled a quarter of the registry.
const SPACELESS_SCRIPT =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿]/u;
// 8, not 10. Measured against real quotes rather than picked: 前年同月比0.1%増
// ("+0.1% year on year") normalises to 8 characters and is genuinely the
// evidence for a claim about visitor numbers, while 2026年7月 is 7 and is a bare
// date that proves nothing. The boundary sits exactly between them. 渋谷で, the
// case this guard exists for, is 3.
const MIN_QUOTE_CHARS_SPACELESS = 8;

/** Is this quote long enough to be evidence of anything? */
function longEnough(normalised) {
  if (SPACELESS_SCRIPT.test(normalised)) {
    return [...normalised].filter((c) => c.trim()).length >= MIN_QUOTE_CHARS_SPACELESS;
  }
  return normalised.split(' ').filter(Boolean).length >= MIN_QUOTE_WORDS;
}

/**
 * Stage 2 — every claim the draft makes must be pinned to a verbatim quote.
 *
 * The drafting step returns `evidence: [{ claim, quote }]`. `quote` must be
 * copied character-for-character out of the source text it was shown. This is
 * checked here, not trusted: a model asked for a quote will occasionally
 * paraphrase one, and a paraphrased quote is exactly the case where the claim
 * came from somewhere other than the source.
 */
export function verifyEvidence(draft, sourceText) {
  const evidence = Array.isArray(draft?.evidence) ? draft.evidence : [];
  if (!evidence.length) throw new RejectedError('no_evidence', 'draft cited nothing');

  const haystack = normalise(sourceText);
  const unsupported = [];

  for (const e of evidence) {
    const quote = String(e?.quote || '').trim();
    const needle = normalise(quote);
    if (!longEnough(needle)) {
      unsupported.push({ quote, why: 'quote too short to be evidence of anything' });
      continue;
    }
    if (!haystack.includes(needle)) {
      unsupported.push({ quote: quote.slice(0, 120), why: 'not found verbatim in the source page' });
    }
  }

  if (unsupported.length) {
    throw new RejectedError(
      'unsupported_claim',
      unsupported.map((u) => `"${u.quote}" (${u.why})`).join(' | ')
    );
  }

  return true;
}

// --- flight-price guard -----------------------------------------------------

// Deliberately not a blanket ban on money: "entry costs €19" is a perfectly good
// practical tip. What's out of scope for v1 is *fares*, so the guard fires only
// when an amount sits near flight vocabulary.
// `ש״ח` is how Israelis actually write shekels — far more common in copy than
// the ₪ sign or the word שקל, and it uses gershayim (U+05F4), not a quote mark.
// Both spellings are matched because both get typed.
const MONEY =
  /(?:[₪$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:₪|\$|€|£|ש["״]ח|שקלים|שקל|דולר|יורו|usd|eur|ils))/giu;
const FLIGHT_WORDS =
  /(?:טיס[הות]|כרטיס(?:י)?\s*טיסה|הלוך[- ]ושוב|צ׳רטר|צ'רטר|flight|airfare|fare|round[- ]trip|one[- ]way|ticket)/giu;

const PROXIMITY_CHARS = 120;

export function flightPriceGuard(text) {
  const s = String(text || '');
  const money = [...s.matchAll(MONEY)];
  if (!money.length) return null;
  const flights = [...s.matchAll(FLIGHT_WORDS)];
  if (!flights.length) return null;

  for (const m of money) {
    for (const f of flights) {
      if (Math.abs(m.index - f.index) <= PROXIMITY_CHARS) {
        return `"${m[0].trim()}" near "${f[0].trim()}"`;
      }
    }
  }
  return null;
}

// A decimal on the front of a card is the tell that the copy was generated from
// a table rather than written. Two real cards read "16.7 מעלות ורק 8.6 ימי גשם"
// and "2.6 ימי גשם בממוצע" — both accurate, both instrument readings, neither a
// sentence a person would say. The prompt asks for rounding; this makes it
// binding, because a style rule that only lives in a prompt holds until the
// model is under pressure from a source that is nothing but decimals.
//
// Times (08:30) and dates use a colon or a slash, so only a dot between digits
// counts. The caption is exempt: there, precision is occasionally the point.
const DECIMAL_IN_COPY = /\d+\.\d/;

export function noDecimalsUpFront(draft) {
  for (const [field, text] of [
    ['headline', draft?.headline],
    ['subhead', draft?.subhead],
  ]) {
    const m = DECIMAL_IN_COPY.exec(String(text || ''));
    if (m) return `${field}: "${m[0]}" — round it`;
  }
  return null;
}

// Hebrew function words. These repeat perfectly naturally — "מ...ל...", "של",
// "את" — and flagging them would reject good headlines. Only content words are
// checked. Hebrew prefixes are attached to the word rather than separate, so
// this is a short list by design.
const FUNCTION_WORDS = new Set([
  'של', 'את', 'עם', 'על', 'אל', 'מן', 'זה', 'זו', 'הוא', 'היא', 'הם', 'הן',
  'יש', 'אין', 'כל', 'גם', 'רק', 'אבל', 'או', 'כי', 'אם', 'לא', 'כך', 'כמו',
  'בין', 'עד', 'לפי', 'אחרי', 'לפני', 'ללא', 'בלי', 'יותר', 'הכי', 'מאוד',
]);

/**
 * A word used twice in a headline of eight words.
 *
 * "יולי היה החודש הכי עמוס ביפן אי פעם ליולי" — accurate, and it sounds
 * assembled rather than written, which is exactly the tell that separates copy
 * from output. Cheap to detect and worth a re-draft.
 *
 * Only the headline: a caption is several sentences and may legitimately repeat
 * its own subject.
 */
export function noRepeatedWord(draft) {
  const words = String(draft?.headline || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Hebrew attaches ו/ב/ל/כ/מ/ה as prefixes, so "ליולי" and "יולי" are the
    // same word wearing a hat. Strip one leading particle before comparing.
    .map((w) => (w.length > 3 ? w.replace(/^[ובלכמה]/u, '') : w))
    .filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w));

  const seen = new Set();
  for (const w of words) {
    if (seen.has(w)) return `"${w}" appears twice`;
    seen.add(w);
  }
  return null;
}

// --- the shape of the copy -------------------------------------------------
//
// The brief asks for a 4-9 word headline and a two-or-three sentence caption,
// and the post that set the standard has six words and two sentences. These
// are the outer bounds, not the targets: wide enough that a good post never
// trips them, tight enough that a headline which is really a sentence with a
// subordinate clause, or a caption which is really the article, is sent back
// for another draft rather than published.

const HEADLINE_WORDS = { min: 3, max: 11 };
const CAPTION_LIMITS = { sentences: 4, chars: 420 };

const wordsOf = (text) =>
  String(text || '')
    .replace(/[^\p{L}\p{N}\s'"-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

export function headlineLength(draft) {
  const n = wordsOf(draft?.headline).length;
  if (n && n < HEADLINE_WORDS.min) return `${n} words - too short to name anything`;
  if (n > HEADLINE_WORDS.max) return `${n} words - a headline, not a sentence`;
  return null;
}

// The caption without its hashtags, which are not prose and do not count.
const captionProse = (caption) =>
  String(caption || '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export function captionLength(draft) {
  const prose = captionProse(draft?.caption);
  if (prose.length > CAPTION_LIMITS.chars) return `${prose.length} chars - this is an article`;
  const sentences = prose.split(/[.!?]+(?:\s|$)/).filter((x) => x.trim()).length;
  if (sentences > CAPTION_LIMITS.sentences) return `${sentences} sentences - say the useful thing and stop`;
  return null;
}

// The adjectives that carry no information. The prompt lists them, and a model
// under pressure from a genuinely spectacular source reaches for them anyway.
// Stems rather than whole words, with an optional Hebrew prefix, so "המדהימה"
// and "ומרהיבים" are caught along with the bare forms.
const FILLER =
  /(?:^|[^\p{L}])[והבלכמש]{0,2}(?:מדהי[םמ]|מרהיב|קסו[םמ]|חלומי|מהמ[םמ]|עוצר(?:ת)? נשימה|בלתי נשכח|פנטסטי|מושל[םמ])/u;

export function fillerAdjective(draft) {
  for (const [field, text] of [
    ['headline', draft?.headline],
    ['subhead', draft?.subhead],
    ['caption', draft?.caption],
  ]) {
    const m = FILLER.exec(String(text || ''));
    if (m) return `${field}: "${m[0].trim()}" - say the specific thing instead`;
  }
  return null;
}

// The three openings the brief forbids: a rhetorical question, "did you
// know", and announcing the post. Checked on the headline and on the first
// sentence of the caption, which is where they land.
const ANNOUNCE = /^(?:ידעתם|האם ידעתם|היום נדבר|אז מה|בואו נדבר|שאלה:|מה חשוב לדעת)/u;

export function rhetoricalOpening(draft) {
  const headline = String(draft?.headline || '').trim();
  if (/\?$/.test(headline)) return 'headline ends with a question mark';
  const first = captionProse(draft?.caption).split(/(?<=[.!?])\s/)[0] || '';
  if (ANNOUNCE.test(first)) return `caption opens with "${first.slice(0, 20)}"`;
  if (/\?$/.test(first.trim())) return 'caption opens with a rhetorical question';
  return null;
}

/** Stage 3 — run over the finished Hebrew copy, right before staging. */
export function verifyDraftText(draft) {
  const blob = [draft?.headline, draft?.subhead, draft?.caption, ...(draft?.bullets || [])]
    .filter(Boolean)
    .join('\n');

  const fare = flightPriceGuard(blob);
  if (fare) throw new RejectedError('flight_price_out_of_scope', fare);

  const decimal = noDecimalsUpFront(draft);
  if (decimal) throw new RejectedError('unrounded_number', decimal);

  const repeat = noRepeatedWord(draft);
  if (repeat) throw new RejectedError('repeated_word', repeat);

  if (!draft?.headline || String(draft.headline).trim().length < 4) {
    throw new RejectedError('empty_headline');
  }
  if (!draft?.caption || String(draft.caption).trim().length < 20) {
    throw new RejectedError('empty_caption');
  }

  const length = headlineLength(draft);
  if (length) throw new RejectedError('headline_length', length);

  const long = captionLength(draft);
  if (long) throw new RejectedError('caption_too_long', long);

  const filler = fillerAdjective(draft);
  if (filler) throw new RejectedError('filler_adjective', filler);

  const opening = rhetoricalOpening(draft);
  if (opening) throw new RejectedError('rhetorical_opening', opening);

  return true;
}

// Hebrew for the skip digest. Unknown codes fall through to the raw string
// rather than being mapped to something reassuring and wrong.
const REASON_HE = {
  not_primary_source: 'המקור לא ברשימת המקורות הראשוניים',
  source_unreachable: 'לא הצלחתי לטעון את דף המקור',
  redirected_off_allowlist: 'הדף הפנה לדומיין שלא ברשימה',
  source_too_thin: 'בדף המקור אין מספיק תוכן',
  no_evidence: 'הטיוטה לא ציטטה שום מקור',
  unsupported_claim: 'ציטוט שלא נמצא בדף המקור',
  flight_price_out_of_scope: 'מחיר טיסה — מחוץ לתחום בגרסה הזו',
  unrounded_number: 'מספר עשרוני בכותרת - צריך לעגל',
  repeated_word: 'מילה חוזרת בכותרת',
  headline_length: 'הכותרת ארוכה או קצרה מדי',
  caption_too_long: 'הטקסט ארוך מדי - זה כבר כתבה',
  filler_adjective: 'תואר ריק (מדהים, מרהיב...) במקום פרט',
  rhetorical_opening: 'פתיחה בשאלה או ב"ידעתם ש"',
  empty_headline: 'כותרת ריקה',
  empty_caption: 'טקסט ריק',
  draft_failed: 'שלב הכתיבה נכשל',
  render_failed: 'רינדור הכרטיס נכשל',
  quota: 'חריגה ממכסת נושא',
  duplicate: 'כבר פורסם',
  not_usable: 'המקור לא עומד בשני התנאים',
  // The hard rule, in the digest. Named so it is obvious in the skip list which
  // items died on the new test rather than on a technical failure — over a week
  // that count is the measurement of whether the direction actually changed.
  no_trip: 'אי אפשר לקשור את זה לטיול שמישהו יכול לעשות',
};
export const reasonHe = (r) => REASON_HE[r] || r || 'סיבה לא ידועה';
