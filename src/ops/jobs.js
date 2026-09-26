import { emit } from './bus.js';

// Work that takes minutes, made watchable from anywhere.
//
// WHAT THIS REPLACES
//
// bot.js had `detach(label, work, chatId)`, and the note on it is still the
// reason this file exists: Telegraf times a handler out at 90 seconds, the
// timeout REJECTS, the rejection reaches bot.launch()'s promise, and the catch
// there exits the process. A gather takes minutes, so awaiting one inside a
// command handler restarted the bot mid-run and lost the work.
//
// An HTTP request has the same problem with worse manners. A browser waiting
// three minutes on a POST looks broken, and any proxy in between will give up
// first — Caddy's default write timeout would cut the connection long before a
// deck finished rendering. So the web cannot await a build either.
//
// Both surfaces therefore need the same thing: start the work, answer at once
// with a handle, and report progress out of band. That is all this is.
//
// The progress line matters more than it looks. A deck is five generated
// photographs and twelve renders, and silence for two minutes is
// indistinguishable from a hang — which is why the Telegram flow already edited
// its message with "writing the cover…". Here that text is emitted rather than
// sent, so the browser gets the same reassurance without the bot having to know
// a browser exists.

const jobs = new Map();

// Finished jobs are kept for a while so a surface that was not watching can
// still ask how something turned out, and then dropped — this is a progress
// indicator, not the audit trail (that is store.note, and it is persisted).
const KEEP_DONE_MS = 30 * 60_000;
const MAX_JOBS = 100;

let seq = 0;

const publicView = (job) => ({
  id: job.id,
  label: job.label,
  status: job.status,
  progress: job.progress,
  actor: job.actor,
  startedAt: job.startedAt,
  endedAt: job.endedAt,
  error: job.error,
  result: job.summary,
});

function sweep() {
  const cutoff = Date.now() - KEEP_DONE_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && (job.endedAt || 0) < cutoff) jobs.delete(id);
  }
  // A hard ceiling as well as an age, because a bad afternoon can produce more
  // finished jobs in thirty minutes than anybody will ever read.
  while (jobs.size > MAX_JOBS) {
    const oldestDone = [...jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))[0];
    if (!oldestDone) break;
    jobs.delete(oldestDone.id);
  }
}

/**
 * Start something slow. Returns the job's public view immediately.
 *
 * `fn` is called with a `progress` function it may call as often as it likes.
 * Whatever it returns is kept as the job's summary, so a surface that asks later
 * gets the answer rather than just "done" — a build that finished with three
 * slides dropped is a different outcome from one that did not.
 *
 * `chatId` travels with the job rather than being closed over, because the
 * Telegram surface subscribes to failures centrally: the old detach() reported
 * its own errors, which meant every caller had to remember to pass a chat and
 * the web callers had nothing sensible to pass.
 */
export function run(label, fn, { actor = null, chatId = null, meta = {} } = {}) {
  sweep();
  const id = `j${++seq}`;
  const job = {
    id,
    label,
    status: 'running',
    progress: null,
    actor,
    chatId,
    meta,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    summary: null,
  };
  jobs.set(id, job);
  emit('job:started', { job: publicView(job) });

  const progress = (text) => {
    if (job.status !== 'running') return;
    job.progress = String(text ?? '').slice(0, 400);
    emit('job:progress', { job: publicView(job) });
  };

  // Promise.resolve().then(fn) rather than calling fn() directly, so a function
  // that throws SYNCHRONOUSLY lands in the catch below like every other failure
  // instead of escaping to the caller — which, on the Telegram path, is an
  // update handler whose throw restarts the process.
  Promise.resolve()
    .then(() => fn(progress))
    .then((result) => {
      job.status = 'done';
      job.endedAt = Date.now();
      job.summary = result && typeof result === 'object' ? result : result != null ? { message: String(result) } : null;
      emit('job:done', { job: publicView(job) });
    })
    .catch((e) => {
      job.status = 'failed';
      job.endedAt = Date.now();
      job.error = String(e?.message || e).slice(0, 400);
      console.error(`job ${label} failed:`, e?.stack || e);
      // The error object travels on the event, not just its message: the
      // Telegram surface formats failures with notify.withDetail(), which reads
      // more off it than a string can carry.
      emit('job:failed', { job: publicView(job), chatId: job.chatId, detail: e });
    });

  return publicView(job);
}

export const get = (id) => {
  const job = jobs.get(id);
  return job ? publicView(job) : null;
};

/** Everything a surface should show: running first, then recently finished. */
export const list = () => {
  sweep();
  return [...jobs.values()]
    .sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || b.startedAt - a.startedAt)
    .map(publicView);
};

export const running = () => [...jobs.values()].filter((j) => j.status === 'running').length;

/** For tests: forget everything, so one case cannot see another's jobs. */
export const __reset = () => {
  jobs.clear();
  seq = 0;
};
