import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import * as store from './src/store.js';
import { usageReport } from './src/usage.js';
import * as notify from './src/notify.js';
import { runOnce, dailyTarget } from './src/pipeline.js';
import { toCandidate, RejectedError } from './src/candidate.js';
import { primaryAuthority, enabledSources, registry } from './src/sources/index.js';
import { approvalMessage, decidedMessage, evidenceReport, channelCaption, instagramCaption, tiktokCaption } from './src/format.js';
import { renderCard, closeBrowser } from './src/render/index.js';
import { publishTelegram, publishTelegramDeck, sendForApproval } from './src/publish/telegram.js';
import { proposeIdeas, titleForRequest } from './src/deck/ideas.js';
import { buildDeck } from './src/deck/build.js';
import { toDeckCandidate } from './src/deck/candidate.js';
import { canonicalKind } from './src/sources/tiyulplus.js';
import { KINDS } from './src/sources/places.js';
import { resolveRequest } from './src/deck/request.js';
import { buildWithFallback, describeAttempt } from './src/deck/attempt.js';
import { searchConfigured, remaining as searchRemaining, dailyBudget as searchBudget } from './src/search.js';
import { publishInstagram, instagramConfigured, remainingQuota, refreshToken, tokenDaysLeft, authMode, describeError } from './src/publish/instagram.js';
import {
  publishTikTok,
  tiktokConfigured,
  creatorInfo,
  defaultPrivacy,
  nextPrivacy,
  privacyHe,
  refreshTikTokToken,
  tokenHoursLeft as tiktokHoursLeft,
  refreshTokenDaysLeft as tiktokRefreshDaysLeft,
  describeError as describeTikTokError,
  isCardLevel as isCardLevelTikTok,
} from './src/publish/tiktok.js';
import { publishTargets, targetsHe, allowedForKind } from './src/publish/targets.js';
import { imagesEnabled } from './src/images.js';
import { reasonHe } from './src/verify.js';
import { LAYOUT_HE } from './src/render/templates.js';

// Kept from BrickDeal for the same reason it exists there: a third-party
// promise chain we never get a reference to can reject, and Node's default
// since v15 is to kill the process. Catching at the boundary is what actually
// stops a crash loop, since the throw isn't in code we can wrap.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection (kept process alive):', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception (kept process alive):', err?.stack || err);
});

const {
  TG_BOT_TOKEN,
  CHANNEL_ID,
  STAGING_CHAT_ID,
  OWNER_ID,
  POST_INTERVAL_MINUTES = '240',
  RUN_HOUR = '8',
  // Gather repeatedly through the day, not once. Cards should arrive when the
  // news does; the daily cap is what keeps that honest.
  GATHER_EVERY_HOURS = '2',
  // Last hour a gather may start. Nothing should arrive overnight.
  GATHER_UNTIL_HOUR = '22',
  REJECT_DIGEST_HOURS = '6',
  REJECT_NOTIFY = 'digest', // off | each | digest
  QUIET_ALERT_HOURS = '30',
} = process.env;

if (!TG_BOT_TOKEN) {
  console.error('Set TG_BOT_TOKEN in .env');
  process.exit(1);
}
// At least one publish destination, or approving something sends it nowhere.
// CHANNEL_ID alone, Instagram alone, or both — but not neither. Telegram being
// approval-only (no channel) is a supported setup; silently having nowhere to
// publish is not.
if (!publishTargets().length) {
  console.error(
    'No publish destination configured. Set CHANNEL_ID for a Telegram channel, ' +
      'or IG_USER_ID + IG_ACCESS_TOKEN + CARD_PUBLIC_BASE_URL for Instagram, or both.'
  );
  process.exit(1);
}
// Fail closed, exactly as BrickDeal does: with no known owner there is nobody
// to lock the bot to, and this bot can publish. Refusing to start beats
// quietly accepting commands from whoever finds the username.
if (!OWNER_ID) {
  console.error('Set OWNER_ID in .env (your Telegram user id) so the bot only responds to you.');
  process.exit(1);
}
if (!STAGING_CHAT_ID) {
  console.error('Set STAGING_CHAT_ID in .env — nothing publishes without an approval tap, so there must be somewhere to send approvals.');
  process.exit(1);
}

// Telegraf times a handler out at 90 seconds by default, and the timeout does
// not merely abandon the handler: it rejects, the rejection reaches
// bot.launch()'s promise, and the catch there exits the process. So a slow
// command was killing the bot.
//
// Every long command now answers immediately and does its work detached (see
// detach below), which is the actual fix. This raises the ceiling anyway,
// because the next long thing somebody adds should degrade into a late reply
// rather than a restart.
const bot = new Telegraf(TG_BOT_TOKEN, {
  handlerTimeout: Number(process.env.HANDLER_TIMEOUT_MS || 600_000),
});

/**
 * Run something slow without holding the update open.
 *
 * A gather takes minutes and a deck takes longer. Awaiting that inside a
 * command handler is what produced "Promise timed out after 90000
 * milliseconds" followed by a restart — mid-gather, so the run was lost and the
 * approval it was about to send never arrived.
 *
 * Errors are reported to the chat rather than thrown, because there is no
 * longer an update to attach them to by the time they happen.
 */
function detach(label, work, chatId = staging) {
  Promise.resolve()
    .then(work)
    .catch(async (e) => {
      console.error(`${label} failed:`, e?.stack || e);
      await notify.send(bot.telegram, chatId, `❌ ${label} נכשל: ${e?.message || e}`).catch(() => {});
    });
}
const staging = STAGING_CHAT_ID;
const intervalMs = Math.max(1, Number(POST_INTERVAL_MINUTES)) * 60_000;
const gatherIntervalMs = Math.max(0.25, Number(GATHER_EVERY_HOURS)) * 3_600_000;

// Without this, an error thrown anywhere in a handler propagates out of
// Telegraf's update loop, rejects the promise bot.launch() returned, and the
// catch on that call exits the process. So a stale callback query — "query is
// too old", which happens whenever you tap a button on a card from before the
// last restart — was enough to restart the bot, which produced more stale
// buttons. Handled here, they stay what they are: one failed tap.
bot.catch((err, ctx) => {
  console.error(`handler error on ${ctx?.updateType || 'update'}:`, err?.stack || err);
});

// String comparison sidesteps float-precision edge cases with large Telegram ids.
const isOwner = (ctx) => String(ctx.from?.id) === String(OWNER_ID);

// Registered before every other handler, so nothing below it — message,
// command, or button tap — runs for anyone else.
bot.use(async (ctx, next) => {
  if (isOwner(ctx)) return next();
  console.log(`blocked non-owner update from ${ctx.from?.id ?? 'unknown'} (${ctx.from?.username || 'no username'})`);
  if (ctx.callbackQuery) {
    // Also clears the spinner on their end; a bare return leaves it turning.
    await ctx.answerCbQuery('⛔ not authorized').catch(() => {});
    return;
  }
  await ctx.reply('⛔ not authorized').catch(() => {});
});

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

function stagingButtons(key, cand) {
  const rows = [
    [Markup.button.callback('✅ אשר ופרסם', `ok:${key}`), Markup.button.callback('❌ דחה', `no:${key}`)],
  ];
  // Editing a headline re-renders one card. On a deck it would re-render every
  // slide at both sizes, and the title lives on the cover alone — so a deck is
  // approved or rejected as a whole, and a wrong title is a re-run.
  rows.push(
    cand?.kind === 'deck'
      ? [Markup.button.callback('📎 ציטוטים', `ev:${key}`)]
      : [Markup.button.callback('✏️ ערוך כותרת', `edit:${key}`), Markup.button.callback('📎 ציטוטים', `ev:${key}`)]
  );
  // Only when there is a real choice to make. With one privacy level available
  // — the unaudited case, where TikTok offers SELF_ONLY and nothing else — a
  // button that cycles back to the same value is a button that lies about
  // having options.
  if (cand?.tiktok?.options?.length > 1) {
    rows.push([
      Markup.button.callback(`🔒 פרטיות: ${privacyHe(cand.tiktok.privacy)}`, `tp:${key}`),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Ask TikTok who we would be posting as, and which privacy levels it allows.
 *
 * Done at staging rather than at publish time, because the answer has to be on
 * the card you are looking at when you tap approve — that is TikTok's rule for
 * Direct Post and the reason this call exists. A failure here does not block
 * staging: the card still goes out for approval carrying the reason, and the
 * publish attempt is what fails, loudly, with the same message.
 */
async function attachTikTok(cand) {
  if (!cand.publishTargets?.includes('tiktok')) return cand;
  try {
    const info = await creatorInfo();
    return {
      ...cand,
      tiktok: {
        username: info.username,
        options: info.options,
        privacy: defaultPrivacy(info.options),
      },
    };
  } catch (e) {
    const detail = describeTikTokError(e);
    console.error('tiktok: creator_info failed:', detail);
    return { ...cand, tiktok: { error: detail, options: [] } };
  }
}

async function stage(candidate) {
  const cand = await attachTikTok(candidate);
  const key = store.addStaging(cand);
  await sendForApproval(bot.telegram, staging, cand, approvalMessage(cand), stagingButtons(key, cand));
  // Stamped after the send, so the quiet alarm measures cards that actually
  // arrived — not ones that were built and then failed to reach you.
  store.noteStagedAt();
  return key;
}

// Rewrite the card in place so a decision is visible at a glance and can't be
// double-tapped. Edits whichever of caption/text the message was sent as.
async function markDecided(ctx, statusLine, cand) {
  const isPhoto = Boolean(ctx.callbackQuery?.message?.photo);
  const edit = isPhoto ? ctx.editMessageCaption.bind(ctx) : ctx.editMessageText.bind(ctx);
  await edit(decidedMessage(statusLine, cand)).catch((e) =>
    console.error('approval UX: edit failed:', e.message)
  );
  // A dedicated call — folding reply_markup into the text edit above isn't
  // reliable for actually clearing the keyboard.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
}

bot.action(/^ok:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.takeStaging(key);
  if (!cand) return ctx.answerCbQuery('כבר טופל');
  store.clearPendingEdit(key);
  store.enqueue(cand);
  const pos = store.queueSize();
  await ctx.answerCbQuery(`✅ אושר — ${pos} בתור`);
  await markDecided(ctx, `✅ אושר — ${pos} בתור`, cand);
});

bot.action(/^no:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.takeStaging(key);
  if (!cand) return ctx.answerCbQuery('כבר טופל');
  store.clearPendingEdit(key);
  // Give the day's quota slot back. A rejected card is not one of "the best two
  // or three a day", and charging the day for it meant rejecting the morning's
  // three ended the day: remaining hit zero, the gather stopped looking, and
  // nothing could publish until tomorrow. offerCeiling() is what stops the
  // refund turning into an endless supply — see tick().
  store.noteRejected(localDay(new Date()));
  await ctx.answerCbQuery('❌ נדחה');
  await markDecided(ctx, '❌ נדחה', cand);
});

bot.action(/^ev:(.+)$/, async (ctx) => {
  const cand = store.getStaging(ctx.match[1]);
  if (!cand) return ctx.answerCbQuery('כבר טופל');
  await ctx.answerCbQuery();
  await notify.send(bot.telegram, staging, evidenceReport(cand));
});

/**
 * Cycle the TikTok privacy level for one staged card.
 *
 * The card is rewritten in place so the level you are about to publish at is
 * always the level printed on the message — a button that changed hidden state
 * would defeat the point of showing it at all.
 */
bot.action(/^tp:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.getStaging(key);
  if (!cand) return ctx.answerCbQuery('כבר טופל');

  const options = cand.tiktok?.options || [];
  if (options.length < 2) return ctx.answerCbQuery('אין רמות פרטיות אחרות זמינות');

  const privacy = nextPrivacy(cand.tiktok.privacy, options);
  const updated = { ...cand, tiktok: { ...cand.tiktok, privacy } };
  store.updateStaging(key, updated);

  await ctx.answerCbQuery(`🔒 ${privacyHe(privacy)}`);
  const isPhoto = Boolean(ctx.callbackQuery?.message?.photo);
  const edit = isPhoto ? ctx.editMessageCaption.bind(ctx) : ctx.editMessageText.bind(ctx);
  await edit(approvalMessage(updated), stagingButtons(key, updated)).catch((e) =>
    console.error('approval UX: privacy edit failed:', e.message)
  );
});

bot.action(/^edit:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.getStaging(key);
  if (!cand) return ctx.answerCbQuery('כבר טופל');

  const chatId = ctx.chat.id;
  const cardMessageId = ctx.callbackQuery.message.message_id;
  const cardIsPhoto = Boolean(ctx.callbackQuery.message.photo);

  await ctx.answerCbQuery('✏️ שלח כותרת מתוקנת');
  // Freeze the card mid-edit so it can't be approved against text that's about
  // to change underneath it. The item stays in staging throughout.
  await markDecided(ctx, '✏️ ממתין לכותרת מתוקנת...', cand);

  const prompt = await ctx.reply('✏️ שלח כותרת חדשה לכרטיס שלמעלה (בתשובה להודעה הזו)', {
    reply_parameters: { message_id: cardMessageId },
    ...Markup.forceReply(),
  });

  // Keyed by the staged item, never by chat — several cards can be mid-edit at
  // once without one tap stealing another's reply.
  store.setPendingEdit(key, { chatId, promptMessageId: prompt.message_id, cardMessageId, cardIsPhoto });
});

/**
 * Apply an edited headline.
 *
 * Unlike BrickDeal's equivalent, this cannot just swap a line of text: the
 * headline is baked into a rendered JPEG, so the card has to be re-rendered or
 * the image and the caption would disagree — and the image is what publishes.
 */
async function handleEditReply(ctx, key) {
  const pending = store.getPendingEdit(key);
  store.clearPendingEdit(key);
  const cand = store.getStaging(key);
  if (!pending || !cand) return ctx.reply('הפריט הזה כבר לא ממתין לעריכה');

  const newHeadline = (ctx.message.text || ctx.message.caption || '').replace(/\s+/g, ' ').trim();
  if (!newHeadline) {
    store.setPendingEdit(key, pending); // nothing consumed — leave it pending
    return ctx.reply('שלח טקסט (לא תמונה/מדבקה)');
  }

  const updated = { ...cand, headline: newHeadline };
  try {
    updated.card = await renderCard(updated, { id: cand.id, data: cand.data, image: cand.image });
  } catch (e) {
    store.setPendingEdit(key, pending);
    return ctx.reply(`רינדור הכרטיס נכשל: ${e.message}`);
  }
  updated.channelCaption = channelCaption(updated);
  updated.instagramCaption = instagramCaption(updated);
  updated.tiktokCaption = tiktokCaption(updated);
  store.updateStaging(key, updated);

  // The old message carried the old image, so it can't be edited in place —
  // the card is re-sent with fresh buttons instead.
  await sendForApproval(bot.telegram, pending.chatId, updated, approvalMessage(updated), stagingButtons(key, updated));
  await ctx.reply('✏️ הכותרת עודכנה והכרטיס רונדר מחדש — אשר/דחה למעלה');
}

// ---------------------------------------------------------------------------
// Manual submission
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

async function ingestUrl(url, ctx) {
  const authority = primaryAuthority(url);
  if (!authority) {
    return ctx.reply(
      `⛔ ${new URL(url).hostname} לא ברשימת המקורות הראשוניים.\n` +
        'אפשר להוסיף אותו ל-sources.json אם הוא באמת מקור ראשוני.'
    );
  }

  await ctx.reply('⏳ בודק את המקור וכותב טיוטה...');
  const item = {
    sourceId: 'manual',
    sourceName: 'הגשה ידנית',
    authority: 'government',
    lang: 'en',
    pillarHints: [],
    title: url,
    summary: '',
    url,
    publishedAt: null,
  };

  try {
    const cand = await toCandidate(item);
    await stage(cand);
    logReject(null);
  } catch (err) {
    const reason = err instanceof RejectedError ? err.reason : 'error';
    const detail = err instanceof RejectedError ? err.detail : err.message;
    await ctx.reply(`❌ נפסל: ${reasonHe(reason)}\n${detail || ''}`.trim());
  }
}

bot.on('message', async (ctx, next) => {
  const replyToId = ctx.message?.reply_to_message?.message_id;
  const editKey = replyToId ? store.findPendingEditByPrompt(replyToId) : null;
  if (editKey) return handleEditReply(ctx, editKey);

  const text = ctx.message?.text || ctx.message?.caption || '';
  const urls = text.match(URL_RE) || [];
  if (!urls.length) return next?.();
  for (const url of urls) await ingestUrl(url, ctx);
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

// How many times a card retries a destination that keeps refusing it before it
// is set aside. Without a cap, a destination down for a day is an endless retry
// loop with an alert every drip tick.
const MAX_PUBLISH_ATTEMPTS = 3;

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
async function publishNext() {
  const cand = store.dequeue();
  if (!cand) return false;

  const configured = publishTargets();

  // What this card was BUILT for, not what happens to be configured now.
  //
  // These are different lists and conflating them is what stopped TikTok ever
  // working. A card is editorially barred from TikTok (targets.js), so
  // candidate.js stamps it `['telegram','instagram']` and bot.js never asks
  // creator_info for it — leaving it, correctly, with no privacy level. Reading
  // the global list here then sent that same card to TikTok anyway, where it
  // died on `no privacy level was chosen at approval`. Every card did. The
  // approval message has always promised the opposite ("what you were shown is
  // what was true when you decided") and this is where that promise was kept.
  //
  // `allowedForKind` is applied as well as the stamp, so a candidate queued
  // before the per-kind rule existed is held to it too rather than being
  // grandfathered into a destination it can never satisfy.
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

  // Nothing to do — the destination was reconfigured away while this sat in the
  // queue. Recording it stops it looping forever as a card that owes nothing.
  if (!owed.length) {
    store.recordPublished({
      id: cand.id,
      pillar: cand.pillar,
      tags: cand.tags,
      layout: cand.layout,
      sourceId: cand.sourceId,
    });
    return false;
  }

  // A destination that has failed enough times running is not worth another
  // call per card: it fails, costs quota, and buries the one alert that matters
  // under a copy of itself. Cards that owe only degraded destinations are held.
  const live = owed.filter((t) => !store.isDegraded(t));
  const skipped = owed.filter((t) => store.isDegraded(t));

  const done = {};
  const failed = [];
  // Targets this particular card can never reach, as opposed to targets that
  // are having a bad day. See the catch below.
  const abandoned = [];

  const publishers = {
    telegram: () =>
      cand.kind === 'deck'
        ? publishTelegramDeck(bot.telegram, CHANNEL_ID, cand)
        : publishTelegram(bot.telegram, CHANNEL_ID, cand),
    instagram: () => publishInstagram(cand),
    tiktok: () => publishTikTok(cand),
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

  for (const target of live) {
    try {
      done[target] = await publishers[target]();
      store.noteTargetOk(target);
    } catch (e) {
      const detail = (errorText[target] || ((x) => x.message))(e);
      console.error(`publish: ${target} failed:`, detail);

      // A card this destination can NEVER accept is not an outage, and scoring
      // it as one does real damage.
      //
      // `step: 'config'` is the publisher saying the problem is the card: no
      // privacy level, an image URL that is not https, more than 35 images.
      // Retrying cannot change any of those, and three such cards in a row
      // degraded TikTok — after which perfectly good cards behind them were
      // skipped and held without ever being attempted. That is how six posts
      // staged before TikTok was connected took the whole destination down
      // with them.
      //
      // So the target is dropped for THIS card and for nothing else: the
      // destination keeps its health, the card publishes everywhere it can,
      // and it is reported rather than retried into a hold.
      //
      // Not only what WE refuse before calling out. TikTok decides some of
      // these at its end — an unaudited app asking for a public post is
      // refused at init, and the next card asking for a private one publishes
      // fine, so the destination is healthy and must not be marked otherwise.
      if (e?.step === 'config' || cardLevel[target]?.(e)) {
        abandoned.push({ target, message: detail });
        continue;
      }

      const health = store.noteTargetFailed(target, detail);
      failed.push({ target, message: detail });
      // The edge, not the state: one escalation per outage rather than one per
      // card. This is the alert that should have arrived on day one.
      if (health.justDegraded) {
        await notify.send(bot.telegram, staging, notify.targetDegraded(target, health, detail));
      }
    }
  }

  const succeeded = live.filter((t) => done[t]);

  if (succeeded.length) {
    store.recordPublished({
      id: cand.id,
      pillar: cand.pillar,
      tags: cand.tags,
      layout: cand.layout,
      sourceId: cand.sourceId,
      telegram: Boolean(done.telegram),
      instagram: Boolean(done.instagram),
      tiktok: Boolean(done.tiktok),
    });
  }

  // Said once, whichever way the card ends up going — it is the only notice
  // that a destination was given up on, and it must not be lost inside a
  // "retrying" or "held" message about a different target.
  if (abandoned.length) {
    await notify.send(bot.telegram, staging, notify.targetAbandoned(cand.headline, abandoned));
  }

  // What this card still owes after this pass. Abandoned targets are NOT owed:
  // nothing about a later attempt would go differently.
  const stillOwed = [...skipped, ...failed.map((f) => f.target)];
  if (!stillOwed.length) {
    // A card whose only remaining target was abandoned has nothing to announce
    // as published — saying "📤 פורסם ל" with an empty list reads as a bug.
    if (succeeded.length) {
      await notify.send(bot.telegram, staging, notify.published({ headline: cand.headline, succeeded, failed: [] }));
    }
    return true;
  }

  const attempts = (cand.publishAttempts || 0) + 1;
  const retryable = skipped.length === 0 && attempts < MAX_PUBLISH_ATTEMPTS;

  if (retryable) {
    store.enqueue({ ...cand, publishAttempts: attempts, pendingTargets: stillOwed });
    await notify.send(
      bot.telegram,
      staging,
      notify.publishRetrying(cand.headline, failed, attempts, MAX_PUBLISH_ATTEMPTS, succeeded)
    );
  } else {
    // Held, not dropped. While a destination is blocked there is nothing useful
    // to retry against — but there will be, and the backlog should still exist
    // when it comes back. /retry replays it.
    store.hold(cand, stillOwed, failed[0]?.message || 'destination unavailable');
    await notify.send(
      bot.telegram,
      staging,
      notify.publishHeld(cand.headline, stillOwed, succeeded, store.heldCount())
    );
  }
  return succeeded.length > 0;
}

// ---------------------------------------------------------------------------
// Gather runs
// ---------------------------------------------------------------------------

let running = false;
let lastRunAt = null;
let lastRunDay = null;
let lastAnnouncedDay = null;
// Epoch 0, so the first tick after a start gathers immediately rather than
// waiting out a full interval.
let lastGatherAt = 0;
let quietAlertSent = false;
// The fallback anchor for the quiet alarm. An install that has never staged or
// published anything has no timestamp to measure from, and "no timestamp" must
// not read as "not quiet" — that is the state a brand new silence starts in.
const bootedAt = Date.now();

// Rolling record of what the filters rejected, so /why and the digest can show
// the actual items rather than a count.
let rejectLog = [];
let rejectQueue = [];
const REJECT_LOG_MAX = 300;
let activity = [];

function logReject(entry) {
  if (!entry) return;
  const row = { ts: Date.now(), ...entry };
  rejectLog.push(row);
  if (rejectLog.length > REJECT_LOG_MAX) rejectLog.shift();
  if (REJECT_NOTIFY === 'each') {
    notify.send(bot.telegram, staging, notify.rejectSingle(row)).catch(() => {});
  } else if (REJECT_NOTIFY === 'digest') {
    rejectQueue.push(row);
  }
}

// The Instagram Login path issues 60-day tokens. Nothing about their expiry is
// visible until publishing simply starts failing, so this runs on boot and once
// a day; refreshToken() itself decides whether it is actually due.
async function maybeRefreshIgToken() {
  if (!instagramConfigured() || authMode() === 'facebook') return;
  try {
    const r = await refreshToken();
    if (r.refreshed) {
      console.log(`   instagram: token refreshed, ${Math.round(r.daysLeft)} days left`);
      await notify.send(bot.telegram, staging, `🔑 טוקן אינסטגרם חודש — תקף עוד ${Math.round(r.daysLeft)} ימים`);
    }
  } catch (e) {
    console.error('instagram: token refresh failed:', e.message);
    await notify.send(
      bot.telegram,
      staging,
      `🔴 חידוש טוקן אינסטגרם נכשל: ${e.message}
אם לא יחודש, הפרסום יפסיק לעבוד. הרץ npm run ig-token.`
    );
  }
}

// TikTok's access token lives about a day, so this is not the same kind of
// housekeeping as Instagram's 60-day one: a bot that only refreshed on a daily
// timer would spend part of every day holding a dead token. The publish path
// refreshes too (see liveToken) — this is the belt to that's braces, and the
// place a failure gets reported while there is still time to act on it.
async function maybeRefreshTikTokToken() {
  if (!tiktokConfigured()) return;
  try {
    const r = await refreshTikTokToken();
    if (r.refreshed) console.log(`   tiktok: token refreshed, ${Math.round(r.hoursLeft)}h left`);
  } catch (e) {
    console.error('tiktok: token refresh failed:', e.message);
    await notify.send(
      bot.telegram,
      staging,
      `🔴 חידוש טוקן טיקטוק נכשל: ${describeTikTokError(e)}
אם לא יחודש, הפרסום לטיקטוק יפסיק לעבוד. הרץ npm run tiktok-token.`
    );
  }

  // The refresh token is the one that cannot be renewed from here. A year is
  // long enough to forget it exists entirely, which is why it is worth saying
  // out loud before it lapses rather than after.
  const days = tiktokRefreshDaysLeft();
  if (days != null && days <= 14) {
    await notify.send(
      bot.telegram,
      staging,
      `🔑 טוקן הרענון של טיקטוק פג בעוד ${days} ימים — הרץ npm run tiktok-token כדי לחדש`
    );
  }
}

/**
 * Ask Instagram whether it is actually reachable, at boot.
 *
 * A read-only quota call, which hits the same Graph endpoint publishing does and
 * fails the same way. Without it the first news of an app-level block arrives at
 * the first publish attempt — which, on a drip of one post every four hours, can
 * be most of a day after the bot came up believing it was fine.
 */
async function probeInstagram() {
  if (!instagramConfigured()) return;
  try {
    await remainingQuota();
    console.log('   instagram: reachable');
  } catch (e) {
    const detail = describeError(e);
    console.error('instagram: unreachable:', detail);
    await notify.send(bot.telegram, staging, notify.targetUnreachableAtBoot('instagram', detail));
  }
}

async function doRun({ announce = true, target } = {}) {
  if (running) return null;
  running = true;
  try {
    const summary = await runOnce({
      ...(target ? { target } : {}),
      onStaged: async (cand) => {
        await stage(cand);
        // Counted here rather than from the summary, so a card that reached
        // Telegram is what counts against the day — not one that was built and
        // then failed to send.
        store.noteStaged(localDay(new Date()));
        activity.push({ ts: Date.now(), type: 'staged' });
      },
      onRejected: async (r) => {
        logReject(r);
        activity.push({ ts: Date.now(), type: 'rejected', reason: r.reason });
      },
    });
    lastRunAt = Date.now();
    activity.push({ ts: lastRunAt, type: 'run', gathered: summary.gathered });
    if (announce) await notify.send(bot.telegram, staging, notify.runReport(summary));
    return summary;
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command('run', async (ctx) => {
  if (running) return ctx.reply('⏳ כבר רץ סבב איסוף');
  await ctx.reply(`⏳ מריץ סבב — עד ${dailyTarget()} פריטים`);
  detach('סבב איסוף', () => doRun(), ctx.chat.id);
});

// Re-run the same sources from scratch.
//
// /run alone will not do this: every item the previous run touched is marked
// seen, so a change to the layout or the copy rules stays invisible until
// tomorrow's news arrives. This forgets the claims first, which is what you
// want while iterating on how the cards look — and nothing else, so the
// Instagram token and the published log both survive.
bot.command('redo', async (ctx) => {
  if (running) return ctx.reply('⏳ כבר רץ סבב איסוף');
  const cleared = store.clearStaging();
  const forgotten = store.forgetAllSeen();
  await ctx.reply(
    `🔄 שכחתי ${forgotten} פריטים שכבר נראו${cleared ? ` וניקיתי ${cleared} ממתינים` : ''} — מריץ מחדש` +
      `\n(${store.publishedCount()} פוסטים שכבר פורסמו לא יחזרו)`
  );
  detach('סבב איסוף', () => doRun(), ctx.chat.id);
});

bot.command('pending', (ctx) => ctx.reply(`⏳ ${store.stagingSize()} ממתינים לאישור`));
bot.command('queue', (ctx) => ctx.reply(`📦 ${store.queueSize()} בתור לפרסום`));

bot.command('next', async (ctx) => {
  const ok = await publishNext();
  await ctx.reply(ok ? '📤 פורסם הפריט הבא' : 'התור ריק');
});

bot.command('held', (ctx) => {
  const rows = store.heldItems();
  if (!rows.length) return ctx.reply('✅ אין פוסטים מוחזקים');
  const lines = rows.map(
    (h, i) => `${i + 1}. ${h.cand.headline}\n   חסר: ${targetsHe(h.targets)}${h.error ? `\n   ${h.error}` : ''}`
  );
  ctx.reply(
    [
      `⏸️ ${rows.length} פוסטים מוחזקים:`,
      '',
      ...lines,
      '',
      '/retry כדי לנסות שוב · /clear_held כדי לוותר עליהם',
    ].join('\n')
  );
});

/**
 * Give up on the held backlog, and un-degrade the destinations it was stuck on.
 *
 * /retry is the "I have fixed it" signal and it assumes the held cards can
 * succeed once the destination is back. Some cannot: a card is frozen at
 * approval with what its destinations said then, and for TikTok that includes
 * the privacy level, which is read once at staging and never again. A card
 * approved while TikTok was unreachable has none, so it fails the instant it
 * is picked up — and /retry re-enqueues it verbatim, so it fails identically
 * every time while re-degrading TikTok behind it.
 *
 * Clearing the degraded flag is itself something only /retry does, so without
 * this there is no way out of that loop: every attempt to un-block the
 * destination drags the unpublishable cards back in with it.
 *
 * What is discarded is only what a destination still OWED. Every target that
 * already published did so before the card was held, so nothing that went out
 * is affected — only the copy that was never going to be made.
 */
bot.command('clear_held', async (ctx) => {
  const rows = store.heldItems();
  if (!rows.length) return ctx.reply('✅ אין פוסטים מוחזקים');

  const lost = new Set();
  for (const h of rows) for (const t of h.targets) lost.add(t);

  const n = store.clearHeld();
  // The point of the command. Un-degrading is what lets the NEXT post reach
  // the destination, and it is the half that /retry could not deliver on its
  // own here.
  for (const t of publishTargets()) store.clearDegraded(t);

  await ctx.reply(
    [
      `🗑️ ${n} פוסטים מוחזקים נמחקו.`,
      `ויתרנו על: ${targetsHe([...lost])}`,
      'מה שכבר פורסם נשאר. כל היעדים סומנו כתקינים - הפוסט הבא ינסה מחדש.',
    ].join('\n')
  );
});

/**
 * Put every held post back on the queue and un-degrade the destinations that
 * were refusing them.
 *
 * This is the deliberate "I have fixed it" signal. Nothing here retries by
 * itself once a destination is marked degraded, because while Instagram is
 * blocked at the API a retry is a wasted call and a repeated alert — so
 * something has to say the block is gone, and it should be you.
 */
bot.command('retry', async (ctx) => {
  const rows = store.releaseHeld();
  const targets = new Set();
  for (const h of rows) for (const t of h.targets) targets.add(t);
  // Also clear anything degraded but with nothing held behind it.
  for (const t of publishTargets()) targets.add(t);
  for (const t of targets) store.clearDegraded(t);

  for (const h of rows) store.enqueue({ ...h.cand, publishAttempts: 0, pendingTargets: h.targets });

  if (!rows.length) return ctx.reply('אין מה להחזיר לתור. סימנתי את כל היעדים כתקינים — הפרסום הבא ינסה שוב.');
  await ctx.reply(`🔁 ${rows.length} פוסטים חזרו לתור. מפרסם את הראשון...`);
  const ok = await publishNext();
  await ctx.reply(ok ? '📤 עבד' : 'עדיין נכשל — /held לפרטים');
});

bot.command('clear_pending', (ctx) => {
  const n = store.clearStaging();
  ctx.reply(`🧹 נוקו ${n} פריטים ממתינים`);
});

bot.command('sources', (ctx) => {
  const { sources } = registry();
  const on = sources.filter((s) => s.enabled).map((s) => `✅ ${s.id} — ${s.name}`);
  const off = sources.filter((s) => !s.enabled).map((s) => `⬜ ${s.id} — ${s.note?.split('.')[0] || 'כבוי'}`);
  ctx.reply(['📚 מקורות', ...on, '', 'כבויים:', ...off].join('\n'));
});

bot.command('mix', (ctx) => ctx.reply(notify.mixReport(store.recentPublished())));
bot.command('usage', (ctx) => ctx.reply(usageReport(), { parse_mode: 'Markdown' }));

bot.command('why', (ctx) => {
  const arg = Number((ctx.message.text || '').split(' ')[1]);
  const n = Number.isFinite(arg) && arg > 0 ? Math.min(Math.floor(arg), 25) : 10;
  const items = rejectLog.slice(-n).reverse();
  if (!items.length) return ctx.reply('✅ שום דבר לא נפסל לאחרונה');
  ctx.reply(notify.rejectDigest(items, 'האחרונות'));
});

bot.command('status', async (ctx) => {
  const dayAgo = Date.now() - 24 * 3_600_000;
  const recent = activity.filter((a) => a.ts >= dayAgo);
  const day = localDay(new Date());
  const rejectedByReason = {};
  for (const r of rejectLog.filter((r) => r.ts >= dayAgo)) {
    rejectedByReason[r.reason] = (rejectedByReason[r.reason] || 0) + 1;
  }
  await ctx.reply(
    notify.statusReport({
      sourceCount: enabledSources().length,
      stagingSize: store.stagingSize(),
      queueSize: store.queueSize(),
      gathered: recent.filter((a) => a.type === 'run').reduce((s, a) => s + (a.gathered || 0), 0),
      staged: recent.filter((a) => a.type === 'staged').length,
      rejected: recent.filter((a) => a.type === 'rejected').length,
      rejectedByReason,
      publishedToday: store.publishedToday(),
      lastRunAgoMs: lastRunAt ? Date.now() - lastRunAt : null,
      postIntervalMinutes: POST_INTERVAL_MINUTES,
      stagedToday: store.stagedToday(day) - store.rejectedToday(day),
      rejectedToday: store.rejectedToday(day),
      remainingToday: remainingToday(day),
      dailyTarget: dailyTarget(),
      nextGatherInMin: Math.max(0, Math.round((gatherIntervalMs - (Date.now() - lastGatherAt)) / 60000)),
      heldCount: store.heldCount(),
      targetHealth: Object.fromEntries(publishTargets().map((t) => [t, store.targetHealth(t)])),
      targets: publishTargets(),
    })
  );
});

bot.command('igquota', async (ctx) => {
  if (!instagramConfigured()) return ctx.reply('אינסטגרם לא מוגדר');
  const health = store.targetHealth('instagram');
  const days = tokenDaysLeft();

  // Everything knowable without asking Instagram anything. Reported first and
  // unconditionally, because the moment the API refuses is exactly the moment
  // you want to know whether the token is the reason — and an earlier version
  // put the token line after the call that throws, so it never printed then.
  const local = [];
  if (days != null) {
    local.push(
      days > 0
        ? `🔑 הטוקן תקף עוד ${days} ימים (מתחדש אוטומטית)`
        : `🔑 הטוקן פג לפני ${Math.abs(days)} ימים — npm run ig-token`
    );
  }
  if (health.lastOkAt) local.push(`✅ פורסם לאחרונה לפני ${notify.humanDuration(Date.now() - health.lastOkAt)}`);
  else local.push('⚪ עוד לא פורסם לאינסטגרם מהמכונה הזו');
  if (health.failures) local.push(`⚠️ ${health.failures} כשלונות ברצף`);

  try {
    const left = await remainingQuota();
    ctx.reply(
      [left == null ? 'לא התקבלה מכסה מ-Graph API' : `📸 נותרו ${left} פרסומים ב-24 השעות הקרובות`, ...local].join('\n')
    );
  } catch (e) {
    // The full diagnostic, not just Graph's sentence. "API access blocked" on
    // its own names a symptom; the code and subcode are what identify it — and
    // a live token printed next to it rules out the first thing you would guess.
    ctx.reply([`🔴 ${describeError(e)}`, '', ...local].join('\n'));
  }
});

/**
 * Build one slideshow.
 *
 * `/deck` lets the model choose what to make; `/deck Prague museum` names it
 * outright, which is what you want when you are testing a change or when the
 * channel needs a specific destination this week.
 *
 * Deliberately on demand rather than on the daily timer. A deck costs an idea
 * call, a search per place and a drafting call per place, and the failure modes
 * (a thin region, an exhausted search budget) are ones you want to read about
 * while you are sitting there, not discover in a digest.
 */
bot.command('deck', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/deck(@\S+)?\s*/, '').trim();

  if (!searchConfigured()) {
    await ctx.reply(
      '⚠️ חיפוש לא מוגדר (GOOGLE_CSE_KEY, GOOGLE_CSE_CX) — נשתמש רק בעמוד הראשי של כל מקום, מה שבדרך כלל לא מספיק לעובדות'
    );
  }

  // A deck is minutes of work: an idea call, a search and a drafting call per
  // place, then twelve renders. Held inside the handler it overran Telegraf's
  // timeout and took the process down with it.
  detach('בניית מצגת', () => buildAndStageDeck(arg, ctx.chat.id), ctx.chat.id);
});

async function buildAndStageDeck(arg, chatId) {
  const say = (text) => notify.send(bot.telegram, chatId, text).catch(() => {});

  let idea;
  let alternatives = [];
  try {
    if (arg) {
      // Anything at all: "Prague museum", "mountains Italy", "japan autumn",
      // "הרים בשווייץ". Parsed when it parses and interpreted when it does not,
      // so the command answers with a slideshow rather than with a grammar
      // complaint.
      const req = await resolveRequest(arg);
      alternatives = req.alternatives;
      await say(`⏳ בונה מצגת: ${req.where} / ${KINDS[req.kind]?.he || req.kind}...`);
      // A requested deck gets a written cover too. Naming it "Prague · museum"
      // put a filename on the front of a Hebrew slideshow.
      const cover = await titleForRequest({ where: req.where, kind: req.kind, count: req.want }).catch(() => ({
        titleHe: req.titleHe,
      }));
      idea = { ...cover, where: req.where, kind: req.kind, want: req.want, whyNow: 'asked for directly' };
    } else {
      await say('⏳ חושב על רעיונות...');
      const recent = store.recentPublished().map((p) => p.headline || p.id).filter(Boolean).slice(0, 12);
      const ideas = await proposeIdeas({ count: 3, recent });
      if (!ideas.length) return say('❌ לא חזרו רעיונות');
      idea = ideas[0];
      // The other two are this run's fallbacks. They were generated anyway, and
      // they are exactly what to try when the first idea turns out to be about
      // a region nobody has mapped.
      alternatives = ideas.slice(1).map((i) => ({ where: i.where, kind: i.kind }));
      // `say`, not ctx.reply — this function runs detached from the update that
      // started it and there is no ctx here. It threw a ReferenceError on every
      // bare /deck, which is why that path appeared to hang.
      await say(
        [`💡 ${idea.titleHe}`, idea.angleHe, `📍 ${idea.where} · ${idea.kind} · ${idea.want} מקומות`, `⏳ מחפש מקורות...`]
          .filter(Boolean)
          .join('\n')
      );
    }

    const built = await buildWithFallback(idea, alternatives, {
      // Said out loud, because a deck takes minutes and silence looks like a
      // hang. "Bernese Alps came back with two slides, trying Valais" is also
      // the most useful thing to know afterwards.
      onAttempt: (attempt, i, why) => {
        if (i > 0) say(`↩️ ${why || 'לא הצליח'} - מנסה ${describeAttempt(attempt)}`);
      },
    });
    if (!built?.slides?.length) {
      // Still a suggestion rather than a dead end: the request was understood,
      // the region just has nothing mappable in it, and the next thing to try
      // is worth saying out loud.
      const next = alternatives[0];
      return say(
        [
          `😕 לא הצלחתי לבנות מצגת על ${idea.where} / ${KINDS[idea.kind]?.he || idea.kind}`,
          next ? `💡 שווה לנסות: /deck ${next.where} ${next.kind}` : '💡 נסה אזור ממוקד יותר, למשל /deck Dolomites trail',
        ].join('\n')
      );
    }

    const cand = await toDeckCandidate(built);

    if (store.hasPublished(cand.id)) {
      return say(`⏭️ המצגת הזו כבר פורסמה (${cand.id}) — /deck שוב לרעיון אחר`);
    }

    await stage(cand);
    await say(
      [
        `✅ ${built.slides.length} שקופיות · סגנון ${built.style === 'info' ? 'מידע' : 'מינימלי'}`,
        built.short ? `⚠️ ביקשנו ${idea.want}` : null,
        searchConfigured() ? `🔎 ${searchRemaining()}/${searchBudget()} חיפושים נותרו היום` : 'בלי חיפוש',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (e) {
    console.error('deck failed:', e);
    // The dropped list is the useful part of a failure here: "nothing had an
    // official page" and "the search budget ran out" look identical otherwise.
    const why = e.deck?.dropped?.length
      ? ['', ...e.deck.dropped.slice(0, 5).map((d) => `   ✗ ${d.place}: ${String(d.why).slice(0, 90)}`)].join('\n')
      : '';
    await say(`❌ בניית המצגת נכשלה: ${e.message}${why}`);
  }
}

bot.command('tiktok', async (ctx) => {
  if (!tiktokConfigured()) {
    return ctx.reply(
      'טיקטוק לא מחובר.\nהגדר TIKTOK_CLIENT_KEY ו-TIKTOK_CLIENT_SECRET ו-TIKTOK_REDIRECT_URI ב-.env, ואז npm run tiktok-token'
    );
  }

  const health = store.targetHealth('tiktok');
  const hours = tiktokHoursLeft();
  const refreshDays = tiktokRefreshDaysLeft();

  // Everything knowable without asking TikTok anything comes first, for the
  // same reason /igquota does it: when the API refuses, the token state is the
  // first thing you want next to the refusal, not after it.
  const local = [];
  if (hours != null) {
    local.push(
      hours > 0
        ? `🔑 טוקן הגישה תקף עוד ${hours} שעות (מתחדש אוטומטית)`
        : `🔑 טוקן הגישה פג — יתחדש בפרסום הבא, או npm run tiktok-token`
    );
  }
  if (refreshDays != null) local.push(`🔁 טוקן הרענון תקף עוד ${refreshDays} ימים`);
  if (health.lastOkAt) local.push(`✅ פורסם לאחרונה לפני ${notify.humanDuration(Date.now() - health.lastOkAt)}`);
  else local.push('⚪ עוד לא פורסם לטיקטוק מהמכונה הזו');
  if (health.failures) local.push(`⚠️ ${health.failures} כשלונות ברצף`);

  try {
    const info = await creatorInfo();
    const levels = info.options.map(privacyHe).join(', ') || 'לא התקבלו';
    const audit =
      info.options.length === 1 && info.options[0] === 'SELF_ONLY'
        ? '\n⚠️ רק פרסום פרטי זמין — זה מה שאפליקציה לפני אישור (audit) מקבלת'
        : '';
    ctx.reply([`🎵 @${info.username || '?'}`, `🔒 רמות פרטיות זמינות: ${levels}${audit}`, ...local].join('\n'));
  } catch (e) {
    ctx.reply([`🔴 ${describeTikTokError(e)}`, '', ...local].join('\n'));
  }
});

bot.command('help', (ctx) =>
  ctx.reply(
    [
      'פקודות:',
      '/run — סבב איסוף עכשיו',
      '/redo — שכח מה כבר נראה והרץ שוב (לבדיקת שינויים בעיצוב/נוסח)',
      '/status — סטטוס מלא',
      '/pending /queue /next',
      '/held — פוסטים מאושרים שממתינים ליעד שנפל',
      '/retry — אחרי שתיקנת: מחזיר אותם לתור',
      '/clear_held — מוותר על המוחזקים ומסמן את היעדים כתקינים',
      '/why [n] — מה נפסל ולמה',
      '/mix — תמהיל הנושאים שפורסמו',
      '/sources — רשימת המקורות',
      '/igquota — מכסת אינסטגרם',
      '/deck — בונה מצגת לטיקטוק (רעיון, מקורות, שקופיות)',
      '/deck <מקום> <קטגוריה> — מצגת מוזמנת, למשל: /deck Prague museum',
      '/tiktok — חיבור טיקטוק, טוקנים ורמות פרטיות',
      '/clear_pending',
      '',
      'אפשר גם להדביק כתובת של מקור ראשוני והיא תיבדק ותיכתב.',
    ].join('\n')
  )
);

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

// The local date, not the UTC one. `toISOString()` would roll the day over at
// 03:00 Israel time and hand you a fresh daily quota in the middle of the night.
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Hard ceiling on how many cards a day may put in front of you, whatever you do
 * with them.
 *
 * Rejecting a card gives its quota slot back, which is right — a card you turned
 * down is not one of "the best two or three a day", and without the refund three
 * rejections at breakfast guaranteed a day with no posts. But a refund with no
 * ceiling is its own failure: on a day you reject everything, every gather tops
 * the queue back up, and twenty cards a day is exactly how a human gate quietly
 * turns into a rubber stamp.
 */
const offerCeiling = () =>
  Math.max(dailyTarget(), Number(process.env.DAILY_OFFER_CEILING || dailyTarget() * 3));

/**
 * How many more cards today may stage — the smaller of the two limits above.
 *
 * `live` is what is still standing: staged-and-awaiting-you, or approved. Those
 * are the ones that count as today's two or three.
 */
function remainingToday(day) {
  const offered = store.stagedToday(day);
  const live = offered - store.rejectedToday(day);
  return Math.min(dailyTarget() - live, offerCeiling() - offered);
}

/**
 * The alarm that should have caught this and did not.
 *
 * It measured from an in-memory `lastStagedAt` that started as null and was only
 * ever set by a successful staging, behind an `if (lastStagedAt)` guard — so a
 * bot that staged nothing, which is the whole point of the alarm, skipped the
 * check forever, and any restart reset it.
 *
 * It also asked whether anything published, globally. That is the wrong
 * question when there is more than one destination: Telegram publishing every
 * day kept the answer yes while Instagram was blocked at the API and had not
 * published in days. The question is per destination.
 */
function quietCheck() {
  const hours = Math.max(1, Number(QUIET_ALERT_HOURS));
  const limitMs = hours * 3_600_000;

  const stagedAt = store.lastStagedAt();
  const stagedAgo = Date.now() - (stagedAt ?? bootedAt);

  // A destination with no success on record has never worked on this install, so
  // it measures from boot rather than opting out — never-worked is the loudest
  // case, not an exemption.
  const darkTargets = publishTargets()
    .map((target) => {
      const okAt = store.lastOkAt(target);
      return { target, ago: Date.now() - (okAt ?? bootedAt), ever: okAt != null };
    })
    .filter((t) => t.ago >= limitMs)
    .map((t) => ({ target: t.target, hoursAgo: Math.floor(t.ago / 3_600_000), ever: t.ever }));

  if (stagedAgo < limitMs && !darkTargets.length) {
    quietAlertSent = false;
    return;
  }
  if (quietAlertSent) return;
  quietAlertSent = true;

  notify
    .send(
      bot.telegram,
      staging,
      notify.quietAlert({
        hours,
        stagedHoursAgo: Math.floor(stagedAgo / 3_600_000),
        everStaged: stagedAt != null,
        darkTargets,
        stagingSize: store.stagingSize(),
        queueSize: store.queueSize(),
        heldCount: store.heldCount(),
      })
    )
    .catch(() => {});
}

function tick() {
  const now = new Date();
  const day = localDay(now);
  const hour = now.getHours();

  // Gather through the day rather than once at RUN_HOUR.
  //
  // One pass a day meant a source publishing at 14:00 waited until 11:00 the
  // next morning, and the only way to see it sooner was to type /run. Cards
  // should arrive when the news does; you approve them when you have time.
  //
  // Three things keep that from becoming a firehose:
  //   - a daily cap on what is standing plus a hard ceiling on what is offered
  //     (see remainingToday), so "the best two or three a day" stays true no
  //     matter how many times it looks, and rejecting the morning's three does
  //     not end the day;
  //   - quiet hours, so nothing arrives overnight;
  //   - the gather itself is free, and it costs a drafting call only when
  //     something genuinely new survives ranking.
  const inHours = hour >= Number(RUN_HOUR) && hour < Number(GATHER_UNTIL_HOUR);
  const remaining = remainingToday(day);
  const due = Date.now() - lastGatherAt >= gatherIntervalMs;

  if (inHours && remaining > 0 && due) {
    lastGatherAt = Date.now();
    if (day !== lastRunDay) {
      lastRunDay = day;
      maybeRefreshIgToken().catch(() => {});
      maybeRefreshTikTokToken().catch(() => {});
    }
    // Announce only the first pass of the day. The later ones are routine and a
    // "0 staged" report every few hours is noise you would learn to ignore.
    doRun({ target: remaining, announce: day !== lastAnnouncedDay }).then(() => {
      lastAnnouncedDay = day;
    }).catch((e) => console.error('gather failed:', e.message));
  }

  quietCheck();
}

function sendRejectDigest() {
  if (REJECT_NOTIFY !== 'digest' || !rejectQueue.length) return;
  const items = rejectQueue;
  rejectQueue = [];
  return notify.send(bot.telegram, staging, notify.rejectDigest(items, REJECT_DIGEST_HOURS));
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('starting tiyul+ ...');

  // launch() never resolves during normal operation — it *is* the long-poll
  // loop. Awaiting it queues everything after it behind a promise that only
  // settles at shutdown, which looks exactly like a startup hang. Confirm
  // connectivity with getMe() instead, then fire launch() without awaiting.
  const me = await bot.telegram.getMe();
  bot.botInfo = me;
  bot.launch().catch((e) => {
    console.error('bot polling stopped with an error:', e.message);
    process.exit(1);
  });

  console.log(`bot live (@${me.username})`);
  console.log(`   owner lock: ON (only ${OWNER_ID})`);
  console.log(`   sources: ${enabledSources().length} enabled`);
  console.log(`   publishing to: ${publishTargets().join(' + ')}`);
  if (!CHANNEL_ID) console.log('   telegram: approval only (no CHANNEL_ID set, nothing posts to a channel)');
  console.log(`   images: ${imagesEnabled() ? 'a provider is configured' : 'text-led cards only'}`);
  console.log(`   daily run at ${RUN_HOUR}:00 · target ${dailyTarget()} · drip every ${POST_INTERVAL_MINUTES} min`);

  await maybeRefreshIgToken();
  await maybeRefreshTikTokToken();
  await probeInstagram();

  setInterval(() => {
    publishNext().catch((e) => console.error('publish error:', e.message));
  }, intervalMs);

  setInterval(tick, 60_000);
  setInterval(
    () => sendRejectDigest()?.catch?.((e) => console.error('reject digest error:', e.message)),
    Math.max(1, Number(REJECT_DIGEST_HOURS)) * 3_600_000
  );

  await notify.send(
    bot.telegram,
    staging,
    notify.startupPing({
      sourceCount: enabledSources().length,
      queueSize: store.queueSize(),
      stagingSize: store.stagingSize(),
      targets: publishTargets(),
      images: imagesEnabled(),
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const shutdown = async (sig) => {
  await closeBrowser();
  bot.stop(sig);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
