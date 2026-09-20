import { renderToJpeg, cardOutputDir, cardPublicUrl } from './index.js';
import { renderSlideHtml, SIZES, isStyle, INK_LUMINANCE } from './deckTemplates.js';
import { analyseSlides } from './photo.js';
import { findTextRegion } from '../images/textbox.js';

// A deck to files on disk, twice.
//
// Both platforms fetch the images from a public URL rather than receiving
// bytes, so every slide of every size has to exist as its own file with its own
// address — there is no "post the same picture, cropped" shortcut available
// here even if the crop were acceptable, which it is not.
//
// Filenames carry the size and the index because both are load-bearing: TikTok
// publishes `photo_images` in array order, and a carousel that ships its slides
// out of order is a deck that counts 1, 4, 2, 5, 3.

/** Deterministic and sortable, so the order on disk is the order on the post. */
export const slideStem = (deckId, size, index) => `deck-${deckId}-${size}-${String(index).padStart(2, '0')}`;

/**
 * Roughly how tall the text on a slide will be, as a fraction of the frame.
 *
 * Not a layout measurement — it is the size of the hole the placement search
 * goes looking for. Searching with the wrong height finds a gap the words do
 * not fit in, which is how a four-line block lands in a narrow strip of sky
 * with a ridge through the middle of it.
 */
/**
 * How wide the text needs to be, as a fraction of the frame.
 *
 * A cover is a sentence and needs room to break into two or three even lines;
 * a place name is two words and does not. Given too little, the text stacks one
 * word per line and reads as ragged rather than as a title — which is what a
 * cover squeezed into a narrow strip of sky looked like.
 */
function blockWidth({ cover = false, style = 'minimal' } = {}) {
  // A cover is a sentence and wants room. At 0.68 a thirty-character title
  // broke into three lines of 9, 17 and 6 characters — balanced wrapping cannot
  // rescue a column that is simply too narrow for the words.
  if (cover) return 0.78;
  return style === 'info' ? 0.54 : 0.48;
}

function blockHeight(slide, { cover = false, style = 'minimal' } = {}) {
  if (cover) {
    // Two lines, or three for a title long enough to need the smallest step.
    //
    // It used to allow four, which was true of the old type scale and is not of
    // this one: every step down also buys more characters per line, so a title
    // that wrapped to four lines at the old sizes wraps to two at these. Asking
    // for a hole twice the height of the words is not caution, it is a search
    // that rejects every gap in the photograph and settles for the least bad
    // one — which is how a cover ended up across a ridge.
    const n = String(slide.titleHe || '').length;
    const lines = n > 44 ? 3 : 2;
    return Math.min(0.24, lines * (style === 'info' ? 0.05 : 0.044));
  }

  if (style === 'info') {
    const fields = Math.min(4, (slide.fields || []).length);
    return 0.05 + fields * 0.035;
  }

  const label = [slide.nameHe, slide.countryHe].filter(Boolean).join(', ');
  const nameLines = label.length > 30 ? 2 : 1;
  // The minimal style shows a note when it has either a written bullet or a
  // measured fact to fall back on, so the search has to allow for one in both
  // cases or the block lands in a gap one line too short for it.
  const hasNote = (slide.bullets || []).length > 0 || (slide.fields || []).length > 0;
  return nameLines * 0.032 + (slide.flag ? 0.032 : 0) + (hasNote ? 0.03 : 0);
}

/**
 * Render every slide of a deck at one size.
 *
 * Measured first, drawn second. Every photograph in the deck is sampled in one
 * pass — the empty region, its brightness, its colour — and each slide is then
 * rendered against its own answer. That order is the point: placement and text
 * colour are properties of the photograph, and the renderer cannot know either
 * of them from the HTML.
 */
export async function renderDeckSize(deck, { size = 'tiktok', outDir = cardOutputDir() } = {}) {
  if (!SIZES[size]) throw new Error(`unknown deck size: ${size}`);
  const geometry = SIZES[size];
  const style = isStyle(deck.style) ? deck.style : 'minimal';

  const cover = {
    titleHe: deck.titleHe,
    emphasisHe: deck.idea?.emphasisHe,
    // Its own photograph, claimed before the slides took theirs. Opening on the
    // same picture the next slide shows reads as running out of material.
    image: deck.coverImage || deck.slides[0]?.image,
  };

  const items = [cover, ...deck.slides];
  const spots = await analyseSlides(
    items.map((slide, i) => ({
      src: slide.image?.src || null,
      place: i === 0 ? deck.titleHe : slide.nameHe,
      blockH: blockHeight(slide, { cover: i === 0, style }),
      blockW: blockWidth({ cover: i === 0, style }),
      // Instagram draws none of TikTok's furniture over the image, so the rail
      // exclusion that pushes text left on a TikTok slide would be inventing a
      // constraint here.
      rail: size === 'tiktok',
    })),
    {
      topSafe: geometry.topSafe,
      bottomSafe: geometry.bottomSafe,
      height: geometry.h,
      inkLum: INK_LUMINANCE[style],
      // Where the background is. The pixel heuristic could not tell sky from a
      // snowfield — see the note in images/textbox.js — so the semantic half of
      // the question is asked, and the measurements then search inside the
      // answer. Skippable with DECK_TEXTBOX=off, which falls back to the pixel
      // detector and costs nothing.
      regionHint:
        process.env.DECK_TEXTBOX === 'off'
          ? null
          : (thumb, item) => findTextRegion(thumb, { place: item.place }),
    }
  );

  const out = [];
  for (const [i, slide] of items.entries()) {
    const index = i + 1;
    const html = renderSlideHtml(
      { ...slide, blockH: blockHeight(slide, { cover: i === 0, style }) },
      { size, cover: i === 0, style, spot: spots[i] }
    );
    const rendered = await renderToJpeg(html, {
      stem: slideStem(deck.id, size, index),
      width: geometry.w,
      height: geometry.h,
      outDir,
    });
    out.push({
      ...rendered,
      index,
      cover: i === 0,
      nameHe: i === 0 ? deck.titleHe : slide.nameHe,
      // Kept so a slide that came out wrong can be argued about with the
      // numbers that placed it rather than from memory.
      spot: spots[i] || null,
    });
  }

  return out;
}

/**
 * Both sizes, in the shape the publishers want.
 *
 * Returns { tiktok: [...], instagram: [...] } with each entry carrying the
 * public URL. A null url means CARD_PUBLIC_BASE_URL is unset, and both
 * publishers refuse on that rather than posting a broken image.
 */
export async function renderDeck(deck, { outDir = cardOutputDir() } = {}) {
  const tiktok = await renderDeckSize(deck, { size: 'tiktok', outDir });
  const instagram = await renderDeckSize(deck, { size: 'instagram', outDir });
  return {
    tiktok,
    instagram,
    // Convenience for the approval message, which shows the TikTok shape
    // because that is the platform the deck is designed for.
    preview: tiktok,
    urls: {
      tiktok: tiktok.map((s) => s.url),
      instagram: instagram.map((s) => s.url),
    },
  };
}

export { cardPublicUrl };
