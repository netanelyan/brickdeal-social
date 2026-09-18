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
