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
import { proposeIdeas, titleForRequest, reviseIdea } from './src/deck/ideas.js';
import { buildDeck } from './src/deck/build.js';
import { toDeckCandidate, deckTopic } from './src/deck/candidate.js';
import { placeOverCap } from './src/pillars.js';
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
  isPlatformLimit as isPlatformLimitTikTok,
  TIKTOK_DAILY_CAP,
} from './src/publish/tiktok.js';
import {
  publishTargets,
  targetsForKind,
  liveTargets,
  targetsHe,
  TARGET_HE,
  allowedForKind,
} from './src/publish/targets.js';
import { imagesEnabled } from './src/images.js';
import { runOverridden, noteOverride, overrideNotes } from './src/override.js';
import { startOAuthServer, stopOAuthServer } from './src/oauthServer.js';
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
// At least one KIND has to have somewhere to go, or approving something sends
// it nowhere.
//
// Asked per kind rather than globally, which matters now that nothing publishes
// to Telegram. A global check counts CHANNEL_ID as a destination, so a box with
// a channel configured and neither Instagram nor TikTok would start cleanly and
// then silently eat everything approved — which is the exact failure this guard
// was written to prevent, surviving as a check that no longer measures it.
if (!targetsForKind('card').length && !targetsForKind('deck').length) {
  console.error(
    'No publish destination configured. Cards go to Instagram ' +
      '(IG_USER_ID + IG_ACCESS_TOKEN + CARD_PUBLIC_BASE_URL) and decks go to TikTok ' +
      '(npm run tiktok-token, or connect it from the browser). Set up at least one.\n' +
      'CHANNEL_ID no longer counts: Telegram is where you approve posts, not where they publish.'
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
      await notify.send(bot.telegram, chatId, notify.withDetail(`❌ ${label} נכשל`, e)).catch(() => {});
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
  await ctx.reply('⛔ אין הרשאה').catch(() => {});
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
  // A draft has no privacy level to show you. TikTok asks you in the app when
  // you post it, so asking creator_info here would spend a call to display a
  // choice that is not yours to make — and the list it returns is the one the
  // file's header warns is a courtesy rather than a guarantee.
  if (cand.tiktokDraft) return cand;
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

// --- deck proposals (the text stage, before anything is built) ---------------

bot.action(/^db:(.+):(instagram|tiktok|both)$/, async (ctx) => {
  const key = ctx.match[1];
  const choice = ctx.match[2];
  // Instagram first in the pair, because it is the one that publishes by
  // itself — the approval message previews whichever size comes first, and
  // previewing the crop that needs no further action from you is the useful
  // way round.
  const targets = choice === 'both' ? ['instagram', 'tiktok'] : [choice];
  // Reaching TikTok always means a draft. See the button.
  const draft = targets.includes('tiktok');
  if (!store.getProposal(key)) return ctx.answerCbQuery('כבר טופל');

  // Said at the tap, not after the build. Choosing a destination that is not
  // connected is allowed — the deck is built and held until it is — but
  // learning that after waiting minutes for twelve renders is the wrong order
  // to find it out in.
  const configured = targetsForKind('deck');
  const missing = targets.filter((t) => !configured.includes(t));
  await ctx.answerCbQuery(
    missing.length
      ? `⏳ בונה — ${targetsHe(missing)} עוד לא מחובר, הפוסט ימתין`
      : draft
        ? '⏳ בונה — טיקטוק יחכה לך בטיוטות'
        : '⏳ בונה'
  );
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  // Detached for the same reason the command was: a build is minutes of work
  // and holding it inside the handler overran Telegraf's timeout. And wrapped
  // in runOverridden again, because an AsyncLocalStorage context cannot survive
  // the wait for you to tap a button — without this, a deck you asked for by
  // name would be judged by guards the override exists to step over.
  const chatId = ctx.chat.id;
  const messageId = ctx.callbackQuery.message.message_id;
  detach(
    'בניית מצגת',
    () => runOverridden('/deck', () => buildProposal(key, chatId, messageId, targets, draft)),
    chatId
  );
});

bot.action(/^dx:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!store.getProposal(key)) return ctx.answerCbQuery('כבר טופל');
  store.clearProposal(key);
  await ctx.answerCbQuery('❌ נדחה');
  await ctx.editMessageText(`❌ נדחה\n\n${ctx.callbackQuery.message.text || ''}`).catch(() => {});
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
});

bot.action(/^dr:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!store.getProposal(key)) return ctx.answerCbQuery('כבר טופל');

  const proposalMessageId = ctx.callbackQuery.message.message_id;
  await ctx.answerCbQuery('🤖 כתוב מה לשנות');
  const prompt = await ctx.reply('🤖 מה לשנות בהצעה שלמעלה? כתוב בתשובה להודעה הזו', {
    reply_parameters: { message_id: proposalMessageId },
    ...Markup.forceReply(),
  });

  // Same pendingEdit table and the same routing by prompt message id, so two
  // proposals can be mid-revision at once without one reply reaching the other.
  // `kind` is what tells the reply handler which of the two it is holding.
  store.setPendingEdit(key, {
    kind: 'idea',
    chatId: ctx.chat.id,
    promptMessageId: prompt.message_id,
    proposalMessageId,
  });
});

/**
 * Apply an instruction to a proposed deck.
 *
 * The reply is an instruction, not a replacement — "make it autumn", "Osaka
 * instead", "six places" — which is the difference between this and the ✏️
 * button on a card, where what you type IS the new headline.
 *
 * It can only work before the build. Once a deck is rendered its title is baked
 * into the cover JPEG and toDeckCandidate has dropped the photograph that would
 * be needed to draw a new one, so this is the last point at which the words are
 * still words.
 */
async function handleIdeaReply(ctx, key, pending) {
  store.clearPendingEdit(key);
  const proposal = store.getProposal(key);
  if (!proposal) return ctx.reply('ההצעה הזו כבר לא ממתינה');

  const said = (ctx.message.text || ctx.message.caption || '').trim();
  if (!said) {
    store.setPendingEdit(key, pending); // nothing consumed — stay open for a real reply
    return ctx.reply('שלח טקסט (לא תמונה/מדבקה)');
  }

  await ctx.reply('🤖 חושב...');
  const chatId = pending.chatId;
  // Detached: one Opus call, and blocking the update loop on it delays every
  // other button in the chat.
  detach(
    'שינוי הצעה',
    async () => {
      let revised;
      try {
        revised = await reviseIdea(proposal.idea, said);
      } catch (e) {
        // The proposal is untouched and still answerable, so the prompt goes
        // back rather than leaving a dead end — replying again retries.
        store.setPendingEdit(key, pending);
        return bot.telegram.sendMessage(chatId, notify.withDetail('❌ השינוי נכשל', e));
      }
      if (!store.updateProposal(key, { idea: revised })) {
        return bot.telegram.sendMessage(chatId, 'ההצעה הזו כבר לא ממתינה');
      }
      await bot.telegram.sendMessage(chatId, `🤖 עודכן:\n\n${proposalMessage(revised)}`, proposalButtons(key));
    },
    chatId
  );
}

/**
 * Apply an edited headline.
 *
 * Unlike BrickDeal's equivalent, this cannot just swap a line of text: the
 * headline is baked into a rendered JPEG, so the card has to be re-rendered or
 * the image and the caption would disagree — and the image is what publishes.
 */
async function handleEditReply(ctx, key) {
  const pending = store.getPendingEdit(key);
  // Both stages route through the same prompt-id lookup, so this is where they
  // part: an idea is still text and gets revised, a staged card is a rendered
  // JPEG and gets its headline replaced.
  if (pending?.kind === 'idea') return handleIdeaReply(ctx, key, pending);
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
    return ctx.reply(notify.withDetail('❌ רינדור הכרטיס נכשל', e));
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
  pillar: cand.pillar,
  tags: cand.tags,
  layout: cand.layout,
  sourceId: cand.sourceId,
  topic: cand.deck ? deckTopic(cand.deck) : null,
  headline: cand.headline || null,
  // Where the post was about. A deck names its region; a card names it on the
  // trip, which is the field verify.js already insists every card have.
  place: (cand.deck ? cand.deck.where : cand.trip?.where) || null,
  // So the row does not claim a post that has not been made. A draft reached
  // the inbox; whether it was ever posted happens in the app, where this
  // process cannot see it.
  tiktokDraft: Boolean(cand.tiktokDraft),
});

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

  // Nothing to do, and two reasons for it that must not be treated alike.
  if (!owed.length) {
    // The kind has no destination configured AT ALL — TikTok not connected yet,
    // Instagram not set up. That is a fact about the install and a temporary
    // one, not a fact about this post, so the post waits for the destination to
    // arrive rather than being consumed by its absence.
    //
    // This became load-bearing the moment each kind got exactly one
    // destination. Before that, "no destination at all" needed two things to be
    // switched off at once and was genuinely an edge case; now an unconnected
    // TikTok means EVERY approved deck lands here, and the branch below would
    // record each one as published and drop it. Silently, at the drip interval,
    // one slideshow at a time.
    if (!targetsForKind(cand.kind).length) {
      store.hold(cand, allowed, `no destination configured for a ${cand.kind || 'card'} yet`);
      console.log(`publish: holding ${cand.kind || 'card'} — ${allowed.join(', ')} not configured yet`);
      await notify.send(
        bot.telegram,
        staging,
        notify.publishWaitingForSetup(cand.headline, allowed, store.heldCount())
      );
      return false;
    }

    // Otherwise the destination really was reconfigured away while this sat in
    // the queue, and the kind still has somewhere to go in general. Recording it
    // stops it looping forever as a card that owes nothing.
    store.recordPublished(publishedFacts(cand));
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
  //
  // Sent on every attempt rather than once, because a card that was held for a
  // day and then retried publishes at a moment nobody is watching, and the one
  // notice it got scrolled past yesterday.
  // Two sources, and both matter. The candidate carries what was stepped over
  // when it was BUILT (a quota, the dedupe window); the ambient context carries
  // what is being stepped over to publish it RIGHT NOW (the drip interval, via
  // /next). A card built under an override and published on the timer has only
  // the first; one built normally and rushed out by hand has only the second.
  const overrides = [...new Set([...(cand.overrides || []), ...overrideNotes()])];
  if (overrides.length && live.length) {
    await notify.send(bot.telegram, staging, notify.overrideNotice(cand.headline, overrides));
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
    telegram: () =>
      cand.kind === 'deck'
        ? publishTelegramDeck(bot.telegram, CHANNEL_ID, cand)
        : publishTelegram(bot.telegram, CHANNEL_ID, cand),
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
      // "Not now" — checked BEFORE the card-level test, because a platform
      // limit arrives as step:'config' from our own preflight and would
      // otherwise be read as a card that can never publish. It can; it just
      // cannot publish yet. The destination keeps its health (nothing is wrong
      // with it), the card keeps its place, and nothing is abandoned.
      if (platformLimit[target]?.(e)) {
        limited.push({ target, message: detail });
        continue;
      }

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
    await notify.send(bot.telegram, staging, ['ℹ️ שינויים בפרסום', cand.headline, ...publisherNotes].join('\n'));
  }

  // Said once, whichever way the card ends up going — it is the only notice
  // that a destination was given up on, and it must not be lost inside a
  // "retrying" or "held" message about a different target.
  if (abandoned.length) {
    await notify.send(bot.telegram, staging, notify.targetAbandoned(cand.headline, abandoned));
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
      await notify.send(
        bot.telegram,
        staging,
        cand.tiktokDraft && succeeded.length === 1 && succeeded[0] === 'tiktok'
          ? notify.sentToDrafts(cand.headline)
          : notify.published({ headline: cand.headline, succeeded, failed: [] })
      );
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
      await notify.send(
        bot.telegram,
        staging,
        notify.platformLimited(cand.headline, limited, store.tiktokCapFreesAt())
      );
    } else {
      await notify.send(
        bot.telegram,
        staging,
        notify.publishRetrying(cand.headline, failed, attempts, MAX_PUBLISH_ATTEMPTS, succeeded)
      );
    }
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
    // Routine housekeeping working is not news. It notified on every successful
    // refresh, which is a message that says "nothing needs you" — and TikTok's
    // identical refresh has always been log-only, so the two destinations were
    // reporting the same event at different volumes.
    if (r.refreshed) console.log(`   instagram: token refreshed, ${Math.round(r.daysLeft)} days left`);
  } catch (e) {
    // The failure still notifies. Left alone, publishing stops in 60 days.
    console.error('instagram: token refresh failed:', e.message);
    await notify.send(
      bot.telegram,
      staging,
      notify.withDetail('🔴 חידוש טוקן אינסטגרם נכשל\nאם לא יחודש, הפרסום יפסיק לעבוד. הרץ npm run ig-token.', e)
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

/**
 * A gather the owner asked for.
 *
 * `/run` is the daily target; `/run 7` is however many you say, and everything
 * in the way of getting there gives way — the topic quotas, the dedupe window,
 * the daily cap itself. Each bypass is collected as it happens and travels on
 * the candidate to the approval card and to Telegram before the post goes out.
 *
 * The bot is not deciding whether the owner may do this. It is making sure the
 * owner knows they did.
 */
bot.command('run', async (ctx) => {
  if (running) return ctx.reply('⏳ כבר רץ סבב איסוף');

  const asked = Number((ctx.message?.text || '').trim().split(/\s+/)[1]);
  const target = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 25) : null;

  await ctx.reply(
    target
      ? `⏳ מריץ סבב — עד ${target} פריטים (עוקף את המכסה היומית ${dailyTarget()})`
      : `⏳ מריץ סבב — עד ${dailyTarget()} פריטים`
  );

  detach(
    'סבב איסוף',
    () => runOverridden('/run', () => doRun(target ? { target } : {})),
    ctx.chat.id
  );
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
  detach('סבב איסוף', () => runOverridden('/redo', () => doRun()), ctx.chat.id);
});

// Both queues, because both are waiting on the same thing — a tap from you.
// Counting only the built ones would report "0 pending" at the exact moment
// three proposed decks were sitting unanswered.
bot.command('pending', (ctx) =>
  ctx.reply(
    [
      `⏳ ${store.stagingSize()} ממתינים לאישור`,
      store.proposalSize() ? `💡 ${store.proposalSize()} הצעות ממתינות לבנייה` : null,
    ]
      .filter(Boolean)
      .join('\n')
  )
);
bot.command('queue', (ctx) => ctx.reply(`📦 ${store.queueSize()} בתור לפרסום`));

/**
 * Publish the next queued post now, rather than at the next drip.
 *
 * The drip is POST_INTERVAL_MINUTES apart so the channel does not arrive in
 * bursts. Asking for the next one immediately steps over that, and how far over
 * is worth saying: "posted 10 minutes after the last one instead of 240" is the
 * difference between a deliberate double-post and one you will be surprised by.
 */
bot.command('next', async (ctx) => {
  const sinceLast = store.lastPublishedAt() ? Date.now() - store.lastPublishedAt() : null;
  const ok = await runOverridden('/next', async () => {
    if (sinceLast !== null && sinceLast < intervalMs) {
      noteOverride(
        'מרווח בין פוסטים (POST_INTERVAL_MINUTES)',
        `פורסם לפני ${Math.round(sinceLast / 60_000)} דק׳ במקום ${POST_INTERVAL_MINUTES}`
      );
    }
    return publishNext();
  });
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
  for (const t of liveTargets()) store.clearDegraded(t);

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
  for (const t of liveTargets()) targets.add(t);
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

/**
 * The registry, with how each feed is actually behaving.
 *
 * `/sources` lists them; `/sources off <id>` and `/sources on <id>` switch one
 * without editing sources.json on the server and restarting. The declaration in
 * the file stays the place a source is turned off FOR GOOD, with its probe
 * result recorded; this is the switch for right now.
 */
bot.command('sources', (ctx) => {
  const { sources } = registry();
  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const verb = parts[1]?.toLowerCase();
  const id = parts[2];

  if (verb === 'on' || verb === 'off') {
    if (!id) return ctx.reply(`שימוש: /sources ${verb} <id>`);
    const src = sources.find((s) => s.id === id);
    if (!src) return ctx.reply(`אין מקור בשם "${id}" — /sources לרשימה`);
    if (verb === 'on' && !src.enabled) {
      return ctx.reply(
        `"${id}" מוצהר כבוי ב-sources.json ולא ניתן להדליק אותו מכאן.\nהסיבה שנרשמה: ${src.note?.split('.')[0] || '—'}`
      );
    }
    store.setSourceEnabled(id, verb === 'on');
    if (verb === 'on') store.clearSourceDegraded(id);
    return ctx.reply(verb === 'on' ? `✅ "${id}" הודלק` : `⬜ "${id}" כובה (זמנית, עד /sources on ${id})`);
  }

  const mark = (s) => {
    if (store.isSourceOff(s.id)) return '⏸️';
    if (store.isSourceDegradedLatched(s.id)) return '🔴';
    const h = store.sourceHealth(s.id);
    if (h.failures) return '🟡';
    return '✅';
  };

  const on = sources
    .filter((s) => s.enabled)
    .map((s) => {
      const h = store.sourceHealth(s.id);
      const bits = [`${mark(s)} ${s.id}`];
      if (h.lastOkAt) bits.push(`${h.lastItems ?? '?'} פריטים לפני ${notify.humanDuration(Date.now() - h.lastOkAt)}`);
      else if (h.failures) bits.push('עוד לא הצליח');
      if (store.isSourceDegradedLatched(s.id)) {
        const due = store.sourceRecoveryDueAt(s.id);
        bits.push(
          `הושבת אחרי ${h.failures} כשלונות` +
            (due ? `, ניסיון חוזר בעוד ${notify.humanDuration(Math.max(0, due - Date.now()))}` : '')
        );
      } else if (h.failures) {
        bits.push(`${h.failures} כשלונות ברצף`);
      }
      const line = bits.join(' · ');
      return h.lastError && (h.failures || store.isSourceDegradedLatched(s.id))
        ? `${line}\n     ⛔ ${h.lastError.slice(0, 120)}`
        : line;
    });

  const off = sources.filter((s) => !s.enabled).map((s) => `⬜ ${s.id} — ${s.note?.split('.')[0] || 'כבוי'}`);

  ctx.reply(
    [
      `📚 מקורות — ${enabledSources().length} פעילים מתוך ${sources.length} מוצהרים`,
      ...on,
      '',
      'מוצהרים כבויים:',
      ...off,
      '',
      '/sources off <id> · /sources on <id>',
    ].join('\n')
  );
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
      targetHealth: Object.fromEntries(liveTargets().map((t) => [t, store.targetHealth(t)])),
      targets: liveTargets(),
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
  // Owner-triggered, so the guards give way — and a deck asked for by name is
  // the case the override was written for. "Two Dolomites decks back to back"
  // is a legitimate request; it is only a problem if it happens without anyone
  // saying so, which is what the disclosure on the approval card prevents.
  detach(
    'בניית מצגת',
    () => runOverridden('/deck', () => buildAndStageDeck(arg, ctx.chat.id)),
    ctx.chat.id
  );
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
      console.log(`deck: resolving request ${req.where} / ${req.kind}`);
      // A requested deck gets a written cover too. Naming it "Prague · museum"
      // put a filename on the front of a Hebrew slideshow.
      const cover = await titleForRequest({ where: req.where, kind: req.kind, count: req.want }).catch(() => ({
        titleHe: req.titleHe,
      }));
      // `asked` is what YOU typed, kept so the proposal can show it beside what
      // the resolver made of it. A request naming a country is narrowed to the
      // part travellers mean — Austria + trails becomes Tyrol — because a
      // country-wide bounding box returns places that do not belong on one
      // list. That is a defensible rule, and it was invisible: the card showed
      // "Tyrol" with nothing to say where Tyrol had come from.
      //
      // whyNow was the literal English 'asked for directly', which is how an
      // English sentence ended up in the middle of a Hebrew card. Dropped: the
      // asked line says the same thing, in Hebrew, and says something useful.
      idea = { ...cover, where: req.where, kind: req.kind, want: req.want, whyNow: null, asked: arg };
    } else {
      console.log('deck: proposing ideas');
      // What actually went out, in words the model can read.
      //
      // This mapped `p.headline || p.id` against a log that never stored a
      // headline — recordPublished did not even accept one — so every entry
      // fell through to `p.id`, a sha1 slice. The prompt handed the model
      // twelve hashes under the heading "ALREADY PUBLISHED (do not repeat, and
      // avoid the same city twice in a row)". It could not read them, so it had
      // no memory of the feed at all and returned its prior every run. For
      // "beautiful travel slideshow" that prior is Kyoto, and the feed became a
      // run of Kyoto while every quota read green.
      //
      // Rows written before these fields existed have neither and drop out,
      // which shortens the list rather than padding it with noise.
      const recent = store.recentTitles();
      const ideas = await proposeIdeas({ count: 3, recent });
      if (!ideas.length) return say('❌ לא חזרו רעיונות');

      // Being told is not a mechanism. The prompt above now says what published
      // and asks for somewhere else, and that is worth doing — but the whole
      // reason the quotas exist is that a model handed a list of instructions
      // will still cheerfully hand back what it was going to say anyway.
      //
      // So the ideas are REORDERED, not filtered: a place already over its
      // share of the window goes to the back rather than being dropped. Dropping
      // would mean answering "no ideas" on a feed whose every candidate happened
      // to be somewhere popular, and a deck about a repeated city still beats no
      // deck at all — it just should not be the first choice, and the approval
      // message says so either way (see deckRepeats).
      const history = store.recentPublished();
      const fresh = ideas.filter((i) => !placeOverCap(i.where, history));
      const ordered = fresh.length ? [...fresh, ...ideas.filter((i) => !fresh.includes(i))] : ideas;
      if (fresh.length && fresh[0] !== ideas[0]) {
        console.log(`deck: "${ideas[0].where}" is over its share — starting from "${fresh[0].where}" instead`);
      }
      idea = ordered[0];
      // The other two are this run's fallbacks. They were generated anyway, and
      // they are exactly what to try when the first idea turns out to be about
      // a region nobody has mapped. Taken from `ordered`, so a fallback reached
      // after the first choice fails is also the less-repeated one.
      alternatives = ordered.slice(1).map((i) => ({ where: i.where, kind: i.kind }));
    }

    // The idea is now TEXT, and text is where it stops until you say otherwise.
    //
    // Everything below the proposal — sourcing each place, a drafting call per
    // place, twelve renders — takes minutes and real quota, and all of it used
    // to happen before you had seen anything. A deck you did not want cost the
    // whole build and was rejected at the end of it. Now it costs one message.
    return proposeDeck(idea, alternatives, chatId);
  } catch (e) {
    console.error('deck idea failed:', e);
    return say(notify.withDetail('❌ לא הצלחתי להציע מצגת', e));
  }
}

/** The proposal itself: what would be built, and the three ways to answer it. */
/** Did the resolver hand back a different region from the one you named? */
const narrowedFrom = (idea) => {
  const asked = String(idea.asked || '').trim();
  const where = String(idea.where || '').trim().toLowerCase();
  return asked && where && !asked.toLowerCase().includes(where) ? asked : null;
};

function proposalMessage(idea) {
  return [
    `💡 ${idea.titleHe}`,
    idea.angleHe,
    `📍 ${idea.where} · ${KINDS[idea.kind]?.he || idea.kind} · ${idea.want} מקומות`,
    // Shown only when the resolver moved. Typing "מסלולים אוסטריה" and being
    // offered Tyrol with no explanation reads as the bot ignoring the request,
    // when it is in fact the documented narrowing doing its job. Suppressed
    // when the request already names the region, where repeating it back costs
    // a line and says nothing.
    narrowedFrom(idea) ? `🗣 ביקשת "${idea.asked}" — צומצם ל-${idea.where}, אזור שמפה יכולה לחפש בו` : null,
    idea.whyNow ? `🗓 ${idea.whyNow}` : null,
    // The content, so the decision here is about the post rather than about a
    // headline. This is the PLAN: the build sources its own places from the
    // site or the map and may not find every one of them, which is why the
    // last line says so rather than letting you discover it at the album.
    idea.places?.length ? '────────────' : null,
    ...(idea.places || []).map((p, i) => `${i + 1}. ${p}`),
    idea.places?.length ? '\n(רשימה מתוכננת — הבנייה מאתרת את המקומות בפועל ויכולה להחליף חלק)' : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// The destination is chosen here, before anything is built — which is the only
// point at which choosing it saves anything. A deck renders twelve slides
// across two aspect ratios; picking the platform first halves that, and the
// approval card then previews the crop that is actually going out rather than
// the other platform's.
const proposalButtons = (key) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('📸 אינסטגרם', `db:${key}:instagram`),
      // TikTok is ALWAYS a draft now. There were two buttons and the direct one
      // had nothing to recommend it: the API cannot name a sound, so a direct
      // post gets whatever TikTok picks and can never be changed afterwards —
      // sound is the one thing not editable after publishing. A draft costs one
      // tap in the app and buys the sound, the cover and the caption. It is
      // also not subject to the audit, which the direct path is.
      Markup.button.callback('🎵 טיקטוק (טיוטה)', `db:${key}:tiktok`),
    ],
    [Markup.button.callback('📸🎵 שניהם', `db:${key}:both`)],
    [Markup.button.callback('🤖 שנה בהוראה', `dr:${key}`), Markup.button.callback('❌ דחה', `dx:${key}`)],
  ]);

async function proposeDeck(idea, alternatives, chatId) {
  const key = store.addProposal({ idea, alternatives, chatId });
  await bot.telegram.sendMessage(chatId, proposalMessage(idea), proposalButtons(key));
  return key;
}

/**
 * Build a proposal that was approved, and stage what comes out.
 *
 * The second half of what used to be one straight-through function. It is
 * reached from a button tap rather than from the command, so it re-enters
 * runOverridden: the override is what lets a deck the owner asked for step over
 * the repeat guards, and an AsyncLocalStorage context does not survive the wait
 * for you to tap a button.
 */
async function buildProposal(key, chatId, messageId = null, targets = ['instagram'], draft = false) {
  const say = (text) => notify.send(bot.telegram, chatId, text).catch(() => {});
  const proposal = store.getProposal(key);
  if (!proposal) return say('ההצעה הזו כבר לא ממתינה');
  const { idea, alternatives = [] } = proposal;
  store.clearProposal(key);

  // Progress rewrites the proposal message instead of sending new ones.
  //
  // A deck takes minutes, and silence looks like a hang — that is why these
  // lines existed at all. But each one was a fresh notification, so watching a
  // deck build meant four buzzes to learn three things you could not act on.
  // Editing one message in place keeps the reassurance and costs one
  // notification, which is what the message already spent.
  const progress = async (text) => {
    console.log(`deck: ${text}`);
    if (!messageId) return;
    await bot.telegram.editMessageText(chatId, messageId, undefined, text).catch(() => {});
  };

  try {
    await progress(`⏳ ${idea.titleHe}\nמחפש מקורות...`);

    const built = await buildWithFallback(idea, alternatives, {
      // Said out loud, because a deck takes minutes and silence looks like a
      // hang. "Bernese Alps came back with two slides, trying Valais" is also
      // the most useful thing to know afterwards.
      onAttempt: (attempt, i, why) => {
        if (i > 0) progress(`↩️ ${idea.titleHe}\nלא הסתדר, מנסה ${describeAttempt(attempt)}...`);
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

    // Rendered for the chosen destination only, and staged owing just that one.
    const cand = await toDeckCandidate(built, { targets, tiktokDraft: draft });

    if (store.hasPublished(cand.id)) {
      return say(`⏭️ המצגת הזו כבר פורסמה (${cand.id}) — /deck שוב לרעיון אחר`);
    }

    // The proposal message has done its job. Removing it means the deck arrives
    // as one album and one approval card, with no stale "⏳ building" line left
    // above them contradicting the finished thing underneath.
    if (messageId) await bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
    await stage(cand);

    // No summary message. It said slide count, style and search budget — and
    // the approval card above it already carries the first two in its header,
    // so it was a second notification to repeat what you were already reading.
    // The budget line goes to the log, where a number you check occasionally
    // belongs.
    console.log(
      `deck: staged ${built.slides.length} slides · style ${built.style}` +
        (built.short ? ` · asked for ${idea.want}` : '') +
        (searchConfigured() ? ` · ${searchRemaining()}/${searchBudget()} searches left today` : ' · no search')
    );
  } catch (e) {
    console.error('deck failed:', e);
    // The dropped list is the useful part of a failure here: "nothing had an
    // official page" and "the search budget ran out" look identical otherwise.
    const why = e.deck?.dropped?.length
      ? ['', ...e.deck.dropped.slice(0, 5).map((d) => `   ✗ ${d.place}: ${String(d.why).slice(0, 90)}`)].join('\n')
      : '';
    await say(notify.withDetail(`❌ בניית המצגת נכשלה${why}`, e));
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

/**
 * Per-destination health, and what is holding anything back.
 *
 * The report that did not exist while TikTok never once published. /status
 * carries a health line, but it is one line among twenty and it reads as
 * healthy whenever *something* went out — which stayed true the whole time,
 * because Telegram and Instagram were fine.
 *
 * Union of the configured destinations and every destination with a stored
 * record, so one that has been switched off while broken still reports rather
 * than vanishing from the list that would have explained it.
 */
bot.command('health', (ctx) => {
  const targets = [...new Set([...liveTargets(), ...store.healthTargets()])];
  const rows = targets.map((target) => ({
    target,
    ...store.targetHealth(target),
    // The stored flag, not the applied one: a destination inside its cooldown
    // and a destination due a probe are different answers to "why is nothing
    // going out", and isDegraded() alone cannot tell them apart.
    degraded: store.isDegradedLatched(target),
    recoveryDueAt: store.recoveryDueAt(target),
  }));

  const extra = [];
  if (tiktokConfigured()) {
    const cap = TIKTOK_DAILY_CAP();
    const used = store.tiktokPostsInLast24h();
    extra.push(`🎵 טיקטוק: ${used}/${cap} פוסטים ב-24 שעות האחרונות`);
    if (used >= cap) {
      const freesAt = store.tiktokCapFreesAt();
      if (freesAt) extra.push(`   המכסה מתפנה בעוד ${notify.humanDuration(Math.max(0, freesAt - Date.now()))}`);
    }
    const hours = tiktokHoursLeft();
    if (hours != null) extra.push(`   🔑 טוקן גישה: ${hours} שעות`);
  }
  if (store.heldCount()) extra.push(`📥 ${store.heldCount()} פוסטים מוחזקים · /held · /retry`);
  if (store.queueSize()) extra.push(`📦 ${store.queueSize()} בתור`);

  ctx.reply(notify.healthReport(rows, extra));
});

bot.command('help', (ctx) =>
  ctx.reply(
    [
      'פקודות:',
      '/run — סבב איסוף עכשיו',
      '/run <מספר> — סבב עם יעד גדול יותר, עוקף מכסות (מדווח מה נעקף)',
      '/redo — שכח מה כבר נראה והרץ שוב (לבדיקת שינויים בעיצוב/נוסח)',
      '/status — סטטוס מלא',
      '/health — בריאות כל יעד בנפרד, והשגיאה האחרונה',
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
  // liveTargets, not publishTargets: a configured Telegram channel receives
  // nothing now, so its lastOkAt is null forever and it would be reported dark
  // from boot onwards, every hour, with no way to ever clear it.
  const darkTargets = liveTargets()
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
  // Per kind, because that is now the whole rule and a combined list would be a
  // lie in both directions: it would name Telegram, which receives nothing, and
  // it would not say that a card and a deck go to different places.
  console.log(`   cards to: ${targetsForKind('card').join(' + ') || 'NOWHERE (Instagram not configured)'}`);
  console.log(`   decks to: ${targetsForKind('deck').join(' + ') || 'NOWHERE (TikTok not connected)'}`);
  console.log('   telegram: approval only — nothing publishes to a channel');
  console.log(`   images: ${imagesEnabled() ? 'a provider is configured' : 'text-led cards only'}`);
  // Connecting TikTok from a browser instead of pasting a code into a terminal.
  // In this process rather than a service of its own, so pm2 supervises it and
  // so the token it writes goes through the same store this process holds open.
  startOAuthServer();
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
      targets: liveTargets(),
      images: imagesEnabled(),
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const shutdown = async (sig) => {
  // Release the port before anything slower. pm2 restart sends SIGTERM and then
  // starts the replacement; a socket still held here greets the new process
  // with EADDRINUSE, and the connect endpoint would be the one thing that did
  // not come back from a routine restart.
  await stopOAuthServer();
  await closeBrowser();
  bot.stop(sig);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
