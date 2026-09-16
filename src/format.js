import { pillarHe } from './pillars.js';
import { LAYOUT_HE } from './render/templates.js';
import { provenanceHe } from './images.js';
import { targetsHe } from './publish/targets.js';

// Two different texts, for two different readers.
//
//   approvalMessage() — for you, before anything publishes. Everything you need
//                       to make the call, including the source URL, every time.
//   channelCaption()  — for the channel and for Instagram, after you approve.
//
// Deliberately kept apart: the approval card carries provenance, evidence and
// quota state that have no business in a published post, and the published post
// must never quietly gain something you didn't see.

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The caption that actually publishes.
 *
 * The source link goes out with the post too, not only in the approval message —
 * a claim is worth as much as the reader's ability to check it.
 */
export function channelCaption(cand) {
  const brand = process.env.BRAND_NAME || 'טיול+';
  const lines = [clean(cand.headline), '', String(cand.caption || '').trim()];

  if (cand.sourceUrl) lines.push('', `מקור: ${cand.sourceUrl}`);
  if (brand) lines.push('', brand);

  return lines.join('\n').trim();
}

/**
 * The Instagram caption. Deliberately short.
 *
 * Three things are NOT here, and each is a decision rather than an omission:
 *
 *   - the headline, because it is already the largest thing on the image;
 *     repeating it is the caption's most common way of wasting its first line.
 *   - the source URL, because it is unclickable on Instagram and long. The
 *     attribution still ships: the card itself prints "מקור: <domain>" in its
 *     footer, so the claim stays traceable in the artefact people actually see.
 *   - the brand name, which the site line already carries.
 *
 * The approval message is unaffected and still carries the full source URL
 * every time. That rule is about what YOU see before tapping, not about what
 * gets published.
 */
// The one line that appears under every post. No source URL, no photographer,
// no library — just this. Written out rather than assembled from SITE_URL so
// the wording is fixed and reviewable in one place.
const SIGNATURE = ['לסוכן הטיולים החכם שלנו:', 'www.tiyulplus.com'].join('\n');

export function instagramCaption(cand) {
  // The subhead is deliberately absent from the rendered card, so this is the
  // only place it appears. Putting it first means the description opens by
  // answering the headline rather than repeating it.
  const parts = [];
  const sub = String(cand.subhead || '').trim();
  const body = String(cand.caption || '').trim();

  if (sub) parts.push(sub);
  if (body) parts.push(body);

  return [parts.join('\n\n'), '', SIGNATURE].join('\n').trim().slice(0, 2200); // IG caption limit
}

/**
 * The staging card.
 *
 * No parse_mode is used for this message anywhere in the bot — a headline or a
 * source URL containing `*`, `_` or a backtick would break Telegram's Markdown
 * parser, and the failure mode there is a message that doesn't send at all.
 * BrickDeal hit exactly this and worked around it with a fallback; not asking
 * for Markdown in the first place is simpler and can't fail.
 */
export function approvalMessage(cand) {
  const lines = [];

  lines.push(`${LAYOUT_HE[cand.layout] || cand.layout} · ${pillarHe(cand.pillar)}`);
  if (cand.tags?.length) lines.push(`תגיות: ${cand.tags.join(', ')}`);
  lines.push('');

  // Shown the way it will actually appear: the card carries the headline alone,
  // and the subhead opens the description. Splitting them here is what lets you
  // see the hook and the payoff as two separate things before approving.
  lines.push(`🖼️ על הכרטיס: ${clean(cand.headline)}`);
  lines.push('');

  const desc = instagramCaption(cand);
  if (desc) {
    lines.push('📝 התיאור:');
    lines.push(desc);
    lines.push('');
  }

  // The trip this post connects to. Nothing reaches this message without one —
  // src/candidate.js refuses to stage a candidate that cannot answer it — so
  // this line is not a check for you to perform, it is the answer that got the
  // post here, shown so you can disagree with it before it publishes.
  if (cand.trip?.where) {
    lines.push(`🧭 הטיול: ${cand.trip.where} · ${cand.trip.how}`);
    if (cand.trip.want) lines.push(`   למה שירצו: ${cand.trip.want}`);
  }

  // Which of the three permitted origins this image came from — or that there
  // is no image at all, which for a text-led card is the expected answer.
  lines.push(
    cand.image
      ? `🖼️ תמונה: ${provenanceHe(cand.image.provenance)}${cand.image.credit ? ` · ${cand.image.credit}` : ''}`
      : '🖼️ תמונה: אין — כרטיס טקסט בלבד'
  );

  // A card that wanted a photograph and did not get one says so. Without this
  // line the demoted card and the deliberately text-led card look the same, and
  // an image provider that stopped working reads as a run of editorial choices.
  if (cand.imageMiss) {
    lines.push(`   ⚠️ ירד ל${LAYOUT_HE[cand.layout] || cand.layout} מ-${cand.photoDowngrade}: ${cand.imageMiss}`);
  }

  const n = cand.evidence?.length || 0;
  lines.push(`✅ ${n} ציטוט${n === 1 ? '' : 'ים'} אומת${n === 1 ? '' : 'ו'} מול דף המקור`);

  // Approving is the irreversible step, so the card says where it goes before
  // you tap, not after. Resolved when the candidate was built rather than at
  // publish time, so what you were shown is what was true when you decided.
  const targets = cand.publishTargets?.length ? cand.publishTargets : [];
  lines.push(targets.length ? `📤 יפורסם ל${targetsHe(targets)}` : '⛔ אין יעד פרסום מוגדר');

  // The rule is "the source URL is always in the approval message", so it is
  // pushed unconditionally, in full, never truncated and never folded into a
  // link label that would hide where it actually points. It sits last rather
  // than in the middle of the copy: an API URL 200 characters long was cutting
  // the draft in half and making the whole message hard to read.
  //
  // It appears here and nowhere else. Nothing published carries a URL.
  lines.push('');
  lines.push(`🔗 מקור (${cand.sourceName}):`);
  lines.push(cand.sourceUrl);

  return lines.join('\n');
}

/** Shown after you tap — the card is rewritten in place so a decision is visible. */
export function decidedMessage(statusLine, cand) {
  return `${statusLine}\n\n${approvalMessage(cand)}`;
}

/** The evidence itself, on demand — `/why` shows counts, this shows the quotes. */
export function evidenceReport(cand) {
  if (!cand.evidence?.length) return 'אין ציטוטים שמורים לפריט הזה';
  const lines = cand.evidence.map(
    (e, i) => `${i + 1}. ${e.claim}\n   « ${String(e.quote).slice(0, 300)} »`
  );
  return `📎 הציטוטים מדף המקור:\n${cand.sourceUrl}\n\n${lines.join('\n\n')}`;
}
