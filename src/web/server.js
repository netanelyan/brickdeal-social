import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, basename, extname, sep } from 'node:path';
import * as store from '../store.js';
import * as auth from './auth.js';
import * as ops from '../ops/marketing.js';
import * as views from '../ops/views.js';
import * as settings from '../ops/settings.js';
import * as jobs from '../ops/jobs.js';
import { subscribe, since as eventsSince, lastId } from '../ops/bus.js';
import { cardOutputDir } from '../render/index.js';
import { handleTikTokExchange, exchangeConfigured } from '../oauthServer.js';
import { loadDeals } from '../brick/feed.js';
import { remainingQuota, describeError as describeIgError, instagramConfigured } from '../publish/instagram.js';
import { creatorInfo, describeError as describeTikTokError, tiktokConfigured, privacyHe } from '../publish/tiktok.js';

// The website: the same marketing, from a browser.
//
// WHY IT LIVES IN THIS PROCESS
//
// It has to. src/store.js holds the whole document in memory and saves it whole,
// so a second process serving this page would not corrupt data/store.json — the
// save is tmp-plus-rename — but it WOULD silently roll back every change the bot
// had made since the web process last loaded. Approve a deck in the browser and
// the next thing the bot writes puts it back in the queue. src/oauthServer.js
// already documents this at length; it is the same constraint, and it is the
// reason there is no separate web service to deploy.
//
// WHERE IT LISTENS, AND WHY THAT IS NOT A PREFERENCE
//
// 127.0.0.1, like the TikTok connect endpoint it absorbs. Caddy terminates TLS
// and proxies to it. Binding 0.0.0.0 would publish an admin panel that can
// publish to Instagram on a plain HTTP port, bypassing the thing holding the
// certificate — so an install that overrides WEB_BIND is warned about it, loudly,
// on every boot.
//
// ONE PORT, NOT TWO. The Caddyfile already proxies /tiktok/* here, and that route
// is served unchanged (same bearer secret, same lockout) so an existing deploy
// keeps working with one added route block rather than a second upstream.

const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url));
const DEFAULT_PORT = 8787;
const HOST = () => process.env.WEB_BIND || '127.0.0.1';
const PORT = () => Number(process.env.WEB_PORT || DEFAULT_PORT);

// Generous enough for the whole of brick-config.json (16KB today) with room to
// grow, small enough that an unauthenticated POST cannot be a memory attack.
const MAX_BODY_BYTES = 256 * 1024;

const COOKIE = 'brickdeal_session';

let server = null;
// Open SSE connections. Held so shutdown can end them rather than waiting for a
// proxy to notice — see stop().
const streams = new Set();

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Run something whose failure is an ANSWER rather than a bug.
 *
 * auth.js and ops/settings.js throw sentences written for the person reading them
 * — "the password must be at least 12 characters", "hashtags.broad has 1 tag,
 * needs 2". Those are 400s, and they must not be logged as crashes: a stack trace
 * per rejected password turns the journal into noise and hides the one entry that
 * is a real fault.
 *
 * Everything NOT wrapped in this is therefore allowed to be a 500 with its stack,
 * which is what an unexpected TypeError should look like. The distinction has to
 * be made at the call site, because by the time an Error reaches the router there
 * is nothing left on it to tell the two apart.
 */
async function expected(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, String(e?.message || 'שגיאה'));
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Every API answer is about right now. A cached /api/pending is a page
    // showing a deck that was approved ten minutes ago.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'הבקשה גדולה מדי'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'לא הצלחתי לקרוא את הבקשה')));
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'הבקשה צריכה להיות JSON');
  }
}

const cookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return i === -1 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
      })
  );

/**
 * Is this request arriving over TLS?
 *
 * Read from the proxy's header, which is a claim by the caller — and safe to
 * trust here for exactly one purpose: deciding whether to mark the cookie Secure.
 * Believing a lie makes the cookie MORE restrictive, never less. Nothing else in
 * this file trusts a forwarded header, and in particular no identity comes from
 * one.
 */
const isSecure = (req) =>
  req.socket.encrypted === true || /https/i.test(String(req.headers['x-forwarded-proto'] || ''));

function setSessionCookie(res, req, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Strict, not Lax. Nothing links into this panel from anywhere else, so the
    // usual reason to loosen it does not apply — and a cross-site GET that
    // arrives with a session is a cross-site GET that can read the queue.
    'SameSite=Strict',
    `Max-Age=${auth.sessionDays() * 86_400}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

const clearSessionCookie = (res) =>
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

/**
 * The signed-in account, or a 401.
 *
 * `capability` is checked here rather than in each handler, so a route that
 * forgets to say what it needs fails closed at `act` — the middle of the three,
 * which a reader route would notice immediately in testing and a privileged one
 * would not be granted by accident.
 */
function require_(req, capability = 'act') {
  const who = auth.session(cookies(req)[COOKIE]);
  if (!who) throw new HttpError(401, 'צריך להתחבר');
  if (!auth.can(who.role, capability)) throw new HttpError(403, 'אין הרשאה לפעולה הזו');
  return who;
}

/**
 * The same, plus the CSRF check every mutating request must pass.
 *
 * SameSite=Strict already stops a cross-site form post from carrying the cookie.
 * This is the second lock: a header a browser will only send on a same-origin
 * fetch, whose value the page can only know because it was told it by
 * /api/session. A form submitted from another origin cannot set it at all.
 */
function requireWrite(req, capability = 'act') {
  const who = require_(req, capability);
  const presented = String(req.headers['x-csrf'] || '');
  if (!who.csrf || presented !== who.csrf) throw new HttpError(403, 'הבקשה לא אומתה — רענן את הדף');
  return who;
}

// ---------------------------------------------------------------------------
// The static page
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Read once and kept. Three small files that change on deploy, not at runtime.
const uiCache = new Map();

async function serveUi(res, name) {
  const safe = basename(name || 'index.html') || 'index.html';
  const ext = extname(safe);
  if (!TYPES[ext]) throw new HttpError(404, 'not found');

  let body = uiCache.get(safe);
  if (!body) {
    const file = join(UI_DIR, safe);
    // basename() above already flattens any traversal, and this re-checks the
    // resolved path rather than trusting that — the cost is one string compare
    // and the failure it prevents is serving .env.
    if (!resolve(file).startsWith(resolve(UI_DIR))) throw new HttpError(404, 'not found');
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (process.env.WEB_NO_CACHE !== '1') uiCache.set(safe, body);
  }

  res.writeHead(200, {
    'content-type': TYPES[ext],
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    // The page loads nothing from anywhere else — no CDN, no font host, no
    // analytics — so the policy can say exactly that. An admin panel is the last
    // place to leave room for an injected script to phone home.
    ...(ext === '.html'
      ? {
          'content-security-policy':
            "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
        }
      : {}),
  });
  res.end(body);
}

/**
 * A rendered slide, by filename, to a signed-in browser.
 *
 * By FILENAME and never by path. The candidate objects carry absolute server
 * paths and the page is never given them: a route that took a path would be a
 * file-read primitive with a session in front of it, and the session is held by
 * people whose job is marketing rather than server security.
 *
 * Note this deliberately does not depend on CARD_PUBLIC_BASE_URL. The public host
 * is how Instagram and TikTok fetch a slide, and it is often not reachable while
 * you are building one — the panel has to show the deck you are approving even on
 * a laptop with no DNS record pointing at it.
 */
function serveImage(req, res, filename) {
  require_(req, 'read');
  const name = basename(String(filename || ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png)$/i.test(name)) throw new HttpError(404, 'not found');

  const dir = resolve(cardOutputDir());
  const file = resolve(join(dir, name));
  if (!file.startsWith(dir + sep)) throw new HttpError(404, 'not found');
  if (!existsSync(file)) throw new HttpError(404, 'הקובץ כבר לא על הדיסק');

  const { size } = statSync(file);
  res.writeHead(200, {
    'content-type': name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    'content-length': size,
    // A rendered slide never changes under its own name — the stem is derived
    // from the deck id and the slide number — so a browser may keep it. It is
    // private, because a queue of unpublished posts is not public.
    'cache-control': 'private, max-age=86400',
  });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * Server-sent events: what just happened, as it happens.
 *
 * Polling would work and this is better for the reason the bus exists at all —
 * two admins and a bot are acting on one queue, and a page that is five seconds
 * stale is a page where somebody taps approve on a deck that has already been
 * approved. The tap is safe (takeStaging is atomic and the second caller gets
 * "already handled") but it is confusing, and confusion here costs real posts.
 *
 * Deliberately dumb: the event says something changed, the page re-reads what it
 * needs. Sending the new state down this channel would mean two places that build
 * a pending list.
 */
function serveEvents(req, res) {
  const who = require_(req, 'read');

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Caddy and nginx both buffer by default, which for a stream means the page
    // gets nothing until the connection closes.
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  // Anything that happened between the page's last event and this connection.
  // Without it, a reconnect after a dropped Wi-Fi link silently misses whatever
  // happened in the gap.
  const from = Number(req.headers['last-event-id'] || new URL(req.url, 'http://x').searchParams.get('since') || 0);
  for (const event of eventsSince(from)) write(event);

  function write(event) {
    try {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      close();
    }
  }

  const unsubscribe = subscribe(write);
  // A proxy will close an idle stream, and so will a phone that sleeps. A comment
  // every twenty-five seconds keeps it open and costs two bytes.
  const beat = setInterval(() => {
    try {
      res.write(': .\n\n');
    } catch {
      close();
    }
  }, 25_000);

  function close() {
    clearInterval(beat);
    unsubscribe();
    streams.delete(close);
    res.end();
  }
  streams.add(close);
  req.on('close', close);
  console.log(`web: ${who.username} is watching (${streams.size} open)`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Matched in order. A route is [method, pattern, handler]; `:name` captures one
// path segment. Kept as a list rather than a framework because it is forty routes
// and a dependency here would be a dependency in the publishing path.
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

const segments = (pattern) => pattern.split('/').filter(Boolean);

function match(pattern, path) {
  const want = segments(pattern);
  const got = segments(path);
  if (want.length !== got.length) return null;
  const params = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(got[i]);
    else if (part !== got[i]) return null;
  }
  return params;
}

// --- the page itself ---------------------------------------------------------

on('GET', '/', (req, res) => serveUi(res, 'index.html'));

// --- who am I ----------------------------------------------------------------

on('GET', '/api/session', (req, res) => {
  const who = auth.session(cookies(req)[COOKIE]);
  // 200 with a null user rather than 401. "Not signed in" is the normal state of
  // the login page, and an error there means the page cannot tell a fresh visit
  // from a broken server.
  sendJson(res, 200, {
    user: who ? { username: who.username, name: who.name, role: who.role, capabilities: who.capabilities } : null,
    csrf: who?.csrf || null,
    // So the login page can say "no accounts yet — run npm run admin" instead of
    // rejecting a password nobody has set.
    accounts: auth.count(),
    telegramOwner: Boolean(process.env.OWNER_ID),
  });
});

on('POST', '/api/login', async (req, res) => {
  const { username, password } = await readJson(req);
  const { admin, token } = await expected(() => auth.signIn(username, password));
  setSessionCookie(res, req, token);
  const who = auth.session(token);
  console.log(`web: ${admin.username} signed in`);
  store.note({ action: 'signed-in', actor: { kind: 'web', id: admin.id, name: admin.name } });
  sendJson(res, 200, {
    user: { username: who.username, name: who.name, role: who.role, capabilities: who.capabilities },
    csrf: who.csrf,
  });
});

on('POST', '/api/logout', (req, res) => {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
});

// --- reading -----------------------------------------------------------------

on('GET', '/api/overview', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, views.overview());
});
on('GET', '/api/pending', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, views.pending());
});
on('GET', '/api/queue', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, { queue: views.queue(), lastKind: store.lastPublishedKindOf() });
});
on('GET', '/api/held', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, { held: views.held() });
});
on('GET', '/api/published', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, { published: views.published({ limit: 60 }) });
});
on('GET', '/api/audit', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, { audit: views.audit({ limit: 150 }) });
});
on('GET', '/api/jobs', (req, res) => {
  require_(req, 'read');
  sendJson(res, 200, { jobs: jobs.list(), lastEventId: lastId() });
});
on('GET', '/api/jobs/:id', (req, res, { id }) => {
  require_(req, 'read');
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, 'אין עבודה כזו');
  sendJson(res, 200, { job });
});
on('GET', '/api/events', (req, res) => serveEvents(req, res));
on('GET', '/api/image/:filename', (req, res, { filename }) => serveImage(req, res, filename));

/**
 * The feed as it stands, which is what every proposal is drawn from.
 *
 * Worth its own page: when /deck says "nothing fresh enough to build", the answer
 * is in here — how old the prices are, which items were dropped and why. That was
 * previously only visible as five truncated lines on a failure message.
 */
on('GET', '/api/feed', async (req, res) => {
  require_(req, 'read');
  const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
  try {
    const { deals, dropped } = await loadDeals({ fresh });
    sendJson(res, 200, {
      count: deals.length,
      deals: deals.slice(0, 200),
      dropped: (dropped || []).slice(0, 60),
    });
  } catch (e) {
    sendJson(res, 200, { count: 0, deals: [], dropped: [], error: String(e.message || e) });
  }
});

// --- the marketing -----------------------------------------------------------
//
// Every one of these is one call into src/ops/marketing.js, which is the point of
// this file being as thin as it is: the browser and the bot reach the same
// function, so there is no second definition of what approving means.

const actor = (who) => ({ kind: 'web', id: who.id, name: who.name, username: who.username, role: who.role });

on('POST', '/api/deck', async (req, res) => {
  const who = requireWrite(req);
  const { request = null } = await readJson(req);
  sendJson(res, 202, ops.proposeDeck({ request: request || null, actor: actor(who) }));
});

on('POST', '/api/proposals/:key/build', async (req, res, { key }) => {
  const who = requireWrite(req);
  const { targets } = await readJson(req);
  const wanted = Array.isArray(targets) ? targets.filter((t) => t === 'instagram' || t === 'tiktok') : [];
  if (!wanted.length) throw new HttpError(400, 'צריך לבחור יעד אחד לפחות');
  // Reaching TikTok always means a draft — the API cannot name a sound, and sound
  // is the one thing that cannot be changed after publishing. See the button in
  // bot.js for the full argument.
  const result = ops.buildProposal(key, { targets: wanted, draft: wanted.includes('tiktok'), actor: actor(who) });
  sendJson(res, result.ok ? 202 : 409, result);
});

on('POST', '/api/proposals/:key/revise', async (req, res, { key }) => {
  const who = requireWrite(req);
  const { instruction } = await readJson(req);
  const result = ops.reviseProposal(key, instruction, { actor: actor(who) });
  sendJson(res, result.ok ? 202 : 400, result);
});

on('POST', '/api/proposals/:key/reject', async (req, res, { key }) => {
  const who = requireWrite(req);
  const result = await ops.rejectProposal(key, { actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

on('POST', '/api/staged/:key/approve', async (req, res, { key }) => {
  const who = requireWrite(req);
  const result = await ops.approve(key, { actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

on('POST', '/api/staged/:key/reject', async (req, res, { key }) => {
  const who = requireWrite(req);
  const result = await ops.reject(key, { actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

on('POST', '/api/staged/:key/privacy', async (req, res, { key }) => {
  const who = requireWrite(req);
  const result = await ops.cyclePrivacy(key, { actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

on('POST', '/api/staged/:key/cover', async (req, res, { key }) => {
  const who = requireWrite(req);
  const result = ops.newCover(key, { actor: actor(who) });
  sendJson(res, result.ok ? 202 : 409, result);
});

on('POST', '/api/staged/:key/photo', async (req, res, { key }) => {
  const who = requireWrite(req);
  const { slide } = await readJson(req);
  const n = Number(slide);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'צריך מספר שקופית');
  const result = ops.newPhoto(key, n, { actor: actor(who) });
  sendJson(res, result.ok ? 202 : 400, result);
});

on('POST', '/api/staged/resend', (req, res) => {
  const who = requireWrite(req);
  const result = ops.resend({ actor: actor(who) });
  sendJson(res, result.ok ? 202 : 409, result);
});

on('POST', '/api/staged/clear', (req, res) => {
  const who = requireWrite(req);
  sendJson(res, 200, ops.clearPending({ actor: actor(who) }));
});

on('POST', '/api/queue/next', async (req, res) => {
  const who = requireWrite(req);
  sendJson(res, 200, await ops.publishNow({ actor: actor(who) }));
});

on('POST', '/api/queue/:n/publish', async (req, res, { n }) => {
  const who = requireWrite(req);
  const result = await ops.publishAt(Number(n), { actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

on('POST', '/api/queue/:n/draft', async (req, res, { n }) => {
  const who = requireWrite(req);
  const result = ops.draftAt(Number(n), { actor: actor(who) });
  sendJson(res, result.ok ? 202 : 409, result);
});

on('POST', '/api/queue/clear', (req, res) => {
  const who = requireWrite(req);
  sendJson(res, 200, ops.clearQueue({ actor: actor(who) }));
});

on('POST', '/api/held/retry', async (req, res) => {
  const who = requireWrite(req);
  sendJson(res, 200, await ops.retryHeld({ actor: actor(who) }));
});

on('POST', '/api/held/clear', async (req, res) => {
  const who = requireWrite(req);
  const result = await ops.clearHeld({ actor: actor(who) });
  sendJson(res, result.ok ? 200 : 409, result);
});

// --- live probes -------------------------------------------------------------
//
// Separate routes, and never part of /api/overview, because each one spends a
// real API call. A dashboard that refreshed every few seconds would burn an
// Instagram quota lookup every few seconds, and the quota is the thing it is
// trying to report.

on('GET', '/api/probe/instagram', async (req, res) => {
  require_(req, 'read');
  if (!instagramConfigured()) return sendJson(res, 200, { configured: false });
  try {
    sendJson(res, 200, { configured: true, remaining: await remainingQuota() });
  } catch (e) {
    sendJson(res, 200, { configured: true, error: describeIgError(e) });
  }
});

on('GET', '/api/probe/tiktok', async (req, res) => {
  require_(req, 'read');
  if (!tiktokConfigured()) return sendJson(res, 200, { configured: false });
  try {
    const info = await creatorInfo();
    sendJson(res, 200, {
      configured: true,
      username: info.username,
      options: (info.options || []).map((o) => ({ value: o, label: privacyHe(o) })),
      // One privacy level, and it is SELF_ONLY: that is what an app before audit
      // gets, and it is worth naming rather than showing as a short list.
      preAudit: info.options?.length === 1 && info.options[0] === 'SELF_ONLY',
    });
  } catch (e) {
    sendJson(res, 200, { configured: true, error: describeTikTokError(e) });
  }
});

// --- settings ----------------------------------------------------------------

on('GET', '/api/config', (req, res) => {
  require_(req, 'read');
  const parsed = views.marketingConfig();
  sendJson(res, 200, {
    ...parsed,
    raw: settings.readRaw(),
    hasBackup: settings.readBackup() !== null,
    dials: settings.dials(),
  });
});

on('POST', '/api/config/copy', async (req, res) => {
  const who = requireWrite(req, 'configure');
  const { text } = await readJson(req);
  // The validator's own sentence goes back to the browser. That is the whole
  // point of the write-validate-restore dance in ops/settings.js: an admin who
  // broke the hashtag pool should read "hashtags.broad has 1 tag, needs 2".
  const config = await expected(() => settings.writeRaw(text, { actor: actor(who) }));
  sendJson(res, 200, { ok: true, config });
});

on('POST', '/api/config/restore', async (req, res) => {
  const who = requireWrite(req, 'configure');
  const backup = settings.readBackup();
  if (backup === null) throw new HttpError(404, 'אין גרסה קודמת לשחזר');
  sendJson(res, 200, { ok: true, config: await expected(() => settings.writeRaw(backup, { actor: actor(who) })) });
});

on('POST', '/api/config/dial', async (req, res) => {
  const who = requireWrite(req, 'configure');
  const { key, value } = await readJson(req);
  sendJson(res, 200, await expected(() => settings.setDial(key, value === null || value === '' ? null : value, { actor: actor(who) })));
});

// --- accounts ----------------------------------------------------------------

on('GET', '/api/admins', (req, res) => {
  require_(req, 'accounts');
  sendJson(res, 200, { admins: auth.list(), roles: auth.ROLES });
});

on('POST', '/api/admins', async (req, res) => {
  const who = requireWrite(req, 'accounts');
  const { username, password, name, role } = await readJson(req);
  const created = await expected(() => auth.createAdmin({ username, password, name, role }));
  store.note({
    action: 'account:created',
    actor: { kind: 'web', id: who.id, name: who.name },
    username: created.username,
    role: created.role,
  });
  sendJson(res, 201, { admin: created });
});

on('POST', '/api/admins/:username/password', async (req, res, { username }) => {
  const who = requireWrite(req, 'accounts');
  const { password } = await readJson(req);
  const updated = await expected(() => auth.setPassword(username, password));
  store.note({
    action: 'account:password',
    actor: { kind: 'web', id: who.id, name: who.name },
    username: updated.username,
  });
  // Every session that account had is now refused — see the passwordAt check in
  // auth.session(). Said in the answer so the page can tell them so.
  sendJson(res, 200, { admin: updated, signedOut: true });
});

on('POST', '/api/admins/:username/role', async (req, res, { username }) => {
  const who = requireWrite(req, 'accounts');
  const { role } = await readJson(req);
  const updated = await expected(() => auth.setRole(username, role));
  store.note({
    action: 'account:role',
    actor: { kind: 'web', id: who.id, name: who.name },
    username: updated.username,
    role: updated.role,
  });
  sendJson(res, 200, { admin: updated });
});

on('DELETE', '/api/admins/:username', async (req, res, { username }) => {
  const who = requireWrite(req, 'accounts');
  await expected(() => auth.removeAdmin(username));
  store.note({ action: 'account:removed', actor: { kind: 'web', id: who.id, name: who.name }, username });
  sendJson(res, 200, { ok: true });
});

on('POST', '/api/admins/signout-all', (req, res) => {
  const who = requireWrite(req, 'accounts');
  auth.signOutEveryone();
  store.note({ action: 'account:signout-all', actor: { kind: 'web', id: who.id, name: who.name } });
  // Including the caller, which is deliberate: "sign everybody out" that quietly
  // spared the person who asked for it would be a different feature.
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
});

// --- TikTok's browser connect, unchanged -------------------------------------
//
// Same path, same bearer secret, same lockout, same single-flight. It is here so
// the Caddyfile keeps one upstream; the logic stayed in src/oauthServer.js
// because it is TikTok's flow rather than this panel's.

on('POST', '/tiktok/exchange', (req, res) => handleTikTokExchange(req, res));

// --- the page's own files, last -----------------------------------------------
//
// Registered after every API route on purpose. It matches any single-segment GET,
// so in front of them it would be the thing that answered a one-segment API path
// — with a 404 from the static handler rather than from the route that was meant
// to exist, which is a confusing way to discover a typo.
on('GET', '/:file', (req, res, { file }) => serveUi(res, file));

// ---------------------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  let status = 500;

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = match(r.pattern, path);
      if (!params) continue;
      await r.handler(req, res, params);
      // The handler owns the response. Streams and images write their own
      // headers and may still be piping, so there is nothing to conclude here.
      status = res.statusCode;
      return;
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    const known = e instanceof HttpError || Number.isInteger(e?.status);
    // Anything that did not come through expected() or an explicit HttpError is a
    // BUG, and is treated as one: a 500, logged in full. Handing those a 400 with
    // the message on it — which an earlier version did — made a TypeError look
    // like a rejected form field, and logged a stack for every wrong password.
    status = known ? e.status : 500;
    if (!known) console.error(`web: ${req.method} ${path} failed:`, e?.stack || e);
    if (!res.headersSent) {
      // An unexpected failure never explains itself to the browser. An admin panel
      // that prints internals is one that tells a stolen session about the
      // filesystem.
      sendJson(res, status, { ok: false, error: known ? String(e.message) : 'שגיאה לא צפויה — ראו את הלוג' });
    } else res.end();
  } finally {
    // Never a body, never a header, never a query string: a login POST has a
    // password in it and this line is what ends up in the journal.
    if (path !== '/api/events') console.log(`web: ${req.method} ${path} -> ${status}`);
  }
}

/**
 * Start the panel, and say plainly what state it is in.
 *
 * It starts even with no accounts, because the page it serves is the one that
 * tells you how to make one. It refuses nothing at boot; every route refuses on
 * its own, which is what keeps "is the server up" and "can anybody use it" as two
 * separate questions.
 */
export function startWebServer() {
  if (server) return server;

  const host = HOST();
  const port = PORT();

  server = createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(`web: unhandled ${e?.message || e}`);
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'שגיאה' });
        else res.end();
      } catch {}
    });
  });

  // A request that opens a socket and dawdles must not hold one open. The event
  // stream is exempt by nature — it is a response that never ends — which is why
  // the request timeout is set and not the overall one.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  // Long, because an SSE connection is meant to idle.
  server.keepAliveTimeout = 76_000;

  server.on('error', (e) => {
    // Worth surviving rather than taking the bot down with it: publishing does
    // not need this port, and a bot that refuses to start because a stale process
    // holds 8787 is a worse outcome than one whose panel is unreachable.
    console.error(
      e.code === 'EADDRINUSE'
        ? `web: ${host}:${port} is already in use — the panel did not start`
        : `web: server error: ${e.message}`
    );
    server = null;
  });

  server.listen(port, host, () => {
    console.log(`   panel: http://${host}:${port} · ${auth.count()} accounts`);
    if (!auth.count()) {
      console.log('   panel: NO ACCOUNTS YET — run `npm run admin -- add <username>` to make the first one');
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(
        `   panel: ⚠️  bound to ${host}, not localhost. This endpoint can publish to Instagram and TikTok ` +
          'and speaks plain HTTP — put a TLS proxy in front of it, or bind 127.0.0.1 and proxy to it.'
      );
    }
    if (!exchangeConfigured()) console.log('   tiktok connect: OFF (no TIKTOK_BOT_SECRET set)');
    else console.log('   tiktok connect: ON (POST /tiktok/exchange)');
  });

  return server;
}

/** Stop accepting, end the streams, and resolve once the port is free. */
export function stopWebServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  // The open event streams first. close() waits for responses to finish and an
  // SSE response never finishes on its own, so without this the port is held
  // until every watching browser happens to go away — and pm2 restart would greet
  // the replacement with EADDRINUSE.
  for (const close of [...streams]) {
    try {
      close();
    } catch {}
  }
  return new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections?.();
  });
}
