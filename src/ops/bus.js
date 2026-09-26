// What just happened, announced once, to whoever is listening.
//
// WHY THIS EXISTS
//
// There are now two surfaces onto the same queue, and the hard part of that is
// not doing the action twice — it is that an action taken on one surface leaves
// the OTHER one showing something that is no longer true. Approve a deck in the
// browser and the Telegram card sits there with live buttons over a post that
// has already been published; approve it in Telegram and the browser tab still
// lists it as waiting.
//
// So actions do not talk to surfaces. They emit here, and each surface decides
// what that means for it: the web server forwards to open browsers over SSE,
// bot.js edits the Telegram message in place. Adding a third surface is then a
// subscriber rather than a change to every action.
//
// Deliberately not Node's EventEmitter. The whole contract is one channel, one
// shape of payload, and a subscriber that throws must not take down the action
// that emitted — which is the default EventEmitter behaviour and the one thing
// this cannot afford: a broken browser connection would otherwise roll back an
// approval that had already published.

const subscribers = new Set();

// A short tail of what has already happened, so a browser that connects (or
// reconnects after a dropped connection) can catch up rather than showing an
// empty log until the next thing happens.
const RECENT_MAX = 50;
const recent = [];
let seq = 0;

/**
 * Announce something. Never throws, whatever the subscribers do.
 *
 * `type` is what happened, in the imperative-free past: 'staged', 'approved',
 * 'published'. `payload` is whatever that type carries.
 */
export function emit(type, payload = {}) {
  const event = { id: ++seq, ts: Date.now(), type, ...payload };
  recent.push(event);
  if (recent.length > RECENT_MAX) recent.shift();

  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (e) {
      // One bad listener is one bad listener. The emitting action has usually
      // already changed the store by this point and must not be unwound by a
      // browser that went away mid-write.
      console.error(`bus: subscriber failed on ${type}: ${e?.message || e}`);
    }
  }
  return event;
}

/** Listen. Returns the unsubscribe. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Everything since `afterId`, for a client that is catching up. */
export const since = (afterId = 0) => recent.filter((e) => e.id > Number(afterId || 0));

export const lastId = () => seq;
