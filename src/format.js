import { pillarHe } from './pillars.js';
import { LAYOUT_HE } from './render/templates.js';
import { provenanceHe } from './images.js';
import { targetsHe } from './publish/targets.js';
import { privacyHe } from './publish/tiktok.js';
import { KINDS } from './sources/places.js';

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

// The same line for a slideshow, pointing at the bio rather than at a URL.
//
// Decks publish to Instagram and TikTok, and neither makes a link in a caption
// tappable. "www.tiyulplus.com" under a carousel is a string somebody has to
// retype; the bio link is the only clickable route either platform offers, so
// that is what a deck asks for. The domain stays on the second line because it
// is the brand and it is what someone searching later will remember.
const DECK_SIGNATURE = ['למתכנן טיולים חכם בביו שלנו', 'www.tiyulplus.com'].join('\n');

// Instagram's caption limit, and the shortest of the three a deck publishes to.
const CAPTION_LIMIT = 2200;

function publishedDescription(cand, limit) {
  // The subhead is deliberately absent from the rendered card, so this is the
  // only place it appears. Putting it first means the description opens by
  // answering the headline rather than repeating it.
  const parts = [];
  const sub = String(cand.subhead || '').trim();
  const body = String(cand.caption || '').trim();

  if (sub) parts.push(sub);
  if (body) parts.push(body);

  return [parts.join('\n\n'), '', SIGNATURE].join('\n').trim().slice(0, limit);
}

export const instagramCaption = (cand) => publishedDescription(cand, 2200); // IG caption limit

/**
 * The TikTok description. Deliberately the same text as Instagram's.
 *
 * Same card, same claim, same signature — a second wording would be a second
 * thing to review, and the approval message shows you one description. The only
 * difference is the ceiling, and the headline, which travels separately as the
 * post title rather than being repeated here.
 */
export const tiktokCaption = (cand) => publishedDescription(cand, 4000); // TikTok description limit

/**
 * The caption under a published deck.
 *
 * The cover slide already carries the title, so the caption opens with the
 * angle — the reason to watch — and then lists the places in order. The list is
 * the part that survives being read without the images, which is what a caption
 * is for, and it is also what someone searching for one of those places will
 * match on.
 */
export function deckCaption(deck) {
  // The title and the shoutout. Nothing else.
  //
  // This listed the angle and then every place, numbered — which is the deck
  // itself, retyped underneath the deck. A viewer who wants the list swipes;
  // the description's job on a slideshow is to say what it is and where to go
  // next, and a wall of names pushes the only line that asks for anything below
  // the fold.
  //
  // The signature is RESERVED out of the limit rather than appended and hoped
  // for: the old version built the whole string and sliced it to 2200, so on a
  // long deck the call to action was the part that fell off the end.
  const tail = `\n\n${DECK_SIGNATURE}`;
  const body = String(deck.titleHe || '').trim().slice(0, CAPTION_LIMIT - tail.length);
  return `${body}${tail}`.trim();
}

/**
 * The approval message for a deck.
 *
 * Longer than a card's, because there is more that can be wrong and all of it
 * is invisible in the images: which slides were dropped and why, how thin the
 * region was, and which domain each fact was quoted from. The album arrives
 * above this message, so the pictures and this text are read together.
 */
export function deckApprovalMessage(cand) {
  const deck = cand.deck || cand;
  const lines = [];

  // The style is on the header because it is the single biggest visual
  // difference between two decks and it is chosen automatically. Reading
  // "minimal" and seeing cream-and-bronze slides means the style decision is
  // wrong, and that is otherwise invisible until the pictures load.
  const styleHe = deck.style === 'info' ? 'מידע' : 'מינימלי';
  // The category in Hebrew, not as its internal id. "temple" and "trail" are
  // keys in a lookup table, and printing them put an English word in the first
  // line of an otherwise Hebrew message for no reason anyone reading it could
  // see. The place name stays as it is — it is a proper noun and the map knows
  // it by that name.
  lines.push(`🎞️ מצגת · ${KINDS[deck.category]?.he || deck.category} · ${deck.where} · סגנון ${styleHe}`);
  lines.push('');
  lines.push(`🖼️ על השער: ${clean(deck.titleHe)}`);
  if (deck.idea?.emphasisHe) lines.push(`   בצבע: ${clean(deck.idea.emphasisHe)}`);
  lines.push('');

  lines.push(`📑 ${deck.slides.length + 1} שקופיות (שער + ${deck.slides.length} מקומות):`);
  for (const [i, s] of deck.slides.entries()) {
    // A slide is a name and, where the category has them, a few fields. The
    // fields are shown because they are the only part that can be wrong.
    const fields = (s.fields || []).map((f) => `${f.labelHe}: ${f.value}`).join(' · ');
    const note = (s.bullets || [])[0]?.text;
    const extra = fields || note || '';
    lines.push(`   ${i + 2}. ${s.nameHe}${s.flag ? ` ${s.flag}` : ''}${extra ? ` — ${extra}` : ''}`);
  }
  lines.push('');

  // The shortfall, stated. A deck that asked for five and built three looks
  // exactly like a deck that meant to be three, and the difference is whether
  // the region is thin or the search is broken.
  if (deck.short) {
    lines.push(`⚠️ ביקשנו ${deck.counts.asked} מקומות, נבנו ${deck.counts.built}`);
  }
  lines.push(
    `🔎 ${deck.counts.found} מקומות באזור · ${deck.counts.withAuthority} עם גוף מוסמך · ${deck.counts.built} נכנסו`
  );

  // Why each candidate fell out. Capped, because a thin region can drop a dozen
  // and the useful signal is the first few reasons, not the list.
  for (const d of (deck.dropped || []).slice(0, 4)) {
    lines.push(`   ✗ ${d.place}: ${String(d.why).slice(0, 80)}`);
  }
  if ((deck.dropped || []).length > 4) lines.push(`   ✗ ועוד ${deck.dropped.length - 4}`);

  // Kept, but with less on them than the category asked for. Listed separately
  // from the dropped, and with a different mark: a place whose page had no
  // numbers is on a slide carrying its name, which is a working slide — showing
  // it under "✗" made a perfectly good deck read as half-broken.
  for (const d of (deck.degraded || []).slice(0, 3)) {
    lines.push(`   ~ ${d.place}: בלי נתונים, רק השם`);
  }
  if ((deck.degraded || []).length > 3) lines.push(`   ~ ועוד ${deck.degraded.length - 3}`);

  const missing = deck.slides.filter((s) => s.imageMiss).length;
  if (missing) lines.push(`⚠️ ${missing} שקופיות בלי צילום`);

  const targets = cand.publishTargets?.length ? cand.publishTargets : [];
  lines.push('');
  lines.push(targets.length ? `📤 יפורסם ל${targetsHe(targets)}` : '⛔ אין יעד פרסום מוגדר');

  if (targets.includes('tiktok')) {
    if (cand.tiktok?.error) {
      lines.push(`⚠️ טיקטוק: לא ניתן לקרוא את הגדרות החשבון — ${cand.tiktok.error}`);
    } else if (cand.tiktok?.privacy) {
      const who = cand.tiktok.username ? ` · @${cand.tiktok.username}` : '';
      lines.push(`🔒 פרטיות בטיקטוק: ${privacyHe(cand.tiktok.privacy)}${who}`);
    }
  }

  // Same as the card: a deck built by stepping over a guard says so before you
  // approve it. This is the one that matters most — "the third Dolomites deck
  // in a row" is invisible in a slideshow and obvious on the feed.
  if (cand.overrides?.length) {
    lines.push('');
    lines.push('🔓 נעקפו בקרות:');
    for (const o of cand.overrides) lines.push(`   • ${o}`);
  }

  // Its own heading, and unconditional. These used to be folded into the block
  // above, which meant two wrong things at once: they only appeared when an
  // override was active, and when they did they were filed as controls that had
  // been bypassed. A repeat bypasses nothing. It is the sentence that changes
  // whether you tap approve on a slideshow that is fine on its own and is the
  // third about the same city.
  if (cand.notes?.length) {
    lines.push('');
    lines.push('👀 שימו לב:');
    for (const n of cand.notes) lines.push(`   • ${n}`);
  }

  lines.push('');
  lines.push('🔗 מקורות:');
  for (const s of deck.slides) {
    // A slide with no page prints where its facts DID come from, rather than
    // the word "null". Mountains and waterfalls mostly have no official site —
    // that is why those kinds are allowed to build from Wikidata at all — so
    // this is the common case for them, not an error. Printing the raw value
    // made a normal deck look broken and told you nothing about provenance.
    // A free-form slide has no source because it carries no claim — saying
    // "Wikidata" there would name a source it never consulted.
    const from = s.sourceUrl || (deck.freeform ? 'ללא מקור (מצגת חופשית)' : `ויקינתונים${s.qid ? ` (${s.qid})` : ''}`);
    lines.push(`   ${s.nameHe}: ${from}`);
  }

  return lines.join('\n');
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
  // A deck has a different failure surface and therefore a different message.
  if (cand.kind === 'deck') return deckApprovalMessage(cand);

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
  //
  // The search term is printed too. It is the one input to the photograph that
  // the drafting step chose, and when a card arrives with the wrong picture the
  // first question is whether the search was wrong or the library was.
  lines.push(
    cand.image
      ? `🖼️ תמונה: ${provenanceHe(cand.image.provenance)}${cand.image.credit ? ` · ${cand.image.credit}` : ''}${cand.image.query ? ` · חיפוש: "${cand.image.query}"` : ''}`
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

  // TikTok's Direct Post rules require the creator to see the privacy level
  // before the post goes out, so it is shown here rather than assumed from
  // .env — and the button under this message is what changes it. A card whose
  // creator-info call failed says so instead of showing a level that was never
  // confirmed against the account.
  if (targets.includes('tiktok')) {
    if (cand.tiktok?.error) {
      lines.push(`⚠️ טיקטוק: לא ניתן לקרוא את הגדרות החשבון — ${cand.tiktok.error}`);
    } else if (cand.tiktok?.privacy) {
      const who = cand.tiktok.username ? ` · @${cand.tiktok.username}` : '';
      lines.push(`🔒 פרטיות בטיקטוק: ${privacyHe(cand.tiktok.privacy)}${who}`);
    }
  }

  // What it took to build this one. Above the source URL rather than below it,
  // because this is the part that changes whether you tap approve — the whole
  // point of letting the owner step over a quota is that stepping over it is a
  // decision, and a decision needs the number in front of it.
  if (cand.overrides?.length) {
    lines.push('');
    lines.push('🔓 נעקפו בקרות:');
    for (const o of cand.overrides) lines.push(`   • ${o}`);
  }

  // What repeats what just went out — see the same block in the deck message.
  // Always computed, never a block, and deliberately not filed under "bypassed".
  if (cand.notes?.length) {
    lines.push('');
    lines.push('👀 שימו לב:');
    for (const n of cand.notes) lines.push(`   • ${n}`);
  }

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
  // A deck's evidence is per slide, and which slide a quote belongs to is the
  // thing you need in order to check it — a flat list of quotes from six
  // different websites is unreadable.
  if (cand.kind === 'deck') {
    // A name-only deck has nothing to quote, and saying so is the honest
    // answer: the only assertion on those slides is that a place is called
    // what our own page calls it.
    const withFields = (cand.deck?.slides || []).filter((s) => s.fields?.length);
    if (!withFields.length) {
      return 'במצגת הזו אין טענות לצטט - כל שקופית נושאת שם מקום בלבד, מתוך הדף שלנו.';
    }
    const blocks = withFields.map((s) => {
      const quotes = s.fields.map((f) => `   ${f.labelHe}: ${f.value}\n   « ${String(f.quote || '').slice(0, 240)} »`);
      return [`${s.n}. ${s.nameHe}`, `   ${s.sourceUrl}`, ...quotes].join('\n');
    });
    return `📎 הציטוטים, שקופית אחר שקופית:\n\n${blocks.join('\n\n')}`;
  }

  if (!cand.evidence?.length) return 'אין ציטוטים שמורים לפריט הזה';
  const lines = cand.evidence.map(
    (e, i) => `${i + 1}. ${e.claim}\n   « ${String(e.quote).slice(0, 300)} »`
  );
  return `📎 הציטוטים מדף המקור:\n${cand.sourceUrl}\n\n${lines.join('\n\n')}`;
}
