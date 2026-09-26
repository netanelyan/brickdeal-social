import * as store from '../store.js';
import * as notify from '../notify.js';
import { emit } from './bus.js';
import { telegram as surface } from './surface.js';
import {
  publishInstagram,
  describeError,
  isPlatformLimit as isPlatformLimitInstagram,
} from '../publish/instagram.js';
import {
  publishTikTok,
  describeError as describeTikTokError,
  isCardLevel as isCardLevelTikTok,
  isPlatformLimit as isPlatformLimitTikTok,
  isConfigProblem as isConfigProblemTikTok,
} from '../publish/tiktok.js';
import { targetsForKind, targetsHe, allowedForKind, publishTargets } from '../publish/targets.js';
import { overrideNotes } from '../override.js';

// Sending one approved post to every destination it still owes.
//
// Moved here from bot.js unchanged in behaviour, for one reason: the website can
// publish too. /next and /post were the only ways to push the queue by hand, and
// leaving this inside the Telegram file would have meant either a second copy of
// three hundred lines of retry logic or a browser that can approve a post and
// then not publish it.
//
// Everything Telegram-specific went out through src/ops/surface.js — the channel
// publisher and the one-line reports to the approval chat. What is left is the
// part that was never about Telegram: which destinations this card owes, which
// of them are having a bad day, and which of the four kinds of failure this is.

// How many times a card retries a destination that keeps refusing it before it
// is set aside. Without a cap, a destination down for a day is an endless retry
// loop with an alert every drip tick.
const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * What the published log records about a post, in one place.
 *
 * Written from two call sites — the nothing-owed path and the succeeded path —
 * which had drifted into two copies of the same object literal. They must agree:
 * the quota window and the /deck idea prompt both read these fields back, and a
 * field populated on one path and not the other is a guard that works only on
 * whichever path the post happened to take.
 */
const publishedFacts = (cand) => ({
  id: cand.id,
  // Every set this post just spent, by listing AND by set number, so the
  // freshness filter in build.js has something to match on. Without these the
  // filter it runs is a no-op and the same five sets come back tomorrow under
  // a different cover — which is exactly what they did.
  alsoIds: (cand.deck?.slides || []).flatMap((s) =>
    [s.productId ? `brick:${s.productId}` : null, s.deal?.setId ? `brickset:${s.deal.setId}` : null].filter(Boolean)
  ),
  pillar: cand.pillar,
  tags: cand.tags,
  layout: cand.layout,
  sourceId: cand.sourceId,
  // What a run of posts would look like the same. For a slideshow that is its
  // theme, or its recipe when it has no theme - see brickRepeats.
  topic: cand.deck ? cand.deck.theme || cand.deck.recipe : null,
  headline: cand.headline || null,
  // Where the post was about. A deck names its region; a card names it on the
  // trip, which is the field verify.js already insists every card have.
  place: (cand.deck ? cand.deck.where : cand.trip?.where) || null,
  // So the row does not claim a post that has not been made. A draft reached
  // the inbox; whether it was ever posted happens in the app, where this
  // process cannot see it.
  tiktokDraft: Boolean(cand.tiktokDraft),
});

/**
 * Publish one approved item to every destination it still owes.
 *
 * The old rule was "if anything published, do not retry" — retrying the whole
 * item would duplicate the destination that had already succeeded. True, and it
 * threw away the other half of the post. With Instagram returning "API access
 * blocked", every card reached Telegram, was recorded as published, and the
 * Instagram account went dark for days behind one warning line per post that
 * read as a handled edge case.
 *
 * The unit of retry is the destination, not the item. `pendingTargets` is what
 * this card still owes; a destination that has already published is never in it,
 * so retrying cannot duplicate anything, and a destination that failed is not
 * abandoned just because its neighbour worked.
 */
export async function publishNext(item = null) {
  // `item` is a post already taken out of the queue — /post and the website's
  // publish-this-one both hand one in after pulling it by position. Everything
  // below is identical either way: a post published out of turn is still the
  // same post, with the same destinations, the same guards and the same retry
  // behaviour.
  const cand = item || store.dequeue();
  if (!cand) return false;

  const say = (text) => surface().say(text).catch(() => {});
  const configured = publishTargets();

  // What this card was BUILT for, not what happens to be configured now.
  //
  // These are different lists and conflating them is what stopped TikTok ever
  // working. A card is editorially barred from TikTok (targets.js), so
  // candidate.js stamps it `['telegram','instagram']` and nothing asks
  // creator_info for it — leaving it, correctly, with no privacy level. Reading
  // the global list here then sent that same card to TikTok anyway, where it
  // died on `no privacy level was chosen at approval`. Every card did. The
  // approval message has always promised the opposite ("what you were shown is
  // what was true when you decided") and this is where that promise was kept.
  const allowed = allowedForKind(cand.kind);
  const intended = (cand.publishTargets?.length ? cand.publishTargets : configured).filter((t) =>
    allowed.includes(t)
  );

  // On a first attempt this is everything it was built for; on a retry it is
  // only what failed — still filtered, so a stale pendingTargets cannot
  // resurrect a destination the kind does not allow.
  const owed = (cand.pendingTargets?.length ? cand.pendingTargets : intended).filter(
    (t) => configured.includes(t) && allowed.includes(t)
  );

  // Not silent: a card that owed a destination its kind cannot accept is a
  // candidate built under an older rule, and the queue draining quietly is how
  // this went unnoticed for 45 published posts.
  const disallowed = (cand.pendingTargets?.length ? cand.pendingTargets : cand.publishTargets || [])
    .filter((t) => !allowed.includes(t));
  if (disallowed.length) {
    console.log(
      `publish: ${disallowed.join(', ')} dropped for this ${cand.kind || 'card'} — not a destination this kind publishes to`
    );
  }

  // Nothing to do, and two reasons for it that must not be treated alike.
  if (!owed.length) {
    // The kind has no destination configured AT ALL — TikTok not connected yet,
    // Instagram not set up. That is a fact about the install and a temporary
    // one, not a fact about this post, so the post waits for the destination to
    // arrive rather than being consumed by its absence.
    if (!targetsForKind(cand.kind).length) {
      store.hold(cand, allowed, `no destination configured for a ${cand.kind || 'card'} yet`);
      console.log(`publish: holding ${cand.kind || 'card'} — ${allowed.join(', ')} not configured yet`);
      await say(notify.publishWaitingForSetup(cand.headline, allowed, store.heldCount()));
      emit('held', { headline: cand.headline, targets: allowed, heldCount: store.heldCount() });
      return false;
    }

    // Otherwise the destination really was reconfigured away while this sat in
    // the queue, and the kind still has somewhere to go in general. Recording it
    // stops it looping forever as a card that owes nothing.
    store.recordPublished(publishedFacts(cand));
    emit('published', { headline: cand.headline, succeeded: [], note: 'destination no longer configured' });
    return false;
  }

  // A destination that has failed enough times running is not worth another
  // call per card: it fails, costs quota, and buries the one alert that matters
  // under a copy of itself. Cards that owe only degraded destinations are held.
  const live = owed.filter((t) => !store.isDegraded(t));
  const skipped = owed.filter((t) => store.isDegraded(t));

  // BEFORE anything goes out, not after. A guard that was stepped over during
  // the gather is only worth recording if the sentence arrives while the post
  // can still be stopped — the point of the override is that a repeat is
  // deliberate, and "deliberate" means you read it first.
  const overrides = [...new Set([...(cand.overrides || []), ...overrideNotes()])];
  if (overrides.length && live.length) {
    await say(notify.overrideNotice(cand.headline, overrides));
  }

  const done = {};
  const failed = [];
  // Targets this particular card can never reach, as opposed to targets that
  // are having a bad day. See the catch below.
  const abandoned = [];
  // And a third kind: targets that are fine, and are simply not accepting
  // another post yet. A daily cap is neither a broken destination nor a broken
  // card, and treating it as either loses a post that would publish tomorrow.
  const limited = [];

  const publishers = {
    // Through the surface, because the channel is Telegram's and this file is
    // not. An install with no Telegram attached (a test, a script) therefore
    // reports the channel as unreachable rather than crashing on a missing
    // client — which is the truth in that situation.
    telegram: () => surface().publishToChannel(cand),
    instagram: () => publishInstagram(cand),
    tiktok: () => publishTikTok(cand, { draft: Boolean(cand.tiktokDraft) }),
  };
  const errorText = {
    instagram: describeError,
    tiktok: describeTikTokError,
  };
  // Per destination, because only the destination's own client knows which of
  // its error codes mean "this card" rather than "this service".
  const cardLevel = {
    tiktok: isCardLevelTikTok,
  };
  // Same shape, different question: is this destination refusing everyone
  // right now, rather than refusing this card or being broken?
  const platformLimit = {
    tiktok: isPlatformLimitTikTok,
    // Graph throttles clear by themselves. Retried as failures they cost three
    // attempts each and then degrade Instagram, which is the wrong answer to a
    // busy afternoon.
    instagram: isPlatformLimitInstagram,
  };
  // And a fourth: is this destination refusing everything until somebody goes
  // and fixes the connection?
  const configProblem = {
    tiktok: isConfigProblemTikTok,
  };

  for (const target of live) {
    try {
      done[target] = await publishers[target]();
      store.noteTargetOk(target);
    } catch (e) {
      const detail = (errorText[target] || ((x) => x.message))(e);
      console.error(`publish: ${target} failed:`, detail);

      // Instagram can refuse a publish it has already carried out — see the note
      // on publishContainer(). When it does, the container id comes back on the
      // error, and it has to survive onto the queued card: it is the only thing
      // the retry can ask "is this already live?" with, and without it the retry
      // posts a second copy of a post that went out fine.
      if (target === 'instagram' && e?.creationId) cand.instagramCreationId = e.creationId;

      // "Not now" — checked BEFORE the card-level test, because a platform
      // limit arrives as step:'config' from our own preflight and would
      // otherwise be read as a card that can never publish. It can; it just
      // cannot publish yet. The destination keeps its health (nothing is wrong
      // with it), the card keeps its place, and nothing is abandoned.
      if (platformLimit[target]?.(e)) {
        limited.push({ target, message: detail });
        continue;
      }

      // A card this destination can NEVER accept is not an outage, and scoring
      // it as one does real damage. `step: 'config'` is the publisher saying the
      // problem is the card: no privacy level, an image URL that is not https,
      // more than 35 images. Retrying cannot change any of those, and three such
      // cards in a row degraded TikTok — after which perfectly good cards behind
      // them were skipped and held without ever being attempted.
      if (e?.step === 'config' || cardLevel[target]?.(e)) {
        abandoned.push({ target, message: detail });
        continue;
      }

      // The connection is wrong, and no number of attempts repairs it. Held
      // rather than abandoned — the same deck publishes perfectly once the
      // scope is granted — and the destination is stood down at once instead
      // of after three posts have each spent three calls proving the same
      // thing.
      if (configProblem[target]?.(e)) {
        store.degrade(target, detail);
        limited.push({ target, message: detail });
        continue;
      }

      const health = store.noteTargetFailed(target, detail);
      failed.push({ target, message: detail });
      // The edge, not the state: one escalation per outage rather than one per
      // card. This is the alert that should have arrived on day one.
      if (health.justDegraded) {
        await say(notify.targetDegraded(target, health, detail));
        emit('target:degraded', { target, detail });
      }
    }
  }

  const succeeded = live.filter((t) => done[t]);

  if (succeeded.length) {
    store.recordPublished({
      ...publishedFacts(cand),
      telegram: Boolean(done.telegram),
      instagram: Boolean(done.instagram),
      tiktok: Boolean(done.tiktok),
    });
  }

  // Anything a publisher repaired on the way through — a privacy level the
  // account no longer offers, slides trimmed to TikTok's 35 — is reported
  // whether or not the post otherwise succeeded. A post that went out at a
  // different privacy level than the approval card promised is exactly the
  // thing that must not be discoverable only by looking at TikTok.
  const publisherNotes = [];
  for (const target of succeeded) {
    for (const note of done[target]?.notes || []) {
      publisherNotes.push(`   ${targetsHe([target])}: ${note}`);
    }
  }
  if (publisherNotes.length) {
    await say(['ℹ️ שינויים בפרסום', cand.headline, ...publisherNotes].join('\n'));
  }

  // Said once, whichever way the card ends up going — it is the only notice
  // that a destination was given up on, and it must not be lost inside a
  // "retrying" or "held" message about a different target.
  if (abandoned.length) {
    await say(notify.targetAbandoned(cand.headline, abandoned));
  }

  // What this card still owes after this pass. Abandoned targets are NOT owed:
  // nothing about a later attempt would go differently.
  const stillOwed = [...skipped, ...failed.map((f) => f.target), ...limited.map((l) => l.target)];
  if (!stillOwed.length) {
    // A card whose only remaining target was abandoned has nothing to announce
    // as published — saying "📤 פורסם ל" with an empty list reads as a bug.
    if (succeeded.length) {
      // A deck handed to your inbox did not publish, and saying it did is the
      // one wrong thing to say here: you would read "posted" and not open the
      // app, which is the only place the last step can happen.
      const drafted = cand.tiktokDraft && succeeded.includes('tiktok') ? ['tiktok'] : [];
      await say(notify.published({ headline: cand.headline, succeeded, failed: [], drafted }));
      emit('published', { headline: cand.headline, succeeded, drafted, id: cand.id });
    }
    return true;
  }

  // A pass that only ran into a platform limit has not used an attempt. The
  // three-attempt ceiling exists to stop a card failing forever; a card waiting
  // on a daily quota is not failing, and spending its attempts on the wait
  // would drop it just as the quota came free.
  const onlyLimited = limited.length > 0 && failed.length === 0 && skipped.length === 0;
  const attempts = (cand.publishAttempts || 0) + (onlyLimited ? 0 : 1);
  const retryable = onlyLimited || (skipped.length === 0 && attempts < MAX_PUBLISH_ATTEMPTS);

  if (retryable) {
    store.enqueue({ ...cand, publishAttempts: attempts, pendingTargets: stillOwed });
    if (onlyLimited) {
      await say(notify.platformLimited(cand.headline, limited, store.tiktokCapFreesAt(), succeeded));
    } else {
      await say(notify.publishRetrying(cand.headline, failed, attempts, MAX_PUBLISH_ATTEMPTS, succeeded));
    }
    emit('requeued', { headline: cand.headline, owed: stillOwed, attempts, succeeded });
  } else {
    // Held, not dropped. While a destination is blocked there is nothing useful
    // to retry against — but there will be, and the backlog should still exist
    // when it comes back. /retry replays it.
    store.hold(cand, stillOwed, failed[0]?.message || 'destination unavailable');
    await say(notify.publishHeld(cand.headline, stillOwed, succeeded, store.heldCount()));
    emit('held', { headline: cand.headline, targets: stillOwed, heldCount: store.heldCount() });
  }
  return succeeded.length > 0;
}

export { MAX_PUBLISH_ATTEMPTS };
