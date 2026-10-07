import { brickConfig } from './config.js';
import { THEME_HE } from './themes.js';
import { emojiFor } from './emoji.js';
import { agorotPerPiece } from './recipes.js';
import { agorotText } from './copy.js';
import { configured as imagesConfigured } from '../images/homeShot.js';

// The first card: what this post would be, before anything is paid for.
//
// The travel pipeline's proposal is a plan the build may not be able to keep —
// it names places it then has to go and source, and the approval card after the
// build is the real list. This one is not a plan. Every deal on it is already
// in the feed and already priced, so the sets named here are the sets that will
// be on the slides.
//
// What is still unknown at this point is the cover line and the photographs,
// and those are exactly what the second tap pays for.

const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')}₪`;

/**
 * The proposal, as one message.
 *
 * The price claims are on it in full, and that is the point of showing it at
 * all: a deck where four of five sets say "no comparison" is a deck worth
 * rejecting before it costs five generated images, and that fact is invisible
 * on a finished slideshow until you read every slide.
 */
export function proposalMessage(p) {
  const lines = [];
  const kindHe = {
    theme: 'לפי נושא',
    price: 'לפי מחיר',
    savings: 'הנחות',
    perPiece: 'מחיר לחלק',
    set: 'סט בודד',
    countdown: 'דירוג',
  };

  lines.push(`💡 הצעה למצגת · ${kindHe[p.recipe] || p.recipe}`);
  lines.push(`🏷️ ${p.subject}${p.theme && THEME_HE[p.theme] ? '' : ''}`);
  // Why this is not what was asked for. Above the sets, because it changes how
  // the rest of the card reads: a theme deck answering "/deck דירוג" looks
  // like the bot misheard unless it says it could not fill the countdown.
  if (p.fallback) lines.push(`↩️ ${p.fallback}`);
  lines.push('');

  // WHAT THE SLIDES WILL SAY, which on a per-piece deck is not the comparison.
  // That deck prints the price, the piece count and the figure between them and
  // nothing else — see perPieceLines — so a card counting how many of its sets
  // got a list price would be describing a different post.
  const perPiece = p.recipe === 'perPiece';
  const countdown = p.recipe === 'countdown';
  const withComparison = p.deals.filter((d) => d.comparison?.ok);
  lines.push(
    perPiece
      ? `📦 ${p.deals.length} סטים · מחיר לחלק על כל שקופית`
      : countdown
        ? `📦 ${p.deals.length} סטים · מדורגים לפי החיסכון, מקום ראשון אחרון`
        : `📦 ${p.deals.length} סטים · ${withComparison.length} עם השוואת מחיר`
  );
  lines.push('');

  for (const [i, d] of p.deals.entries()) {
    const c = d.comparison;
    // The place each set would hold if every photograph comes back. The build
    // counts the ranks again off the slides that survive, so a set dropped
    // there moves the ones above it down a place rather than leaving a gap.
    const place = countdown ? `#${p.deals.length - i} ` : '';
    lines.push(`   ${place}${emojiFor(d)} ${d.product}`);
    if (perPiece) {
      lines.push(
        `      ${money(d.price)} · ${Number(d.pieces || 0).toLocaleString('en-US')} חלקים · ` +
          `${agorotText(agorotPerPiece(d))} לחלק`
      );
      continue;
    }
    lines.push(
      c?.ok
        ? `      ${money(c.paid)} מול ${money(c.listIls)} · חיסכון ${money(c.saving)}`
        : `      ${money(d.price)} · ללא השוואה — ${c?.why || 'לא ידוע'}`
    );
  }

  const rates = Object.entries(p.rates || {});
  if (rates.length) {
    lines.push('');
    lines.push(`💱 ${rates.map(([c, r]) => `${c}/ILS ${r.rate} (${r.date})`).join(' · ')}`);
  }

  // Said before the build rather than after it, because it changes whether the
  // build is worth starting: with no image key every slide falls back to a
  // catalogue photo, which is the one thing the reference account never does
  // and the reason this format works at all.
  lines.push('');
  lines.push(
    imagesConfigured()
      ? `📷 ${p.deals.length} תמונות ייווצרו בבינה מלאכותית (יש לסמן את הפוסט בהתאם)`
      : '⚠️ אין מפתח ליצירת תמונות — השקופיות יקבלו תמונות קטלוג'
  );

  if (p.feedDropped?.length) {
    lines.push('');
    lines.push(`🚫 ${p.feedDropped.length} דילים לא היו ראויים לפרסום`);
  }

  return lines.join('\n');
}

/**
 * How thin this proposal is, in a sentence, or null.
 *
 * A separate question from "can it be built". A deck of five sets with no
 * comparison on any of them builds perfectly and is a bad post, and the only
 * moment that is cheap to act on is now.
 */
export function proposalWarning(p) {
  // A per-piece deck is not thin for having no comparisons — it was never going
  // to show one. Warning about it here would train the owner to ignore the line
  // on the one recipe that can be built entirely out of sets Brickset has never
  // heard of, which is half of what that recipe is for.
  if (p.recipe === 'perPiece') {
    return p.deals.length < brickConfig().deck.slides ? `${p.deals.length} סטים בלבד — פחות מהרגיל` : null;
  }
  // Nor is a countdown, which cannot hold a set without one. A short one is
  // worth a word, since "top five" is a smaller post than the usual eight.
  if (p.recipe === 'countdown') {
    return p.deals.length < brickConfig().deck.slides ? `דירוג של ${p.deals.length} סטים בלבד — פחות מהרגיל` : null;
  }

  const withComparison = p.deals.filter((d) => d.comparison?.ok).length;
  if (!withComparison) return 'אף סט לא קיבל מחיר מחירון — המצגת תציג מחירים בלבד, בלי חיסכון';
  if (withComparison < Math.ceil(p.deals.length / 2)) {
    return `רק ${withComparison} מתוך ${p.deals.length} סטים יציגו חיסכון`;
  }
  if (p.deals.length < brickConfig().deck.slides) {
    return `${p.deals.length} סטים בלבד — פחות מהרגיל`;
  }
  return null;
}
