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
import { deckImageUrls, renderedSizes } from '../src/publish/deckImages.js';
import { emojiFor, THEME_EMOJI, DEFAULT_EMOJI, missingThemes, ALL_USED as BRICK_EMOJI } from '../src/brick/emoji.js';
import { priceRoundup, themeRoundup, savingsRoundup, singleSet, orderSlides, slideScore } from '../src/brick/recipes.js';
import { hashtagsFor, themeTag, captionFor, instagramCaptionFor, dressing } from '../src/brick/caption.js';
import { brickConfig, coverLine } from '../src/brick/config.js';
import { themeKeyFor, chooseRecipe, priceHook, PRICE_HOOK_RATIO, MAX_HOOK_WORDS } from '../src/brick/build.js';
import { brickDeckId, sizesFor, photoSummary, brickRepeats } from '../src/brick/candidate.js';
import { holdFor, sourceFor, stillPrompt, HEADROOM_MIN } from '../src/images/homeShot.js';
import { subjectTopRow, fitPhoto, scrimAlpha, underScrim } from '../src/render/headroom.js';
import { brickScale, nameClass, coverClass, coverHtml, renderBrickSlideHtml } from '../src/render/brickSlide.js';
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
group('a deck finds the slides it actually rendered');
{
  // The exact shape toBrickCandidate produces: renderBrickDeck returns its work
  // keyed by SIZE and that is spread onto the deck. There is no `urls` key and
  // there never was — both publishers used to read one, so every deck looked
  // unrendered to them.
  const cand = {
    kind: 'deck',
    card: { url: 'https://example.com/cards/cover-instagram-01.jpg' },
    deck: {
      tiktok: [
        { index: 1, url: 'https://example.com/cards/d-tiktok-01.jpg' },
        { index: 2, url: 'https://example.com/cards/d-tiktok-02.jpg' },
      ],
      instagram: [{ index: 1, url: 'https://example.com/cards/d-instagram-01.jpg' }],
    },
  };

  eq('the 9:16 slides are found, in order', deckImageUrls(cand, 'tiktok').join(','),
    'https://example.com/cards/d-tiktok-01.jpg,https://example.com/cards/d-tiktok-02.jpg');
  eq('and the 4:5 ones separately', deckImageUrls(cand, 'instagram').length, 1);
  eq('a size that was never rendered is empty, not undefined', deckImageUrls({ deck: {} }, 'tiktok').length, 0);
  eq('and so is a deck with no renders at all', deckImageUrls({}, 'tiktok').length, 0);
  eq('what it has is reported, for the error message', renderedSizes(cand).join(','), 'tiktok,instagram');

  // The regression guard. A deck carrying ONLY the old, invented path must read
  // as unrendered — otherwise the shape could quietly come back and the tests
  // above would still pass.
  const wrongShape = { kind: 'deck', deck: { urls: { tiktok: ['https://example.com/x.jpg'] } } };
  eq('the invented urls key is not a source of slides', deckImageUrls(wrongShape, 'tiktok').length, 0);
}

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
  ok('and an ask for a comment', Boolean(dress.engage) && tiktok.includes(dress.engage));
  // Both destinations get the one drawn ask. Drawing it per caption would send
  // the same post out wearing two different faces.
  ok('the same ask reaches Instagram', instagramCaptionFor(deck, dress).includes(dress.engage));
  // Order: what it is, then the free thing to do, then the link that takes you
  // away. A CTA that leaves the post should not be offered first.
  ok(
    'the comment ask comes before the link',
    tiktok.indexOf(dress.engage) < tiktok.indexOf(brickConfig().caption.cta)
  );
  ok('and a reason to follow', Boolean(dress.follow) && tiktok.includes(dress.follow));
  ok('the same reason reaches Instagram', insta.includes(dress.follow));
  // It is the last thing said before the tags, because it is the only line
  // about the NEXT post rather than this one.
  ok(
    'the reason to follow closes the caption',
    tiktok.indexOf(dress.follow) > tiktok.indexOf(brickConfig().caption.cta)
  );
  eq(
    'nothing but the separator and the tags comes after it',
    tiktok.split('\n').slice(-3)[0],
    dress.follow
  );
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
group('the cover that leads with the price');

{
  const slide = (paid, listIls) => ({
    deal: { price: paid, comparison: { ok: true, paid, listIls, saving: listIls - paid } },
  });

  const led = priceHook(slide(89, 400), { rand: () => 0 });
  ok('a wide gap puts both numbers on the cover', led && /89₪/.test(led.hook) && /400₪/.test(led.hook), led?.hook);
  eq('and says where it came from', led?.from, 'price');
  ok('the shout is a phrase inside the line, or there is none', !led.emphasis || led.hook.includes(led.emphasis));
  ok('our price is the one shouted', !led.emphasis || /89₪/.test(led.emphasis), led?.emphasis);
  ok('no placeholder survives into the line', !/\{(ours|list)\}/.test(led.hook + (led.emphasis || '')));
  // The numbers on the cover are the numbers on the slide under it. A cover
  // quoting a price the post does not charge is the one failure that matters.
  ok('the trademark cannot reach a cover', !TRADEMARK.test(led.hook));

  // Every shape, not just the one the first draw happened to land on.
  const all = brickConfig().covers.priceLines.map((_, i) =>
    priceHook(slide(89, 400), { rand: () => i / brickConfig().covers.priceLines.length })
  );
  ok('every shape fills in', all.every((h) => h && /89₪/.test(h.hook) && /400₪/.test(h.hook)));
  ok(
    'and every one fits the cover, same limit a written hook has',
    all.every((h) => h.hook.split(/\s+/).filter(Boolean).length <= MAX_HOOK_WORDS),
    all.map((h) => `${h.hook.split(/\s+/).length}: ${h.hook}`).find((s) => Number(s.split(':')[0]) > MAX_HOOK_WORDS) || 'clean'
  );
  ok('none of them names the brand', all.every((h) => !TRADEMARK.test(h.hook)));

  // When there is no number worth leading with, there is no price cover — the
  // deck asks for a guess instead, where the contrast is whatever the viewer
  // imagined rather than one we had to defend.
  eq('a slide with no comparison declines', priceHook({ deal: { price: 89, comparison: { ok: false } } }), null);
  eq('and so does a missing slide', priceHook(undefined), null);
  eq(
    `a gap under ${PRICE_HOOK_RATIO}x is not worth the loudest slide in the post`,
    priceHook(slide(89, Math.floor(89 * PRICE_HOOK_RATIO) - 1), { rand: () => 0 }),
    null
  );
  ok('a gap at the ratio is', Boolean(priceHook(slide(100, 250), { rand: () => 0 })));
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
  ok('and asks for a real room rather than a studio', /a real room in daylight/.test(p));
  // A slide is watched at thumbnail size, where a dark frame is a dark smudge.
  // The prompt used to stage the shot in a dim bedroom at night.
  ok('the room is bright and lit by daylight', /the room is bright/.test(p) && /daylight/.test(p));
  ok(
    'and nothing asks for the dark any more',
    !/at night|the room is dim|soft shadow/.test(p),
    p.match(/at night|the room is dim|soft shadow/)?.[0] || 'clean'
  );
  ok('a dark scene is refused outright', /dark room/.test(p) && /underexposed/.test(p));
  ok('and so is the model sitting in shadow', /the model sitting in shadow/.test(p));
  // The subject is whatever the link sells. A black set is photographed black —
  // lit and legible, not recoloured. See the note above `stillPrompt`.
  ok('but the model still has to match the photo exactly', /matches the attached photo exactly/.test(p));

  // The two framing rules contradict each other for a tall subject — a bouquet
  // two thirds of the frame wide is taller than the frame — and the deck that
  // went out with the type across a Christmas tree is what the model did with
  // that contradiction. One of them has to be named as the one that yields.
  ok('the width rule gives way to the headroom rule', /which always wins/.test(p));
  ok('and the headroom rule is a fraction of the frame, which survives the crop', /lower two thirds of the frame/.test(p));

  const again = stillPrompt({ nameHe: 'x', sizeCm: 30, theme: 'flowers', insist: true });
  ok('a second attempt asks for the bottom half instead', /lower half of the frame/.test(again));
  ok('and says so before anything else, where it carries weight', again.indexOf('BOTTOM HALF') < again.indexOf('Framing:'));
  ok('and warns that the model will look smaller, so it is not corrected back', /SMALLER in the frame/.test(again));
  ok('the ordinary prompt does not shout', !/BOTTOM HALF/.test(p));
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

  // The cover asks for the swipe, and asks quieter than it asks the question.
  const coverHtmlOut = renderBrickSlideHtml(
    { hookHe: 'כמה באמת צריך לשלם?', emphasisHe: 'באמת', image: null },
    { size: 'tiktok', cover: true }
  );
  const plainSlide = renderBrickSlideHtml({ nameHe: 'סחלב', emoji: '🌸', lines: [], image: null }, { size: 'tiktok' });
  ok('the cover asks for the swipe', coverHtmlOut.includes(brickConfig().covers.swipeHe));
  ok('and a product slide does not', !plainSlide.includes(brickConfig().covers.swipeHe));

  // The swipe line is the second and last hand-written place the brand is
  // named, and it is named the same way the price label names it — as what the
  // comparison is against. The HOOK must never carry it: that one is written
  // by a model, and the guard cannot tell a comparison from a claim of origin.
  ok('the swipe line names what the price is compared against', TRADEMARK.test(brickConfig().covers.swipeHe));
  ok(
    'but the cover hook itself never does',
    !TRADEMARK.test(brickConfig().covers.lines.map((l) => l.text).join(' '))
  );
  ok(
    'and neither does a price-led one, which the build would throw on',
    !TRADEMARK.test(brickConfig().covers.priceLines.map((l) => l.text).join(' '))
  );

  // A cover that already printed both numbers must not then offer to reveal
  // the one it printed. It offers the rest of the post instead.
  const priceCover = renderBrickSlideHtml(
    { hookHe: 'זה עולה 89₪ במקום 419₪', emphasisHe: '89₪', image: null, priceLed: true },
    { size: 'tiktok', cover: true }
  );
  ok('a price-led cover asks for the swipe differently', priceCover.includes(brickConfig().covers.swipePriceHe));
  ok(
    'and does not offer to reveal the number it just printed',
    !priceCover.includes(brickConfig().covers.swipeHe)
  );
  ok('the swipe line is quieter than the price lines', /\.swipe\s*\{[^}]*font-size:(\d+)px/.test(coverHtmlOut) &&
    Number(coverHtmlOut.match(/\.swipe\s*\{[^}]*font-size:(\d+)px/)[1]) < s.line);

  eq('a long hook is broken over two lines', coverClass('למה אתה עדיין משלם אלף שקל על מכונית מאבנים?'), ' long');
  eq('a short one is left on one', coverClass('שליש מהמחיר'), '');

  // One number can end with the other. The cream belongs on OUR price, not on
  // the last two digits of the list price.
  ok(
    'the shout lands on the whole number, not inside a bigger one',
    /<span class="emph[^"]*">99₪<\/span>$/.test(coverHtml('במחירון 399₪. אצלי 99₪', '99₪')),
    coverHtml('במחירון 399₪. אצלי 99₪', '99₪')
  );
  ok(
    'and an emphasis that really is mid-word still highlights',
    /emph/.test(coverHtml('שליש מהמחיר', 'מחיר')),
    coverHtml('שליש מהמחיר', 'מחיר')
  );

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
  ok('and gives a reason to follow', endHtml.includes(ec.followHe));
  ok('and prints the address', endHtml.includes(ec.siteHe));
  // The address stays the last thing read. See the note beside `.end .follow`.
  ok(
    'the reason sits above the address, not under it',
    endHtml.indexOf(ec.followHe) < endHtml.indexOf(`class="site"`)
  );
  ok('the closing frame washes the photograph back', endHtml.includes('end-scrim'));
  ok('it carries no price block', !endHtml.includes('class="line'));
  ok('the money bag rides the saving line', html.includes('💰') || /1f4b0/.test(html));
  // The trademark may appear on a slide in ONE place: the configured list
  // label, where it names the price being compared against. Everywhere else on
  // the frame — the set name, the hook, the saving line — it is still banned,
  // because there it would be describing what is being sold rather than what
  // the price is measured against.
  {
    const text = html.replace(/<[^>]*>/g, '');
    const withoutLabel = text.split(brickConfig().labels.list).join('');
    ok('the list label names the brand it is comparing against', TRADEMARK.test(brickConfig().labels.list));
    ok('and nothing else on the slide carries the trademark', !TRADEMARK.test(withoutLabel));
  }
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
group('the room above the model');

{
  // The detector. `energy` is one number per row of the photograph: how sharp
  // the sharpest part of that row is. The subject is the sharp thing, because
  // the prompt puts everything else out of focus.
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i / n));
  const quiet = 0.01;
  const sharp = 0.4;

  eq(
    'a model in the lower half is found where it starts',
    Math.round(subjectTopRow(rows(100, (y) => (y < 0.4 ? quiet : sharp))) * 100),
    40
  );
  eq('a photograph of nothing is empty all the way down', subjectTopRow(rows(100, () => quiet)), 1);
  eq(
    'an out-of-focus room is not a subject',
    subjectTopRow(rows(100, (y) => (y < 0.4 ? 0.02 : 0.03))),
    1
  );
  // The absolute floor is what stops the relative one turning grain into a
  // plant: dividing by a small peak makes everything look large.
  eq(
    'grain on a bare wall is not a subject either',
    subjectTopRow(rows(100, (y) => (y === 0.5 ? 0.012 : 0.008))),
    1
  );
  ok(
    'one bright row is not a model — four in a row are',
    subjectTopRow(rows(100, (y) => (Math.abs(y - 0.2) < 0.011 ? sharp : quiet))) > 0.5
  );

  // The fit. All frame pixels; `need` is the bottom of the type.
  const IG = { frameW: 1080, frameH: 1350, imgW: 768, imgH: 1344, anchorPct: 0.33, dropMax: 135, zoomMin: 0.8 };

  ok('a photograph with room above the model is not touched at all', fitPhoto({ ...IG, subject: 0.5, need: 458 }) === null);

  {
    const p = fitPhoto({ ...IG, subject: 0.3, need: 458 });
    ok('one that is nearly there is dropped rather than shrunk', p && p.zoom === 1, JSON.stringify(p));
    ok('and the type then clears the model', p.top >= 458, `${p?.top}`);
    ok('the picture still reaches both sides', !p.sides);
    ok('and its bottom edge is still below the frame', p.y + p.h >= 1350);
  }

  {
    const p = fitPhoto({ ...IG, subject: 0.1, need: 458 });
    ok('a model reaching the top is shrunk once the drop runs out', p.zoom < 1 && p.zoom >= 0.8, `${p?.zoom}`);
    ok('the drop is spent first, because it costs less', p.drop === 135, `${p?.drop}`);
    ok('the type clears it', p.top >= 458, `${p?.top}`);
    ok('the bottom of the frame is still photograph', p.y + p.h >= 1350);
    ok('the band above it is filled with the wall out of the picture itself', p.stretch !== null);
    ok('and the fill reaches past the frame so its blur cannot show an edge', p.stretch.top < 0 && p.stretch.left < 0);
    ok(
      'the fill never fades further than the strip it is made of',
      p.stretch.fade <= Math.max(6, p.stretch.strip),
      `${p.stretch.fade} vs ${p.stretch.strip}`
    );
  }

  {
    // Both levers run out. The honest answer is a number, not a silent pass.
    const p = fitPhoto({ ...IG, subject: 0.01, need: 458 });
    eq('a model filling the frame hits the shrink limit', p.zoom, 0.8);
    ok('and says how far short it fell', p.short > 0, `${p?.short}`);
    ok('rather than cropping the hand off to get there', p.drop <= 135);
  }

  // The threshold the generator gates on is derived from the frame it is
  // hardest for, not chosen. At exactly HEADROOM_MIN the 4:5 frame must still
  // clear the type on the drop alone — no shrink, no slivers down the sides.
  {
    const p = fitPhoto({ ...IG, subject: HEADROOM_MIN, need: 458 });
    ok('a shot at the gate threshold needs no shrinking', p === null || p.zoom === 1, JSON.stringify(p));
    const worse = fitPhoto({ ...IG, subject: HEADROOM_MIN - 0.06, need: 458 });
    ok('and one meaningfully under it does', worse && worse.zoom < 1, JSON.stringify(worse));
  }

  // The scrim, measured off what the type actually ended up over.
  ok('a white wall in daylight gets a real scrim', scrimAlpha(0.85) > 0.3, `${scrimAlpha(0.85)}`);
  ok('a dim room gets almost none', scrimAlpha(0.03) <= 0.15, `${scrimAlpha(0.03)}`);
  ok('but never none at all, or the type looks like it landed there', scrimAlpha(0.0) >= 0.1);
  ok('the wash it asks for always clears the bar', 1.05 / (underScrim(0.85, scrimAlpha(0.85)) + 0.05) >= 3);
  ok('and it is bounded, because a slide is a photograph', scrimAlpha(1) <= 0.55);

  // The measurement runs in the page, which is what makes it reach every
  // caller — the deck, both single-slide redraws and the lab — rather than
  // only the ones that remembered to ask for it.
  const measured = renderBrickSlideHtml(
    { nameHe: 'סחלב', emoji: '🌸', lines: [], image: { src: 'data:image/png;base64,iVBOR' } },
    { size: 'instagram' }
  );
  ok('a slide measures its own photograph', measured.includes('__slideReady'));
  ok('and carries the two layers that let it be moved', measured.includes('class="backdrop"') && measured.includes('class="wallfill"'));
  ok('the fit knows which frame it is in', measured.includes('"frameH":1350'));
  ok(
    'a slide with no photograph has nothing to measure and says so',
    !renderBrickSlideHtml({ nameHe: 'סחלב', lines: [], image: null }, { size: 'instagram' }).includes('class="backdrop"')
  );
  ok(
    'the end card is left alone, since its picture is washed out anyway',
    renderBrickSlideHtml({ image: { src: 'data:image/png;base64,iVBOR' } }, { size: 'tiktok', end: true }).includes(
      '"enabled":false'
    )
  );
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
  ok('and there is something to ask for a comment with', cfg.caption.engage.length > 0);
  // Engagement bait is demoted by both platforms, and we could not honour it
  // anyway — nothing here replies, DMs or sends a link back.
  ok(
    'no ask promises a reply or a DM in exchange',
    cfg.caption.engage.every((l) => !/(אשלח|בפרטי|בדי'אם|ד''מ|תקבלו לינק)/.test(l)),
    cfg.caption.engage.find((l) => /(אשלח|בפרטי|תקבלו לינק)/.test(l)) || 'clean'
  );
  ok('and something to give as a reason to follow', cfg.caption.follow.length > 0);
  // The emoji budget is three — hook, comment ask, cta pin — and the follow
  // line is the one that reads best without one. See the note in the config.
  ok(
    'no reason to follow spends a fourth emoji',
    cfg.caption.follow.every((l) => !/\p{Extended_Pictographic}/u.test(l)),
    cfg.caption.follow.find((l) => /\p{Extended_Pictographic}/u.test(l)) || 'clean'
  );
  ok('the closing frame gives a reason to follow too', cfg.endCard.followHe.length > 0);
  // A tag or a save is a fine ask and not this one. This line buys a reply in
  // the thread, so every entry has to actually ask for one.
  ok(
    'every ask asks for a comment, not a tag or a save',
    cfg.caption.engage.every((l) => /תגיבו/.test(l)),
    cfg.caption.engage.find((l) => !/תגיבו/.test(l)) || 'clean'
  );
  ok('the cover pool is not empty', cfg.covers.lines.length > 0);
  ok('there are enough tags to draw the configured number', cfg.hashtags.broad.length >= cfg.hashtags.broadCount);
  ok('and enough niche ones', cfg.hashtags.niche.length >= cfg.hashtags.nicheCount);
  ok('the deck size sits inside its own bounds', cfg.deck.minSlides <= cfg.deck.slides && cfg.deck.slides <= cfg.deck.maxSlides);
}

/* -------------------------------------------------------------------------- */
group('who may sign in to the website');

// The bot's Telegram lock is a one-line comparison against OWNER_ID and it is
// tested by being impossible to get wrong. The website's door is not: it hashes,
// it signs, it expires, and every one of those has a way to be subtly useless.
{
  const { hashPassword, checkPassword, checkUsername, createAdmin, setPassword, setRole, removeAdmin, signIn, session, signOutEveryone, can, ROLES } =
    await import('../src/web/auth.js');

  ok('a hash is not the password', hashPassword('correct horse battery').hash.includes('correct') === false);
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  ok('the same password twice gives different hashes (per-account salt)', a.hash !== b.hash);

  ok('a short password is refused', Boolean(checkPassword('short')));
  eq('twelve characters is the floor', checkPassword('123456789012'), null);
  ok('a username with a space is refused', Boolean(checkUsername('two words')));
  ok('a username in Hebrew is refused', Boolean(checkUsername('נתנאל')));
  eq('a plain latin username is fine', checkUsername('netanel'), null);

  const first = createAdmin({ username: 'Netanel', password: 'a-good-long-password', name: 'נתנאל', role: 'viewer' });
  eq('a username is stored lowercased', first.username, 'netanel');
  // The account that cannot manage accounts cannot add the second one, and there
  // is no sign-up page to fall back to.
  eq('the FIRST account is an owner whatever was asked for', first.role, 'owner');
  ok('and the record handed back carries no hash', !('hash' in first) && !('salt' in first));

  const second = createAdmin({ username: 'shai', password: 'another-long-password', role: 'admin' });
  eq('the second account gets the role it asked for', second.role, 'admin');
  throws('the same username cannot be taken twice', () => createAdmin({ username: 'shai', password: 'yet-another-password' }));
  throws('a weak password is refused at creation', () => createAdmin({ username: 'weak', password: 'abc' }));

  // Capabilities are checked by name rather than by "is not a viewer", so that
  // adding one means naming who gets it.
  ok('a viewer may read', can('viewer', 'read'));
  ok('a viewer may NOT act', !can('viewer', 'act'));
  ok('an admin may act', can('admin', 'act'));
  ok('an admin may NOT manage accounts', !can('admin', 'accounts'));
  ok('an owner may', can('owner', 'accounts'));
  ok('every role is one of the three', ROLES.length === 3);

  const signed = await signIn('NETANEL', 'a-good-long-password');
  ok('signing in is case-insensitive on the username', signed.admin.username === 'netanel');
  const live = session(signed.token);
  ok('a fresh cookie resolves to the account', live?.username === 'netanel');
  eq('and carries the role', live.role, 'owner');
  ok('and a CSRF token', Boolean(live.csrf));

  ok('a tampered cookie is refused', session(`${signed.token}x`) === null);
  ok('a cookie with no signature is refused', session(signed.token.split('.')[0]) === null);
  ok('rubbish is refused', session('nonsense') === null);
  ok('nothing is refused', session('') === null && session(null) === null);

  // The forged cookie: a valid-looking body with a signature that was never
  // issued. This is the one a naive implementation lets through by decoding the
  // claims before checking the MAC.
  const forged = `${Buffer.from(JSON.stringify({ id: signed.admin.id, exp: Date.now() + 1e6, iat: Date.now() })).toString('base64url')}.deadbeef`;
  ok('a forged cookie is refused', session(forged) === null);

  let failed = null;
  await signIn('netanel', 'wrong password entirely').catch((e) => (failed = e));
  ok('a wrong password is refused', Boolean(failed));
  ok('and the refusal does not say which half was wrong', !/סיסמה שגויה$/.test(failed?.message || ''));

  // Resetting a password must also mean "end that person's sessions", because
  // that is what somebody resetting a password believes they are doing.
  setPassword('netanel', 'a-different-long-password');
  ok('changing a password invalidates the sessions it was minted before', session(signed.token) === null);
  const again = await signIn('netanel', 'a-different-long-password');
  ok('and the new password works', session(again.token)?.username === 'netanel');

  throws('the only owner cannot be demoted', () => setRole('netanel', 'admin'));
  throws('the only owner cannot be removed', () => removeAdmin('netanel'));
  setRole('shai', 'owner');
  ok('with a second owner, the first can be demoted', Boolean(setRole('netanel', 'admin')));

  signOutEveryone();
  ok('signing everybody out invalidates every open session', session(again.token) === null);
}

/* -------------------------------------------------------------------------- */
group('the schedule reads, rather than captures');

{
  const store = await import('../src/store.js');

  // The whole point: these used to be destructured at module load, so a change
  // took effect at the next deploy.
  const before = store.setting('POST_INTERVAL_MINUTES');
  ok('a dial has a value with nothing stored', Number.isFinite(before));
  eq('setting one returns what was stored', store.setSetting('POST_INTERVAL_MINUTES', 90), 90);
  eq('and reading it back agrees', store.setting('POST_INTERVAL_MINUTES'), 90);

  throws('a value below the floor is refused', () => store.setSetting('POST_INTERVAL_MINUTES', 1));
  throws('a value above the ceiling is refused', () => store.setSetting('POST_INTERVAL_MINUTES', 99999));
  throws('a value that is not a number is refused', () => store.setSetting('POST_INTERVAL_MINUTES', 'soon'));
  throws('an unknown dial is refused', () => store.setSetting('TG_BOT_TOKEN', 'nice try'));

  const report = store.settingsReport().find((d) => d.key === 'POST_INTERVAL_MINUTES');
  eq('the report says where the value came from', report.source, 'stored');
  store.setSetting('POST_INTERVAL_MINUTES', null);
  eq('clearing a dial falls back', store.settingsReport().find((d) => d.key === 'POST_INTERVAL_MINUTES').source !== 'stored', true);

  // Clamped on READ rather than rejected, because a value that got in out of
  // range by some other route must not take the drip timer to NaN.
  ok('a dial is clamped on read, never NaN', Number.isFinite(store.setting('DECKS_PER_DAY')));
}

/* -------------------------------------------------------------------------- */
group('one action, two surfaces');

{
  const store = await import('../src/store.js');
  const ops = await import('../src/ops/marketing.js');
  const views = await import('../src/ops/views.js');
  const { detach: detachSurface } = await import('../src/ops/surface.js');
  // No Telegram in a test, which is the point of the surface being injected: the
  // whole approval path runs without a bot token and without pretending to have a
  // chat.
  detachSurface();

  const fakeDeck = (headline, targets = ['instagram']) => ({
    kind: 'deck',
    id: `test-${headline}`,
    headline,
    publishTargets: targets,
    tiktokDraft: targets.includes('tiktok'),
    deck: {
      subject: headline,
      hookHe: 'שער כלשהו',
      recipe: 'savings',
      slides: [{ nameHe: 'סט', productId: 'p1', emoji: '🧱', deal: { price: 100 } }],
      preview: [],
    },
  });

  const { key } = await ops.stage(fakeDeck('בדיקה'), { actor: { kind: 'web', name: 'טסט' } });
  eq('staging puts one item in front of somebody', store.stagingSize(), 1);
  eq('and the pending view can see it', views.pending().staged.length, 1);
  eq('with its headline', views.pending().staged[0].headline, 'בדיקה');

  const approved = await ops.approve(key, { actor: { kind: 'web', name: 'טסט' } });
  ok('approving succeeds', approved.ok);
  eq('and the post is now in the queue', store.queueSize(), 1);
  eq('and no longer waiting', store.stagingSize(), 0);

  // The race that matters. Two admins on one queue means a second tap on the same
  // card is normal, not exotic — takeStaging is atomic, so the second caller must
  // get "already handled" rather than a second publish.
  const twice = await ops.approve(key, { actor: { kind: 'telegram', name: 'שוב' } });
  ok('approving the same thing twice is refused', !twice.ok);
  eq('and says so plainly', twice.reason, 'gone');
  eq('the queue did not grow', store.queueSize(), 1);

  // Rejecting refunds the day's quota slot. Without that, three rejections at
  // breakfast ended the day: remaining hit zero and nothing could publish.
  const day = ops.localDay();
  const { key: key2 } = await ops.stage(fakeDeck('לדחייה'));
  store.noteStaged(day);
  const before = store.rejectedToday(day);
  await ops.reject(key2, { actor: { kind: 'web', name: 'טסט' } });
  eq('rejecting gives the day its quota slot back', store.rejectedToday(day), before + 1);

  eq('the queue view numbers from 1, the way the list is read', views.queue()[0]?.n, 1);
  ok('and names where it will actually go', views.queue()[0]?.targets.includes('instagram'));

  // Every action leaves a name behind, because there is now more than one person
  // who could have taken it.
  const trail = store.auditTrail({ limit: 20 });
  ok('the audit trail recorded the approval', trail.some((t) => t.action === 'approved'));
  ok('with who did it', trail.find((t) => t.action === 'approved')?.actor?.name === 'טסט');
  ok('and from which surface', trail.find((t) => t.action === 'approved')?.actor?.kind === 'web');
  eq('the trail is newest first', trail[0].ts >= trail[trail.length - 1].ts, true);

  eq('an actor is described with its surface', ops.describeActor({ kind: 'web', name: 'נתנאל' }), 'נתנאל · מהאתר');
  eq('the timer is not a person', ops.describeActor({ kind: 'timer' }), 'אוטומטי');

  store.clearQueue();
  store.clearStaging();
}

/* -------------------------------------------------------------------------- */
group('editing the copy cannot break the copy');

{
  const settings = await import('../src/ops/settings.js');
  const { brickConfig: reread, __reset } = await import('../src/brick/config.js');

  const original = settings.readRaw();
  ok('the current file can be read', original.length > 100);

  throws('a save that is not JSON is refused', () => settings.writeRaw('{ not json'));
  eq('and the file is untouched', settings.readRaw(), original);

  // The one that matters. This IS valid JSON, so a naive editor accepts it — and
  // src/brick/config.js throws on an empty caption pool, which means the next
  // build dies with no way to fix it from the page that broke it.
  const emptied = JSON.stringify({ ...JSON.parse(original), caption: { lines: [] } });
  throws('a save that is valid JSON but fails validation is refused', () => settings.writeRaw(emptied));
  eq('and the previous file was put back', settings.readRaw(), original);
  __reset();
  ok('so the config still loads after a rejected save', Boolean(reread().caption.lines.length));

  // A real change goes through, and takes effect without a restart — which is
  // the cache invalidation, and the thing most likely to be forgotten.
  const changed = JSON.parse(original);
  changed.labels = { ...changed.labels, saving: 'חוסכים' };
  const saved = settings.writeRaw(JSON.stringify(changed, null, 2));
  eq('a valid save is applied', saved.labels.saving, 'חוסכים');
  eq('and takes effect immediately, with no restart', reread().labels.saving, 'חוסכים');
  ok('and the previous version is kept to go back to', settings.readBackup() !== null);

  settings.writeRaw(settings.readBackup());
  eq('restoring the backup works', reread().labels.saving, JSON.parse(original).labels.saving);
}

/* -------------------------------------------------------------------------- */
group('jobs and the bus');

{
  const bus = await import('../src/ops/bus.js');
  const jobs = await import('../src/ops/jobs.js');
  jobs.__reset();

  const seen = [];
  const off = bus.subscribe((e) => seen.push(e.type));
  bus.emit('test:one', {});
  // A subscriber that throws must not unwind the action that emitted — by then
  // the store has usually already been written.
  const offBad = bus.subscribe(() => {
    throw new Error('a browser went away mid-write');
  });
  bus.emit('test:two', {});
  offBad();
  off();
  ok('subscribers hear events', seen.includes('test:one') && seen.includes('test:two'));
  ok('a throwing subscriber does not stop the emit', bus.lastId() >= 2);
  ok('and a client can catch up on what it missed', bus.since(0).length >= 2);

  const done = jobs.run('משהו', async (progress) => {
    progress('חצי דרך');
    return { ok: true, message: 'נגמר' };
  });
  eq('a job starts running', done.status, 'running');
  await new Promise((r) => setTimeout(r, 30));
  eq('and finishes', jobs.get(done.id)?.status, 'done');
  eq('carrying its result', jobs.get(done.id)?.result?.message, 'נגמר');

  const boom = jobs.run('נשבר', async () => {
    throw new Error('נפל');
  });
  await new Promise((r) => setTimeout(r, 30));
  eq('a failed job is recorded as failed', jobs.get(boom.id)?.status, 'failed');
  eq('with the reason', jobs.get(boom.id)?.error, 'נפל');

  // A synchronous throw has to land in the same place. On the Telegram path the
  // caller is an update handler, and a throw that escapes it restarts the process.
  const sync = jobs.run('נשבר מיד', () => {
    throw new Error('מיד');
  });
  await new Promise((r) => setTimeout(r, 30));
  eq('a job that throws synchronously fails rather than escaping', jobs.get(sync.id)?.status, 'failed');
  eq('nothing is left running', jobs.running(), 0);
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
