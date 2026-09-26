import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { loadDeals } from './feed.js';
import { lookup as bricksetLookup, compare, configured as bricksetConfigured } from './rrp.js';
import { rateToIls } from './fx.js';
import { brickConfig } from './config.js';
import { slideLines, assertCopy, CopyError } from './copy.js';
import { emojiFor } from './emoji.js';
import { available, priceRoundup, themeRoundup, singleSet, oneListingPerSet } from './recipes.js';
import { THEME_HE } from './themes.js';
import { shotOrProduct } from '../images/homeShot.js';
import { hasPublished } from '../store.js';

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
 * Seven. Six was tried first and was half a word too tight: the model reaches
 * for the varied shapes the prompt asks for — an admission, a contrast, a
 * before-and-after — and those land at seven, so five covers in six were being
 * thrown back to the pool and the same eight lines went out forever.
 *
 * It lives here as a constant rather than in the prompt alone so the prompt and
 * the check cannot drift — which they had: the prompt asked for "under nine", nothing counted,
 * and what shipped was ten words wide across a full frame.
 */
export const MAX_HOOK_WORDS = 7;

const hookSystem = () => `You write the first slide of a Hebrew TikTok slideshow for a channel that finds cheap compatible building-brick sets on AliExpress.

The cover line is the only thing most viewers will read. It has to stop a scroll.

VOICE: first person, conversational, slightly confrontational, hobbyist talking to hobbyist. A question or a challenge. Never a sale, never a percentage, never an exclamation of how amazing something is.

These are real covers from the account this channel is modelled on. Match their voice and their shapes — but DO NOT REPRODUCE ONE. They are the standard, not a menu, and they are already in rotation as the fallback: handing one back means this post and the next go out under the same cover. Write a new line that would belong in this list.

${brickConfig().covers.lines.map((l) => `  ${l}`).join('\n')}

HARD RULES:
- Hebrew only.
- SEVEN WORDS OR FEWER. Count them. Every example above is four to seven, and the limit is checked in code: a longer line is thrown away and one of the examples is used instead. A cover is read at a glance on a moving screen, and ten words is a paragraph rather than a hook.
- NEVER name the original brand. Not in Hebrew, not in English, not as part of a longer word. Say "סטים תואמים", "אבני בנייה", "התחביב" or just "סט".
- DO NOT SAY WHAT THE THING IS. The photograph is already showing it. Naming the category — "סט מכוניות", "סט טכניק", "דגם רכב" — spends half a seven-word line describing the picture underneath it, and leaves no room for the only thing the line is for. Say "סט" or "זה" and move on. Never invent a compound noun for it either: "מכונית אבנים" is not a phrase anybody uses.
- THE STRONGEST SHAPE ASKS THE VIEWER TO NAME A PRICE. "כמה הייתם משלמים על סט כזה?", "נחשו כמה שילמתי על הסט הזה", "תנחשו את המחיר. לא תאמינו." Prefer it when nothing else is obviously better, and here is why it beats a statement: this is a SLIDESHOW. Somebody who has silently guessed a number has to swipe to find out whether they were right, and the second slide is the answer. A line that merely tells them the price is good sets up nothing — they can agree with it and keep scrolling.

- EVERY LINE MUST CARRY THE CONTRAST. The post is one argument: the same model costs a fraction of what the original does. If your line does not contain the too-much — a price, "מחיר מלא", "פי שבע", "ביוקר", "כמה באמת" — then it is not a hook, it is the first half of one. Asking the viewer to guess the price counts: the gap between what they guess and what the next slide says IS the contrast, which is why that shape works.

  These are NOT hooks, and each fails the same way:
    "למה אתם משלמים על סט מכוניות"  - paying WHAT? Three words spent naming the picture, nothing left for the point.
    "הסטים האלה ממש שווים"           - says nothing anybody disagrees with.
    "תראו את הסט הזה"                 - an instruction, not an argument.

  The test: could somebody read your line and answer "so what?" If yes, rewrite it.

- VARY THE WORDING INSIDE THAT SHAPE. Asking for a guess is the mechanic; "נחשו כמה שילמתי" is not the only sentence that does it, and four posts in a row opening on the same verb is a template whatever the mechanic underneath. Ask it differently every time: "כמה הייתם משלמים על סט כזה?", "תנחשו את המחיר. לא תאמינו.", "מה המחיר שלו לדעתכם?", "תנו מספר. עכשיו תראו את האמיתי.", "כמה זה נראה לכם?" Name the thing in the picture when it helps — "נחשו כמה עלתה הטירה הזאת" is better than the same line about "סט", because it could only be this post.

- VARY THE SHAPE. Not every cover is a question, and no single pattern is the template — each is one of eleven. Look at the range above: a challenge ("אתם קונים סטים במחיר מלא?"), a first-person admission ("הפסקתי לשלם ביוקר על התחביב שלי"), a flat contrast ("זה אותו דגם. זה לא אותו מחיר."), a before-and-after ("מה הזמנתי VS מה קיבלתי"), a confession ("עשיתי את החישוב ונדהמתי"). These posts go out one after another to the same people; five covers in a row opening with "למה" is a template, and a template is the thing this whole account is trying not to look like.
- No URLs, no calls to action, no hashtags, no emoji.
- Plain hyphens, never an em dash.
- Do not state a specific price or a percentage. The slides carry the numbers; the cover carries the question.

THE EMPHASIS is the one phrase in the line that gets shouted. Hebrew has no capitals, so it is set in a different colour instead. Two to four words, and it must appear in the hook character for character or it will not highlight. Pick the phrase the whole line turns on - what somebody is being asked to stop doing, or the thing they did not expect. Never the whole line: if every word is coloured then no word is shouted.`;

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
export async function draftHook(recipe, { rand = Math.random } = {}) {
  const pool = brickConfig().covers.lines;
  const fallback = () => {
    const picked = pool[Math.floor(rand() * pool.length)];
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
  const specs =
    recipe.slides ||
    recipe.deals.map((deal) => ({ deal, showPrices: true }));

  for (const [i, spec] of specs.entries()) {
    const { deal } = spec;
    onProgress?.(`${i + 1}/${specs.length} ${deal.product}`);

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
    const lines = spec.fact
      ? [{ label: spec.fact.text, value: '' }]
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
      // Carried so the approval message can show what a slide is claiming and
      // where the number came from, without re-deriving any of it.
      deal: {
        price: deal.price,
        setId: deal.setId,
        pieces: deal.pieces,
        link: deal.link,
        theme: deal.theme,
        comparison: deal.comparison,
      },
    });
  }

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
export async function proposeDeck(request = null, { onProgress = null } = {}) {
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
  const enough = fresh.length >= brickConfig().deck.minSlides ? fresh : deals;

  // And never the same set twice in ONE deck, which is a different rule from
  // the one above and the one that was actually being broken on screen. Applied
  // to the pool rather than inside each recipe so that every path — a theme, a
  // price ceiling, a named set, the fallback — inherits it without having to
  // remember to.
  const pool = oneListingPerSet(enough);

  const recipe = chooseRecipe(pool, request);
  if (!recipe) {
    const err = new Error(
      `nothing to build from: ${deals.length} usable deals out of ${total} on the feed` +
        (feedDropped.length ? ` (${feedDropped.length} dropped)` : '')
    );
    err.feedDropped = feedDropped;
    throw err;
  }

  onProgress?.('pricing');
  const priced = await priceDeals(recipe.deals);
  const withPrices = { ...recipe, deals: priced.deals };
  // A single-set recipe carries its own slide list built from the UNPRICED
  // deal, so it has to be rebuilt once the comparison exists — otherwise the
  // saving fact it wanted to show was decided before we knew there was one.
  const ready = withPrices.kind === 'set' ? singleSet(priced.deals[0]) || withPrices : withPrices;

  return {
    request: request || null,
    recipe: ready.kind,
    subject: ready.subject,
    theme: ready.theme || null,
    ceiling: ready.ceiling || null,
    deals: ready.deals,
    slideSpecs: ready.slides || null,
    rates: priced.rates,
    feedDropped,
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
    deals: proposal.deals,
    slides: proposal.slideSpecs,
  };

  onProgress?.('cover');
  const { hook, emphasis, title, from } = await draftHook(ready, { rand });

  onProgress?.('photographs');
  const { slides, dropped } = await buildSlides(ready, { wantImages, onProgress });

  return {
    kind: 'brick',
    recipe: ready.kind,
    subject: ready.subject,
    theme: ready.theme || null,
    ceiling: ready.ceiling || null,
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
