import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { renderToJpeg, closeBrowser } from '../src/render/index.js';
import { renderSlideHtml, SIZES } from '../src/render/deckTemplates.js';
import { analyseSlides } from '../src/render/photo.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { flagFor } from '../src/deck/flags.js';

// Which typeface the Hebrew is set in.
//
//   npm run font-lab
//
// This is a decision that cannot be made from a font specimen. The question is
// not "which of these is a nice Hebrew face" — they all are — it is "which one
// looks like the text somebody typed into TikTok", and the only way to answer
// that is to see the same slide, the same size, over the same photograph, in
// each of them.
//
// WHAT WE ACTUALLY KNOW. TikTok Sans, the app's own typeface, has no Hebrew
// coverage at all: Latin, Greek and Cyrillic only. So when Hebrew is typed into
// TikTok's text tool the app does not draw it with a TikTok font — the phone
// falls back, to SF Hebrew on iOS and to Noto Sans Hebrew on Android. There is
// no single "TikTok Hebrew font" to match. What there is, is the face an iPhone
// shows, and the closest licensable relatives of it.
//
// Apple's SF Hebrew cannot be shipped — it is Apple's, it comes with their
// operating systems, and rendering happens on a Linux box. Same argument as the
// emoji set. So these are the candidates that CAN be shipped, ordered by how
// close they plausibly sit to what an iPhone draws.

const OUT = path.join(process.cwd(), 'out', 'fonts');
const CACHE = path.join(OUT, 'faces');

const CANDIDATES = [
  {
    id: 'heebo',
    family: 'Heebo',
    weight: 600,
    note: 'current default · extends Roboto, so it is the Android-flavoured answer',
  },
  {
    id: 'assistant',
    family: 'Assistant',
    weight: 600,
    note: 'humanist, slightly warmer — the usual stand-in for SF Hebrew on iOS',
  },
  {
    id: 'notosanshebrew',
    family: 'Noto Sans Hebrew',
    weight: 600,
    note: 'literally what Android falls back to, so it IS right for half the audience',
  },
  {
    id: 'rubik',
    family: 'Rubik',
    weight: 500,
    note: 'what the slides used before, at a normal weight instead of Black',
  },
  {
    id: 'arimo',
    family: 'Arimo',
    weight: 600,
    note: 'metric-compatible with Arial, which is what older iOS drew Hebrew with',
  },
];

/**
 * One font file, via the Google Fonts CSS API.
 *
 * Asked for by name and weight rather than by URL, because the URLs under
 * fonts.gstatic.com carry a content hash and change without notice — a
 * hardcoded one works until it quietly 404s. Cached, since this script is meant
 * to be run repeatedly while somebody stares at the output.
 */
async function face({ id, family, weight }) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${id}-${weight}.ttf`);

  if (!existsSync(file)) {
    if (id === 'heebo') {
      // Already bundled; no reason to fetch it.
      const bundled = new URL('../assets/fonts/Heebo.ttf', import.meta.url);
      writeFileSync(file, readFileSync(bundled));
    } else {
      const css = await fetch(
        `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`,
        { headers: { 'user-agent': 'Mozilla/5.0' } }
      ).then((r) => r.text());

      const url = css.match(/url\((https:\/\/[^)]+\.ttf)\)/)?.[1];
      if (!url) throw new Error(`no ttf for ${family} ${weight} — the API returned woff2 only`);
      writeFileSync(file, Buffer.from(await fetch(url).then((r) => r.arrayBuffer())));
    }
  }

  return { family, dataUri: `data:font/ttf;base64,${readFileSync(file).toString('base64')}` };
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // One photograph for all of them, so nothing but the letterforms differs.
  // Reuses whatever deck-lab already cached rather than hitting the library.
  const cached = path.join(process.cwd(), 'out', 'lab', 'photos', 'matterhorn.jpg');
  if (!existsSync(cached)) {
    console.error('No cached photograph. Run `npm run deck-lab` first.');
    process.exitCode = 1;
    return;
  }
  const src = `data:image/jpeg;base64,${readFileSync(cached).toString('base64')}`;

  // A name, a flag and a measured fact — the three things a minimal slide can
  // carry, so every letterform that appears on a real slide appears here.
  const slide = {
    nameHe: 'מאטרהורן, שווייץ',
    flag: flagFor('CH'),
    fields: [{ emoji: '⛰️', labelHe: 'גובה', value: '4,478 מ׳' }],
  };

  const geometry = SIZES.tiktok;
  const [spot] = await analyseSlides([{ src, blockH: 0.1, rail: true }], {
    topSafe: geometry.topSafe,
    bottomSafe: geometry.bottomSafe,
    height: geometry.h,
    inkLum: null,
  });

  const slides = [];
  for (const candidate of CANDIDATES) {
    let font;
    try {
      font = await face(candidate);
    } catch (e) {
      console.error(`${candidate.family}: ${e.message}`);
      continue;
    }

    const html = renderSlideHtml({ ...slide, image: { src } }, { style: 'minimal', spot, font });
    const rendered = await renderToJpeg(html, {
      stem: `font-${candidate.id}`,
      width: geometry.w,
      height: geometry.h,
      outDir: OUT,
    });

    slides.push({ ...rendered, index: slides.length + 1, nameHe: `${candidate.family} ${candidate.weight}`, spot: null });
    console.log(`${candidate.family.padEnd(20)} ${candidate.note}`);
  }

  const sheet = writeContactSheet(
    [{ titleHe: 'איזה פונט עברי', style: 'minimal', size: 'tiktok', note: 'same slide, same photo, one render per face', slides }],
    OUT,
    { title: 'hebrew font — same slide in each candidate' }
  );
  console.log(`\nContact sheet: ${sheet}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
