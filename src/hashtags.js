import { postConfig } from './postConfig.js';
import { deckPlace } from './deck/region.js';

// The five tags under every slideshow.
//
// Two broad and three niche, and the split is the whole design: broad tags buy
// the first few hundred impressions from the general pool, niche tags decide
// who the post is shown to after that. All-broad is a post competing with
// everything on the app; all-niche is a post with no way in.
//
// One of the three niche slots is spent on the deck's own country. That tag is
// the only one on the post that is actually ABOUT the post, and it is the one
// somebody searching for a trip will match on.

/**
 * The deck's country, as a hashtag can carry it.
 *
 * Read off the slides rather than off `deck.where`, for the same reason the
 * cover is: `where` is the English string the map was searched with ("Prague"),
 * and the country is a property of the places that actually survived. deckPlace
 * answers it from the slides' own ISO codes, which survive the build — the
 * Hebrew country NAME does not, because applyCountryVisibility strips it from
 * every slide once they all agree on one, which is the common case.
 *
 * Returns null rather than guessing. A deck spanning four countries genuinely
 * has no country tag, and inventing one is worse than spending the slot on the
 * niche pool.
 */
export function destinationTag(deck) {
  if (!deck) return null;
  const place = deckPlace(deck.slides || [], { kind: deck.category });
  const he = place.he || (deck.slides || []).find((s) => s.countryHe)?.countryHe || null;
  if (!he) return null;

  // A hashtag has no spaces and no punctuation. "צ׳כיה" keeps its geresh —
  // that is a letter as far as the name is concerned and the tag is unusable
  // without it — while "דרום מזרח אסיה" closes up into one word, which is what
  // a person typing it would do anyway.
  const word = String(he).replace(/\s+/g, '').replace(/[^\p{L}\p{N}׳״'"]/gu, '');
  return word.length >= 2 ? `#${word}` : null;
}

/** `n` distinct entries from a pool, chosen at random, in the order drawn. */
function draw(pool, n, taken, rand) {
  const left = pool.filter((t) => !taken.has(t));
  const out = [];
  while (out.length < n && left.length) {
    const [tag] = left.splice(Math.floor(rand() * left.length), 1);
    taken.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * The hashtag block for one deck: exactly broadCount + nicheCount tags.
 *
 * "Exactly" is enforced rather than hoped for. The destination tag REPLACES a
 * niche draw instead of being appended to it, so a deck whose country resolved
 * and a deck whose country did not both publish with the same number of tags —
 * otherwise the one variable being tested changes for a reason that has
 * nothing to do with the test.
 *
 * Broad tags lead. They are what the first impressions come from, and a
 * description is read from its first line.
 */
export function hashtagsFor(deck, { rand = Math.random } = {}) {
  const cfg = postConfig().hashtags;
  const taken = new Set();

  const broad = draw(cfg.broad, cfg.broadCount, taken, rand);

  const niche = [];
  const dest = cfg.useDestination ? destinationTag(deck) : null;
  if (dest) {
    taken.add(dest);
    niche.push(dest);
  }
  niche.push(...draw(cfg.niche, cfg.nicheCount - niche.length, taken, rand));

  return [...broad, ...niche];
}

/** The same thing as the line that goes under a caption. */
export const hashtagLine = (deck, opts) => hashtagsFor(deck, opts).join(' ');
