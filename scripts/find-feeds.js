import { loadEnv } from '../src/env.js';
loadEnv();

import { fetchText } from '../src/fetchPage.js';

// Ask a site where its feed is, instead of guessing.
//
// The registry was built by probing paths — /feed/, /rss.xml, /articles.xml —
// against a few hundred domains, and the README records the hit rate: most
// official tourism boards publish no feed at all. That method also misses every
// site that DOES publish one at a path nobody thought to try, and there is no
// way to tell those two cases apart from a wall of 404s.
//
// A site that has a feed almost always declares it in the document head:
//
//   <link rel="alternate" type="application/rss+xml" href="...">
//
// So this reads the homepage and reports what the site says about itself. It is
// the step BEFORE eval-feed: this finds candidates, eval-feed judges them.
//
//   npm run find-feeds "https://www.visitportugal.com" "https://www.gotokyo.org"

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: npm run find-feeds "<site url>" [more urls]');
  process.exit(1);
}

// Both attribute orders, because `type` before `rel` is just as common and a
// regex written for one silently reports "no feed" on half the web.
const LINK = /<link\b[^>]*>/gi;
const ATTR = (tag, name) =>
  tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find(Boolean) || '';

const FEED_TYPES = /(rss|atom)\+xml|application\/(rss|atom)/i;

for (const site of args) {
  console.log(`\n=== ${site}`);
  let body;
  try {
    ({ body } = await fetchText(site, { accept: 'text/html,application/xhtml+xml' }));
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
    continue;
  }

  const found = [];
  for (const tag of body.match(LINK) || []) {
    const rel = ATTR(tag, 'rel');
    const type = ATTR(tag, 'type');
    if (!/alternate/i.test(rel) || !FEED_TYPES.test(type)) continue;
    const href = ATTR(tag, 'href');
    if (!href) continue;
    let abs;
    try {
      abs = new URL(href, site).toString();
    } catch {
      continue;
    }
    if (!found.some((f) => f.url === abs)) found.push({ url: abs, title: ATTR(tag, 'title'), type });
  }

  if (!found.length) {
    console.log('  no feed declared in the head');
    continue;
  }
  for (const f of found) {
    console.log(`  ${f.url}`);
    if (f.title) console.log(`     "${f.title}" (${f.type})`);
  }
  console.log(`  → npm run eval-feed ${found.map((f) => `"${f.url}"`).join(' ')}`);
}
