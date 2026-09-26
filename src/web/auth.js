import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import * as store from '../store.js';

// Who may drive the marketing from a browser.
//
// THE BOT'S LOCK IS UNCHANGED. bot.js answers exactly one Telegram id and refuses
// to start without it; nothing here widens that. These accounts are a second door
// onto the same actions, and the reason they exist is that "the owner's phone" is
// not a team — the moment somebody else has to approve a deck on a Friday, the
// alternative to this file is sharing a Telegram account.
//
// WHY PASSWORDS AND NOT TELEGRAM LOGIN
//
// Telegram's login widget is the obvious answer and it needs a public HTTPS
// domain registered against the bot, a callback, and a browser that can reach
// Telegram's CDN. This endpoint sits behind Caddy on a box whose whole job is
// serving JPEGs, and the first admin has to be creatable from an SSH session with
// no browser involved (see scripts/admin.js). A password with a real KDF and
// signed sessions is less clever and works everywhere, including on the day
// Telegram is the thing that is down.
//
// WHAT IS DELIBERATELY NOT HERE: password reset by email (there is no mail on
// this box, and a reset link is a second credential to protect), and sign-up. An
// account is created by somebody who already has one, or from the terminal.

// scrypt parameters. N=16384 is the Node default and takes ~50ms here, which is
// the right trade for a login page a handful of people use a few times a day:
// slow enough that a stolen store.json is not a list of passwords, fast enough
// that nobody notices.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = Math.max(1, Number(process.env.WEB_SESSION_DAYS ?? '14'));

// Failed sign-ins are answered slowly, and after a handful that username stops
// being answered at all for a few minutes. Per username rather than per IP for
// the reason src/oauthServer.js gives: behind a proxy the only address seen is
// Caddy's, and a forwarded header is a claim by the caller rather than a fact.
const FAIL_DELAY_MS = 400;
const LOCKOUT_AFTER = 6;
const LOCKOUT_MS = 5 * 60_000;
const attempts = new Map();

export const ROLES = ['owner', 'admin', 'viewer'];

// What each role may do. Checked by name at every mutating route rather than by
// "is not a viewer", so adding a capability means naming who gets it instead of
// discovering later that viewers had it all along.
const CAPABILITIES = {
  // Reading anything at all.
  read: ['owner', 'admin', 'viewer'],
  // Approving, rejecting, building, publishing — the marketing itself.
  act: ['owner', 'admin'],
  // The schedule and the copy rules: changes that affect every future post
  // rather than one of them.
  configure: ['owner', 'admin'],
  // Accounts, and signing everybody out.
  accounts: ['owner'],
};

export const can = (role, capability) => Boolean(CAPABILITIES[capability]?.includes(role));
export const capabilitiesOf = (role) =>
  Object.keys(CAPABILITIES).filter((c) => can(role, c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mintSecret = () => randomBytes(32).toString('hex');

/**
 * Hash a password for storage.
 *
 * A fresh salt per account, so two admins who choose the same password do not
 * have the same hash — which is what makes a leaked store worth less than the
 * accounts in it.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash };
}

/**
 * Compare without leaking how much of the hash matched.
 *
 * Both sides are the same fixed width by construction (scrypt output), so
 * timingSafeEqual cannot throw on a length mismatch — which would itself be an
 * early exit, and the thing a constant-time compare exists to avoid.
 */
function passwordOk(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const want = Buffer.from(record.hash, 'hex');
  const got = scryptSync(String(password), record.salt, want.length, SCRYPT);
  return timingSafeEqual(want, got);
}

/**
 * How strict to be about a new password.
 *
 * Length only, deliberately. Composition rules ("one capital, one symbol") push
 * people towards Passw0rd! and towards writing it on something; a floor of twelve
 * characters on an endpoint that is not exposed to the internet is the honest
 * trade. The floor is not negotiable from the browser.
 */
export function checkPassword(password) {
  const p = String(password ?? '');
  if (p.length < 12) return 'הסיסמה צריכה להיות לפחות 12 תווים';
  if (p.length > 200) return 'הסיסמה ארוכה מדי';
  return null;
}

export function checkUsername(username) {
  const u = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(u)) {
    return 'שם משתמש: אותיות לטיניות קטנות, ספרות, נקודה, מקף או קו תחתון (2–31 תווים)';
  }
  return null;
}

// --- accounts ----------------------------------------------------------------

/**
 * Create an account.
 *
 * The FIRST account is forced to be an owner, whatever was asked for. An install
 * whose only account cannot manage accounts is an install that needs a terminal
 * to add the second one, which defeats the point of having the page.
 */
export function createAdmin({ username, password, name = null, role = 'admin' }) {
  const badUser = checkUsername(username);
  if (badUser) throw new Error(badUser);
  const badPass = checkPassword(password);
  if (badPass) throw new Error(badPass);

  const key = String(username).trim().toLowerCase();
  if (store.adminByUsername(key)) throw new Error(`המשתמש ${key} כבר קיים`);
  const first = store.adminCount() === 0;
  const wanted = ROLES.includes(role) ? role : 'admin';

  const { salt, hash } = hashPassword(password);
  return strip(
    store.putAdmin({
      id: randomUUID(),
      username: key,
      name: name ? String(name).slice(0, 60) : key,
      role: first ? 'owner' : wanted,
      salt,
      hash,
      createdAt: Date.now(),
      lastLoginAt: null,
    })
  );
}

export function setPassword(username, password) {
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  const existing = store.adminByUsername(username);
  if (!existing) throw new Error('אין משתמש כזה');
  const { salt, hash } = hashPassword(password);
  // Every session this account had is signed by the shared secret, so changing a
  // password does not by itself end them. `passwordAt` is what does: sessions
  // minted before it are refused in `session()` below.
  return strip(store.putAdmin({ ...existing, salt, hash, passwordAt: Date.now() }));
}

export function setRole(username, role) {
  if (!ROLES.includes(role)) throw new Error('תפקיד לא מוכר');
  const existing = store.adminByUsername(username);
  if (!existing) throw new Error('אין משתמש כזה');
  // The last owner may not demote themselves. Otherwise an install ends up with
  // nobody who can manage accounts and the only way back is the terminal.
  if (existing.role === 'owner' && role !== 'owner' && owners().length < 2) {
    throw new Error('זה הבעלים היחיד — קדם מישהו אחר לבעלים קודם');
  }
  return strip(store.putAdmin({ ...existing, role }));
}

export function removeAdmin(username) {
  const existing = store.adminByUsername(username);
  if (!existing) throw new Error('אין משתמש כזה');
  if (existing.role === 'owner' && owners().length < 2) {
    throw new Error('זה הבעלים היחיד — אי אפשר למחוק אותו');
  }
  store.removeAdmin(username);
  return true;
}

const owners = () => store.adminList().filter((a) => a.role === 'owner');
const strip = ({ hash, salt, ...rest }) => rest;

export const list = () => store.adminList();
export const count = () => store.adminCount();

// --- signing in --------------------------------------------------------------

/**
 * Check a username and password.
 *
 * Wrong answers are slow and, after a few, refused outright for a while. The
 * delay is on the FAILURE path only — a correct password is answered at once, so
 * the lockout costs nothing to the people it is protecting.
 */
export async function signIn(username, password) {
  const key = String(username ?? '').trim().toLowerCase();
  const state = attempts.get(key);
  if (state && state.lockedUntil > Date.now()) {
    const mins = Math.ceil((state.lockedUntil - Date.now()) / 60_000);
    throw new Error(`יותר מדי נסיונות — נסה שוב בעוד ${mins} דקות`);
  }

  const record = store.adminByUsername(key);
  // The password is checked even when there is no such user, against a throwaway
  // hash. Otherwise "no such user" returns in a millisecond and "wrong password"
  // in fifty, which turns this endpoint into a list of who has an account.
  const ok = record ? passwordOk(password, record) : passwordOk(password, decoy());

  if (!ok || !record) {
    const next = { fails: (state?.fails || 0) + 1, lockedUntil: 0 };
    if (next.fails >= LOCKOUT_AFTER) {
      next.lockedUntil = Date.now() + LOCKOUT_MS;
      next.fails = 0;
      console.warn(`web auth: ${key || '(blank)'} locked out for ${LOCKOUT_MS / 60_000} minutes`);
    }
    attempts.set(key, next);
    await sleep(FAIL_DELAY_MS);
    throw new Error('שם משתמש או סיסמה שגויים');
  }

  attempts.delete(key);
  store.putAdmin({ ...record, lastLoginAt: Date.now() });
  return { admin: strip(record), token: mintSession(record) };
}

// A stable decoy, computed once, so the no-such-user path costs the same scrypt
// work as the real one. Its password is random and never returned as a match.
let decoyRecord = null;
function decoy() {
  decoyRecord ??= hashPassword(randomBytes(32).toString('hex'));
  return decoyRecord;
}

// --- sessions ----------------------------------------------------------------
//
// A signed value rather than a server-side table, for the same reason the rest of
// this project has no database: the process restarts (pm2 does it routinely) and
// a table in memory would sign everybody out every time. The signing key is
// persisted in the store, so restarts are invisible and rotating the key is the
// deliberate "sign everybody out" action.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const secret = () => store.webSecret(mintSecret);
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

function mintSession(admin) {
  const body = b64(
    JSON.stringify({
      id: admin.id,
      u: admin.username,
      // When it was minted, stored rather than derived from `exp`. Subtracting
      // SESSION_DAYS to recover it would silently change the meaning of every
      // existing cookie the moment WEB_SESSION_DAYS is edited, which is exactly
      // the kind of check that looks right and stops working.
      iat: Date.now(),
      exp: Date.now() + SESSION_DAYS * 86_400_000,
      // Minted with the session so a CSRF token can be checked without a second
      // store lookup, and so it changes whenever the session does.
      csrf: randomBytes(16).toString('hex'),
    })
  );
  return `${body}.${sign(body)}`;
}

/**
 * The account behind a cookie, or null.
 *
 * Every reason to say no is checked: the signature, the expiry, whether the
 * account still exists, whether its role still exists, and whether its password
 * has changed since the cookie was minted. That last one is what makes "reset a
 * password" also mean "end that person's sessions", which is what somebody
 * resetting a password believes they are doing.
 */
export function session(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return null;
  const body = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);

  const want = Buffer.from(sign(body), 'utf8');
  const got = Buffer.from(mac, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  let claims;
  try {
    claims = JSON.parse(unb64(body));
  } catch {
    return null;
  }
  if (!claims?.id || !(Number(claims.exp) > Date.now())) return null;

  const admin = store.adminById(claims.id);
  if (!admin) return null;
  if (admin.passwordAt && Number(claims.iat || 0) < admin.passwordAt) return null;
  if (!ROLES.includes(admin.role)) return null;

  return {
    id: admin.id,
    username: admin.username,
    name: admin.name || admin.username,
    role: admin.role,
    kind: 'web',
    csrf: claims.csrf || null,
    capabilities: capabilitiesOf(admin.role),
  };
}

/** Sign every open session out, by replacing the key they were all signed with. */
export function signOutEveryone() {
  store.rotateWebSecret(mintSecret);
  return true;
}

export const sessionDays = () => SESSION_DAYS;

/** For tests: forget the lockout counters. */
export const __reset = () => attempts.clear();
