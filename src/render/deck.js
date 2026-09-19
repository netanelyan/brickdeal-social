import { renderToJpeg, cardOutputDir, cardPublicUrl } from './index.js';
import { renderSlideHtml, SIZES } from './deckTemplates.js';

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
 * Render every slide of a deck at one size.
 *
 * The cover is slide 1 and is rendered from the deck itself rather than from a
 * slides entry, because it carries the title and no facts — it is the one slide
 * with nothing to source.
 */
export async function renderDeckSize(deck, { size = 'tiktok', outDir = cardOutputDir() } = {}) {
  if (!SIZES[size]) throw new Error(`unknown deck size: ${size}`);

  const total = deck.slides.length + 1;
  const out = [];

  const cover = await renderToJpeg(
    renderSlideHtml({
      titleHe: deck.titleHe,
      angleHe: deck.idea?.angleHe,
      // The city, above the title. Falls back to the English region rather than
      // printing nothing — a cover with no place on it is the one that gets
      // scrolled past.
      eyebrow: deck.idea?.eyebrowHe || deck.where,
      // Its own photograph, claimed before the slides took theirs. Opening on
      // the same picture the next slide shows reads as running out of material.
      image: deck.coverImage || deck.slides[0]?.image,
    }, {
      index: 1,
      total,
      size,
      cover: true,
    }),
    { stem: slideStem(deck.id, size, 1), width: SIZES[size].w, height: SIZES[size].h, outDir }
  );
  out.push({ ...cover, index: 1, cover: true });

  for (const [i, slide] of deck.slides.entries()) {
    const index = i + 2;
    const rendered = await renderToJpeg(renderSlideHtml(slide, { index, total, size }), {
      stem: slideStem(deck.id, size, index),
      width: SIZES[size].w,
      height: SIZES[size].h,
      outDir,
    });
    out.push({ ...rendered, index, cover: false, nameHe: slide.nameHe });
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
