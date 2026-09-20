import { AsyncLocalStorage } from 'node:async_hooks';

// The owner's override, and the record of what it stepped over.
//
// Every guard in this project exists to protect the FEED from the pipeline: a
// quota so one pillar cannot become the whole channel, a dedupe window so the
// same story is not drafted twice, a daily target so the approval queue does
// not turn into a rubber stamp. None of them exists to protect the feed from
// its owner, who can already publish anything by hand.
//
// So when the owner asks for a post, the guards give way. What they do NOT do
// is give way quietly. The whole value of a quota you are allowed to break is
// that breaking it is a decision — "two Dolomites decks back to back" should be
// something chosen, not something noticed a week later in /mix. Every bypass is
// recorded here with the measurement that would have blocked it, and the caller
// is expected to say so in Telegram before the post goes out.
//
// AsyncLocalStorage rather than a parameter threaded through fifteen
// signatures, because the guards are scattered across candidate.js, pipeline.js
// and bot.js, and a flag passed by hand is a flag that gets dropped in the one
// path nobody tested. The store is scoped to the triggering command, so a timer
// firing mid-run cannot inherit it.
//
// What is deliberately NOT bypassable here:
//   - TikTok's 5-posts-per-24h cap and every other platform rule. Those are not
//     ours to waive; see TIKTOK_DAILY_CAP in publish/tiktok.js.
//   - hasPublished(), which stops the same post reaching real followers twice.
//     That is not a quota, it is a duplicate, and the owner asking for a second
//     Dolomites deck is asking for a different post rather than the same one.

const als = new AsyncLocalStorage();

/** Run `fn` with guards relaxed, collecting what was stepped over. */
export function runOverridden(reason, fn) {
  return als.run({ active: true, reason, notes: [] }, fn);
}

export const overrideActive = () => Boolean(als.getStore()?.active);

/**
 * Record that a guard was stepped over, and report whether it may be.
 *
 * Returns true when an override is in force — so a call site reads as
 * `if (blocked && !noteOverride(...)) reject()`, which keeps the guard's normal
 * behaviour when nobody asked for an override and cannot accidentally bypass it
 * by forgetting a check.
 */
export function noteOverride(guard, detail) {
  const s = als.getStore();
  if (!s?.active) return false;
  const line = detail ? `${guard} — ${detail}` : guard;
  if (!s.notes.includes(line)) s.notes.push(line);
  return true;
}

/** Note something worth saying that did not block anything. */
export function noteDisclosure(detail) {
  const s = als.getStore();
  if (!s?.active || !detail) return false;
  if (!s.notes.includes(detail)) s.notes.push(detail);
  return true;
}

export const overrideNotes = () => [...(als.getStore()?.notes || [])];
export const overrideReason = () => als.getStore()?.reason || null;
