import { brickConfig } from './config.js';
import { assertCopy, assertNoUrl } from './copy.js';
import { THEME_HE } from './themes.js';

// What goes under the post.
//
// The reference's shape exactly: one or two sentences, the call to the
// community, a separator line, then five hashtags. Two or three emoji in the
// whole thing and no more.
//
// The one thing it deliberately does NOT carry is a link, and that is enforced
// twice over rather than trusted. The community is reachable from the bio,
// which is the only tappable route either platform offers anyway, and an
// external domain in a TikTok description is a demotion — so `assertNoUrl`
// runs here, at build time, before a caption can become something approvable by
// tapping. `assertCopy` runs beside it for the trademark and the em dash.

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
 * The deck's own theme, as a hashtag can carry it.
 *
 * The only tag on the post that is actually ABOUT the post, and the one
 * somebody browsing for a particular franchise will match on. Returns null
 * rather than guessing — a price roundup spanning six themes genuinely has no
 * theme tag, and inventing one is worse than spending the slot on the pool.
 *
 * A tag has no spaces: "הארי פוטר" closes up into one word, which is what a
 * person typing it would do anyway.
 */
export function themeTag(deck) {
  const key = deck?.theme || null;
  const he = key ? THEME_HE[key] : null;
  if (!he) return null;
  const word = String(he).replace(/\s+/g, '').replace(/[^\p{L}\p{N}׳״'"]/gu, '');
  return word.length >= 2 ? `#${word}` : null;
}

/**
 * The hashtag block: exactly broadCount + nicheCount tags.
 *
 * "Exactly" is enforced rather than hoped for. The theme tag REPLACES a niche
 * draw instead of being appended to it, so a deck whose theme resolved and a
 * deck whose theme did not both publish with the same number of tags — which
 * is the thing that would otherwise vary invisibly between posts and make the
 * count impossible to reason about when reading the numbers back.
 */
export function hashtagsFor(deck, { rand = Math.random } = {}) {
  const cfg = brickConfig().hashtags;
  const taken = new Set();

  const broad = draw(cfg.broad, cfg.broadCount, taken, rand);

  const niche = [];
  if (cfg.useTheme) {
    const tag = themeTag(deck);
    if (tag) {
      niche.push(tag);
      taken.add(tag);
    }
  }
  niche.push(...draw(cfg.niche, cfg.nicheCount - niche.length, taken, rand));

  return [...broad, ...niche];
}

/** The line that opens a post, drawn from the pool. */
export const captionHook = ({ rand = Math.random } = {}) => {
  const lines = brickConfig().caption.lines;
  return lines[Math.floor(rand() * lines.length)];
};

/**
 * Everything about a post that is drawn at random, drawn ONCE.
 *
 * A deck publishes to TikTok and to Instagram, and both descriptions have to be
 * the same post. Passing only the hook was not enough and the first end-to-end
 * run proved it: the two captions came back with different hashtags — TikTok
 * got #חוסכים #תחביב and Instagram got #אבניבנייה #בונים off the same deck,
 * because each call drew its own. That is not a variation between platforms, it
 * is one slideshow going out as two posts that happen to share their pictures.
 *
 * So the drawing happens here, once, and both captions are written from the
 * result. The same argument the hook already made, applied to the thing that
 * was still getting it wrong.
 */
export const dressing = (deck, { rand = Math.random } = {}) => ({
  hook: captionHook({ rand }),
  tags: hashtagsFor(deck, { rand }),
});

/**
 * The whole caption.
 *
 * `hook` and `tags` are passed in rather than drawn here — see `dressing`. The
 * defaults draw a fresh set, which is correct for a single caption on its own
 * and wrong for a deck going to two places, so every caller with two
 * destinations passes both.
 */
export function captionFor(deck, { hook, tags, rand = Math.random } = {}) {
  const cfg = brickConfig().caption;
  const drawn = hook != null && tags != null ? { hook, tags } : dressing(deck, { rand });
  const body = [hook ?? drawn.hook, cfg.cta].filter(Boolean).join(' ');
  const text = [body, cfg.separator, (tags ?? drawn.tags).join(' ')].filter(Boolean).join('\n');
  return assertCopy(assertNoUrl(text, 'the caption'), 'the caption');
}

/**
 * Instagram's, which has to open with the title.
 *
 * TikTok carries the title separately in `post_info.title`, so its description
 * opens with the hook — repeating the title there would spend the first line on
 * something the viewer read two centimetres higher. A carousel has no title
 * field at all, so if its caption does not carry the title the post has none.
 */
export function instagramCaptionFor(deck, opts = {}) {
  const caption = captionFor(deck, opts);
  return assertNoUrl([deck.titleHe, '', caption].join('\n').trim(), 'the Instagram caption');
}
