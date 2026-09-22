import { createHash } from 'node:crypto';
import { renderBrickDeck } from '../render/brickDeck.js';
import { captionFor, instagramCaptionFor, dressing } from './caption.js';
import { brickConfig } from './config.js';
import { targetsForKind } from '../publish/targets.js';
import { overrideActive, overrideNotes } from '../override.js';
import { recentPublished } from '../store.js';

// A built deck becomes something the approval queue can carry.
//
// Deliberately the same shape as the travel deck candidate — id, publishTargets,
// captions, an approval message — so staging, the queue, the drip, the
// per-destination retry and the held list all work on it unchanged. `kind` stays
// `'deck'` for the same reason: the bot branches on it in exactly three places
// (which approval message to write, whether to send an album, which destinations
// are allowed) and all three want the same answer for a BrickDeal slideshow as
// for a travel one. What this is a deck OF lives on `deck.kind`.

const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')}₪`;

/**
 * Stable across re-runs, so the same deck cannot be staged twice.
 *
 * Keyed on the products in it, sorted — not on the title, which the model
 * rewrites slightly every time it is asked, and not on the recipe, because the
 * same five sets offered as "under 100₪" and as "the biggest savings" are the
 * same post with a different cover.
 */
export function brickDeckId(deck) {
  const key = deck.slides.map((s) => s.productId).sort().join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Which render sizes a set of destinations needs, in the order given.
 *
 * The first is what the approval album previews, so a deck bound for TikTok
 * shows its 9:16 slides rather than the Instagram crop of them.
 */
export const sizesFor = (targets) => [...new Set((targets || []).filter((t) => t === 'instagram' || t === 'tiktok'))];

/**
 * "Third Harry Potter deck in a row" — the sentence the owner asked to be told.
 *
 * Counted as a RUN from the newest post backwards rather than as a share,
 * because a share cannot see a streak: three consecutive theme decks out of
 * forty posts is 7% of the window and looks like nothing, while on the feed it
 * is the only thing anybody notices.
 *
 * The travel version counts runs on the place. A BrickDeal deck has no place;
 * what repeats here is the theme, and — more often, because the feed is small —
 * the individual sets. A roundup sharing four of five sets with last week's is
 * the case worth being told about, and it is invisible to a theme count.
 */
export function brickRepeats(deck, history = recentPublished()) {
  const notes = [];

  const topic = deck.theme || deck.recipe;
  let run = 0;
  for (const p of history) {
    if (p.topic !== topic) break;
    run++;
  }
  if (run >= 1) notes.push(`חוזר על "${deck.subject}" — ${run + 1} מצגות ברצף`);

  const ids = new Set(deck.slides.map((s) => s.productId));
  for (const p of history.slice(0, 3)) {
    const shared = (p.productIds || []).filter((id) => ids.has(id));
    if (shared.length >= Math.ceil(ids.size / 2)) {
      notes.push(`${shared.length} מתוך ${ids.size} הסטים כבר היו במצגת "${p.headline || p.topic}"`);
      break;
    }
  }

  return notes;
}

/**
 * How the photographs on this deck were made.
 *
 * Counted and reported because it is the one thing on the approval card that
 * changes what the owner has to do AFTER approving: a deck carrying generated
 * photographs has to be labelled as AI-generated in the TikTok app, which is a
 * rule of the owner's own product-shot skill and something no part of this
 * pipeline can do for them.
 */
export function photoSummary(slides) {
  const counts = {};
  for (const s of slides) counts[s.image?.provenance || 'none'] = (counts[s.image?.provenance || 'none'] || 0) + 1;
  return counts;
}

/**
 * The approval message.
 *
 * Every number a slide will state, with where it came from, on one screen. The
 * travel pipeline's rule was that a claim without a source does not ship; the
 * claims here are prices, so their source is a region, a currency and an
 * exchange rate on a date, and all four are printed. A comparison that could
 * not be made says why — those lines are the ones worth reading, because a run
 * of them means the set numbers on the feed have gone wrong rather than that
 * the sets happen to be unlisted.
 */
export function brickApprovalMessage(cand) {
  const deck = cand.deck || cand;
  const lines = [];

  lines.push(`🎞️ מצגת · ${deck.subject}`);
  lines.push('');
  lines.push(`🖼️ על השער: ${deck.hookHe}`);
  lines.push('');

  const desc = cand.tiktokCaption || cand.instagramCaption;
  if (desc) {
    lines.push('📝 התיאור:');
    for (const l of String(desc).split('\n')) lines.push(`   ${l}`.trimEnd());
    lines.push('');
  }

  lines.push(`📑 ${deck.slides.length + 1} שקופיות (שער + ${deck.slides.length} סטים):`);
  for (const [i, s] of deck.slides.entries()) {
    const c = s.deal?.comparison;
    lines.push(`   ${i + 2}. ${s.emoji} ${s.nameHe}`);
    if (c?.ok) {
      lines.push(`      ${money(c.paid)} מול ${money(c.listIls)} · חיסכון ${money(c.saving)}`);
      lines.push(`      מקור: ${c.source.region} ${c.source.amount} ${c.source.currency} @ ${c.source.rate} (${c.source.rateDate})`);
    } else {
      lines.push(`      ${money(s.deal?.price)} · ללא השוואה — ${c?.why || 'לא ידוע'}`);
    }
  }
  lines.push('');

  // The photographs, and the thing to do about them.
  const photos = photoSummary(deck.slides);
  const he = { generated: 'נוצרו בבינה מלאכותית', stock: 'תמונות קטלוג', none: 'ללא תמונה' };
  lines.push(`📷 ${Object.entries(photos).map(([k, n]) => `${n} ${he[k] || k}`).join(' · ')}`);
  if (photos.generated) {
    lines.push('   ⚠️ יש לסמן את הפוסט כתוכן שנוצר בבינה מלאכותית באפליקציה');
  }

  if (deck.dropped?.length) {
    lines.push('');
    lines.push('🚫 ירדו מהמצגת:');
    for (const d of deck.dropped.slice(0, 5)) lines.push(`   ${d.id} — ${d.why}`);
  }

  if (cand.notes?.length) {
    lines.push('');
    for (const n of cand.notes) lines.push(`🔁 ${n}`);
  }
  if (cand.overrides?.length) {
    lines.push('');
    for (const o of cand.overrides) lines.push(`⚠️ ${o}`);
  }

  return lines.join('\n');
}

/** Shown after you tap — the card is rewritten in place so a decision is visible. */
export const decidedMessage = (statusLine, cand) => `${statusLine}

${brickApprovalMessage(cand)}`;

/**
 * Render a built deck and wrap it for approval.
 *
 * Rendering happens here rather than in build.js for the same reason the card
 * pipeline renders last: it is the only step that costs a browser, and a deck
 * that lost too many slides to be worth publishing should not have paid for it.
 */
export async function toBrickCandidate(
  built,
  { minSlides = brickConfig().deck.minSlides, targets = targetsForKind('deck'), tiktokDraft = false } = {}
) {
  if (built.slides.length < minSlides) {
    const err = new Error(
      `only ${built.slides.length} slide(s) survived, needs ${minSlides} — ` +
        (built.dropped[0]?.why || 'no reason recorded')
    );
    err.deck = built;
    throw err;
  }

  const id = brickDeckId(built);
  const deck = { ...built, id };
  const rendered = await renderBrickDeck(deck, { sizes: sizesFor(targets) });

  // Drop the photographs now that they are baked into the JPEGs.
  //
  // Each one is a base64 data URI — a megabyte or two of string per slide — and
  // a staged candidate lives in data/store.json, which is rewritten in full on
  // every save. A six-slide deck awaiting approval would otherwise re-serialise
  // ~10MB of base64 every time anything else marked an item seen.
  //
  // The provenance survives, because that is what the approval message prints
  // and what the owner is deciding about.
  deck.slides = deck.slides.map((s) =>
    s.image ? { ...s, image: { provenance: s.image.provenance, note: s.image.note || null } } : s
  );

  const cand = {
    kind: 'deck',
    id,
    headline: deck.titleHe,
    sourceName: deck.subject,
    // A deck's "source" is the catalogue it was built from. There is no single
    // page behind it and inventing one would put a URL in the approval message
    // that answers nothing.
    sourceUrl: null,
    pillar: 'day',
    tags: [],
    deck: { ...deck, ...rendered },
    publishTargets: targets,
    tiktokDraft: Boolean(tiktokDraft),
    createdAt: deck.createdAt,
    overrides: overrideActive() ? overrideNotes() : [],
    notes: brickRepeats(deck),
    // So the dedupe in build.js can refuse these sets next time.
    productIds: deck.slides.map((s) => s.productId),
  };

  // One hook and one tag block for the post, drawn once and handed to both.
  // Two draws would send the same slideshow out as two different posts — which
  // is not hypothetical, it is what the first end-to-end run did.
  const dress = dressing(deck);
  const caption = captionFor(deck, dress);
  cand.channelCaption = [deck.titleHe, '', caption].join('\n');
  cand.instagramCaption = instagramCaptionFor(deck, dress);
  cand.tiktokCaption = caption;

  // A deck publishes from its slide URLs, but Telegram uploads bytes and the
  // held/retry paths look for a file — the cover stands in as "the card".
  cand.card = rendered.preview[0] || null;

  return cand;
}
