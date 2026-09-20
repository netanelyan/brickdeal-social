import { gather, enabledSources } from './sources/index.js';
import { rank } from './score.js';
import { toCandidate, candidateId, RejectedError } from './candidate.js';
import * as store from './store.js';
import { snapshot as usageSnapshot } from './usage.js';
import { noteOverride, overrideActive } from './override.js';

// The daily loop: gather -> rank -> build the best two or three -> hand them
// over for approval.
//
// It stops at the target rather than building everything it found. The brief
// asks for "the best two or three a day", and an approval queue you stop
// reading is worse than a short one — twenty cards a day is how a human gate
// quietly turns into a rubber stamp.

export const dailyTarget = () => Math.max(1, Number(process.env.DAILY_TARGET ?? '3'));

/**
 * Ceiling on drafting calls per run — the only thing here that costs money.
 *
 * Without it the run keeps trying until it hits the target or exhausts the
 * ranked list, so a day where every source is thin or off-topic quietly spends
 * a full ranked list of calls to produce nothing. The cap turns that from an
 * open-ended bill into a known one: at the default it is 9 calls, and if the
 * budget runs out before the target is met the run reports it rather than
 * pretending there was simply nothing to post.
 */
export const draftBudget = (target = dailyTarget()) =>
  Math.max(1, Number(process.env.MAX_DRAFT_CALLS ?? target * 3));

/**
 * One full pass.
 *
 * `onStaged` is awaited per candidate so the Telegram send is part of the run,
 * not a detached promise — an approval card that fails to send should show up
 * in the run report rather than vanishing.
 *
 * Returns a summary the caller can report; it never throws for a single bad
 * item, only for a failure that makes the whole run meaningless.
 *
 * `markSeen: false` is for looking without consuming. The normal run claims each
 * id before the slow work so two runs can't race, but that also means a preview
 * burns the very candidates it was showing you — you would inspect five posts
 * and then never receive them. With this off nothing is written to the store, so
 * a preview and the real run that follows it see the same day.
 */
export async function runOnce({
  onStaged,
  onRejected,
  target = dailyTarget(),
  now = new Date(),
  markSeen = true,
  rankOptions = null,
} = {}) {
  const summary = {
    gathered: 0,
    ranked: 0,
    staged: 0,
    rejected: 0,
    rejectedByReason: {},
    sourceErrors: [],
    perSource: {},
    sourceCount: enabledSources().length,
    draftCalls: 0,
    budgetExhausted: false,
  };

  // Asking for more than the daily target is itself an override, and it is the
  // one that explains why the other bypasses in this run happened at all.
  if (overrideActive() && target > dailyTarget()) {
    noteOverride('יעד יומי (DAILY_TARGET)', `${target} פריטים במקום ${dailyTarget()}`);
  }

  const { items, errors, perSource } = await gather({ now });
  summary.gathered = items.length;
  summary.sourceErrors = errors;
  summary.perSource = perSource;

  // The daily run wants a narrow window — two items per source, twelve in all —
  // because its job is to find three good posts, not to survey the day. A
  // preview wants the opposite: the whole point is to see far enough down the
  // list to judge the direction, and with the trip rule rejecting most of a
  // natural-phenomena wire, twelve ranked items no longer reliably contain five
  // survivors. So the window is a parameter rather than a constant, and the
  // daily run's default is unchanged.
  const candidates = rank(items, { now: now.getTime(), ...(rankOptions || {}) });
  summary.ranked = candidates.length;

  // Counted from the usage recorder rather than from loop iterations, because
  // the two differ: an item rejected by verifySource never reaches the model,
  // and charging it against a budget for API calls would cut the run short over
  // something that cost nothing.
  const budget = draftBudget(target);
  const callsBefore = usageSnapshot().calls;
  const callsUsed = () => usageSnapshot().calls - callsBefore;

  for (const { item } of candidates) {
    if (summary.staged >= target) break;
    if (callsUsed() >= budget) {
      summary.budgetExhausted = true;
      break;
    }

    const id = candidateId(item);

    // Backstop. rank() already drops published items, so reaching this means
    // something bypassed the ranker — a direct caller, or a future change. It
    // costs one map lookup and it is the difference between a quiet skip and
    // posting the same thing to real followers twice.
    if (store.hasPublished(id)) {
      summary.rejected++;
      summary.rejectedByReason.duplicate = (summary.rejectedByReason.duplicate || 0) + 1;
      await onRejected?.({ reason: 'duplicate', detail: 'כבר פורסם', title: item.title, url: item.url, sourceId: item.sourceId });
      continue;
    }

    // Claimed before the slow work, not after. Two feeds carrying the same
    // story minutes apart would otherwise both survive the pre-rank dedupe
    // check and both get drafted — BrickDeal's lesson, in a new pipeline.
    //
    // The owner may step over the dedupe window. Note the short-circuit: the
    // bypass is only recorded when the item WAS going to be skipped, so the
    // override report names the items it actually rescued rather than every
    // item in the run. hasPublished above is NOT bypassable — that is a
    // duplicate reaching real followers, not a window.
    if (store.hasSeen(id) && !noteOverride('חלון כפילויות (SEEN_TTL_DAYS)', item.title || id)) {
      continue;
    }
    if (markSeen) store.markSeen(id);

    try {
      const cand = await toCandidate(item);
      await onStaged?.(cand);
      summary.staged++;
    } catch (err) {
      const reason = err instanceof RejectedError ? err.reason : 'error';
      const detail = err instanceof RejectedError ? err.detail : err.message;

      // Which rejections deserve a second chance. A source that was briefly
      // unreachable may well be up tomorrow; a source that is not on the
      // allowlist will never be, and a quota breach should be re-evaluated
      // against a different published window rather than blocked forever.
      if (markSeen && RETRYABLE.has(reason)) store.forgetSeen(id);

      summary.rejected++;
      summary.rejectedByReason[reason] = (summary.rejectedByReason[reason] || 0) + 1;
      await onRejected?.({ reason, detail, title: item.title, url: item.url, sourceId: item.sourceId });
    }
  }

  summary.draftCalls = callsUsed();
  return summary;
}

// `not_primary_source`, `redirected_off_allowlist`, `flight_price_out_of_scope`,
// `not_usable` and `no_trip` are deliberately absent: re-running them tomorrow
// re-reaches the same verdict, and forgetting them just means paying for the
// same rejection again. The last two are the new selection rule, and they are
// the ones this matters most for — a wire of eruptions and icebergs would
// otherwise be re-drafted and re-rejected every single day, for money.
const RETRYABLE = new Set([
  'source_unreachable',
  'source_too_thin',
  'draft_failed',
  'render_failed',
  // A style slip, not a verdict on the source — a fresh draft usually gets it
  // right, so the item should come back rather than being lost for 45 days.
  'unrounded_number',
  'repeated_word',
  'headline_length',
  'caption_too_long',
  'filler_adjective',
  'rhetorical_opening',
  'quota',
  'error',
]);
