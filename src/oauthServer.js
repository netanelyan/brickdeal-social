import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as store from './store.js';
import { exchangeCode, creatorInfo, describeError, missingScopes } from './publish/tiktok.js';

// The last piece of connecting TikTok from a browser instead of a terminal.
//
// The flow, end to end, and where this file sits in it:
//
//   1. www.brickdeal.co.il/tiktok/connect  sends the owner to TikTok with a state.
//   2. TikTok redirects back to          www.brickdeal.co.il/tiktok/callback?code=…
//   3. That page validates its own state and POSTs the code here.
//   4. This exchanges the code for a token pair, stores it, and answers with
//      the account it just connected.
//
// Steps 1–3 are the website's, and they already exist. Only step 4 needs to run
// inside the bot, for one reason: the token pair has to land in the same
// data/store.json the bot publishes from, and the refresh token that comes with
// it cannot be replaced without a browser. Anything that writes it from another
// process is writing to a file a long-running process holds in memory.
//
// WHY THIS LISTENS ON LOCALHOST ONLY
// Caddy on the VPS terminates TLS and proxies slides.brickdeal.co.il/tiktok/* to
// 127.0.0.1:8787. Binding 0.0.0.0 would publish an endpoint that takes a shared
// secret straight to the open internet on a plain HTTP port, bypassing the
// thing holding the certificate. The bind address is not a preference.

const HOST = '127.0.0.1';
const PORT = 8787;

// An authorization code is a few hundred bytes and the body holds one. Reading
// an unbounded request into memory on an endpoint that answers before it
// authenticates is how a single curl becomes an outage.
const MAX_BODY_BYTES = 4096;

// Wrong guesses are answered slowly, and after a handful the endpoint stops
// answering them at all for a minute. The counter is global rather than
// per-IP on purpose: behind a proxy the only address seen is Caddy's, and a
// forwarded header is a claim by the caller, not a fact. One account connects
// here, once in a while, so a global lockout costs nothing real and cannot be
// escaped by rotating source addresses.
const FAIL_DELAY_MS = 300;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 60_000;

let failures = 0;
let lockedUntil = 0;
let server = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Is this the shared secret, compared without leaking how much of it matched?
 *
 * Both sides are hashed first. timingSafeEqual throws outright when the two
 * buffers differ in length, so handing it the raw values would turn the
 * secret's length into an observable — and a length check written to avoid the
 * throw would itself be the early exit the constant-time compare exists to
 * prevent. Two SHA-256 digests are always 32 bytes, so the comparison is over a
 * fixed width no matter what was presented.
 */
function bearerOk(header, secret) {
  const presented = /^bearer\s+(.*)$/i.exec(String(header || '').trim())?.[1] ?? '';
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(a, b);
}

async function authorize(req) {
  if (Date.now() < lockedUntil) {
    throw new HttpError(429, 'too many failed attempts — try again in a minute');
  }
  if (!bearerOk(req.headers.authorization, process.env.TIKTOK_BOT_SECRET || '')) {
    failures += 1;
    if (failures >= LOCKOUT_AFTER) {
      lockedUntil = Date.now() + LOCKOUT_MS;
      failures = 0;
      console.warn('tiktok oauth: repeated bad bearer — endpoint locked for 60s');
    }
    await sleep(FAIL_DELAY_MS);
    throw new HttpError(401, 'unauthorized');
  }
  failures = 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'could not read the request body')));
  });
}

// One exchange at a time. Not for the store's sake — see the note on writes
// below — but because two codes arriving together would each overwrite the
// other's token pair, and the loser would be a refresh token nobody holds any
// more. Rare, but the failure is silent and needs a browser to repair.
let inFlight = Promise.resolve();
function serialize(fn) {
  const run = inFlight.then(fn, fn);
  inFlight = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Swap the code for a token pair and report which account was connected.
 *
 * ON WRITING THE STORE SAFELY
 * This does not touch data/store.json itself. It calls exchangeCode(), which is
 * the same function scripts/tiktok-token.js calls, which persists through
 * src/store.js — the module the rest of the bot already writes through. That
 * matters more than it looks: store.js keeps the whole document in memory and
 * saves it whole, so a second writer holding its own copy would not corrupt the
 * file (the save is a tmp-plus-rename) but would silently roll back every
 * change made since it loaded. Running in the bot's own process, through the
 * bot's own store module, there is one copy of that document and one event loop
 * touching it; setTikTokToken() is synchronous from read to rename, so no
 * concurrent publish can interleave with it.
 */
async function exchange(body) {
  let parsed;
  try {
    parsed = JSON.parse(body || '');
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'body must be a JSON object');

  const code = typeof parsed.code === 'string' ? parsed.code.trim() : '';
  // Deliberately not validated beyond "present and not absurd". A v2 code
  // contains `*` and `!` and a trailing `.s1`, and the last thing that tried to
  // be clever about its shape truncated it and spent a day reading TikTok's
  // reply — "Authorization code is expired" — as a clock problem.
  if (!code) throw new HttpError(400, 'no code in the request');
  if (code.length > 512) throw new HttpError(400, 'that does not look like an authorization code');

  const configured = process.env.TIKTOK_REDIRECT_URI || '';
  if (!configured) throw new HttpError(500, 'TIKTOK_REDIRECT_URI is not set on the bot');
  const redirectUri = typeof parsed.redirect_uri === 'string' && parsed.redirect_uri
    ? parsed.redirect_uri
    : configured;
  // TikTok requires the redirect_uri at exchange to be the one the code was
  // issued against, character for character. Checking it here names the
  // mismatch; leaving it to TikTok spends the code — they are single use — and
  // answers with a generic invalid_grant that reads like a bad code.
  if (redirectUri !== configured) {
    throw new HttpError(
      400,
      `redirect_uri does not match the one this bot is configured with (${configured})`
    );
  }

  let token;
  try {
    token = await exchangeCode(code, { redirectUri });
  } catch (e) {
    // A network failure is ours, not the caller's, and saying 400 would tell
    // the website the code was bad when it was never sent.
    const status = /network error/i.test(e?.message || '') ? 502 : 400;
    throw new HttpError(status, describeError(e));
  }

  // The token pair is stored by this point. creator_info is a courtesy lookup
  // to name the account, so a failure here is reported and then dropped:
  // answering 4xx would tell the browser the connection failed while the bot is
  // in fact connected, and the code it would ask you to retry with is spent.
  let username = null;
  try {
    username = (await creatorInfo()).username;
  } catch (e) {
    console.warn(`tiktok oauth: token stored, but creator_info failed: ${describeError(e)}`);
  }

  // What the grant did NOT include, said at connect time rather than at the
  // first publish.
  //
  // scripts/tiktok-token.js has always warned about this; the browser flow did
  // not, so connecting through the website accepted a token that could not
  // post and said "ok". That is exactly how a deck came to fail at init with
  // scope_not_authorized weeks later, with nothing in between to suggest the
  // connection was only half a connection.
  const missing = missingScopes({ draft: true });
  if (missing.length) {
    console.warn(`tiktok oauth: connected WITHOUT ${missing.join(', ')} — publishing will fail`);
  }

  const saved = store.getTikTokToken();
  return {
    ok: true,
    open_id: token.open_id || saved?.openId || null,
    scope: token.scope || saved?.scope || null,
    username,
    // The website shows this to whoever just connected. A connection that
    // cannot publish should not look like a success on the page that made it.
    missing_scopes: missing,
  };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function route(req, res) {
  // Pathname only, never the whole URL. A code that arrives in a query string —
  // from a mistyped GET, say — must not reach the log, and req.url carries it.
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  let status = 500;
  try {
    if (req.method !== 'POST' || path !== '/tiktok/exchange') {
      throw new HttpError(404, 'not found');
    }
    await authorize(req);
    const body = await readBody(req);
    const result = await serialize(() => exchange(body));
    status = 200;
    send(res, status, result);
  } catch (e) {
    const known = e instanceof HttpError;
    status = known ? e.status : 500;
    if (!known) console.error(`tiktok oauth: unexpected failure: ${e?.message || e}`);
    send(res, status, { ok: false, error: known ? e.message : 'unexpected error' });
  } finally {
    // Method and path and outcome. Never a header, never a body.
    console.log(`tiktok oauth: ${req.method} ${path} -> ${status}`);
  }
}

/**
 * Start the connect endpoint, or explain why it is not starting.
 *
 * Returns the server, or null when there is no secret to check against. A
 * missing TIKTOK_BOT_SECRET must not fall through to an empty-string
 * comparison: that is an open endpoint that writes the publishing token.
 */
export function startOAuthServer() {
  if (server) return server;
  if (!process.env.TIKTOK_BOT_SECRET) {
    console.log('   tiktok connect: OFF (no TIKTOK_BOT_SECRET set)');
    return null;
  }

  server = createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(`tiktok oauth: ${e?.message || e}`);
      try {
        send(res, 500, { ok: false, error: 'unexpected error' });
      } catch {}
    });
  });
  // A request that opens a socket and then dawdles should not hold one open
  // indefinitely on an endpoint that exists to answer one POST.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.on('error', (e) => {
    // Worth surviving rather than taking the bot down with it: the publishing
    // pipeline does not need this port, and a bot that refuses to start because
    // a stale process holds 8787 is a worse outcome than one that cannot be
    // re-authorised until the port is free.
    console.error(
      e.code === 'EADDRINUSE'
        ? `tiktok oauth: ${HOST}:${PORT} is already in use — connect endpoint not started`
        : `tiktok oauth: server error: ${e.message}`
    );
    server = null;
  });

  server.listen(PORT, HOST, () => {
    console.log(`   tiktok connect: listening on http://${HOST}:${PORT} (POST /tiktok/exchange)`);
  });
  return server;
}

/** Stop accepting, drop what is open, and resolve once the port is free. */
export function stopOAuthServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  return new Promise((resolve) => {
    s.close(() => resolve());
    // close() alone waits for keep-alive sockets to go idle, which a proxy
    // holding a connection open will not do promptly. SIGTERM means now.
    s.closeAllConnections?.();
  });
}
