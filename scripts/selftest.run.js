import { loadEnv } from '../src/env.js';
loadEnv();

import { primaryAuthority, registry } from '../src/sources/index.js';
import { flightPriceGuard, verifyEvidence, verifyDraftText, minSourceChars, noDecimalsUpFront, noRepeatedWord, headlineLength, captionLength, fillerAdjective, rhetoricalOpening, RejectedError } from '../src/verify.js';
import { safeStem } from '../src/render/index.js';
import { htmlToText, stripBoilerplate, decodeEntities, fetchReadable, FetchError } from '../src/fetchPage.js';
import { parseFeed } from '../src/sources/rss.js';
import { monthlyNormals, verdictFor } from '../src/sources/climate.js';
import { quotaBlock, placeOverCap, describeRepeats } from '../src/pillars.js';
import { deckRepeats } from '../src/deck/candidate.js';
import { scoreItem, rank } from '../src/score.js';
import * as store from '../src/store.js';
import { candidateId, tripGap } from '../src/candidate.js';
import { renderHtml, LAYOUTS, PHOTO_LAYOUTS, isPhotoLayout, SCRIM_FALLBACK } from '../src/render/templates.js';
import { assertGenericAiPrompt, ImagePolicyError, imageQueries } from '../src/images.js';
import { approvalMessage, instagramCaption, tiktokCaption, deckCaption, deckTiktokCaption, evidenceReport, deckApprovalMessage } from '../src/format.js';
import { renderSlideHtml, SIZES, sizeClass, INK_LUMINANCE, FACES } from '../src/render/deckTemplates.js';
import { renderInstagramSlideHtml } from '../src/render/deckInstagram.js';
import { sizesFor } from '../src/deck/candidate.js';
import { normaliseIdea } from '../src/deck/ideas.js';
import { readFileSync } from 'node:fs';
import { FIELDS_BY_KIND } from '../src/deck/fields.js';
import { cinematicQueries } from '../src/images/curate.js';
import { countryMismatch } from '../src/deck/region.js';
import { SCRIM_INK } from '../src/render/theme.js';
import {
  lengthValue,
  yearValue,
  factsFor,
  countryFor,
  applyCountryVisibility,
  enoughFor,
  WIKIDATA_FIELDS,
} from '../src/deck/facts.js';
import { flagFor, COUNTRIES } from '../src/deck/flags.js';
import { emojiDataUri } from '../src/render/emojiArt.js';
import { isHebrew } from '../src/deck/hebrew.js';
import { parseLocally } from '../src/deck/request.js';
import { rotationFor, oneClause, emphasisFrom, COVER_SHAPES, COVER_VOICES } from '../src/deck/ideas.js';
import { deckPlace, namesPlace, REGIONS } from '../src/deck/region.js';
import { __test as photoTest, scrimAlpha, underScrim } from '../src/render/photo.js';
import { deckId } from '../src/deck/candidate.js';
import { sameSite } from '../src/search.js';
import { authorityDomains, KINDS, subjectEn } from '../src/sources/places.js';
import { pick, CATEGORY_HE, canonicalKind } from '../src/sources/tiyulplus.js';
import { keepByName } from '../src/deck/shape.js';
import {
  quietAlert,
  targetAbandoned as notifyTargetAbandoned,
  publishWaitingForSetup,
  published,
  withDetail,
} from '../src/notify.js';
import { describeError, InstagramError, isPlatformLimit as isPlatformLimitInstagram } from '../src/publish/instagram.js';
import { publishTargets, targetsForKind, allowedForKind, liveTargets } from '../src/publish/targets.js';
import {
  defaultPrivacy,
  nextPrivacy,
  privacyHe,
  publishTikTok,
  tiktokConfigured,
  describeError as describeTikTokError,
  isCardLevel as isCardLevelTikTok,
  isConfigProblem,
  missingScopes,
  scopeForMode,
  SCOPES as TK_SCOPES,
  TikTokError,
} from '../src/publish/tiktok.js';
import { codeFrom } from './tiktok-token.js';
import { hyphensOnly, stripEmoji, capHashtags, normalise } from '../src/draft.js';

// Offline behaviour checks. No network, no credentials, no Telegram.
//
// Everything here is a rule from the brief that would be expensive to get wrong
// quietly — the allowlist boundary, the fare guard, claim verification, the
// font guard. These started life as one-off shell commands while building,
// which meant they proved something once and then evaporated. This is the same
// checks, kept.
//
//   npm test

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
  } else {
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
    ok(name, !reason || e.reason === reason || e instanceof ImagePolicyError, `threw ${e.reason || e.name}`);
  }
}

const group = (title) => console.log(`\n${title}`);

/* -------------------------------------------------------------------------- */
group('allowlist — "no source, no candidate"');

for (const [url, want, why] of [
  ['https://www.gov.uk/foreign-travel-advice/japan', true, 'FCDO'],
  ['https://whc.unesco.org/en/news/1', true, 'UNESCO subdomain'],
  ['https://www.nps.gov/x', true, 'US federal'],
  ['https://cnn.com/travel', false, 'news outlet'],
  ['https://evil-gov.uk/x', false, 'suffix must match on a label boundary'],
  ['https://gov.uk.attacker.com/x', false, 'prefix, not suffix'],
  ['https://notunesco.org/x', false, 'not a subdomain of unesco.org'],
  ['javascript:alert(1)', false, 'non-http scheme'],
  ['not a url', false, 'unparseable'],
]) {
  eq(`${want ? 'accepts' : 'rejects'} ${url} (${why})`, Boolean(primaryAuthority(url)), want);
}

/* -------------------------------------------------------------------------- */
group('fare guard — flight prices out of scope in v1, other costs fine');

for (const [text, want] of [
  ['טיסה לאתונה החל מ-249 שקל', true],
  ['צ׳רטר ישיר, 1,200 ש״ח הלוך ושוב', true],
  ['כרטיס טיסה עולה 1200 ש"ח', true],
  ['round-trip fares from $420', true],
  ['כרטיס הכניסה לאלהמברה עולה 19 יורו', false],
  ['הכניסה לפארק חינם, החניה 8 יורו ליום', false],
  ['ארוחת ערב טובה בעיר: 120 ש״ח לזוג', false],
  ['הטיסה נוחתת ב-06:30 בבוקר', false],
]) {
  eq(`${want ? 'blocks' : 'allows'}: ${text}`, Boolean(flightPriceGuard(text)), want);
}

throws(
  'verifyDraftText rejects a draft carrying a fare',
  () => verifyDraftText({ headline: 'טיסות זולות', caption: 'כרטיס טיסה החל מ-199 שקל הלוך ושוב לאתונה' }),
  'flight_price_out_of_scope'
);

/* -------------------------------------------------------------------------- */
group('claim verification — quotes must be verbatim');

const SRC = 'The new Entry/Exit System starts on 12 October 2026 for all non-EU nationals crossing an external border.';

ok(
  'accepts a verbatim quote',
  (() => {
    try {
      return verifyEvidence({ evidence: [{ claim: 'x', quote: 'starts on 12 October 2026 for all non-EU nationals' }] }, SRC);
    } catch {
      return false;
    }
  })()
);
ok(
  'accepts a quote differing only in whitespace and punctuation',
  (() => {
    try {
      return verifyEvidence({ evidence: [{ claim: 'x', quote: 'starts  on 12 October, 2026 — for all non-EU nationals' }] }, SRC);
    } catch {
      return false;
    }
  })()
);
throws('rejects a paraphrase', () => verifyEvidence({ evidence: [{ claim: 'x', quote: 'begins in October 2026 for non-EU travellers' }] }, SRC), 'unsupported_claim');
throws('rejects a quote too short to be evidence', () => verifyEvidence({ evidence: [{ claim: 'x', quote: 'the new' }] }, SRC), 'unsupported_claim');
throws('rejects a draft that cites nothing', () => verifyEvidence({ evidence: [] }, SRC), 'no_evidence');

// Regression: the minimum quote length was a WORD count, and Japanese does not
// separate words with spaces. Every Japanese quote counted as one word and was
// rejected as too short, which made JNTO - one of four enabled sources -
// structurally unable to produce a candidate.
const JA_SRC = '2026年8月21日、最大44名対応の箸作り体験を渋谷で開始しました。';
ok(
  'accepts a substantial Japanese quote despite it having no spaces',
  (() => {
    try {
      return verifyEvidence({ evidence: [{ claim: 'x', quote: '最大44名対応の箸作り体験を渋谷で開始' }] }, JA_SRC);
    } catch {
      return false;
    }
  })()
);
ok(
  'accepts a dense 8-character Japanese quote as evidence',
  (() => { try { return verifyEvidence({ evidence: [{ claim: 'x', quote: '前年同月比0.1%増' }] }, '訪日外客数は前年同月比0.1%増となった。'); } catch { return false; } })()
);
throws(
  'still rejects a Japanese quote that is genuinely too short',
  () => verifyEvidence({ evidence: [{ claim: 'x', quote: '渋谷で' }] }, JA_SRC),
  'unsupported_claim'
);

/* -------------------------------------------------------------------------- */
group('source text extraction — boilerplate must not become citable evidence');

const HTML = `<html><body>
  <nav><a href="/">Home</a><a href="/x">Advice</a></nav>
  <div>We use some essential cookies to make this website work.</div>
  <div>We also use cookies set by other sites to help us deliver content.</div>
  <p>Skip to main content</p>
  <p>Latest update: biometric registration begins at external borders.</p>
  <p>Entry rules changed on 12 October 2026.</p>
  <footer>All content is available under the Open Government Licence v3.0</footer>
</body></html>`;

const text = htmlToText(HTML);
ok('keeps the substantive lines', text.includes('biometric registration begins') && text.includes('12 October 2026'));
ok('drops the cookie-consent lines', !/cookie/i.test(text), text.slice(0, 120));
ok('drops <nav> and <footer> wholesale', !text.includes('Open Government Licence') && !text.includes('Skip to main content'));
eq('decodes entities', decodeEntities('caf&eacute; &amp; b&#97;r'), 'café & bar');
ok(
  'refuses to gut a page it misreads',
  stripBoilerplate(['We use cookies', 'Search']).length === 2,
  'a page that is almost all boilerplate should pass through untouched rather than be emptied'
);

/* -------------------------------------------------------------------------- */
group('the 403 browser fallback — which failures are worth a second request');

// globalThis.fetch is stubbed rather than hitting the network, so this stays an
// offline check. It deliberately never exercises the Playwright path: launching
// Chromium to prove a routing decision would make `npm test` need a browser.
// The browser fetch itself was verified against UNESCO's live pages.
{
  const realFetch = globalThis.fetch;
  const stub = (status) => async () => ({
    ok: status < 400,
    status,
    url: 'https://whc.unesco.org/en/news/1',
    headers: new Map([['content-type', 'text/html']]),
    text: async () => '<html><body><p>hello</p></body></html>',
  });
  const grab = async (fn) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  const prev = process.env.FETCH_BROWSER_FALLBACK;
  try {
    process.env.FETCH_BROWSER_FALLBACK = '0';

    globalThis.fetch = stub(404);
    const notFound = await grab(() => fetchReadable('https://whc.unesco.org/en/news/1'));
    ok('a 404 is a FetchError', notFound instanceof FetchError, String(notFound));
    eq('the status rides along on the error', notFound?.status, 404);
    ok('a 404 is never retried through a browser', notFound?.browserRetry === undefined, 'a dead link is not a bot wall');

    globalThis.fetch = stub(429);
    const rateLimited = await grab(() => fetchReadable('https://whc.unesco.org/en/news/1'));
    ok('a 429 is not retried either', rateLimited?.browserRetry === undefined, 'asking again does not fix a rate limit');

    globalThis.fetch = stub(403);
    const blocked = await grab(() => fetchReadable('https://whc.unesco.org/en/news/1'));
    eq('a 403 still reports 403', blocked?.status, 403);
    ok(
      'the kill switch stops the browser being reached for at all',
      blocked?.browserRetry === undefined,
      'FETCH_BROWSER_FALLBACK=0 must keep the offline suite off Chromium'
    );

    globalThis.fetch = stub(200);
    const fine = await fetchReadable('https://whc.unesco.org/en/news/1');
    eq('a 200 goes through the ordinary path', fine.text.trim(), 'hello');
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.FETCH_BROWSER_FALLBACK;
    else process.env.FETCH_BROWSER_FALLBACK = prev;
  }
}

/* -------------------------------------------------------------------------- */
group('feed parsing — RSS and Atom through one adapter');

const src = { id: 't', name: 'T', authority: 'government', lang: 'en', pillars: ['entry'] };

const rss = parseFeed(
  `<?xml version="1.0"?><rss version="2.0"><channel><item>
     <title>Entry rules change</title><link>https://www.gov.uk/a</link>
     <description>&lt;p&gt;From &lt;b&gt;October&lt;/b&gt;.&lt;/p&gt;</description>
     <pubDate>Wed, 20 Aug 2026 10:00:00 GMT</pubDate>
   </item></channel></rss>`,
  src
);
eq('RSS: one item', rss.length, 1);
eq('RSS: title', rss[0].title, 'Entry rules change');
eq('RSS: link', rss[0].url, 'https://www.gov.uk/a');
eq('RSS: escaped HTML in description is unwrapped', rss[0].summary, 'From October.');
ok('RSS: date parsed to ISO', rss[0].publishedAt?.startsWith('2026-08-20'), rss[0].publishedAt);

const atom = parseFeed(
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
     <title>Norway</title>
     <link rel="alternate" href="https://www.gov.uk/b"/>
     <summary>Updated advice.</summary>
     <updated>2026-08-19T09:00:00Z</updated>
   </entry></feed>`,
  src
);
eq('Atom: one item', atom.length, 1);
eq('Atom: href pulled from the alternate link element', atom[0].url, 'https://www.gov.uk/b');
ok('Atom: date parsed', atom[0].publishedAt?.startsWith('2026-08-19'), atom[0].publishedAt);
eq('an entry with no link is dropped', parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>x</title></entry></feed>', src).length, 0);

// urlIncludes — one feed carrying two kinds of thing.
//
// JNTO publishes travel news and its corporate wire down the same pipe. The
// junk was always rejected downstream as too thin, so this is about not letting
// fourteen procurement notices occupy the ranked list a real candidate needs.
const mixedFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
   <item><title>Tool for inbound travellers</title><link>https://www.jnto.go.jp/news/press/_1.html</link><description>real</description></item>
   <item><title>Procurement notice</title><link>https://www.jnto.go.jp/news/info/post_53.html</link><description>stub</description></item>
   <item><title>Trade show exhibitors wanted</title><link>https://www.jnto.go.jp/news/expo-seminar/_925.html</link><description>stub</description></item>
 </channel></rss>`;
const jntoSrc = { ...src, id: 'jnto-news', urlIncludes: ['/news/press/'] };
eq('urlIncludes: keeps only the declared path', parseFeed(mixedFeed, jntoSrc).length, 1);
eq('urlIncludes: and it is the right one', parseFeed(mixedFeed, jntoSrc)[0].title, 'Tool for inbound travellers');
eq('a source with no urlIncludes is unfiltered', parseFeed(mixedFeed, src).length, 3);
eq(
  'urlIncludes accepts more than one fragment',
  parseFeed(mixedFeed, { ...src, urlIncludes: ['/news/press/', '/news/info/'] }).length,
  2
);
// The registry is data, so the filter has to survive a round trip through it.
ok(
  'the live JNTO entry declares the filter',
  (registry().sources.find((s) => s.id === 'jnto-news')?.urlIncludes || []).includes('/news/press/'),
  'sources.json lost urlIncludes'
);

// dedupeBy: 'url+updated' — a living document at a permanent URL.
//
// FCDO publishes one page per country and re-surfaces it whenever it is
// revised. Under URL-derived identity the first sighting of a country was the
// only one for SEEN_TTL_DAYS, so every later revision was skipped in silence.
const advisory = (updated) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
     <title>Italy travel advice</title>
     <link rel="alternate" href="https://www.gov.uk/foreign-travel-advice/italy"/>
     <summary>Entry requirements updated.</summary>
     <updated>${updated}</updated>
   </entry></feed>`;
const fcdoSrc = { ...src, id: 'fcdo-travel-advice', dedupeBy: 'url+updated' };
const sept11 = parseFeed(advisory('2026-09-11T10:00:00Z'), fcdoSrc)[0];
const sept14 = parseFeed(advisory('2026-09-14T14:40:00Z'), fcdoSrc)[0];

eq('a re-read of the same revision is the same candidate', candidateId(parseFeed(advisory('2026-09-11T10:00:00Z'), fcdoSrc)[0]), candidateId(sept11));
ok('a revised advisory at the same URL is a new candidate', candidateId(sept11) !== candidateId(sept14), 'the revision would have been skipped as already-seen');

// The opposite case, which is why this is declared per source rather than on
// by default: a one-time article must not come back round on an edit.
const article = { ...src, id: 'nasa-earth-observatory' };
eq(
  'a source without the flag still keys on the URL alone',
  candidateId(parseFeed(advisory('2026-09-11T10:00:00Z'), article)[0]),
  candidateId(parseFeed(advisory('2026-09-14T14:40:00Z'), article)[0])
);
ok(
  'the live FCDO entry declares it',
  registry().sources.find((s) => s.id === 'fcdo-travel-advice')?.dedupeBy === 'url+updated',
  'sources.json lost dedupeBy'
);

/* -------------------------------------------------------------------------- */
group('climate — monthly normals and month verdicts');

const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] };
for (const y of ['2023', '2024']) {
  for (let d = 1; d <= 28; d++) {
    daily.time.push(`${y}-07-${String(d).padStart(2, '0')}`);
    daily.temperature_2m_max.push(36);
    daily.temperature_2m_min.push(24);
    daily.precipitation_sum.push(0);
  }
}
const normals = monthlyNormals(daily);
eq('July mean max computed', normals[6].meanMax, 36);
eq('a month with no data stays null', normals[0].meanMax, null);
eq('36C in July is "avoid"', verdictFor(normals[6]), 'avoid');
eq('22C and dry is "good"', verdictFor({ meanMax: 22, wetDaysPerMonth: 4 }), 'good');
eq('22C but very wet is "avoid"', verdictFor({ meanMax: 22, wetDaysPerMonth: 18 }), 'avoid');
eq('no data is "unknown"', verdictFor({ meanMax: null }), 'unknown');

/* -------------------------------------------------------------------------- */
group('topic quotas — kosher is a thread, not the theme');

const hist = (n, tagged) =>
  Array.from({ length: n }, (_, i) => ({ pillar: 'inCity', tags: i < tagged ? ['kosher'] : [] }));

ok('below the sample floor nothing is capped', quotaBlock({ pillar: 'inCity', tags: ['kosher'] }, hist(4, 4)) === null);
ok('kosher blocked once it is over its share', quotaBlock({ pillar: 'timing', tags: ['kosher'] }, hist(20, 5)) !== null);
ok('kosher allowed while under its share', quotaBlock({ pillar: 'timing', tags: ['kosher'] }, hist(20, 1)) === null);
ok('a single pillar cannot take over', quotaBlock({ pillar: 'inCity', tags: [] }, hist(20, 0)) !== null);
ok('an untagged post in a fresh pillar passes', quotaBlock({ pillar: 'route', tags: [] }, hist(20, 0)) === null);

// The share that was missing. Every volcano report files as `conditions` — so
// does every closure, reopening and season — so one feed can fill that pillar's
// entire 40% while each individual post is filed perfectly correctly. Measured
// against the live registry: 22 of the 65 items gathered on an ordinary day were
// the Smithsonian's weekly volcano report, and the account read as one.
const srcHist = (n, fromWire) =>
  Array.from({ length: n }, (_, i) => ({
    pillar: i % 2 ? 'inCity' : 'timing',
    tags: [],
    sourceId: i < fromWire ? 'smithsonian-volcano' : `other-${i}`,
  }));

ok('one source cannot become the feed', quotaBlock({ pillar: 'route', tags: [], sourceId: 'smithsonian-volcano' }, srcHist(20, 6)) !== null);
ok('a source under its share still publishes', quotaBlock({ pillar: 'route', tags: [], sourceId: 'smithsonian-volcano' }, srcHist(20, 3)) === null);
ok('a candidate with no source is not capped by one', quotaBlock({ pillar: 'route', tags: [] }, srcHist(20, 20)) === null);
// Records written before sourceId was stored count toward nobody's share, so the
// cap loosens for a window rather than blocking real posts over a missing field.
ok('history from before the field existed blocks nothing', quotaBlock({ pillar: 'route', tags: [], sourceId: 'smithsonian-volcano' }, hist(20, 0)) === null);

// The axis none of the three caps above could see. A feed can satisfy every one
// of them and still be entirely about one city: decks file as pillar `day` with
// no sourceId, so only the 40% pillar cap could bite a run of Kyoto, and it did
// not. This is the cap that measures where a post is actually about.
const placeHist = (n, atPlace, place = 'Kyoto') =>
  Array.from({ length: n }, (_, i) => ({
    pillar: i % 2 ? 'inCity' : 'timing',
    tags: [],
    place: i < atPlace ? place : `Elsewhere-${i}`,
  }));

ok('one city cannot become the feed', quotaBlock({ pillar: 'route', tags: [], place: 'Kyoto' }, placeHist(20, 6)) !== null);
ok('a city under its share still publishes', quotaBlock({ pillar: 'route', tags: [], place: 'Kyoto' }, placeHist(20, 2)) === null);
ok('a candidate with no place is not capped by one', quotaBlock({ pillar: 'route', tags: [] }, placeHist(20, 20)) === null);
// Case and stray space are the same city; nothing beyond that is guessed at,
// because merging "Dolomites" into "Italian Dolomites" would cap two genuinely
// different destinations as one.
ok('case and space do not defeat the cap', placeOverCap('  kyoto ', placeHist(20, 6)) !== null);
ok('a different city is a different bucket', placeOverCap('Vienna', placeHist(20, 20)) === null);
// Same forgiveness the source cap gets: rows written before `place` existed
// count toward nobody's share rather than blocking real posts over a field that
// was never written.
ok('history from before the field existed blocks nothing', placeOverCap('Kyoto', hist(20, 0)) === null);
ok('below the sample floor nothing is capped', placeOverCap('Kyoto', placeHist(4, 4)) === null);

// A streak is not a share, and the place streak was measured by nothing at all.
const runHist = (places) => places.map((place) => ({ pillar: 'day', tags: [], place }));

ok(
  'three about one city in a row is said out loud',
  describeRepeats({ pillar: 'day', tags: [], place: 'Kyoto' }, runHist(['Kyoto', 'Kyoto', 'Lisbon'])).some((n) =>
    n.includes('Kyoto')
  )
);
ok(
  'a single previous post about it is not a streak',
  !describeRepeats({ pillar: 'day', tags: [], place: 'Kyoto' }, runHist(['Kyoto', 'Lisbon', 'Porto'])).some((n) =>
    n.includes('Kyoto')
  )
);
ok(
  'the streak is broken by anywhere else',
  !describeRepeats({ pillar: 'day', tags: [], place: 'Kyoto' }, runHist(['Lisbon', 'Kyoto', 'Kyoto'])).some((n) =>
    n.includes('Kyoto')
  )
);

// The gap that let the run through: deckTopic is "<where> · <category>", so
// Kyoto temples then Kyoto food then Kyoto gardens is three different topics.
// The topic run breaks at the first change and reports nothing, while the feed
// reads as three Kyoto posts running — which it is.
const kyotoDeck = { where: 'Kyoto', category: 'garden', slides: [] };
const mixedKyoto = [
  { topic: 'Kyoto · food', place: 'Kyoto' },
  { topic: 'Kyoto · temple', place: 'Kyoto' },
  { topic: 'Lisbon · city', place: 'Lisbon' },
];
eq('the topic run sees nothing across categories', deckRepeats({ ...kyotoDeck }, mixedKyoto).filter((n) => n.includes('חוזר על')).length, 0);
ok('but the place run catches it', deckRepeats({ ...kyotoDeck }, mixedKyoto).some((n) => n.includes('אותו מקום')));
// Decks never reach quotaBlock, so for them saying it IS the intervention.
ok(
  'a deck over its place share says so',
  deckRepeats({ ...kyotoDeck }, placeHist(20, 6)).some((n) => n.includes('share'))
);
ok('a deck about somewhere fresh says nothing', deckRepeats({ where: 'Porto', category: 'city', slides: [] }, mixedKyoto).length === 0);

/* -------------------------------------------------------------------------- */
group('what the idea prompt remembers — the list that was twelve hashes');

// The bug this guards, exactly: recordPublished never accepted a `headline`, so
// `p.headline || p.id` fell through to a sha1 on every row and the /deck prompt
// asked the model not to repeat twelve hex strings. With no readable memory it
// returned its prior every run, and for "beautiful travel slideshow" that prior
// is Kyoto — which is how a feed meant to span the world became one city.
const titleHist = [
  { headline: 'המקדשים והארמונות הכי יפים ביפן', topic: 'Kyoto · temple', place: 'Kyoto' },
  { headline: null, topic: 'Vienna · city', place: 'Vienna' },
  { headline: 'הרים באיטליה', topic: null, place: null },
];

eq(
  'a headline is shown with its place',
  store.recentTitles({ history: titleHist })[0],
  'המקדשים והארמונות הכי יפים ביפן (Kyoto)'
);
eq('a row with no headline falls back to its topic', store.recentTitles({ history: titleHist })[1], 'Vienna · city');
eq('a headline with no place is still readable', store.recentTitles({ history: titleHist })[2], 'הרים באיטליה');
ok(
  'nothing the model cannot read reaches the prompt',
  store.recentTitles({ history: titleHist }).every((t) => !/^[0-9a-f]{12}$/.test(t))
);
// Rows written before these fields existed are dropped, not padded into the
// list as empty strings — a short true list beats a long meaningless one.
eq('legacy rows drop out entirely', store.recentTitles({ history: [{ ts: 1, id: 'a3f9c1b2d4e5' }] }).length, 0);
eq('the list is capped', store.recentTitles({ history: Array.from({ length: 40 }, () => titleHist[0]) }).length, 12);

/* -------------------------------------------------------------------------- */
group('deck proposals — the text stage, before anything is built');

// A deck is an idea call, a search and a drafting call per place, then twelve
// renders. All of it used to happen before you had seen anything, so a deck you
// did not want cost the whole build and was rejected at the end of it. The
// proposal is the same decision taken while it is still one message.
const propIdea = { titleHe: 'המקדשים של קיוטו', where: 'Kyoto', kind: 'temple', want: 5, angleHe: 'מה פתוח בחורף' };
const propKey = store.addProposal({ idea: propIdea, alternatives: [{ where: 'Nara', kind: 'temple' }], chatId: 42 });

eq('a proposal round-trips', store.getProposal(propKey).idea.where, 'Kyoto');
ok('and is stamped with when it was proposed', typeof store.getProposal(propKey).proposedAt === 'number');

// Revision replaces the idea and nothing else: the fallbacks were generated in
// the same call and are still the right things to try if the build comes up dry.
store.updateProposal(propKey, { idea: { ...propIdea, where: 'Osaka' } });
eq('a revision moves the idea', store.getProposal(propKey).idea.where, 'Osaka');
eq('and keeps the alternatives', store.getProposal(propKey).alternatives.length, 1);
eq('and keeps the chat it was proposed in', store.getProposal(propKey).chatId, 42);

// Keyed per proposal, never per chat — the same lesson pendingEdit records.
const propKey2 = store.addProposal({ idea: { ...propIdea, where: 'Lisbon' }, chatId: 42 });
ok('two proposals do not collide', store.getProposal(propKey).idea.where !== store.getProposal(propKey2).idea.where);

// Building consumes it, so a second tap on a message still showing its buttons
// finds nothing rather than building the same deck twice.
store.clearProposal(propKey);
eq('building consumes the proposal', store.getProposal(propKey), null);

// The marker that splits the two reply paths. Both route through the same
// prompt-id lookup; only `kind` says whether the reply is an instruction for an
// idea or a replacement headline for a rendered card.
store.setPendingEdit(propKey2, { kind: 'idea', chatId: 42, promptMessageId: 777 });
eq('a reply routes to its own proposal', store.findPendingEditByPrompt(777), propKey2);
eq('and carries the marker that says which stage it is', store.getPendingEdit(propKey2).kind, 'idea');
eq('a reply to anything else routes nowhere', store.findPendingEditByPrompt(999), null);

// The drip alternates kinds. Approve five decks and then five cards and a
// plain FIFO posts five slideshows in a row, then five news cards — which
// reads as two accounts taking turns rather than one feed.
const kindTag = (c) => (c.kind === 'deck' ? 'D' : 'C') + c.n;
const drainQueue = () => {
  const out = [];
  for (;;) {
    const i = store.dequeue();
    if (!i) break;
    out.push(kindTag(i));
  }
  return out.join(' ');
};

for (let n = 1; n <= 3; n++) store.enqueue({ kind: 'deck', n });
for (let n = 1; n <= 3; n++) store.enqueue({ kind: 'card', n });
eq('the list shows the running order, not the array', store.queuedItems().map(kindTag).join(' '), 'D1 C1 D2 C2 D3 C3');
eq('and that is the order they publish in', drainQueue(), 'D1 C1 D2 C2 D3 C3');

// Alternation is a preference about ORDER and never a reason to hold a post
// back: a queue of one kind publishes all of it, in order.
for (let n = 1; n <= 4; n++) store.enqueue({ kind: 'deck', n });
eq('one kind alone still drains', drainQueue(), 'D1 D2 D3 D4');

// Uneven queues alternate as far as they can and then continue.
store.enqueue({ kind: 'card', n: 1 });
for (let n = 1; n <= 3; n++) store.enqueue({ kind: 'deck', n });
eq('uneven alternates then continues', drainQueue(), 'C1 D1 D2 D3');

// A queued item from before `kind` existed counts as a card rather than
// breaking the comparison.
store.enqueue({ n: 1 });
store.enqueue({ kind: 'deck', n: 1 });
store.enqueue({ n: 2 });
eq('kind-less items count as cards', drainQueue(), 'C1 D1 C2');

// /post takes the number printed, which is a position in the RUNNING order.
// Splicing the array at that index would publish a different post.
for (let n = 1; n <= 2; n++) store.enqueue({ kind: 'deck', n });
for (let n = 1; n <= 2; n++) store.enqueue({ kind: 'card', n });
eq('shown order', store.queuedItems().map(kindTag).join(' '), 'D1 C1 D2 C2');
eq('/post 2 takes the second LINE', kindTag(store.takeQueuedAt(2)), 'C1');
store.clearStaging();
while (store.dequeue());

// Picking one post out of the queue by the number /queue printed. 1-based,
// because the list a person reads from starts at 1 and asking them to subtract
// one is how the wrong post gets published.
store.enqueue({ headline: 'ראשון' });
store.enqueue({ headline: 'שני' });
store.enqueue({ headline: 'שלישי' });
eq('the queue lists in publish order', store.queuedItems().map((c) => c.headline).join(','), 'ראשון,שני,שלישי');
eq('taking 2 takes the second', store.takeQueuedAt(2).headline, 'שני');
eq('and the rest close up', store.queuedItems().map((c) => c.headline).join(','), 'ראשון,שלישי');

// Out of range returns null rather than clamping. Clamping would publish item 5
// when 6 was asked for — precisely the case where the person misread the list,
// and the last moment to confidently pick a neighbour.
eq('past the end is nothing', store.takeQueuedAt(9), null);
eq('zero is nothing', store.takeQueuedAt(0), null);
eq('nonsense is nothing', store.takeQueuedAt('abc'), null);
eq('and none of that disturbed the queue', store.queueSize(), 2);

// The listing hands out copies, so a caller cannot edit the queue by accident.
const listed = store.queuedItems();
listed[0].headline = 'נדרס';
eq('the listing is a copy', store.queuedItems()[0].headline, 'ראשון');
store.takeQueuedAt(1);
store.takeQueuedAt(1);
eq('emptied', store.queueSize(), 0);

// /clear_pending means everything awaiting a tap, not just the built ones.
store.clearStaging();
eq('clearing what is pending takes proposals too', store.proposalSize(), 0);

// The destination is chosen at the proposal, which is the only point at which
// choosing it saves anything: a deck renders twelve slides across two aspect
// ratios, and picking the platform first halves that.
eq('an Instagram deck renders one size', sizesFor(['instagram']).join(','), 'instagram');
eq('a TikTok deck renders the other', sizesFor(['tiktok']).join(','), 'tiktok');
eq('both still works, in the order given', sizesFor(['tiktok', 'instagram']).join(','), 'tiktok,instagram');
eq('telegram is not a render size', sizesFor(['telegram', 'instagram']).join(','), 'instagram');
eq('and nothing sensible is asked for nothing', sizesFor([]).join(','), '');

// The button carries the destination in its callback data, so the two buttons
// route to the same builder with different targets. The key never contains a
// colon, which is what lets the target be appended with one.
const cb = /^db:(.+):(instagram|tiktok)$/;
ok('the Instagram button parses', cb.exec('db:a1b2c3d:instagram')?.[2] === 'instagram');
ok('the TikTok button parses', cb.exec('db:a1b2c3d:tiktok')?.[2] === 'tiktok');
ok('and a bare build tap no longer matches anything', !cb.test('db:a1b2c3d'));

// Draft mode: the same destination reached a different way. TikTok's API has no
// field for choosing a sound on a photo post — auto_add_music is a boolean —
// so a deck that wants a particular track has to be finished by hand in the
// app. MEDIA_UPLOAD delivers it to the inbox for exactly that.
const cbd = /^db:(.+):(instagram|tiktok|tiktokdraft)$/;
eq('the draft button parses', cbd.exec('db:a1b2c3d:tiktokdraft')?.[2], 'tiktokdraft');
eq('and does not shadow the direct one', cbd.exec('db:a1b2c3d:tiktok')?.[2], 'tiktok');
// It resolves to the tiktok TARGET plus a flag, not a fourth destination —
// publishTargets stays a list of real places.
eq('a draft still renders the TikTok size', sizesFor(['tiktok']).join(','), 'tiktok');

// The message must not say "published". Nothing in the process can see whether
// the app was ever opened, so this is the last honest thing it can report.
// Reported per DESTINATION, not per post. A deck sent to both said
// "פורסם לאינסטגרם וטיקטוק" — half true, and false in the direction that
// matters: you read "posted", never open the app, and the app is the only
// place a draft becomes a post.
const bothMsg = published({ headline: 'המקדשים של קיוטו', succeeded: ['instagram', 'tiktok'], drafted: ['tiktok'] });
ok('Instagram is reported as published', /📤 אינסטגרם/.test(bothMsg));
ok('TikTok is reported as a draft', /טיקטוק טיוטה/.test(bothMsg));
ok('and never as published', !/פורסם.*טיקטוק/.test(bothMsg));
ok('and the draft is marked as such, not as posted', /📥/.test(bothMsg) && !/📤 טיקטוק/.test(bothMsg));
ok('it carries the headline', bothMsg.includes('המקדשים של קיוטו'));
// Where it actually is. An upload is an inbox notification, not the Drafts
// folder on the profile — the first place anybody looks, and the one place it
// will not be.
eq('and the whole thing is one line', bothMsg.split('\n').length, 1);

// TikTok alone: nothing published, so no posted line at all.
const only = published({ headline: 'מסלולים באירופה', succeeded: ['tiktok'], drafted: ['tiktok'] });
ok('a draft-only post claims nothing published', !only.includes('📤'));
ok('and still says it is a draft', only.includes('טיוטה'));

// And an ordinary post is untouched.
const plain = published({ headline: 'כרטיס', succeeded: ['instagram'] });
ok('a normal publish still reads as published', plain.includes('📤 אינסטגרם'));
ok('with no draft line', !plain.includes('טיוטות'));

// The 24h cap counts posts PUBLISHED through the API. A draft publishes
// nothing, so charging it against the cap would spend a limit never touched.
const day = Date.now();
const capRows = [
  { tiktok: true, tiktokAt: day },
  { tiktok: true, tiktokAt: day, tiktokDraft: true },
  { tiktok: true, tiktokAt: day, tiktokDraft: true },
];
eq(
  'drafts do not eat the direct-post cap',
  capRows.filter((p) => p.tiktok && !p.tiktokDraft).length,
  1
);

// The proposal carries the CONTENT, not just a title. Deciding on a deck from
// its headline alone is deciding on a headline, and the list is the post.
const withPlaces = normaliseIdea({
  title_he: 'טופ 5 הרים יפים באוסטריה',
  where: 'Austria',
  kind: 'trail',
  want: 5,
  places_he: ['גרוסגלוקנר', 'דכשטיין'],
});
eq('the planned places survive normalisation', withPlaces.places.join(','), 'גרוסגלוקנר,דכשטיין');
eq('a long list is clamped', normaliseIdea({ title_he: 't', where: 'Austria', kind: 'trail', want: 5, places_he: Array(20).fill('x') }).places.length, 8);
// An older idea, or a model that omitted the field, must not throw — the
// proposal simply shows no list.
eq('an idea without places is still usable', normaliseIdea({ title_he: 't', where: 'Austria', kind: 'trail', want: 5 }).places.length, 0);

// A named region is used as named. This used to narrow a country to "the part
// travellers mean" — Austria became Tyrol — which overruled the one field the
// request was most explicit about, silently.
const req = readFileSync(new URL('../src/deck/request.js', import.meta.url), 'utf8');
ok('the resolver is told to use the region as named', /USE THE REGION THE REQUEST NAMES/.test(req));
ok('and the old narrowing instruction is gone', !/narrow to the part\s+travellers mean/.test(req));
ok('the schema no longer discourages a country', !/a country is acceptable only when/.test(req));

// Reaching TikTok always means a draft now. The direct button had nothing to
// recommend it: the API cannot name a sound, so a direct post takes whatever
// TikTok picks — and sound is the one thing not editable after publishing.
const cb3 = /^db:(.+):(instagram|tiktok|both)$/;
eq('instagram parses', cb3.exec('db:k:instagram')?.[2], 'instagram');
eq('tiktok parses', cb3.exec('db:k:tiktok')?.[2], 'tiktok');
eq('both parses', cb3.exec('db:k:both')?.[2], 'both');
ok('and the old separate draft button is gone', !cb3.test('db:k:tiktokdraft'));
// "both" is two destinations and one draft flag, not a third place to publish.
const destinationsFor = (c) => (c === 'both' ? ['instagram', 'tiktok'] : [c]);
eq('both means two destinations', destinationsFor('both').join(','), 'instagram,tiktok');
ok('and anything touching tiktok is a draft', destinationsFor('both').includes('tiktok'));
eq('both renders both sizes', sizesFor(destinationsFor('both')).join(','), 'instagram,tiktok');

/* -------------------------------------------------------------------------- */
group('one deck, one vocabulary — and a photo of what the deck is about');

// The screenshot that prompted this: one slide read "מרחק", the next "אורך",
// same measurement, same ruler emoji. Two field specs are live for a trail — a
// place with an official page gets its fields drafted from it, a place without
// gets them from Wikidata — and the two files disagreed on the word.
const allKinds = new Set([...Object.keys(FIELDS_BY_KIND), ...Object.keys(WIKIDATA_FIELDS)]);
for (const k of allKinds) {
  const specs = [...(FIELDS_BY_KIND[k] || []), ...(WIKIDATA_FIELDS[k] || [])];
  const byEmoji = new Map();
  const byKey = new Map();
  for (const f of specs) {
    if (!byEmoji.has(f.emoji)) byEmoji.set(f.emoji, new Set());
    byEmoji.get(f.emoji).add(f.labelHe);
    if (!byKey.has(f.key)) byKey.set(f.key, new Set());
    byKey.get(f.key).add(f.labelHe);
  }
  for (const [emoji, labels] of byEmoji)
    ok(`${k}: ${emoji} means one thing`, labels.size === 1, [...labels].join(' vs '));
  for (const [key, labels] of byKey)
    ok(`${k}: ${key} is named once`, labels.size === 1, [...labels].join(' vs '));
}

// The photo. "Bodensee-Rundweg" searched on its name alone returns the lakefront
// town — the right place, the wrong subject, on a slide in a deck about trails.
ok('every kind has an English subject for the search', [...Object.keys(KINDS)].every((k) => subjectEn(k)));
const qs = cinematicQueries('Bodensee-Rundweg', 'Austria', subjectEn('trail'));
ok('the subject leads the queries', qs[0].includes('hiking trail'));
ok('the bare name is still tried', qs.includes('Bodensee-Rundweg'));
// Without a subject the behaviour is exactly what it was, so a cover — which is
// a picture of the region and not of the category — is unaffected.
eq('no subject means the old queries', cinematicQueries('Prague', 'Prague')[0], 'Prague');

/* -------------------------------------------------------------------------- */
group('ranking — the two misfires found against live feeds');

const base = { sourceId: 's', publishedAt: new Date().toISOString(), pillarHints: [] };
const fcdo = { ...base, authority: 'government', title: 'Norway', summary: 'x'.repeat(400) };
const trade = { ...base, authority: 'official-dmo', title: '「第29回JNTOインバウンド旅行振興フォーラム」取材のご案内', summary: 'y'.repeat(400) };

ok('a short title with a real summary is not penalised as thin', scoreItem(fcdo) > scoreItem({ ...fcdo, summary: '' }));
// News that changes what a traveller can do still outranks a dataset item — but
// it now wins for the right reason.
//
// It used to win because evergreen carried a penalty, which made the feed a wire
// with a climate card as the fallback. Evergreen now earns a bonus, and the
// Louvre still comes first on the actionable vocabulary alone ("reopens"). That
// is the intended shape: something a reader can act on beats an evergreen fact,
// and everything else loses to it.
ok(
  'actionable news still outranks an evergreen dataset item',
  scoreItem({ title: 'Louvre reopens the Denon wing after two years', summary: 'x'.repeat(300), authority: 'government', publishedAt: new Date().toISOString(), pillarHints: ['inCity'] }) >
    scoreItem({ title: 'Bangkok — monthly climate normals 2016–2025 (ERA5)', summary: 'x'.repeat(300), authority: 'dataset', publishedAt: null, evergreen: true, pillarHints: ['timing'] })
);

// The reversal, pinned. A travel desk is not a wire: a fact that is worth saving
// beats a fact that merely happened, and "it happened today" is worth very
// little on its own. Both items below are ordinary news with nothing actionable
// in them; the evergreen one wins.
ok(
  'an evergreen fact now beats an undifferentiated news item',
  scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'dataset', evergreen: true }) >
    scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'dataset', publishedAt: new Date().toISOString(), evergreen: false })
);
ok(
  'the evergreen flag is what does it, not the source name',
  scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'dataset', evergreen: true }) >
    scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'dataset', evergreen: false })
);
// Recency is now a tie-breaker rather than a driver: it still orders two
// otherwise identical items, and it no longer decides the feed.
ok(
  'recency still breaks a tie between identical items',
  scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'government', publishedAt: new Date().toISOString() }) >
    scoreItem({ title: 'T', summary: 'x'.repeat(300), authority: 'government', publishedAt: new Date(Date.now() - 90 * 86_400_000).toISOString() })
);

/* -------------------------------------------------------------------------- */
group('the trip rule — could they go, and does it make them want to');

// The six posts that made this a natural-phenomena account rather than a travel
// one. Each is checked against a mundane item from an equally authoritative
// source, published at the same moment, so the only thing that can separate them
// is the new question.
const sameDay = { sourceId: 's', authority: 'government', publishedAt: new Date().toISOString(), pillarHints: [], summary: 'x'.repeat(300) };
const ordinary = scoreItem({ ...sameDay, title: 'Alhambra opens timed-entry tickets for the Nasrid Palaces' });

for (const title of [
  'Waterspout observed off the coast of Puerto Rico',
  'Lava flows continue at Kilauea summit',
  'Icebergs calving into the strait off east Greenland',
  'Eruption at Fuego sends ash plume over Guatemala',
  'Emperor penguin colony surveyed from orbit, Antarctica',
]) {
  ok(`spectacle loses to an ordinary reachable item: ${title.slice(0, 34)}`, scoreItem({ ...sameDay, title }) < ordinary);
}

// The item that is both — a volcano the reader is being told they cannot visit.
// It matches both lists and lands between the two, which is the correct outcome
// for something that genuinely could go either way: it stays in the running and
// the drafting step, which has read the page, gets to make the actual call.
const both = scoreItem({ ...sameDay, title: 'Etna: summit craters closed to visitors until further notice' });
ok('a closure at a volcano is not treated as pure spectacle', both > scoreItem({ ...sameDay, title: 'Lava flows continue at Kilauea summit' }));

// The hole the penalty left, found by scoring a live gather rather than a
// fixture. Of the Smithsonian's 22 weekly reports, the two that ranked highest —
// 7th and 8th of 65 items, above every FCDO advisory — were the two that never
// say erupt, lava, ash or volcano. They say "unrest" and "the Alert Level was
// lowered". The vocabulary filter was not missing them, it was selecting them.
const unrest = {
  ...sameDay,
  title: 'Asosan (Japan) - Report for 27 August-2 September 2026 - Continuing Unrest',
  summary:
    'The Japan Meteorological Agency (JMA) reported that unrest at Asosan showed a downward trend ' +
    'since 17 August based on seismic and gas emission data. At 1600 on 1 September the Alert Level ' +
    'was lowered to 2 (on a scale of 1-5) and the public was warned not to enter the area around the crater.',
};
ok('an unrest report that never says volcano is still spectacle', scoreItem(unrest) < ordinary);

// And the guarantee that does not depend on wording at all: a feed that is one
// phenomenon is declared as such in sources.json, so next week's phrasing cannot
// walk around it.
const plainWording = { ...sameDay, title: 'Report for 27 August-2 September 2026' };
ok(
  'a wire declared as one phenomenon takes the penalty whatever the wording',
  scoreItem({ ...plainWording, spectacle: true }) < scoreItem(plainWording)
);

// The hard rule itself. Three ways the answer comes back no, and the case the
// brief was explicit about: a volcano you can stand near is a post, the same
// volcano closed to visitors is not.
ok('no place to stand is not a trip', tripGap({ where: '', how: 'fly to X', open: true, want: 'w' }) !== null);
ok('no way to get there is not a trip', tripGap({ where: 'איסלנד', how: '', open: true, want: 'w' }) !== null);
ok('closed to visitors is not a trip', tripGap({ where: 'הר הגעש פואגו', how: 'tours from Antigua', open: false, want: 'w' }) !== null);
ok(
  'a volcano someone can stand near is a trip',
  tripGap({ where: 'הר הגעש פואגו', how: 'overnight hike from Antigua, 2 hours from Guatemala City', open: true, want: 'you watch it erupt from the next ridge' }) === null
);
ok('a missing trip object is not a trip', tripGap(undefined) !== null);

ok('B2B trade notices rank below traveller content',scoreItem(trade) < scoreItem({ ...trade, title: '箸作り体験を渋谷で開始' }));

// The intergovernmental half of the same problem, checked against the live
// UNESCO feed rather than invented: the post that prompted this — the first
// World Heritage site of São Tomé — was ranking BELOW a fund project, a side
// event, a policy adoption and a public forum, each of which cost a drafting
// call to be told that a strategy document is not a place anyone can stand.
const unesco = (title, summary) => scoreItem({ ...sameDay, authority: 'intergovernmental', title, summary });

const inscription = unesco(
  'Three New Countries Join the World Heritage List: A Major Milestone for Africa and SIDS',
  'With the inscription of three new properties located in the Comoros, São Tomé and Príncipe, and South Sudan, three countries have joined the World Heritage List for the first time.'
);

for (const [title, summary] of [
  ['UNESCO Supports Nauru in Completing its First World Heritage International Assistance Project', 'Supported through the World Heritage Fund, the project has strengthened national capacities for implementing the Convention.'],
  ['World Heritage Committee adopts a landmark strategy for Small Island Developing States', 'The Committee adopted the World Heritage Strategy for SIDS 2026-2034, with over 20 SIDS State Parties present. A comprehensive roadmap backed by a budget of US$13 million.'],
  ['Flying Beyond Borders: Connecting People, Birds and Habitats', 'The side event was organized on 25 July 2026 during the 48th session of the World Heritage Committee in Busan.'],
  ['UNESCO-supported Public Forum Empowers Youth and Advances Partnerships', 'A Public Forum was held in Ravno, bringing together representatives of government institutions, academia and civil society.'],
]) {
  ok(`a new place outranks institutional news: ${title.slice(0, 38)}`, inscription > unesco(title, summary));
}

// Both halves of the feed say "the 48th session of the World Heritage
// Committee", so the session is not the signal and must not be treated as one.
ok(
  'the committee session itself is not what gets penalised',
  unesco('25 new sites inscribed', 'The World Heritage Committee wrapped up its 48th session in Busan with the addition of 25 new sites.') > 0.5
);

// Somewhere nobody can go, ever — top item of all 65 on the day this was found.
ok(
  'a post about Mars is not a trip and does not lead the run',
  scoreItem({ ...sameDay, title: "Curiosity Postcard Celebrates Rover's 5,000th Day on Mars" }) < ordinary
);

/* -------------------------------------------------------------------------- */
group('dedupe identity');

eq(
  'tracking parameters do not create a second candidate',
  candidateId({ url: 'https://www.gov.uk/a?utm_source=x&utm_campaign=y' }),
  candidateId({ url: 'https://www.gov.uk/a' })
);
eq('a fragment does not either', candidateId({ url: 'https://www.gov.uk/a#top' }), candidateId({ url: 'https://www.gov.uk/a' }));
ok('different pages stay distinct', candidateId({ url: 'https://www.gov.uk/a' }) !== candidateId({ url: 'https://www.gov.uk/b' }));
ok('a real query parameter is significant', candidateId({ url: 'https://www.gov.uk/a?id=1' }) !== candidateId({ url: 'https://www.gov.uk/a' }));

/* -------------------------------------------------------------------------- */
group('the daily cap survives repeated gathers and restarts');

// The gather now runs through the day instead of once, so "the best two or
// three a day" has to be counted rather than being a property of running once.
{
  eq('a fresh day starts at zero', store.stagedToday('2026-08-24'), 0);
  store.noteStaged('2026-08-24');
  store.noteStaged('2026-08-24');
  eq('counts up', store.stagedToday('2026-08-24'), 2);
  eq('yesterday is not today', store.stagedToday('2026-08-23'), 0);
  store.noteStaged('2026-08-25');
  eq('a new day resets', store.stagedToday('2026-08-25'), 1);
  eq('and the old day is gone rather than accumulating', store.stagedToday('2026-08-24'), 0);
}

// Rejecting a card gives its slot back.
//
// The day this was written: three cards staged in the morning, all three
// rejected, remaining quota zero, the gather stopped looking, and the day
// produced no posts at all. A card you turned down is not one of "the best two
// or three a day".
{
  const DAY = '2026-08-26';
  store.noteStaged(DAY);
  store.noteStaged(DAY);
  store.noteStaged(DAY);
  eq('three offered', store.stagedToday(DAY), 3);
  eq('none rejected yet', store.rejectedToday(DAY), 0);

  store.noteRejected(DAY);
  eq('a rejection is counted', store.rejectedToday(DAY), 1);
  eq('but the offer count stands — the ceiling is computed from it', store.stagedToday(DAY), 3);

  store.noteRejected(DAY);
  store.noteRejected(DAY);
  eq('all three refunded', store.rejectedToday(DAY), 3);

  // Bounded by what was actually offered, so a card staged yesterday and
  // rejected today cannot mint a slot today never spent.
  store.noteRejected(DAY);
  eq('a fourth rejection cannot refund what was never offered', store.rejectedToday(DAY), 3);
  eq('and rejections do not leak into another day', store.rejectedToday('2026-08-27'), 0);
}

// The scheduling decision itself, as a pure function of the clock and the counts.
{
  const RUN_HOUR = 8, UNTIL = 22, EVERY_MS = 2 * 3_600_000, TARGET = 3, CEILING = 9;
  const remaining = (offered, rejected) =>
    Math.min(TARGET - (offered - rejected), CEILING - offered);
  const wouldGather = (hour, offered, sinceLastMs, rejected = 0) =>
    hour >= RUN_HOUR && hour < UNTIL && remaining(offered, rejected) > 0 && sinceLastMs >= EVERY_MS;

  ok('gathers at the start of the window', wouldGather(8, 0, Infinity));
  ok('gathers again later in the day — this is the whole point', wouldGather(14, 1, EVERY_MS));
  ok('does not gather before the window opens', !wouldGather(6, 0, Infinity));
  ok('does not gather overnight', !wouldGather(23, 0, Infinity));
  ok('stops once the daily cap is met', !wouldGather(14, 3, Infinity));
  ok('does not gather twice inside one interval', !wouldGather(14, 0, EVERY_MS - 1));

  // The bug: rejecting the morning's three used to end the day.
  ok('a rejected card frees its slot, so the day is not over', wouldGather(14, 3, Infinity, 3));
  ok('rejecting one of three frees exactly one', remaining(3, 1) === 1);

  // ...but not without limit, or a day of rejections becomes a firehose and the
  // human gate becomes a rubber stamp.
  ok('the offer ceiling still ends the day', !wouldGather(14, 9, Infinity, 9));
  eq('and it binds before the target does', remaining(8, 8), 1);
}

/* -------------------------------------------------------------------------- */
group('the quiet alarm — the check that could not fire');

// It watched an in-memory `lastStagedAt` that started null, behind a truthiness
// guard, and was only ever set by a successful staging. So a bot that staged
// nothing — the exact thing the alarm exists to report — skipped the check
// forever, and a restart reset it. It also watched staging only, so a day where
// cards arrived and none was approved published nothing and said nothing.
{
  const HOURS = 30;
  const LIMIT = HOURS * 3_600_000;
  const now = 1_800_000_000_000;
  const bootedAt = now - 40 * 3_600_000;
  // Exactly the two lines from bot.js quietCheck().
  const isQuiet = (stagedAt, publishedAt) =>
    now - (stagedAt ?? bootedAt) >= LIMIT || now - (publishedAt ?? bootedAt) >= LIMIT;

  const fresh = now - 1 * 3_600_000;
  const stale = now - 31 * 3_600_000;

  ok('a bot that has never staged anything is quiet, not exempt', isQuiet(null, null));
  ok('nothing staged for 31 hours is quiet', isQuiet(stale, fresh));
  ok('staged all day but never published is quiet too', isQuiet(fresh, stale));
  ok('both moving recently is not quiet', !isQuiet(fresh, fresh));

  // The anchors have to survive a restart or 30 hours can never accumulate on a
  // bot that is restarted daily.
  store.noteStagedAt();
  ok('the staging anchor is persisted', store.lastStagedAt() != null);
  store.recordPublished({ id: 'quiet-alarm-probe', pillar: 'fact', tags: [], layout: 'numbers', instagram: true });
  ok('the publish anchor is persisted', store.lastPublishedAt() != null);
  store.forgetPublished('quiet-alarm-probe');
}

// The message has to say which half is quiet and what to do about it, or it is
// just a nudge to go and type /status.
{
  const dark = [{ target: 'instagram', hoursAgo: 31, ever: true }];
  const base = { hours: 30, stagedHoursAgo: 31, everStaged: true, darkTargets: dark };

  const waiting = quietAlert({ ...base, stagingSize: 2, queueSize: 0 });
  ok('names the approval tap when cards are waiting', waiting.includes('ממתינים לאישור שלך'));

  const stuck = quietAlert({ ...base, stagingSize: 0, queueSize: 3 });
  ok('names publishing when the queue is full but nothing goes out', stuck.includes('בדוק את הפרסום'));

  const dry = quietAlert({ ...base, stagingSize: 0, queueSize: 0 });
  ok('names the pipeline when there is nothing anywhere', dry.includes('/run'));

  const held = quietAlert({ ...base, stagingSize: 2, queueSize: 1, heldCount: 4 });
  ok('held posts outrank everything else as the thing to act on', held.includes('/retry'));

  const never = quietAlert({
    ...base,
    everStaged: false,
    darkTargets: [{ target: 'instagram', hoursAgo: 40, ever: false }],
  });
  ok('says "never staged" rather than an hour count it cannot know', never.includes('מאז שהבוט עלה'));
  ok('says "never published there" too', never.includes('מעולם לא פורסם'));

  const onlyPublish = quietAlert({ ...base, stagedHoursAgo: 1, stagingSize: 1 });
  ok('reports only the half that is actually quiet', !onlyPublish.includes('לא עלה מועמד חדש'));
  ok('and still reports the other half', onlyPublish.includes('שום דבר לא פורסם'));

  // The failure this was rewritten for: one destination up, one down.
  const oneDark = quietAlert({ ...base, stagedHoursAgo: 1, stagingSize: 0, queueSize: 0 });
  ok('names WHICH destination is dark', oneDark.includes('אינסטגרם'));
  ok('and does not blame the one that is working', !oneDark.includes('טלגרם'));
}

/* -------------------------------------------------------------------------- */
group('a blocked destination must not be silently abandoned');

// The actual outage: Instagram returned "API access blocked" on every post.
// Telegram succeeded, so `succeeded.length` was non-zero, so the item was
// recorded as published and never retried — one warning line per post, and the
// Instagram account dark for days behind it.
{
  const TARGET = 'instagram';
  store.clearDegraded(TARGET);

  // The retry unit is the destination, not the item. This is the arithmetic
  // from publishNext(): what a card still owes after a pass.
  const owedAfter = (owed, succeeded) => owed.filter((t) => !succeeded.includes(t));
  eq(
    'a card that reached Telegram still owes Instagram',
    owedAfter(['telegram', 'instagram'], ['telegram']).join(),
    'instagram'
  );
  eq(
    'and retrying it cannot duplicate Telegram',
    owedAfter(['telegram', 'instagram'], ['telegram']).includes('telegram'),
    false
  );
  eq('a card that reached both owes nothing', owedAfter(['telegram', 'instagram'], ['telegram', 'instagram']).length, 0);

  // Consecutive failures, reset by any success — a blip must not look like a
  // block, and a block must not stay invisible.
  const first = store.noteTargetFailed(TARGET, 'API access blocked [code 200]');
  eq('one failure is not yet a block', first.degraded, false);
  eq('and it does not escalate', first.justDegraded, false);

  store.noteTargetFailed(TARGET, 'API access blocked [code 200]');
  const third = store.noteTargetFailed(TARGET, 'API access blocked [code 200]');
  eq('three in a row is a block', third.degraded, true);
  ok('which escalates exactly once', third.justDegraded);

  const fourth = store.noteTargetFailed(TARGET, 'API access blocked [code 200]');
  ok('and does not escalate again on every later card', !fourth.justDegraded);
  ok('the error is kept for the report', store.targetHealth(TARGET).lastError.includes('code 200'));
  ok('the destination is skipped while degraded', store.isDegraded(TARGET));

  store.noteTargetOk(TARGET);
  eq('a success clears the streak', store.targetHealth(TARGET).failures, 0);
  eq('and un-degrades it', store.isDegraded(TARGET), false);
  ok('and stamps when it last worked', store.lastOkAt(TARGET) != null);

  // Telegram working must not vouch for Instagram — the whole reason the old
  // global "did anything publish" check never fired.
  ok('health is per destination', store.lastOkAt('telegram') == null);
}

// An approved post that a destination refused is set aside, not dropped.
{
  const cand = { id: 'held-probe', headline: 'כותרת', pillar: 'fact', tags: [], layout: 'numbers' };
  eq('nothing held to start', store.heldCount(), 0);

  store.hold(cand, ['instagram'], 'API access blocked');
  eq('the post is kept', store.heldCount(), 1);
  eq('with the destination it still owes', store.heldItems()[0].targets.join(), 'instagram');

  const released = store.releaseHeld();
  eq('/retry gets them all back', released.length, 1);
  eq('and the hold list empties', store.heldCount(), 0);
  eq('the card itself survives intact', released[0].cand.headline, 'כותרת');
}

// Not every held post CAN be retried, which is why there is a way to give up.
//
// A card is frozen at approval with whatever its destinations said then, and
// for TikTok that includes the privacy level - attached once by creator_info at
// staging and never re-read. A card approved while TikTok was unreachable
// carries none, so it throws the instant it is picked up, and /retry cannot
// help: it re-enqueues the stored candidate verbatim, so the same card fails
// the same way forever while re-degrading the destination behind it. Clearing
// the degraded flag is itself only something /retry does, so without this there
// is no exit from that loop.
{
  const frozen = { id: 'poisoned-probe', headline: 'בלי רמת פרטיות', pillar: 'fact', tags: [], layout: 'numbers' };
  store.hold(frozen, ['tiktok'], 'no privacy level was chosen at approval');
  store.hold({ ...frozen, id: 'poisoned-probe-2' }, ['tiktok'], 'no privacy level was chosen at approval');
  eq('two unpublishable cards are held', store.heldCount(), 2);

  eq('/clear_held reports what it discarded', store.clearHeld(), 2);
  eq('and the backlog is gone', store.heldCount(), 0);
  // The distinction that makes this safe to offer: a held row lists only what a
  // destination still OWES. Whatever already published did so before the card
  // was held, so giving up on the row cannot unpublish anything.
  eq('nothing is left to release afterwards', store.releaseHeld().length, 0);
  eq('and clearing an empty backlog is a no-op', store.clearHeld(), 0);
}

// Reaching the second destination later must not count the post twice.
{
  const id = 'partial-publish-probe';
  store.recordPublished({ id, pillar: 'fact', tags: [], layout: 'numbers', telegram: true, instagram: false });
  const afterFirst = store.recentPublished().filter((p) => p.id === id);
  eq('one row after the first destination', afterFirst.length, 1);

  store.recordPublished({ id, pillar: 'fact', tags: [], layout: 'numbers', telegram: false, instagram: true });
  const afterSecond = store.recentPublished().filter((p) => p.id === id);
  eq('still one row after the second', afterSecond.length, 1);
  eq('and it now records both', `${afterSecond[0].telegram}/${afterSecond[0].instagram}`, 'true/true');
  store.forgetPublished(id);
}

// "API access blocked" names a symptom and no cause. The code, subcode and step
// are what tell a dead token from a throttle from an app-level restriction, and
// they were being dropped before the message ever reached Telegram.
{
  const blocked = new InstagramError('API access blocked', { step: 'create_container', code: 200, subcode: 2207051 });
  const text = describeError(blocked);
  ok('keeps Graph\'s own message', text.includes('API access blocked'));
  ok('adds the code', text.includes('code 200'));
  ok('adds the subcode', text.includes('subcode 2207051'));
  ok('and says which step failed', text.includes('create_container'));

  const expired = describeError(new InstagramError('Session has expired', { step: 'publish', code: 190 }));
  ok('a token code carries the fix with it', expired.includes('ig-token'));

  const plain = describeError(new Error('socket hang up'));
  eq('a non-Graph error is passed through unchanged', plain, 'socket hang up');
}

/* -------------------------------------------------------------------------- */
group('/redo must not resurrect something already published');

// The exact sequence that happened: an iceberg post was approved, published to
// Instagram, then /redo cleared `seen` and it came straight back to the
// approval queue with a different photograph.
{
  const item = { url: 'https://earthobservatory.nasa.gov/images/1', title: 'Drifter', summary: 'x'.repeat(300), authority: 'government', pillarHints: ['fact'] };
  const id = candidateId(item);

  store.forgetAllSeen();
  ok('before publishing, it ranks', rank([item], { now: Date.now() }).length === 1);

  store.recordPublished({ id, pillar: 'fact', tags: [], layout: 'photoFull', instagram: true });
  eq('after publishing, it is remembered', store.hasPublished(id), true);
  ok('and it no longer ranks', rank([item], { now: Date.now() }).length === 0);

  // The whole point of /redo is to clear `seen`. It must not clear this.
  store.forgetAllSeen();
  eq('/redo does not forget it', store.hasPublished(id), true);
  ok('so it still does not rank', rank([item], { now: Date.now() }).length === 0);

  // A different item is unaffected — this is not a blanket freeze.
  const other = { ...item, url: 'https://earthobservatory.nasa.gov/images/2' };
  ok('an unpublished item still ranks', rank([other], { now: Date.now() }).length === 1);

  store.forgetPublished(id);
  ok('and it can be released deliberately', rank([item], { now: Date.now() }).length === 1);
}

/* -------------------------------------------------------------------------- */
group('no word twice in a headline');

// "יולי" appeared at both ends of a real staged card. Accurate, and it reads
// assembled rather than written.
ok('flags the live repeat', noRepeatedWord({ headline: 'יולי היה החודש הכי עמוס ביפן אי פעם ליולי' }));
ok('sees through an attached Hebrew prefix — ליולי is יולי', noRepeatedWord({ headline: 'יולי עמוס ליולי' }));
eq('the rewrite passes', noRepeatedWord({ headline: 'יולי השיא של התיירות ביפן' }), null);
eq('a real headline passes', noRepeatedWord({ headline: 'הקרחון הענק במיצר שבין גרינלנד לאיסלנד' }), null);
eq('an alert headline passes', noRepeatedWord({ headline: 'בריטניה ביטלה את האזהרה מנסיעה לבחריין' }), null);
eq('function words may repeat', noRepeatedWord({ headline: 'בין הים בין ההרים של הצפון' }), null);
throws('verifyDraftText refuses one', () =>
  verifyDraftText({ headline: 'יפן פתחה מסלול חדש ליפן', caption: 'a caption long enough to pass the length check' })
);

/* -------------------------------------------------------------------------- */
group('feeds that are themselves the publication');

// The Smithsonian weekly volcano report puts each volcano's full report in its
// own item and links all 21 of them to the same landing page — which returns
// 403 to anything that is not a browser.
const volcanoFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Etna (Italy) - Report for 13 August-19 August 2026</title>
    <link>https://volcano.si.edu/reports_weekly.cfm</link><description>Explosive activity at Voragine Crater persisted.</description></item>
  <item><title>Karangetang (Indonesia) - Report for 13 August-19 August 2026</title>
    <link>https://volcano.si.edu/reports_weekly.cfm</link><description>Lava advanced about 700 m south.</description></item>
</channel></rss>`;

const volSrc = { id: 'v', name: 'V', authority: 'research-institution', lang: 'en', pillars: ['fact'], dedupeBy: 'title', contentInFeed: true };
const volItems = parseFeed(volcanoFeed, volSrc);
eq('both items survive parsing', volItems.length, 2);
ok('a shared link does not collapse them into one candidate', candidateId(volItems[0]) !== candidateId(volItems[1]));
ok('identity comes from the title', Boolean(volItems[0].dedupeId));
ok('the feed-content flag is carried onto the item', volItems[0].contentInFeed === true);

const plainItems = parseFeed(volcanoFeed, { ...volSrc, dedupeBy: undefined, contentInFeed: undefined });
eq('without the flag, a shared link still collapses them', candidateId(plainItems[0]), candidateId(plainItems[1]));
ok('and no feed-content flag is set', plainItems[0].contentInFeed === undefined);

// A feed item carries no menus or breadcrumbs, so the same character count buys
// more substance than it does on a page. The real Smithsonian report that was
// being thrown away came to 779 characters.
ok('the feed floor is lower than the page floor', minSourceChars('english text', { fromFeed: true }) < minSourceChars('english text'));
ok('779 characters of clean report clears the feed floor', 779 > minSourceChars('english text', { fromFeed: true }));
ok('but 779 would not clear the page floor', 779 < minSourceChars('english text'));

/* -------------------------------------------------------------------------- */
group('rounding — a decimal on a card means it was generated, not written');

// Both of these shipped to the approval queue before the guard existed.
ok('rejects the live "16.7 מעלות" headline', noDecimalsUpFront({ headline: 'נובמבר בטוקיו: 16.7 מעלות ורק 8.6 ימי גשם' }));
ok('rejects the live "2.6 ימי גשם" headline', noDecimalsUpFront({ headline: 'בנובמבר בקטמנדו יורדים 2.6 ימי גשם בממוצע' }));
ok('rejects a decimal in the subhead too', noDecimalsUpFront({ headline: 'ok', subhead: 'ממוצע 30.9 ימים' }));
eq('a rounded headline passes', noDecimalsUpFront({ headline: 'נובמבר בטוקיו: 17 מעלות וכמעט בלי גשם' }), null);
eq('a time of day is not a decimal', noDecimalsUpFront({ headline: 'הטיסה נוחתת ב-06:30' }), null);
eq('a date is not a decimal', noDecimalsUpFront({ headline: 'נכנס לתוקף ב-1/10' }), null);
throws('verifyDraftText refuses a draft carrying one', () =>
  verifyDraftText({ headline: 'טוקיו ב-16.7 מעלות', caption: 'a caption long enough to pass the length check' })
);

/* -------------------------------------------------------------------------- */
group('card filenames — a dedupeId is not automatically a safe filename');

// Found by measuring a real run: two drafting calls a day were being paid for
// and then thrown away at the render step, because the climate adapter's
// readable dedupeId contains colons.
eq('colons are replaced — Windows rejects them outright', safeStem('climate:dubai:2025'), 'climate-dubai-2025');
eq('a hex id is untouched', safeStem('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
ok('nothing survives that would need URL-escaping', /^[A-Za-z0-9._-]+$/.test(safeStem('a b/c:d?e#f')));
eq('an id of only separators still yields a filename', safeStem(':::'), 'card');
ok('long ids are bounded', safeStem('x'.repeat(300)).length <= 100);

/* -------------------------------------------------------------------------- */
group('thin sources are rejected before a drafting call is paid for');

const thinItem = (text, title = 'x') => ({ title, summary: '', url: 'https://www.gov.uk/a', text });

eq(
  'a Japanese headline stub is under the CJK floor',
  minSourceChars('お知らせ：安全情報リーフレットを刷新しました。'.repeat(4)),
  700
);
eq('an English page is judged by the higher floor', minSourceChars('a plain english travel advisory update'), 1200);
ok(
  'the observed stub sizes (291 and 346 chars) fall under the CJK floor',
  291 < minSourceChars('日本語') && 346 < minSourceChars('日本語')
);
ok(
  'the thinnest genuinely usable source that day (3157 chars) clears the floor',
  3157 > minSourceChars('an english advisory')
);

/* -------------------------------------------------------------------------- */
group('image policy — AI imagery may only be generic');

throws('rejects a prompt naming the post\'s place', () => assertGenericAiPrompt('a sunny street in Lisbon', { place: 'Lisbon', country: 'Portugal' }));
throws('rejects a prompt naming the country', () => assertGenericAiPrompt('rooftops in portugal at dusk', { place: 'Lisbon', country: 'Portugal' }));
ok('allows an abstract prompt', assertGenericAiPrompt('abstract warm-toned travel texture', { place: 'Lisbon', country: 'Portugal' }));

/* -------------------------------------------------------------------------- */
group('rendering — escaping and layout selection');

const draft = {
  layout: 'fact',
  pillar: 'fact',
  headline: 'כותרת <script>alert(1)</script> a & b',
  subhead: 'זו שורת המשך שלא אמורה להופיע על הכרטיס',
  place: 'תל אביב',
  country: '',
  url: 'https://www.gov.uk/x',
  bullets: [],
};
const html = renderHtml(draft);
ok('interpolated content is escaped', !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
ok('ampersand escaped', html.includes('a &amp; b'));

// The card is the hook. If the subhead is printed on it too, the description
// has nothing left to offer and nobody taps "more".
ok('the subhead is NOT printed on the card', !html.includes('שלא אמורה להופיע'));
for (const layout of LAYOUTS) {
  const h = renderHtml({ ...draft, layout, stat: { value: '1', label: 'x' }, compare: { a: 'a', b: 'b' }, route: {} });
  ok(`${layout} keeps the subhead off the card`, !h.includes('שלא אמורה להופיע'));
}
ok('document declares Hebrew and RTL', html.includes('lang="he"') && html.includes('dir="rtl"'));
ok('the font is inlined, not linked', html.includes('data:font/ttf;base64,') && !html.includes('fonts.googleapis'));
// The card is a hook, not a citation: no source line, no credit line. The
// sourcing rule is unaffected - it lives in the approval message, which is
// asserted separately below and prints the URL unconditionally.
ok(
  'the card carries no source line',
  !renderHtml({ ...draft, sourceUrl: 'https://www.jnto.go.jp/news/x' }).includes('jnto.go.jp')
);

// The card carries no photographer or library credit - Pexels does not require
// it and it is visual noise on a 4:5 card. The provenance trail is not lost:
// it still appears in the approval message, which is where the "show me which
// origin this came from" rule actually lives.
for (const l of PHOTO_LAYOUTS) {
  ok(
    `${l} keeps the card clean of credit lines`,
    !renderHtml({ ...draft, layout: l }, {
      image: { src: 'data:image/png;base64,AA', provenance: 'stock', credit: 'Pexels / Ada L' },
    }).includes('Ada L')
  );
}

eq('ten layouts registered', LAYOUTS.length, 10);
ok('the photo family is identified as such', PHOTO_LAYOUTS.every(isPhotoLayout) && !isPhotoLayout('fact'));

// A photo layout with no image must degrade to a text card, never render an
// empty frame. With no image provider configured this is not an edge case — it
// is what happens on every single render today.
for (const l of PHOTO_LAYOUTS) {
  const noImage = renderHtml({ ...draft, layout: l });
  ok(`${l} falls back to a text card when no image is supplied`, !noImage.includes('class="bg"') && noImage.includes('&lt;script&gt;'));
  ok(`${l} renders a background image when one is supplied`, renderHtml({ ...draft, layout: l }, { image: { src: 'data:image/png;base64,AA', provenance: 'stock' } }).includes('class="bg"'));
}

// Layout-specific payloads must actually reach the card.
ok(
  'numbers renders the figure, isolated so bidi cannot reorder it',
  (() => {
    const h = renderHtml({ ...draft, layout: 'numbers', stat: { value: '3,715', unit: 'מטר', label: 'גובה' } });
    return h.includes('3,715') && /unicode-bidi:\s*isolate/.test(h);
  })()
);
ok(
  'compare renders both panels',
  renderHtml({ ...draft, layout: 'compare', compare: { aTitle: 'מיתוס', aText: 'א', bTitle: 'מציאות', bText: 'ב' } }).includes('מציאות')
);
ok(
  'route renders origin and destination',
  (() => {
    const h = renderHtml({ ...draft, layout: 'route', route: { from: 'תל אביב', to: 'טביליסי', operator: '', startsOn: '' } });
    return h.includes('טביליסי') && h.includes('תל אביב');
  })()
);

/* -------------------------------------------------------------------------- */
group('approval message — the source URL is never optional');

const cand = {
  ...draft,
  caption: 'טקסט',
  tags: [],
  sourceUrl: 'https://www.gov.uk/foreign-travel-advice/japan',
  sourceName: 'UK FCDO',
  evidence: [{ claim: 'a', quote: 'b' }],
  image: null,
};
const msg = approvalMessage({ ...cand, publishTargets: ['instagram'] });
ok('contains the full source URL verbatim', msg.includes(cand.sourceUrl));
ok('states the image provenance (or that there is none)', /תמונה:/.test(msg));
ok('reports how many quotes were verified', /1 ציטוט/.test(msg));
ok('says where it will publish, before you tap', msg.includes('יפורסם לאינסטגרם'));
ok('warns when there is nowhere to publish', approvalMessage({ ...cand, publishTargets: [] }).includes('אין יעד פרסום'));

// A photo-led draft that arrives as a wall of type looks exactly like a draft
// that chose a text layout on purpose, so a stock provider that has stopped
// answering reads as a run of editorial decisions for as long as nobody checks.
const demoted = approvalMessage({
  ...cand,
  publishTargets: ['telegram'],
  layout: 'fact',
  photoDowngrade: 'photoFull',
  imageMiss: 'Pexels search failed: HTTP 429',
});
ok('a card that wanted a photograph and did not get one says so', demoted.includes('HTTP 429'));
ok('and names the layout it was demoted from', demoted.includes('photoFull'));
ok('a deliberately text-led card has nothing to explain', !/ירד ל/.test(approvalMessage({ ...cand, publishTargets: ['telegram'] })));

/* -------------------------------------------------------------------------- */
group('publish targets — Telegram may be approval-only');

const targetsFor = (env) => publishTargets({ ...env });
const IG = { IG_USER_ID: '1', IG_ACCESS_TOKEN: 'x', CARD_PUBLIC_BASE_URL: 'https://x/c' };

// instagramConfigured() reads process.env directly, so drive it there.
const withEnv = (patch, fn) => {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

withEnv({ ...IG, CHANNEL_ID: undefined }, () => {
  eq('Instagram only (no channel) is a valid setup', targetsFor({ CHANNEL_ID: undefined }).join(','), 'instagram');
});
withEnv({ IG_USER_ID: undefined, IG_ACCESS_TOKEN: undefined, CARD_PUBLIC_BASE_URL: undefined }, () => {
  eq('Telegram channel only is a valid setup', targetsFor({ CHANNEL_ID: '@c' }).join(','), 'telegram');
  eq('neither configured yields no targets — bot refuses to start', targetsFor({ CHANNEL_ID: undefined }).length, 0);
});
withEnv(IG, () => {
  eq('both configured publishes to both', targetsFor({ CHANNEL_ID: '@c' }).join(','), 'telegram,instagram');
});
withEnv({ ...IG, CARD_PUBLIC_BASE_URL: undefined }, () => {
  eq(
    'Instagram without a public card URL is not configured — it cannot fetch the image',
    targetsFor({ CHANNEL_ID: undefined }).length,
    0
  );
});

/* -------------------------------------------------------------------------- */
group('tiktok - the privacy level is chosen, never assumed');

// The whole point of the privacy plumbing: a default that errs towards the
// quietest setting, and a level the owner actually saw before tapping.
eq('defaults to the most private level available', defaultPrivacy(['PUBLIC_TO_EVERYONE', 'SELF_ONLY']), 'SELF_ONLY');
eq(
  'honours TIKTOK_PRIVACY when the account really offers it',
  defaultPrivacy(['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], 'PUBLIC_TO_EVERYONE'),
  'PUBLIC_TO_EVERYONE'
);
eq(
  'ignores TIKTOK_PRIVACY when the account does not offer it - an unaudited app gets SELF_ONLY only',
  defaultPrivacy(['SELF_ONLY'], 'PUBLIC_TO_EVERYONE'),
  'SELF_ONLY'
);
eq('falls back to whatever came back when SELF_ONLY is absent', defaultPrivacy(['FOLLOWER_OF_CREATOR']), 'FOLLOWER_OF_CREATOR');
eq('with nothing offered at all, still names a level rather than undefined', defaultPrivacy([]), 'SELF_ONLY');

const two = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'];
eq('the button cycles forward', nextPrivacy('PUBLIC_TO_EVERYONE', two), 'SELF_ONLY');
eq('and wraps', nextPrivacy('SELF_ONLY', two), 'PUBLIC_TO_EVERYONE');
eq('a level no longer offered lands on the first available one', nextPrivacy('MUTUAL_FOLLOW_FRIENDS', two), two[0]);
eq('one option means the button cannot change anything', nextPrivacy('SELF_ONLY', ['SELF_ONLY']), 'SELF_ONLY');
ok('every level has Hebrew', two.every((l) => privacyHe(l) !== l));

// Refusing before the network, not during it. A publish that reaches TikTok
// without a chosen privacy level is the one failure this path exists to stop,
// so it must not depend on the API to catch it.
const noPrivacy = await publishTikTok({ card: { url: 'https://x/c.jpg' } }).then(
  () => null,
  (e) => e
);
ok('refuses to publish with no privacy level chosen', noPrivacy instanceof TikTokError);
ok('and says so before any API call', noPrivacy.step === 'config', `step was ${noPrivacy?.step}`);

// `step: 'config'` is load-bearing beyond being a label. The publish loop reads
// it to tell "this CARD can never go here" from "this DESTINATION is having a
// bad day", and the difference is what stopped a run of unpublishable cards
// degrading TikTok and taking good cards down with them: three no-privacy
// cards marked the destination degraded, and every card behind them was then
// skipped and held without ever being attempted.
//
// Every per-card refusal must carry it, or it gets scored as an outage.
for (const [what, cand] of [
  ['no privacy level', { card: { url: 'https://x/c.jpg' } }],
  ['a non-https image', { tiktok: { privacy: 'SELF_ONLY' }, card: { url: 'http://x/c.jpg' } }],
]) {
  const e = await publishTikTok(cand).then(() => null, (err) => err);
  ok(`${what} is the card's problem, not the destination's`, e?.step === 'config', `step was ${e?.step}`);
}
// TikTok decides some of these at ITS end, and they are the same kind of thing.
//
// creator_info reports what the ACCOUNT supports, not what this CLIENT may use
// — a comment in tiktok.js claimed the opposite for months. So an unaudited app
// against a public account is offered all three privacy levels, offers them on
// the approval card, and is refused at init. Scoring that as an outage degraded
// TikTok after three cards and held every good card behind them, when a card
// asking for SELF_ONLY would have published perfectly well.
const unaudited = new TikTokError('Please review our integration guidelines', {
  step: 'init',
  code: 'unaudited_client_can_only_post_to_private_accounts',
});
ok("an unaudited-client refusal is the card's problem", isCardLevelTikTok(unaudited));
ok('a mismatched privacy level is too', isCardLevelTikTok(new TikTokError('x', { step: 'init', code: 'privacy_level_option_mismatch' })));
// The ones that really are the destination must still degrade it, or an outage
// would be retried forever with no backoff and no alert.
ok('a dead token is NOT', !isCardLevelTikTok(new TikTokError('x', { step: 'init', code: 'access_token_invalid' })));
ok('nor is an unknown server error', !isCardLevelTikTok(new TikTokError('x', { step: 'init', code: 'internal_error' })));
ok('nor is a plain Error from somewhere else', !isCardLevelTikTok(new Error('socket hang up')));
// The raw TikTok sentence says nothing about what to do, so the code carries it.
ok('the refusal explains the way out', describeTikTokError(unaudited).includes('audit'));
ok('and names the level that would work', describeTikTokError(unaudited).includes('פרטי'));

// And the message the owner gets says so, rather than reading as a failure.
const abandonMsg = notifyTargetAbandoned('כותרת', [{ target: 'tiktok', message: 'no privacy level was chosen at approval' }]);
ok('the notice names the destination given up on', abandonMsg.includes('טיקטוק'));
ok('and names the reason', abandonMsg.includes('no privacy level was chosen at approval'));
eq('on one line', abandonMsg.split('\n').length, 1);
ok('tiktok is not configured in the test environment', !tiktokConfigured());

// The error text has to name the code, because TikTok's sentence alone often
// does not say what to do — same lesson as Instagram's describeError().
const unverified = describeTikTokError(
  new TikTokError('url ownership unverified', { step: 'init', code: 'url_ownership_unverified' })
);
ok('failure text carries the code', unverified.includes('url_ownership_unverified'));
ok('and the step', unverified.includes('init'));
ok('and translates the ones worth acting on', unverified.includes('דומיין'));
eq('a plain error passes through untouched', describeTikTokError(new Error('boom')), 'boom');

// What people actually paste is the whole address bar, and TikTok appends a
// "*1" to the code on some redirects — pasting it raw fails as an invalid code,
// which reads like the login went wrong rather than the copy.
eq('reads the code out of a redirected URL', codeFrom('https://tiyulplus.com/cb?code=abc123&state=x'), 'abc123');
// The one that cost an evening. A v2 code carries a `*v!NNNN.sN` tail and it is
// part of the code — trimming it sends a truncated code, and TikTok reports a
// truncated code as an EXPIRED one, so every fresh attempt fails with an error
// that blames the clock and sends you back to fetch another doomed code.
eq(
  'keeps the *v!... tail, which is part of the code and not a suffix to discard',
  codeFrom('https://tiyulplus.com/cb?code=abc123%2Av%215236.s1&state=x'),
  'abc123*v!5236.s1'
);
eq('accepts a bare code too', codeFrom('abc123'), 'abc123');
eq('a bare code copied still encoded is decoded once', codeFrom('abc123%2Av%215236.s1'), 'abc123*v!5236.s1');
eq('nothing pasted, nothing returned', codeFrom('   '), null);
eq('a URL with no code at all', codeFrom('https://tiyulplus.com/cb'), null);
ok(
  'a refusal in the URL is raised rather than read as a missing code',
  (() => {
    try {
      codeFrom('https://tiyulplus.com/cb?error=access_denied&error_description=user%20said%20no');
      return false;
    } catch (e) {
      return /access_denied|said/.test(e.message);
    }
  })()
);

// TikTok's rule for Direct Post: the creator sees the privacy level before it
// publishes. That means it has to be on the approval card, and only there.
const tkCand = { ...cand, publishTargets: ['tiktok'], tiktok: { privacy: 'SELF_ONLY', username: 'tiyulplus', options: ['SELF_ONLY'] } };
const tkMsg = approvalMessage(tkCand);
ok('the approval card names the privacy level', tkMsg.includes(privacyHe('SELF_ONLY')));
ok('and the account it would post as', tkMsg.includes('@tiyulplus'));
ok(
  'a card with no TikTok target says nothing about privacy',
  !approvalMessage({ ...cand, publishTargets: ['telegram'] }).includes('פרטיות')
);
ok(
  'a failed creator-info call is reported rather than papered over with a default',
  approvalMessage({ ...cand, publishTargets: ['tiktok'], tiktok: { error: 'access_token_invalid', options: [] } }).includes(
    'access_token_invalid'
  )
);

// One description, one review. A second wording would be a second thing to
// approve, and the approval message only ever shows you one.
const bothCand = { headline: 'כותרת', subhead: 'תת כותרת', caption: 'גוף הטקסט.', sourceUrl: 'https://gov.uk/x' };
eq('the TikTok description is the same text as the Instagram one', tiktokCaption(bothCand), instagramCaption(bothCand));

/* -------------------------------------------------------------------------- */
group('decks - a slideshow is not a card, and goes somewhere else');

// The editorial rule, in code: one destination each. A news card is written for
// a feed and goes to Instagram; a deck is written for a vertical scroll and goes
// to TikTok. Sending both kinds to several places at once made every account a
// copy of the others.
withEnv({ ...IG, CHANNEL_ID: '@c' }, () => {
  eq('a card goes to Instagram and nowhere else', targetsForKind('card').join(','), 'instagram');
  ok('a card never goes to TikTok', !allowedForKind('card').includes('tiktok'));
  // A deck goes to both, and it is not the same artefact twice: the TikTok set
  // is drawn to be read over a video player's furniture, the Instagram set is
  // drawn as cards so a slideshow sits in the grid looking like the account
  // that posted it. Same words, same photographs, two designs.
  ok('a deck goes to TikTok', allowedForKind('deck').includes('tiktok'));
  ok('and a deck also goes to Instagram', allowedForKind('deck').includes('instagram'));
  // CHANNEL_ID is set in this env and still nothing routes to it. Telegram is
  // where posts are APPROVED; that path runs on STAGING_CHAT_ID and never comes
  // through here.
  ok('nothing publishes to Telegram, even with a channel configured', !allowedForKind('card').includes('telegram'));
  ok('not even a deck', !allowedForKind('deck').includes('telegram'));

  // The distinction health and the quiet alarm depend on. publishTargets says
  // what is CONFIGURED and still counts a Telegram channel; liveTargets says
  // what can actually receive something. Reading the first one would have left
  // Telegram with a lastOkAt of null for ever, reported dark from boot onwards,
  // with no possible way to clear it.
  ok('a configured channel still counts as configured', publishTargets().includes('telegram'));
  ok('but is not a live destination', !liveTargets().includes('telegram'));
  eq('and the live set is exactly where the two kinds go', liveTargets().sort().join(','), 'instagram');
});

// With TikTok connected too, both kinds have somewhere to go and both show up.
withEnv({ ...IG, CHANNEL_ID: '@c', TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' }, () => {
  ok('Instagram is live for cards', liveTargets().includes('instagram'));
  ok('Telegram is still not live', !liveTargets().includes('telegram'));
});

// The condition publishNext holds on. Before each kind had exactly ONE
// destination, "no destination at all" needed two things switched off at once
// and was a genuine edge case. Now an unconnected TikTok means every approved
// deck reaches it — and the branch it used to fall into recorded the post as
// published and dropped it. Silently, one slideshow at a time, at the drip
// interval.
withEnv({ ...IG, CHANNEL_ID: '@c' }, () => {
  // While TikTok approval is pending, a deck is NOT stuck: it publishes to
  // Instagram and owes TikTok nothing it can act on. That is the whole value of
  // the deck reaching two platforms rather than one.
  eq('with TikTok pending a deck still has Instagram', targetsForKind('deck').join(','), 'instagram');
  ok('so nothing is waiting on a destination that does not exist yet', targetsForKind('deck').length > 0);
  ok('and cards are unaffected', targetsForKind('card').length > 0);
});

// The hold path still matters, for the case where a kind genuinely has nowhere
// to go. Neither destination configured means a deck cannot publish anywhere —
// and the startup guard refuses to start at all in that state, which is the
// first of the two defences.
// Explicitly cleared, not merely absent from the patch: withEnv only touches
// the keys it is given, and a developer .env supplies the real ones.
withEnv({ CHANNEL_ID: '@c', IG_USER_ID: undefined, IG_ACCESS_TOKEN: undefined, CARD_PUBLIC_BASE_URL: undefined }, () => {
  eq('with neither destination a deck has nowhere to go', targetsForKind('deck').length, 0);
  eq('and neither do cards', targetsForKind('card').length, 0);
  ok('which is what the startup guard refuses to start on', !targetsForKind('card').length && !targetsForKind('deck').length);
});

// Its own message, not the outage one. "Held until TikTok comes back to work"
// is the wrong sentence for an account that has never been connected, and a bot
// that reports a setup step in the vocabulary of an outage teaches you to read
// real outages as setup steps.
const waitMsg = publishWaitingForSetup('המקדשים של קיוטו', ['tiktok'], 3);
ok('it names the destination being waited on', waitMsg.includes('טיקטוק'));
ok('it says the destination is not connected', waitMsg.includes('לא מחובר'));
ok('it carries the headline', waitMsg.includes('המקדשים של קיוטו'));
ok('and says how many are waiting', waitMsg.includes('3'));
ok('it does not claim anything failed', !/נכשל|שגיאה/.test(waitMsg));

/* -------------------------------------------------------------------------- */
group('a throttle is not a breakage');

// "Application request limit reached" came back on a publish and was retried
// three times, then counted against Instagram's health. Graph throttles by app,
// by user and by page, and every one clears on its own within the hour — so a
// busy afternoon ended with the destination marked down and a backlog held
// behind it at the exact moment nothing was wrong.
//
// TikTok has had this distinction since its daily cap; the code never made it
// across.
ok('the code that actually turned up is a limit', isPlatformLimitInstagram(new InstagramError('x', { code: 4, subcode: 2207051 })));
ok('so is a user throttle', isPlatformLimitInstagram(new InstagramError('x', { code: 17 })));
ok('and a page throttle', isPlatformLimitInstagram(new InstagramError('x', { code: 32 })));
// A dead token and a rejected image are NOT throttles: one needs you, the other
// needs a different card, and holding either as "not now" would wait forever.
ok('a dead token is not', !isPlatformLimitInstagram(new InstagramError('x', { code: 190 })));
ok('nor an unfetchable image', !isPlatformLimitInstagram(new InstagramError('x', { code: 9004 })));
ok('nor a non-Graph failure', !isPlatformLimitInstagram(new Error('network')));

/* -------------------------------------------------------------------------- */
group('a deck must be where it says it is');

// A deck went out headed "United States" carrying six Swiss peaks, with Swiss
// flags and a Hebrew title naming שווייץ. Everything a reader saw was right and
// everything the bot RECORDED was wrong — and `place` is what the geographic
// quota measures and the repeat detector counts runs on, so the guard that
// exists to stop one country dominating was filing Switzerland under America.
//
// The two halves come from different places on purpose: the cover's country
// from each slide's own P17 claim, `where` from the string the map was searched
// with. Nothing compared them.
const swissSlides = [{ iso: 'CH', countryHe: 'שווייץ' }, { iso: 'CH', countryHe: 'שווייץ' }];
ok('Swiss slides in a US search is a mismatch', countryMismatch(swissSlides, 'US'));
eq('Swiss slides in a Swiss search is fine', countryMismatch(swissSlides, 'CH'), null);
// Compared on ISO rather than name: the two sides name countries differently
// and a string compare would fire on "USA" vs "United States".
eq('case does not matter', countryMismatch(swissSlides, 'ch'), null);

// Unknown is not mismatch. Refusing a deck because a geocoder timed out would
// trade a rare wrong label for a common missing post.
eq('no region resolved means nothing to check', countryMismatch(swissSlides, null), null);
eq('slides with no country claim likewise', countryMismatch([{}, {}], 'US'), null);
eq('and a deck spanning countries is not a mismatch', countryMismatch([{ iso: 'CH' }, { iso: 'IT' }], 'US'), null);

/* -------------------------------------------------------------------------- */
group('TikTok scopes — the half-connection that looked connected');

// A deck failed at init with scope_not_authorized against a token that plainly
// carried video.publish. TikTok splits posting by MODE, not by media: a direct
// post needs video.publish, an upload-to-inbox needs video.upload. Decks go out
// as drafts, and only video.publish had ever been requested — so the connection
// held a scope for the mode the bot no longer uses and not the one it does.
eq('a draft needs the upload scope', scopeForMode(true), 'video.upload');
eq('a direct post needs the publish scope', scopeForMode(false), 'video.publish');
ok('and both are requested at connect time', TK_SCOPES.includes('video.upload') && TK_SCOPES.includes('video.publish'));

// The exact token that was live when this failed.
store.setTikTokToken({
  accessToken: 't',
  refreshToken: 'r',
  expiresAt: Date.now() + 86_400_000,
  refreshExpiresAt: Date.now() + 30_000_000_000,
  openId: 'o',
  scope: 'user.info.basic,video.publish',
});
eq('that token cannot send a draft', missingScopes({ draft: true }).join(','), 'video.upload');
eq('though it could have posted directly', missingScopes({ draft: false }).length, 0);

store.setTikTokToken({
  accessToken: 't',
  refreshToken: 'r',
  expiresAt: Date.now() + 86_400_000,
  refreshExpiresAt: Date.now() + 30_000_000_000,
  openId: 'o',
  scope: 'user.info.basic,video.publish,video.upload',
});
eq('reconnecting with both clears it', missingScopes({ draft: true }).length, 0);

// No token is "not connected", which is a different message reported elsewhere.
store.clearTikTokToken();
eq('an absent token reports no missing scopes', missingScopes({ draft: true }).length, 0);

// And it is no longer retried. A missing scope refuses every post identically
// and will refuse the next hundred; "ניסיון 1/3" promised something that could
// not happen, three calls at a time.
ok('a scope failure is a config problem', isConfigProblem(new TikTokError('x', { code: 'scope_not_authorized' })));
ok('so is a dead token', isConfigProblem(new TikTokError('x', { code: 'access_token_invalid' })));
ok('a rate limit is not', !isConfigProblem(new TikTokError('x', { code: 'rate_limit_exceeded' })));
ok('nor is an unverified image host', !isConfigProblem(new TikTokError('x', { code: 'url_ownership_unverified' })));

/* -------------------------------------------------------------------------- */
group('the same deck, drawn as cards for Instagram');

// One deck, two designs. The words and the photographs are identical — what
// differs is that the Instagram set is built in the CARD's design language, so
// a slideshow lands in the grid looking like the account that posted it rather
// than like a TikTok slide with less headroom.
const igSlide = renderInstagramSlideHtml(
  { nameHe: 'אגם סורפיס', countryHe: 'איטליה', flag: '🇮🇹', fields: [{ emoji: '📏', labelHe: 'מרחק', value: '12.5 קמ' }] },
  { index: 3, total: 5, style: 'info', kicker: 'טופ 4 מסלולים בדולומיטים' }
);

ok('it carries the brand, which a TikTok slide never does', igSlide.includes('class="brand"'));
ok('and the site, the same as a card', igSlide.includes('class="site"'));
ok('it is numbered, because a carousel shows no progress of its own', igSlide.includes('3 / 5'));
ok('it names the deck it belongs to', igSlide.includes('טופ 4 מסלולים בדולומיטים'));
ok('the place name is there', igSlide.includes('אגם סורפיס'));
ok('and the info fields', igSlide.includes('מרחק'));
// Built at card dimensions, from the card stylesheet — not approximated.
ok('it is the card size', igSlide.includes('1080px') && igSlide.includes('1350px'));
ok('it uses the card accent rule under the header', igSlide.includes('border-bottom: 2px solid var(--accent)'));

// The minimal style has a note and no field list; the info style the reverse.
// Same split the TikTok slide makes, so the two stay one deck.
const igMinimal = renderInstagramSlideHtml(
  { nameHe: 'מאטרהורן', fields: [{ emoji: '🗻', labelHe: 'גובה', value: '4,478 מ' }] },
  { index: 2, total: 6, style: 'minimal' }
);
ok('the minimal style shows the fact as a note', igMinimal.includes('(4,478 מ)'));
ok('and does not list fields', !igMinimal.includes('גובה:'));

// The cover is the title alone, with the model's chosen phrase in the accent.
const igCover = renderInstagramSlideHtml(
  { titleHe: 'טופ 5 פסגות שאסור לפספס באלפים', emphasisHe: 'שאסור לפספס' },
  { cover: true, index: 1, total: 6 }
);
ok('the cover carries the title', igCover.includes('טופ 5 פסגות'));
ok('and lifts the emphasis into the accent colour', igCover.includes('class="emph"'));
ok('a cover is not numbered against a deck title it opens', !igCover.includes('class="kick"'));

// No photograph is not an error — a deck built with no image provider renders
// every slide this way, and an empty frame would be worse than a flat field.
ok('a slide with no photograph still renders', renderInstagramSlideHtml({ nameHe: 'x' }, {}).includes('bg-empty'));

/* -------------------------------------------------------------------------- */
group('Hebrew first — technical detail below the line, never inside it');

// Every failure read `❌ משהו נכשל: ${e.message}`, and e.message is whatever the
// API or the runtime said: always English. A Hebrew clause and an English
// clause on one line is hard to read in either, and genuinely hard to SKIM —
// RTL and LTR reorder each other at the boundary, so the punctuation ends up
// somewhere neither language put it.
const det = withDetail('❌ בניית המצגת נכשלה', new Error('only 2 slide(s) survived sourcing'));
eq('the first line is Hebrew and complete on its own', det.split('\n')[0], '❌ בניית המצגת נכשלה');
ok('the technical text survives, on its own line', det.split('\n')[1].includes('only 2 slide(s)'));
ok('and is marked as technical rather than narrated', det.includes('🔧'));

// A message with nothing to add should not grow an empty footnote.
eq('no detail means no second line', withDetail('❌ נכשל', null), '❌ נכשל');
eq('an empty error is the same as none', withDetail('❌ נכשל', new Error('')), '❌ נכשל');

// A stack in a notification is the message being replaced by its own footnote.
const long = withDetail('❌ נכשל', 'x'.repeat(900));
ok('a long detail is trimmed', long.length < 300);
ok('and says it was trimmed', long.includes('…'));

// Plain strings work too — not every failure arrives as an Error.
ok('a bare string is accepted', withDetail('❌ נכשל', 'ECONNRESET').includes('ECONNRESET'));

const deckFixture = {
  kind: 'deck',
  id: 'abc123',
  publishTargets: ['instagram', 'tiktok'],
  tiktok: { privacy: 'SELF_ONLY', username: 'tiyulplus', options: ['SELF_ONLY'] },
  deck: {
    titleHe: 'המוזיאונים של פראג',
    where: 'Prague',
    category: 'museum',
    idea: { angleHe: 'מה פתוח ביום שני ומה שווה את הכרטיס' },
    counts: { found: 75, withWikidata: 75, withAuthority: 52, asked: 5, built: 3 },
    short: true,
    dropped: [{ place: 'Kafka Museum', why: 'fetch failed: HTTP 403' }],
    slides: [
      {
        n: 1,
        nameHe: 'המוזיאון הלאומי',
        nameEn: 'National Museum',
        sourceHost: 'tiyulplus.com',
        sourceUrl: 'https://www.nm.cz/en/visit',
        fields: [
          { key: 'distance', labelHe: 'מרחק', emoji: '📏', value: '5.3 ק\"מ', quote: 'Admission 250 CZK' },
        ],
      },
      {
        n: 2,
        nameHe: 'הגלריה הלאומית',
        nameEn: 'National Gallery',
        sourceHost: 'tiyulplus.com',
        sourceUrl: 'https://www.ngprague.cz/en/visit',
        fields: [],
      },
    ],
  },
};

const deckMsg = approvalMessage(deckFixture);
ok('a deck gets the deck approval message', deckMsg.includes('מצגת'));
ok('which lists every slide', deckMsg.includes('המוזיאון הלאומי') && deckMsg.includes('הגלריה הלאומית'));
ok('and the domain each fact was quoted from', deckMsg.includes('nm.cz') && deckMsg.includes('ngprague.cz'));
// A deck that came up short and a deck that meant to be short look identical
// afterwards, so the shortfall is stated at the moment it can still be rejected.
ok('says when it came up short of what was asked', deckMsg.includes('ביקשנו 5'));
ok('reports how thin the region was', deckMsg.includes('75') && deckMsg.includes('52'));
ok('names what was dropped and why', deckMsg.includes('Kafka Museum') && deckMsg.includes('403'));
ok('carries the TikTok privacy level, same as a card', deckMsg.includes(privacyHe('SELF_ONLY')));
ok('every source URL is in the message', deckMsg.includes('https://www.nm.cz/en/visit'));

const deckEv = evidenceReport(deckFixture);
ok('evidence is grouped per slide, not flattened', deckEv.includes('המוזיאון הלאומי') && deckEv.includes('Admission 250 CZK'));
ok('with the page each quote came from', deckEv.includes('nm.cz'));

const dcap = deckCaption(deckFixture.deck);
// The title and the shoutout, nothing else. This used to carry the angle and
// then every place, numbered — the deck retyped underneath the deck. Anyone
// who wants the list swipes; what the description is for is saying what this
// is and where to go next, and a wall of names pushes the only line that asks
// for anything below the fold.
// Two descriptions, because one platform has a title field and the other does
// not. Repeating the title in TikTok's description spends the first line of the
// only place a link can be asked for on a line already read two centimetres up.
eq('TikTok gets the shoutout alone', deckTiktokCaption().split('
')[0], 'למתכנן טיולים חכם בביו שלנו');
ok('and never the title', !deckTiktokCaption().includes('פראג'));
ok('the caption is the title', dcap.startsWith('המוזיאונים של פראג'));
ok('and does not list the places', !dcap.includes('1. המוזיאון'));
ok('and drops the angle', !dcap.includes('מה פתוח'));

// A deck publishes to Instagram and TikTok, and neither makes a caption link
// tappable — so it asks for the bio, which is the only clickable route either
// platform offers. The card signature still points at the URL; a card's caption
// is read somewhere a URL is worth printing.
ok('a deck caption asks for the bio', dcap.includes('בביו'));
ok('and still carries the domain for recall', dcap.includes('www.tiyulplus.com'));

// The "always" in "always ends with the call to action", which the old version
// could not keep. It built the whole string and sliced it to 2200, so on a long
// deck the signature was what fell off the end — and a deck with many places is
// exactly the one that runs long. The truncation read as a finished caption
// that had simply stopped asking anyone to go anywhere.
const longCap = deckCaption({ idea: { angleHe: 'א'.repeat(2500) }, slides: [{ nameHe: 'מקדש א' }] });
ok('a caption over the limit is still within it', longCap.length <= 2200);
ok('and the call to action survives being over the limit', longCap.endsWith('בביו שלנו\nwww.tiyulplus.com'));

// A slide is a numbered NAME, and fields only where the category has them.
// Never a sentence: prose on a slide is what made these read like a guidebook,
// and it survived every typographic fix because it was never typographic.
const slideHtml = renderSlideHtml(deckFixture.deck.slides[0], { size: 'tiktok', style: 'info' });
ok('the name stands alone, unnumbered', slideHtml.includes('המוזיאון הלאומי') && !slideHtml.includes('1. המוזיאון'));
ok('a field renders as icon, label, value', slideHtml.includes('מרחק: 5.3'));
ok('no score on a slide - it belongs in the cover line', !slideHtml.includes('class="score"'));

const bare = renderSlideHtml({ n: 3, nameHe: 'גשר קרל', fields: [] }, { style: 'minimal' });
ok('a name-only slide is just the name', bare.includes('גשר קרל'));
ok('and carries nothing else at all', !bare.includes('class="field"'));

// The minimal style is the one modelled on the reference that carries no facts
// at all, so it must not start printing them when a slide happens to have some.
ok(
  'the minimal style shows no fields even when the slide has them',
  !renderSlideHtml(deckFixture.deck.slides[0], { style: 'minimal' }).includes('class="field"')
);

// The flag belongs to the name, not to a line of its own.
//
// The reference puts it underneath and that was copied faithfully; in Hebrew at
// this size it read as a detached ornament floating below the label. Inline it
// wraps with the text and stays part of the thing it is labelling.
const flagged = renderSlideHtml(
  { nameHe: 'החוף האדום', flag: '🇬🇷', fields: [] },
  { style: 'minimal' }
);
ok('the flag sits inside the name', /class="name[^"]*">[^<]*החוף האדום[^<]*<img/.test(flagged));
ok('and there is no separate flag line', !flagged.includes('class="flag"'));

// Leading, which is the thing that was wrong twice. Hebrew has almost no
// descenders and takes far less than a Latin face; at 1.2 a wrapped place name
// read as two separate thoughts rather than one name.
ok('a wrapped name is set tight', flagged.includes('line-height: 0.98'));

// The country is named only when the deck spans countries; in a one-city deck
// every slide would repeat the same word.
ok(
  'a cross-country deck names the country and flies the flag',
  renderSlideHtml(
    { n: 1, nameHe: 'דולומיטים', countryHe: 'איטליה', flag: '🇮🇹', fields: [] },
    { style: 'minimal' }
  ).includes('דולומיטים, איטליה')
);

// The cover is one line with one word louder. Hebrew has no capitals, so the
// emphasis is colour; a word the model did not take from the title is dropped
// rather than appended.
const coverHtml = renderSlideHtml(
  { titleHe: '5 מקומות בפראג שאסור לפספס', emphasisHe: 'בפראג' },
  { cover: true, style: 'minimal' }
);
ok('the emphasis is set apart', coverHtml.includes('class="emph tight">בפראג</span>'));
ok('and the rest of the line survives intact', coverHtml.includes('5 מקומות') && coverHtml.includes('שאסור לפספס'));
ok(
  'an emphasis that is not in the title is ignored, not appended',
  !renderSlideHtml({ titleHe: '5 מקומות בפראג', emphasisHe: 'וויומינג' }, { cover: true, style: 'minimal' }).includes(
    'וויומינג'
  )
);
ok('no eyebrow and no second line on a cover', !coverHtml.includes('class="eyebrow"') && !coverHtml.includes('class="cover-angle"'));
// A two-word emphasis broken across a line break is two coloured fragments
// rather than one shouted phrase, which is the whole point of colouring it.
ok('a short emphasis is held on one line', coverHtml.includes('.emph.tight { white-space: nowrap; }'));

// A name is not a claim, so a name-only deck has nothing to quote - and the
// evidence report says exactly that rather than showing an empty list.
ok(
  'a name-only deck reports that there is nothing to quote',
  evidenceReport({ kind: 'deck', deck: { slides: [{ n: 1, nameHe: 'x', fields: [] }] } }).includes('אין טענות לצטט')
);
ok('a field-bearing deck still shows its quotes', evidenceReport(deckFixture).includes('Admission 250 CZK'));

// A cover set at full size wraps to four lines and eats the photograph.
eq('a short title stays large', sizeClass('חמישה מוזיאונים', { mid: 24, long: 36 }), '');
eq('a medium one steps down', sizeClass('המוזיאונים של פראג ששווים בהחלט', { mid: 24, long: 36 }), ' mid');
eq(
  'a long one steps down twice',
  sizeClass('המוזיאונים של פראג ששווים את הכרטיס ועוד כמה דברים', { mid: 24, long: 36 }),
  ' long'
);
ok('a long name steps down rather than overflowing', renderSlideHtml(
  { n: 1, nameHe: 'x'.repeat(40), fields: [] },
  { style: 'minimal' }
).includes('name long'));

// sizeClass emits BOTH a mid and a long step for everything it is given, and
// for a while only .long had a rule — so every name between twenty and thirty
// characters carried a class that styled nothing and set at full size, which is
// precisely the length at which a Hebrew place name begins to wrap. A class
// with no rule behind it fails silently, so each one is checked against the
// stylesheet it is supposed to match.
for (const [what, cls, html] of [
  ['a name', 'name', renderSlideHtml({ nameHe: 'x'.repeat(25), fields: [] }, { style: 'minimal' })],
  ['an info name', 'title-info', renderSlideHtml({ nameHe: 'x'.repeat(22), fields: [] }, { style: 'info' })],
  ['a cover', 'cover', renderSlideHtml({ titleHe: 'x'.repeat(25) }, { cover: true, style: 'minimal' })],
]) {
  ok(`${what} of middling length takes the middle step`, html.includes(`${cls} mid`));
  ok(`and the stylesheet actually has a rule for it`, html.includes(`.${cls}.mid {`));
}

// A fourth step, for the covers that got longer when they started naming the
// country. Same failure mode as the mid step had: a class the stylesheet has no
// rule for sets at full size and fails silently.
const xlongCover = renderSlideHtml({ titleHe: 'x'.repeat(50) }, { cover: true, style: 'minimal' });
ok('a very long cover takes the smallest step', xlongCover.includes('cover xlong'));
ok('and the stylesheet has a rule for that too', xlongCover.includes('.cover.xlong {'));
// Opt-in, because a place name has three steps and must never be handed a class
// that does not exist in the stylesheet.
eq('nothing else reaches for it', sizeClass('x'.repeat(80), { mid: 20, long: 30 }), ' long');

// The complaint that prompted the scale: a cover set as a poster rather than as
// a caption. Every step is measured against the frame so the two styles cannot
// drift apart silently.
const coverPx = (style, cls) =>
  Number(
    renderSlideHtml({ titleHe: 'x' }, { cover: true, style })
      .match(new RegExp(`\\.cover${cls ? `\\.${cls}` : ''} \\{[^}]*font-size: (\\d+)px`))?.[1]
  );
ok('a minimal cover is under 4% of the frame', coverPx('minimal', '') / 1920 < 0.04, coverPx('minimal', ''));
ok('an info cover is too', coverPx('info', '') / 1920 < 0.045, coverPx('info', ''));
ok('and every step is smaller than the one above it',
  coverPx('minimal', '') > coverPx('minimal', 'mid') &&
    coverPx('minimal', 'mid') > coverPx('minimal', 'long') &&
    coverPx('minimal', 'long') > coverPx('minimal', 'xlong'));
// A URL burned into a photograph is the clearest sign a post was made by a
// company. The sourcing did not weaken: every slide's URL is in the approval
// message, which is where the decision is actually made.
ok('no URL is burned into a fact slide', !slideHtml.includes('nm.cz'));
ok('but the approval message still carries every one', deckMsg.includes('https://www.nm.cz/en/visit'));
// TikTok draws its own slide counter and genuine posts carry no second one, so
// ours was the tell that this had been made elsewhere and uploaded.
ok('no counter of our own', !slideHtml.includes('class="counter"'));
// Nor our own domain on a fact slide. The source stays; branding on every
// slide is what an advertisement looks like.
ok('the brand is not on every slide', !slideHtml.includes('tiyulplus'));
// Not one reference post carries a domain, cover included.
ok('nor on the cover', !renderSlideHtml({ titleHe: 'x' }, { cover: true, style: 'minimal' }).includes('tiyulplus'));

// Placement is measured, not named. render/photo.js returns the centre of the
// empty region as a fraction of the frame, and the renderer applies it
// literally — a fixed centre is what put a title across the middle of a garden,
// and three named bands were not much better.
const placed = renderSlideHtml(
  { nameHe: 'x', fields: [] },
  { style: 'minimal', spot: { x: 0.34, y: 0.28, width: 0.52, color: '#FFFFFF', onDark: true, assist: 0, shadow: 0 } }
);
ok('the block is positioned from the measurement', placed.includes('top:538px') && placed.includes('width:562px'));
ok('a slide with no measurement still lands somewhere sane', bare.includes('class="block"'));

// Text ran off the left edge of the first renders because a 0.56-wide box
// centred at 0.3 reaches x=0.02. The margin is guaranteed here rather than
// trusted from the scoring.
const hugging = renderSlideHtml(
  { nameHe: 'x', fields: [] },
  { style: 'minimal', spot: { x: 0.05, y: 0.5, width: 0.9, color: '#FFFFFF', onDark: true, assist: 0, shadow: 0 } }
);
ok('and never touches the edge of the frame', hugging.includes('left:65px'));

// No outline in the minimal style. A stroke around every letter is not
// something TikTok's own text tool can produce, so the eye reads it as foreign
// no matter how good the rest of the slide is — it was the single loudest part
// of "the font looks like it was added in Photoshop".
ok('the minimal style carries no outline at all', placed.includes('-webkit-text-stroke: 0'));
ok('the info style is cream over bronze, which is its whole signature', slideHtml.includes('-webkit-text-stroke: var(--stroke) #7A4A12'));

// One Hebrew face, two weights. TikTok Sans has no Hebrew at all — it carries
// only the digits and punctuation — so the family after it is the one that
// actually draws the words.
ok('Latin and digits are always set in TikTok Sans', slideHtml.includes("font-family: 'TikTok Sans'"));
ok('the info style sets Hebrew in the display face', slideHtml.includes("font-family: 'TikTok Sans', 'Arimo'"));
ok('and so does the minimal style', placed.includes("font-family: 'TikTok Sans', 'Arimo'"));
// Heebo stays last, so a face that fails to parse degrades to legible-but-wrong
// rather than to a slide full of tofu boxes.
ok('both fall back rather than to nothing', placed.includes("'Heebo', sans-serif") && slideHtml.includes("'Heebo', sans-serif"));
ok('the faces are bundled into the page, not linked', placed.includes('data:font/ttf;base64,'));

// ONE weight across both styles, and it is a constraint rather than a taste.
//
// The shipped Arimo.ttf is a single static 600 instance, not a variable font.
// Asking for 800 from it does not get a heavier cut — the browser synthesises
// one by smearing the outlines, and faux-bold Hebrew over a photograph is
// exactly the "added in Photoshop" look the rest of this file works to avoid.
//
// The weights used to be what separated the two styles. They no longer need to
// be: an info slide already announces itself with a list of fields and a cream
// ink over a bronze outline, which is a louder difference than 200 units of
// weight ever was.
eq('the deck face is Arimo', FACES.minimal.family, 'Arimo');
eq('and both styles use it', FACES.info.family, FACES.minimal.family);
eq('at one weight', FACES.minimal.name, 600);
eq('the same one', FACES.info.name, FACES.minimal.name);
// Guard against a heavier weight being asked of a single-weight file again.
ok(
  'no style asks for a weight the file does not have',
  [FACES.minimal, FACES.info].every((f) => Object.values(f).filter((v) => typeof v === 'number').every((w) => w === 600))
);
ok('the weight reaches the stylesheet', placed.includes(`font-weight: ${FACES.minimal.name};`));
ok('and the info weight does too', slideHtml.includes(`font-weight: ${FACES.info.name};`));

// The wash behind the text is the last resort and has to stay rare, or every
// slide grows a panel and the look is gone.
ok('no wash when the photograph offers enough contrast', !placed.includes('class="assist"'));
ok(
  'a wash appears when it does not',
  renderSlideHtml(
    { nameHe: 'x', fields: [] },
    { style: 'minimal', spot: { x: 0.5, y: 0.5, width: 0.7, color: '#FFFFFF', onDark: true, assist: 0.8, shadow: 1 } }
  ).includes('class="assist"')
);

// The info style's ink never changes, so the placement search has to score
// contrast against cream rather than against whichever of white and black it
// might otherwise pick. Getting this wrong put a cream line on a sunlit
// snowfield with clear blue sky directly above it.
ok('the info style declares a fixed ink luminance', INK_LUMINANCE.info > 0.7);
eq('the minimal style leaves it to the measurement', INK_LUMINANCE.minimal, null);
eq('TikTok slides are 9:16', `${SIZES.tiktok.w}x${SIZES.tiktok.h}`, '1080x1920');
eq('Instagram slides are 4:5, because the feed crops anything taller', `${SIZES.instagram.w}x${SIZES.instagram.h}`, '1080x1350');
ok('a slide with no photograph still renders', renderSlideHtml({ nameHe: 'x', fields: [] }, { style: 'minimal' }).includes('linear-gradient'));
ok('HTML in a place name cannot break out of the template', renderSlideHtml(
  { nameHe: '<script>alert(1)</script>', fields: [], sourceHost: 'x.cz' },
  { style: 'minimal' }
).includes('&lt;script&gt;'));
ok('nor out of a field value', renderSlideHtml(
  { nameHe: 'x', fields: [{ emoji: '🗻', labelHe: 'גובה', value: '<img src=x onerror=1>' }] },
  { style: 'info' }
).includes('&lt;img'));

// The deck id has to be stable across re-runs or the same five museums stage
// twice, and has to change when the places do.
const idA = deckId(deckFixture.deck);
eq('the same places give the same id', idA, deckId({ ...deckFixture.deck, titleHe: 'a different title' }));
ok(
  'different places give a different id',
  idA !== deckId({ ...deckFixture.deck, slides: [{ ...deckFixture.deck.slides[0], qid: 'Q999' }] })
);

// Site restriction is an allowlist check, not a convenience: the same
// label-boundary rule the source allowlist uses.
ok('a subdomain of the site matches', sameSite('https://en.nm.cz/visit', 'nm.cz'));
ok('the bare site matches', sameSite('https://www.nm.cz/visit', 'nm.cz'));
ok('a lookalike domain does not', !sameSite('https://evil-nm.cz/visit', 'nm.cz'));
ok('nor does a suffixed one', !sameSite('https://nm.cz.attacker.com/visit', 'nm.cz'));

// Authority order is meaning: the place's own site outranks whoever runs it,
// which outranks whatever contains it.
eq(
  'authority domains come back closest-to-the-horse first',
  authorityDomains({
    officialUrl: 'https://www.nm.cz/en',
    operatorUrl: 'https://www.mkcr.cz',
    withinUrl: 'https://www.praha.eu',
    osmTags: {},
  }).join(','),
  'nm.cz,mkcr.cz,praha.eu'
);
eq('a place with nothing has no authority', authorityDomains({ osmTags: {} }).length, 0);

/* -------------------------------------------------------------------------- */
group('the guide page — a deck of trails is not a deck of whatever is on the page');

// The bug this group exists for.
//
// CATEGORY_HE had no line for `trail`, and an unmapped kind fell through to the
// permissive branch of pick(), which takes the WHOLE destination page. So
// "trails in the Dolomites" shipped as a valley, two lakes, a town, a museum
// town and Piazza delle Erbe market — under a cover calling them the most
// beautiful mountains in Italy.
//
// A missing line is invisible until a deck goes out wrong, so the table is held
// against the registry instead of being read by eye.
for (const id of Object.keys(KINDS)) {
  ok(`the guide page knows what a ${id} deck wants`, Array.isArray(CATEGORY_HE[id]) && CATEGORY_HE[id].length > 0);
}

// The site's real vocabulary, sampled off the live pages. A category we invent
// matches nothing and fails exactly as silently as a missing line — 'shopping'
// said 'קניות' for months while the site said 'שופינג'.
const SITE_CATEGORIES = [
  'טבע', 'אתר היסטורי', 'תצפית', 'אטרקציה', 'אוכל', 'אוכל כשר', 'שופינג', 'שוק', 'מוזיאון', 'בית קפה', 'גלריה', 'מסעדה', 'פארק', 'גן', 'קניות',
];
for (const [id, cats] of Object.entries(CATEGORY_HE)) {
  for (const c of cats) ok(`${id} asks for a category the site actually uses: ${c}`, SITE_CATEGORIES.includes(c));
}

// The Dolomites page, as it actually parses.
const guide = [
  { nameHe: 'שוק פיאצה דלה ארבה', category: 'שוק', rating: 4.6 },
  { nameHe: 'אגם סוראפיס', category: 'טבע', rating: 4.8 },
  { nameHe: 'בולצאנו ומוזיאון אצי', category: 'אתר היסטורי', rating: 4.5 },
  { nameHe: 'סאס פורדוי', category: 'תצפית', rating: 4.7 },
];
const names = (list) => list.map((p) => p.nameHe);

ok('a trail deck no longer takes the market', !names(pick(guide, { kind: 'trail', want: 9 })).includes('שוק פיאצה דלה ארבה'));
ok('nor the museum town', !names(pick(guide, { kind: 'trail', want: 9 })).includes('בולצאנו ומוזיאון אצי'));
ok('a food deck still gets the market', names(pick(guide, { kind: 'food', want: 9 })).includes('שוק פיאצה דלה ארבה'));

// A registered kind with nothing on the page returns nothing, so buildDeck
// falls through to the map — whose Overpass tags cannot answer a summit query
// with a market. Taking the whole page instead is the bug, not the fallback.
eq('a registered kind with no match yields nothing', pick(guide, { kind: 'museum', want: 9 }).length, 0);
// And the permissive branch survives for what it was written for: a deck of
// "the best of Prague", where no category was asked for at all.
eq('an unregistered kind still takes the page', pick(guide, { kind: 'best of', want: 9 }).length, 4);
eq('and so does no kind at all', pick(guide, { want: 9 }).length, 4);

// The filter must never fail CLOSED on a formatting detail.
//
// Entries go to the model as "name — description" so it can judge the subject,
// and it is asked for the name. Told to copy "exactly as given", it reasonably
// echoed the WHOLE line — and an exact-string lookup then matched none of its
// ten correct answers, so Prague built zero slides out of ten good quarters and
// castles. An empty result from a filter is indistinguishable from "everything
// was rejected", which is why this is checked rather than eyeballed.
const pragueish = [
  { nameHe: 'מאלה סטראנה' },
  { nameHe: 'מצודת וישהראד' },
  { nameHe: 'קוטנה הורה' },
  { nameHe: 'סאס פורדוי - מרפסת הדולומיטים' },
];
eq(
  'a name echoed with its description still matches',
  keepByName(pragueish, ['מאלה סטראנה — הרובע הבארוקי שמתחת למצודה']).length,
  1
);
eq('and a bare name matches too', keepByName(pragueish, ['מצודת וישהראד']).length, 1);
// A place whose OWN name contains a dash reduces the same way on both sides,
// so it still matches itself rather than being cut in half and lost.
eq(
  'a name with a dash in it survives the reduction',
  keepByName(pragueish, ['סאס פורדוי - מרפסת הדולומיטים'])[0]?.nameHe,
  'סאס פורדוי - מרפסת הדולומיטים'
);
eq('a name nobody asked for stays out', keepByName(pragueish, ['מאלה סטראנה']).length, 1);
eq('and asking for nothing keeps nothing', keepByName(pragueish, []).length, 0);

// "/deck Italy mountains" must not fail on the plural.
eq('a plural resolves to the registry name', canonicalKind('mountains'), 'mountain');
eq('and so does a synonym', canonicalKind('hiking'), 'trail');
ok('a resolved synonym reaches a real mapping', Boolean(CATEGORY_HE[canonicalKind('waterfalls')]));

// The model is asked for 5-7 and will occasionally ask for eleven; that is a
// misunderstanding of the format rather than a richer list.
eq('slide count is clamped, not trusted', normaliseIdea({ title_he: 'x', where: 'Prague', kind: 'museum', want: 11 }).want, 7);
eq('and clamped upwards too', normaliseIdea({ title_he: 'x', where: 'Prague', kind: 'museum', want: 2 }).want, 5);
eq('an idea in an unknown category is dropped', normaliseIdea({ title_he: 'x', where: 'p', kind: 'nightclub', want: 5 }), null);
ok(
  'em dashes are stripped from an idea title like everywhere else',
  !normaliseIdea({ title_he: 'פראג — מוזיאונים', where: 'Prague', kind: 'museum', want: 5 }).titleHe.includes('—')
);

/* -------------------------------------------------------------------------- */
group('copy style - hyphens only, never em or en dashes');

const EM = '—';
const EN = '–';
const NL = '\n';

eq('em dash becomes a spaced hyphen', hyphensOnly(`בין השוק לנמל ${EM} עשר דקות`), 'בין השוק לנמל - עשר דקות');
eq('en dash too', hyphensOnly(`ליסבון ${EN} פורטוגל`), 'ליסבון - פורטוגל');
eq('a numeric range stays tight', hyphensOnly(`2${EN}3 ימים`), '2-3 ימים');
eq('text without dashes is untouched', hyphensOnly('רגיל לגמרי'), 'רגיל לגמרי');
ok(
  'caption line breaks survive the substitution',
  hyphensOnly(`א ${EM} ב${NL}ג`).includes(NL),
  'a naive \\s* around the dash swallows the newline and flattens a multi-line caption'
);

/* -------------------------------------------------------------------------- */
group('instagram caption - short, no source URL, site line');

const capCand = {
  headline: 'העמק שנפתח רק 60 יום בשנה',
  subhead: 'ההרשמה נסגרת חודש מראש',
  // String.fromCharCode(10) rather than an escape: this file is edited by
  // scripts often enough that a literal backslash-n keeps getting mangled.
  caption: ['שאר השנה הדרך סגורה.', 'ההרשמה נפתחת בינואר.'].join(String.fromCharCode(10)),
  sourceUrl: 'https://www.govt.nz/some/very/long/path/that/nobody/can/tap',
};

const cap = instagramCaption(capCand);
ok('omits the source URL - nothing published carries one', !cap.includes('govt.nz'));
ok('omits the headline rather than repeating what the image already shows', !cap.includes(capCand.headline));
ok('keeps the caption body', cap.includes('ההרשמה נפתחת בינואר'));
ok('stays short', cap.length < 400, `${cap.length} chars`);

// The subhead is deliberately not on the card, so the description is the only
// place it can appear — and it opens it.
ok('carries the subhead, which the card no longer shows', cap.includes(capCand.subhead));
ok('the subhead comes first', cap.indexOf(capCand.subhead) < cap.indexOf('שאר השנה'));

// One fixed sign-off under every post, and no other link anywhere.
ok('carries the sign-off line', cap.includes('לסוכן הטיולים החכם שלנו'));
ok('carries the site', cap.includes('www.tiyulplus.com'));
ok('the sign-off is last', cap.trim().endsWith('www.tiyulplus.com'));
eq('exactly one link in the whole caption', (cap.match(/tiyulplus\.com/g) || []).length, 1);
ok('no scheme-prefixed URL anywhere', !/https?:\/\//.test(cap));

/* -------------------------------------------------------------------------- */
group('pexels stock provider');

{
  const realFetch = globalThis.fetch;
  const realKey = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'test-key';

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const searchUrls = [];
  let sentAuth = null;
  let downloaded = null;

  const photo = (over) => ({
    width: 3000, height: 4000, alt: 'Lisbon old town alley at sunset', photographer: 'Ada L',
    url: 'https://pexels.com/photo/1',
    src: { original: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg', portrait: 'https://images.pexels.com/p.jpg' },
    ...over,
  });

  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.pexels.com')) {
      searchUrls.push(String(url));
      sentAuth = opts.headers?.Authorization;
      return {
        ok: true,
        json: async () => ({
          photos: [
            photo({ width: 400, height: 600, photographer: 'Too Small' }),
            // Pexels' own first result: a person posing. Ranked below the scene.
            photo({ alt: 'Woman smiling in front of a tram in Lisbon', photographer: 'Portrait Guy' }),
            photo({ photographer: 'Ada L' }),
          ],
        }),
      };
    }
    downloaded = String(url);
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
    };
  };

  const { search, scorePhoto, pickBest, cropUrl } = await import('../src/images/pexels.js');
  const got = await search('Lisbon old town alley');

  ok('sends the API key as an Authorization header', sentAuth === 'test-key');
  ok('asks for portrait crops first - the card is 4:5, a landscape crop loses the subject', /orientation=portrait/.test(searchUrls[0] || ''));
  ok('inlines the bytes as a data URI rather than hotlinking', got?.src?.startsWith('data:image/jpeg;base64,'));
  eq('tags provenance as stock', got?.provenance, 'stock');
  ok('picks the scene over the person, not the first result', got?.credit?.includes('Ada L'));
  ok('skips photos narrower than the card', !/Too Small/.test(JSON.stringify(got)));
  ok('downloads an exact 1080x1350 crop from the CDN, not the 800x1200 portrait', /w=1080/.test(downloaded) && /h=1350/.test(downloaded) && /fit=crop/.test(downloaded));
  eq('an empty query returns null rather than searching', await search('  '), null);

  // Ranking on its own, no network.
  const scene = photo({});
  const person = photo({ alt: 'Man posing with a selfie stick in Lisbon' });
  const product = photo({ alt: 'Lisbon souvenir coffee cup mockup' });
  const wide = photo({ width: 6000, height: 2000 });
  ok('a described scene outranks a person in front of it', scorePhoto(scene, 'Lisbon old town alley') > scorePhoto(person, 'Lisbon old town alley'));
  ok('a product shot ranks below zero and is refused', scorePhoto(product, 'Lisbon old town alley') < 0);
  ok('portrait outranks a wide landscape of the same scene', scorePhoto(scene, 'Lisbon alley') > scorePhoto(wide, 'Lisbon alley'));
  eq('nothing acceptable means null, so the caller can broaden the query', pickBest([person, product], 'Lisbon alley'), null);
  ok('cropUrl keeps the original and adds the crop parameters', cropUrl(scene).startsWith('https://images.pexels.com/photos/1/pexels-photo-1.jpeg?'));
  ok('cropUrl falls back to a generic size without an original', cropUrl({ src: { large2x: 'https://x/l.jpg' } }) === 'https://x/l.jpg');

  // The second pass: the portrait search finds nothing usable, any orientation does.
  searchUrls.length = 0;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.pexels.com')) {
      searchUrls.push(String(url));
      calls++;
      return { ok: true, json: async () => ({ photos: calls === 1 ? [person] : [wide] }) };
    }
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => jpeg.buffer.slice(0, 6) };
  };
  const second = await search('Lisbon alley');
  eq('a portrait miss triggers a second, unconstrained search', searchUrls.length, 2);
  ok('the second search carries no orientation', !/orientation=/.test(searchUrls[1]));
  ok('and its landscape result is used rather than a text card', Boolean(second?.src));

  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = realKey;
}

/* -------------------------------------------------------------------------- */
group('image query fallback chain');

{
  const qs = imageQueries({ imageQuery: 'Kyoto wooden bridge', imageQueryAlt: 'Kyoto autumn temple', placeEn: 'Kyoto', countryEn: 'Japan' });
  eq('most specific first', qs[0], 'Kyoto wooden bridge');
  eq('then the broader one the model supplied', qs[1], 'Kyoto autumn temple');
  ok('then the place by name', qs.some((q) => q === 'Kyoto Japan landmark'));
  ok('and the country as a last resort', qs.at(-1) === 'Japan travel scenery');
  eq('no duplicates', new Set(qs).size, qs.length);
  eq('nothing to search for is an empty list, not [""]', imageQueries({}).length, 0);
  eq('a country alone still yields searches', imageQueries({ countryEn: 'Japan' }).length, 2);
}

/* -------------------------------------------------------------------------- */
group('copy shape — the exemplar passes, its failure modes do not');

{
  const exemplar = {
    headline: 'החודשים שבהם הזוהר הצפוני עובד לטובתכם',
    subhead: 'סביב השוויונים - ספטמבר ומרץ - הגיאומטריה המגנטית פשוט נוחה יותר.',
    caption:
      'זוהר אפשר לראות בכל חודש בשנה, אבל סביב השוויונים הזווית בין השדה המגנטי של כדור הארץ לרוח השמש מעבירה אנרגיה פנימה ביעילות - האפקט נקרא ראסל-מקפרון. ואם יצא לכם לראות סגול ולא ירוק: זה פשוט צבעים של גזים שונים שמתערבבים בעין. 💜 #זוהרצפוני #מתיטסים',
  };
  ok('the post that set the standard passes every check', verifyDraftText(exemplar) === true);

  ok('a one-word headline is too short', Boolean(headlineLength({ headline: 'ליסבון' })));
  ok('a twelve-word headline is a sentence', Boolean(headlineLength({ headline: 'א ב ג ד ה ו ז ח ט י כ ל' })));
  eq('six words is fine', headlineLength(exemplar), null);
  throws('rejected as headline_length', () => verifyDraftText({ ...exemplar, headline: 'ליסבון' }), 'headline_length');

  ok('six sentences is an article', Boolean(captionLength({ caption: 'א. ב. ג. ד. ה. ו.' })));
  ok('five hundred characters is an article', Boolean(captionLength({ caption: 'א'.repeat(500) })));
  eq('hashtags do not count toward the length', captionLength({ caption: 'משפט אחד. ' + '#תג '.repeat(3) }), null);
  throws('rejected as caption_too_long', () => verifyDraftText({ ...exemplar, caption: 'א. ב. ג. ד. ה. ו. ז.' }), 'caption_too_long');

  ok('"מדהים" is filler', Boolean(fillerAdjective({ headline: 'הנוף המדהים של ליסבון' })));
  ok('a prefixed form is still filler', Boolean(fillerAdjective({ caption: 'והמרהיבים שבהם' })));
  ok('"בלתי נשכח" is filler', Boolean(fillerAdjective({ caption: 'חוויה בלתי נשכחת' })));
  eq('a specific noun is not', fillerAdjective({ caption: 'השוק בשבת בבוקר' }), null);
  throws('rejected as filler_adjective', () => verifyDraftText({ ...exemplar, subhead: 'נוף מרהיב.' }), 'filler_adjective');

  ok('a headline ending in ? is rhetorical', Boolean(rhetoricalOpening({ headline: 'למה ליסבון?' })));
  ok('"ידעתם ש" is an opening the brief forbids', Boolean(rhetoricalOpening({ headline: 'x', caption: 'ידעתם שבליסבון יש חשמלית? כן.' })));
  ok('a caption opening on a question is rhetorical', Boolean(rhetoricalOpening({ headline: 'x', caption: 'רוצים לדעת מה? הנה.' })));
  eq('a question later in the caption is allowed', rhetoricalOpening({ headline: 'x', caption: 'השוק פתוח בשבת. למה? כי כן.' }), null);
  throws('rejected as rhetorical_opening', () => verifyDraftText({ ...exemplar, headline: 'מתי הזוהר הצפוני עובד לטובתכם?' }), 'rhetorical_opening');
}

/* -------------------------------------------------------------------------- */
group('normalise — what is fixed for free rather than re-drafted');

{
  eq('emoji leave the headline', stripEmoji('הזוהר 💜 הצפוני ✨'), 'הזוהר הצפוני');
  eq('three hashtags stay', capHashtags('טקסט. 💜 #א #ב #ג'), 'טקסט. 💜 #א #ב #ג');
  eq('a fourth and fifth are trimmed', capHashtags('טקסט. 💜 #א #ב #ג #ד #ה'), 'טקסט. 💜 #א #ב #ג');

  const item = { pillarHints: ['inCity'] };
  const base = { usable: true, layout: 'fact', headline: 'x', place_en: 'Lisbon', country_en: 'Portugal', image_query: '' };
  eq('a fact card about a named place becomes a photo card when images are available', normalise(base, item, { imagesAvailable: true }).layout, 'photoFull');
  eq('...but not when they are not', normalise(base, item, { imagesAvailable: false }).layout, 'fact');
  eq('...and not when the post names nowhere', normalise({ ...base, place_en: '', country_en: '' }, item, { imagesAvailable: true }).layout, 'fact');
  eq('the alert layout is left alone', normalise({ ...base, layout: 'alert' }, item, { imagesAvailable: true }).layout, 'alert');
  const n = normalise({ ...base, image_query: 'Lisbon tram', image_query_alt: 'Lisbon skyline' }, item, { imagesAvailable: true });
  eq('the second image query is carried', n.imageQueryAlt, 'Lisbon skyline');
  eq('the English place is carried', n.placeEn, 'Lisbon');
}

/* -------------------------------------------------------------------------- */
group('feed parsing — a full-text feed is not an entity bomb');

{
  // Three of the first six official tourism feeds probed carried escaped HTML
  // summaries with more than 1,000 entities between them, and the parser's
  // default budget rejected the whole feed. A billion-laughs document is
  // stopped by depth, not by count.
  const item = (i) =>
    `<item><title>Post ${i}</title><link>https://example.gov/${i}</link><description>${'&lt;p&gt;a &amp; b&lt;/p&gt;'.repeat(60)}</description></item>`;
  const body = `<?xml version="1.0"?><rss><channel><title>t</title>${Array.from({ length: 12 }, (_, i) => item(i)).join('')}</channel></rss>`;
  let parsed = null;
  let err = null;
  try {
    parsed = parseFeed(body, { id: 'x', name: 'x', authority: 'government', lang: 'en', pillars: [] });
  } catch (e) {
    err = e;
  }
  ok('a feed with thousands of ordinary entities parses', !err, err?.message);
  eq('all twelve items survive', parsed?.length, 12);
  ok('and the escaped HTML is decoded to text', parsed?.[0]?.summary.includes('a & b'));
}

/* -------------------------------------------------------------------------- */
group('ranking — what a title alone can rule out');

{
  const base = { authority: 'government', publishedAt: new Date().toISOString(), pillarHints: [], summary: 'x'.repeat(300) };
  const sc = (title) => scoreItem({ ...base, title });
  ok('a fatality comes last, however fresh and official', sc('Two Deceased Hikers Recovered and Identified Following Flash Flood') < sc('Timed entry reservations return in May'));
  ok('an MoU signing is trade noise', sc('Visit Maldives and Emirates sign MoU to strengthen tourism promotion') < sc('The night market reopens on the riverbank'));
  ok('a travel mart is trade noise', sc('TAT strengthens global golf tourism connections at Thailand Golf Travel Mart 2026') < sc('The night market reopens on the riverbank'));
  ok('a named destination is nudged up', sc('The Odeon of Herodes Atticus in Athens closes for restoration') > sc('The Odeon closes for restoration'));
  ok('a comedian is not a trip', sc('Elena Gabrielle: comedy special, live') < sc('Elena Gabrielle: the square'));
}

/* -------------------------------------------------------------------------- */
group('registry integrity');

const reg = registry();
ok('every source has an id, kind and note', reg.sources.every((s) => s.id && s.kind && s.note));
ok('every enabled source has an implemented adapter', reg.sources.filter((s) => s.enabled).every((s) => ['rss', 'climate'].includes(s.kind)));
ok('ids are unique', new Set(reg.sources.map((s) => s.id)).size === reg.sources.length);

/* -------------------------------------------------------------------------- */
// Last, and slowest: the guard that was silently broken. Needs Chromium but no
// network. Checked in both directions, because the whole point is that the
// obvious version of this check passed in both.
/* -------------------------------------------------------------------------- */
group('measured facts — the numbers a mountain has instead of a website');

const METRE = { amount: '+3967', unit: 'http://www.wikidata.org/entity/Q11573' };
eq('an elevation in metres reads as metres', lengthValue(METRE, 'm'), '3,967 מ׳');
eq(
  'feet are normalised rather than printed',
  lengthValue({ amount: '+14692', unit: 'http://www.wikidata.org/entity/Q3710' }, 'm'),
  '4,478 מ׳'
);
eq(
  'a trail in metres is stated in kilometres',
  lengthValue({ amount: '+5300', unit: 'http://www.wikidata.org/entity/Q11573' }, 'km'),
  '5.3 ק"מ'
);
// Wikidata's default unit for a bare quantity is "1", and guessing metres from
// that is how a slide ends up claiming a hill is four kilometres high.
eq('an unrecognised unit is refused, not guessed', lengthValue({ amount: '+900', unit: 'http://www.wikidata.org/entity/Q99' }, 'm'), null);
eq('and so is a missing amount', lengthValue({ unit: 'x' }, 'm'), null);

// Wikidata pads years to four digits; "נבנה: 0778" went out on a slide.
eq('a padded year loses its padding', yearValue({ time: '+0778-00-00T00:00:00Z' }), '778');
eq('a modern year is unchanged', yearValue({ time: '+1601-01-01T00:00:00Z' }), '1601');
eq('a year BCE says so rather than showing a minus', yearValue({ time: '-0447-00-00T00:00:00Z' }), '447 לפנה"ס');

const peakClaims = {
  P2044: [{ mainsnak: { datavalue: { value: METRE } } }],
  P17: [{ mainsnak: { datavalue: { value: { id: 'Q39' } } } }],
};
const peakLabels = new Map([['Q39', { he: 'שווייץ', iso: 'CH' }]]);
const peakFields = factsFor('mountain', peakClaims, { labels: peakLabels });
eq('a summit carries its height', peakFields[0].value, '3,967 מ׳');
eq('labelled in Hebrew', peakFields[0].labelHe, 'גובה');
// The flag beside the name already says the country; a field saying it again is
// the same fact twice, and five times over a one-country deck.
ok('and no country field, because the flag already says it', !peakFields.some((f) => f.key === 'country'));

const swiss = countryFor(peakClaims, peakLabels);
eq('the country resolves to Hebrew', swiss.he, 'שווייץ');
eq('and to its flag', swiss.flag, '🇨🇭');
eq('a place with no country claim says so', countryFor({}, peakLabels).flag, null);

// "Tromsø, Norway" earns the word because the next slide says Finland. Six
// Swiss summits do not.
const oneCountry = [{ countryHe: 'שווייץ', flag: '🇨🇭' }, { countryHe: 'שווייץ', flag: '🇨🇭' }];
applyCountryVisibility(oneCountry);
ok('a one-country deck drops the repeated word', oneCountry.every((s) => s.countryHe === null));
ok('but keeps the flag, which is what makes the set look like a set', oneCountry.every((s) => s.flag));
const manyCountries = [{ countryHe: 'נורווגיה' }, { countryHe: 'פינלנד' }];
applyCountryVisibility(manyCountries);
ok('a cross-country deck keeps it', manyCountries.every((s) => s.countryHe));

ok('a deck whose slides mostly have fields is an info deck', enoughFor([{ fields: [1] }, { fields: [1] }, { fields: [] }]));
ok('one where they mostly do not is not', !enoughFor([{ fields: [1] }, { fields: [] }, { fields: [] }]));
ok('and an empty deck is not', !enoughFor([]));

// Artwork for every emoji a slide can draw, checked rather than assumed.
//
// The whole reason the set is committed rather than left to the machine's own
// emoji font is that a missing glyph does not error, it renders as a box — and
// a slide full of boxes screenshots perfectly happily. Adding a field to
// WIKIDATA_FIELDS without running `npm run fetch-emoji` is the obvious way to
// reintroduce that, so the specs are checked against the files on disk.
for (const [kind, spec] of Object.entries(WIKIDATA_FIELDS)) {
  for (const f of spec) {
    ok(`${kind}/${f.key} has artwork for ${f.emoji}`, Boolean(emojiDataUri(f.emoji)));
  }
}
// Flags are the ones most likely to be missing: noto-emoji keeps them in a
// different directory, in a different format, and every one of them 404s at the
// path the pictograms come from — which is how the whole set came to be absent.
for (const iso of ['IT', 'CH', 'JP', 'NO', 'GR', 'IS', 'CZ']) {
  ok(`the ${iso} flag has artwork`, Boolean(emojiDataUri(flagFor(iso))));
}
eq('an ISO code becomes a flag', flagFor('it'), '🇮🇹');
eq('and nonsense does not', flagFor('xyz'), null);

/* -------------------------------------------------------------------------- */
group('Hebrew names — a Latin name on a Hebrew slide is the loudest tell there is');

ok('Hebrew passes', isHebrew('מאטרהורן'));
ok('Hebrew with a space and a comma passes', isHebrew('אלפה די סיוזי, איטליה'));
ok('Latin is refused', !isHebrew('Piz Bernina'));
// The failure that actually shipped: a transliteration that kept one Latin word.
ok('and so is a mixture, which is how "Aletschhorn" survived', !isHebrew('הר Aletschhorn'));
ok('an empty answer is refused', !isHebrew(''));
ok('so is whitespace', !isHebrew('   '));

/* -------------------------------------------------------------------------- */
group('module surfaces — a deleted export must not fail silently');

// A careless edit to deck/ideas.js removed hasApiKey and proposeIdeas along
// with the function it meant to replace. Nothing caught it: the tests did not
// import them, the renderer does not use them, and the only caller is the /deck
// command with no argument — which would have thrown at runtime, in the bot, on
// the one path nobody exercises while iterating on slides.
//
// Checked as a list rather than by importing each one, so the failure names the
// missing symbol instead of taking the whole suite down with a module error.
for (const [mod, expected] of [
  ['../src/deck/ideas.js', ['hasApiKey', 'proposeIdeas', 'reviseIdea', 'coverForDeck', 'titleForRequest', 'normaliseIdea', 'rotationFor', 'oneClause', 'emphasisFrom']],
  ['../src/deck/build.js', ['buildDeck', 'buildDeckFromSite', 'fillImages', 'draftSlide', 'findPage']],
  ['../src/deck/facts.js', ['factsFor', 'countryFor', 'enoughFor', 'applyCountryVisibility', 'lengthValue', 'yearValue']],
  ['../src/render/deck.js', ['renderDeck', 'renderDeckSize', 'slideStem']],
  ['../src/render/photo.js', ['analyseSlides', 'measureCardScrims', 'scrimAlpha', 'underScrim']],
  ['../src/render/deckTemplates.js', ['renderSlideHtml', 'SIZES', 'FACES', 'INK_LUMINANCE']],
  ['../src/deck/attempt.js', ['buildWithFallback', 'describeAttempt']],
  ['../src/deck/request.js', ['resolveRequest', 'parseLocally']],
  ['../src/deck/hebrew.js', ['hebrewNames', 'isHebrew']],
  ['../src/deck/region.js', ['deckPlace', 'namesPlace', 'REGIONS']],
  ['../src/images/textbox.js', ['findTextRegion']],
]) {
  const loaded = await import(mod).catch((e) => ({ __error: e.message }));
  if (loaded.__error) {
    ok(`${mod} loads`, false, loaded.__error);
    continue;
  }
  for (const name of expected) {
    ok(`${mod.split('/').pop()} still exports ${name}`, typeof loaded[name] !== 'undefined');
  }
}

/* -------------------------------------------------------------------------- */
group('covers — variety is a property of the sequence, not of one call');

// A model asked once per deck cannot see the previous deck, so "vary it" in a
// brief converges on its favourite phrasing — which is how six decks in a row
// came back "טופ N ... שאסור לפספס". The shape and voice are therefore chosen
// outside the call and handed down.
// An example beats a rule, so the examples have to obey the rules.
//
// The brief says a number on a cover is written as a numeral and never spelled
// out — and one of the shape examples read "איסלנד בחמישה מפלים", three
// paragraphs below that rule. The model copied the example, not the rule, and
// shipped "האלפים של ברן בשישה הרים". Everything handed to the model as an
// exemplar is checked against the rule it is meant to illustrate.
const SPELLED_OUT = /\b(?:שניים|שתיים|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה|תשעה|תשע|עשרה|עשר)\b/;
for (const shape of COVER_SHAPES) {
  for (const example of shape.examples) {
    ok(`the ${shape.id} example writes its number as a numeral`, !SPELLED_OUT.test(example), example);
  }
}
for (const voice of Object.values(COVER_VOICES)) {
  ok(`the ${voice.id} example does too`, !SPELLED_OUT.test(voice.example), voice.example);
}

// A counter, not a hash of the deck.
//
// Hashing made the choice stable across re-runs, which nothing needed — the
// deck id is built from the region, the category and the place ids, and
// deliberately not from the title. What it cost was collisions: seven decks
// drawing independently from six buckets put four on the same picture and
// returned the identical closing phrase twice, which is the exact thing the
// rotation exists to prevent. A counter cannot collide.
const seq = Array.from({ length: 30 }, (_, i) => rotationFor(i));

ok('consecutive posts differ in shape', seq[0].shape.id !== seq[1].shape.id);
// Not voice: it follows the shape, and two impersonal shapes can sit next to
// each other. Three of the four covers the channel was specified by are
// impersonal, so that is the common case rather than a fault.
// The voice belongs to the shape rather than rotating beside it. Spun
// independently it put "אתם" on a shape with no room for it —
// "פסגות שאתם לא תאמינו שהן אמיתיות" where the spec says
// "הרים שלא נראים אמיתיים".
eq('the unreal shape is impersonal', seq[0].voice.id, 'none');
eq('the obligation shape takes the pronoun', seq[2].voice.id, 'you');
ok('every shape declares its voice', COVER_SHAPES.every((sh) => COVER_VOICES[sh.voice]));
// In the four covers the channel was specified by, "אתם" appears exactly once.
const pronouns = COVER_SHAPES.filter((sh) => sh.voice === 'you').length;
ok('most shapes carry no pronoun', pronouns <= 2);

eq('every shape is reachable', new Set(seq.map((r) => r.shape.id)).size, COVER_SHAPES.length);
eq('and both voices are used', new Set(seq.map((r) => r.voice.id)).size, Object.keys(COVER_VOICES).length);
// Most covers carry no count and name nowhere. The counted shape exists because
// the channel's own first example was "טופ 4 פסגות שאסור לפספס באלפים", but a
// list built AROUND counts and place names had every cover rejected.
const counted = seq.slice(0, 10).filter((r) => r.shape.id === 'top-n').length;
eq('one cover in five carries a count', counted, 2);
// Obligation is no longer rationed by a flag — it is one of the five shapes,
// which is what the channel's own examples do with it.
ok('obligation is a shape of its own', COVER_SHAPES.some((sh) => sh.id === 'urgency'));
ok('and so is the superlative', COVER_SHAPES.some((sh) => sh.id === 'superlative'));

// Nonsense in, first entry out, rather than a crash — the caller passes a count
// that could be absent on a fresh store.
eq('a missing count starts at the beginning', rotationFor(undefined).shape.id, seq[0].shape.id);
eq('and so does rubbish', rotationFor('x').shape.id, seq[0].shape.id);

// "One line, not a title plus a subtitle" was in the brief from the start and a
// cover still came back as "סנטוריני שאתם לא מכירים: חורבות ומצודות מול הים".
// The half before the colon is the line that was wanted.
eq(
  'a cover split by a colon keeps its first half',
  oneClause('סנטוריני שאתם לא מכירים: חורבות ומצודות מול הים'),
  'סנטוריני שאתם לא מכירים'
);
eq('a clean line is untouched', oneClause('6 מפלים באיסלנד שלא נראים אמיתיים'), '6 מפלים באיסלנד שלא נראים אמיתיים');
// Half of a short title is not a title, so a stub is refused and the whole
// line kept — better an awkward cover than a two-word one.
eq('but a stub is refused', oneClause('פראג: שישה מקומות'), 'פראג: שישה מקומות');
// Told not to use a colon, the next cover used a comma for the same splice.
eq(
  'a comma splice is cut the same way',
  oneClause('הסנטוריני שאתם לא מכירים, חורבות ומצודות'),
  'הסנטוריני שאתם לא מכירים'
);

// Cutting the splice can take the model's chosen emphasis with it, which left
// one cover with nothing set in colour. The closing clause is what should have
// been coloured anyway, and in Hebrew it opens with ש.
eq('the closing clause is recoverable', emphasisFrom('הסנטוריני שאתם לא מכירים'), 'שאתם לא מכירים');
eq('and from a longer line too', emphasisFrom('6 מפלים באיסלנד שלא נראים אמיתיים'), 'שלא נראים אמיתיים');
// No ש-clause: the last two words carry it.
eq('otherwise the tail does', emphasisFrom('6 פינות בפראג עם גגות כתומים'), 'גגות כתומים');
eq('a title too short to split gives nothing', emphasisFrom('פראג'), '');

/* -------------------------------------------------------------------------- */
group('where a deck is — the cover has to say it, so it has to be worked out');

// Six Icelandic waterfalls went out under "מפלים שאתם חייבים לראות פעם אחת
// בחיים". Every slide was in one country and the cover named nowhere, which is
// the one thing a viewer needed in order to save the post.
const ice = [
  { nameHe: 'סקוגאפוס', iso: 'IS', countryHe: 'איסלנד' },
  { nameHe: 'גודפוס', iso: 'IS', countryHe: 'איסלנד' },
  { nameHe: 'דטיפוס', iso: 'is', countryHe: 'איסלנד' },
];
eq('one country is named', deckPlace(ice, { kind: 'waterfall' }).he, 'איסלנד');
eq('and it is a country, not an area', deckPlace(ice, { kind: 'waterfall' }).scope, 'country');

// "even if all countries are nordic, the title should say in the nordics".
const nordic = [
  { iso: 'NO', countryHe: 'נורווגיה' },
  { iso: 'SE', countryHe: 'שוודיה' },
  { iso: 'IS', countryHe: 'איסלנד' },
];
eq('three nordic countries are one area', deckPlace(nordic).he, 'סקנדינביה');
eq('and it is an area, not a country', deckPlace(nordic).scope, 'region');

// Only when nothing is shared does the cover name nowhere.
eq(
  'places on different continents share nothing',
  deckPlace([{ iso: 'IS' }, { iso: 'JP' }, { iso: 'PE' }]).scope,
  'none'
);
eq('and nothing is what it offers', deckPlace([{ iso: 'IS' }, { iso: 'JP' }]).he, null);

// The SMALLEST covering group, not the first one that fits. Norway and Sweden
// are in Europe as well as in Scandinavia, and "באירופה" for two Nordic
// countries is the vaguer of two true answers.
eq('the tightest grouping wins', deckPlace([{ iso: 'NO' }, { iso: 'SE' }]).he, 'סקנדינביה');
// Italy and Norway have no region between them, and the continent is the last
// thing true of both.
eq('a continent is the last resort', deckPlace([{ iso: 'IT' }, { iso: 'NO' }]).he, 'אירופה');

// The one grouping that asks what the deck is about. A museum in Vienna is not
// in the Alps; a summit above it is.
eq('a cross-border summit deck is alpine', deckPlace([{ iso: 'CH' }, { iso: 'AT' }], { kind: 'mountain' }).he, 'האלפים');
eq(
  'the same two countries of museums are not',
  deckPlace([{ iso: 'CH' }, { iso: 'AT' }], { kind: 'museum' }).he,
  'מרכז אירופה'
);

// The tiyulplus route has no Wikidata entity and therefore no ISO code; it
// resolves one country for the whole deck and writes the Hebrew name onto every
// slide. That has to reach the cover too.
eq(
  'a deck with names but no codes still has a country',
  deckPlace([{ countryHe: 'צ׳כיה' }, { countryHe: 'צ׳כיה' }]).he,
  'צ׳כיה'
);
eq('an empty deck is nowhere', deckPlace([]).scope, 'none');
// A slide with no country does not vote. Filling it in from the region the deck
// was searched in is a guess, and the guess that adds a country is the one that
// turns "באיסלנד" into "בסקנדינביה".
eq('a slide with no country abstains', deckPlace([{ iso: 'IS' }, {}, { iso: 'IS' }]).he, 'איסלנד');

// Every region has to be sayable in Hebrew and reachable.
for (const r of REGIONS) {
  ok(`${r.id} is written in Hebrew`, isHebrew(r.he), r.he);
  ok(`${r.id} has countries in it`, r.isos.length >= 2);
}
// Smallest wins, so the list is written smallest first and reads in the order
// it resolves in.
const sizes = REGIONS.map((r) => r.isos.length);
ok('the groupings are declared smallest first', sizes.every((n, i) => i === 0 || n >= sizes[i - 1]), sizes.join(','));

// Two groupings of the same size that shared a country would be resolved by
// declaration order, which is a coin toss dressed as a rule. Same size is fine
// as long as they cannot both cover one deck.
for (const a of REGIONS) {
  for (const b of REGIONS) {
    if (a === b || a.isos.length !== b.isos.length) continue;
    ok(
      `${a.id} and ${b.id} are the same size and cannot both win`,
      !a.isos.some((c) => b.isos.includes(c))
    );
  }
}

// France and Germany: the same pair of countries, two different answers,
// because a summit between them is in the Alps and a museum in either is not.
eq('a cross-border summit deck gets the range',
  deckPlace([{ iso: 'FR' }, { iso: 'DE' }], { kind: 'mountain' }).he, 'האלפים');
eq('and the same two countries of museums get the half-continent',
  deckPlace([{ iso: 'FR' }, { iso: 'DE' }], { kind: 'museum' }).he, 'מערב אירופה');

// The check that closes the loop: the model writes the place with a preposition
// on it, so the cover is matched on the substring rather than on equality.
ok('a country with ב in front of it counts', namesPlace('המפלים הכי יפים באיסלנד', 'איסלנד'));
ok('and an area does too', namesPlace('המפלים הכי יפים בסקנדינביה', 'סקנדינביה'));
ok('a cover that names nowhere does not', !namesPlace('מפלים שאתם חייבים לראות', 'איסלנד'));
// ב absorbs a definite ה, so "הפיליפינים" is written "בפיליפינים" and a plain
// includes() would fail a perfectly good cover.
ok('the definite article is absorbed by the preposition', namesPlace('החופים הכי יפים בפיליפינים', 'הפיליפינים'));
// Checked WITH the ב attached, so stripping the ה cannot match a country whose
// name merely begins with one: "הודו" is not satisfied by a line that happens
// to contain the letters ודו.
ok('a stem on its own is not a match', !namesPlace('מקומות יפים עם ודו בשם', 'הודו'));
ok('nothing asked for is always satisfied', namesPlace('כל דבר', ''));

/* -------------------------------------------------------------------------- */
group('deck requests — the command has to answer with a slideshow');

eq('the category at the end is found', parseLocally('Prague museum')?.kind, 'museum');
eq('and the region with it', parseLocally('Prague museum')?.where, 'Prague');
// "/deck Italy mountains" is what people actually type.
eq('a plural at the end is found too', parseLocally('Dolomites trails')?.kind, 'trail');
eq('a category at the START is found', parseLocally('mountains Italy')?.kind, 'mountain');
eq('with the rest as the region', parseLocally('mountains Italy')?.where, 'Italy');
// Not a failure — a request the model is asked to interpret rather than one the
// command rejects. Answering a typed request with a grammar complaint is the
// behaviour being removed.
eq('a phrase with no category is handed upwards', parseLocally('japan autumn'), null);
eq('and so is a single word', parseLocally('Santorini'), null);

/* -------------------------------------------------------------------------- */
group('scrims — sized to the photograph, not to the worst photograph');

// The complaint: Instagram cards sometimes come out too dark. "Sometimes" is
// the tell — the scrim was a constant sized for a white sky, so over a
// photograph that was already dark it painted near-black onto near-black and
// the bottom half of the picture stopped existing.
const bright = scrimAlpha(0.6);
const dim = scrimAlpha(0.05, { floor: 0.34 });
ok('a blown-out sky still gets a heavy scrim', bright > 0.6, bright);
ok('an already-dark photograph gets a light one', dim <= 0.4, dim);
ok('and darker photographs never ask for more than brighter ones',
  scrimAlpha(0.05) <= scrimAlpha(0.25) && scrimAlpha(0.25) <= scrimAlpha(0.6));

// The floor is not a legibility number. Without it a dark photograph gets no
// scrim at all, which is legible and reads as an accident rather than as a
// block of type.
eq('the floor holds when no darkening is needed', scrimAlpha(0.02, { floor: 0.34 }), 0.34);
// And the ceiling holds when no amount would be enough, rather than running off
// the end of the search.
eq('the ceiling holds when nothing would be enough', scrimAlpha(1, { want: 99 }), 0.97);

// Composited the way the browser composites it. Averaging the LINEAR
// luminances instead reports a scrim as darker than it renders, which would
// size every scrim too light — the opposite failure, and a worse one.
ok('a scrim at full strength lands on the scrim colour',
  Math.abs(underScrim(0.9, 1) - 0.0124) < 0.001);
eq('and at zero it changes nothing', Number(underScrim(0.42, 0).toFixed(4)), 0.42);
ok('the sRGB midpoint is darker than the linear one would be',
  underScrim(0.6, 0.5) < (0.6 + 0.0124) / 2);

// The scrim the measurement produced has to actually reach the stylesheet, and
// a card that could not be measured has to fall back to the old constants
// rather than to no scrim at all.
const lit = renderHtml(
  { pillar: 'discover', layout: 'photoFull', headline: 'כותרת', place: 'ונציה' },
  { image: { src: 'data:image/jpeg;base64,x', scrim: { bottom: 0.4, top: 0.2 } } }
);
ok('a measured scrim reaches the gradient', lit.includes(`rgba(${SCRIM_INK},0.400)`), lit.match(/scrim-bottom[\s\S]{0,180}/)?.[0]);
ok('and so does the top one', lit.includes(`rgba(${SCRIM_INK},0.200)`));
const unlit = renderHtml(
  { pillar: 'discover', layout: 'photoFull', headline: 'כותרת', place: 'ונציה' },
  { image: { src: 'data:image/jpeg;base64,x' } }
);
ok('an unmeasured card falls back to the constants', unlit.includes(`rgba(${SCRIM_INK},${SCRIM_FALLBACK.bottom.toFixed(3)})`));
// The scrim is NOT the ink. Over a photograph at 97% the ink's deliberate green
// cast stops being a ground and becomes a filter on every shadow in the picture.
ok('and the scrim is not the flat-card ink', SCRIM_INK !== '16,32,31');
ok('rather than to no scrim at all', unlit.includes('scrim-bottom'));

// TikTok draws a caption in white across the foot of the frame and a search bar
// across the top; Instagram draws neither. The band that protects those is a
// TikTok band, and applying it to the Instagram render darkened the bottom
// fifth of every slide for furniture that is not there.
const tikScrim = renderSlideHtml({ nameHe: 'x', fields: [] }, { size: 'tiktok', style: 'minimal' });
const igScrim = renderSlideHtml({ nameHe: 'x', fields: [] }, { size: 'instagram', style: 'minimal' });
ok('the TikTok slide darkens its foot for the caption bar', tikScrim.includes('rgba(4,10,12,0.42) 100%'));
ok('the Instagram slide does not', !igScrim.includes('rgba(4,10,12,0.42) 100%'));
ok('and takes only the edge off the sky', igScrim.includes('rgba(4,10,12,0.12) 100%'));
// An unknown size is a TikTok slide, which is the shape the deck is designed
// for — never an unscrimmed one.
ok('an unknown size keeps the TikTok scrim',
  renderSlideHtml({ nameHe: 'x', fields: [] }, { size: 'nonsense', style: 'minimal' }).includes('rgba(4,10,12,0.42) 100%'));

/* -------------------------------------------------------------------------- */
group('placement — measured off the photograph, not guessed at');

// White until the frame is genuinely pale. Strict contrast arithmetic flips to
// near-black above about 0.22 luminance, which is most skies, and near-black
// lettering on a mid grey-blue sky reads as a watermark.
ok('light type over a dark frame', photoTest.colourFor({ mean: 0.05, sat: 0.1 }, null).color === '#FFFFFF');
ok('light type still, over a mid-tone sky', photoTest.colourFor({ mean: 0.3, sat: 0.1 }, null).color === '#FFFFFF');
ok('dark type only once the frame is genuinely pale', photoTest.colourFor({ mean: 0.7, sat: 0.1 }, null).color === '#14110E');

// Judged on the worst BAND the block crosses, not on its average. A cover over
// bright sky at the top and dark rock at the bottom averages to a comfortable
// mid-tone, and its last line disappears into the mountain — which it did.
const split = photoTest.colourFor({ mean: 0.42, lo: 0.12, hi: 0.72, sat: 0.2 }, null);
ok('a block spanning sky and rock knows it is in trouble', split.contrast < 4.5);
ok('and calls for the wash', split.assist > 0);
// Cream is the same luminance as a bright sky, so the coloured phrase has to be
// refused there rather than set in something invisible.
eq('no cream accent across a band it cannot survive', split.accent, null);
ok('an evenly dark block still gets one', photoTest.colourFor({ mean: 0.12, lo: 0.1, hi: 0.15, sat: 0.3 }, null).accent !== null);
// Not pure black: a true #000 over a photograph reads as a hole punched in it.
ok('and it is not pure black', photoTest.colourFor({ mean: 0.9, sat: 0.1 }, null).color !== '#000000');

// The shadow is the first line of defence and it is invisible; the wash is the
// last and has to stay rare, or every slide grows a panel.
ok('a clean dark frame needs no help at all', photoTest.colourFor({ mean: 0.02, sat: 0.1 }, null).assist === 0);
ok('a frame with nothing left to give gets a wash', photoTest.colourFor({ mean: 0.42, sat: 0.1 }, null).assist > 0);
ok(
  'and the shadow works harder before the wash appears',
  photoTest.colourFor({ mean: 0.3, sat: 0.1 }, null).shadow > photoTest.colourFor({ mean: 0.02, sat: 0.1 }, null).shadow
);

// Tinting the accent with the photograph's own hue was the obvious idea and it
// is camouflage: a cover over a blue sky came back pale blue and read as white.
const blueish = photoTest.colourFor({ mean: 0.2, sat: 0.5 }, 210).accent;
ok('the accent is warm even over a cool photograph', blueish === '#F7E3A1');
ok('and steps aside when the photograph is itself yellow', photoTest.colourFor({ mean: 0.2, sat: 0.5 }, 45).accent !== '#F7E3A1');
ok('a pale frame gets no accent, having no contrast left to give', photoTest.colourFor({ mean: 0.8, sat: 0.5 }, 210).accent === null);

// Background, not smoothness.
//
// The rule is "the words go in the sky or on the water, never across the
// mountain". Four pixel heuristics were built for it and all four failed,
// because the shaded face of a mountain measures CALMER than the sky above it —
// smoothness and background are different properties. A region identified
// semantically is turned into a mask, and coverage of that mask outranks
// everything else in the score.
const skyBox = { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.4 };
const skyMask = photoTest.maskFromBox(skyBox);
ok('a hinted region becomes a mask', Boolean(skyMask));
eq('a box inside it is fully covered', photoTest.coverage(skyMask, 0.2 * photoTest.GW, 0.25 * photoTest.GH, 0.8 * photoTest.GW, 0.35 * photoTest.GH), 1);
eq('a box outside it is not', photoTest.coverage(skyMask, 0.2 * photoTest.GW, 0.6 * photoTest.GH, 0.8 * photoTest.GW, 0.7 * photoTest.GH), 0);
ok('a box half in, half out lands between', (() => {
  const c = photoTest.coverage(skyMask, 0.2 * photoTest.GW, 0.35 * photoTest.GH, 0.8 * photoTest.GW, 0.45 * photoTest.GH);
  return c > 0.2 && c < 0.8;
})());
// A degenerate rectangle is a misunderstanding rather than an answer, and the
// pixel fallback beats honouring it.
eq('a zero-width region yields no mask', photoTest.maskFromBox({ x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.4 }), null);

// TikTok draws its button rail over the right of the frame; text under it is
// text nobody reads. Instagram draws nothing, so the exclusion is not a
// constant in SIZES.
ok('a box under the button rail is penalised', photoTest.railOverlap(0.8, 0.6, 0.4, 0.2) > 0);
ok('one above it is not', photoTest.railOverlap(0.8, 0.2, 0.4, 0.1) === 0);
ok('nor one away to the left', photoTest.railOverlap(0.3, 0.6, 0.4, 0.2) === 0);

/* -------------------------------------------------------------------------- */
group('font guard — the check that was silently passing');

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const probe = async (html) => {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const face = [...document.fonts].find((f) => f.family.replace(/['"]/g, '') === 'Heebo');
      const measure = (family) => {
        const el = document.createElement('span');
        el.textContent = 'מסלול טיול בחו״ל';
        el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:900 100px ${family}`;
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      };
      return {
        naive: document.fonts.check('900 100px Heebo'),
        status: face?.status ?? 'missing',
        distinct: Math.abs(measure("'Heebo'") - measure("'__no_such_font__'")) > 0.5,
      };
    });
    await page.close();
    return r;
  };

  const bare = await probe('<html dir="rtl"><body style="font-family:Heebo">שלום</body></html>');
  ok('document.fonts.check() is unreliable — it reports true with no @font-face at all', bare.naive === true, 'if this ever fails, the naive check may have become usable');
  ok('the real guard fires when the font is absent', bare.status !== 'loaded' && !bare.distinct);

  const real = await probe(renderHtml(draft));
  ok('the real guard passes on an actual card', real.status === 'loaded' && real.distinct);
  ok('Heebo measurably differs from the fallback', real.distinct);

  await browser.close();
} catch (e) {
  console.log(`  ⚠ skipped (Playwright unavailable: ${e.message})`);
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
