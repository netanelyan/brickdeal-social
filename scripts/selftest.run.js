import { loadEnv } from '../src/env.js';
loadEnv();

import { primaryAuthority, registry } from '../src/sources/index.js';
import { flightPriceGuard, verifyEvidence, verifyDraftText, minSourceChars, noDecimalsUpFront, noRepeatedWord, headlineLength, captionLength, fillerAdjective, rhetoricalOpening, RejectedError } from '../src/verify.js';
import { safeStem } from '../src/render/index.js';
import { htmlToText, stripBoilerplate, decodeEntities, fetchReadable, FetchError } from '../src/fetchPage.js';
import { parseFeed } from '../src/sources/rss.js';
import { monthlyNormals, verdictFor } from '../src/sources/climate.js';
import { quotaBlock } from '../src/pillars.js';
import { scoreItem, rank } from '../src/score.js';
import * as store from '../src/store.js';
import { candidateId, tripGap } from '../src/candidate.js';
import { renderHtml, LAYOUTS, PHOTO_LAYOUTS, isPhotoLayout } from '../src/render/templates.js';
import { assertGenericAiPrompt, ImagePolicyError, imageQueries } from '../src/images.js';
import { approvalMessage, instagramCaption, tiktokCaption, deckCaption, evidenceReport, deckApprovalMessage } from '../src/format.js';
import { renderSlideHtml, SIZES, coverSize } from '../src/render/deckTemplates.js';
import { deckId } from '../src/deck/candidate.js';
import { normaliseIdea } from '../src/deck/ideas.js';
import { sameSite } from '../src/search.js';
import { authorityDomains } from '../src/sources/places.js';
import { quietAlert } from '../src/notify.js';
import { describeError, InstagramError } from '../src/publish/instagram.js';
import { publishTargets, targetsForKind, allowedForKind } from '../src/publish/targets.js';
import {
  defaultPrivacy,
  nextPrivacy,
  privacyHe,
  publishTikTok,
  tiktokConfigured,
  describeError as describeTikTokError,
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

// The editorial rule, in code: a news card is written for a feed and never
// reaches TikTok; a deck is written for a scroll and reaches both.
withEnv({ ...IG, CHANNEL_ID: '@c' }, () => {
  ok('a card never goes to TikTok', !targetsForKind('card').includes('tiktok'));
  eq('a card goes to the channel and Instagram', targetsForKind('card').join(','), 'telegram,instagram');
  ok('a deck is permitted to reach TikTok', allowedForKind('deck').includes('tiktok'));
  ok('a card is not, whatever is configured', !allowedForKind('card').includes('tiktok'));
});

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
        nameHe: 'המוזיאון הלאומי',
        nameEn: 'National Museum',
        sourceHost: 'nm.cz',
        sourceUrl: 'https://www.nm.cz/en/visit',
        hook: { text: 'כיפת הזכוכית שכולם מצלמים', quote: 'the glass dome visitors photograph most' },
        lines: [
          { emoji: '🕘', text: 'סגור בימי שני', quote: 'Closed on Mondays' },
          { emoji: '🎟️', text: 'כניסה 250 קרונות', quote: 'Admission 250 CZK' },
        ],
      },
      {
        nameHe: 'הגלריה הלאומית',
        nameEn: 'National Gallery',
        sourceHost: 'ngprague.cz',
        sourceUrl: 'https://www.ngprague.cz/en/visit',
        hook: { text: 'אוסף המודרניסטים הגדול בצ׳כיה', quote: 'the largest collection of modern art in Czechia' },
        lines: [{ emoji: '🕘', text: 'סגור בימי שני', quote: 'Closed on Mondays' }],
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
ok('with the page each quote came from', deckEv.includes('ngprague.cz'));

const dcap = deckCaption(deckFixture.deck);
ok('the caption opens with the angle, not the title', dcap.startsWith('מה פתוח'));
ok('and lists the places in order', dcap.indexOf('1. המוזיאון') < dcap.indexOf('2. הגלריה'));
ok('the title is not repeated - the cover slide already carries it', !dcap.includes('המוזיאונים של פראג'));

// Slide rendering is where a verified fact can still be lost, so the template
// is checked for the two ways that happens: a dropped line, and text that
// silently overflows the image.
const slideHtml = renderSlideHtml(deckFixture.deck.slides[0], { index: 2, total: 3, size: 'tiktok' });
ok('every verified line reaches the slide', slideHtml.includes('סגור בימי שני') && slideHtml.includes('כניסה 250 קרונות'));

// The hook is the only line that has to be interesting, so it is the one the
// slide cannot ship without and the one the approval message leads with.
ok('the hook is on the slide', slideHtml.includes('כיפת הזכוכית שכולם מצלמים'));
ok('the approval message leads each slide with its hook', deckMsg.includes('כיפת הזכוכית שכולם מצלמים'));
ok('a slide with no hook says so rather than looking complete', deckApprovalMessage({
  ...deckFixture,
  deck: { ...deckFixture.deck, slides: [{ ...deckFixture.deck.slides[0], hook: null }] },
}).includes('אין וו'));
ok('the hook is quoted like everything else', evidenceReport(deckFixture).includes('the glass dome visitors photograph most'));

// A cover set at full size wraps to four lines and eats the photograph.
eq('a short title stays large', coverSize('חמישה מוזיאונים'), '');
eq('a medium one steps down', coverSize('המוזיאונים של פראג ששווים'), ' mid');
eq('a long one steps down twice', coverSize('המוזיאונים של פראג ששווים את הכרטיס ועוד'), ' long');

// Practical lines are capped at two. Four of them over a photograph is the wall
// of small text the first decks produced.
ok('no more than two practical lines reach a slide', renderSlideHtml(
  { nameHe: 'x', hook: { text: 'h' }, lines: [1, 2, 3, 4].map((n) => ({ emoji: '•', text: `line${n}` })) },
  { index: 2, total: 3 }
).split('class="line').length - 1 <= 4);
ok('an overlong line renders smaller rather than being dropped', renderSlideHtml(
  { ...deckFixture.deck.slides[0], lines: [{ emoji: '🕘', text: 'x'.repeat(60), quote: 'q', overlong: true }] },
  { index: 2, total: 3, size: 'tiktok' }
).includes('line long'));
ok('the slide carries the source host', slideHtml.includes('nm.cz'));
// TikTok draws its own slide counter and genuine posts carry no second one, so
// ours was the tell that this had been made elsewhere and uploaded.
ok('no counter of our own', !slideHtml.includes('class="counter"'));
// Nor our own domain on a fact slide. The source stays; branding on every
// slide is what an advertisement looks like.
ok('the brand is not on every slide', !slideHtml.includes('tiyulplus'));
ok('but it is on the cover', renderSlideHtml({ titleHe: 'x' }, { index: 1, total: 3, cover: true }).includes('tiyulplus'));
// Legibility without a panel: the outline is what makes white type work on a
// sunlit facade, and paint-order is what stops the stroke eating the letters.
ok('type is outlined rather than plated', slideHtml.includes('paint-order: stroke fill'));
ok('and the emoji is exempt, or it renders as a black blob', slideHtml.includes('-webkit-text-stroke: 0'));
eq('TikTok slides are 9:16', `${SIZES.tiktok.w}x${SIZES.tiktok.h}`, '1080x1920');
eq('Instagram slides are 4:5, because the feed crops anything taller', `${SIZES.instagram.w}x${SIZES.instagram.h}`, '1080x1350');
ok('a slide with no photograph still renders', renderSlideHtml({ nameHe: 'x', lines: [] }, { index: 2, total: 3 }).includes('linear-gradient'));
ok('HTML in a place name cannot break out of the template', renderSlideHtml(
  { nameHe: '<script>alert(1)</script>', lines: [], sourceHost: 'x.cz' },
  { index: 2, total: 3 }
).includes('&lt;script&gt;'));

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
