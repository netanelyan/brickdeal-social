import { createHash } from 'node:crypto';
import { verifySource, verifyEvidence, verifyDraftText, RejectedError } from './verify.js';
import { draft as draftPost } from './draft.js';
import { quotaBlock } from './pillars.js';
import { findImage, imageQueries, imagesEnabled } from './images.js';
import { renderCard } from './render/index.js';
import { isPhotoLayout, PHOTO_FALLBACK } from './render/templates.js';
import { channelCaption, instagramCaption, tiktokCaption } from './format.js';
import { targetsForKind } from './publish/targets.js';
import { recordWasted } from './usage.js';

// One source item all the way to a stageable candidate.
//
// The order of the gates is the point. Verification of the source happens
// BEFORE the drafting call, so an unreachable page or a non-primary domain
// costs nothing; evidence checking and the fare guard happen BEFORE rendering,
// so a rejected claim never reaches Chromium; the quota check happens before
// the image lookup and the render, which are the two expensive steps.
//
// The same reordering lesson BrickDeal learned about dedupe applies here in a
// different form: claim the id up front, before the slow calls, so two sources
// carrying the same story seconds apart can't both get drafted and staged.

export { RejectedError };

/** Stable per source URL, so the same story from the same page is one candidate. */
export function candidateId(item) {
  if (item.dedupeId) return item.dedupeId;
  let key;
  try {
    const u = new URL(item.url);
    u.hash = '';
    // Tracking parameters change per referral and would otherwise defeat dedupe.
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
      u.searchParams.delete(p);
    }
    key = u.toString();
  } catch {
    key = String(item.url);
  }
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Why this draft is not a trip — or null when it is one.
 *
 * Split out and exported so the rule is testable on its own, without a drafting
 * call standing between the test and the thing being tested.
 *
 * The three checks are the three ways the answer comes back no: nowhere to
 * stand, no way to get there, and — the one that matters most, because it is
 * the one a striking photograph talks you out of — somewhere you are not
 * currently allowed to be.
 */
export function tripGap(trip) {
  const where = String(trip?.where || '').trim();
  const how = String(trip?.how || '').trim();
  if (!where) return 'no place a reader could go';
  if (!how) return `no way to get to or use "${where}"`;
  if (!trip?.open) return `"${where}" is not open to a visitor now`;
  return null;
}

/**
 * Build a candidate, or throw RejectedError with a reason you can read.
 *
 * Nothing here is silent: every throw carries a reason code that src/notify.js
 * turns into Hebrew for the skip digest. A filter you cannot see is a filter
 * you cannot disagree with.
 */
export async function toCandidate(item, opts = {}) {
  // Everything from the drafting call onward has already been paid for. If it
  // dies down there the money is spent either way, so it is counted as waste —
  // that number is what tells you whether the pre-draft gates are doing enough.
  try {
    return await build(item, opts);
  } catch (e) {
    if (e?.paidFor) recordWasted();
    throw e;
  }
}

async function build(item, { render = true } = {}) {
  const id = candidateId(item);

  // 1. Primary source, reachable, and still on the allowlist after redirects.
  const { sourceText, finalUrl, authority } = await verifySource(item);

  // 2. Hebrew copy + layout choice + the quotes that back every claim.
  let d;
  try {
    d = await draftPost(item, sourceText, { imagesAvailable: imagesEnabled() });
  } catch (e) {
    throw new RejectedError('draft_failed', e.message);
  }
  // From here down the call is already billed, so every exit is flagged as
  // paid-for on the way out. `not_usable` counts: the model read the page and
  // declined it, which is a correct answer we still paid full price for.
  try {
    return await afterDraft();
  } catch (e) {
    e.paidFor = true;
    throw e;
  }

  async function afterDraft() {
  if (!d.usable) throw new RejectedError('not_usable', d.rejectReason || 'the model declined this source');

  // 2b. THE HARD RULE: a post that cannot be connected to a trip someone could
  //     actually take never reaches the approval queue.
  //
  //     The drafting prompt asks the same two questions, and a prompt is where
  //     this belongs first — but a prompt is a request. This is the guarantee,
  //     and it is here rather than in verify.js because it is a rule about what
  //     we choose to publish, not about whether the source says what we claim.
  //
  //     Deliberately not retryable in pipeline.js: unlike a style slip, a second
  //     draft of the same page reaches the same verdict, and paying for that
  //     twice is how a filter turns into a tax.
  const gap = tripGap(d.trip);
  if (gap) throw new RejectedError('no_trip', gap);

  // 3. Every quote must literally appear in the page we fetched, and no fares.
  verifyEvidence(d, sourceText);
  verifyDraftText(d);

  // 4. Topic quotas — checked here rather than at publish time so a blocked
  //    candidate never occupies your attention in the first place.
  const blocked = quotaBlock({ ...d, sourceId: item.sourceId });
  if (blocked) throw new RejectedError('quota', blocked);

  // 5. Image, if any provider is configured. v1 runs with none, so this is null
  //    and the layout choice already assumed as much.
  //
  //    The downgrade below used to happen in silence, and silence is the wrong
  //    behaviour for it: a photo-led draft that arrives as a wall of type looks
  //    identical to a draft that chose a text layout on purpose, so a broken
  //    image provider reads as an editorial decision for as long as nobody
  //    thinks to check. What was asked for and what came back is recorded and
  //    printed in the approval message.
  let image = null;
  let imageMiss = null;
  if (isPhotoLayout(d.layout)) {
    if (!imagesEnabled()) {
      imageMiss = 'אין ספק תמונות מוגדר';
    } else {
      try {
        image = await findImage(d);
        if (!image?.src) {
          const asked = imageQueries(d);
          imageMiss = asked.length ? `לא נמצאה תמונה ל-"${asked[0]}"` : 'הטיוטה לא ביקשה תמונה';
        }
      } catch (e) {
        imageMiss = e.message;
      }
    }
  }
  const photoDowngrade = isPhotoLayout(d.layout) && !image?.src ? d.layout : null;
  if (photoDowngrade) d.layout = PHOTO_FALLBACK;

  const cand = {
    id,
    ...d,
    sourceUrl: finalUrl,
    sourceName: item.sourceName,
    sourceId: item.sourceId,
    authority: authority.suffix,
    publishedAt: item.publishedAt || null,
    data: item.data || null,
    image,
    // Only set when a photograph was wanted and did not arrive — a text-led
    // draft has nothing to explain.
    imageMiss: photoDowngrade ? imageMiss : null,
    photoDowngrade,
    createdAt: new Date().toISOString(),
    // A news card is written for a feed, not a scroll: it never goes to TikTok.
    kind: 'card',
    publishTargets: targetsForKind('card'),
  };

  // 6. Render last — it is the only step that costs a browser.
  if (render) {
    let card;
    try {
      card = await renderCard(cand, { id, data: cand.data, image });
    } catch (e) {
      throw new RejectedError('render_failed', e.message);
    }
    cand.card = card;
  }

  cand.channelCaption = channelCaption(cand);
  cand.instagramCaption = instagramCaption(cand);
  cand.tiktokCaption = tiktokCaption(cand);

  return cand;
  }
}
