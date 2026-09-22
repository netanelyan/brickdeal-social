import { loadEnv } from '../src/env.js';
loadEnv();

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDeck } from '../src/brick/build.js';
import { renderBrickDeckSize } from '../src/render/brickDeck.js';
import { captionFor, instagramCaptionFor, dressing } from '../src/brick/caption.js';
import { closeBrowser } from '../src/render/index.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { sampleDeals } from './fixtures/deals.js';

// The whole path, printed, publishing nothing.
//
//   npm run brick-once
//   npm run brick-once -- "harry-potter"
//   npm run brick-once -- --no-images        (skip the generated photographs)
//   npm run brick-once -- --fixture          (a generated feed, no network)
//
// Writes to out/brick/ instead of to Telegram, with a contact sheet. Touches
// neither the store nor any destination, so it is safe to run on the VPS.
//
// Every expensive step degrades rather than failing, and this script is where
// that gets checked: with no BRICKSET_API_KEY every slide loses its comparison
// and keeps its price, with no ANTHROPIC_API_KEY the cover falls back to the
// configured pool, and with no IMAGE_GEN_API_KEY the photographs fall back to
// the catalogue images with their provenance told truthfully. A deck still
// comes out of all three, which is the property worth having.

const OUT = path.join(process.cwd(), 'out', 'brick');

const argv = process.argv.slice(2);
const noImages = argv.includes('--no-images');
const useFixture = argv.includes('--fixture');
const request = argv.filter((a) => !a.startsWith('--')).join(' ') || null;

const money = (n) => `${Math.round(n).toLocaleString('en-US')}₪`;

async function main() {
  mkdirSync(OUT, { recursive: true });

  // The fixture is written to disk rather than injected, so it goes through
  // exactly the same loader, the same validation and the same freshness rule as
  // the live feed. A fixture that took a shortcut past those would be testing a
  // path that does not exist in production.
  if (useFixture) {
    const file = path.join(OUT, 'fixture-deals.json');
    writeFileSync(file, JSON.stringify(sampleDeals(), null, 2));
    process.env.BRICKDEAL_FEED_FILE = file;
    delete process.env.BRICKDEAL_FEED_URL;
    console.log(`  feed: generated fixture at ${file}`);
  }

  console.log(`\n  building${request ? ` "${request}"` : ''}${noImages ? ' (no photographs)' : ''}\n`);
  const deck = await buildDeck(request, {
    wantImages: !noImages,
    onProgress: (s) => console.log(`    ${s}`),
  });
  deck.id = 'once';

  console.log(`\n  ${deck.titleHe}`);
  console.log(`  recipe: ${deck.recipe}${deck.ceiling ? ` (under ${deck.ceiling}₪)` : ''}${deck.theme ? ` · ${deck.theme}` : ''}`);
  console.log(`  cover:  "${deck.hookHe}"  [${deck.hookFrom}]`);

  const rateNote = Object.entries(deck.rates)
    .map(([c, r]) => `${c}/ILS ${r.rate} on ${r.date}`)
    .join(', ');
  console.log(`  rates:  ${rateNote || 'none needed'}`);

  console.log('\n  slides');
  for (const s of deck.slides) {
    const c = s.deal.comparison;
    // A single-set post's later slides carry a fact rather than a price block,
    // so printing the price under all of them reads as five identical slides
    // when they are nothing of the sort. What a slide SAYS is what to print.
    const carriesPrices = s.lines.length > 1 || s.lines[0]?.value;
    const claim = !carriesPrices
      ? s.lines.map((l) => l.label).join(' · ')
      : c?.ok
        ? `${money(c.paid)} vs ${money(c.listIls)} (${c.source.region} ${c.source.amount} ${c.source.currency}) → saves ${money(c.saving)}`
        : `${money(s.deal.price)} · no comparison — ${c?.why || 'unknown'}`;
    console.log(`    ${s.emoji} ${s.nameHe}`);
    console.log(`       ${claim}`);
    console.log(`       photo: ${s.image?.provenance || 'none'}${s.image?.note ? ` (${s.image.note})` : ''}`);
  }

  if (deck.dropped.length) {
    console.log('\n  dropped');
    for (const d of deck.dropped) console.log(`    ${d.id} — ${d.why}`);
  }
  if (deck.feedDropped?.length) {
    console.log(`\n  feed: ${deck.feedDropped.length} record(s) were not usable`);
    for (const d of deck.feedDropped.slice(0, 6)) console.log(`    ${d.id} — ${d.why}`);
    if (deck.feedDropped.length > 6) console.log(`    ... and ${deck.feedDropped.length - 6} more`);
  }

  // One hook AND one tag block, drawn once and handed to both, exactly as the
  // publisher does it. Printing the two side by side is what caught them
  // diverging in the first place, so they stay side by side.
  const dress = dressing(deck);
  console.log('\n  TikTok description\n');
  console.log(captionFor(deck, dress).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('\n  Instagram caption\n');
  console.log(instagramCaptionFor(deck, dress).split('\n').map((l) => `    ${l}`).join('\n'));

  console.log('\n  rendering');
  const slides = await renderBrickDeckSize(deck, { size: 'tiktok', outDir: OUT });
  writeContactSheet(
    [{ titleHe: deck.titleHe, style: 'product', size: 'tiktok', note: deck.subject, slides: slides.map((s) => ({ ...s, spot: null })) }],
    OUT,
    { title: `brick-once — ${deck.titleHe}` }
  );

  await closeBrowser();
  console.log(`\n  ${slides.length} slides\n  ${path.join(OUT, 'index.html')}\n`);
}

main().catch(async (e) => {
  console.error(`\n  failed: ${e.message}\n`);
  if (e.feedDropped?.length) {
    for (const d of e.feedDropped.slice(0, 10)) console.error(`    ${d.id} — ${d.why}`);
  }
  await closeBrowser();
  process.exitCode = 1;
});
