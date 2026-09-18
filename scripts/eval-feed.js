import { loadEnv } from '../src/env.js';
loadEnv();

import { fetchText, fetchReadable } from '../src/fetchPage.js';
import { parseFeed } from '../src/sources/rss.js';
import { primaryAuthority } from '../src/sources/index.js';
import { scoreItem } from '../src/score.js';

// Size up a feed BEFORE it goes in the registry.
//
// check-sources tells you whether the sources you have are alive. This is the
// step before that: given a URL someone thinks might be a source, does it
// parse with our parser, what does it actually contain, how old is it, how
// much text is on the pages it links to, and would the allowlist even accept
// it. Every source added in September 2026 was chosen by running this against
// a shortlist and reading the titles - and every one that was declared off
// has this script's findings in its `note`.
//
//   npm run eval-feed "https://www.thisisathens.org/rss.xml"
//   npm run eval-feed <url> <url> ...

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('usage: npm run eval-feed "<feed url>" [more urls]');
  process.exit(1);
}

const ACCEPT = 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8';

for (const url of urls) {
  console.log(`\n=== ${url}`);
  let items;
  try {
    const { body } = await fetchText(url, { accept: ACCEPT });
    items = parseFeed(body, { id: 'probe', name: 'probe', authority: 'probe', lang: 'en', pillars: [] });
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
    continue;
  }

  const dates = items.map((i) => i.publishedAt).filter(Boolean).sort();
  console.log(`  ${items.length} items · dated ${dates[0]?.slice(0, 10) || '?'} .. ${dates.at(-1)?.slice(0, 10) || '?'}`);

  const off = items.filter((i) => !primaryAuthority(i.url));
  if (off.length) {
    console.log(`  ⚠️  ${off.length}/${items.length} items link to a domain that is NOT on the allowlist (${new URL(off[0].url).hostname})`);
  }

  for (const it of items.slice(0, 8)) {
    const score = scoreItem({ ...it, authority: 'official-dmo' }).toFixed(2);
    console.log(`  ${score}  [${(it.publishedAt || '').slice(0, 10) || 'undated'}] ${it.title.slice(0, 80)}  (summary ${it.summary.length} chars)`);
  }

  // One page, so the thin-source floor can be judged against reality.
  const first = items.find((i) => i.url);
  if (first) {
    try {
      const page = await fetchReadable(first.url);
      console.log(`  first page: ${page.text.length} chars${page.truncated ? ' (truncated)' : ''} at ${page.finalUrl.slice(0, 80)}`);
      console.log(`    » ${page.text.slice(0, 220).replace(/\n/g, ' / ')}`);
    } catch (e) {
      console.log(`  first page: fetch failed - ${e.message}`);
    }
  }
}
