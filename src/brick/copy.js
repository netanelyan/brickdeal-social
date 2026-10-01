import { brickConfig } from './config.js';

// The copy rules, enforced where a prompt cannot enforce them.
//
// Two of these come from the owner and predate this repo — they govern
// brickdeal-website's copy and its generated pages — and the reason they live
// in code here is the reason the card pipeline's fare ban and quote check live
// in code: a style rule that exists only in a prompt holds right up until the
// model meets a case that pushes against it, and the case that pushes hardest
// is the one we are deliberately imitating.
//
// The account this channel is modelled on writes the original brand's name on
// every slide and spends a hashtag on it. It is the tag this audience actually
// searches, and giving it up costs real discovery. That was weighed and the
// rule kept, so what stands between a well-meaning prompt edit and a slide
// carrying a trademark is this file.

/**
 * The trademarked word, in both alphabets.
 *
 * Three details, each of which a simpler pattern gets wrong:
 *
 * NOT PRECEDED BY ד. `דלגו` is an ordinary Hebrew verb ("they skipped") and
 * contains the three letters — it is the false match the owner's own copy rule
 * names, and it appears in the website's skip link. But the exclusion is that
 * one letter and not "any Hebrew letter before it", because Hebrew glues its
 * prefix particles straight onto the word: `בלגו`, `הלגו`, `מלגו` and `ולגו`
 * are all the trademark, and a blanket lookbehind waves every one of them
 * through while claiming to enforce the rule.
 *
 * NOT FOLLOWED BY A HEBREW LETTER. `לגור` (to live), `לגוף` (to the body) and
 * `לגובה` (to the height) are common words that open with these three letters.
 * Without this, the guard rejects ordinary captions and the rule gets switched
 * off for being useless.
 *
 * A LEADING WORD BOUNDARY ONLY, in Latin. Trailing would miss "LEGOs" and
 * "Legoland", which are the same claim; leading is still needed, or "allegory"
 * matches.
 */
export const TRADEMARK = /(?<!ד)לגו(?![֐-׿])|\bLEGO/i;

/** The vocabulary that replaces it, for error messages that suggest a fix. */
const INSTEAD = 'אבני בנייה תואמות / סטים תואמים / המותג המקורי / מחיר מחירון';

export class CopyError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'CopyError';
    this.reason = reason;
  }
}

/** Whether the rule is currently in force. One boolean, in brick-config.json. */
export const trademarkAllowed = () => brickConfig().copy.allowTrademark === true;

/**
 * The guard between any published string and the approval queue.
 *
 * Runs at build time on every slide line, both captions and the hashtag block —
 * the same placement, and for the same reason, as `assertNoUrl` in format.js. A
 * string that breaks the rule must never become something approvable by
 * tapping, because at that point the only thing between it and TikTok is
 * whether the last line happened to be read.
 *
 * Throws rather than substituting. A slide whose name genuinely needs the word
 * is a slide that should not be built from that deal, and quietly rewriting it
 * would leave the feed's own name wrong and every post silently repaired.
 */
export function assertNoTrademark(text, where = 'copy') {
  const s = String(text || '');
  if (trademarkAllowed()) return s;
  const hit = s.match(TRADEMARK);
  if (hit) {
    throw new CopyError(
      `${where} contains "${hit[0]}" — the trademark appears nowhere outside the legal disclaimer; use ${INSTEAD}`,
      'trademark'
    );
  }
  return s;
}

/**
 * Em dashes, which Hebrew copy here does not use.
 *
 * A plain hyphen with spaces around it is the house style. Small, and it is the
 * kind of thing that reads as a different hand having written the post.
 */
export function assertNoEmDash(text, where = 'copy') {
  const s = String(text || '');
  if (/[—–]/.test(s)) {
    throw new CopyError(`${where} contains an em dash — Hebrew copy here uses a plain hyphen`, 'em-dash');
  }
  return s;
}

/** Both guards, which is how every caller wants them. */
export const assertCopy = (text, where = 'copy') => assertNoEmDash(assertNoTrademark(text, where), where);

/**
 * Anything that reads as a link: a scheme, a www host, or a .com / .co.il.
 *
 * Deliberately broader than a URL parser. What gets a post demoted is not a
 * well-formed URL, it is a domain a human can retype — "brickdeal.co.il" with no
 * scheme and no www is the same signal to the platform and the same signal to
 * the reader, and a parser would pass it.
 */
export const URL_LIKE = /(?:https?:\/\/)|(?:\bwww\.)|(?:\.(?:com|co\.il)\b)/i;

/**
 * The guard between a built caption and the approval queue.
 *
 * Here rather than at publish time on purpose. The rule is about what we choose
 * to publish, so it has to fire before anything is shown for approval — a
 * caption with a URL in it must never become something you can tap approve on,
 * because at that point the only thing standing between it and TikTok is
 * whether you happened to read the last line.
 *
 * Throws rather than stripping. A caption assembled from a pool that has a
 * domain in it is a configuration error, and silently editing it would leave
 * post-config.json broken and every future post quietly repaired.
 */
export function assertNoUrl(caption, where = 'caption') {
  const text = String(caption || '');
  const hit = text.match(URL_LIKE);
  if (hit) {
    throw new Error(
      `${where} contains a URL ("${hit[0]}") — nothing published may carry one; the link lives in the bio`
    );
  }
  return text;
}

/**
 * A whole shekel, grouped, with the sign.
 *
 * No agorot anywhere on a slide. The card pipeline already refuses decimals on
 * a rendered surface and the reason carries over unchanged: "129.40₪" set in
 * 40px white type reads as a spreadsheet, and the second digit after the point
 * has never once changed whether somebody taps.
 */
/**
 * A geresh the feed lost, put back.
 *
 * `ג'יפ` arrives from brickdeal-automation as `ג יפ` on some rows — the
 * apostrophe dropped somewhere upstream, leaving a lone letter, a space, and
 * the rest of the word. On a slide that reads as a typo rather than as a name,
 * and a typo in 54px type is the whole frame.
 *
 * THE REAL FIX IS UPSTREAM and this does not replace it. It is here because
 * this repository does not own the feed, cannot correct it, and must not put a
 * broken word on a published post while somebody else's bug is outstanding.
 *
 * Deliberately narrow. Only ג, ז and צ, which are the three letters Hebrew
 * gives a geresh to when transcribing a foreign sound — j, zh, ch — and only
 * when one stands completely alone before another Hebrew word. A single
 * free-standing letter is not a Hebrew word: the letters that genuinely appear
 * alone are prefixes (ב, ל, ה, ו, מ, ש, כ) and they attach to what follows
 * rather than standing off it, so they cannot match this.
 */
export const repairGeresh = (text) =>
  String(text ?? '').replace(/(^|[\s|])([גזצ]) (?=[א-ת])/g, "$1$2'");

export const shekels = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')}₪`;

/**
 * A count of agorot, whole, with the word for it.
 *
 * This is NOT the rule above being bent. That rule bans agorot as the tail of a
 * price — "129.40₪", a second digit after a point that has never changed
 * whether anybody taps. Here the agora is the unit itself and the number is a
 * whole one: "4 אגורות" is the same shape as "822 חלקים", not the same shape as
 * a price with change on the end.
 *
 * Singular when it is one. "1 אגורות" is a grammatical error, and a
 * grammatical error set in 40px white type across a photograph is the whole
 * frame — the same argument repairGeresh is here for.
 */
export const agorotText = (n) => {
  const whole = Math.round(Number(n) || 0);
  return `${whole} ${whole === 1 ? 'אגורה' : 'אגורות'}`;
};

/**
 * One price line, as the renderer wants it.
 *
 * `value` is returned separately from `label` rather than pre-joined because
 * the two need different bidi treatment and joining them here is what makes
 * that impossible later. See `priceLineHtml`.
 */
export const priceLine = (label, amount) => ({ label: String(label), value: shekels(amount) });

/**
 * A line whose value is not money — a count, a unit.
 *
 * Same two halves and the same bidi treatment as a price line, because the
 * problem is the same one: "10,001" is a left-to-right run of digits and a
 * comma dropped into a right-to-left paragraph. It is a separate constructor
 * only so that nothing has to pass a number through `shekels` to get a line
 * out of it.
 */
export const factLine = (label, value) => ({ label: String(label), value: String(value) });

/**
 * A price line, bidi-safe.
 *
 * The line is Hebrew and therefore right-to-left: the label sits at the right
 * edge and the number to its left. That much the browser gets right on its own.
 * What it does not reliably get right is the number itself — "1,234₪" is a
 * left-to-right run of digits, a comma and a currency sign dropped into a
 * right-to-left paragraph, and the shekel sign is a bidi "European terminator"
 * whose direction is inherited from whatever it happens to touch. Put a colon
 * on one side and a line break on the other and it can resolve differently in
 * two slides of the same deck.
 *
 * `<bdi>` isolates it: the number is resolved on its own and then placed as a
 * single neutral unit.
 *
 * Measured, and worth recording honestly: with the current labels it changes
 * nothing. Chromium renders `מחיר מחירון: 1,559₪` glyph-for-glyph identically
 * with and without the isolate — label at the right edge, the number to its
 * left, the shekel sign hard against the digits. The isolate is not fixing an
 * observed bug; it is making the result independent of the label, so that a
 * reworded label in brick-config.json — one ending in a Latin word, a digit or
 * a bracket — cannot silently re-resolve the number on some slides and not
 * others. Cheap insurance on the one thing here that cannot be checked by
 * reading the HTML.
 */
export const priceLineHtml = ({ label, value }, escape = (s) => s) =>
  // A line with no value is a sentence rather than a field — the piece count or
  // the rating on a single-set post — and it carries no colon and no isolate.
  // Without this case every one of those slides would print a dangling ":".
  value ? `${escape(label)}: <bdi>${escape(value)}</bdi>` : escape(label);

/**
 * The lines under a set's name on a slide, in the reference's fixed order.
 *
 * Three when the comparison could be made, one when it could not. The order and
 * the labels never vary within a deck — a slide whose fields differ from its
 * neighbour's reads as improvised, which is the note that produced fields.js on
 * the travel side and applies here unchanged.
 *
 * `comparison` is whatever `rrp.compare()` returned. When it refused it carries
 * only a reason, so `price` is passed separately and is the one number always
 * available — we always know what we charge, and on some sets that is all we
 * know. A slide in that state says nothing about what the set is worth, which
 * is correct rather than merely tolerable.
 */
export function slideLines(comparison, { price, labels = brickConfig().labels } = {}) {
  if (!comparison?.ok) {
    return [priceLine(labels.ours, price)];
  }
  return [
    priceLine(labels.ours, comparison.paid),
    priceLine(labels.list, comparison.listIls),
    priceLine(labels.saving, comparison.saving),
  ];
}

/**
 * The lines on a per-piece slide: what it costs, how many pieces, what that is
 * each.
 *
 * Three lines, always, whether or not Brickset knew the set — which is the
 * whole reason this is a separate function and not a fourth line bolted onto
 * the one above.
 *
 * THE LIST PRICE AND THE SAVING ARE DELIBERATELY NOT HERE, and on a deck that
 * could source them. Two reasons, and the second is the one that decided it:
 *
 *   - One deck, one argument. This post's claim is what a piece costs. A slide
 *     that also shows what the original brand charges is making the savings
 *     deck's case in smaller type underneath, and four lines of Hebrew over a
 *     photograph is where the block stops being read at a glance.
 *   - The arithmetic is on the slide. Price, pieces, and price divided by
 *     pieces: a viewer can check the third line against the first two without
 *     leaving the frame. That is a stronger thing to put in front of somebody
 *     than a number they have to trust, and it is only true if the block
 *     contains nothing else.
 *
 * `agorot` is passed in rather than divided here. The recipe already computed
 * it to pick the ceiling the cover claims, and a second division in a second
 * file is how a slide comes to disagree with the post it is in.
 */
export function perPieceLines(deal, agorot, { labels = brickConfig().labels } = {}) {
  return [
    priceLine(labels.ours, deal.price),
    factLine(labels.pieces, Number(deal.pieces).toLocaleString('en-US')),
    factLine(labels.perPiece, agorotText(agorot)),
  ];
}
