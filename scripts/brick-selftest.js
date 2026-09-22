import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

// Launcher. The tests are in brick-selftest.run.js.
//
// Same trick, and the same reason, as scripts/selftest.js: ES module imports
// are hoisted and evaluated before any statement in the file that declares
// them, so setting STORE_PATH at the top of a file that also imports
// src/store.js is too late — the store has already resolved its path and read
// the real data/store.json.
//
// That matters because merely importing the store prunes and rewrites that
// file. On the VPS it holds the live Instagram token, the publish history and
// the dedupe record, and `npm test` there must not touch it.
//
// The rate and set-price caches get the same treatment for the same reason:
// src/brick/fx.js and src/brick/rrp.js write to data/, and a test that
// poisoned the cached exchange rate would change what every subsequent deck
// published, silently and in the right shape to be believed.
process.env.STORE_PATH ||= fileURLToPath(new URL('../data/.brick-selftest-store.json', import.meta.url));
process.env.FX_CACHE_PATH ||= fileURLToPath(new URL('../data/.brick-selftest-fx.json', import.meta.url));
process.env.RRP_CACHE_PATH ||= fileURLToPath(new URL('../data/.brick-selftest-rrp.json', import.meta.url));

for (const p of [process.env.STORE_PATH, process.env.FX_CACHE_PATH, process.env.RRP_CACHE_PATH]) {
  rmSync(p, { force: true });
}

await import('./brick-selftest.run.js');
