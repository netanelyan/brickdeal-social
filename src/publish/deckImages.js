// The public URLs of a deck's slides, at one size, in order.
//
// WHY THIS EXISTS AS A FUNCTION rather than a property read.
//
// renderBrickDeck() returns its work keyed by SIZE — { tiktok: [...],
// instagram: [...], preview: [...] } — and toBrickCandidate spreads that onto
// the deck. So the rendered slides have always lived at `deck.tiktok` and
// `deck.instagram`, each an array of objects carrying `.url`.
//
// Both publishers read `deck.urls.tiktok` and `deck.urls.instagram`. Nothing
// has ever written a `urls` key. The reads therefore always returned empty,
// and neither of them said so:
//
//   - TikTok threw "this deck has no 1080x1920 renders — it was built for
//     another destination", which is a sentence about the deck that was never
//     true. Every deck had them. No slideshow has ever reached TikTok.
//   - Instagram fell through to `[cand.card?.url]` and posted the single cover
//     image where a six-slide carousel was meant to go — silently, because one
//     image is a valid post.
//
// A function, and one function for both, because the alternative is to write
// the URLs into the candidate a second time under the name the publishers
// already guess at. Two copies of the same truth in a store that is rewritten
// whole on every save is how this class of bug starts, not how it ends.
//
// Returns strings, because that is what both callers check and pass on.

/** Every rendered slide URL for `size`, in slide order. Empty if unrendered. */
export function deckImageUrls(cand, size) {
  const slides = cand?.deck?.[size];
  if (!Array.isArray(slides)) return [];
  return slides.map((s) => s?.url).filter((u) => typeof u === 'string' && u.length > 0);
}

/**
 * Which sizes a deck actually carries renders for.
 *
 * For error messages that would otherwise have to guess. "Built for instagram"
 * is worth saying only when it is checked rather than assumed.
 */
export function renderedSizes(cand) {
  const deck = cand?.deck || {};
  return ['tiktok', 'instagram'].filter((size) => deckImageUrls({ deck }, size).length > 0);
}
