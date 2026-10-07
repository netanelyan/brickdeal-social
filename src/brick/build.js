import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { loadDeals } from './feed.js';
import { lookup as bricksetLookup, compare, configured as bricksetConfigured } from './rrp.js';
import { rateToIls } from './fx.js';
import { brickConfig } from './config.js';
import { slideLines, perPieceLines, assertCopy, CopyError, shekels } from './copy.js';
import { emojiFor } from './emoji.js';
import {
  available,
  priceRoundup,
  themeRoundup,
  pricePerPiece,
  singleSet,
  oneListingPerSet,
  agorotPerPiece,
  countdownRoundup,
  countdownShortlist,
} from './recipes.js';
import { THEME_HE } from './themes.js';
import { shotOrProduct } from '../images/homeShot.js';
import { hasPublished, wasProposed, noteProposed } from '../store.js';

// Feed to deck.
//
// The travel pipeline's equivalent is 1,400 lines because it had to go and find
// out whether a place it had decided to talk about could be sourced at all:
// search a map, rank on Wikidata, fetch an official page, quote-check every
// sentence. None of that applies here. The feed IS the sourcing — every deal in
// it is something the bot already verified and the channel already posted — so
// the build is: pick five, price them, photograph them, name the post.
//
// The one thing that still has to be gone and got is the comparison price, and
// the rule around it is in rrp.js: no retail price means no comparison line,
// and the slide publishes with what we charge and nothing else.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
let client = null;
const getClient = () => (client ??= new Anthropic());

const HOOK_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string', description: 'The cover line, in Hebrew. Seven words or fewer.' },
    emphasis: {
      type: 'string',
      description:
        'The one phrase INSIDE the hook to set in colour - two to four words, copied character for character from the hook. Empty string if the hook has nothing to shout.',
    },
    title: { type: 'string', description: 'What this post is, in Hebrew. Under eight words. Not shown on a slide.' },
  },
  required: ['hook', 'emphasis', 'title'],
  additionalProperties: false,
};

/**
 * The brief for the cover line.
 *
 * Built around the reference's own covers, which are handed over as the
 * standard rather than described — the same technique src/draft.js uses with a
 * real published post, and for the same reason: a model told to be
 * "conversational and slightly confrontational" produces an advertisement's
 * idea of those words, while a model shown five real ones produces a sixth.
 *
 * The trademark ban is stated here AND enforced in code afterwards. Stating it
 * saves a round trip; enforcing it is what makes it true, because this is
 * precisely the instruction a model drops when the examples it was given are
 * about a brand it is not allowed to name.
 */
/**
 * The ceiling on a cover line, in words.
 *
 * ELEVEN, AND IT WAS SEVEN. Seven was a judgement about reading speed — "ten
 * words is a paragraph rather than a hook" — and the reference account's own
 * numbers say otherwise. Its three biggest posts, 29% of everything it has ever
 * been watched, open on lines of eleven, eight and ten words:
 *
 *   בואו תראו כמה כסף אתם יכולים לחסוך אם תזמינו מאלי אקספרס   208.7K
 *   הסניף הכי זול של [brand] בארץ, הכל ברבע מחיר                 153.8K
 *   אם אתם אוהבים לקנות [brand] במחירים של הארץ תמשיכו לגלול      146.5K
 *
 * Seven would have thrown all three back to the pool. What they spend the extra
 * words on is the viewer — "אתם", "תמשיכו לגלול" — which is exactly the part a
 * seven-word line has to cut. The cover lays a long line out over three lines
 * rather than clamping it; see `coverClass`.
 *
 * It lives here as a constant rather than in the prompt alone so the prompt and
 * the check cannot drift — which they had: the prompt asked for "under nine",
 * nothing counted, and what shipped was ten words wide across a full frame.
 */
export const MAX_HOOK_WORDS = 11;

/**
 * Does this line state a number, a ratio or a multiple?
 *
 * The covers that do — "89₪ במקום 400₪", "הכל ברבע מהמחיר" — are built from the
 * deck's own numbers and nothing else, because a cover quoting a figure the
 * slides do not back is the one failure a language model cannot be relied on
 * not to produce. So a model-written hook that states one is thrown back to
 * the pool, however good it reads. "ביוקר", "מחיר מלא" and "הכי זול" carry the
 * same contrast without a claim anybody would have to check.
 *
 * Fraction words are matched as words, with the prefixes Hebrew glues on: ברבע
 * is a claim, ארבע and רבעון are not.
 */
const FRACTION_WORD = /(?:^|[^\p{L}])[ובלמהש]?(?:חצי|שליש|רבע|חמישית|עשירית)(?!\p{L})/u;
const MULTIPLE = /(?:^|[^\p{L}])פי\s+(?:\d|שתיים|שניים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר)/u;
export const statesNumber = (s) => /[\d%₪]/.test(String(s)) || FRACTION_WORD.test(String(s)) || MULTIPLE.test(String(s));

const hookSystem = () => `You write the first slide of a Hebrew TikTok slideshow for a channel that finds cheap compatible building-brick sets on AliExpress and shows Israeli builders what they cost there.

The cover line is the only thing most viewers will read. It has to stop a scroll.

WHAT WORKS, MEASURED. The account this channel is modelled on has 102 posts and a median of about 5,000 views. These are its three biggest covers, and they earned 29% of all its views between them. The brand name in the originals is replaced with "סטים", because this channel never writes it:

  בואו תראו כמה כסף אתם יכולים לחסוך אם תזמינו מאלי אקספרס    208,700 views
  הסניף הכי זול בארץ, הכל ברבע מחיר                              153,800 views
  אם אתם אוהבים לקנות סטים במחירים של הארץ תמשיכו לגלול           146,500 views

(The ratio in the second one is not yours to write: when a deck can back a line like it, code writes it from the deck's own prices. See NO NUMBERS below.)

And a mid-table one, in the same voice:

  ועדיין אתם ממשיכים לשלם ביוקר??                                 14,700 views

And these were its weakest:

  הפסקתי לשלם ביוקר על התחביב שלי        929 views
  במחיר של סט אחד תקנו 8                 1,033 views
  מה הזמנתי VS מה קיבלתי                 1,082 views

THE DIFFERENCE IS THE WHOLE BRIEF:
- The winners talk TO THE VIEWER about THEIR money: אתם, תראו, תמשיכו. The losers talk about me — הפסקתי, הזמנתי, קיבלתי — or do arithmetic at the viewer.
- The winners name the viewer's pain: paying Israeli prices. "במחירים של הארץ", "ביוקר", "עדיין משלמים".
- The winners point at where it is cheaper, or tease it. "מאלי אקספרס" makes the claim concrete; "הסניף הכי זול בארץ" is a joke and a riddle at once, and "which branch?" is one of the commonest comments on that account. A question the viewer has to ask is a comment.
- The winners tell the viewer what to do next: בואו תראו, תמשיכו לגלול.
- None of them asks the viewer to guess a price. This channel asked for guesses under four posts and got no comments at all.

These lines are already in rotation as the fallback. Do not hand one back — this post and the next would go out under the same cover:

${brickConfig().covers.lines.map((l) => `  ${l.text}`).join('\n')}

HARD RULES:
- Hebrew only.
- ${MAX_HOOK_WORDS} WORDS OR FEWER. Count them. The biggest cover above is eleven; most good ones are five to eight. The limit is checked in code and a longer line is thrown away.
- NEVER name the original brand. Not in Hebrew, not in English, not as part of a longer word. Say "סטים", "סטים תואמים", "אבני בנייה", "התחביב" or just "סט". AliExpress MAY be named — "אלי אקספרס" or "אלי" — it is the shop, not the brand, and naming it is what made the biggest cover concrete.
- NO NUMBERS. No price, no digits, no percentage, no ratio ("בחצי מחיר", "בשליש", "ברבע מחיר"), no multiple ("פי שלוש"). Covers that state a number are built from this deck's own prices by code; a sentence that states one without them is a claim nobody checked, and it is thrown away. Carry the contrast with words: "ביוקר", "מחיר מלא", "במחירים של הארץ", "הכי זול".
- DO NOT SAY WHAT THE THING IS. The photograph is already showing it. Naming the category — "סט מכוניות", "סט טכניק", "דגם רכב" — spends the line describing the picture underneath it. Say "סטים", "סט" or "זה" and move on. Never invent a compound noun either: "מכונית אבנים" is not a phrase anybody uses.
- EVERY LINE CARRIES THE CONTRAST: the viewer is paying too much and does not have to. A line without the too-much is the first half of a hook.

  These are NOT hooks, and each fails the same way:
    "למה אתם משלמים על סט מכוניות"  - paying WHAT? Words spent naming the picture, nothing left for the point.
    "הסטים האלה ממש שווים"           - says nothing anybody disagrees with.
    "תראו את הסט הזה"                 - an instruction, not an argument.

  The test: could somebody read your line and answer "so what?" If yes, rewrite it.

- VARY. These posts go out one after another to the same people. Do not copy a winner word for word, and do not open the way the fallback lines open. Vary the verb and the shape: an invitation (בואו תראו...), a condition (אם אתם...), a jab (ועדיין אתם...), a tease (מצאתי את...), a flat contrast (אותו דגם, לא אותו מחיר). Not every cover is a question.
- No URLs, no hashtags, no emoji.
- Plain hyphens, never an em dash.

THE EMPHASIS is the one phrase in the line that gets shouted. Hebrew has no capitals, so it is set in a different colour instead. Two to four words, and it must appear in the hook character for character or it will not highlight. Pick the phrase the whole line turns on — the viewer's pain or where it ends. Never the whole line: if every word is coloured then no word is shouted.`;

/**
 * The cover line, and the deck's own name.
 *
 * `title` never appears on a slide — it is what the approval message, the queue
 * and the Instagram caption call this post. The hook is what gets rendered.
 *
 * Falls back to the configured pool rather than failing the build. A deck that
 * lost its model call still has five perfectly good slides, and the pool
 * exists precisely so that the expensive half is optional.
 */
export async function draftHook(recipe, { rand = Math.random, avoid = [] } = {}) {
  const pool = brickConfig().covers.lines;
  // A fallback that cannot hand back a line we are trying to get away from.
  // Without this, asking for a new cover could return the one on screen.
  const usable = pool.filter((l) => !avoid.includes(l.text));
  const fallback = () => {
    const from = usable.length ? usable : pool;
    const picked = from[Math.floor(rand() * from.length)];
    return { hook: picked.text, emphasis: picked.emphasis, title: recipe.subject, from: 'pool' };
  };

  if (!process.env.ANTHROPIC_API_KEY) return fallback();

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 700,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: HOOK_SCHEMA } },
      system: [{ type: 'text', text: hookSystem(), cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            `THIS POST: ${recipe.subject}`,
            // What NOT to write. The model is close to deterministic on
            // identical input, so a second call about the same five sets
            // returns the same sentence — which is what made the "new cover"
            // button look like it did nothing.
            ...(avoid.length
              ? ['', 'ALREADY USED for this post - write something different, not a reword of these:', ...avoid.map((a) => `  ${a}`)]
              : []),
            '',
            'The sets in it:',
            ...recipe.deals.map(
              (d) =>
                `  ${d.product} - ${Math.round(d.price)}₪` +
                (d.comparison?.ok ? `, list ${d.comparison.listIls}₪, saving ${d.comparison.saving}₪` : ', no list price')
            ),
          ].join('\n'),
        },
      ],
    });

    recordUsage(res.usage, MODEL);
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) return fallback();

    const parsed = JSON.parse(text);
    // The guard, after the model has spoken. A hook that names the brand is
    // thrown away rather than repaired: repairing it would leave the prompt
    // broken and every future cover quietly patched.
    const hook = assertCopy(String(parsed.hook || '').trim(), 'the cover line');
    // Stated in the prompt AND enforced here, same as the trademark, and for
    // the same reason: the length rule is the one a model drops first when it
    // has something clever to fit in. Thrown back to the pool rather than
    // trimmed — a hook cut off at six words is not a shorter hook, it is a
    // broken sentence, and the pool lines are the standard anyway.
    const words = hook.split(/\s+/).filter(Boolean).length;
    if (words > MAX_HOOK_WORDS) {
      return { ...fallback(), from: `pool (model wrote ${words} words)` };
    }
    // A number nothing checked. See `statesNumber`.
    if (statesNumber(hook)) {
      return { ...fallback(), from: 'pool (model stated a number)' };
    }
    // The emphasis has to be a substring of the hook or the renderer cannot
    // find it — and a hook whose shout cannot be found is the failure this
    // whole block is guarding against, not a cosmetic slip.
    //
    // This used to render the cover in one colour and carry on, on the
    // reasoning that "a cover with nothing to shout" sets that way anyway. That
    // reasoning had it backwards. A line with no phrase worth colouring is a
    // line with no argument in it — "למה אתם משלמים על סט מכוניות" is six words
    // that ask nothing — and the pool exists precisely so the cover never has
    // to be the weakest thing in the post. Falling back costs one model call
    // and nothing else: the five slides are already built and untouched.
    const said = assertCopy(String(parsed.emphasis || '').trim(), 'the cover emphasis');
    if (!said || !hook.includes(said)) {
      return { ...fallback(), from: said ? 'pool (emphasis not in the hook)' : 'pool (no emphasis)' };
    }
    return {
      hook,
      emphasis: said,
      title: assertCopy(String(parsed.title || recipe.subject).trim(), 'the deck title'),
      from: 'model',
    };
  } catch (e) {
    if (e instanceof CopyError) return { ...fallback(), from: `pool (model said: ${e.reason})` };
    return fallback();
  }
}

/**
 * How much cheaper the number has to be before it is allowed to be the cover.
 *
 * A cover that says "89₪ במקום 110₪" is a true sentence and a bad hook: the gap
 * is the entire argument, and one small enough to shrug at spends the loudest
 * slide in the post making the case look weak. Below this the deck falls back
 * to asking the viewer to guess, where the contrast is whatever they imagined
 * rather than a number we had to defend.
 *
 * Two and a half, because the account's own claim is "a third of the price".
 */
export const PRICE_HOOK_RATIO = 2.5;

/**
 * The cover line for a post that leads with the deal.
 *
 * Built from the numbers rather than written by a model, and that is the whole
 * design. Everywhere else a hook is a sentence about the post and a model is
 * the right tool for it; here the hook is two prices, and the one failure that
 * matters — a cover stating a number the slides do not — is exactly the failure
 * a language model cannot be relied on not to produce. So the shapes are
 * hand-written in the config with `{ours}` and `{list}` in them, and the only
 * thing chosen at run time is which shape and which numbers.
 *
 * IT TAKES THE SLIDE, NOT THE RECIPE, and that is not incidental. The cover
 * carries `deck.slides[0].image` — the first slide's photograph — so the set on
 * screen when the line is read is that slide's set. Built from the recipe it
 * would quote the first DEAL, which is the same set right up until a
 * photograph fails and that deal is dropped, and then the cover is a price
 * label on a picture of something else.
 *
 * Returns null rather than something weaker, for every reason it can: no
 * comparison, a gap too small to be worth shouting, or no shapes configured.
 * The caller then drafts an ordinary hook, which is not a fallback so much as
 * the other half of the rotation.
 */
export function priceHook(slide, { rand = Math.random } = {}) {
  const shapes = brickConfig().covers.priceLines;
  if (!shapes.length) return null;

  const cmp = slide?.deal?.comparison;
  if (!cmp?.ok) return null;

  const ours = Number(cmp.paid ?? slide.deal.price);
  const list = Number(cmp.listIls);
  if (!Number.isFinite(ours) || !Number.isFinite(list) || ours <= 0) return null;
  if (list < ours * PRICE_HOOK_RATIO) return null;

  const shape = shapes[Math.floor(rand() * shapes.length)];
  // Both halves, or the emphasis stops matching the line it came from and the
  // renderer finds nothing to colour — the same failure draftHook throws a
  // model hook away for.
  const fill = (s) => String(s || '').replaceAll('{ours}', shekels(ours)).replaceAll('{list}', shekels(list));

  const hook = assertCopy(fill(shape.text), 'the price cover line');
  const emphasis = shape.emphasis ? assertCopy(fill(shape.emphasis), 'the price cover emphasis') : null;
  return {
    hook,
    emphasis: emphasis && hook.includes(emphasis) ? emphasis : null,
    title: null,
    from: 'price',
  };
}

/**
 * The fractions a whole deck may claim, strongest first.
 *
 * Stops at a third. "בחצי מחיר" is true of a great many ordinary sales, and a
 * cover spent on it is a cover that sounds like every other shop.
 */
export const DECK_FRACTIONS = [
  [5, 'חמישית'],
  [4, 'רבע'],
  [3, 'שליש'],
];

/**
 * The fraction of its list price that EVERY set in this deck is at or under,
 * as a word, or null.
 *
 * Every slide, not most of them. "הכל ברבע מהמחיר" is a claim about the whole
 * post, and a viewer who swipes to a set at forty percent has caught the cover
 * lying. So a slide with no comparison at all disqualifies the deck — there is
 * nothing to say what fraction it is — and the worst ratio on the deck is the
 * one that picks the word.
 */
export function deckFraction(slides) {
  const priced = (slides || []).filter((s) => !s?.lines?.every((l) => l.value === ''));
  if (priced.length < brickConfig().deck.minSlides) return null;
  let worst = 0;
  for (const s of priced) {
    const cmp = s?.deal?.comparison;
    if (!cmp?.ok) return null;
    const paid = Number(cmp.paid ?? s.deal.price);
    const list = Number(cmp.listIls);
    if (!(paid > 0) || !(list > 0)) return null;
    worst = Math.max(worst, paid / list);
  }
  const hit = DECK_FRACTIONS.find(([n]) => worst <= 1 / n);
  return hit ? hit[1] : null;
}

/**
 * The cover that says what fraction of the price the whole deck is at.
 *
 * The reference's second-biggest post — 153.8K views — opened on "הסניף הכי
 * זול של [brand] בארץ, הכל ברבע מחיר". Half of that line is a joke and half of
 * it is a number, and the number is the half this pipeline can only write by
 * hand: so the shapes are in the config with `{fraction}` in them, and the
 * word is `deckFraction`'s, measured off the slides that will carry it.
 *
 * Returns null when the deck cannot back any fraction worth saying, and the
 * caller tries the single-set price cover next.
 */
export function ratioHook(slides, { rand = Math.random } = {}) {
  const shapes = brickConfig().covers.ratioLines;
  if (!shapes.length) return null;
  const fraction = deckFraction(slides);
  if (!fraction) return null;

  const shape = shapes[Math.floor(rand() * shapes.length)];
  const fill = (s) => String(s || '').replaceAll('{fraction}', fraction);
  const hook = assertCopy(fill(shape.text), 'the ratio cover line');
  const emphasis = shape.emphasis ? assertCopy(fill(shape.emphasis), 'the ratio cover emphasis') : null;
  return { hook, emphasis: emphasis && hook.includes(emphasis) ? emphasis : null, title: null, from: 'ratio' };
}

/**
 * The slide a countdown's cover is about: #1.
 *
 * Found by its rank rather than by its position, so that nothing here depends
 * on the deck having been built in display order, which it always is today.
 */
export const topOfCountdown = (slides) => (slides || []).find((s) => s?.rank === 1) || null;

/**
 * The cover of a countdown deck, teasing #1's saving.
 *
 * Built from the slides like ratioHook and priceHook, and for the same reason:
 * the cover states a number, and a number on the cover is only allowed to be
 * one a slide underneath repeats. Here it is #1's saving, which that slide
 * prints in cream, and the count, which is the number of slides that were
 * actually built rather than the number the proposal asked for.
 *
 * `avoid` is the lines already used on this deck, so a redrawn cover is a
 * different one. Returns null when there is no #1 with a saving, no shape is
 * configured, or every shape has been used. The caller then writes an ordinary
 * hook, and the swipe line still says it is a countdown.
 */
export function countdownHook(slides, { rand = Math.random, avoid = [] } = {}) {
  const top = topOfCountdown(slides);
  const cmp = top?.deal?.comparison;
  if (!cmp?.ok || !(Number(cmp.saving) > 0)) return null;

  const fill = (s) =>
    String(s || '')
      .replaceAll('{count}', String(slides.length))
      .replaceAll('{top}', shekels(cmp.saving));
  const shapes = brickConfig().covers.countdownLines.filter((l) => !avoid.includes(fill(l.text)));
  if (!shapes.length) return null;

  const shape = shapes[Math.floor(rand() * shapes.length)];
  const hook = assertCopy(fill(shape.text), 'the countdown cover line');
  const emphasis = shape.emphasis ? assertCopy(fill(shape.emphasis), 'the countdown cover emphasis') : null;
  return { hook, emphasis: emphasis && hook.includes(emphasis) ? emphasis : null, title: null, from: 'countdown' };
}

/**
 * Whether a request asks for a countdown, and of which theme, or null.
 *
 * The words are the ones that get typed: דירוג, מדורגים, ספירה לאחור, טופ, and
 * the English. What is left once they are taken out is read as a theme, so
 * `/deck דירוג רכבים` is a countdown of car sets. Anything else left over is
 * ignored rather than guessed at: "טופ 5" is not a request for sets under 5₪,
 * and a stray number must not be matched against set names either.
 *
 * טופ is matched as a whole word. Inside another word it is a coincidence —
 * לפטופ is a laptop.
 *
 * THE PREFIX GOES WITH THE WORD. Hebrew glues ה, ב, ל and the rest straight
 * on, so "הדירוג" has to be taken out whole: left behind, the lone ה is a
 * one-letter "theme" that themeKeyFor's partial match finds inside הארי פוטר.
 * For the same reason nothing shorter than two letters is read as a theme.
 */
const COUNTDOWN_ASK = /[ובלהמש]?(?:דירוג|מדורג(?:ים|ות|ת)?)|ספירה לאחור|(?:^|\s)טופ(?=\s|\d|$)|countdown|\branking\b|\btop\b/giu;

export function countdownRequest(request) {
  const want = String(request || '').trim();
  if (!want || !want.match(COUNTDOWN_ASK)) return null;
  const rest = want
    .replace(COUNTDOWN_ASK, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { theme: rest.length >= 2 ? themeKeyFor(rest) : null };
}

/**
 * A countdown, if the feed can fill one, with the prices it was chosen by.
 *
 * The only recipe that pays before it knows whether it can be built: a saving
 * needs a lookup, so a shortlist is priced first and the countdown chosen from
 * what came back. Everything the lookup costs is cached for thirty days, so
 * this is cheap after the first few decks, and the quota a cold cache spends is
 * bounded by the shortlist rather than by the size of the feed.
 *
 * Returns `{ recipe, rates }` or `{ recipe: null, why }`. The rates are only
 * the currencies the chosen sets were converted from, because the approval card
 * prints every rate on the deck, and a rate that no slide used is a line asking
 * to be checked against nothing.
 */
export async function planCountdown(pool, { theme = null } = {}) {
  const candidates = theme ? pool.filter((d) => d.theme === theme) : pool;
  const priced = await priceDeals(countdownShortlist(candidates));
  const recipe = countdownRoundup(priced.deals, { theme });
  if (!recipe) {
    const found = priced.deals.filter((d) => d.comparison?.ok).length;
    return { recipe: null, why: `${found} סטים עם חיסכון, צריך ${brickConfig().deck.countdownMin}` };
  }
  const used = new Set(recipe.deals.map((d) => d.comparison?.source?.currency).filter(Boolean));
  return { recipe, rates: Object.fromEntries(Object.entries(priced.rates).filter(([c]) => used.has(c))) };
}

/**
 * The comparison for every deal in one go, at one rate.
 *
 * One rate per deck, fetched once, and that is the reason this is a batch
 * rather than a per-deal call. Seven slides each fetching their own would be
 * seven chances to straddle a publication boundary and produce a deck whose
 * numbers cannot be reproduced from a single stated rate — and the rate is
 * printed on the approval message precisely so they can be.
 *
 * Every failure here is survivable and none of them stops a deck. A deal with
 * no comparison is a deal with one price line, which is a normal slide.
 */
export async function priceDeals(deals) {
  if (!bricksetConfigured()) {
    return { deals: deals.map((d) => ({ ...d, comparison: { ok: false, why: 'BRICKSET_API_KEY is not set' } })), rates: {} };
  }

  const looked = await Promise.all(
    deals.map(async (d) => {
      try {
        return { deal: d, set: await bricksetLookup(d.setId) };
      } catch (e) {
        return { deal: d, set: { found: false, why: e.message } };
      }
    })
  );

  // Only the currencies actually needed, and each one only once.
  const currencies = [...new Set(looked.map((l) => l.set?.price?.currency).filter(Boolean))];
  const rates = {};
  for (const c of currencies) {
    try {
      rates[c] = await rateToIls(c);
    } catch {
      /* no rate for this currency means no comparison for its deals */
    }
  }

  return {
    rates,
    deals: looked.map(({ deal, set }) => ({
      ...deal,
      sizeCm: set?.sizeCm ?? null,
      comparison: set?.found
        ? compare({ price: deal.price, rrp: set.price, rate: rates[set.price?.currency] })
        : { ok: false, why: set?.why || 'not on Brickset' },
    })),
  };
}

/**
 * Turn a priced recipe into renderable slides.
 *
 * The photograph is the slow and expensive part and it is the last thing that
 * happens, for the same reason the card pipeline renders last: a deck that
 * cannot be assembled should not have paid for five generated images.
 */
export async function buildSlides(recipe, { wantImages = true, onProgress = null } = {}) {
  const slides = [];
  const dropped = [];

  // A single-set post has its own slide list - one deal, several shots - so it
  // is the recipe that says what the slides are, not the deal list.
  //
  // A per-piece deck does NOT get its own list, and that is the point of
  // reading the kind here instead. Its slides are one per deal like every other
  // roundup's; only the three lines under the name differ. Emitting specs for
  // it would put a second copy of every deal into the stored proposal and
  // inherit singleSet's problem - a slide list built before the deals were
  // priced, and rebuilt afterwards or quietly stale.
  const specs =
    recipe.slides ||
    recipe.deals.map((deal) => ({ deal, showPrices: true, perPiece: recipe.kind === 'perPiece' }));
  const countdown = recipe.kind === 'countdown';

  for (const [i, spec] of specs.entries()) {
    const { deal } = spec;
    onProgress?.(`${i + 1}/${specs.length} ${deal.product}`);

    // A countdown is ranked by saving, so a set with no saving has no place in
    // it. The recipe cannot pick one, but this is also reachable from a
    // hand-built recipe, and checking before the photograph means a set that
    // would be dropped anyway is never paid for.
    if (countdown && !(deal.comparison?.ok && deal.comparison.saving > 0)) {
      dropped.push({ id: deal.productId, why: 'a countdown ranks by saving, and this set has none' });
      continue;
    }

    let image = null;
    if (wantImages) {
      try {
        image = await shotOrProduct(deal, { n: i + 1, sizeCm: deal.sizeCm });
      } catch (e) {
        dropped.push({ id: deal.productId, why: `no photograph: ${e.message}` });
        continue;
      }
    }

    // A fact slide carries a sentence, not a label and a number, so it has no
    // value half. copy.js renders a line with an empty value as plain text -
    // otherwise every fact slide would show a trailing colon.
    //
    // The per-piece figure is re-derived from the deal rather than carried on
    // the spec so that a deal which lost its piece count between the proposal
    // and the build falls back to an ordinary price slide instead of printing
    // a figure divided by nothing. The recipe cannot select such a deal, but
    // this function is also reachable from a hand-built recipe.
    const agorot = spec.perPiece ? agorotPerPiece(deal) : null;
    const lines = spec.fact
      ? [{ label: spec.fact.text, value: '' }]
      : agorot
        ? perPieceLines(deal, agorot)
        : slideLines(deal.comparison, { price: deal.price });

    try {
      assertCopy(deal.product, `the name of ${deal.productId}`);
    } catch (e) {
      // A deal whose own name carries the trademark cannot go on a slide. It is
      // not an error in this build - it is a deal the bot named before the rule
      // existed - so it is dropped and reported rather than thrown.
      dropped.push({ id: deal.productId, why: e.message });
      continue;
    }

    slides.push({
      productId: deal.productId,
      nameHe: deal.product,
      emoji: spec.fact ? spec.fact.emoji : emojiFor(deal),
      lines,
      image,
      // Which cached photograph this slide carries. The shot cache is keyed on
      // the position a deal was built at, and a deal dropped earlier in the
      // loop shifts every later slide's index without shifting its shot, so a
      // slide's own index is not enough to find its photograph again. Re-drawing
      // a cover needs exactly that.
      shot: i + 1,
      // Carried so the approval message can show what a slide is claiming and
      // where the number came from, without re-deriving any of it.
      deal: {
        price: deal.price,
        setId: deal.setId,
        pieces: deal.pieces,
        link: deal.link,
        theme: deal.theme,
        comparison: deal.comparison,
        // The photograph this slide was built FROM, kept so it can be built
        // again. Two URLs, not an image: the megabytes of base64 are stripped
        // from a staged candidate on purpose, but the addresses they were made
        // from cost a few hundred bytes and are the only way to ask for a
        // different photograph of the same set later. Without them /photo can
        // only fail with "the deal has no photograph to build from".
        image: deal.image || null,
        sourceImage: deal.sourceImage || null,
      },
    });
  }

  // The ranks, counted off the slides that survived rather than the deals that
  // were proposed. A set that lost its photograph takes its slide with it, and
  // ranks assigned before that would leave a countdown with a gap in it: #8,
  // #7, #5. Counted here, the list is always whole and #1 is always the last
  // set, which is the biggest saving left on the deck.
  if (countdown) slides.forEach((s, i) => (s.rank = slides.length - i));

  return { slides, dropped };
}

/**
 * What this post WOULD be, without paying for it.
 *
 * The cheap half, and the reason the approval flow has two taps. Everything
 * here is free or nearly so — the feed is a file, Brickset is cached and the
 * rate is one call a day — while the half below costs a model call and one
 * generated photograph per slide. So the proposal is a complete, honest
 * account of the post, including every price claim it will make, and rejecting
 * it costs one message instead of a build.
 *
 * That split matters more here than it did for travel. There the expensive
 * part was searching and drafting; here it is image generation, which is the
 * slowest and least predictable step in the pipeline and the one most worth
 * not spending on a deck nobody wanted.
 *
 * `request` is whatever was typed after /deck: a theme key, a theme's Hebrew
 * name, a price, or nothing. Nothing is the common case and means "whatever
 * this feed can best make right now".
 */
export async function proposeDeck(request = null, { onProgress = null, rand = Math.random } = {}) {
  const { deals, dropped: feedDropped, total } = await loadDeals();

  // Never the same set twice in a fortnight.
  //
  // The feed is small and its best deals are its best deals every day, so
  // without this every roundup would be the same five sets under a different
  // cover. `hasPublished` is keyed on ids that survive the 30-day quota window
  // being pruned, which is why it is the right question to ask.
  // Asked per SET as well as per listing. The listing key alone could not do
  // the job it claimed: the same set reaches the feed from a dozen sellers under
  // a dozen productIds, so a set posted on Monday was free to come back on
  // Tuesday through a different seller.
  const fresh = deals.filter(
    (d) => !hasPublished(`brick:${d.productId}`) && !(d.setId && hasPublished(`brickset:${d.setId}`))
  );
  // And skip what was OFFERED in the last few hours, not just what was
  // published. Selection is deterministic — the best theme on the feed and its
  // five best deals — so with nothing published yet, every /deck returned the
  // same five sets out of two hundred, and the cover written about them came
  // back identical too. A stable ranking is correct; showing only its top five
  // forever is not.
  const unseen = fresh.filter((d) => !wasProposed(`brick:${d.productId}`));
  const enough =
    unseen.length >= brickConfig().deck.minSlides
      ? unseen
      : fresh.length >= brickConfig().deck.minSlides
        ? fresh
        : deals;

  // And never the same set twice in ONE deck, which is a different rule from
  // the one above and the one that was actually being broken on screen. Applied
  // to the pool rather than inside each recipe so that every path — a theme, a
  // price ceiling, a named set, the fallback — inherits it without having to
  // remember to.
  const pool = oneListingPerSet(enough);

  // A COUNTDOWN IS TRIED FIRST, when one was asked for and on a share of the
  // decks the schedule offers. First because it is the only recipe that has to
  // price before it can choose (see planCountdown), and so the only one that
  // cannot simply be another entry in `available`.
  //
  // The coin is drawn only when nothing was asked for. A request is honoured
  // as it reads: `/deck 100` is a price deck every time, and a deck the owner
  // named should not turn into a countdown one time in three.
  const asked = countdownRequest(request);
  const tryCountdown = asked !== null || (!request && rand() < brickConfig().deck.countdownShare);
  let planned = null;
  let fallback = null;
  if (tryCountdown) {
    onProgress?.('pricing a countdown shortlist');
    planned = await planCountdown(pool, { theme: asked?.theme || null });
    // Said on the card only when somebody asked. A scheduled coin that could
    // not be filled is not news; a request that was not honoured is, because
    // otherwise `/deck דירוג` silently comes back as a theme deck.
    if (!planned.recipe && asked) fallback = `לא נבנה דירוג: ${planned.why}`;
  }

  // A countdown request that could not be filled falls through to its theme if
  // it named one, and to whatever the feed can best make if it did not. Never
  // to the raw request: "טופ 5" read as a set name finds whichever set has a 5
  // in its title.
  const recipe = planned?.recipe || chooseRecipe(pool, asked ? asked.theme : request);
  if (!recipe) {
    const err = new Error(
      `nothing to build from: ${deals.length} usable deals out of ${total} on the feed` +
        (feedDropped.length ? ` (${feedDropped.length} dropped)` : '')
    );
    err.feedDropped = feedDropped;
    throw err;
  }

  // A countdown was chosen BY its prices, so it already has them, at the rate
  // the shortlist was converted at. Pricing it again would be a second set of
  // lookups for numbers already on the deals.
  let priced;
  if (planned?.recipe) {
    priced = { deals: recipe.deals, rates: planned.rates };
  } else {
    onProgress?.('pricing');
    priced = await priceDeals(recipe.deals);
  }
  const withPrices = { ...recipe, deals: priced.deals };
  // A single-set recipe carries its own slide list built from the UNPRICED
  // deal, so it has to be rebuilt once the comparison exists — otherwise the
  // saving fact it wanted to show was decided before we knew there was one.
  const ready = withPrices.kind === 'set' ? singleSet(priced.deals[0]) || withPrices : withPrices;

  // Recorded at the moment it is OFFERED, not when it is approved. A proposal
  // you declined still used up its turn — showing it again on the next /deck is
  // exactly the behaviour this exists to stop.
  noteProposed(ready.deals.map((d) => `brick:${d.productId}`));

  return {
    request: request || null,
    recipe: ready.kind,
    subject: ready.subject,
    theme: ready.theme || null,
    ceiling: ready.ceiling || null,
    agorotCeiling: ready.agorotCeiling || null,
    deals: ready.deals,
    slideSpecs: ready.slides || null,
    rates: priced.rates,
    feedDropped,
    // Why this is not the deck that was asked for, or null. Only a countdown
    // can be asked for and not built while the request itself parsed, so it is
    // the only thing that writes here.
    fallback,
    proposedAt: new Date().toISOString(),
  };
}

/**
 * The expensive half: the cover line and the photographs.
 *
 * Takes a proposal that was approved. Re-deriving it from the request instead
 * would quietly build a different deck — the feed moves, and a proposal that
 * named five sets has to produce those five.
 */
export async function buildProposed(proposal, { wantImages = true, onProgress = null, rand = Math.random } = {}) {
  const ready = {
    kind: proposal.recipe,
    subject: proposal.subject,
    theme: proposal.theme,
    ceiling: proposal.ceiling,
    agorotCeiling: proposal.agorotCeiling,
    deals: proposal.deals,
    slides: proposal.slideSpecs,
  };

  // THE PHOTOGRAPHS COME FIRST NOW, and the cover after them. It used to be the
  // other way round and the order was arbitrary then — the hook did not depend
  // on anything the slides produced. It does now: a price-led cover quotes the
  // first SLIDE, which is only the first deal until a photograph fails and that
  // deal is dropped. See `priceHook`.
  onProgress?.('photographs');
  const { slides, dropped } = await buildSlides(ready, { wantImages, onProgress });

  onProgress?.('cover');
  // Some posts lead with the deal, the rest ask the viewer to guess it.
  //
  // Both shapes work and they work on different people. A number on the cover
  // is the account's whole argument in the first second, which is the right
  // thing to show somebody who has never seen this feed; asking for a guess
  // makes them swipe to find out, which is worth more from somebody who has.
  // Neither is good enough to be every post — a feed of price tags reads as a
  // shop and a feed of riddles never quite says what it is selling — so it is
  // a coin weighted by `covers.priceLedShare`.
  //
  // The draw happens even when the price hook then declines, so that the share
  // means what it says: a run of decks whose first slide has no comparison
  // does not make the NEXT one more likely to lead with a price.
  //
  // A PER-PIECE DECK IS NOT IN THE DRAW AT ALL, which is a different thing from
  // drawing and declining. Its slides do not print the list price — see
  // perPieceLines — so a cover reading "420₪ במקום 2,400₪" would be a number
  // nothing behind it repeats, and that is precisely the failure priceHook was
  // written to make impossible. Excluded before the coin rather than inside it,
  // because the share is a statement about the decks that CAN lead with a
  // price, and counting a draw that could never land would quietly shrink it.
  //
  // THE WHOLE-DECK FRACTION IS TRIED FIRST. "הכל ברבע מהמחיר" is the
  // reference's own second-biggest shape and a claim about every slide in the
  // post, where "89₪ במקום 400₪" is a claim about one. A single-set post is not
  // offered it: "everything" about one set is a strange way to say one price.
  //
  // A COUNTDOWN IS NOT IN THE DRAW EITHER, and for a different reason from the
  // per-piece deck: it has a numbered cover of its own. Its cover teases #1's
  // saving over #1's photograph (see countdownHook and coverSlide), and a
  // price-led cover would quote the FIRST slide, which on a countdown is the
  // smallest saving in the post, over a picture of a different set.
  const countdown = ready.kind === 'countdown';
  const wantPrice = !countdown && ready.kind !== 'perPiece' && rand() < brickConfig().covers.priceLedShare;
  const led = countdown
    ? countdownHook(slides, { rand })
    : wantPrice
      ? (ready.kind !== 'set' && ratioHook(slides, { rand })) || priceHook(slides[0], { rand })
      : null;
  // Only the hook is taken from it. The title is what the queue and the
  // Instagram caption call this post, it is not on a slide, and "89₪ במקום
  // 400₪" is a useless name for a post about six sets.
  const { hook, emphasis, title, from } = led
    ? { ...led, title: ready.subject }
    : await draftHook(ready, { rand });

  return {
    kind: 'brick',
    recipe: ready.kind,
    subject: ready.subject,
    theme: ready.theme || null,
    ceiling: ready.ceiling || null,
    agorotCeiling: ready.agorotCeiling || null,
    titleHe: title,
    hookHe: hook,
    emphasisHe: emphasis || null,
    hookFrom: from,
    slides,
    dropped: [...dropped],
    feedDropped: proposal.feedDropped || [],
    // The rate every number on this deck was converted at, and the day it was
    // published. Without it a slide's comparison cannot be checked afterwards.
    rates: proposal.rates,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Both halves, for the paths that do not stop to ask — `brick-once`, and a
 * deck the owner asked for by name and does not want to confirm twice.
 */
export async function buildDeck(request = null, opts = {}) {
  const proposal = await proposeDeck(request, opts);
  return buildProposed(proposal, opts);
}

/**
 * Which recipe answers this request.
 *
 * A request that parses is honoured; a request that does not is interpreted
 * rather than refused, and a thin result falls through to something buildable
 * rather than answering with a failure. That last part is the travel side's
 * rule and it is the right one: a deck you asked for and did not get costs a
 * message, and a deck of the wrong kind costs nothing at all.
 */
export function chooseRecipe(deals, request) {
  const want = String(request || '').trim();

  if (want) {
    // A THEME, and only when the word actually resolves to one.
    //
    // `themeRoundup(deals, { theme: null })` does not mean "no theme", it means
    // "pick whichever theme can fill the best deck" — which is exactly right as
    // the fallback below and exactly wrong here. Passing an unresolved request
    // straight through swallowed every other interpretation: `/deck בונסאי`
    // came back as a Harry Potter roundup, because the bonsai set never got as
    // far as being looked for.
    const theme = themeKeyFor(want);
    if (theme) {
      const byTheme = themeRoundup(deals, { theme });
      if (byTheme) return byTheme;
    }

    // WHAT A PIECE COSTS. Before the price branch, and that order is the whole
    // reason this is written as a word test rather than folded into the number
    // test below: "10 אגורות" also matches "a number with a bit of text round
    // it", so left to the price branch it would come back as a roundup of sets
    // under ten shekels — a deck that answers a question nobody asked, built
    // from a request that parsed perfectly.
    //
    // The number inside it is the ceiling in agorot when one is given, and the
    // configured walk when it is not, so both "/deck אגורות" and "/deck 8
    // אגורות" mean what they look like they mean.
    if (/אגור|לחלק|ppp|per[\s-]?piece/i.test(want)) {
      const n = want.match(/\d{1,3}/);
      const value = pricePerPiece(deals, n ? { agorotCeilings: [Number(n[0])] } : {});
      if (value) return value;
    }

    // A PRICE. Only when the number is the whole request or nearly so — a set
    // whose name contains "911" is not a request for sets under 911₪.
    const asPrice = want.match(/^\D{0,12}(\d{2,4})\D{0,12}$/);
    if (asPrice) {
      const under = priceRoundup(deals, { ceilings: [Number(asPrice[1])] });
      if (under) return under;
    }

    // A NAMED SET. Matched on either half of the feed's own name, folded, so
    // "בונסאי" finds "פרחים | עץ בונסאי" without the caller having to know
    // which side of the pipe it is on.
    const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const needle = fold(want);
    const named =
      deals.find((d) => fold(d.product).includes(needle)) || deals.find((d) => fold(d.name).includes(needle));
    if (named) {
      const one = singleSet(named);
      if (one) return one;
    }
  }

  return available(deals)[0] || null;
}

/**
 * A theme key from whatever was typed.
 *
 * Three shapes, because all three get typed: the key itself (`harry-potter`),
 * the Hebrew label the channel uses (`הארי פוטר`), or a loose English word
 * (`potter`). Returns null when nothing matches, which is not a failure — the
 * caller then tries the request as a price and as a set name before falling
 * through to whatever the feed can best make.
 */
export function themeKeyFor(want) {
  const s = String(want || '').trim().toLowerCase();
  if (!s) return null;

  const keys = Object.keys(THEME_HE);
  const slug = s.replace(/\s+/g, '-');
  if (keys.includes(slug)) return slug;

  const he = keys.find((k) => THEME_HE[k] === s.trim());
  if (he) return he;

  // A partial, either way round, so "potter" finds harry-potter and "מלחמת
  // הכוכבים הקלאסי" finds star-wars. Longest key first, so "star-wars" is not
  // beaten by a shorter key that happens to be a substring of the same request.
  return (
    [...keys]
      .sort((a, b) => b.length - a.length)
      .find((k) => k.includes(slug) || slug.includes(k) || String(THEME_HE[k]).includes(s.trim())) || null
  );
}
