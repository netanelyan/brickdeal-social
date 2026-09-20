import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { renderDeckSize } from '../src/render/deck.js';
import { closeBrowser } from '../src/render/index.js';
import * as pexels from '../src/images/pexels.js';
import { SIZES } from '../src/render/deckTemplates.js';
import { flagFor } from '../src/deck/flags.js';
import { writeContactSheet } from './lib/contact-sheet.js';

// Look at the slides.
//
//   npm run deck-lab
//   npm run deck-lab -- --no-photos     (cached photographs only, no network)
//
// The typography on these slides cannot be reviewed by reading the HTML. Hebrew
// shaping, bidi, where a line breaks, whether 26px of leading is too much,
// whether white type survives on that particular sky — all of it happens at
// render time, and all of it is what the feedback on the first real decks was
// about. So this renders fixed content against real photographs and writes a
// contact sheet.
//
// Deliberately free of the model. The drafting and curation calls cost money
// and take minutes, and neither is what is being iterated on here: the fixtures
// below are the OUTPUT those calls would produce, written by hand, so that a
// change to the stylesheet can be seen in about fifteen seconds.

const OUT = path.join(process.cwd(), 'out', 'lab');
const CACHE = path.join(OUT, 'photos');
const noPhotos = process.argv.includes('--no-photos');

// Two decks, one per style, each carrying the cases that actually break:
// a long Hebrew name, a two-word name, a country that needs a flag, a title
// long enough to wrap, and — in the info deck — four fields on every slide.
const DECKS = [
  {
    id: 'lab-alps',
    style: 'minimal',
    titleHe: 'טופ 5 פסגות שאסור לפספס באלפים',
    emphasisHe: 'שאסור לפספס',
    coverQuery: 'Alps mountains',
    // Fields on a MINIMAL deck, deliberately. The minimal style shows no field
    // lines, but it will show the first measured value as its one note — so a
    // summit deck in this style still says how high the summit is, which is the
    // best of both references: the look of the one, the fact from the other.
    slides: [
      { nameHe: 'מאטרהורן', countryHe: 'שווייץ', iso: 'CH', query: 'Matterhorn', fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '4,478 מ׳' }] },
      { nameHe: 'מון בלאן', countryHe: 'צרפת', iso: 'FR', query: 'Mont Blanc', fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '4,806 מ׳' }] },
      { nameHe: 'אייגר', countryHe: 'שווייץ', iso: 'CH', query: 'Eiger north face', fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '3,967 מ׳' }] },
      { nameHe: 'גרוסגלוקנר', countryHe: 'אוסטריה', iso: 'AT', query: 'Grossglockner', fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '3,798 מ׳' }] },
      { nameHe: 'מרמולדה', countryHe: 'איטליה', iso: 'IT', query: 'Marmolada', fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '3,343 מ׳' }] },
    ],
  },
  {
    id: 'lab-dolomites',
    style: 'info',
    titleHe: 'טופ 4 מסלולים בדולומיטים',
    emphasisHe: 'בדולומיטים',
    coverQuery: 'Dolomites Italy',
    slides: [
      {
        nameHe: 'אלפה די סיוזי',
        iso: 'IT',
        query: 'Alpe di Siusi',
        fields: [
          { emoji: '🥾', labelHe: 'קושי', value: 'קל' },
          { emoji: '📏', labelHe: 'מרחק', value: '5.3 ק"מ' },
          { emoji: '📈', labelHe: 'טיפוס', value: '208 מ׳' },
          { emoji: '⏱️', labelHe: 'זמן', value: 'שעה וחצי' },
        ],
      },
      {
        nameHe: 'אגם סורפיס',
        iso: 'IT',
        query: 'Lago di Sorapis',
        fields: [
          { emoji: '🥾', labelHe: 'קושי', value: 'בינוני' },
          { emoji: '📏', labelHe: 'מרחק', value: '12.5 ק"מ' },
          { emoji: '📈', labelHe: 'טיפוס', value: '730 מ׳' },
          { emoji: '⏱️', labelHe: 'זמן', value: '5 שעות' },
        ],
      },
      {
        nameHe: 'טרה צ׳ימה די לאוורדו',
        iso: 'IT',
        query: 'Tre Cime di Lavaredo',
        fields: [
          { emoji: '🥾', labelHe: 'קושי', value: 'בינוני' },
          { emoji: '📏', labelHe: 'מרחק', value: '10 ק"מ' },
          { emoji: '📈', labelHe: 'טיפוס', value: '350 מ׳' },
          { emoji: '⏱️', labelHe: 'זמן', value: '4 שעות' },
        ],
      },
      {
        nameHe: 'סצ׳דה',
        iso: 'IT',
        query: 'Seceda',
        fields: [
          { emoji: '🚡', labelHe: 'רכבל', value: 'מאורטיזיי' },
          { emoji: '📏', labelHe: 'מרחק', value: '6 ק"מ' },
          { emoji: '📈', labelHe: 'טיפוס', value: '400 מ׳' },
          { emoji: '⏱️', labelHe: 'זמן', value: 'שעתיים' },
        ],
      },
    ],
  },
];

/**
 * A photograph for one query, cached on disk.
 *
 * Cached because the point of this script is to be run twenty times in a row
 * while a number in the stylesheet is being argued with, and re-downloading the
 * same five mountains each time is both slow and rude to the library. Delete
 * out/lab/photos to get fresh ones.
 */
async function photo(query) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${query.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`);

  if (existsSync(file)) {
    return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
  }
  if (noPhotos || !pexels.configured()) return null;

  // The same shape the slide is, for the same reason the pipeline now asks for
  // it: judging or caching a 4:5 frame and rendering it into a 9:16 one throws
  // away a third of the picture.
  const got = await pexels.search(query, {}).catch(() => null);
  const hit = got?.src ? got : null;
  if (!hit) return null;

  const base64 = hit.src.split(',')[1];
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return hit.src;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const rendered = [];

  for (const spec of DECKS) {
    const coverImage = await photo(spec.coverQuery);
    const slides = [];
    for (const s of spec.slides) {
      const src = await photo(s.query);
      slides.push({
        ...s,
        flag: flagFor(s.iso),
        image: src ? { src } : null,
      });
    }

    const deck = {
      id: spec.id,
      style: spec.style,
      titleHe: spec.titleHe,
      idea: { emphasisHe: spec.emphasisHe },
      coverImage: coverImage ? { src: coverImage } : null,
      slides,
    };

    // Both sizes, because they are not the same render. The measurement runs
    // per size — a 4:5 frame crops a 9:16 photograph top and bottom, so the
    // quiet region moves — and TikTok's button rail is excluded only on the
    // TikTok one. Rendering only the tall version would leave the Instagram
    // path uncovered until something broke in it on a live post.
    for (const size of ['tiktok', 'instagram']) {
      const out = await renderDeckSize(deck, { size, outDir: OUT });
      rendered.push({ titleHe: spec.titleHe, style: spec.style, size, slides: out });
      console.log(`${spec.id} · ${size} · ${out.length} slides`);
      for (const s of out) {
        if (!s.spot) continue;
        console.log(
          `   ${String(s.index).padStart(2)} ${(s.nameHe || '').padEnd(22)} ${s.spot.side.padEnd(6)} y=${s.spot.y.toFixed(
            2
          )} lum=${String(s.spot.lum).padEnd(5)} busy=${String(s.spot.busy).padEnd(5)} ${s.spot.color}`
        );
      }
    }
  }

  const sheet = writeContactSheet(rendered, OUT, { title: 'deck lab' });
  console.log(`\nContact sheet: ${sheet}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
