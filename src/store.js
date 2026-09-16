import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same tiny persistent store as BrickDeal: one JSON file, written atomically
// (tmp + rename), no database. Single process, a handful of posts a day.
//
// One collection is new here: `published`. The pillar quotas (src/pillars.js)
// are computed over a rolling window of what actually went out, so "kosher and
// Shabbat is an occasional thread, not the theme" is a number the code can
// check rather than a hope about the drafting prompt.
// Overridable so the test suite can point at a scratch file.
//
// This is not a convenience. On the VPS this file holds the refreshed Instagram
// token, the dedupe history and the published log — and merely importing this
// module prunes and rewrites it. `npm test` on the server would therefore touch
// live state, and the new dedupe test writes to it outright. Tests get their
// own file; nothing else sets this.
const FILE = process.env.STORE_PATH
  ? resolve(process.env.STORE_PATH)
  : fileURLToPath(new URL('../data/store.json', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
// Read lazily rather than at module load — store.js can be evaluated before
// .env has been read. Same hoisting trap BrickDeal's deals.js documents.
const ttlMs = () => Math.max(0, Number(process.env.SEEN_TTL_DAYS ?? '45')) * DAY_MS;
const publishedWindowMs = () =>
  Math.max(1, Number(process.env.QUOTA_WINDOW_DAYS ?? '30')) * DAY_MS;

const empty = {
  seen: {},
  queue: [],
  staging: {},
  pendingEdit: {},
  published: [],
  // Ids of everything ever published, kept separately from `published`.
  //
  // `published` is a 30-day quota window and gets pruned, so it cannot answer
  // "have we posted this before?" — after a month it says no. And `seen` cannot
  // answer it either, because /redo deliberately clears `seen` so a change to
  // the copy rules can be tested against the same sources. That left nothing
  // guarding the case that actually happened: an item published to Instagram,
  // then staged again by the next /redo as though it were new.
  publishedIds: {},
  // { date: 'YYYY-MM-DD', count: n, rejected: n } — the daily cap, survives restart.
  stagedDay: null,
  // When a card last reached the approval chat, and when something last went
  // out. Both are what the quiet alarm measures from, and both have to outlive
  // the process: held only in memory, a bot that restarts once a day can never
  // accumulate enough silence to notice it is silent.
  lastStagedAt: null,
  lastPublishedAt: null,
  // Per destination: consecutive failures, the last error, and when it last
  // actually worked. A global "something published" is not enough — Telegram
  // succeeding while Instagram is blocked looks identical to a healthy day.
  // { instagram: { failures, lastError, lastFailAt, lastOkAt, degraded } }
  targetHealth: {},
  // Approved cards that could not reach a destination and are waiting for it to
  // come back, rather than being dropped. /retry replays them.
  held: [],
  igToken: null,
};

// How long a published id is remembered. Long, because the cost of forgetting
// is posting the same thing twice to real followers, and the cost of
// remembering is a few hundred bytes a year.
const PUBLISHED_ID_TTL_MS = Math.max(1, Number(process.env.PUBLISHED_TTL_DAYS ?? '730')) * 86_400_000;
let state = load();

function pruneSeen(s) {
  const cutoff = Date.now() - ttlMs();
  let changed = false;
  for (const [id, ts] of Object.entries(s.seen)) {
    if (ts < cutoff) {
      delete s.seen[id];
      changed = true;
    }
  }
  return changed;
}

// The published log only exists to answer quota questions over a rolling
// window, so anything older than that window is dead weight.
function prunePublished(s) {
  const cutoff = Date.now() - publishedWindowMs();
  const before = s.published.length;
  s.published = s.published.filter((p) => p.ts >= cutoff);
  return s.published.length !== before;
}

function prunePublishedIds(s) {
  const cutoff = Date.now() - PUBLISHED_ID_TTL_MS;
  let changed = false;
  for (const [id, ts] of Object.entries(s.publishedIds || {})) {
    if (ts < cutoff) {
      delete s.publishedIds[id];
      changed = true;
    }
  }
  return changed;
}

function load() {
  let s;
  try {
    s = { ...empty, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    s = structuredClone(empty);
  }
  if (!Array.isArray(s.published)) s.published = [];
  if (!Array.isArray(s.held)) s.held = [];
  if (!s.targetHealth || typeof s.targetHealth !== 'object') s.targetHealth = {};

  // Migration for stores written before publishedIds existed. Backfill from the
  // quota window — it is the only record of what went out, and recovering the
  // last 30 days is strictly better than starting empty and re-posting them.
  let migrated = false;
  if (!s.publishedIds || typeof s.publishedIds !== 'object') {
    s.publishedIds = {};
    migrated = true;
  }
  for (const p of s.published) {
    if (p?.id && !s.publishedIds[p.id]) {
      s.publishedIds[p.id] = p.ts || Date.now();
      migrated = true;
    }
  }

  // Same idea for the quiet alarm's anchor: the published log already knows when
  // the last post went out, so a store written before this field existed starts
  // with the real answer rather than looking like it has never published.
  if (!s.lastPublishedAt && s.published.length) {
    s.lastPublishedAt = Math.max(...s.published.map((p) => p.ts || 0)) || null;
    migrated = Boolean(s.lastPublishedAt) || migrated;
  }

  const changed = pruneSeen(s) || prunePublished(s) || prunePublishedIds(s) || migrated;
  if (changed) save(s);
  return s;
}

function save(s = state) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {}
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, FILE);
}

// --- dedupe -----------------------------------------------------------------
// Keyed by a candidate's stable id (src/candidate.js derives it from the
// canonical source URL). TTL defaults to 45 days here rather than BrickDeal's
// 10: a deal's price moves, but "the Alhambra caps daily tickets" doesn't
// become news again in a fortnight.
export const hasSeen = (id) => {
  const ts = state.seen[id];
  return Boolean(ts) && Date.now() - ts < ttlMs();
};
export function markSeen(id) {
  state.seen[id] = Date.now();
  pruneSeen(state);
  save();
}
// Roll back a claim when the pipeline fails *after* claiming it, so a transient
// error doesn't permanently bury a source item that would otherwise be fine.
export function forgetSeen(id) {
  delete state.seen[id];
  save();
}

/**
 * Forget every claimed item, so the next run rebuilds today's candidates from
 * scratch. Returns how many were dropped.
 *
 * This is for iterating on how the cards look and read: a change to the layout
 * or the copy rules is invisible until the same sources are drafted again, and
 * they are all marked seen the moment the first run claims them. Without this
 * the only way to see the effect of a change was to wait for tomorrow's news.
 *
 * Deliberately touches `seen` and nothing else. The published log stays (the
 * topic quotas are computed from it) and so does the Instagram token, which
 * lives in the same file and is expensive to replace — deleting store.json to
 * get the same effect would take both with it.
 */
export function forgetAllSeen() {
  const n = Object.keys(state.seen).length;
  state.seen = {};
  save();
  return n;
}

/**
 * Has this exact item already gone out?
 *
 * Checked independently of `seen`, and never cleared by /redo. The two answer
 * different questions: `seen` is "have we already tried this today", which is
 * the thing you WANT to reset when testing a change to the copy rules;
 * this is "did real followers already receive this", which you never do.
 *
 * Missing this distinction put an iceberg post that had already published to
 * Instagram straight back into the approval queue with a different photograph.
 */
export const hasPublished = (id) => Boolean(id && state.publishedIds[id]);

/** Deliberately allow a published item to be built again. */
export function forgetPublished(id) {
  delete state.publishedIds[id];
  save();
}
export const publishedCount = () => Object.keys(state.publishedIds).length;

// --- how many were staged today --------------------------------------------
//
// The gather used to run once a day, so "the best two or three a day" was a
// property of running once. Now it runs through the day, which is what you want
// when a source publishes at 14:00 and the morning pass has already been and
// gone — but it means the daily cap has to be counted rather than assumed.
//
// Persisted, so a restart cannot reset the count and hand you a second full
// day's worth. `day` is the local date string the caller computes; the store
// does not decide what "today" means.
//
// Two numbers, not one. `count` is how many cards were put in front of you
// today; `rejected` is how many of those you turned down. They answer different
// questions and the caller needs both: a card you rejected is not one of "the
// best two or three a day" and should not spend the day's quota, but it was
// still something the bot asked you to look at, and the ceiling on *that* is
// what keeps the approval queue from becoming a rubber stamp.
//
// Counting only `count` meant three rejections at breakfast ended the day: the
// remaining quota hit zero, the gather stopped looking, and nothing could
// possibly publish until tomorrow.
export function stagedToday(day) {
  return state.stagedDay?.date === day ? state.stagedDay.count : 0;
}
export function rejectedToday(day) {
  return state.stagedDay?.date === day ? state.stagedDay.rejected || 0 : 0;
}

function dayRecord(day) {
  if (state.stagedDay?.date !== day) state.stagedDay = { date: day, count: 0, rejected: 0 };
  // Stores written before rejections were counted.
  if (typeof state.stagedDay.rejected !== 'number') state.stagedDay.rejected = 0;
  return state.stagedDay;
}

export function noteStaged(day) {
  const rec = dayRecord(day);
  rec.count++;
  save();
  return rec.count;
}

/**
 * Give back the quota slot a rejected card was holding.
 *
 * Bounded by what was actually offered that day, so rejecting a card that was
 * staged yesterday cannot mint today a slot it never spent.
 */
export function noteRejected(day) {
  const rec = dayRecord(day);
  if (rec.rejected >= rec.count) return rec.rejected;
  rec.rejected++;
  save();
  return rec.rejected;
}

// --- the quiet alarm's anchors ----------------------------------------------
// Stamped rather than derived. `published` is pruned to the quota window and
// `staging` empties on every decision, so neither can answer "when did this bot
// last actually do something" once enough time has passed — which is precisely
// the moment the question is worth asking.
export const lastStagedAt = () => state.lastStagedAt || null;
export const lastPublishedAt = () => state.lastPublishedAt || null;

/**
 * A card reached the approval chat.
 *
 * Separate from noteStaged() because the two have different scopes: only the
 * pipeline's cards count against the daily quota, but a manual submission is
 * still a card, and a day full of them is not a quiet day.
 */
export function noteStagedAt() {
  state.lastStagedAt = Date.now();
  save();
}

// --- staging (awaiting your approve/reject tap) ------------------------------
export function addStaging(item) {
  const key = Math.random().toString(36).slice(2, 9);
  state.staging[key] = item;
  save();
  return key;
}
export function takeStaging(key) {
  const item = state.staging[key];
  delete state.staging[key];
  save();
  return item || null;
}
export const getStaging = (key) => state.staging[key] || null;
export function updateStaging(key, patch) {
  if (!state.staging[key]) return false;
  state.staging[key] = { ...state.staging[key], ...patch };
  save();
  return true;
}
export const hasStaging = (key) => Boolean(state.staging[key]);
export const stagingSize = () => Object.keys(state.staging).length;
export function clearStaging() {
  const n = Object.keys(state.staging).length;
  state.staging = {};
  state.pendingEdit = {};
  save();
  return n;
}

// --- pending edits ----------------------------------------------------------
// Keyed by the staging key, never by chat: BrickDeal learned the hard way that
// a single "currently editing" value per chat lets the second of two in-flight
// edits steal the reply meant for the first. Routing is by the prompt's own
// message id (see bot.js), not by "whatever text arrived next".
export function setPendingEdit(key, edit) {
  state.pendingEdit[key] = edit;
  save();
}
export const getPendingEdit = (key) => state.pendingEdit[key] || null;
export function clearPendingEdit(key) {
  delete state.pendingEdit[key];
  save();
}
export function findPendingEditByPrompt(promptMessageId) {
  for (const [key, edit] of Object.entries(state.pendingEdit)) {
    if (edit.promptMessageId === promptMessageId) return key;
  }
  return null;
}

// --- publish queue ----------------------------------------------------------
export function enqueue(item) {
  state.queue.push(item);
  save();
}
export function dequeue() {
  const item = state.queue.shift() || null;
  if (item) save();
  return item;
}
export const queueSize = () => state.queue.length;
export const peekQueue = () => state.queue.slice(0, 10);

// --- published log (drives the pillar quotas) -------------------------------
/**
 * Record that a card went out, or that it reached one more destination.
 *
 * Upserts by id rather than always pushing. A card can now reach Telegram on one
 * attempt and Instagram on a later one; two rows for one post would double-count
 * it in the quota window and skew the pillar mix the scorer reads back.
 */
export function recordPublished({ id, pillar, tags = [], layout, sourceId, telegram, instagram }) {
  if (id) state.publishedIds[id] = Date.now();
  state.lastPublishedAt = Date.now();

  const existing = id ? state.published.find((p) => p.id === id) : null;
  if (existing) {
    // Sticky: a destination that has already published must never be recorded
    // as un-published by a later attempt that only covered the other one.
    existing.telegram = existing.telegram || Boolean(telegram);
    existing.instagram = existing.instagram || Boolean(instagram);
  } else {
    state.published.push({
      ts: Date.now(),
      id,
      pillar,
      tags,
      layout,
      // What the post was made from, so the quota window can answer "how much of
      // the feed is one source" — see sourceMaxShare in src/pillars.js.
      sourceId,
      telegram: Boolean(telegram),
      instagram: Boolean(instagram),
    });
  }
  prunePublished(state);
  save();
}
// Newest first, already inside the quota window.
export function recentPublished() {
  prunePublished(state);
  return [...state.published].sort((a, b) => b.ts - a.ts);
}
export const publishedToday = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return state.published.filter((p) => p.ts >= start.getTime()).length;
};

// --- per-destination health --------------------------------------------------
//
// A post that reaches Telegram and fails on Instagram used to be recorded as
// published and forgotten: `succeeded.length` was non-zero, so it was not
// retried, and the only trace was one warning line in a chat full of them. With
// Instagram blocked at the API, that repeated for every post — the Instagram
// account went dark for days while every individual message read as a handled
// edge case, and the global "when did we last publish" stayed fresh because
// Telegram kept working.
//
// So health is tracked per destination. `failures` counts CONSECUTIVE failures
// and resets on any success, which is what separates a blip from a block.

const DEGRADE_AFTER = () => Math.max(1, Number(process.env.TARGET_DEGRADE_AFTER ?? '3'));

const healthOf = (target) =>
  state.targetHealth[target] || { failures: 0, lastError: null, lastFailAt: null, lastOkAt: null, degraded: false };

export const targetHealth = (target) => ({ ...healthOf(target) });

export function noteTargetOk(target) {
  state.targetHealth[target] = {
    ...healthOf(target),
    failures: 0,
    lastError: null,
    lastOkAt: Date.now(),
    degraded: false,
  };
  save();
}

/**
 * Record a failed publish to one destination.
 *
 * Returns the updated record, including whether this failure is the one that
 * tipped the destination into `degraded` — the caller escalates on that edge so
 * the alert fires once per outage rather than once per card.
 */
export function noteTargetFailed(target, error) {
  const prev = healthOf(target);
  const failures = prev.failures + 1;
  const degraded = failures >= DEGRADE_AFTER();
  state.targetHealth[target] = {
    ...prev,
    failures,
    lastError: error ? String(error).slice(0, 300) : null,
    lastFailAt: Date.now(),
    degraded,
  };
  save();
  return { ...state.targetHealth[target], justDegraded: degraded && !prev.degraded };
}

/** A destination that has failed enough times running to stop hammering it. */
export const isDegraded = (target) => Boolean(healthOf(target).degraded);

/** When this destination last actually published, or null if it never has. */
export const lastOkAt = (target) => healthOf(target).lastOkAt || null;

/** Clear the degraded flag so the next attempt goes through. Used by /retry. */
export function clearDegraded(target) {
  const prev = healthOf(target);
  state.targetHealth[target] = { ...prev, failures: 0, degraded: false };
  save();
}

// --- held posts --------------------------------------------------------------
//
// An approved card that a destination refused is kept here instead of being
// dropped. Losing an approved post is the one outcome worth avoiding, and while
// a destination is blocked for days there is nothing useful to retry against —
// but there will be, and then the backlog should still exist.

export function hold(cand, targets, error) {
  state.held.push({ ts: Date.now(), targets, error: error ? String(error).slice(0, 300) : null, cand });
  save();
}
export const heldCount = () => state.held.length;
export const heldItems = () => state.held.map((h) => ({ ...h }));

/** Take everything held back out, for requeueing. Returns the rows. */
export function releaseHeld() {
  const rows = state.held;
  state.held = [];
  save();
  return rows;
}

// --- Instagram token ---------------------------------------------------------
// The Instagram Login path issues 60-day tokens that must be refreshed. The
// refreshed value has to outlive the process, or every restart would fall back
// to the stale seed in .env and the pipeline would still die on day 60. So the
// env var is the starting point and this is the source of truth thereafter.
export function setIgToken({ token, expiresAt }) {
  state.igToken = { token, expiresAt, updatedAt: Date.now() };
  save();
}
export const getIgToken = () => state.igToken || null;

export { existsSync };
