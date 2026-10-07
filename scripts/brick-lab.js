import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { renderToJpeg, closeBrowser } from '../src/render/index.js';
import { renderBrickSlideHtml } from '../src/render/brickSlide.js';
import { SIZES } from '../src/render/sizes.js';
import { renderBrickDeckSize } from '../src/render/brickDeck.js';
import { slideLines, perPieceLines, shekels } from '../src/brick/copy.js';
import { agorotPerPiece } from '../src/brick/recipes.js';
import { brickConfig } from '../src/brick/config.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { ROOMS, roomFor } from './lib/rooms.js';

// Look at the slides.
//
//   npm run brick-lab
//
// The typography on these cannot be reviewed by reading the HTML. Hebrew
// shaping, bidi, whether "1,234₪" lands on the correct side of its label,
// whether a 6px outline closes the counters of Arimo at 35px, whether white
// type survives on a white wall — all of it happens at render time.
//
// Deliberately free of the model, the feed, Brickset and the network. The
// fixtures below are the OUTPUT those would produce, written by hand, so a
// number in brick-config.json can be argued with in about fifteen seconds.
//
// The backgrounds are synthetic on purpose. The real photographs are AI home
// shots and cost money per image, and none of the questions this script exists
// to answer are about the photograph — they are about whether the type holds up
// over the three kinds of background a home shot actually produces. The worst
// of those, by a distance, is a white wall in daylight, which is also the most
// common. It is first in the list for that reason.

const OUT = path.join(process.cwd(), 'out', 'brick-lab');

// The cases that actually break, not five tidy ones.
const SLIDES = [
  {
    nameHe: 'מכונית פורד אנגליה מעופפת',
    emoji: '🚗',
    // The ordinary case: a sourced comparison, three lines.
    comparison: { ok: true, paid: 129, listIls: 559, saving: 430 },
  },
  {
    nameHe: 'סחלב',
    emoji: '🌸',
    // A two-word name. Short names are where a line-clamp built for long ones
    // leaves the block looking top-heavy.
    comparison: { ok: true, paid: 45, listIls: 269, saving: 224 },
  },
  {
    nameHe: 'מסדרונות הטירה והספרייה הגדולה של בית הספר לקוסמים',
    emoji: '🏰',
    // Deliberately past two lines, to prove the clamp and the size step.
    comparison: { ok: true, paid: 210, listIls: 1499, saving: 1289 },
  },
  {
    nameHe: 'קסדת מרוצים F1',
    emoji: '🏎️',
    // Latin characters inside a Hebrew name: the other bidi case, and the one
    // that goes wrong in the opposite direction from the prices.
    comparison: { ok: true, paid: 91, listIls: 349, saving: 258 },
  },
  {
    nameHe: 'דגם יחיד ללא מספר סט מזוהה',
    emoji: '🧱',
    // No RRP. One line, no comparison, no money bag. This is not an error state
    // and it must not look like one - on a marketplace where set numbers are
    // scraped out of seller titles, it is going to be a real share of slides.
    comparison: { ok: false, why: 'no such set on Brickset' },
    price: 78,
  },
  {
    nameHe: 'מגדל אייפל',
    emoji: '🏛️',
    // A per-piece block, and the reason it is in here rather than trusted: its
    // last two lines are a bidi case nothing else on this list produces. A
    // price is digits with a sign hard against them; "10,001" is a bare
    // grouped number, and "4 אגורות" is a number LEADING a Hebrew word inside
    // an isolate in a right-to-left paragraph. Whether the digit stays on the
    // correct side of the word it belongs to is decided at render time.
    //
    // It also has the most crowded value half of any slide the pipeline can
    // build, which is the other thing worth looking at: the type step is sized
    // for "1,499₪" and this asks it to set two words.
    pieces: 10001,
    price: 420,
  },
];

const COVER = { hookHe: 'איך אנשים עדיין משלמים מחיר מלא?', emphasisHe: 'מחיר מלא' };

// A countdown, as a whole deck rather than slide by slide, because what it adds
// is only visible in a row: the numeral counting down across the frames, the
// saving under it growing, a cover carrying #1's picture rather than the first
// slide's, and an end card that follows the cover. Rendered through the real
// deck renderer for exactly that reason.
//
// The cover line is the first configured shape, filled in here rather than by
// countdownHook. That lives in build.js, and importing build.js imports the
// store, which rewrites data/store.json on load. This script touches nothing.
//
// Smallest saving first, as the recipe hands them over. The names repeat the
// cases above that break: Latin inside Hebrew, two words, past two lines. With
// a numeral on top, a two-line name is the tallest block the format produces.
const COUNTDOWN = [
  ['מכונית ספורט כחולה ולבנה', '🏎️', 59, 412],
  ['מרוצי קארט על מסלול', '🏎️', 245, 618],
  ['קסדת מרוצים F1', '🏎️', 74, 583],
  ['סחלב', '🌸', 57, 686],
  ['רכבת קיטור קלאסית', '🚂', 89, 790],
  ['מסדרונות הטירה והספרייה הגדולה של בית הספר לקוסמים', '🏰', 210, 1099],
  ['טירת הוגוורטס הגדולה', '🏰', 349, 1559],
  ['מגדל אייפל', '🏛️', 420, 2402],
];

async function countdownDeck() {
  const slides = COUNTDOWN.map(([nameHe, emoji, paid, listIls], i) => {
    const comparison = { ok: true, paid, listIls, saving: listIls - paid };
    return {
      productId: `lab-${i}`,
      nameHe,
      emoji,
      rank: COUNTDOWN.length - i,
      lines: slideLines(comparison, { price: paid }),
      image: { src: roomFor(i).src },
      deal: { price: paid, comparison },
    };
  });
  const [shape] = brickConfig().covers.countdownLines;
  const top = slides.at(-1).deal.comparison.saving;
  const fill = (s) => String(s || '').replaceAll('{count}', String(slides.length)).replaceAll('{top}', shekels(top));
  const deck = {
    id: 'lab-countdown',
    recipe: 'countdown',
    hookHe: fill(shape?.text || 'דירוג'),
    emphasisHe: shape?.emphasis ? fill(shape.emphasis) : null,
    hookFrom: 'countdown',
    slides,
  };
  const rendered = await renderBrickDeckSize(deck, { size: 'tiktok', outDir: OUT });
  return {
    titleHe: 'דירוג — ממקום 8 עד מקום ראשון',
    style: 'countdown',
    size: 'tiktok',
    note: `"${deck.hookHe}" · cover and end card carry #1's picture`,
    slides: rendered.map((s) => ({ ...s, spot: null })),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const decks = [];

  for (const [r, bg] of ROOMS.entries()) {
    const slides = [];

    const coverHtml = renderBrickSlideHtml({ ...COVER, image: { src: bg.src } }, { size: 'tiktok', cover: true });
    slides.push({
      file: (await renderToJpeg(coverHtml, { stem: `brick-${r}-00`, width: SIZES.tiktok.w, height: SIZES.tiktok.h, outDir: OUT, face: 'Arimo' })).file,
      index: 0,
      nameHe: `כריכה — ${COVER.hookHe}`,
      spot: null,
    });

    for (const [i, fixture] of SLIDES.entries()) {
      const lines = fixture.pieces
        ? perPieceLines(fixture, agorotPerPiece(fixture))
        : slideLines(fixture.comparison, { price: fixture.price ?? fixture.comparison.paid });
      const html = renderBrickSlideHtml(
        { nameHe: fixture.nameHe, emoji: fixture.emoji, lines, image: { src: bg.src } },
        { size: 'tiktok' }
      );
      const out = await renderToJpeg(html, { stem: `brick-${r}-${String(i + 1).padStart(2, '0')}`, width: SIZES.tiktok.w, height: SIZES.tiktok.h, outDir: OUT, face: 'Arimo' });
      slides.push({ file: out.file, index: i + 1, nameHe: fixture.nameHe, spot: null });
    }

    decks.push({
      titleHe: bg.label,
      style: 'product',
      size: 'tiktok',
      note: `${SLIDES.length} slides + cover`,
      slides,
    });
  }

  decks.push(await countdownDeck());

  const sheet = path.join(OUT, 'index.html');
  writeContactSheet(decks, OUT, { title: 'brick lab — the reference look, over three backgrounds' });
  await closeBrowser();
  console.log(`\n  ${decks.reduce((n, d) => n + d.slides.length, 0)} slides\n  ${sheet}\n`);
}

main().catch(async (e) => {
  console.error(e);
  await closeBrowser();
  process.exitCode = 1;
});
