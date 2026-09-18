import { instagramConfigured } from './instagram.js';
import { tiktokConfigured } from './tiktok.js';

// Where an approved post actually goes.
//
// Every destination is optional and independent, which is the point: Telegram
// can be approval-only (no channel at all, posts go to Instagram), Instagram can
// be dark while the channel carries everything, TikTok can be connected long
// before it is audited. What is NOT optional is that there be at least one —
// bot.js refuses to start otherwise, because an approval queue with nowhere to
// publish is a queue that quietly eats everything you approve.

export const TARGET_HE = { telegram: 'טלגרם', instagram: 'אינסטגרם', tiktok: 'טיקטוק' };

/**
 * Where each kind of post is allowed to go.
 *
 * Not a config value, an editorial rule: a news card is written for a feed and
 * a deck is written for a scroll, and posting either one in the other's place
 * is what makes a channel look automated. A card never goes to TikTok. A deck
 * goes to both, because the same slides read correctly in a carousel.
 */
const ALLOWED_BY_KIND = {
  card: ['telegram', 'instagram'],
  deck: ['telegram', 'instagram', 'tiktok'],
};

/**
 * Where this kind of post is permitted, regardless of what is configured.
 *
 * Separate from targetsForKind() so the editorial rule can be asserted on its
 * own: whether a card may reach TikTok is a decision, and it should not become
 * untestable just because no TikTok token happens to be present.
 */
export const allowedForKind = (kind = 'card') => [...(ALLOWED_BY_KIND[kind] || ALLOWED_BY_KIND.card)];

/** Configured destinations for one kind of post, in publish order. */
export function targetsForKind(kind = 'card', env = process.env) {
  const allowed = allowedForKind(kind);
  return publishTargets(env).filter((t) => allowed.includes(t));
}

/** Currently-configured destinations, in publish order. */
export function publishTargets(env = process.env) {
  const targets = [];
  // CHANNEL_ID is what switches Telegram publishing on. Leaving it unset is a
  // supported setup, not a misconfiguration: the bot still DMs you approval
  // cards, it just has no channel to post them to afterwards.
  if (env.CHANNEL_ID) targets.push('telegram');
  if (instagramConfigured()) targets.push('instagram');
  // Last, and for one reason: TikTok is the only destination that needs a
  // decision from you at approval time (the privacy level), so it is the one
  // most likely to be held back while the other two go out.
  if (tiktokConfigured()) targets.push('tiktok');
  return targets;
}

export const targetsHe = (targets) => targets.map((t) => TARGET_HE[t] || t).join(' ו');
