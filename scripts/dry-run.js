import { loadEnv } from '../src/env.js';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The full publish path, exercised without publishing.
//
// Everything up to and including the last reversible step runs for real: the
// config is read, the token is checked against TikTok, creator_info is asked
// who we are, the privacy level is resolved, the image hosts are checked
// against the verified list and the 24h cap is counted. The one call that does
// not happen is content/init/, because that is the step that creates a post.
//
// Two things make it safe to run against production while the bot is live:
//
//   1. STORE_PATH is pointed at a COPY of data/store.json before anything that
//      touches the store is imported. The running bot rewrites that file on
//      every save, and a second process writing it would lose whichever write
//      landed second. Nothing here can reach the real one.
//   2. Every TikTok call it makes is a read. creator_info/query is a lookup.
//
// Usage:  npm run dry-run            — synthetic candidates, every branch
//         npm run dry-run -- --queue — plus whatever is really in the queue

loadEnv();

const REAL_STORE = fileURLToPath(new URL('../data/store.json', import.meta.url));
const scratch = join(mkdtempSync(join(tmpdir(), 'tiyul-dryrun-')), 'store.json');
if (existsSync(REAL_STORE)) copyFileSync(REAL_STORE, scratch);
process.env.STORE_PATH = scratch;

// Imported only now — store.js resolves STORE_PATH at module load, so importing
// it any earlier would bind it to the live file.
const store = await import('../src/store.js');
const {
  publishTikTok,
  preflight,
  resolvePrivacy,
  creatorInfo,
  tiktokConfigured,
  describeError,
  isCardLevel,
  isPlatformLimit,
  tokenHoursLeft,
  refreshTokenDaysLeft,
  TIKTOK_DAILY_CAP,
} = await import('../src/publish/tiktok.js');
const { cardBaseUrls, tiktokVerifiedDomains } = await import('../src/publish/imageHosts.js');
const { publishTargets, targetsForKind, allowedForKind } = await import('../src/publish/targets.js');
const { runOverridden, noteOverride, overrideNotes } = await import('../src/override.js');
const { quotaBlock, describeRepeats } = await import('../src/pillars.js');

const withQueue = process.argv.includes('--queue');

let failures = 0;
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'─'.repeat(t.length)}`);
const ok = (t) => console.log(`  \x1b[32m✓\x1b[0m ${t}`);
const bad = (t) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${t}`);
};
const info = (t) => console.log(`    ${t}`);

/* ────────────────────────────────────────────────────────────────────────── */
head('1. Configuration');

const hosts = cardBaseUrls();
const verified = tiktokVerifiedDomains();
console.log(`  card hosts      : ${hosts.length ? hosts.join(', ') : '(none)'}`);
console.log(`  tiktok verified : ${verified.length ? verified.join(', ') : '(none)'}`);
console.log(`  publish targets : ${publishTargets().join(' + ') || '(none)'}`);
console.log(`  card  may go to : ${allowedForKind('card').join(', ')}`);
console.log(`  deck  may go to : ${allowedForKind('deck').join(', ')}`);
console.log(`  tiktokConfigured: ${tiktokConfigured()}`);
if (!hosts.length) bad('no card host configured — nothing can publish to Instagram or TikTok');
if (!verified.length) bad('no TikTok-verified domain configured');

/* ────────────────────────────────────────────────────────────────────────── */
head('2. The bug that stopped every post: which targets does each kind get?');

// The regression test for publishNext()'s target derivation. A card carries no
// TikTok privacy level BY DESIGN, so a card reaching TikTok is guaranteed to
// fail — that was the whole outage.
const cardTargets = targetsForKind('card');
if (cardTargets.includes('tiktok')) bad(`a card is being sent to TikTok: ${cardTargets.join(', ')}`);
else ok(`a card publishes to ${cardTargets.join(' + ') || '(nothing)'} — never TikTok`);

const deckTargets = targetsForKind('deck');
if (deckTargets.includes('tiktok')) ok(`a deck publishes to ${deckTargets.join(' + ')}`);
else info(`a deck publishes to ${deckTargets.join(' + ') || '(nothing)'} — TikTok not configured`);

/* ────────────────────────────────────────────────────────────────────────── */
head('3. Preflight — each refusal names the exact cause');

const base = hosts[0] || 'https://cards.tiyulplus.com/cards';
const goodUrl = `${base}/dryrun.jpg`;

const deckCand = (urls) => ({
  kind: 'deck',
  headline: 'דריי־ראן',
  tiktokCaption: 'בדיקה',
  deck: { urls: { tiktok: urls } },
});

const cases = [
  ['a good single card', { kind: 'card', card: { url: goodUrl } }, null],
  ['a good deck', deckCand([goodUrl, goodUrl]), null],
  ['no public URL at all', { kind: 'card', card: { url: null } }, 'no public image URL'],
  ['a non-https URL', { kind: 'card', card: { url: 'http://cards.tiyulplus.com/x.jpg' } }, 'must be https'],
  [
    'an unverified image host',
    { kind: 'card', card: { url: 'https://evil.example.com/x.jpg' } },
    'not verified with TikTok',
  ],
  [
    'a host that merely ENDS with a verified name',
    { kind: 'card', card: { url: 'https://nottiyulplus.com/x.jpg' } },
    'not verified with TikTok',
  ],
  ['a deck with a hole in it', deckCand([goodUrl, null, goodUrl]), 'have no public URL'],
  ['36 slides', deckCand(Array(36).fill(goodUrl)), null],
];

for (const [label, cand, expect] of cases) {
  try {
    const { images, notes } = preflight(cand);
    if (expect) bad(`${label} — expected a refusal mentioning "${expect}", got ${images.length} images`);
    else {
      ok(`${label} → ${images.length} image(s)`);
      for (const n of notes) info(`note: ${n}`);
    }
  } catch (e) {
    const msg = describeError(e);
    if (!expect) bad(`${label} — unexpected refusal: ${msg}`);
    else if (!e.message.includes(expect)) bad(`${label} — refused, but not for "${expect}": ${msg}`);
    else {
      ok(`${label} → refused`);
      info(msg.split('\n')[0]);
      info(`card-level: ${isCardLevel(e)} · platform-limit: ${isPlatformLimit(e)}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
head('4. Privacy resolution — never wider than what was shown');

const privacyCases = [
  ['the owner chose SELF_ONLY', { tiktok: { privacy: 'SELF_ONLY', options: ['SELF_ONLY'] } }],
  ['nothing was chosen (the staging failure)', {}],
  ['creator_info failed at staging', { tiktok: { error: 'access_token_invalid', options: [] } }],
  [
    'the chosen level is no longer offered',
    { tiktok: { privacy: 'PUBLIC_TO_EVERYONE', options: ['PUBLIC_TO_EVERYONE'] } },
  ],
];

for (const [label, cand] of privacyCases) {
  try {
    const r = await resolvePrivacy(cand, { allowRefetch: tiktokConfigured() });
    const wide = r.privacy === 'PUBLIC_TO_EVERYONE';
    if (wide) bad(`${label} → ${r.privacy} — wider than SELF_ONLY while unaudited`);
    else ok(`${label} → ${r.privacy} (${r.source})`);
    if (r.note) info(`says: ${r.note}`);
  } catch (e) {
    bad(`${label} — threw: ${describeError(e)}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
head('5. Platform limits — counted, never bypassed');

const cap = TIKTOK_DAILY_CAP();
const used = store.tiktokPostsInLast24h();
console.log(`  TikTok posts in the last 24h: ${used}/${cap}`);
if (used >= cap) {
  const freesAt = store.tiktokCapFreesAt();
  info(`cap reached — frees at ${freesAt ? new Date(freesAt).toISOString() : 'unknown'}`);
}

// Prove the override cannot reach it: run the cap check inside an override.
await runOverridden('dry-run', async () => {
  noteOverride('בדיקה', 'dry run');
  const capped = store.tiktokPostsInLast24h() >= cap;
  ok(`inside an owner override, the cap still reads ${store.tiktokPostsInLast24h()}/${cap}${capped ? ' (blocking)' : ''}`);
});

/* ────────────────────────────────────────────────────────────────────────── */
head('6. Owner override — bypasses guards, and says so');

await runOverridden('dry-run', async () => {
  const history = Array.from({ length: 12 }, () => ({
    ts: Date.now(),
    pillar: 'conditions',
    tags: [],
    sourceId: 'smithsonian-volcano',
  }));
  const cand = { pillar: 'conditions', tags: [], sourceId: 'smithsonian-volcano' };

  const blocked = quotaBlock(cand, history);
  if (!blocked) {
    bad('the synthetic history should have breached the pillar quota');
  } else {
    ok(`quota would block: ${blocked}`);
    const bypassed = noteOverride('מכסת נושאים', blocked);
    if (bypassed) ok('override steps over it');
    else bad('override did not engage');
  }

  for (const r of describeRepeats(cand, history)) info(`discloses: ${r}`);

  const notes = overrideNotes();
  if (!notes.length) bad('nothing was recorded — a silent override is the failure mode');
  else {
    ok(`${notes.length} disclosure line(s) would reach Telegram before publishing:`);
    for (const n of notes) info(`• ${n}`);
  }
});

// And that it does NOT leak outside the override scope.
if (overrideNotes().length) bad('override notes leaked outside runOverridden');
else ok('outside an override, no guard is relaxed');

/* ────────────────────────────────────────────────────────────────────────── */
head('7. Live TikTok — read-only calls against the real account');

if (!tiktokConfigured()) {
  info('TikTok is not configured here; skipping the live half.');
} else {
  console.log(`  access token : ${tokenHoursLeft()}h left`);
  console.log(`  refresh token: ${refreshTokenDaysLeft()}d left`);
  try {
    const cinfo = await creatorInfo();
    ok(`creator_info → @${cinfo.username} (${cinfo.nickname})`);
    info(`privacy_level_options: ${JSON.stringify(cinfo.options)}`);
    if (cinfo.options.includes('PUBLIC_TO_EVERYONE')) {
      bad('PUBLIC_TO_EVERYONE is offered — the account is PUBLIC, and an unaudited app cannot post to it');
    } else {
      ok('PUBLIC_TO_EVERYONE is absent — the account is private, as an unaudited app requires');
    }
  } catch (e) {
    bad(`creator_info failed: ${describeError(e)}`);
  }

  // The whole publish path, stopping at init.
  try {
    const r = await publishTikTok(deckCand([goodUrl, goodUrl]), { dryRun: true });
    ok(`full path reached init and stopped: ${r.slides} slides at ${r.privacy} (${r.privacySource})`);
    info(`cap ${r.capUsed}/${r.cap} · notes: ${r.notes.length ? r.notes.join('; ') : 'none'}`);
  } catch (e) {
    const platform = isPlatformLimit(e);
    if (platform) ok(`full path stopped at a platform limit (correct, not a bug): ${describeError(e).split('\n')[0]}`);
    else bad(`full path failed before init: ${describeError(e)}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
if (withQueue) {
  head('8. What is actually queued right now');
  const rows = [...store.peekQueue()];
  if (!rows.length) info('the queue is empty');
  for (const cand of rows) {
    const kind = cand.kind || 'card';
    const allowed = allowedForKind(kind);
    const intended = (cand.publishTargets?.length ? cand.publishTargets : publishTargets()).filter((t) =>
      allowed.includes(t)
    );
    const owed = (cand.pendingTargets?.length ? cand.pendingTargets : intended).filter(
      (t) => publishTargets().includes(t) && allowed.includes(t)
    );
    console.log(`  ${kind} "${String(cand.headline || cand.id).slice(0, 40)}"`);
    info(`stamped : ${JSON.stringify(cand.publishTargets)}`);
    info(`pending : ${JSON.stringify(cand.pendingTargets || null)}`);
    info(`would publish to: ${owed.join(' + ') || '(nothing — already done or not allowed)'}`);
    if (owed.includes('tiktok')) {
      try {
        const { images } = preflight(cand);
        const p = await resolvePrivacy(cand, { allowRefetch: false });
        ok(`tiktok ok: ${images.length} image(s) at ${p.privacy} (${p.source})`);
      } catch (e) {
        bad(`tiktok would fail: ${describeError(e).split('\n')[0]}`);
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
head('Result');
console.log(
  failures === 0
    ? '\x1b[32mno problems found — nothing was published, the live store was not touched\x1b[0m'
    : `\x1b[31m${failures} problem(s) found\x1b[0m`
);
console.log(`(store copy used: ${scratch})`);
process.exit(failures === 0 ? 0 : 1);
