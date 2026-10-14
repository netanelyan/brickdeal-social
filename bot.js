import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import * as store from './src/store.js';
import { usageReport } from './src/usage.js';
import * as notify from './src/notify.js';
import { closeBrowser } from './src/render/index.js';
import { publishTelegram, publishTelegramDeck, sendForApproval } from './src/publish/telegram.js';
import { brickApprovalMessage, decidedMessage } from './src/brick/candidate.js';
// Every action, once, in one place — approve, reject, build, publish, retry. This
// file is now one of TWO callers of it; src/web/server.js is the other. See the
// header of src/ops/marketing.js for why that split exists and what it prevents.
import * as ops from './src/ops/marketing.js';
import * as views from './src/ops/views.js';
import * as jobs from './src/ops/jobs.js';
import { publishNext } from './src/ops/publish.js';
import { attach as attachSurface } from './src/ops/surface.js';
import { subscribe } from './src/ops/bus.js';
import {
  instagramConfigured,
  remainingQuota,
  refreshToken,
  tokenDaysLeft,
  describeError,
} from './src/publish/instagram.js';
import {
  zernioConfigured,
  creatorSummary,
  privacyHe,
  describeError as describeTikTokError,
  TIKTOK_DAILY_CAP,
} from './src/publish/zernio.js';
import { brickConfig } from './src/brick/config.js';
import { targetsForKind, liveTargets, targetsHe } from './src/publish/targets.js';
import { configured as imagesEnabled } from './src/images/homeShot.js';
import { startWebServer, stopWebServer } from './src/web/server.js';
import { count as adminCount } from './src/web/auth.js';

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

const { TG_BOT_TOKEN, CHANNEL_ID, STAGING_CHAT_ID, OWNER_ID } = process.env;

// The schedule is READ, never captured.
//
// These used to be destructured out of process.env at module load, which made
// every one of them unchangeable without a deploy. They are now editable from
// either surface (see SETTABLE in src/store.js), so reading them once here would
// mean a change that takes effect at the next restart — which is the same as not
// having the feature. Every use goes through the store, and the store falls back
// to .env and then to a built-in default.
const minutes = () => store.setting('POST_INTERVAL_MINUTES');
const intervalMs = () => minutes() * 60_000;
const gatherIntervalMs = () => store.setting('GATHER_EVERY_HOURS') * 3_600_000;
const decksPerDay = () => store.setting('DECKS_PER_DAY');
const deckBacklogMax = () => store.setting('DECK_BACKLOG_MAX');
const runHour = () => store.setting('RUN_HOUR');
const gatherUntilHour = () => store.setting('GATHER_UNTIL_HOUR');

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
      '(IG_USER_ID + IG_ACCESS_TOKEN + CARD_PUBLIC_BASE_URL) and decks go to TikTok through Zernio ' +
      '(ZERNIO_API_KEY + ZERNIO_TIKTOK_ACCOUNT_ID + CARD_PUBLIC_BASE_URL). Set up at least one.\n' +
      'CHANNEL_ID no longer counts: Telegram is where you approve posts, not where they publish.'
  );
  process.exit(1);
}
// Fail closed, exactly as BrickDeal does: with no known owner there is nobody
// to lock the bot to, and this bot can publish. Refusing to start beats
// quietly accepting commands from whoever finds the username.
//
// The website does not change this. Its accounts are a second door onto the same
// actions and they are checked by src/web/auth.js; the Telegram side still answers
// exactly one id, and an install with no OWNER_ID has no Telegram side at all.
if (!OWNER_ID) {
  console.error('Set OWNER_ID in .env (your Telegram user id) so the bot only responds to you.');
  process.exit(1);
}
if (!STAGING_CHAT_ID) {
  console.error(
    'Set STAGING_CHAT_ID in .env — it is where every post is reported in auto mode, and where approvals are sent in manual mode.'
  );
  process.exit(1);
}

// Telegraf times a handler out at 90 seconds by default, and the timeout does
// not merely abandon the handler: it rejects, the rejection reaches
// bot.launch()'s promise, and the catch there exits the process. So a slow
// command was killing the bot.
//
// Every long command answers immediately and does its work as a job (see
// src/ops/jobs.js), which is the actual fix. This raises the ceiling anyway,
// because the next long thing somebody adds should degrade into a late reply
// rather than a restart.
const bot = new Telegraf(TG_BOT_TOKEN, {
  handlerTimeout: Number(process.env.HANDLER_TIMEOUT_MS || 600_000),
});

const staging = STAGING_CHAT_ID;

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

/** Who a Telegram update is, in the shape the audit trail and status lines want. */
const actorOf = (ctx) => ({
  kind: 'telegram',
  id: ctx.from?.id ?? null,
  name: ctx.from?.first_name || ctx.from?.username || null,
});

/** Where a tapped card actually is, which is not always where it was sent. */
const tgOf = (ctx) => ({
  chatId: ctx.chat?.id,
  messageId: ctx.callbackQuery?.message?.message_id,
  isPhoto: Boolean(ctx.callbackQuery?.message?.photo),
  text: ctx.callbackQuery?.message?.text || null,
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function stagingButtons(key, cand) {
  const rows = [
    [Markup.button.callback('✅ אשר ופרסם', `ok:${key}`), Markup.button.callback('❌ דחה', `no:${key}`)],
  ];
  // A new cover, for a deck, without rebuilding one. It costs nothing: the
  // photographs are already paid for and sit in the shot cache, the re-render
  // reuses them, and the only spend is one short model call for the line itself.
  if (cand?.kind === 'deck') {
    rows.push([Markup.button.callback('🔁 שער חדש', `dh:${key}`)]);
  }
  // Only when there is a real choice to make. With one privacy level available
  // a button that cycles back to the same value is a button that lies about
  // having options.
  if (cand?.tiktok?.options?.length > 1) {
    rows.push([Markup.button.callback(`🔒 פרטיות: ${privacyHe(cand.tiktok.privacy)}`, `tp:${key}`)]);
  }
  return Markup.inlineKeyboard(rows);
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
      // A real post through Zernio, with TikTok's own sound on it. A deck of
      // generated photographs still reaches the inbox instead, because it has
      // to be labelled by hand; the card says which, after the build.
      Markup.button.callback('🎵 טיקטוק', `db:${key}:tiktok`),
    ],
    [Markup.button.callback('📸🎵 שניהם', `db:${key}:both`)],
    [Markup.button.callback('🤖 שנה בהוראה', `dr:${key}`), Markup.button.callback('❌ דחה', `dx:${key}`)],
  ]);

// ---------------------------------------------------------------------------
// The Telegram surface
// ---------------------------------------------------------------------------
//
// Registered with src/ops/surface.js so the actions can reach Telegram without
// importing this file — which would be a cycle, since this file imports them.
//
// Everything here is Telegram's half of an action: the card, the album, the edit
// in place, the channel. The decisions are all on the other side.

attachSurface({
  async sendApproval(key, cand) {
    const msg = await sendForApproval(bot.telegram, staging, cand, brickApprovalMessage(cand), stagingButtons(key, cand));
    return {
      chatId: staging,
      messageId: msg.message_id,
      // Which of caption/text the card was sent as, so an edit later reaches the
      // field that actually holds the words. Getting this wrong is a silent
      // no-op: a decided card keeps its live buttons.
      isPhoto: Boolean(msg.photo),
    };
  },

  async rewriteApproval(tg, key, cand) {
    if (!tg?.messageId) return false;
    const edit = tg.isPhoto ? bot.telegram.editMessageCaption : bot.telegram.editMessageText;
    await edit
      .call(bot.telegram, tg.chatId, tg.messageId, undefined, brickApprovalMessage(cand), stagingButtons(key, cand))
      .catch((e) => console.error(`approval UX: rewrite failed: ${e.message}`));
    return true;
  },

  // Rewrite the card in place so a decision is visible at a glance and cannot be
  // double-tapped. Edits whichever of caption/text the message was sent as.
  async settle(tg, statusLine, cand) {
    if (!tg?.messageId) return false;
    const edit = tg.isPhoto ? bot.telegram.editMessageCaption : bot.telegram.editMessageText;
    await edit
      .call(bot.telegram, tg.chatId, tg.messageId, undefined, decidedMessage(statusLine, cand))
      .catch((e) => console.error(`approval UX: edit failed: ${e.message}`));
    // A dedicated call — folding reply_markup into the text edit above isn't
    // reliable for actually clearing the keyboard.
    await bot.telegram.editMessageReplyMarkup(tg.chatId, tg.messageId, undefined, undefined).catch(() => {});
    return true;
  },

  async settleProposal(tg, statusLine) {
    if (!tg?.messageId) return false;
    // The proposal's own text is carried on the coordinates by sendProposal
    // below, so a decision made from the website can strike through the message
    // without losing what it said.
    await bot.telegram
      .editMessageText(tg.chatId, tg.messageId, undefined, [statusLine, '', tg.text || ''].join('\n'))
      .catch(() => {});
    await bot.telegram.editMessageReplyMarkup(tg.chatId, tg.messageId, undefined, undefined).catch(() => {});
    return true;
  },

  async clearButtons(tg) {
    if (!tg?.messageId) return false;
    await bot.telegram.editMessageReplyMarkup(tg.chatId, tg.messageId, undefined, undefined).catch(() => {});
    return true;
  },

  async editText(tg, text) {
    if (!tg?.messageId) return false;
    await bot.telegram.editMessageText(tg.chatId, tg.messageId, undefined, text).catch(() => {});
    return true;
  },

  async remove(tg) {
    if (!tg?.messageId) return false;
    await bot.telegram.deleteMessage(tg.chatId, tg.messageId).catch(() => {});
    return true;
  },

  say: (text) => notify.send(bot.telegram, staging, text),

  async sendProposal(key, text) {
    const msg = await bot.telegram.sendMessage(staging, text, proposalButtons(key));
    return { chatId: staging, messageId: msg.message_id, text };
  },

  publishToChannel: (cand) =>
    cand.kind === 'deck'
      ? publishTelegramDeck(bot.telegram, CHANNEL_ID, cand)
      : publishTelegram(bot.telegram, CHANNEL_ID, cand),
});

// A job that failed used to report itself, because detach() took a chat id and
// every caller had to remember to pass one. Subscribed centrally instead: the
// website's jobs report here too, which is the point — a build somebody started
// in a browser that then failed is exactly the thing the owner should be told
// about without having to be looking at the browser.
subscribe((event) => {
  if (event.type !== 'job:failed') return;
  const where = event.chatId || staging;
  notify
    .send(bot.telegram, where, notify.withDetail(`❌ ${event.job?.label || 'משהו'} נכשל`, event.detail))
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// Buttons on a staged card
// ---------------------------------------------------------------------------

bot.action(/^ok:(.+)$/, async (ctx) => {
  const result = await ops.approve(ctx.match[1], { actor: actorOf(ctx), tg: tgOf(ctx) });
  await ctx.answerCbQuery(result.said);
});

bot.action(/^no:(.+)$/, async (ctx) => {
  const result = await ops.reject(ctx.match[1], { actor: actorOf(ctx), tg: tgOf(ctx) });
  await ctx.answerCbQuery(result.said);
});

bot.action(/^tp:(.+)$/, async (ctx) => {
  const result = await ops.cyclePrivacy(ctx.match[1], { actor: actorOf(ctx), tg: tgOf(ctx) });
  await ctx.answerCbQuery(result.said);
});

bot.action(/^dh:(.+)$/, async (ctx) => {
  const result = ops.newCover(ctx.match[1], { actor: actorOf(ctx) });
  await ctx.answerCbQuery(result.said);
  // The old card cannot stay tappable: approving it would publish the deck the
  // new one replaced, and both carry the same key.
  if (result.ok) await ctx.editMessageReplyMarkup(undefined).catch(() => {});
});

// ---------------------------------------------------------------------------
// Buttons on a proposal
// ---------------------------------------------------------------------------

bot.action(/^db:(.+):(instagram|tiktok|both)$/, async (ctx) => {
  const key = ctx.match[1];
  const choice = ctx.match[2];
  // Instagram first in the pair, because it is the one that publishes by
  // itself - the approval message previews whichever size comes first, and
  // previewing the crop that needs no further action from you is the useful
  // way round.
  const targets = choice === 'both' ? ['instagram', 'tiktok'] : [choice];
  const result = ops.buildProposal(key, { targets, actor: actorOf(ctx) });
  await ctx.answerCbQuery(result.said);
  if (result.ok) await ctx.editMessageReplyMarkup(undefined).catch(() => {});
});

bot.action(/^dx:(.+)$/, async (ctx) => {
  const result = await ops.rejectProposal(ctx.match[1], { actor: actorOf(ctx), tg: tgOf(ctx) });
  await ctx.answerCbQuery(result.said);
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
  // Keyed by the staging key and routed by the PROMPT's message id, never by
  // chat: a single "currently editing" value per chat lets the second of two
  // in-flight edits steal the reply meant for the first.
  store.setPendingEdit(key, {
    kind: 'idea',
    chatId: ctx.chat.id,
    promptMessageId: prompt.message_id,
    proposalMessageId,
  });
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

bot.on('message', async (ctx, next) => {
  // The only thing a reply can be now is an instruction to re-plan a proposal.
  // A deck's title is baked into the cover JPEG, so there is no line to swap —
  // it is re-proposed instead, which costs nothing — and there is nothing to
  // submit by hand because the deals come from the feed rather than from a link.
  const replyToId = ctx.message?.reply_to_message?.message_id;
  const editKey = replyToId ? store.findPendingEditByPrompt(replyToId) : null;
  if (!editKey) return next?.();

  const pending = store.getPendingEdit(editKey);
  if (pending?.kind !== 'idea') {
    store.clearPendingEdit(editKey);
    return ctx.reply('הפריט הזה כבר לא ממתין');
  }

  const said = (ctx.message.text || ctx.message.caption || '').trim();
  if (!said) return ctx.reply('שלח טקסט (לא תמונה/מדבקה)'); // nothing consumed — stays open for a real reply

  const result = ops.reviseProposal(editKey, said, { actor: actorOf(ctx) });
  // Cleared only once the revision has actually been accepted for work. A failed
  // parse leaves the prompt answerable, so replying again retries rather than
  // landing on a dead end.
  if (result.ok) store.clearPendingEdit(editKey);
  await ctx.reply(result.said);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The numeric argument of a command like `/post 2`, or null. */
function argOf(ctx, name) {
  const raw = (ctx.message.text || '').replace(new RegExp(`^/${name}(@\\S+)?\\s*`), '').trim();
  return raw || null;
}

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
      rows.length ? 'אם אין כרטיס בצ׳אט: /resend · או באתר: /site' : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
});

bot.command('resend', async (ctx) => {
  const result = ops.resend({ actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

/**
 * What is waiting, in the order it will go out.
 *
 * The list is numbered because the numbers are what /post takes — printing a
 * list nobody can act on is half a command.
 */
bot.command('queue', (ctx) => {
  const rows = views.queue();
  if (!rows.length) return ctx.reply('📦 התור ריק');

  // Long enough to see the near future, short enough to stay one message. A
  // backlog of thirty is a different problem and /status is where it shows.
  const SHOWN = 12;
  const lines = rows.slice(0, SHOWN).map(
    (c) =>
      `${c.n}. ${c.kind === 'deck' ? '🎞️' : '📰'} ${c.headline}\n   ${targetsHe(c.targets) || 'אין יעד'}${
        c.draft ? ' · טיקטוק כטיוטה (AI)' : ''
      }`
  );

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

bot.command('post', async (ctx) => {
  const arg = argOf(ctx, 'post');
  const n = Number(arg);
  if (!arg || !Number.isInteger(n) || n < 1) {
    return ctx.reply('שימוש: /post 2 — המספר מהרשימה ב-/queue');
  }
  const result = await ops.publishAt(n, { actor: actorOf(ctx) });
  await ctx.reply(result.ok ? `📤 פורסם: ${result.headline}` : `${result.said} — /queue לרשימה`);
});

bot.command('next', async (ctx) => {
  const result = await ops.publishNow({ actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

/**
 * A different photograph for one slide.
 *
 * A command rather than buttons. Five slides would mean five buttons on every
 * approval card for something used occasionally, and this reads the way
 * /draft 2 already does — a number off the list in front of you.
 *
 * THIS ONE COSTS MONEY, which is why it says so in the reply rather than
 * quietly generating. It acts on the newest staged deck and names it, so there
 * is no ambiguity about which card was changed when two are waiting. (The
 * website asks per slide on the card itself, where there is room to be explicit.)
 */
bot.command('photo', async (ctx) => {
  const arg = argOf(ctx, 'photo');
  const n = Number(arg);
  if (!arg || !Number.isInteger(n) || n < 1) {
    return ctx.reply('שימוש: /photo 3 — מספר השקופית (בלי הכריכה), מהכרטיס האחרון');
  }

  const decks = store.stagingItems().filter(({ cand }) => cand.kind === 'deck');
  if (!decks.length) return ctx.reply('אין מצגת שממתינה לאישור');
  // Newest, because this follows looking at a card that just arrived.
  const { key } = decks[decks.length - 1];

  const result = ops.newPhoto(key, n, { actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

bot.command('held', (ctx) => {
  const rows = views.held();
  if (!rows.length) return ctx.reply('✅ אין פוסטים מוחזקים');
  const lines = rows.map(
    (h) => `${h.n}. ${h.headline}\n   חסר: ${targetsHe(h.targets)}${h.error ? `\n   ${h.error}` : ''}`
  );
  ctx.reply([`⏸️ ${rows.length} פוסטים מוחזקים:`, '', ...lines, '', '/retry כדי לנסות שוב · /clear_held כדי לוותר עליהם'].join('\n'));
});

bot.command('retry', async (ctx) => {
  const result = await ops.retryHeld({ actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

bot.command('clear_held', async (ctx) => {
  const result = await ops.clearHeld({ actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

bot.command('clear_pending', (ctx) => ctx.reply(ops.clearPending({ actor: actorOf(ctx) }).said));

// The queue, which /clear_pending does not touch and should not. What is in
// staging you have not answered; what is in the queue you already approved.
bot.command('clear_queue', (ctx) => ctx.reply(ops.clearQueue({ actor: actorOf(ctx) }).said));

bot.command('usage', (ctx) => ctx.reply(usageReport(), { parse_mode: 'Markdown' }));

bot.command('status', async (ctx) => {
  const day = ops.localDay();
  // "Cards that reached you in the last 24 hours", counted from the audit trail.
  //
  // This line reported 0 for as long as it existed. It read an in-memory
  // `activity` array that nothing ever pushed to, so the one number about the
  // last day was always zero and looked like a quiet bot. The trail is persisted,
  // so it also survives the restart that used to reset the count it was reading.
  const dayAgo = Date.now() - 24 * 3_600_000;
  const stagedRecently = store
    .auditTrail({ limit: 500 })
    .filter((a) => a.action === 'staged' && a.ts >= dayAgo).length;

  await ctx.reply(
    notify.statusReport({
      stagingSize: store.stagingSize(),
      proposalSize: store.proposalSize(),
      queueSize: store.queueSize(),
      staged: stagedRecently,
      publishedToday: store.publishedToday(),
      postIntervalMinutes: minutes(),
      stagedToday: store.stagedToday(day) - store.rejectedToday(day),
      rejectedToday: store.rejectedToday(day),
      decksToday: store.decksStartedToday(day),
      decksPerDay: decksPerDay(),
      mode: ops.approvalMode(),
      paused: store.pausedState(),
      heldCount: store.heldCount(),
      targetHealth: Object.fromEntries(liveTargets().map((t) => [t, store.targetHealth(t)])),
      targets: liveTargets(),
    })
  );
});

/**
 * Where the website is, and whether anybody can get in.
 *
 * Worth a command because the panel binds to localhost: the URL is whatever the
 * proxy in front of it publishes, which this process cannot know — so it reports
 * what it CAN know (the bind address, the port, how many accounts exist) and the
 * one thing to do if the answer is zero.
 */
bot.command('site', (ctx) => {
  const n = adminCount();
  ctx.reply(
    [
      '🖥️ אתר הניהול',
      `מאזין על ${process.env.WEB_BIND || '127.0.0.1'}:${process.env.WEB_PORT || 8787}`,
      process.env.WEB_PUBLIC_URL ? `כתובת: ${process.env.WEB_PUBLIC_URL}` : 'הכתובת הציבורית נקבעת ב-Caddy (proxy לכתובת שלמעלה)',
      '',
      n ? `👥 ${n} חשבונות` : '⚠️ אין עוד חשבונות — מהשרת: npm run admin -- add <שם>',
      '',
      'כל מה שיש כאן יש שם, ובנוסף: כל השקופיות זו לצד זו, כל מחיר עם המקור שלו,',
      'עריכת הקופי וההאשטגים, לוח הזמנים, ויומן של מי עשה מה.',
    ].join('\n'),
    { link_preview_options: { is_disabled: true } }
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
 * `/deck` lets the feed choose what to make; `/deck harry-potter`, `/deck 100`,
 * `/deck דירוג` or `/deck בונסאי` names it. A request that parses is honoured
 * and one that does not is interpreted rather than refused - a thin result
 * falls through to whatever the feed can best make rather than answering with
 * a complaint.
 */
bot.command('deck', async (ctx) => {
  // Built and scored in auto mode, proposed in manual mode. See makeDeck.
  const result = ops.makeDeck({ request: argOf(ctx, 'deck'), actor: actorOf(ctx) });
  await ctx.reply(result.said);
});

/**
 * The kill switch. Stops the timer's decks and the drip until /resume, and
 * survives a restart. /deck still builds when asked; what it makes waits.
 */
bot.command('pause', (ctx) => ctx.reply(ops.pause({ actor: actorOf(ctx) }).said));

/**
 * Score against views, for the last 30 posts that reached the feed, and
 * whether the score predicts anything. The verdict line is the point.
 */
bot.command('score', (ctx) => {
  const s = views.scores({ limit: 30 });
  if (!s.posts.length) {
    return ctx.reply(`🧮 עוד אין פוסטים מנוקדים שפורסמו${s.dropped ? ` · ${s.dropped} נפסלו` : ''}`);
  }
  const lines = s.posts.map(
    (p) => `${p.score ?? '—'} → ${p.views == null ? 'עוד לא נמדד' : `${p.views.toLocaleString('en-US')} צפיות`} · ${String(p.hook || p.headline || '').slice(0, 40)}`
  );
  ctx.reply(
    [
      `🧮 ציון מול צפיות · ${s.posts.length} הפוסטים האחרונים (סף ${s.threshold})`,
      '',
      ...lines,
      '',
      s.rho == null ? `ρ: אין מספיק נתונים (${s.n} נמדדו)` : `ρ = ${s.rho.toFixed(2)} על ${s.n} פוסטים שנמדדו`,
      `${s.verdict.state === 'yes' ? '✅' : s.verdict.state === 'no' ? '❌' : '⏳'} ${s.verdict.he}`,
      s.dropped || s.drafts ? `🗑️ ${s.dropped} נפסלו · 📥 ${s.drafts} יצאו כטיוטה` : null,
      s.lastSyncAt ? `📊 צפיות עודכנו לפני ${notify.humanDuration(Date.now() - s.lastSyncAt)}` : '📊 צפיות עוד לא נמשכו',
    ]
      .filter((l) => l !== null)
      .join('\n'),
    { link_preview_options: { is_disabled: true } }
  );
});
bot.command('resume', (ctx) => ctx.reply(ops.resume({ actor: actorOf(ctx) }).said));

bot.command('tiktok', async (ctx) => {
  if (!zernioConfigured()) {
    return ctx.reply('טיקטוק לא מחובר.\nהגדר ZERNIO_API_KEY ו-ZERNIO_TIKTOK_ACCOUNT_ID ב-.env (החשבון עצמו מחובר בלוח של Zernio)');
  }

  const health = store.targetHealth('tiktok');
  const tt = brickConfig().tiktok;

  // Everything knowable without asking anybody comes first, for the same
  // reason /igquota does it: when the API refuses, these are the facts you
  // want next to the refusal.
  const local = [
    `⚙️ פרטיות: ${privacyHe(tt.privacy)} · סאונד: ${tt.autoAddMusic ? 'אוטומטי' : 'כבוי'} · תוכן מסחרי: ${tt.commercialContentType}`,
    `🤖 מצגת עם תמונות AI: ${tt.aiPhotos === 'skip' ? 'לא נשלחת לטיקטוק' : 'טיוטה בתיבה, לסמן ולפרסם ידנית'}`,
    `📊 ${store.tiktokPostsInLast24h()}/${TIKTOK_DAILY_CAP()} פוסטים ב-24 שעות`,
  ];
  if (health.lastOkAt) local.push(`✅ פורסם לאחרונה לפני ${notify.humanDuration(Date.now() - health.lastOkAt)}`);
  else local.push('⚪ עוד לא פורסם לטיקטוק מהמכונה הזו');
  if (health.failures) local.push(`⚠️ ${health.failures} כשלונות ברצף`);

  try {
    const info = await creatorSummary();
    const levels = info.options.map(privacyHe).join(', ') || 'לא התקבלו';
    const allowed = info.options.includes(tt.privacy) ? '' : `\n🔴 ${privacyHe(tt.privacy)} לא מותר לחשבון — כל פרסום ייכשל עד שזה יתוקן`;
    ctx.reply([`🎵 ${info.username || '?'} · דרך Zernio`, `🔒 רמות פרטיות זמינות: ${levels}${allowed}`, ...local].join('\n'));
  } catch (e) {
    ctx.reply([`🔴 ${describeTikTokError(e)}`, '', ...local].join('\n'));
  }
});

/**
 * Per-destination health, and what is holding anything back.
 *
 * /status carries a health line, but it is one line among twenty and it reads as
 * healthy whenever *something* went out. Union of the configured destinations and
 * every destination with a stored record, so one that has been switched off while
 * broken still reports rather than vanishing from the list that would have
 * explained it.
 */
bot.command('health', (ctx) => {
  const rows = views.health();
  const extra = [];
  if (zernioConfigured()) {
    const cap = TIKTOK_DAILY_CAP();
    const used = store.tiktokPostsInLast24h();
    extra.push(`🎵 טיקטוק (Zernio): ${used}/${cap} פוסטים ב-24 שעות האחרונות`);
    if (used >= cap) {
      const freesAt = store.tiktokCapFreesAt();
      if (freesAt) extra.push(`   המכסה מתפנה בעוד ${notify.humanDuration(Math.max(0, freesAt - Date.now()))}`);
    }
  }
  if (store.heldCount()) extra.push(`📥 ${store.heldCount()} פוסטים מוחזקים · /held · /retry`);
  if (store.queueSize()) extra.push(`📦 ${store.queueSize()} בתור`);
  const busy = jobs.running();
  if (busy) extra.push(`⚙️ ${busy} עבודות רצות עכשיו`);

  ctx.reply(notify.healthReport(rows, extra));
});

bot.command('help', (ctx) =>
  ctx.reply(
    [
      'פקודות:',
      '/deck — מצגת מהדילים שיש עכשיו (במצב אוטומטי: נבנית, מנוקדת ומתפרסמת או נפסלת)',
      '/deck harry-potter — מצגת על נושא מסוים',
      '/deck 100 — מצגת של סטים עד 100 ₪',
      '/deck אגורות — מצגת לפי מחיר לחלק (או "/deck 8 אגורות")',
      '/deck דירוג — הסטים שהכי חוסכים, ממקום 8 עד מקום 1 (או "/deck דירוג רכבים")',
      '/deck בונסאי — מצגת על סט מסוים',
      '',
      '/score — ציון מול צפיות ב-30 הפוסטים האחרונים, והאם הציון מנבא משהו',
      '/pause — עוצר הכל: לא נבנה ולא מתפרסם כלום אוטומטית',
      '/resume — ממשיך',
      '',
      '/site — כתובת אתר הניהול ומצב החשבונות',
      '/status — סטטוס מלא',
      '/health — בריאות כל יעד בנפרד, והשגיאה האחרונה',
      '/usage — טוקנים ועלות',
      '/pending — הצעות ומצגות שממתינות לך',
      '/resend — שולח שוב את כרטיסי האישור (אם לא הגיעו)',
      '/queue — מה בתור, לפי הסדר, ממוספר',
      '/next — מפרסם את הבא בתור',
      '/post <מספר> — מפרסם אחד מסוים מהתור, מדלג על הסדר',
      '/photo <מספר> — תמונה חדשה לשקופית מסוימת (עולה קריאה למודל)',
      '/held — מצגות מאושרות שממתינות ליעד שנפל',
      '/retry — אחרי שתיקנת: מחזיר אותן לתור',
      '/clear_held — מוותר על המוחזקות ומסמן את היעדים כתקינים',
      '/clear_pending — מנקה הצעות ומצגות שממתינות לאישור',
      '/clear_queue — מרוקן את התור (פוסטים שכבר אושרו)',
      '',
      '/igquota — מכסת אינסטגרם',
      '/tiktok — טיקטוק דרך Zernio: החשבון, רמות הפרטיות והמכסה',
      '',
      'תשובה להצעה משנה אותה: כתוב נושא, מחיר או שם של סט.',
      'לוח הזמנים והקופי נערכים באתר — /site',
    ].join('\n')
  )
);

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

let lastRunDay = null;
let quietAlertSent = false;
// The fallback anchor for the quiet alarm. An install that has never staged or
// published anything has no timestamp to measure from, and "no timestamp" must
// not read as "not quiet" — that is the state a brand new silence starts in.
const bootedAt = Date.now();

/**
 * How many decks the schedule may start in a day.
 *
 * Capped two ways. DECKS_PER_DAY is the day's budget, and a ceiling on the
 * backlog stops them accumulating: unanswered proposals in manual mode, or
 * scored decks waiting in the queue in auto mode. Three waiting is a signal to
 * stop making them, not to make a fourth.
 *
 * The count is in the store now. It was a variable here, which every restart
 * reset to zero, and in auto mode a deck started is a deck that may post.
 */
let lastDeckSuggestAt = 0;
// Said once per breakage, not once a minute.
let configBroken = false;
// When the drip last fired. The drip used to be its own setInterval, which meant
// POST_INTERVAL_MINUTES was captured at boot and a change to it did nothing until
// a restart. Measured against the clock inside the one-minute tick instead, so the
// dial is live — at the cost of up to a minute of granularity on a value whose
// smallest setting is five.
let lastDripAt = Date.now();

function quietCheck() {
  const hours = store.setting('QUIET_ALERT_HOURS');
  const limitMs = hours * 3_600_000;

  const stagedAt = store.lastStagedAt();
  const stagedAgo = Date.now() - (stagedAt ?? bootedAt);

  // A destination with no success on record has never worked on this install, so
  // it measures from boot rather than opting out — never-worked is the loudest
  // case, not an exemption.
  //
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
  const day = ops.localDay(now);
  const hour = now.getHours();

  const inHours = hour >= runHour() && hour < gatherUntilHour();

  // The token refresh used to ride along with the daily gather, which is where
  // it lived because a gather happened every day. There is no gather now, so it
  // gets its own day-change check - otherwise the Instagram token quietly
  // stopped being refreshed the moment the card path came out.
  if (day !== lastRunDay) {
    lastRunDay = day;
    refreshToken().catch(() => {});
    // Once a day, views for every scored post, so /score has something to
    // check the scorer against. Reads only, so the pause does not stop it.
    if (zernioConfigured()) ops.syncViews({ actor: { kind: 'timer' } });
  }

  // The kill switch. Nothing below runs while it is on: no deck is started and
  // nothing is published. The token refresh above and the quiet alarm below
  // still run, because neither of them posts anything.
  const paused = store.pausedState();

  // Decks through the day, in waking hours, spaced by the gather interval so
  // they arrive through the day rather than three at once at 08:00. In manual
  // mode that is a free proposal waiting for a tap; in auto mode it is a deck
  // built, scored, and queued or dropped.
  // A config that does not load means no deck can be built, but it must not
  // take the drip and the quiet alarm down with it: every tick would throw
  // here, and the uncaught-exception handler would keep a process alive that
  // had quietly stopped posting.
  let mode = null;
  try {
    mode = ops.approvalMode();
  } catch (e) {
    if (!configBroken) console.error(`deck timer: brick-config.json does not load, no decks until it does — ${e.message}`);
    configBroken = true;
  }
  if (mode) configBroken = false;
  const auto = mode !== 'manual';
  const backlog = auto ? store.queueSize() : store.proposalSize();
  if (
    mode &&
    !paused &&
    inHours &&
    decksPerDay() > 0 &&
    store.decksStartedToday(day) < decksPerDay() &&
    backlog < deckBacklogMax() &&
    !(auto && ops.autoBusy()) &&
    Date.now() - lastDeckSuggestAt >= gatherIntervalMs()
  ) {
    lastDeckSuggestAt = Date.now();
    store.noteDeckStarted(day);
    // `timer` rather than a person, so the audit trail distinguishes a deck
    // the schedule made from one somebody asked for.
    ops.makeDeck({ actor: { kind: 'timer' }, reason: 'timer' });
  }

  // The drip, never sooner than POST_INTERVAL_MINUTES after the last post as
  // well as after the last attempt. A post somebody pushed out by hand with
  // /next resets the clock for the automatic one behind it, so the feed never
  // gets two posts closer together than the interval without a person having
  // decided it.
  if (ops.dripDue({ lastDripAt, lastPublishedAt: store.lastPublishedAt(), intervalMs: intervalMs(), paused })) {
    lastDripAt = Date.now();
    publishNext().catch((e) => console.error('publish error:', e.message));
  }

  quietCheck();
}

// ---------------------------------------------------------------------------

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
  if (zernioConfigured()) {
    const tt = brickConfig().tiktok;
    console.log(
      `   tiktok: via Zernio · ${tt.privacy} · music ${tt.autoAddMusic ? 'on' : 'off'} · ` +
        `commercial ${tt.commercialContentType} · AI-photo decks: ${tt.aiPhotos === 'skip' ? 'kept off TikTok' : 'inbox draft'}`
    );
    // Said, not fixed. TikTok allows only its Commercial Music Library on a post
    // that discloses commercial content, so auto-added music attaches nothing
    // and every post goes out silent. Changing either value here would be
    // deciding a disclosure question for the owner.
    if (tt.autoAddMusic && tt.commercialContentType !== 'none') {
      console.warn(
        `   tiktok: ⚠️  commercialContentType is "${tt.commercialContentType}" and autoAddMusic is on — ` +
          'TikTok attaches no auto-added music to a post with a commercial disclosure, so posts will be silent'
      );
    }
  }
  console.log(
    ops.approvalMode() === 'manual'
      ? '   telegram: approval only — nothing publishes to a channel'
      : '   mode: AUTO — decks are scored and posted with no tap; telegram gets one line per post'
  );
  if (store.pausedState()) console.log(`   ⏸️  PAUSED since ${new Date(store.pausedState().at).toISOString()} — /resume`);
  console.log(
    `   photographs: ${
      imagesEnabled() ? 'generated at home-shot quality' : 'NOT configured — slides fall back to catalogue images'
    }`
  );

  // The admin panel, and TikTok's browser connect on the same port. In this
  // process rather than a service of its own for the reason src/store.js spells
  // out: two processes holding this document would silently roll each other back.
  startWebServer();

  console.log(
    `   proposals ${decksPerDay()}/day between ${runHour()}:00 and ${gatherUntilHour()}:00 · drip every ${minutes()} min`
  );

  // The refresh is "maybe" by nature — it returns early unless the token is
  // close enough to lapsing to be worth a call — so there is nothing to decide
  // here beyond letting it fail quietly.
  //
  // And they must fail quietly. main() rejecting exits the process, pm2 starts
  // it again, and a refresh is a network call: one unreachable API at boot
  // would otherwise become a restart loop on a bot that had nothing wrong with
  // it. Whatever does not refresh now is retried at the next day change.
  await refreshToken().catch((e) => console.error('instagram token refresh at boot:', e.message));
  await probeInstagram();

  setInterval(tick, 60_000);

  await notify.send(
    bot.telegram,
    staging,
    [
      notify.startupPing({
        queueSize: store.queueSize(),
        stagingSize: store.stagingSize(),
        proposalSize: store.proposalSize(),
        targets: liveTargets(),
        images: imagesEnabled(),
      }),
      `${ops.approvalMode() === 'manual' ? '✋ ידני — כל פוסט מחכה לאישור' : '🤖 אוטומטי — מנקד ומפרסם בלי אישור'}${
        store.pausedState() ? ' · ⏸️ מושהה (/resume)' : ''
      }`,
      // Said at boot rather than only on /site, because an install with no
      // accounts has a panel nobody can reach and no other moment where that
      // becomes apparent.
      adminCount() ? `🖥️ אתר הניהול: ${adminCount()} חשבונות · /site` : '🖥️ אתר הניהול פעיל אבל אין חשבונות — npm run admin -- add <שם>',
    ].join('\n')
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const shutdown = async (sig) => {
  // Release the port before anything slower. pm2 restart sends SIGTERM and then
  // starts the replacement; a socket still held here greets the new process
  // with EADDRINUSE, and the panel would be the one thing that did not come back
  // from a routine restart.
  await stopWebServer();
  await closeBrowser();
  bot.stop(sig);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
