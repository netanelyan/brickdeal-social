import { readFileSync } from 'node:fs';

// What the renderer draws with.
//
// The palette is a fallback ground and nothing else — a BrickDeal slide is a
// photograph with white type on it.
//
// The TYPE is now the travel pipeline's, face for face. It was one file, Rubik,
// on the argument that Israeli social graphics are set in a display face and
// that a display face is what holds a heavy outline. Both halves of that were
// true of the heavy version these slides no longer are: the outline came down
// to ~2px, the scrim took over legibility, and what was left was a logo-weight
// face doing a caption's job.
//
// So the stack matches tiyul-social's, which is the channel these slides sit
// beside. TikTok Sans is the app's own typeface and goes FIRST, carrying
// exactly the glyphs it has — the digits, which on a BrickDeal slide is most of
// what is written — and every Hebrew letter falls through it, per glyph, to
// Arimo. That per-glyph fallback is not a workaround: TikTok Sans has no Hebrew
// at all, so falling through is precisely what the app does with Hebrew text,
// and matching it means matching what a viewer already sees in the editor.

export const palette = {
  // Only ever seen when a slide has no photograph — a build where generation
  // failed AND the catalogue image was missing too. Kept as a gradient rather
  // than flat black so that case looks like a deliberate slide rather than a
  // rendering failure, which is what a black rectangle reads as.
  ink: '#10201F',
  inkSoft: '#1B302E',
};

/**
 * The four faces, inlined.
 *
 * INLINED PER RENDER, and that is not an optimisation to be tidied away. A
 * webfont that fails to load does not error: Chromium silently falls through to
 * whatever it has, and for Hebrew on a bare Linux box that is very often tofu
 * boxes. A card full of ▯▯▯ screenshots perfectly happily. Faces bundled in the
 * travel repo turned out to be corrupt and had never once loaded, which is
 * exactly that failure — and it is why render/index.js proves the face actually
 * loaded before it takes the screenshot.
 *
 * Every one of these is cached after the first read. Four data URIs is roughly
 * 1.7MB of base64 built into each page, which at one deck of eight slides twice
 * over is the difference between reading four files and reading sixty-four.
 *
 * WEIGHTS ARE NOT INTERCHANGEABLE HERE, and the declared ranges in brickSlide.js
 * are copied off the files rather than guessed. Three of the four are variable;
 * ARIMO IS NOT. It is a single static SemiBold — usWeightClass 600, one instance,
 * no fvar table — so 600 is the only weight Hebrew can actually be set in, and
 * asking CSS for 700 gets Chromium's synthetic bold rather than a bolder Arimo.
 * That is why brick-config.json's overlay weight is 600: it is the weight the
 * bundled file has, not a preference.
 */
const uriCache = new Map();
const dataUri = (file) => {
  if (uriCache.has(file)) return uriCache.get(file);
  const buf = readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url));
  const uri = `data:font/ttf;base64,${buf.toString('base64')}`;
  uriCache.set(file, uri);
  return uri;
};

/** TikTok Sans, the app's own face. Variable, wght 300-900. No Hebrew at all. */
export const tiktokSansDataUri = () => dataUri('TikTokSans.ttf');

/** Arimo SemiBold, which carries the Hebrew. STATIC — 600 and nothing else. */
export const arimoDataUri = () => dataUri('Arimo.ttf');

/** Assistant, variable wght 200-800. First fallback under Arimo. */
export const assistantDataUri = () => dataUri('Assistant.ttf');

/** Heebo, variable wght 100-900. Last resort before the system face. */
export const heeboDataUri = () => dataUri('Heebo.ttf');

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
