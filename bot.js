import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import * as store from './src/store.js';
import { usageReport } from './src/usage.js';
import * as notify from './src/notify.js';
import { closeBrowser } from './src/render/index.js';
import { publishTelegram, publishTelegramDeck, sendForApproval } from './src/publish/telegram.js';
// The BrickDeal path, in two halves on purpose. `planDeck` is free - the feed
// is a file, Brickset is cached, the rate is one call a day - and `buildProposed`
// is what costs a model call and a generated photograph per slide. The two taps
// in the approval flow sit exactly between them.
import { proposeDeck as planDeck, buildProposed } from './src/brick/build.js';
import { toBrickCandidate, brickApprovalMessage, decidedMessage } from './src/brick/candidate.js';
import { proposalMessage, proposalWarning } from './src/brick/proposal.js';
import { brickConfig } from './src/brick/config.js';
import {
  publishInstagram,
  instagramConfigured,
  remainingQuota,
  refreshToken,
  tokenDaysLeft,
  authMode,
  describeError,
  isPlatformLimit as isPlatformLimitInstagram,
} from './src/publish/instagram.js';
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
  isConfigProblem as isConfigProblemTikTok,
  missingScopes as tiktokMissingScopes,
  authorizeUrl,
  SCOPES as TIKTOK_SCOPES,
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
import { configured as imagesEnabled } from './src/images/homeShot.js';
import { runOverridden, noteOverride, overrideNotes } from './src/override.js';
import { startOAuthServer, stopOAuthServer } from './src/oauthServer.js';

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
  // How often the timer may offer a deck, through the day rather than all at
  // once in the morning. Kept under its old name because it is still the same
  // dial and it is what .env and the deploy notes call it.
  GATHER_EVERY_HOURS = '2',
  // Last hour a proposal may arrive. Nothing should turn up overnight.
  GATHER_UNTIL_HOUR = '22',
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
  // Two buttons, and there used to be four.
  //
  // "Edit the headline" re-rendered one card. On a deck it would mean
  // re-rendering every slide at both sizes, and the hook lives on the cover
  // alone — so a deck is approved or rejected as a whole, and a wrong hook is a
  // re-run, which now costs nothing but the photographs it already paid for.
  //
  // "Quotes" showed the sourced sentences behind a claim. A slideshow's claims
  // are prices, and every one of them is already on the message above with the
  // region, the currency and the rate it was converted at. A button that opened
  // a second screen to repeat that would be a button nobody taps twice.
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
  try {
    await sendForApproval(bot.telegram, staging, cand, brickApprovalMessage(cand), stagingButtons(key, cand));
  } catch (e) {
    // A send that fails leaves a post staged and INVISIBLE. It has to be added
    // before the send — the key is what the buttons carry — so the item exists,
    // is counted by /pending, and has no card in the chat to act on. Six of
    // those and the bot looks like it has stopped working while it is in fact
    // waiting for you.
    //
    // The likeliest cause is Telegram refusing a burst: a gather that drafts
    // five cards sends five photos in a row, and 429 is not a rare answer to
    // that. Not worth failing the post over — the post is fine — so it says so
    // and /resend picks it up.
    console.error(`stage: card did not reach you — ${e?.message || e}`);
    await notify
      .send(bot.telegram, staging, `⚠️ פוסט נוצר אבל הכרטיס לא נשלח (${store.stagingSize()} ממתינים) · /resend`)
      .catch(() => {});
    return key;
  }
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

  // A draft is a handoff, not a publish, so there is nothing for the drip to
  // pace. It goes to your TikTok inbox now and waits there for you; the
  // interval exists so the FEED does not arrive in bursts, and an inbox is not
  // a feed. Holding a draft in a queue for four hours delays only the moment
  // you could have started working on it.
  //
  // Instagram is a real post and keeps its place in the queue.
  const targets = cand.pendingTargets?.length ? cand.pendingTargets : cand.publishTargets || [];
  const draftNow = Boolean(cand.tiktokDraft) && targets.includes('tiktok');
  const queued = draftNow ? targets.filter((t) => t !== 'tiktok') : targets;

  if (queued.length) store.enqueue({ ...cand, pendingTargets: queued });
  const pos = store.queueSize();
  const said = draftNow
    ? queued.length
      ? `✅ טיוטה לטיקטוק · ${pos} בתור לאינסטגרם`
      : '✅ נשלח לטיוטות בטיקטוק'
    : `✅ אושר — ${pos} בתור`;

  await ctx.answerCbQuery(said);
  await markDecided(ctx, said, cand);

  // After the card is settled, so a slow upload cannot leave the message
  // looking undecided while it runs.
  if (draftNow) {
    detach('טיוטה לטיקטוק', () => publishNext({ ...cand, pendingTargets: ['tiktok'] }), ctx.chat.id);
  }
});

bot.action(/^no:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.takeStaging(key);
  if (!cand) return ctx.answerCbQuery('כבר טופל');
  store.clearPendingEdit(key);
  // Give the day's quota slot back. A rejected card is not one of "the best two
  // or three a day", and charging the day for it meant rejecting the morning's
  // three ended the day: remaining hit zero, the gather stopped looking, and
  // nothing could publish until tomorrow. DECK_BACKLOG_MAX is what stops the
  // refund turning into an endless supply — see tick().
  store.noteRejected(localDay(new Date()));
  await ctx.answerCbQuery('❌ נדחה');
  await markDecided(ctx, '❌ נדחה', cand);
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
  await edit(brickApprovalMessage(updated), stagingButtons(key, updated)).catch((e) =>
    console.error('approval UX: privacy edit failed:', e.message)
  );
});

// --- deck proposals (the text stage, before anything is paid for) -----------
//
// A proposal is not a plan here. Every set on it is already in the feed and
// already priced, so what it names is what the slides will carry. What the
// second tap buys is the cover line and the photographs, and the photographs
// are the reason the two stages exist: one generated image per slide is the
// slowest and least predictable step in the pipeline, and the cheapest moment
// to decide against a post is before paying for five of them.

bot.action(/^db:(.+):(instagram|tiktok|both)$/, async (ctx) => {
  const key = ctx.match[1];
  const choice = ctx.match[2];
  // Instagram first in the pair, because it is the one that publishes by
  // itself - the approval message previews whichever size comes first, and
  // previewing the crop that needs no further action from you is the useful
  // way round.
  const targets = choice === 'both' ? ['instagram', 'tiktok'] : [choice];
  // Reaching TikTok always means a draft. See the button.
  const draft = targets.includes('tiktok');
  if (!store.getProposal(key)) return ctx.answerCbQuery('כבר טופל');

  // Said at the tap, not after the build. Choosing a destination that is not
  // connected is allowed - the deck is built and held until it is - but
  // learning that after waiting for the photographs is the wrong order to find
  // it out in.
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

  // Detached for the same reason the command was: generating five photographs
  // is minutes of work and holding it inside the handler overran Telegraf's
  // timeout. Wrapped in runOverridden again, because an AsyncLocalStorage
  // context cannot survive the wait for you to tap a button - without this, a
  // deck you asked for by name would be judged by the guards the override
  // exists to step over.
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
  await ctx.editMessageText(`❌ נדחה

${ctx.callbackQuery.message.text || ''}`).catch(() => {});
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
});

bot.action(/^dr:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!store.getProposal(key)) return ctx.answerCbQuery('כבר טופל');

  const proposalMessageId = ctx.callbackQuery.message.message_id;
  await ctx.answerCbQuery('🤖 כתוב מה לשנות');
  const prompt = await ctx.reply('מה לבנות במקום? נושא, מחיר או שם של סט — כתוב בתשובה להודעה הזו', {
    reply_parameters: { message_id: proposalMessageId },
    ...Markup.forceReply(),
  });
  store.setPendingEdit(key, {
    kind: 'idea',
    chatId: ctx.chat.id,
    promptMessageId: prompt.message_id,
    proposalMessageId,
  });
});

/**
 * Re-plan a proposal from what you typed.
 *
 * NOT a model call, and that is a deliberate departure from the travel side,
 * where revising an idea costs an Opus round trip because the thing being
 * revised is prose. Here the request language is small and closed - a theme, a
 * price, or a set name - and `chooseRecipe` already interprets all three,
 * falling through to something buildable rather than answering with a
 * complaint. Asking a model to translate "cheaper" into "under 100₪" would be
 * paying for a worse version of a function that already exists.
 *
 * It re-reads the feed, so a set that sold out between the two messages is
 * gone from the new proposal rather than carried forward.
 */
async function handleIdeaReply(ctx, key, pending) {
  store.clearPendingEdit(key);
  if (!store.getProposal(key)) return ctx.reply('ההצעה הזו כבר לא ממתינה');

  const said = (ctx.message.text || ctx.message.caption || '').trim();
  if (!said) {
    store.setPendingEdit(key, pending); // nothing consumed — stay open for a real reply
    return ctx.reply('שלח טקסט (לא תמונה/מדבקה)');
  }

  const chatId = pending.chatId;
  detach(
    'שינוי הצעה',
    async () => {
      let proposal;
      try {
        proposal = await planDeck(said);
      } catch (e) {
        // The old proposal is untouched and still answerable, so the prompt
        // goes back rather than leaving a dead end — replying again retries.
        store.setPendingEdit(key, pending);
        return bot.telegram.sendMessage(chatId, notify.withDetail('❌ השינוי נכשל', e));
      }
      if (!store.updateProposal(key, { proposal })) {
        return bot.telegram.sendMessage(chatId, 'ההצעה הזו כבר לא ממתינה');
      }
      const warning = proposalWarning(proposal);
      await bot.telegram.sendMessage(
        chatId,
        `🤖 עודכן:

${proposalMessage(proposal)}${warning ? `

⚠️ ${warning}` : ''}`,
        proposalButtons(key)
      );
    },
    chatId
  );
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

bot.on('message', async (ctx, next) => {
  // The only thing a reply can be now is an instruction to re-plan a proposal.
  //
  // The card path used to own this handler twice over: a reply could be a new
  // headline for a staged card, and a bare message containing a URL was a
  // manual submission. Neither exists for a slideshow. A deck's title is baked
  // into the cover JPEG, so there is no line to swap - it is re-proposed
  // instead, which costs nothing - and there is nothing to submit by hand
  // because the deals come from the feed rather than from a link.
  const replyToId = ctx.message?.reply_to_message?.message_id;
  const editKey = replyToId ? store.findPendingEditByPrompt(replyToId) : null;
  if (!editKey) return next?.();

  const pending = store.getPendingEdit(editKey);
  if (pending?.kind === 'idea') return handleIdeaReply(ctx, editKey, pending);
  store.clearPendingEdit(editKey);
  return ctx.reply('הפריט הזה כבר לא ממתין');
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

async function publishNext(item = null) {
  // `item` is a post already taken out of the queue — /post hands one in after
  // pulling it by position. Everything below is identical either way: a post
  // published out of turn is still the same post, with the same destinations,
  // the same guards and the same retry behaviour.
  const cand = item || store.dequeue();
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

      // The connection is wrong, and no number of attempts repairs it. Held
      // rather than abandoned — the same deck publishes perfectly once the
      // scope is granted — and the destination is stood down at once instead
      // of after three posts have each spent three calls proving the same
      // thing. `limited` is the right bucket: it means "not now, and not your
      // fault", which is exactly this.
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
      // Which of the destinations took a draft rather than a post. Passed
      // through rather than decided here, so a deck that went to both is
      // reported honestly on each: Instagram published, TikTok is waiting.
      const drafted = cand.tiktokDraft && succeeded.includes('tiktok') ? ['tiktok'] : [];
      await notify.send(
        bot.telegram,
        staging,
        notify.published({ headline: cand.headline, succeeded, failed: [], drafted })
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
        notify.platformLimited(cand.headline, limited, store.tiktokCapFreesAt(), succeeded)
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

let lastRunDay = null;
// Epoch 0, so the first tick after a start gathers immediately rather than
// waiting out a full interval.
let quietAlertSent = false;
// The fallback anchor for the quiet alarm. An install that has never staged or
// published anything has no timestamp to measure from, and "no timestamp" must
// not read as "not quiet" — that is the state a brand new silence starts in.
const bootedAt = Date.now();

let activity = [];

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Both queues, because both are waiting on the same thing — a tap from you.
// Counting only the built ones would report "0 pending" at the exact moment
// three proposed decks were sitting unanswered.
bot.command('pending', (ctx) => {
  const rows = store.stagingItems();
  if (!rows.length && !store.proposalSize()) return ctx.reply('✅ אין ממתינים');

  // Listed, not counted. The count and the number of cards in the chat can
  // disagree — a send that failed leaves a staged post with nothing to tap —
  // and a count is the one shape that cannot show you which.
  const lines = rows.map(({ cand }, i) => `${i + 1}. ${cand.kind === 'deck' ? '🎞️' : '📰'} ${cand.headline}`);
  ctx.reply(
    [
      `⏳ ${rows.length} ממתינים לאישור:`,
      ...lines,
      store.proposalSize() ? `💡 ${store.proposalSize()} הצעות ממתינות לבנייה` : null,
      rows.length ? 'אם אין כרטיס בצ׳אט: /resend' : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
});

/**
 * Send the approval cards again.
 *
 * For the case where a post exists and its card does not. Spaced out on
 * purpose: the likeliest reason the first attempt failed is that several went
 * at once and Telegram refused the burst, and resending at the same rate would
 * reproduce exactly that.
 */
bot.command('resend', async (ctx) => {
  const rows = store.stagingItems();
  if (!rows.length) return ctx.reply('אין ממתינים');

  await ctx.reply(`📨 שולח מחדש ${rows.length} כרטיסים...`);
  detach(
    'שליחה מחדש',
    async () => {
      let sent = 0;
      for (const { key, cand } of rows) {
        try {
          await sendForApproval(bot.telegram, staging, cand, brickApprovalMessage(cand), stagingButtons(key, cand));
          sent += 1;
        } catch (e) {
          console.error(`resend: ${cand.headline} — ${e?.message || e}`);
        }
        // A second and a half between cards. The per-chat burst limit is what
        // is being worked around, and a deck is an album plus a message.
        await new Promise((r) => setTimeout(r, 1500));
      }
      await notify.send(bot.telegram, staging, `📨 ${sent}/${rows.length} נשלחו`);
    },
    ctx.chat.id
  );
});
/**
 * What is waiting, in the order it will go out.
 *
 * It used to answer with a count, which tells you there are four posts and
 * nothing about whether you want all four. The list is numbered because the
 * numbers are what /post takes — printing a list nobody can act on is half a
 * command.
 */
bot.command('queue', (ctx) => {
  const rows = store.queuedItems();
  if (!rows.length) return ctx.reply('📦 התור ריק');

  // Long enough to see the near future, short enough to stay one message. A
  // backlog of thirty is a different problem and /status is where it shows.
  const SHOWN = 12;
  const lines = rows.slice(0, SHOWN).map((c, i) => {
    // What it will ACTUALLY publish to: the pending list filtered by what this
    // kind is allowed. A card queued before the routing rule changed still
    // carries telegram, and printing it promises a destination that will be
    // dropped at publish time.
    const owed = (c.pendingTargets?.length ? c.pendingTargets : c.publishTargets || []).filter((t) =>
      allowedForKind(c.kind).includes(t)
    );
    const where = targetsHe(owed);
    const kind = c.kind === 'deck' ? '🎞️' : '📰';
    // Only when TikTok is still owed. Approval sends the draft immediately and
    // queues the rest, so the remainder is Instagram-only — and calling that
    // "draft" describes a handoff that already happened.
    const draft = c.tiktokDraft && owed.includes('tiktok') ? ' · טיוטה' : '';
    return `${i + 1}. ${kind} ${c.headline}\n   ${where || 'אין יעד'}${draft}`;
  });

  ctx.reply(
    [
      `📦 ${rows.length} בתור לפרסום:`,
      '',
      ...lines,
      rows.length > SHOWN ? `\n…ועוד ${rows.length - SHOWN}` : null,
      '',
      '/post 2 לפרסם אחד מסוים · /next לפרסם את הבא',
    ]
      .filter((l) => l !== null)
      .join('\n')
  );
});

/**
 * Publish one specific queued post, now, out of turn.
 *
 * The same act as /next with a choice attached, so it carries the same
 * disclosure: publishing ahead of the drip steps over POST_INTERVAL_MINUTES,
 * and how far over is worth saying out loud. It adds one of its own — this
 * post jumped the queue, which is a thing you did on purpose and which the
 * posts behind it did not.
 */
bot.command('post', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/post(@\S+)?\s*/, '').trim();
  const n = Number(arg);
  if (!arg || !Number.isInteger(n) || n < 1) {
    return ctx.reply('שימוש: /post 2 — המספר מהרשימה ב-/queue');
  }

  // Taken out BEFORE publishing, so a slow publish cannot have the drip pick
  // the same post up underneath it. If publishing then fails, the post follows
  // the ordinary failure path — held or requeued — exactly as it would have
  // from the drip.
  const item = store.takeQueuedAt(n);
  if (!item) return ctx.reply(`אין פריט ${n} בתור — /queue לרשימה`);

  await ctx.reply(`⏳ מפרסם: ${item.headline}`);
  const sinceLast = store.lastPublishedAt() ? Date.now() - store.lastPublishedAt() : null;
  const ok = await runOverridden('/post', async () => {
    noteOverride('סדר התור', `#${n} לפני התור`);
    if (sinceLast !== null && sinceLast < intervalMs) {
      noteOverride(
        'מרווח',
        `${Math.round(sinceLast / 60_000)}/${POST_INTERVAL_MINUTES} דק׳`
      );
    }
    return publishNext(item);
  });
  await ctx.reply(ok ? '📤 פורסם' : 'לא פורסם — ראו את ההודעה שלמעלה');
});

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
        'מרווח',
        `${Math.round(sinceLast / 60_000)}/${POST_INTERVAL_MINUTES} דק׳`
      );
    }
    return publishNext();
  });
  await ctx.reply(ok ? '📤 פורסם הפריט הבא' : 'התור ריק');
});

/**
 * Send a queued post to TikTok drafts now, without waiting for the drip.
 *
 * The same act approval performs automatically, available for anything already
 * in the queue — a post approved before this existed, or one whose TikTok half
 * was requeued after a failure. Numbered against /queue, like /post.
 *
 * Only the TikTok half moves. Anything else the post still owes goes back on
 * the queue and keeps its turn, because that half is a real publish and the
 * drip exists for it.
 */
bot.command('draft', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/draft(@\S+)?\s*/, '').trim();
  const n = Number(arg);
  if (!arg || !Number.isInteger(n) || n < 1) return ctx.reply('שימוש: /draft 2 — המספר מהרשימה ב-/queue');

  const item = store.takeQueuedAt(n);
  if (!item) return ctx.reply(`אין פריט ${n} בתור — /queue לרשימה`);

  const targets = item.pendingTargets?.length ? item.pendingTargets : item.publishTargets || [];
  if (!targets.includes('tiktok')) {
    // Put it back exactly as it was. Taking a post out of the queue to tell you
    // it was the wrong one would be a worse answer than the error.
    store.enqueue(item);
    return ctx.reply(`הפריט הזה לא מיועד לטיקטוק (${targetsHe(targets) || 'אין יעד'})`);
  }

  const rest = targets.filter((t) => t !== 'tiktok');
  if (rest.length) store.enqueue({ ...item, pendingTargets: rest });

  await ctx.reply(`⏳ שולח לטיוטות: ${item.headline}`);
  detach('טיוטה לטיקטוק', () => publishNext({ ...item, pendingTargets: ['tiktok'] }), ctx.chat.id);
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

// The queue, which /clear_pending does not touch and should not.
//
// What is in staging you have not answered; what is in the queue you already
// approved. Throwing both away on one word would put the more expensive
// mistake behind the cheaper one's command.
//
// It is needed because approval is not reversible otherwise: a deck approved
// to a destination that has since been turned off can never publish and could
// never be removed, so it sat in /queue forever being counted and reported.
bot.command('clear_queue', (ctx) => {
  const n = store.clearQueue();
  if (!n) return ctx.reply('📦 התור כבר ריק');
  ctx.reply(`🧹 רוקנתי את התור — ${n} פוסטים שאושרו לא יפורסמו`);
});

bot.command('usage', (ctx) => ctx.reply(usageReport(), { parse_mode: 'Markdown' }));

bot.command('status', async (ctx) => {
  const dayAgo = Date.now() - 24 * 3_600_000;
  const recent = activity.filter((a) => a.ts >= dayAgo);
  const day = localDay(new Date());
  await ctx.reply(
    notify.statusReport({
      stagingSize: store.stagingSize(),
      proposalSize: store.proposalSize(),
      queueSize: store.queueSize(),
      staged: recent.filter((a) => a.type === 'staged').length,
      publishedToday: store.publishedToday(),
      postIntervalMinutes: POST_INTERVAL_MINUTES,
      stagedToday: store.stagedToday(day) - store.rejectedToday(day),
      rejectedToday: store.rejectedToday(day),
      decksToday,
      decksPerDay: DECKS_PER_DAY,
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
 * Build a slideshow.
 *
 * `/deck` lets the feed choose what to make; `/deck harry-potter`, `/deck 100`
 * or `/deck בונסאי` names it. A request that parses is honoured and one that
 * does not is interpreted rather than refused - a thin result falls through to
 * whatever the feed can best make rather than answering with a complaint,
 * because a deck you asked for and did not get costs a message and a deck of
 * the wrong kind costs nothing at all.
 *
 * Deliberately on demand rather than on a timer. A deck costs a model call and
 * a generated photograph per slide, and the failure modes - a feed with
 * nothing fresh on it, a run of sets Brickset has never heard of - are ones you
 * want to read about while you are sitting there.
 */
bot.command('deck', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/deck(@\S+)?\s*/, '').trim();

  // Owner-triggered, so the guards give way - and a deck asked for by name is
  // the case the override was written for. "Two Harry Potter decks back to
  // back" is a legitimate request; it is only a problem if it happens without
  // anyone saying so, which is what the disclosure on the card prevents.
  //
  // Detached because reading the feed and pricing five sets against Brickset
  // can take a few seconds on a cold cache, and holding that inside the handler
  // is how Telegraf's timeout gets overrun.
  detach('הצעת מצגת', () => runOverridden('/deck', () => proposeAndAsk(arg, ctx.chat.id)), ctx.chat.id);
});

/**
 * Plan a deck and put it in front of the owner, having spent nothing.
 *
 * The proposal is where a deck stops until it is answered. Everything below it
 * - the cover call, one generated photograph per slide, twelve renders - takes
 * minutes and real money, and all of it used to happen before anything had
 * been seen.
 */
async function proposeAndAsk(request, chatId) {
  const say = (text) => notify.send(bot.telegram, chatId, text).catch(() => {});
  try {
    const proposal = await planDeck(request || null);
    const key = store.addProposal({ proposal, chatId });
    const warning = proposalWarning(proposal);
    await bot.telegram.sendMessage(
      chatId,
      `${proposalMessage(proposal)}${warning ? `\n\n⚠️ ${warning}` : ''}`,
      proposalButtons(key)
    );
    return key;
  } catch (e) {
    console.error('deck proposal failed:', e);
    // The feed's own rejections are the useful part of this failure: "every
    // deal is stale" and "the feed did not parse" look identical otherwise, and
    // only one of them is something to fix here.
    const why = e.feedDropped?.length
      ? ['', ...e.feedDropped.slice(0, 5).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`)].join('\n')
      : '';
    return say(notify.withDetail(`❌ לא הצלחתי להציע מצגת${why}`, e));
  }
}

// The destination is chosen here, before anything is built - which is the only
// point at which choosing it saves anything. A deck renders twelve slides
// across two aspect ratios; picking the platform first halves that, and the
// approval card then previews the crop that is actually going out rather than
// the other platform's.
const proposalButtons = (key) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('📸 אינסטגרם', `db:${key}:instagram`),
      // TikTok is ALWAYS a draft. There were two buttons and the direct one had
      // nothing to recommend it: the API cannot name a sound, so a direct post
      // gets whatever TikTok picks and can never be changed afterwards - sound
      // is the one thing not editable after publishing. A draft costs one tap
      // in the app and buys the sound, the cover and the caption. It is also
      // not subject to the audit, which the direct path is.
      Markup.button.callback('🎵 טיקטוק (טיוטה)', `db:${key}:tiktok`),
    ],
    [Markup.button.callback('📸🎵 שניהם', `db:${key}:both`)],
    [Markup.button.callback('🤖 שנה בהוראה', `dr:${key}`), Markup.button.callback('❌ דחה', `dx:${key}`)],
  ]);

/**
 * Build a proposal that was approved, and stage what comes out.
 *
 * Reached from a button tap rather than from the command, so it re-enters
 * runOverridden: the override is what lets a deck the owner asked for step over
 * the repeat guards, and an AsyncLocalStorage context does not survive the wait
 * for you to tap a button.
 */
async function buildProposal(key, chatId, messageId = null, targets = ['instagram'], draft = false) {
  const say = (text) => notify.send(bot.telegram, chatId, text).catch(() => {});
  const held = store.getProposal(key);
  if (!held) return say('ההצעה הזו כבר לא ממתינה');
  const { proposal } = held;
  store.clearProposal(key);

  // Progress rewrites the proposal message instead of sending new ones.
  //
  // A deck takes minutes, and silence looks like a hang - that is why these
  // lines exist at all. But each one as a fresh message meant four buzzes to
  // learn three things you could not act on. Editing one message in place keeps
  // the reassurance and costs one notification, which is what the message had
  // already spent.
  const progress = async (text) => {
    console.log(`deck: ${text}`);
    if (!messageId) return;
    await bot.telegram.editMessageText(chatId, messageId, undefined, text).catch(() => {});
  };

  try {
    await progress(`⏳ ${proposal.subject}\nכותב שער...`);

    const built = await buildProposed(proposal, {
      onProgress: (s) => progress(`⏳ ${proposal.subject}\n${s}`),
    });

    if (!built?.slides?.length) {
      return say(
        [
          `😕 לא נשארו שקופיות ב"${proposal.subject}"`,
          ...(built?.dropped || []).slice(0, 4).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`),
        ].join('\n')
      );
    }

    // Rendered for the chosen destination only, and staged owing just that one.
    const cand = await toBrickCandidate(built, { targets, tiktokDraft: draft });

    if (store.hasPublished(cand.id)) {
      return say(`⏭️ המצגת הזו כבר פורסמה (${cand.id}) — /deck שוב לרעיון אחר`);
    }

    // The proposal message has done its job. Removing it means the deck arrives
    // as one album and one approval card, with no stale "⏳ building" line left
    // above them contradicting the finished thing underneath.
    if (messageId) await bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
    await stage(cand);

    console.log(
      `deck: staged ${built.slides.length} slides · ${built.recipe} · cover from ${built.hookFrom}` +
        (built.dropped.length ? ` · ${built.dropped.length} dropped` : '')
    );
  } catch (e) {
    console.error('deck failed:', e);
    const why = e.deck?.dropped?.length
      ? ['', ...e.deck.dropped.slice(0, 5).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`)].join('\n')
      : '';
    await say(notify.withDetail(`❌ בניית המצגת נכשלה${why}`, e));
  }
}


/**
 * What a working connection needs, and the two ways to get one.
 *
 * NOT a link. An earlier version of this printed an authorize URL built here,
 * and it could never have worked: the website's callback mints its own `state`,
 * stores it, and checks the one that comes back matches. A link built anywhere
 * else carries a state that callback never issued, so it lands on
 * "הבקשה לא אומתה" every time — which is the callback doing its job.
 *
 * So the bot cannot hand out a browser link. What it can do is say precisely
 * which scopes it needs, because that is the fact that lives on this side: the
 * post mode decides the scope, and the bot is what chooses the post mode.
 */
bot.command('tiktok_connect', (ctx) => {
  const missing = tiktokMissingScopes({ draft: true });
  ctx.reply(
    [
      missing.length
        ? `🔴 החיבור הנוכחי חסר: ${missing.join(', ')}`
        : '✅ החיבור הנוכחי כולל את כל ההרשאות הדרושות',
      '',
      'ההרשאות הדרושות, בדיוק כך:',
      TIKTOK_SCOPES.join(','),
      '',
      'דרך 1 - לתקן את הדף באתר:',
      'ב-/tiktok/connect, הפרמטר scope בקישור ההרשאה צריך להיות המחרוזת שלמעלה.',
      'רק האתר יכול לייצר state שה-callback שלו יקבל, ולכן רק הוא יכול לסיים חיבור בדפדפן.',
      '',
      'דרך 2 - מהטרמינל ב-VPS, עובד עכשיו:',
      'npm run tiktok-token',
      'הסקריפט מדפיס קישור עם ההרשאות הנכונות. פתחו, אשרו, ואז העתיקו את כל',
      'הכתובת מהדפדפן והדביקו בטרמינל. דף ה-callback יראה שגיאת state - זה צפוי,',
      'והקוד עדיין תקף כי הדף לא עשה בו שימוש.',
    ].join('\n'),
    { link_preview_options: { is_disabled: true } }
  );
});

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

  // The scopes, which nothing reported until a post failed on one. The stored
  // token has carried them all along; they were simply never read back, so a
  // connection that could not publish looked identical to one that could until
  // TikTok said otherwise at init.
  const granted = store.getTikTokToken()?.scope;
  if (granted) {
    local.push(`🔐 הרשאות: ${granted}`);
    // Decks go out as drafts, so video.upload is the one that matters.
    const missing = tiktokMissingScopes({ draft: true });
    if (missing.length) {
      local.push(
        `🔴 חסר: ${missing.join(', ')} — פרסום ייכשל עד חיבור מחדש.`,
        '   רענון טוקן לא מוסיף הרשאות; צריך אישור חדש מול טיקטוק.'
      );
    }
  }
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
      '/deck — מציע מצגת מהדילים שיש עכשיו',
      '/deck harry-potter — מצגת על נושא מסוים',
      '/deck 100 — מצגת של סטים עד 100 ₪',
      '/deck בונסאי — מצגת על סט מסוים',
      '',
      '/status — סטטוס מלא',
      '/health — בריאות כל יעד בנפרד, והשגיאה האחרונה',
      '/usage — טוקנים ועלות',
      '/pending — הצעות ומצגות שממתינות לך',
      '/resend — שולח שוב את כרטיסי האישור (אם לא הגיעו)',
      '/queue — מה בתור, לפי הסדר, ממוספר',
      '/next — מפרסם את הבא בתור',
      '/post <מספר> — מפרסם אחד מסוים מהתור, מדלג על הסדר',
      '/draft <מספר> — שולח את החצי של טיקטוק לטיוטות עכשיו',
      '/held — מצגות מאושרות שממתינות ליעד שנפל',
      '/retry — אחרי שתיקנת: מחזיר אותן לתור',
      '/clear_held — מוותר על המוחזקות ומסמן את היעדים כתקינים',
      '/clear_pending — מנקה הצעות ומצגות שממתינות לאישור',
      '/clear_queue — מרוקן את התור (פוסטים שכבר אושרו)',
      '',
      '/igquota — מכסת אינסטגרם',
      '/tiktok — חיבור טיקטוק, טוקנים ורמות פרטיות',
      '/tiktok_connect — אילו הרשאות צריך ואיך לחבר',
      '',
      'תשובה להצעה משנה אותה: כתוב נושא, מחיר או שם של סט.',
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
/**
 * How many deck proposals may arrive unasked in a day.
 *
 * Capped two ways. DECKS_PER_DAY is the day's budget, and a ceiling on the
 * backlog stops them accumulating: three unanswered proposals sitting in the
 * chat is a signal to stop offering, not to offer a fourth.
 *
 * A proposal is free — the feed is a file and the prices are cached — so what
 * this paces is your attention rather than any cost.
 */
const DECKS_PER_DAY = Math.max(0, Number(process.env.DECKS_PER_DAY ?? '2'));
const DECK_BACKLOG_MAX = Math.max(1, Number(process.env.DECK_BACKLOG_MAX ?? '3'));
let deckDay = null;
let decksToday = 0;
let lastDeckSuggestAt = 0;

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

  const inHours = hour >= Number(RUN_HOUR) && hour < Number(GATHER_UNTIL_HOUR);

  // The token refresh used to ride along with the daily gather, which is where
  // it lived because a gather happened every day. There is no gather now, so it
  // gets its own day-change check - otherwise the Instagram token quietly
  // stopped being refreshed the moment the card path came out.
  if (day !== lastRunDay) {
    lastRunDay = day;
    refreshToken().catch(() => {});
    refreshTikTokToken().catch(() => {});
  }

  // Deck proposals through the day, in waking hours. Only the PROPOSAL - the
  // feed is read and the sets are priced, both of which are free, and nothing
  // is written or generated until you tap. Spaced by the gather interval so
  // they arrive through the day rather than three at once at 08:00.
  if (deckDay !== day) {
    deckDay = day;
    decksToday = 0;
  }
  if (
    inHours &&
    DECKS_PER_DAY > 0 &&
    decksToday < DECKS_PER_DAY &&
    store.proposalSize() < DECK_BACKLOG_MAX &&
    Date.now() - lastDeckSuggestAt >= gatherIntervalMs
  ) {
    lastDeckSuggestAt = Date.now();
    decksToday += 1;
    proposeAndAsk(null, staging).catch((e) => console.error('deck suggestion failed:', e.message));
  }

  quietCheck();
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('starting brickdeal-social ...');

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
  // Per kind, because that is now the whole rule and a combined list would be a
  // lie in both directions: it would name Telegram, which receives nothing, and
  // it would not say that a card and a deck go to different places.
  console.log(`   decks to: ${targetsForKind('deck').join(' + ') || 'NOWHERE (nothing is connected)'}`);
  console.log('   telegram: approval only — nothing publishes to a channel');
  console.log(
    `   photographs: ${
      imagesEnabled() ? 'generated at home-shot quality' : 'NOT configured — slides fall back to catalogue images'
    }`
  );
  // Connecting TikTok from a browser instead of pasting a code into a terminal.
  // In this process rather than a service of its own, so pm2 supervises it and
  // so the token it writes goes through the same store this process holds open.
  startOAuthServer();
  console.log(
    `   proposals ${DECKS_PER_DAY}/day between ${RUN_HOUR}:00 and ${GATHER_UNTIL_HOUR}:00 · drip every ${POST_INTERVAL_MINUTES} min`
  );

  // Both refreshes are "maybe" by nature — each returns early unless the token
  // is close enough to lapsing to be worth a call — so there is nothing to
  // decide here beyond letting them fail quietly.
  //
  // And they must fail quietly. main() rejecting exits the process, pm2 starts
  // it again, and a refresh is a network call: one unreachable API at boot
  // would otherwise become a restart loop on a bot that had nothing wrong with
  // it. Whatever does not refresh now is retried at the next day change.
  await refreshToken().catch((e) => console.error('instagram token refresh at boot:', e.message));
  await refreshTikTokToken().catch((e) => console.error('tiktok token refresh at boot:', e.message));
  await probeInstagram();

  setInterval(() => {
    publishNext().catch((e) => console.error('publish error:', e.message));
  }, intervalMs);

  setInterval(tick, 60_000);

  await notify.send(
    bot.telegram,
    staging,
    notify.startupPing({
      queueSize: store.queueSize(),
      stagingSize: store.stagingSize(),
      proposalSize: store.proposalSize(),
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
