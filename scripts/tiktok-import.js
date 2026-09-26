import { loadEnv } from '../src/env.js';
loadEnv();

import { readFileSync } from 'node:fs';
import * as store from '../src/store.js';
import { missingScopes } from '../src/publish/tiktok.js';

// Adopt the TikTok authorization that brickdeal-website already holds.
//
//   npm run tiktok-import                       # the default path below
//   npm run tiktok-import -- /some/other.json
//
// WHY THIS EXISTS RATHER THAN `npm run tiktok-token`.
//
// The website serves /tiktok/callback and exchanges the OAuth code server-side.
// tiktok-token.js is built on the opposite assumption — that the callback 404s,
// leaving the single-use code in the address bar to paste. Both cannot consume
// the same code, and re-authorizing the same account against the same client
// would hand back a new refresh token and strand the website's copy.
//
// So the connection is moved rather than repeated. Same client key, same
// account, same grant: only the custodian changes.
//
// WHAT MUST BE TRUE AFTERWARDS, and it is not enforceable from here: the
// website must stop refreshing. TikTok rotates the refresh token on every use,
// so two independent refreshers means whichever goes second is holding a value
// that has already been replaced — and that failure surfaces days later as an
// invalid_grant on a post nobody was watching. The website's refresh is manual
// and on-demand, which is what makes this safe: there is no timer to race.
//
// Both processes live on the same box, so the file is read in place. No token
// text needs to travel through a terminal, a chat log or an env var.

const DEFAULT_PATH = '/opt/brickdeal-site/data/tiktok-tokens.json';

const SECOND = 1000;
const path = process.argv.slice(2).find((a) => !a.startsWith('--')) || DEFAULT_PATH;

/**
 * `obtained_at` in an absolute millisecond stamp, whichever unit it arrived in.
 *
 * The file states relative lifetimes and one origin, and the origin's unit is
 * the ambiguous part: Date.now() gives milliseconds, a Python or shell-produced
 * stamp gives seconds, and both are plausible in a file written by a different
 * project. Ten-digit values are seconds — anything in milliseconds has been
 * thirteen digits since 2001 and stays that way until 2286.
 *
 * Guessing wrong is not a small error. Read as milliseconds, a seconds stamp
 * lands in 1970, every expiry is already past, and the bot reports a dead
 * connection that is in fact healthy.
 */
function obtainedAtMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`obtained_at is not a timestamp: ${raw}`);
  return n < 1e12 ? n * SECOND : n;
}

const human = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

function main() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }

  const required = ['access_token', 'refresh_token', 'expires_in', 'refresh_expires_in', 'obtained_at'];
  const absent = required.filter((k) => raw[k] === undefined || raw[k] === null || raw[k] === '');
  if (absent.length) throw new Error(`${path} is missing: ${absent.join(', ')}`);

  const obtained = obtainedAtMs(raw.obtained_at);
  const expiresAt = obtained + Number(raw.expires_in) * SECOND;
  const refreshExpiresAt = obtained + Number(raw.refresh_expires_in) * SECOND;

  // The refresh token is the one that cannot be repaired without a browser. If
  // it has lapsed there is nothing here worth storing, and storing it anyway
  // would replace "not connected" with a connection that fails at publish time.
  if (refreshExpiresAt <= Date.now()) {
    throw new Error(
      `the refresh token in ${path} expired on ${human(refreshExpiresAt)} — ` +
        'it has to be replaced in a browser, not imported'
    );
  }

  store.setTikTokToken({
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt,
    refreshExpiresAt,
    openId: raw.open_id || null,
    scope: raw.scope || null,
  });

  const accessLive = expiresAt > Date.now();
  console.log(`
imported from  ${path}
open_id        ${raw.open_id || '(none)'}
scope          ${raw.scope || '(none)'}
access token   ${accessLive ? `valid until ${human(expiresAt)}` : `LAPSED ${human(expiresAt)} — the bot will refresh on first use`}
refresh token  valid until ${human(refreshExpiresAt)}
saved to       ${process.env.STORE_PATH || 'data/store.json'}
`);

  // Draft mode is the only mode this bot posts in, so that is what is checked.
  const missing = missingScopes({ draft: true });
  if (missing.length) {
    console.log(`WARNING: missing scope(s) for a draft: ${missing.join(', ')}`);
    console.log('Every post will be refused at init. This needs a new authorization, not a refresh.\n');
  }

  console.log('NOW STOP THE OTHER SIDE REFRESHING. TikTok rotates the refresh token on');
  console.log('every use; two refreshers means one of them silently holds a dead value.\n');
}

try {
  main();
} catch (e) {
  console.error(`\nFailed: ${e.message}\n`);
  process.exitCode = 1;
}
