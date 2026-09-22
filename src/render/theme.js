import { readFileSync } from 'node:fs';

// What the renderer draws with.
//
// Down to one typeface and a handful of colours. It used to carry five faces
// and a full card palette, because the travel pipeline rendered news cards as
// well as slides and its two slide styles set Hebrew in two different families.
// A BrickDeal slide is a photograph with white type on it, so the palette is
// down to a fallback ground and the type is down to one face.

export const palette = {
  // Only ever seen when a slide has no photograph — a build where generation
  // failed AND the catalogue image was missing too. Kept as a gradient rather
  // than flat black so that case looks like a deliberate slide rather than a
  // rendering failure, which is what a black rectangle reads as.
  ink: '#10201F',
  inkSoft: '#1B302E',
};

/**
 * Rubik, inlined.
 *
 * A display face with real weight at 800, which is what Israeli social graphics
 * are actually set in, and — the property that matters most here — it holds a
 * heavy outline without the letterforms closing up. A text face at this size
 * with a 12px stroke around every glyph loses its counters and turns into
 * shapes.
 *
 * INLINED PER RENDER, and that is not an optimisation to be tidied away. A
 * webfont that fails to load does not error: Chromium silently falls through to
 * whatever it has, and for Hebrew on a bare Linux box that is very often tofu
 * boxes. A card full of ▯▯▯ screenshots perfectly happily. Four of the faces
 * that used to be bundled here turned out to be corrupt and had never once
 * loaded, which is exactly that failure — and it is why render/index.js proves
 * the face actually loaded before it takes the screenshot.
 *
 * One variable file covering every weight the slides ask for.
 */
let rubikCache = null;
export function rubikDataUri() {
  if (rubikCache) return rubikCache;
  const buf = readFileSync(new URL('../../assets/fonts/Rubik.ttf', import.meta.url));
  rubikCache = `data:font/ttf;base64,${buf.toString('base64')}`;
  return rubikCache;
}

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
