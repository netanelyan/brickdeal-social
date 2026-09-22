import { loadEnv } from '../src/env.js';
loadEnv();

import * as store from '../src/store.js';
import { primaryAuthority } from '../src/sources/index.js';
import { toCandidate, candidateId, RejectedError } from '../src/candidate.js';
import { gather } from '../src/sources/index.js';
import { publishInstagram, instagramConfigured, describeError } from '../src/publish/instagram.js';
import { closeBrowser } from '../src/render/index.js';
import { reasonHe } from '../src/verify.js';
import { hasApiKey } from '../src/draft.js';

// Republish to Instagram ONLY, for posts that reached Telegram and never made
// it to Instagram.
//
// This exists because of a real gap rather than as a convenience. When
// publishNext() recorded a card as published on the strength of Telegram alone,
// the card left the queue and the only thing kept about it was the row in the
// published log: id, pillar, tags, layout and the two destination flags. Not the
// headline, not the source URL, not the caption. So the store can say HOW MANY
// posts never reached Instagram and when, and cannot say which stories they
// were. The URLs have to come from you — they are in the Telegram channel, on
// the `מקור:` line of every post.
//
// Instagram only, deliberately. Re-approving through the bot would republish to
// Telegram too, and posting the same card to the channel twice to fix a gap on
// the other network is a worse outcome than the gap.
//
// Takes either a source URL or an id straight from the gap report. Prefer the
// id: it is the same identity the pipeline used, so it addresses feed sources
// whose items all share one landing page, which a URL cannot.
//
//   node scripts/backfill-instagram.js                    # what is missing
//   node scripts/backfill-instagram.js --check URL [...]  # does this match a gap?
//   node scripts/backfill-instagram.js ID|URL [...]       # rebuild, do not publish
//   node scripts/backfill-instagram.js --yes ID|URL [...] # rebuild and publish
//   --attempts=N   drafting tries per post before giving up (default 3)

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const checkOnly = args.includes('--check');
const urls = args.filter((a) => !a.startsWith('--'));
// A candidate id as the gap report prints it.
const ID_RE = /^[0-9a-f]{12}$/;
// Drafting attempts per post. Each one is a paid call, so it is small and
// visible rather than an invisible loop.
const attempts = Math.max(1, Number(args.find((a) => a.startsWith('--attempts='))?.split('=')[1] || 3));

/** Posts in the quota window that Telegram carried and Instagram never did. */
function gap() {
  return store
    .recentPublished()
    .filter((p) => p.telegram && !p.instagram)
    .sort((a, b) => a.ts - b.ts);
}

function reportGap() {
  const missing = gap();
  const health = store.targetHealth('instagram');

  if (!missing.length) {
    console.log('No posts in the quota window reached Telegram without also reaching Instagram.');
  } else {
    const first = new Date(missing[0].ts);
    const last = new Date(missing[missing.length - 1].ts);
    console.log(`${missing.length} posts went to Telegram and never to Instagram.`);
    console.log(`   from ${first.toISOString().slice(0, 16).replace('T', ' ')}`);
    console.log(`   to   ${last.toISOString().slice(0, 16).replace('T', ' ')}\n`);
    for (const p of missing) {
      console.log(`   ${new Date(p.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${p.id}  [${p.pillar}]`);
    }
    console.log(
      '\nThe published log keeps no headline, URL or caption, so these cannot be rebuilt\n' +
        'from the store alone. Find each post in the Telegram channel, copy the URL from\n' +
        'its `מקור:` line, and pass them to this script.'
    );
  }

  if (store.heldCount()) {
    console.log(`\n${store.heldCount()} posts are HELD and do not need this script — run /retry in the bot.`);
  }
  if (health.degraded) {
    console.log(`\nInstagram is currently marked broken: ${health.lastError || 'no detail'}`);
  }
}

/**
 * Does this URL rebuild the post you think it does?
 *
 * A candidate's id is a hash of its canonical source URL, so the id in the gap
 * report is checkable against a URL without drafting anything. Worth doing
 * first: a URL copied from the wrong message costs a drafting call and then
 * publishes the wrong story to real followers, and neither is undoable.
 */
function check(ref) {
  const id = ID_RE.test(ref) ? ref : candidateId({ url: ref });
  const row = gap().find((p) => p.id === id);
  if (row) {
    console.log(`   ✓ ${id} — missing since ${new Date(row.ts).toISOString().slice(0, 16).replace('T', ' ')}`);
    return true;
  }
  if (store.hasPublished(id)) {
    console.log(`   • ${id} — already published to both. Nothing to backfill.`);
    return false;
  }
  console.log(`   ✗ ${id} — not in the gap. Wrong URL, or it never published at all.`);
  // The trap this exists to name. A source whose identity comes from the item
  // title cannot be addressed by URL at all: every entry shares one landing
  // page, so the hash of that page matches nothing.
  console.log('     If the post came from a feed where many items share one link');
  console.log('     (the Smithsonian volcano report), use its id from the gap list instead.');
  return false;
}

/**
 * Find the live source item behind a gap id.
 *
 * A URL is not a usable address for every post. Sources with `dedupeBy: title`
 * take identity from the item title because every entry links to the same
 * landing page — the Smithsonian weekly volcano report is twenty-one eruptions
 * behind one `reports_weekly.cfm` link. Rebuilding one of those from its URL
 * would fetch whatever that page says today and publish a different eruption
 * under the belief it was the missing one.
 *
 * Re-gathering and matching on the id sidesteps that: it is the same identity
 * function the pipeline used the first time, so it addresses both kinds of
 * source correctly.
 */
let gathered = null;
async function itemForId(id) {
  if (!gathered) {
    process.stdout.write('   re-gathering sources...');
    const { items } = await gather({ now: new Date() });
    gathered = items;
    console.log(` ${items.length} items`);
  }
  return gathered.find((it) => candidateId(it) === id) || null;
}

function manualItem(url) {
  // The same shape ingestUrl() builds in bot.js.
  return {
    sourceId: 'backfill',
    sourceName: 'השלמה ידנית',
    authority: 'government',
    lang: 'en',
    pillarHints: [],
    title: url,
    summary: '',
    url,
    publishedAt: null,
  };
}

/**
 * Rebuild and republish one post, addressed either by source URL or by the id
 * from the gap report.
 *
 * The card is drafted and rendered fresh. The original JPEG may still be on
 * disk, but its caption is not, and an old image beside a new caption is worse
 * than either — so the copy will not be word-for-word what the channel got.
 */
async function backfill(ref) {
  const byId = ID_RE.test(ref);
  let item;

  if (byId) {
    if (!gap().some((p) => p.id === ref)) {
      console.log(`   ✗ ${ref} is not in the gap`);
      return false;
    }
    item = await itemForId(ref);
    if (!item) {
      // Not necessarily unrecoverable. An id only resolves while the item is
      // still in a feed, but a post whose source is an ordinary permalink can
      // be addressed by that URL for as long as the page exists — the id route
      // is only *required* for sources where many items share one link.
      console.log(`   ✗ ${ref} has rolled off every feed, so the id no longer resolves.`);
      console.log('     If you have its source URL, pass that instead — it works after the');
      console.log('     feed has moved on. Only feed-identity sources need the id.');
      return false;
    }
    console.log(`   ${item.sourceId}: ${item.title.slice(0, 70)}`);
  } else {
    if (!primaryAuthority(ref)) {
      console.log(`   ✗ ${new URL(ref).hostname} is not on the primary-source allowlist`);
      return false;
    }
    // Refuses by default when the URL does not correspond to a post that is
    // actually missing. This script publishes to real followers and there is no
    // undo; a URL copied from the wrong message should cost nothing.
    if (!check(ref) && !args.includes('--force')) {
      console.log('   skipped — pass --force to publish it anyway');
      return false;
    }
    item = manualItem(ref);
  }

  // Retried, unlike the pipeline, and for a reason specific to backfilling:
  // every post here ALREADY passed every gate once and published. So a
  // rejection now is far more likely to be a bad drafting call than a verdict
  // on the source — the volcano report came back quoting its own title,
  // "Klyuchevskoy (Russia)", which is two words and fails the evidence check.
  // The pipeline is right to treat that as final: it has other stories to
  // spend the call on. This has exactly one, and it is known good.
  let cand;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      cand = await toCandidate(item);
      break;
    } catch (e) {
      const reason = e instanceof RejectedError ? e.reason : 'error';
      console.log(`   ✗ attempt ${attempt}/${attempts} rejected [${reasonHe(reason)}] ${e.detail || e.message}`);
      if (attempt === attempts) return false;
    }
  }

  console.log(`   ${cand.headline}`);
  console.log(`   card: ${cand.card?.file}`);

  if (!confirmed) {
    console.log('   (dry run — pass --yes to publish this to Instagram)');
    return false;
  }

  try {
    const r = await publishInstagram(cand);
    // Upserts by id, so a post already logged as telegram-only gains its
    // Instagram flag rather than being counted twice in the quota window.
    store.recordPublished({
      id: cand.id,
      pillar: cand.pillar,
      tags: cand.tags,
      layout: cand.layout,
      instagram: true,
    });
    store.noteTargetOk('instagram');
    // No media id when the publish came back as an error on a post that had
    // gone up anyway — the container is what we have, and the notes say why.
    console.log(`   ✓ published to Instagram (media ${r.mediaId || `container ${r.creationId}`})`);
    for (const note of r.notes || []) console.log(`     ℹ️ ${note}`);
    return true;
  } catch (e) {
    store.noteTargetFailed('instagram', describeError(e));
    console.log(`   ✗ ${describeError(e)}`);
    return false;
  }
}

async function main() {
  if (!urls.length) return reportGap();

  // Costs nothing and needs no credentials, so it can run against a blocked
  // Instagram — collect the URLs now, publish when the block clears.
  if (checkOnly) {
    let matched = 0;
    for (const url of urls) {
      console.log(url);
      if (check(url)) matched++;
      console.log('');
    }
    console.log(`--- ${matched}/${urls.length} match a missing post ---`);
    return;
  }

  if (!instagramConfigured()) {
    console.error('Instagram is not configured — needs IG_ACCESS_TOKEN, IG_USER_ID and CARD_PUBLIC_BASE_URL.');
    process.exitCode = 1;
    return;
  }
  if (!hasApiKey()) {
    console.error('ANTHROPIC_API_KEY is not set — each post has to be drafted again.');
    process.exitCode = 1;
    return;
  }

  console.log(`${urls.length} to backfill${confirmed ? '' : ' (dry run)'}\n`);
  let done = 0;
  for (const [i, url] of urls.entries()) {
    console.log(`${i + 1}/${urls.length} ${url}`);
    if (await backfill(url)) done++;
    console.log('');
  }

  console.log(`--- ${done}/${urls.length} published to Instagram ---`);
  if (!confirmed && urls.length) console.log('Nothing was published. Re-run with --yes.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeBrowser);
