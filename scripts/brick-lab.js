import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { renderToJpeg, closeBrowser } from '../src/render/index.js';
import { renderBrickSlideHtml } from '../src/render/brickSlide.js';
import { SIZES } from '../src/render/sizes.js';
import { slideLines } from '../src/brick/copy.js';
import { writeContactSheet } from './lib/contact-sheet.js';

// Look at the slides.
//
//   npm run brick-lab
//
// The typography on these cannot be reviewed by reading the HTML. Hebrew
// shaping, bidi, whether "1,234₪" lands on the correct side of its label,
// whether a 6px outline closes the counters of Rubik at 35px, whether white
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

/**
 * A stand-in for a home photograph, as an inline SVG.
 *
 * Not a photograph and not trying to be one. What it reproduces is the thing
 * that decides legibility: the luminance of the region the words land in, and
 * whether there is a hard edge running through it.
 */
const room = ({ wall, shelf, model, accent, label }) => ({
  label,
  src:
    'data:image/svg+xml;base64,' +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
        <defs>
          <linearGradient id="w" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stop-color="${wall}"/>
            <stop offset="1" stop-color="${shelf}"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1920" fill="url(#w)"/>
        <rect x="0" y="1320" width="1080" height="26" fill="${shelf}" opacity="0.8"/>
        <rect x="0" y="1346" width="1080" height="574" fill="${shelf}"/>
        <g opacity="0.95">
          <rect x="300" y="900" width="480" height="420" rx="14" fill="${model}"/>
          <rect x="360" y="820" width="360" height="90" rx="10" fill="${accent}"/>
          <circle cx="410" cy="1320" r="52" fill="${accent}"/>
          <circle cx="670" cy="1320" r="52" fill="${accent}"/>
        </g>
      </svg>`
    ).toString('base64'),
});

const ROOMS = [
  room({ label: 'white wall, daylight', wall: '#F4F2EE', shelf: '#DCD6CC', model: '#C8452F', accent: '#2B4C7E' }),
  room({ label: 'oak shelf, warm lamp', wall: '#C9A97E', shelf: '#8A6A46', model: '#2F6B3C', accent: '#E0C24A' }),
  room({ label: 'dim bedroom, night', wall: '#2A2E36', shelf: '#171A20', model: '#9C2B2B', accent: '#D8D2C4' }),
];

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
];

const COVER = { hookHe: 'איך אנשים עדיין משלמים מחיר מלא?', emphasisHe: 'מחיר מלא' };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const decks = [];

  for (const [r, bg] of ROOMS.entries()) {
    const slides = [];

    const coverHtml = renderBrickSlideHtml({ ...COVER, image: { src: bg.src } }, { size: 'tiktok', cover: true });
    slides.push({
      file: (await renderToJpeg(coverHtml, { stem: `brick-${r}-00`, width: SIZES.tiktok.w, height: SIZES.tiktok.h, outDir: OUT, face: 'Rubik' })).file,
      index: 0,
      nameHe: `כריכה — ${COVER.hookHe}`,
      spot: null,
    });

    for (const [i, fixture] of SLIDES.entries()) {
      const lines = slideLines(fixture.comparison, { price: fixture.price ?? fixture.comparison.paid });
      const html = renderBrickSlideHtml(
        { nameHe: fixture.nameHe, emoji: fixture.emoji, lines, image: { src: bg.src } },
        { size: 'tiktok' }
      );
      const out = await renderToJpeg(html, { stem: `brick-${r}-${String(i + 1).padStart(2, '0')}`, width: SIZES.tiktok.w, height: SIZES.tiktok.h, outDir: OUT, face: 'Rubik' });
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

  const sheet = path.join(OUT, 'index.html');
  writeContactSheet(decks, OUT, { title: 'brick lab — the reference look, over three backgrounds' });
  await closeBrowser();
  console.log(`\n  ${decks.length * (SLIDES.length + 1)} slides\n  ${sheet}\n`);
}

main().catch(async (e) => {
  console.error(e);
  await closeBrowser();
  process.exitCode = 1;
});
