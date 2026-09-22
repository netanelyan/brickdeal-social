import { createHash } from 'node:crypto';
import { renderDeck } from '../render/deck.js';
import { deckCaption, deckTiktokCaption, captionHook } from '../format.js';
import { targetsForKind } from '../publish/targets.js';
import { overrideActive, overrideNotes } from '../override.js';
import { recentPublished } from '../store.js';
import { placeOverCap } from '../pillars.js';

/** How many decks in a row have been about this same place and category. */
export const deckTopic = (deck) => `${deck.where} · ${deck.category}`;

/**
 * "Third mountain deck in a row" — the sentence the owner asked to be told.
 *
 * Counted as a RUN from the newest post backwards rather than as a share,
 * because a share cannot see a streak: three consecutive Dolomites decks out of
 * forty posts is 7% of the window and looks like nothing, while on the feed it
 * is the only thing anybody notices.
 */
export function deckRepeats(deck, history = recentPublished()) {
  const notes = [];

  const topic = deckTopic(deck);
  let run = 0;
  for (const p of history) {
    if (p.topic !== topic) break;
    run++;
  }
  if (run >= 1) notes.push(`חוזר על "${topic}" — ${run + 1} מצגות ברצף`);

  // The same run counted on the PLACE alone, because the topic above is
  // "<where> · <category>" and that is too specific to catch the thing it was
  // written for. Kyoto temples, then Kyoto food, then Kyoto gardens is three
  // different topics: the run breaks at the first one and reports nothing,
  // while the feed reads as three Kyoto posts running. Which it is.
  const place = String(deck.where || '').trim().toLowerCase();
  if (place) {
    let placeRun = 0;
    for (const p of history) {
      if (String(p.place || '').trim().toLowerCase() !== place) break;
      placeRun++;
    }
    if (placeRun >= 1 && placeRun !== run) {
      notes.push(`אותו מקום (${deck.where}) — ${placeRun + 1} ברצף`);
    }
  }

  // And the share, which a run cannot see. Decks never reach quotaBlock, so
  // unlike a card this is not blocked anywhere — saying it is the whole
  // intervention, and it needs to be said before you tap approve.
  const over = placeOverCap(deck.where, history);
  if (over) notes.push(over);

  return notes;
}

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
 * Which render sizes a set of destinations needs.
 *
 * One each, deduplicated, in the order the destinations were given — so the
 * first one is what the approval message previews.
 */
export const sizesFor = (targets) => [
  ...new Set((targets || []).filter((t) => t === 'instagram' || t === 'tiktok')),
];

/**
 * Render a built deck and wrap it for approval.
 *
 * Rendering happens here rather than in build.js for the same reason the card
 * pipeline renders last: it is the only step that costs a browser, and a deck
 * that lost too many slides to be worth publishing should not have paid for it.
 *
 * `targets` is the destination chosen at the proposal, and it decides which
 * sizes are rendered at all — a deck bound for Instagram does not pay for the
 * TikTok crop of itself.
 */
export async function toDeckCandidate(
  built,
  {
    minSlides = Number(process.env.DECK_MIN_SLIDES || 3),
    targets = targetsForKind('deck'),
    tiktokDraft = false,
  } = {}
) {
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
  const rendered = await renderDeck(deck, { sizes: sizesFor(targets) });

  // Drop the photographs now that they are baked into the JPEGs.
  //
  // images.js hands back each photo as a base64 data URI — a megabyte or two of
  // string per slide, held so the renderer can put it in an <img>. Once the
  // slides exist on disk it is dead weight, and not merely wasteful: a staged
  // candidate lives in data/store.json, and store.js rewrites that whole file
  // on every save. A six-slide deck awaiting approval would re-serialise ~10MB
  // of base64 every time anything else marked an item seen.
  //
  // Cards deliberately keep theirs: editing a headline re-renders the card, and
  // that re-render needs the image. A deck has no edit path for exactly this
  // reason — it is re-run instead.
  deck.slides = deck.slides.map((s) =>
    s.image ? { ...s, image: { provenance: s.image.provenance, credit: s.image.credit || null } } : s
  );

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
    // Chosen at the proposal, not derived here: the owner picked the platform
    // before the build, and that choice is what the slides were rendered for.
    publishTargets: targets,
    // Not a destination but a way of reaching one: the slides go to the
    // account's TikTok inbox and the owner posts them from the app, which is
    // the only route to choosing the sound. Carried on the candidate so it
    // survives the wait in the queue — the decision was made at the proposal,
    // possibly hours before this publishes.
    tiktokDraft: Boolean(tiktokDraft),
    createdAt: deck.createdAt,
    // Same as a card: whatever the owner's request stepped over travels with
    // the deck so it can be said before it publishes, not discovered after.
    overrides: overrideActive() ? overrideNotes() : [],
    // Repeats are NOT overrides and no longer ride along with them. They were
    // only computed when an override was active, so on the ordinary path —
    // every path, almost always — nobody was ever told "the third Kyoto deck in
    // a row", which is precisely when being told is useful. And folding them
    // into `overrides` filed them under "controls bypassed" when no control had
    // been bypassed at all.
    notes: deckRepeats(deck),
  };

  // Not the same text, and the difference is one field.
  //
  // TikTok carries the title separately in post_info.title, so its description
  // opens with the line rather than with the title — repeating the title there
  // spends the description's first line on a line the viewer just read two
  // centimetres higher. Instagram has no title field on a carousel, so its
  // caption has to open with the title or the post has none.
  //
  // ONE hook for the post, drawn here and handed to both. Calling captionHook
  // twice would draw twice, and the same slideshow would go out under two
  // different opening lines — which is not a variation, it is a bug that looks
  // like one post made by two people.
  //
  // Both calls run the URL guard and THROW rather than returning something
  // unpublishable. A deck that cannot produce a clean caption fails here, in
  // the build, which is upstream of everything: it never becomes a candidate,
  // never reaches the queue, and never becomes something that can be approved
  // by tapping without reading the last line.
  const hook = captionHook();
  const caption = deckCaption(deck, { hook });
  cand.channelCaption = [deck.titleHe, '', caption].join('\n');
  cand.instagramCaption = caption;
  cand.tiktokCaption = deckTiktokCaption(deck, { hook });

  // A deck publishes from its slide URLs, but Telegram uploads bytes and the
  // held/retry paths look for a file — the cover stands in as "the card".
  cand.card = rendered.preview[0] || null;

  return cand;
}
