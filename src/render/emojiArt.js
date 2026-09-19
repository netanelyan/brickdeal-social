import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN } from '../deck/emoji.js';

// Emoji as pictures, not as characters.
//
// A slide that prints an emoji as text is asking the rendering machine which
// drawing to use, and the answer differs per machine: Windows gave a mangled
// glyph where Linux gives Noto and a box where it has nothing. That is a silent
// difference between what was approved and what publishes — the same class of
// failure the bundled Hebrew font exists to prevent.
//
// So the artwork is committed (npm run fetch-emoji) and inlined as a data URI
// at render time. 128px files, a few KB each, and only the ones a slide
// actually uses are read.
//
// What this is NOT is Apple's set, which is what the team types and what the
// reference posts show. Apple licenses that artwork to nobody; it ships with
// their operating systems and rendering happens on Ubuntu. Noto is the closest
// set that can lawfully be shipped here. Swapping the folder swaps the style —
// see scripts/fetch-emoji.js.

const dir = fileURLToPath(new URL('../../assets/emoji/', import.meta.url));
const cache = new Map();

const codepoints = (ch) =>
  [...ch].map((c) => c.codePointAt(0).toString(16)).filter((hex) => hex !== 'fe0f');

/** The data URI for one emoji, or null if we have no artwork for it. */
export function emojiDataUri(ch) {
  if (!ch) return null;
  if (cache.has(ch)) return cache.get(ch);

  const file = `${dir}${codepoints(ch).join('_')}.png`;
  let uri = null;
  if (existsSync(file)) {
    uri = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
  cache.set(ch, uri);
  return uri;
}

export const haveArtFor = (ch) => KNOWN.has(ch) && Boolean(emojiDataUri(ch));

/**
 * One emoji, ready to drop into a line.
 *
 * Falls back to the character itself rather than to nothing: an emoji we have
 * no file for should still appear, just at the mercy of the local font. The
 * alignment nudge matters more than it looks — a 1em image sits on the
 * baseline, and next to Hebrew that reads as a picture stuck under the words.
 */
export function emojiHtml(ch, { size = '1em' } = {}) {
  const uri = emojiDataUri(ch);
  if (!uri) return escape(ch);
  return `<img class="emoji" src="${uri}" alt="${escape(ch)}" style="width:${size};height:${size}">`;
}

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
