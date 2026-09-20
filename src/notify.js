import { reasonHe } from './verify.js';
import { pillarHe, PILLAR_KEYS, quotaConfig } from './pillars.js';
import { TARGET_HE, targetsHe } from './publish/targets.js';

// The Hebrew status messages, as pure formatters plus one thin `send` — same
// split BrickDeal uses, for the same reason: the strings can be built and
// eyeballed in a plain script without booting the bot.
//
// No parse_mode anywhere. These embed scraped titles and source URLs, and a
// stray `*` or `_` in either would break Telegram's Markdown parser and drop
// the message entirely. Not asking for Markdown can't fail.

export async function send(telegram, chatId, text) {
  if (!chatId) return null;
  return telegram
    .sendMessage(chatId, text, { link_preview_options: { is_disabled: true } })
    .catch((e) => {
      console.error('notify: send failed:', e.message);
      return null;
    });
}

export function startupPing({ sourceCount, queueSize, stagingSize, targets, images }) {
  return [
    '🟢 tiyul+ עלה',
    `${sourceCount} מקורות פעילים · ${stagingSize} ממתינים לאישור · ${queueSize} בתור לפרסום`,
    `מפרסם ל: ${targetsHe(targets)}`,
    `תמונות: ${images ? 'זמינות' : 'כרטיסי טקסט בלבד'}`,
  ].join('\n');
}

/** After a daily gather run — what came in, what survived, what was dropped. */
export function runReport({
  gathered,
  ranked,
  staged,
  rejected,
  sourceErrors,
  perSource,
  draftCalls,
  budgetExhausted,
}) {
  const lines = [
    '📥 סבב איסוף הסתיים',
    `${gathered} פריטים נאספו · ${ranked} נבדקו · ${staged} עלו לאישור · ${rejected} נפסלו`,
  ];

  if (draftCalls) lines.push(`✍️ ${draftCalls} קריאות כתיבה`);

  // A run that ran out of budget looks exactly like a quiet news day unless it
  // says so. The difference matters: one means there was nothing to post, the
  // other means we stopped looking.
  if (budgetExhausted) {
    lines.push('⚠️ תקציב הקריאות נגמר לפני שהושלם היעד - ייתכן שנשארו פריטים טובים');
  }

  const bySource = Object.entries(perSource || {})
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `   • ${id}: ${n}`);
  if (bySource.length) lines.push('', 'לפי מקור:', ...bySource);

  if (sourceErrors?.length) {
    lines.push('', '⚠️ מקורות שנכשלו:');
    for (const e of sourceErrors) lines.push(`   • ${e.name}: ${e.message}`);
  }

  return lines.join('\n');
}

/**
 * Rejected candidates, with their reason and their URL.
 *
 * This exists because of the note in BrickDeal's own README: its quality filter
 * used to drop things silently, which made it impossible to tell whether it was
 * saving you from junk or quietly throwing away good posts. The filters here are
 * more opinionated than that one — a primary-source rule, a quote check, topic
 * quotas — so seeing what they killed matters more, not less.
 */
export function rejectDigest(items, hours) {
  if (!items.length) return null;
  const lines = items.map((it, i) => {
    const detail = it.detail ? ` — ${String(it.detail).slice(0, 160)}` : '';
    return `${i + 1}. [${reasonHe(it.reason)}] ${it.title}${detail}\n   ${it.url}`;
  });
  return `🗑️ ${items.length} מועמדים נפסלו ב-${hours} השעות האחרונות:\n\n${lines.join('\n\n')}`;
}

export function rejectSingle(item) {
  const detail = item.detail ? ` — ${String(item.detail).slice(0, 200)}` : '';
  return `🗑️ נפסל [${reasonHe(item.reason)}] ${item.title}${detail}\n${item.url}`;
}

/** Everything this card owed has now gone out. */
/**
 * A destination was given up on for this card alone.
 *
 * Deliberately not phrased as a failure, because nothing is wrong with the
 * destination and nothing will be retried. The card carries something that
 * destination cannot accept — most often a TikTok privacy level that was never
 * attached, on a card approved while TikTok was unreachable — and the honest
 * report is that this one copy will not be made.
 */
export function targetAbandoned(headline, abandoned = []) {
  return [
    `⤫ ויתרנו על ${targetsHe(abandoned.map((a) => a.target))} לפוסט הזה`,
    headline,
    ...abandoned.map((a) => `   ${TARGET_HE[a.target] || a.target}: ${a.message}`),
    'לא ינוסה שוב - הבעיה בפוסט עצמו, לא ביעד. שאר היעדים לא נפגעו.',
  ].join('\n');
}

export function published({ headline, succeeded, failed = [] }) {
  const lines = [`📤 פורסם ל${targetsHe(succeeded)}`, headline];
  for (const f of failed) {
    lines.push(`⚠️ ${TARGET_HE[f.target] || f.target} נכשל: ${f.message}`);
  }
  return lines.join('\n');
}

/**
 * A destination still owes this card, and it is going back on the queue for that
 * destination only.
 *
 * `succeeded` is listed explicitly so a partial publish reads as partial. The
 * old message said "nothing published" whenever it retried, which was true then
 * and is not now: the retry is per destination, so half of it may well be live.
 */
export function publishRetrying(headline, failed, attempt, max, succeeded = []) {
  const lines = [
    succeeded.length
      ? `🔁 פורסם ל${targetsHe(succeeded)} · חוזר לתור עבור השאר (ניסיון ${attempt}/${max})`
      : `🔁 שום דבר לא פורסם — חזר לתור (ניסיון ${attempt}/${max})`,
    headline,
  ];
  for (const f of failed) lines.push(`   ${TARGET_HE[f.target] || f.target}: ${f.message}`);
  lines.push('ינוסה שוב רק ליעד שנכשל — מה שכבר עלה לא ישוכפל.');
  return lines.join('\n');
}

/**
 * Set aside rather than dropped.
 *
 * The version this replaces dropped the card and told you to resend the link by
 * hand. With a destination blocked for days that is a backlog thrown away one
 * post at a time.
 */
export function publishHeld(headline, owed, succeeded = [], heldCount = 1) {
  const lines = [`⏸️ מוחזק עד שי${targetsHe(owed)} יחזור לעבוד`, headline];
  if (succeeded.length) lines.push(`✅ כבר פורסם ל${targetsHe(succeeded)} — לא ישוכפל`);
  lines.push(`📥 ${heldCount} מוחזקים בסך הכל · /held לרשימה · /retry לנסות שוב`);
  return lines.join('\n');
}

/**
 * A platform said "not now", and it meant it.
 *
 * Deliberately not the same message as a failure or a hold. TikTok allows an
 * unaudited client five posts a day; the sixth is refused, and that is the
 * platform working as documented rather than anything being wrong. Saying so in
 * the vocabulary of an outage would train you to ignore the word "failed" on
 * the day it means something.
 *
 * It says when the slot frees, because the only question worth answering here
 * is "so when does it go out".
 */
export function platformLimited(headline, limited = [], freesAt = null) {
  const lines = [`⏳ ${targetsHe(limited.map((l) => l.target))} — מגבלת פלטפורמה, הפוסט ממתין`, headline];
  for (const l of limited) lines.push(`   ${TARGET_HE[l.target] || l.target}: ${l.message}`);
  if (freesAt) {
    lines.push(`🕒 המכסה מתפנה בעוד ${humanDuration(Math.max(0, freesAt - Date.now()))}`);
  }
  lines.push('זו מגבלה של הפלטפורמה, לא תקלה — לא עוקפים אותה. הפוסט יישלח כשהמכסה תתפנה.');
  return lines.join('\n');
}

/**
 * Per-destination health, on demand.
 *
 * The one report that answers "is it working" for each destination separately.
 * A global "something published recently" reads as healthy while one
 * destination has been dark for a week, which is exactly how TikTok managed to
 * never once succeed without that being the headline anywhere.
 */
export function healthReport(rows = [], extra = []) {
  const lines = ['🩺 בריאות היעדים', ''];
  if (!rows.length) lines.push('אין יעדים מוגדרים.');

  for (const r of rows) {
    const name = TARGET_HE[r.target] || r.target;
    if (r.degraded) {
      lines.push(`🔴 ${name} — מושבת אחרי ${r.failures} כשלונות ברצף`);
      if (r.recoveryDueAt) {
        const left = r.recoveryDueAt - Date.now();
        lines.push(
          left > 0
            ? `   בדיקה חוזרת אוטומטית בעוד ${humanDuration(left)}`
            : '   מוכן לבדיקה חוזרת — הפוסט הבא ינסה'
        );
      }
    } else if (r.failures > 0) {
      lines.push(`🟡 ${name} — ${r.failures} כשלונות ברצף, עדיין מנסה`);
    } else {
      lines.push(`🟢 ${name} — תקין`);
    }

    lines.push(
      r.lastOkAt
        ? `   ✅ פורסם לאחרונה לפני ${humanDuration(Date.now() - r.lastOkAt)}`
        : '   ⚠️ מעולם לא פורסם בהצלחה'
    );
    if (r.lastError) lines.push(`   ⛔ ${r.lastError}`);
  }

  if (extra.length) lines.push('', ...extra);
  return lines.join('\n');
}

/**
 * The owner asked for something the bot would normally refuse.
 *
 * Every guard that was stepped over, named, before the post goes out. The point
 * is not permission — the owner already has that — it is that a repeat should
 * be a decision rather than something noticed three posts later. So this is
 * sent even when it is obvious, and it names the guard and the measurement that
 * tripped it rather than saying "overridden".
 */
export function overrideNotice(headline, overrides = []) {
  if (!overrides.length) return null;
  const lines = ['🔓 עקיפת בקרות (בקשת בעלים)', headline, ''];
  for (const o of overrides) lines.push(`   • ${o}`);
  lines.push('', 'מגבלות הפלטפורמה עצמן לא נעקפות.');
  return lines.join('\n');
}

/**
 * A destination has failed enough times running to be called broken.
 *
 * Fired on the edge — the failure that tips it over — not on every card, because
 * the whole failure this comes from is an alert that repeated until it read as
 * routine. This one names the destination, how long it has been down, and the
 * diagnostic the Graph message on its own does not carry.
 */
export function targetDegraded(target, health, detail) {
  const name = TARGET_HE[target] || target;
  const lines = [
    `🔴 ${name} נכשל ${health.failures} פעמים ברצף — מפסיק לנסות`,
    detail ? `   ${detail}` : '',
    health.lastOkAt
      ? `📆 פורסם שם לאחרונה לפני ${humanDuration(Date.now() - health.lastOkAt)}`
      : '📆 מעולם לא פורסם שם בהצלחה',
    '',
    'פוסטים מאושרים יוחזקו ולא יאבדו.',
    'אחרי שהתקלה נפתרת: /retry',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * The alarm for "a day has gone by and nothing came out".
 *
 * It watches two streams, not one. The old version watched only staging, which
 * left the failure people actually notice — no posts — with no alarm at all:
 * cards can arrive on schedule every day and still publish nothing, because
 * nothing publishes without an approval tap.
 *
 * They are reported separately because they have different fixes, and the last
 * line says which one this is. A quiet stream with cards waiting is a tap that
 * never came; a quiet stream with an empty queue is the pipeline going dry.
 */
/** The boot probe found a destination already broken. */
export function targetUnreachableAtBoot(target, detail) {
  const name = TARGET_HE[target] || target;
  return [
    `🔴 ${name} לא זמין כרגע`,
    `   ${detail}`,
    '',
    'פוסטים מאושרים יוחזקו ולא יאבדו. אחרי שהתקלה נפתרת: /retry',
  ].join('\n');
}

export function quietAlert({
  hours,
  stagedHoursAgo,
  everStaged,
  darkTargets = [],
  stagingSize = 0,
  queueSize = 0,
  heldCount = 0,
}) {
  const lines = [`⚠️ שקט כבר יותר מ-${hours} שעות`];

  if (stagedHoursAgo >= hours) {
    lines.push(
      everStaged
        ? `🗂️ לא עלה מועמד חדש לאישור כבר ${stagedHoursAgo} שעות`
        : '🗂️ שום מועמד לא עלה לאישור מאז שהבוט עלה'
    );
  }

  // Per destination, because they fail independently. Watching a single global
  // "did anything publish" meant Telegram succeeding every day kept this quiet
  // while the Instagram account was dark — which is exactly the outage that
  // prompted this alarm to be rewritten in the first place.
  for (const t of darkTargets) {
    const name = TARGET_HE[t.target] || t.target;
    lines.push(
      t.ever
        ? `📤 שום דבר לא פורסם ל${name} כבר ${t.hoursAgo} שעות`
        : `📤 מעולם לא פורסם ל${name}`
    );
  }

  if (heldCount) lines.push(`👉 ${heldCount} פוסטים מאושרים מוחזקים — /held, ואחרי תיקון /retry`);
  else if (stagingSize) lines.push(`👉 ${stagingSize} כרטיסים ממתינים לאישור שלך — אשר או דחה`);
  else if (queueSize) lines.push(`👉 ${queueSize} מאושרים בתור אבל לא יוצאים — בדוק את הפרסום`);
  else lines.push('👉 אין כלום ממתין ואין כלום בתור — /status או /run');

  return lines.join('\n');
}

// "3 שעות ו-14 דק'" / "14 דק'" — enough precision for a status readout.
export function humanDuration(ms) {
  if (ms == null) return null;
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} שעות ו-${m} דק'` : `${m} דק'`;
}

/** /status — a fixed last-24h window, so it answers "why nothing today". */
export function statusReport({
  stagedToday,
  rejectedToday = 0,
  remainingToday,
  dailyTarget: target,
  nextGatherInMin,
  sourceCount,
  stagingSize,
  queueSize,
  gathered,
  staged,
  rejected,
  rejectedByReason,
  publishedToday,
  lastRunAgoMs,
  postIntervalMinutes,
  targets,
  heldCount = 0,
  targetHealth = {},
}) {
  const breakdown = Object.entries(rejectedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `   • ${reasonHe(reason)} (${reason}): ${n}`);

  return [
    '🔎 סטטוס',
    `📚 ${sourceCount} מקורות פעילים`,
    `⏳ ${stagingSize} ממתינים לאישור · 📦 ${queueSize} בתור לפרסום`,
    `📤 ${publishedToday} פורסמו היום`,
    '',
    'ב-24 השעות האחרונות:',
    `👀 נאספו: ${gathered}`,
    `✅ עלו לאישור: ${staged}`,
    `🗑️ נפסלו: ${rejected}`,
    ...breakdown,
    '',
    `⏱️ סבב אחרון: ${lastRunAgoMs == null ? 'עדיין לא רץ' : `לפני ${humanDuration(lastRunAgoMs)}`}`,
    // The two questions "why is it quiet" actually splits into: have we already
    // filled today's quota, and when does it next look? Both, in one line.
    `🎯 עלו היום: ${stagedToday ?? 0}/${target ?? '?'}` +
      (rejectedToday ? ` (${rejectedToday} נדחו והוחזרו למכסה)` : '') +
      (remainingToday <= 0 ? ' (הושלמה המכסה היומית)' : ` · סבב הבא בעוד ${nextGatherInMin ?? '?'} דק'`),
    `⚙️ דריפ כל ${postIntervalMinutes} דק' · מפרסם ל${targetsHe(targets)}`,
    // Per destination, because "published today" hides the case that matters:
    // one destination working and another blocked.
    ...targets.map((t) => {
      const h = targetHealth[t] || {};
      const name = TARGET_HE[t] || t;
      if (h.degraded) return `   🔴 ${name}: מושבת אחרי ${h.failures} כשלונות · ${h.lastError || ''}`.trim();
      if (h.lastOkAt) return `   ✅ ${name}: לפני ${humanDuration(Date.now() - h.lastOkAt)}`;
      return `   ⚪ ${name}: עוד לא פורסם`;
    }),
    ...(heldCount ? [`⏸️ ${heldCount} מוחזקים — /held`] : []),
  ].join('\n');
}

/** /mix — the pillar and tag balance the quotas are actually computed from. */
export function mixReport(history) {
  if (!history.length) return '📊 עדיין לא פורסם כלום — אין ממה לחשב תמהיל';

  const total = history.length;
  const counts = Object.fromEntries(PILLAR_KEYS.map((k) => [k, 0]));
  for (const p of history) if (counts[p.pillar] !== undefined) counts[p.pillar]++;

  const rows = PILLAR_KEYS.map((k) => {
    const n = counts[k];
    const pct = Math.round((n / total) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) || '·';
    return `${pillarHe(k).padEnd(14)} ${String(pct).padStart(3)}%  ${bar}`;
  });

  const kosher = history.filter((p) => (p.tags || []).includes('kosher')).length;
  const kosherPct = Math.round((kosher / total) * 100);
  const { kosherMaxShare, pillarMaxShare } = quotaConfig();

  return [
    `📊 תמהיל ${total} הפוסטים האחרונים`,
    '',
    ...rows,
    '',
    `כשרות/שבת: ${kosherPct}% (תקרה ${Math.round(kosherMaxShare * 100)}%)`,
    `תקרה לנושא בודד: ${Math.round(pillarMaxShare * 100)}%`,
  ].join('\n');
}
