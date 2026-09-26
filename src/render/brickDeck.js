import { renderToJpeg, cardOutputDir, cardPublicUrl } from './index.js';
import { renderBrickSlideHtml } from './brickSlide.js';
import { SIZES } from './sizes.js';

// A built deck to JPEGs on disk.
//
// The travel equivalent spends most of its time measuring each photograph to
// decide where the words go. This does not, and the reason is in brickSlide.js:
// the reference pins its block to the same corner on every slide, and that
// sameness is what makes five swipes read as one post rather than five posts.
// So there is no placement search here, which also means a deck renders in
// about a second a slide instead of ten.

export const slideStem = (deckId, size, index) =>
  `brick-${deckId}-${size}-${String(index).padStart(2, '0')}`;

/**
 * One size of one deck.
 *
 * The cover comes first and carries the hook. It takes the FIRST slide's
 * photograph rather than one of its own — unlike the travel deck, which claims
 * a separate cover image because opening on the same picture the next slide
 * shows "reads as running out of material".
 *
 * That argument does not survive the move. A travel deck's cover photograph is
 * a different place; here it would have to be a different set, and a cover
 * showing a set that is then never mentioned is worse than a repeat — it is the
 * post promising six and delivering five. Reusing slide one's shot costs one
 * generated image less per deck and is what the reference does.
 */
export async function renderBrickDeckSize(deck, { size = 'tiktok', outDir = cardOutputDir() } = {}) {
  if (!SIZES[size]) throw new Error(`unknown deck size: ${size}`);
  const { w, h } = SIZES[size];

  const items = [{ hookHe: deck.hookHe, emphasisHe: deck.emphasisHe, image: deck.slides[0]?.image, cover: true }, ...deck.slides];

  const out = [];
  for (const [i, slide] of items.entries()) {
    const index = i + 1;
    const html = renderBrickSlideHtml(slide, { size, cover: i === 0 });
    const rendered = await renderToJpeg(html, {
      stem: slideStem(deck.id, size, index),
      width: w,
      height: h,
      outDir,
      // Arimo carries every Hebrew word on these slides, and the guard measures
      // Hebrew — so this has to be Arimo and not TikTok Sans, which is first in
      // the stack but has no Hebrew in it at all. Naming the face is what stops
      // the guard proving that a font the page never draws with did or did not
      // load; naming the wrong one would have it prove nothing while passing.
      face: 'Arimo',
    });
    out.push({
      ...rendered,
      index,
      cover: i === 0,
      nameHe: i === 0 ? deck.hookHe : slide.nameHe,
      url: cardPublicUrl(rendered.filename),
    });
  }

  return out;
}

/**
 * Both sizes, in the shape the publishers want.
 *
 * A null url means CARD_PUBLIC_BASE_URL is unset, and both publishers refuse on
 * that rather than posting a broken image — Instagram fetches the bytes from a
 * public URL rather than receiving them, so a deck that only exists on local
 * disk cannot be published.
 */
export async function renderBrickDeck(deck, { outDir = cardOutputDir(), sizes = ['tiktok', 'instagram'] } = {}) {
  const rendered = {};
  for (const size of sizes) {
    rendered[size] = await renderBrickDeckSize(deck, { size, outDir });
  }
  return {
    ...rendered,
    // What the approval album shows. The first configured size, because that is
    // the one the deck was built for.
    preview: rendered[sizes[0]] || [],
  };
}
