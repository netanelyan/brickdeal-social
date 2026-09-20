import { readFileSync } from 'node:fs';
import { fetchFeed } from './rss.js';
import { fetchClimate, loadDestinations } from './climate.js';
import * as store from '../store.js';

// The registry is data, not code (sources.json), so adding a source is an edit
// to one JSON file and turning one off is a one-word change. Adapters are
// keyed by `kind`.

let cached = null;

export function registry() {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(new URL('../../sources.json', import.meta.url), 'utf8'));
  cached = {
    allowlist: (raw.allowlist || []).map((a) => ({ ...a, suffix: a.suffix.toLowerCase() })),
    sources: raw.sources || [],
  };
  return cached;
}

/**
 * Sources that are on.
 *
 * Two switches, deliberately separate. `enabled` in sources.json is the
 * declaration — off for good, with the probe result in its `note`, which is the
 * half that makes the registry worth reading. The store's switch is the other
 * kind: off right now, from Telegram, without editing a file on the server.
 */
export const enabledSources = () =>
  registry().sources.filter((s) => s.enabled && !store.isSourceOff(s.id));

/** Everything declared, whatever state it is in — for reporting. */
export const allSources = () => registry().sources.slice();
export const sourceById = (id) => registry().sources.find((s) => s.id === id) || null;

/**
 * Is this URL on an allowlisted primary-authority domain?
 *
 * This is the enforcement point for "no claim without a primary source". A
 * suffix match is deliberate: `.gov.uk` should cover every department without
 * enumerating them, but it must match on a domain-label boundary so that
 * `evil-gov.uk` or `notunesco.org` can't sneak through as `gov.uk`/`unesco.org`.
 */
export function primaryAuthority(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  for (const entry of registry().allowlist) {
    const s = entry.suffix;
    const bare = s.startsWith('.') ? s.slice(1) : s;
    if (host === bare || host.endsWith('.' + bare)) return entry;
  }
  return null;
}

export const isPrimary = (url) => Boolean(primaryAuthority(url));

/**
 * Run every enabled source and return raw items.
 *
 * A single failing source never sinks the run — it is caught, tallied, and
 * reported. `errors` is returned rather than logged and forgotten so the caller
 * can surface it, which is the same reasoning behind BrickDeal's skip digest.
 */
export async function gather({ climateLimit = 2, now = new Date() } = {}) {
  const items = [];
  const errors = [];
  const perSource = {};
  const skipped = [];

  // Resolved ONCE and indexed from that array. It used to be called again
  // inside the result loop — `enabledSources()[i]` — which was correct only
  // because the registry is cached and the list could not change mid-run. It
  // can now: a source stood down or switched off between the two calls would
  // have shifted every index after it, and attributed each feed's items to its
  // neighbour. A silent mis-attribution is a bad thing to leave lying around.
  const live = [];
  for (const source of enabledSources()) {
    // A feed that has failed repeatedly is not fetched again until its cooldown
    // has elapsed. It is not dropped — after the cooldown exactly one run tries
    // it, and a success clears the whole record.
    if (store.isSourceDegraded(source.id)) {
      const due = store.sourceRecoveryDueAt(source.id);
      skipped.push({
        sourceId: source.id,
        name: source.name,
        failures: store.sourceHealth(source.id).failures,
        retryAt: due,
      });
      perSource[source.id] = 0;
      continue;
    }
    live.push(source);
  }

  const settled = await Promise.allSettled(
    live.map(async (source) => {
      if (source.kind === 'rss') {
        const got = await fetchFeed(source);
        return { source, got };
      }
      if (source.kind === 'climate') {
        const got = await gatherClimate(source, { limit: climateLimit, now });
        return { source, got };
      }
      // 'html' sources are declared in the registry but have no adapter yet;
      // they're all `enabled: false`, so reaching here means someone flipped one
      // on prematurely. Say so instead of silently returning nothing.
      throw Object.assign(new Error(`no adapter for kind "${source.kind}"`), { sourceId: source.id });
    })
  );

  for (let i = 0; i < settled.length; i++) {
    const source = live[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      perSource[source.id] = r.value.got.length;
      items.push(...r.value.got);
      store.noteSourceOk(source.id, r.value.got.length);
    } else {
      const message = r.reason?.message || String(r.reason);
      perSource[source.id] = 0;
      const health = store.noteSourceFailed(source.id, message);
      errors.push({
        sourceId: source.id,
        name: source.name,
        message,
        failures: health.failures,
        // The edge, so the caller can say "this one has now been stood down"
        // once rather than repeating a count nobody reads.
        justDegraded: health.justDegraded,
      });
    }
  }

  return { items, errors, perSource, skipped };
}

// Climate is a pull, not a feed, so it needs its own rotation: walk the
// destination list and take the first few that haven't already produced a post
// this year. Without this it would offer the same city every single day.
async function gatherClimate(source, { limit, now }) {
  const out = [];
  const dests = loadDestinations();
  const offset = Math.floor(now.getTime() / 86_400_000) % Math.max(1, dests.length);
  const ordered = [...dests.slice(offset), ...dests.slice(0, offset)];

  for (const dest of ordered) {
    if (out.length >= limit) break;
    const year = now.getUTCFullYear() - 1;
    if (store.hasSeen(`climate:${dest.id}:${year}`)) continue;
    try {
      out.push(await fetchClimate(source, dest, now));
    } catch (e) {
      // One unreachable destination shouldn't stop the rotation reaching the
      // next one — the whole source only fails if every attempt fails.
      console.error(`   climate: ${dest.en} failed — ${e.message}`);
    }
  }
  if (!out.length && ordered.length) {
    // Distinguish "everything is already used up this year" (fine, quiet) from
    // "the API is down" (an error worth reporting).
    const allSeen = ordered.every((d) => store.hasSeen(`climate:${d.id}:${now.getUTCFullYear() - 1}`));
    if (!allSeen) throw new Error('every climate lookup attempted failed');
  }
  return out;
}
