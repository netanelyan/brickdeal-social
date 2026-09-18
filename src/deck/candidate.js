import { createHash } from 'node:crypto';
import { renderDeck } from '../render/deck.js';
import { deckCaption } from '../format.js';
import { targetsForKind } from '../publish/targets.js';

// A built deck becomes something the approval queue can carry.
//
// Deliberately the same shape as a card candidate — id, publishTargets,
// captions, an approval message — so staging, the queue, the drip, the
// per-destination retry and the held list all work on it unchanged. The only
// field the rest of the bot has to know about is `kind`, and it uses it in
// exactly three places: which approval message to write, whether to send an
// album, and which destinations are allowed.

/**
 * Stable across re-runs of the same idea, so a deck cannot be staged twice.
 *
 * Keyed on what the deck IS — the region, the category and the places in it —
 * rather than on the title, which the model rewrites slightly every time it is
 * asked. Two decks about the same five Prague museums are the same deck even if
 * one is called "חמישה מוזיאונים" and the other "המוזיאונים של פראג".
 */
export function deckId(deck) {
  const key = [deck.where, deck.category, ...deck.slides.map((s) => s.qid).sort()].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Render a built deck and wrap it for approval.
 *
 * Rendering happens here rather than in build.js for the same reason the card
 * pipeline renders last: it is the only step that costs a browser, and a deck
 * that lost too many slides to be worth publishing should not have paid for it.
 */
export async function toDeckCandidate(built, { minSlides = Number(process.env.DECK_MIN_SLIDES || 3) } = {}) {
  if (built.slides.length < minSlides) {
    const err = new Error(
      `only ${built.slides.length} slide(s) survived sourcing, needs ${minSlides} — ` +
        (built.dropped[0]?.why || 'no reason recorded')
    );
    err.deck = built;
    throw err;
  }

  const id = deckId(built);
  const deck = { ...built, id };
  const rendered = await renderDeck(deck);

  const cand = {
    kind: 'deck',
    id,
    headline: deck.titleHe,
    // The pipeline's shared vocabulary. A deck has no single source item, so
    // these describe the deck itself; the per-slide sources are in deck.slides.
    sourceName: `${deck.where} · ${deck.category}`,
    sourceUrl: deck.slides[0]?.sourceUrl || null,
    pillar: 'day',
    tags: [],
    deck: { ...deck, ...rendered },
    publishTargets: targetsForKind('deck'),
    createdAt: deck.createdAt,
  };

  // Both platforms get the same words, for the same reason the card does: the
  // approval message shows you one caption, and a second wording would be a
  // second thing nobody reviewed.
  const caption = deckCaption(deck);
  cand.channelCaption = [deck.titleHe, '', caption].join('\n');
  cand.instagramCaption = caption;
  cand.tiktokCaption = caption;

  // A deck publishes from its slide URLs, but Telegram uploads bytes and the
  // held/retry paths look for a file — the cover stands in as "the card".
  cand.card = rendered.preview[0] || null;

  return cand;
}
