import { loadEnv } from '../src/env.js';
loadEnv();

import { gather, registry, enabledSources, primaryAuthority } from '../src/sources/index.js';
import { rank, scoreItem } from '../src/score.js';
import { verifySource, reasonHe } from '../src/verify.js';
import { closeFetchBrowser } from '../src/browserFetch.js';

// How many items per source to take all the way to "could this be drafted".
const SAMPLE = Math.max(1, Number(process.argv[2] || 3));

// Runs every enabled source against the live endpoint and prints what came
// back, without drafting, rendering, or touching Telegram.
//
// This is the command to reach for when the answer to "why did nothing get
// staged today" might be "the feed moved". It separates a source that is broken
// from a source that simply had nothing new, which a run report alone can't.

async function main() {
  const { sources, allowlist } = registry();

  console.log(`registry: ${sources.length} sources (${enabledSources().length} enabled), ${allowlist.length} allowlisted domains\n`);

  const { items, errors, perSource } = await gather();

  console.log('per source:');
  for (const s of enabledSources()) {
    const n = perSource[s.id] ?? 0;
    const err = errors.find((e) => e.sourceId === s.id);
    const state = err ? `FAILED — ${err.message}` : n === 0 ? 'ok, but nothing returned' : `${n} items`;
    console.log(`  ${err ? '✗' : '✓'} ${s.id.padEnd(22)} ${state}`);
  }

  // Counting feed items is not the same question as "can this source produce a
  // post", and for a month it gave the wrong answer.
  //
  // UNESCO's feed served 10 items every run and showed a green tick here, while
  // every article page behind those items returned 403 — so the source was
  // contributing nothing and this command said it was fine. The feed is the one
  // thing that was never broken.
  //
  // verifySource() is the honest check because it IS the gate: same allowlist,
  // same thin-source floor, same contentInFeed handling (the Smithsonian is
  // supposed to never fetch its landing page, and a naive page fetch here would
  // report that healthy source as broken), and it exercises the 403 browser
  // fallback too.
  console.log('\ncan it actually produce a post? (sampling up to ' + SAMPLE + ' items per source)');
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.sourceId)) bySource.set(it.sourceId, []);
    bySource.get(it.sourceId).push(it);
  }

  let anyDark = false;
  for (const s of enabledSources()) {
    const sample = (bySource.get(s.id) || []).slice(0, SAMPLE);
    if (!sample.length) {
      console.log(`  - ${s.id.padEnd(22)} nothing gathered to sample`);
      continue;
    }
    const results = [];
    for (const it of sample) {
      try {
        const { sourceText } = await verifySource(it);
        results.push({ ok: true, chars: sourceText.replace(/\s/g, '').length });
      } catch (e) {
        results.push({ ok: false, reason: e.reason || 'error', detail: e.detail || e.message });
      }
    }
    const pass = results.filter((r) => r.ok);
    const dark = pass.length === 0;
    if (dark) anyDark = true;
    const chars = pass.length ? ` (${Math.min(...pass.map((r) => r.chars))}-${Math.max(...pass.map((r) => r.chars))} chars)` : '';
    console.log(`  ${dark ? '✗' : '✓'} ${s.id.padEnd(22)} ${pass.length}/${results.length} usable${chars}`);
    // Only the failures, and only once per distinct reason — three identical
    // 403s is one fact, not three.
    const seen = new Set();
    for (const r of results.filter((x) => !x.ok)) {
      const key = `${r.reason}|${r.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`      ${r.reason} — ${r.detail}  [${reasonHe(r.reason)}]`);
    }
  }

  if (anyDark) {
    console.log('\n⚠️ a source with 0 usable items is contributing nothing, however many feed items it returns.');
  }

  // Every item must be publishable in principle before it is worth ranking —
  // an item whose own link is off the allowlist can never become a candidate.
  const offList = items.filter((it) => !primaryAuthority(it.url));
  if (offList.length) {
    console.log(`\n⚠️ ${offList.length} item(s) link off the allowlist and would be rejected:`);
    for (const it of offList.slice(0, 5)) console.log(`   ${new URL(it.url).hostname} — ${it.title.slice(0, 70)}`);
  }

  const ranked = rank(items);
  console.log(`\ntop ${Math.min(8, ranked.length)} of ${items.length} gathered (already-seen items excluded):`);
  for (const { item, score } of ranked.slice(0, 8)) {
    console.log(`  ${score.toFixed(2)}  [${item.sourceId}] ${item.title.slice(0, 78)}`);
  }

  if (!ranked.length && items.length) {
    console.log('  (everything gathered has been seen before — this is normal on a repeat run)');
  }

  if (errors.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // The 403 fallback may have left Chromium warm; without this the command
  // prints its report and then hangs for the idle timeout.
  .finally(() => closeFetchBrowser().catch(() => {}));
