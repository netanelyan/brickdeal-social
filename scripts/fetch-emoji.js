import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_USED } from '../src/brick/emoji.js';

// Fetches the emoji artwork the slides draw with.
//
//   npm run fetch-emoji
//
// One PNG per emoji, committed to assets/emoji/. That is deliberate and it is
// the same argument the bundled Heebo makes: a slide that depends on whatever
// emoji font the machine happens to have is a slide that renders differently on
// the VPS than it did in review — and the failure is silent, because a missing
// emoji is a box rather than an error. Thirty small files remove the question.
//
// WHY NOT APPLE'S. Apple Color Emoji is what the team sees when they type, and
// it is the set these slides are trying to look like. It cannot be used here:
// the artwork is Apple's, it ships only with their operating systems, and Apple
// grants no licence to redistribute it. Rendering happens on an Ubuntu box, so
// there is no lawful path to it. Noto is the closest set that is actually
// licensed for this (OFL/Apache), and swapping to another is a matter of
// pointing SET_URL somewhere else — the renderer only ever asks for a file.
//
// JoyPixels is the nearest thing to Apple's drawings that can be licensed for
// commercial use, and it is a paid licence. If that is wanted, buy it and point
// this script at their assets.

const TAG = process.env.EMOJI_SET_TAG || 'v2.047';
const SET_URL = process.env.EMOJI_SET_URL || `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@${TAG}/png/128/emoji_u{cp}.png`;

const outDir = fileURLToPath(new URL('../assets/emoji/', import.meta.url));

/**
 * The filename for an emoji.
 *
 * U+FE0F is dropped: it is a presentation selector rather than a character, and
 * Noto files are named without it. Keeping it turns every heart and every
 * shrug into a 404.
 */
export const codepoints = (ch) =>
  [...ch].map((c) => c.codePointAt(0).toString(16)).filter((hex) => hex !== 'fe0f');

export const fileFor = (ch) => `${codepoints(ch).join('_')}.png`;

async function main() {
  mkdirSync(outDir, { recursive: true });

  // One emoji per theme, a handful of overrides for items whose theme implies
  // the wrong picture, and the money bag that rides every saving line. Each one
  // lands on the name line of a slide, so a missing file is immediately visible
  // - and, worse, visible only on the machine that is missing it.
  const wanted = [...new Set(ALL_USED)];
  let fetched = 0;
  let already = 0;
  const missing = [];

  for (const ch of wanted) {
    const file = outDir + fileFor(ch);
    if (existsSync(file)) {
      already++;
      continue;
    }
    const url = SET_URL.replace('{cp}', codepoints(ch).join('_'));
    const res = await fetch(url);
    if (!res.ok) {
      missing.push(`${ch} (${res.status}) ${url}`);
      continue;
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }

  console.log(`${wanted.length} in the vocabulary · ${fetched} fetched · ${already} already here`);
  if (missing.length) {
    console.log('\nNOT FOUND — these will fall back to the system font, which is what we are trying to avoid:');
    for (const m of missing) console.log('  ' + m);
  }
  console.log(`\nSaved to assets/emoji/ from ${SET_URL.replace('{cp}', '<codepoints>')}`);
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}\n`);
  process.exitCode = 1;
});
