import { fileURLToPath } from 'node:url';
import { rmSync, copyFileSync } from 'node:fs';

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

// And brick-config.json, which is new to this list because the panel can now
// WRITE it. The suite proves that a save which fails validation is rolled back,
// and proving that means deliberately breaking a copy — never the file the
// account's captions and hashtags actually come from.
const REAL_CONFIG = fileURLToPath(new URL('../brick-config.json', import.meta.url));
process.env.BRICK_CONFIG_PATH ||= fileURLToPath(new URL('../data/.brick-selftest-config.json', import.meta.url));

for (const p of [process.env.STORE_PATH, process.env.FX_CACHE_PATH, process.env.RRP_CACHE_PATH]) {
  rmSync(p, { force: true });
}
rmSync(`${process.env.BRICK_CONFIG_PATH}.bak`, { force: true });
// Copied rather than written, so the config tests are checking the real rules
// this account publishes under rather than a fixture that can drift from them.
copyFileSync(REAL_CONFIG, process.env.BRICK_CONFIG_PATH);

await import('./brick-selftest.run.js');
