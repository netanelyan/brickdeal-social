import { loadEnv } from '../src/env.js';
loadEnv();

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { unusable, normalise, isPlaceholder, priceAgeDays, loadDeals, __reset as resetFeed } from '../src/brick/feed.js';
import { detectTheme, splitName, THEME_HE, THEME_KEYS } from '../src/brick/themes.js';
import {
  TRADEMARK,
  assertNoTrademark,
  assertNoEmDash,
  assertCopy,
  shekels,
  priceLine,
  priceLineHtml,
  slideLines,
  repairGeresh,
  CopyError,
} from '../src/brick/copy.js';
import { setNumber, pickPrice, longestSideCm, compare } from '../src/brick/rrp.js';
import { emojiFor, THEME_EMOJI, DEFAULT_EMOJI, missingThemes, ALL_USED as BRICK_EMOJI } from '../src/brick/emoji.js';
import { priceRoundup, themeRoundup, savingsRoundup, singleSet, orderSlides, slideScore } from '../src/brick/recipes.js';
import { hashtagsFor, themeTag, captionFor, instagramCaptionFor, dressing } from '../src/brick/caption.js';
import { brickConfig, coverLine } from '../src/brick/config.js';
import { themeKeyFor, chooseRecipe } from '../src/brick/build.js';
import { brickDeckId, sizesFor, photoSummary, brickRepeats } from '../src/brick/candidate.js';
import { holdFor, sourceFor, stillPrompt } from '../src/images/homeShot.js';
import { brickScale, nameClass, coverClass, renderBrickSlideHtml } from '../src/render/brickSlide.js';
import { SIZES } from '../src/render/sizes.js';
import { emojiDataUri } from '../src/render/emojiArt.js';
import { sampleDeals } from './fixtures/deals.js';

// Offline behaviour checks for the BrickDeal path. No network, no credentials.
//
// Everything here is a rule that would be expensive to get wrong quietly: the
// trademark guard, the freshness floor, the "no retail price means no
// comparison" rule, the hashtag count, the bidi on a price line. These are the
// things that are invisible in a rendered slide until somebody screenshots one
// and asks about it.
//
//   npm run brick-test

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
}

const eq = (name, got, want) => ok(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

function throws(name, fn, reason) {
  try {
    fn();
    ok(name, false, 'did not throw');
  } catch (e) {
    ok(name, !reason || e.reason === reason, `threw ${e.reason || e.name}: ${e.message}`);
  }
}

const group = (t) => console.log(`\n${t}`);

const NOW = Date.parse('2026-09-22T12:00:00Z');
const DAY = 86400000;
const deal = (over = {}) => ({
  productId: 'p1',
  name: 'פרחים | זר ורדים',
  setId: '10328',
  pieces: 822,
  price: 44,
  currency: 'ILS',
  image: 'https://example.invalid/a.jpg',
  link: 'https://s.click.aliexpress.com/e/_cReal',
  priceCheckedAt: new Date(NOW - DAY).toISOString(),
  ...over,
});

/* -------------------------------------------------------------------------- */
group('the feed — a slide has no warning band, so this refuses where the site warns');

eq('an ordinary deal is usable', unusable(deal(), { now: NOW }), null);
eq('marked dead', unusable(deal({ dead: true }), { now: NOW }), 'marked dead');
eq('marked unavailable', unusable(deal({ available: false }), { now: NOW }), 'marked unavailable');
eq('no name', unusable(deal({ name: '  ' }), { now: NOW }), 'no name');
eq('no price', unusable(deal({ price: 0 }), { now: NOW }), 'no price');
eq('negative price', unusable(deal({ price: -5 }), { now: NOW }), 'no price');
eq('no link', unusable(deal({ link: '' }), { now: NOW }), 'no link');
eq(
  'a placeholder affiliate link, which the website only warns about',
  unusable(deal({ link: 'https://s.click.aliexpress.com/e/_PLACEHOLDER0002' }), { now: NOW }),
  'placeholder affiliate link'
);
eq(
  'no image to build a photograph from',
  unusable(deal({ image: null, sourceImage: null }), { now: NOW }),
  'no image to build a photograph from'
);
eq(
  'a price nobody has checked',
  unusable(deal({ priceCheckedAt: null }), { now: NOW }),
  'price has never been checked'
);
ok(
  'a price checked 40 days ago is past the freshness floor',
  /^price last checked 40 days ago$/.test(unusable(deal({ priceCheckedAt: new Date(NOW - 40 * DAY).toISOString() }), { now: NOW }))
);
eq(
  'and 13 days is still inside it — the same 14 the website dims a card at',
  unusable(deal({ priceCheckedAt: new Date(NOW - 13 * DAY).toISOString() }), { now: NOW }),
  null
);
ok('a placeholder productId counts too', isPlaceholder({ productId: 'PLACEHOLDER-0002', link: 'https://x.invalid' }));
ok('price age is null when never checked', priceAgeDays({}) === null);

{
  const n = normalise(deal());
  eq('the series comes off the name prefix', n.series, 'פרחים');
  eq('and the product is what is left', n.product, 'זר ורדים');
  eq('the theme is carried or derived', n.theme, 'flowers');
  eq('and its Hebrew label comes with it', n.themeHe, 'פרחים וצמחים');
  eq('a seller photo is kept separately from a render', normalise(deal({ sourceImage: 'https://x.invalid/s.jpg' })).sourceImage, 'https://x.invalid/s.jpg');
}

/* -------------------------------------------------------------------------- */
group('the feed loader, end to end against the fixture');

{
  const dir = path.join(process.cwd(), 'out', 'brick-test');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'feed.json');
  writeFileSync(file, JSON.stringify(sampleDeals(NOW)));
  process.env.BRICKDEAL_FEED_FILE = file;
  delete process.env.BRICKDEAL_FEED_URL;
  resetFeed();

  const { deals, dropped, total } = await loadDeals({ fresh: true, now: NOW });
  eq('every fixture record is accounted for', deals.length + dropped.length, total);
  ok('the placeholder, the stale one and the dead one are all refused', dropped.length === 3, `dropped ${dropped.length}`);
  ok('nothing usable carries a placeholder link', deals.every((d) => !isPlaceholder(d)));
  ok('newest first', deals.every((d, i) => i === 0 || Date.parse(deals[i - 1].postedAt) >= Date.parse(d.postedAt)));

  // Held for the recipe tests below, so they run against the same feed the
  // build would actually see rather than against hand-made objects.
  globalThis.__deals = deals;
}

/* -------------------------------------------------------------------------- */
group('the trademark rule — the one place this deliberately departs from the reference');

for (const [s, want, why] of [
  ['לגו', true, 'bare'],
  ['בלגו', true, 'Hebrew glues its prefixes on'],
  ['הלגו', true, 'and its definite article'],
  ['ולגו', true, 'and its conjunction'],
  ['מחיר לגו גבוה', true, 'mid-sentence'],
  ['דלגו', false, 'they skipped — the false match the copy rule names'],
  ['לגור', false, 'to live'],
  ['לגוף', false, 'to the body'],
  ['לגובה', false, 'to the height'],
  ['LEGO', true, 'Latin'],
  ['legos', true, 'Latin plural — a trailing \\b would miss this'],
  ['Legoland', true, 'Latin compound'],
  ['allegory', false, 'Latin false positive — a leading \\b is still needed'],
  ['אבני בנייה תואמות', false, 'the approved vocabulary'],
  ['מחיר מחירון: 269₪', false, 'the comparison label actually used'],
]) {
  eq(`${want ? 'catches' : 'allows '} ${s} (${why})`, TRADEMARK.test(s), want);
}

throws('a slide name carrying it is refused', () => assertNoTrademark('לגו סטאר וורס', 'a name'), 'trademark');
throws('and so is an em dash in Hebrew copy', () => assertNoEmDash('סטים — תואמים'), 'em-dash');
ok('clean copy passes both', assertCopy('סטים תואמים - במחיר אחר') === 'סטים תואמים - במחיר אחר');
ok('the rule is on by default in brick-config.json', brickConfig().copy.allowTrademark === false);

/* -------------------------------------------------------------------------- */
group('prices on a slide — whole shekels, and the bidi that cannot be read off the HTML');

eq('rounded, never agorot', shekels(129.4), '129₪');
eq('rounded up as well as down', shekels(129.6), '130₪');
eq('grouped past a thousand', shekels(1499), '1,499₪');
eq('a price line is a label and a value, kept apart', JSON.stringify(priceLine('בקהילה', 45)), JSON.stringify({ label: 'בקהילה', value: '45₪' }));
eq('the value is isolated so a reworded label cannot re-resolve it', priceLineHtml(priceLine('בקהילה', 45)), 'בקהילה: <bdi>45₪</bdi>');
eq('a line with no value is a sentence, and carries no dangling colon', priceLineHtml({ label: '822 חלקים', value: '' }), '822 חלקים');

{
  const three = slideLines({ ok: true, paid: 129, listIls: 559, saving: 430 }, { price: 129 });
  eq('a sourced comparison is three lines', three.length, 3);
  eq('ours first', three[0].label, brickConfig().labels.ours);
  eq('then the list price', three[1].label, brickConfig().labels.list);
  eq('then the saving', three[2].label, brickConfig().labels.saving);

  const one = slideLines({ ok: false, why: 'no such set on Brickset' }, { price: 78 });
  eq('no comparison is ONE line, not an error state', one.length, 1);
  eq('and it is the price we actually charge', one[0].value, '78₪');
}

/* -------------------------------------------------------------------------- */
group('the comparison — an empty comparison beats an invented one');

eq('a bare set number gets the -1 variant Brickset keys on', setNumber('10328'), '10328-1');
eq('an explicit variant is left alone', setNumber('10328-2'), '10328-2');
eq('a MOC with no set number cannot be looked up', setNumber(null), null);
eq('and neither can something that is not a number', setNumber('ABC'), null);

eq(
  'Germany is preferred, because its price includes VAT and Israel has VAT',
  JSON.stringify(pickPrice({ US: { retailPrice: 100 }, DE: { retailPrice: 90 }, UK: { retailPrice: 80 } })),
  JSON.stringify({ amount: 90, currency: 'EUR', region: 'DE' })
);
eq(
  'the United States is the last resort, not the first',
  pickPrice({ US: { retailPrice: 100 }, CA: { retailPrice: 130 } }).region,
  'CA'
);
eq('a region priced at zero was never sold there', pickPrice({ DE: { retailPrice: 0 }, US: { retailPrice: 100 } }).region, 'US');
eq('no LEGOCom block at all', pickPrice(undefined), null);
eq('the longest side is what the photograph step needs', longestSideCm({ height: 12, width: 40, depth: 7 }), 40);
eq('no dimensions is null, never a guess', longestSideCm({}), null);

{
  const rate = { rate: 4, date: '2026-09-22' };
  const good = compare({ price: 129, rrp: { amount: 140, currency: 'EUR', region: 'DE' }, rate });
  ok('an ordinary comparison resolves', good.ok);
  eq('converted and rounded to the shekel', good.listIls, 560);
  eq('the saving is the difference', good.saving, 431);
  eq('and the rate travels with it, so the slide can be checked later', good.source.rateDate, '2026-09-22');

  ok('no retail price means no comparison', compare({ price: 129, rrp: null, rate }).ok === false);
  ok('no exchange rate means no comparison', compare({ price: 129, rrp: { amount: 140, currency: 'EUR' }, rate: null }).ok === false);

  const inverted = compare({ price: 200, rrp: { amount: 40, currency: 'EUR', region: 'DE' }, rate });
  ok('a "saving" against a lower list price is refused outright', inverted.ok === false);
  ok('and says so in numbers', /not above/.test(inverted.why), inverted.why);

  const tiny = compare({ price: 129, rrp: { amount: 35, currency: 'EUR', region: 'DE' }, rate, minSaving: 20 });
  ok('a saving under the floor is not worth a comparison line', tiny.ok === false, tiny.why);
}

/* -------------------------------------------------------------------------- */
group('the emoji beside a name — a fixed map, not a free choice');

eq('every theme in themes.js has one', missingThemes().length, 0, JSON.stringify(missingThemes()));
eq('a themed deal takes its theme emoji', emojiFor({ theme: 'flowers', name: 'פרחים | סחלב' }), '🌸');
eq('an unthemed deal takes the brick', emojiFor({ name: 'משהו' }), DEFAULT_EMOJI);
eq('a castle in a wizarding deck is a castle, not a wand', emojiFor({ theme: 'harry-potter', name: 'הארי פוטר | טירת הוגוורטס' }), '🏰');
eq('and its train is a train', emojiFor({ theme: 'harry-potter', name: 'הארי פוטר | רכבת הוגוורטס' }), '🚂');
eq('a bonsai in a flowers deck is a tree, not a blossom', emojiFor({ theme: 'flowers', name: 'פרחים | עץ בונסאי' }), '🌳');
ok(
  'every emoji a slide can draw has artwork committed — otherwise it renders differently on the VPS',
  BRICK_EMOJI.every((ch) => Boolean(emojiDataUri(ch))),
  BRICK_EMOJI.filter((ch) => !emojiDataUri(ch)).join(' ')
);

/* -------------------------------------------------------------------------- */
group('themes');

eq('the series prefix states the theme outright', detectTheme('מלחמת הכוכבים | ספינת אקס ווינג'), 'star-wars');
eq('a legacy name with no pipe still works', detectTheme('טירת הוגוורטס הגדולה'), 'harry-potter');
eq('an unrecognisable name gets no theme rather than a wrong one', detectTheme('משהו כללי'), undefined);
eq('a name with no pipe has no series', splitName('זר ורדים').series, undefined);
eq('every theme key has a Hebrew label', THEME_KEYS.filter((k) => !THEME_HE[k]).length, 0);

/* -------------------------------------------------------------------------- */
group('recipes — which five deals, in which order');

{
  const deals = globalThis.__deals;

  const priced = deals.map((d) => ({ ...d, comparison: { ok: false, why: 'test' } }));
  const under = priceRoundup(priced, { want: 3, ceilings: [50, 100, 200, 500] });
  ok('a price roundup finds a ceiling that fills the deck', Boolean(under));
  ok('and takes the tightest true claim, not a safe round number', under.ceiling === 100, `chose ${under?.ceiling}`);
  ok('every deal really is under it', under.deals.every((d) => d.price <= under.ceiling));

  const theme = themeRoundup(priced, { want: 5 });
  ok('a theme roundup picks a theme that can actually fill one', Boolean(theme));
  ok('and every slide is that theme', theme.deals.every((d) => d.theme === theme.theme));
  eq('a theme with too few deals is refused rather than padded', themeRoundup(priced, { theme: 'dinosaurs', want: 5 }), null);

  eq('a savings roundup needs deals that have savings', savingsRoundup(priced, { want: 3 }), null);
  const withSavings = priced.map((d, i) => ({ ...d, comparison: { ok: true, paid: d.price, listIls: d.price * 3, saving: 100 + i * 10 } }));
  ok('and finds them when they exist', Boolean(savingsRoundup(withSavings, { want: 3 })));

  ok(
    'a sourced comparison outranks anything a piece count can say',
    slideScore({ comparison: { ok: true, saving: 20, listIls: 100 }, pieces: 1 }) >
      slideScore({ comparison: { ok: false }, pieces: 10000 })
  );

  const ordered = orderSlides([
    { id: 'a', comparison: { ok: true, saving: 500, listIls: 1000 } },
    { id: 'b', comparison: { ok: true, saving: 400, listIls: 1000 } },
    { id: 'c', comparison: { ok: true, saving: 300, listIls: 1000 } },
    { id: 'd', comparison: { ok: true, saving: 200, listIls: 1000 } },
  ]);
  eq('the strongest slide goes first, where it decides whether anyone swipes', ordered[0].id, 'a');
  eq('the second-strongest goes last, where it decides whether anyone follows', ordered.at(-1).id, 'b');
  eq('fewer than three slides is left alone', orderSlides([{ id: 'a' }, { id: 'b' }]).length, 2);

  const one = singleSet({ ...priced[0], pieces: 822, stars: 4.9, series: 'פרחים' }, { want: 5 });
  ok('a single-set post is built from what the feed actually knows', Boolean(one));
  ok('its first slide carries the prices', one.slides[0].showPrices === true);
  ok('and the rest carry one fact each, not the same price five times', one.slides.slice(1).every((s) => s.fact));
  eq('a deal the feed knows nothing about cannot fill one', singleSet({ productId: 'x', price: 10 }, { want: 5 }), null);
}

/* -------------------------------------------------------------------------- */
group('what goes under the post');

{
  const deck = { theme: 'harry-potter', titleHe: 'הארי פוטר', slides: [] };
  const cfg = brickConfig().hashtags;

  const tags = hashtagsFor(deck);
  eq('exactly five tags', tags.length, cfg.broadCount + cfg.nicheCount);
  eq('no duplicates', new Set(tags).size, tags.length);
  ok('every one is a hashtag', tags.every((t) => t.startsWith('#')));
  ok("the deck's own theme spends a niche slot", tags.includes('#האריפוטר'));

  const noTheme = hashtagsFor({ slides: [] });
  eq('a deck with no theme publishes the same number of tags', noTheme.length, cfg.broadCount + cfg.nicheCount);
  eq('a theme that cannot be resolved has no tag', themeTag({ theme: null }), null);
  eq('a multi-word theme closes up into one word', themeTag({ theme: 'star-wars' }), '#מלחמתהכוכבים');

  ok('no tag carries the trademark while the rule is on', tags.every((t) => !TRADEMARK.test(t)));

  const dress = dressing(deck);
  const tiktok = captionFor(deck, dress);
  const insta = instagramCaptionFor(deck, dress);
  ok('the caption carries the call to the community', tiktok.includes(brickConfig().caption.cta));
  ok('and a separator before the tags', tiktok.includes(brickConfig().caption.separator));
  ok('no URL anywhere in it — the link lives in the bio', !/https?:\/\/|www\.|\.com|\.co\.il/i.test(tiktok));
  ok("Instagram opens with the title, because a carousel has no title field", insta.startsWith(deck.titleHe));
  eq(
    'both destinations get the SAME tags — one deck is one post',
    tiktok.split('\n').at(-1),
    insta.split('\n').at(-1)
  );
  eq('and the same opening line', tiktok.split('\n')[0], insta.split('\n')[2]);
}

/* -------------------------------------------------------------------------- */
group('the candidate');

{
  const slides = [
    { productId: 'b', nameHe: 'ב', image: { provenance: 'generated' }, deal: { price: 10 } },
    { productId: 'a', nameHe: 'א', image: { provenance: 'stock' }, deal: { price: 20 } },
  ];
  const deck = { slides, subject: 'x', recipe: 'theme', theme: 'flowers' };

  eq('the id is keyed on the products, in a stable order', brickDeckId(deck), brickDeckId({ slides: [...slides].reverse() }));
  ok('and two different decks differ', brickDeckId(deck) !== brickDeckId({ slides: [{ productId: 'c' }] }));

  eq('only the sizes a destination needs', JSON.stringify(sizesFor(['tiktok', 'tiktok', 'telegram'])), JSON.stringify(['tiktok']));
  eq('the first destination is the one previewed', sizesFor(['instagram', 'tiktok'])[0], 'instagram');

  const photos = photoSummary(slides);
  eq('the approval card can count generated photographs', photos.generated, 1);
  eq('and catalogue ones', photos.stock, 1);

  const repeats = brickRepeats(deck, [{ topic: 'flowers' }, { topic: 'flowers' }]);
  ok('a run of the same theme is reported before you tap', repeats.length >= 1, JSON.stringify(repeats));
  eq('a first post on a theme says nothing', brickRepeats(deck, []).length, 0);

  const overlap = brickRepeats(deck, [{ topic: 'other', headline: 'last week', productIds: ['a', 'b'] }]);
  ok('so is a roundup that reuses last week\'s sets', overlap.some((n) => /כבר היו/.test(n)), JSON.stringify(overlap));
}

/* -------------------------------------------------------------------------- */
group('the photograph step');

eq('a small model is held in the fingers', holdFor({ sizeCm: 10 }).fraction, 'most');
eq('a mid-sized one sits on an open palm', holdFor({ sizeCm: 30 }).fraction, 'one third');
eq('a large one rests on a desk, because a palm makes it read as a trinket', holdFor({ sizeCm: 60 }).fraction, 'a quarter');
ok('a bouquet is gripped by the stems', /stems/.test(holdFor({ theme: 'flowers' }).hold));
eq(
  'the seller photo wins over the official render — the link sells that one',
  sourceFor({ image: 'render.jpg', sourceImage: 'seller.jpg' }).url,
  'seller.jpg'
);
eq('with nothing else, the feed image is what there is', sourceFor({ image: 'render.jpg' }).url, 'render.jpg');
{
  const p = stillPrompt({ nameHe: 'x', sizeCm: 30, theme: 'vehicles' });
  ok('the prompt states the real size rather than guessing silently', p.includes('30 cm'));
  ok('and forbids lettering, which would put a trademark somewhere copy.js cannot see', /lettering on the model/.test(p));
  ok('and asks for a real room rather than a studio', /bedroom/.test(p));
}

/* -------------------------------------------------------------------------- */
group('the slide');

{
  const s = brickScale({ w: 1080, h: 1920 });
  ok('the name is the largest thing on its slide', s.name > s.line);
  ok('the price lines are a step down, not a whisper', s.line / s.name > 0.7 && s.line / s.name < 0.85, `${s.line}/${s.name}`);

  // The cover now sets LARGER than a set name, which reverses what this test
  // asserted for most of the file's life.
  //
  // The old rule was sound while it was true that "a hook is a sentence and a
  // name is a label, so the sentence gives up size to fit on two lines". It is
  // not true any more: draftHook enforces MAX_HOOK_WORDS, so a hook is now six
  // words at most, which fits two comfortable lines without giving up anything.
  // With the length problem solved by the length rule, there is no argument
  // left for the most important type in the post being the smallest.
  ok('the cover is the loudest type in the post', s.cover > s.name && s.name > s.line, `${s.cover}/${s.name}/${s.line}`);

  // An edge, not a border. The heavy ~7px version was built first, off the
  // reference account, and the lighter travel-channel treatment was chosen
  // instead - so what carries legibility is the scrim and the shadow. Raising
  // strokePct back toward 0.006 is the one-line way to undo that.
  ok('the outline is an edge rather than a border', s.stroke >= 1 && s.stroke <= 4, `${s.stroke}px`);

  eq('a long name steps down a size', nameClass('מסדרונות הטירה והספרייה הגדולה של בית הספר'), ' long');
  eq('a short one does not', nameClass('סחלב'), '');

  // The feed ships some names with the geresh dropped — "ג יפ" for "ג'יפ".
  // Repaired on the way in, narrowly: a prefix letter standing before a word is
  // ordinary Hebrew and must survive untouched.
  eq('a dropped geresh is put back', repairGeresh('מכוניות | ג יפ שטח עם ציוד'), "מכוניות | ג'יפ שטח עם ציוד");
  eq('and at the start of a name', repairGeresh('ג יפ כחול'), "ג'יפ כחול");
  eq('a clean name is left alone', repairGeresh('מכונית ספורט שחורה'), 'מכונית ספורט שחורה');
  eq('and a prefix letter is not a lost geresh', repairGeresh('ה מכונית'), 'ה מכונית');

  eq('a long hook is broken over two lines', coverClass('למה אתה עדיין משלם אלף שקל על מכונית מאבנים?'), ' long');
  eq('a short one is left on one', coverClass('שליש מהמחיר'), '');

  const html = renderBrickSlideHtml(
    { nameHe: 'סחלב', emoji: '🌸', lines: slideLines({ ok: true, paid: 45, listIls: 269, saving: 224 }, { price: 45 }), image: null },
    { size: 'tiktok' }
  );
  ok('the page is right to left', html.includes('dir="rtl"'));
  ok('the outline is painted outside the letter, not over it', html.includes('paint-order:stroke fill'));
  ok('no watermark is on the frame', !html.includes('class="mark"'));

  // The end card. The ask is the only branding left in the post now that the
  // watermark is gone, so "it rendered at all" is worth asserting.
  const endHtml = renderBrickSlideHtml({ image: null }, { size: 'tiktok', end: true });
  const ec = brickConfig().endCard;
  ok('the closing frame carries the ask', endHtml.includes(ec.askHe));
  ok('and says where to go', endHtml.includes(ec.whereHe));
  ok('and prints the address', endHtml.includes(ec.siteHe));
  ok('the closing frame washes the photograph back', endHtml.includes('end-scrim'));
  ok('it carries no price block', !endHtml.includes('class="line'));
  ok('the money bag rides the saving line', html.includes('💰') || /1f4b0/.test(html));
  ok('nothing on the slide carries the trademark', !TRADEMARK.test(html.replace(/<[^>]*>/g, '')));
  ok('the block is centred, as the published posts are', html.includes('text-align:center'));
  ok('a set name sits near the top, clear of the product', html.includes('block at-top'));
  ok('and the scrim is there, because a 2px outline cannot carry a white wall alone', html.includes('class="scrim"'));
  ok('the saving is the one line set in cream', /class="line emph"/.test(html));
  ok('and the two plain price lines are not', (html.match(/class="line"/g) || []).length === 2);

  const cover = renderBrickSlideHtml(
    { hookHe: 'אתם קונים סטים במחיר מלא?', emphasisHe: 'במחיר מלא', image: null },
    { size: 'tiktok', cover: true }
  );
  ok('a cover carries the hook', cover.includes('אתם קונים סטים'));
  ok('and no price block — a number there answers the question the deck is for', !cover.includes(brickConfig().labels.list));
  ok('a hook sits across the upper middle, not at the top like a name', cover.includes('block at-mid'));
  ok('one phrase is shouted in cream, because Hebrew has no capitals', /<span class="emph[^"]*">במחיר מלא<\/span>/.test(cover));

  // An emphasis the model paraphrased has to degrade to one colour rather than
  // to a duplicated fragment or a stray marker on the slide.
  const noMatch = renderBrickSlideHtml(
    { hookHe: 'אתם קונים סטים במחיר מלא?', emphasisHe: 'משהו אחר לגמרי', image: null },
    { size: 'tiktok', cover: true }
  );
  ok('an emphasis that is not in the hook simply does not highlight', !noMatch.includes('class="emph'));
  ok('and the hook itself is untouched', noMatch.includes('אתם קונים סטים במחיר מלא?'));

  eq('the stars never reach a slide', coverLine('קונים *במחיר מלא*?').text, 'קונים במחיר מלא?');
  eq('and the phrase comes out separately', coverLine('קונים *במחיר מלא*?').emphasis, 'במחיר מלא');
  eq('an unmarked line has no emphasis', coverLine('בלי דגש').emphasis, null);
  eq('an unbalanced star is stripped rather than published', coverLine('חצי *דגש').text, 'חצי דגש');
  ok('every configured cover survives the round trip', brickConfig().covers.lines.every((l) => l.text && !l.text.includes('*')));
}

/* -------------------------------------------------------------------------- */
group('requests');

eq('a theme key is taken as one', themeKeyFor('harry-potter'), 'harry-potter');
eq('so is its Hebrew label', themeKeyFor('הארי פוטר'), 'harry-potter');
eq('and a loose English word', themeKeyFor('potter'), 'harry-potter');
eq('a word matching nothing is null, not a guess', themeKeyFor('כלום שלא קיים'), null);
eq('and so is an empty request', themeKeyFor(''), null);
{
  const deals = globalThis.__deals.map((d) => ({ ...d, comparison: { ok: false } }));

  ok('a request nothing matches still yields a buildable deck', Boolean(chooseRecipe(deals, 'nonsense')));
  eq('a theme name builds that theme', chooseRecipe(deals, 'harry-potter')?.theme, 'harry-potter');
  eq('a bare number builds a price roundup', chooseRecipe(deals, '100')?.kind, 'price');
  eq('and takes the number as the ceiling', chooseRecipe(deals, '100')?.ceiling, 100);

  // The regression. `themeRoundup(deals, { theme: null })` does not mean "no
  // theme", it means "pick the best theme" — so passing an unresolved request
  // straight through swallowed every other reading of it, and `/deck בונסאי`
  // came back as a Harry Potter roundup without the bonsai set ever being
  // looked for.
  const named = chooseRecipe(deals, 'בונסאי');
  eq('a set name builds a single-set post, not whatever theme is strongest', named?.kind, 'set');
  ok('and it is the set that was named', named?.deals[0]?.product?.includes('בונסאי'), named?.deals[0]?.product);
  ok(
    'matched on the product half of the feed name, not only the whole string',
    chooseRecipe(deals, 'זר ורדים')?.deals[0]?.product === 'זר ורדים'
  );
}

/* -------------------------------------------------------------------------- */
group('the config refuses to be half-loaded');

{
  const cfg = brickConfig();
  ok('the caption pool is not empty', cfg.caption.lines.length > 0);
  ok('the cover pool is not empty', cfg.covers.lines.length > 0);
  ok('there are enough tags to draw the configured number', cfg.hashtags.broad.length >= cfg.hashtags.broadCount);
  ok('and enough niche ones', cfg.hashtags.niche.length >= cfg.hashtags.nicheCount);
  ok('the deck size sits inside its own bounds', cfg.deck.minSlides <= cfg.deck.slides && cfg.deck.slides <= cfg.deck.maxSlides);
}

/* -------------------------------------------------------------------------- */
console.log(`\n${'─'.repeat(56)}`);
if (fail) {
  console.log(`${pass} passed, ${fail} FAILED\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`${pass} passed, 0 failed`);
}
