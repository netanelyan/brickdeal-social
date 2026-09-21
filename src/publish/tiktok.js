import * as store from '../store.js';
import { cardHostConfigured, tiktokVerifiedDomains, unverifiedTikTokHosts } from './imageHosts.js';

// TikTok publishing, through the official Content Posting API only.
//
// The shape is close to Instagram's and deliberately so — init a post, poll
// until TikTok says it finished, report what happened — but three things differ
// enough to be worth naming up front:
//
//   1. The access token lives about 24 HOURS, not 60 days. Instagram's refresh
//      is a background nicety; here it is load-bearing, and refreshBefore() runs
//      on the publish path itself rather than only on a daily timer. A bot that
//      slept through its refresh tick must still be able to publish on waking.
//   2. The creator has to be shown the privacy level before publishing. That is
//      TikTok's rule for Direct Post, not ours, and creatorInfo() is where the
//      offered levels come from.
//
//      It was written here that an unaudited app is given SELF_ONLY and nothing
//      else. THAT IS NOT TRUE, and believing it cost a deck. creator_info
//      reports what the ACCOUNT supports, not what this CLIENT may use — an
//      unaudited app against a public account is offered all three levels,
//      offers them to you, and is then refused at init with
//      unaudited_client_can_only_post_to_private_accounts. The list is a
//      courtesy, not a guarantee, and the refusal is handled as a card-level
//      failure rather than as TikTok being down.
//   3. Photo posts are PULL_FROM_URL only. There is no byte-upload path for
//      images, so the same public card URL Instagram fetches is required here,
//      AND the domain it sits on must be verified in the developer portal.
//      An unverified domain fails at init with url_ownership_unverified.
//
// The publishing handshake:
//   1. POST /v2/post/publish/creator_info/query/  -> who, and which privacy levels
//   2. POST /v2/post/publish/content/init/        -> a publish_id
//   3. POST /v2/post/publish/status/fetch/        -> poll until PUBLISH_COMPLETE

const API = 'https://open.tiktokapis.com';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';

export const SCOPES = ['user.info.basic', 'video.publish'];

// Every privacy level TikTok defines, in the order we cycle them in the
// approval message. What is actually offered comes from creatorInfo() — this is
// only the Hebrew for whatever comes back, and the sort order.
export const PRIVACY_HE = {
  PUBLIC_TO_EVERYONE: 'ציבורי',
  MUTUAL_FOLLOW_FRIENDS: 'חברים',
  FOLLOWER_OF_CREATOR: 'עוקבים',
  SELF_ONLY: 'פרטי (רק אני)',
};
const PRIVACY_ORDER = Object.keys(PRIVACY_HE);

export const privacyHe = (level) => PRIVACY_HE[level] || level;

export const tiktokConfigured = () =>
  Boolean(
    process.env.TIKTOK_CLIENT_KEY &&
      process.env.TIKTOK_CLIENT_SECRET &&
      store.getTikTokToken()?.accessToken &&
      cardHostConfigured()
  );

/**
 * How many photo posts an unaudited client may publish in 24 hours.
 *
 * TikTok's number, not ours, and the one limit in this file that must never be
 * routed around — including by the owner override, which bypasses every guard
 * this project invented and none that TikTok did. Configurable only downward in
 * practice: raising it past what TikTok allows just moves the refusal from here
 * to their API, where it costs a post and reads as an outage.
 */
export const TIKTOK_DAILY_CAP = () => Math.max(1, Number(process.env.TIKTOK_DAILY_CAP ?? '5'));

export class TikTokError extends Error {
  constructor(message, { step, code, logId } = {}) {
    super(message);
    this.step = step;
    this.code = code;
    this.logId = logId;
  }
}

// Error codes worth translating, because the message alone does not say what to
// do about it. Short on purpose: guessing wrong about an unknown code is worse
// than printing it and letting you look it up.
const CODE_HINTS = {
  access_token_invalid: 'הטוקן פג או נפסל — npm run tiktok-token',
  scope_not_authorized: 'ההרשאה video.publish לא אושרה לאפליקציה',
  scope_permission_missed: 'ההרשאה video.publish לא נכללה בהתחברות — npm run tiktok-token',
  url_ownership_unverified: 'הדומיין של הכרטיס לא מאומת ב-Developer Portal',
  privacy_level_option_mismatch: 'רמת הפרטיות לא זמינה לחשבון הזה כרגע',
  unaudited_client_can_only_post_to_private_accounts:
    'האפליקציה עוד לא עברה אודיט בטיקטוק, ולכן מותר לה לפרסם רק ב"פרטי (רק אני)". ' +
    'בחרו פרטיות פרטי בכרטיס האישור, או הגישו את האפליקציה ל-audit כדי לפרסם ציבורי.',
  spam_risk_too_many_posts: 'חריגה ממכסת הפרסום היומית של טיקטוק',
  spam_risk_user_banned_from_posting: 'החשבון חסום לפרסום בטיקטוק',
  reached_active_user_cap: 'חריגה במספר המשתמשים של האפליקציה (sandbox)',
  rate_limit_exceeded: 'חריגה בקצב הקריאות — יתפנה מעצמו',
  // Ours, not TikTok's. Raised by the preflight below, before any call goes
  // out, because TikTok's own answer to an unverified domain is not reliably
  // an error — it can simply decline to fetch and leave the post unfinished.
  image_host_unverified:
    'הדומיין של התמונות לא מאומת ב-TikTok Developer Portal (URL properties). ' +
    'אמתו אותו שם, או הוסיפו אותו ל-TIKTOK_VERIFIED_DOMAINS אם הוא כבר מאומת.',
  tiktok_daily_cap: 'הגעתם למכסת הפרסום של טיקטוק ל-24 שעות. הפוסט ממתין ויפורסם כשהמכסה תתפנה.',
  no_publish_id: 'טיקטוק אישרה את הבקשה אך לא החזירה publish_id — נסו שוב',
};

/**
 * Codes that are about THIS CARD rather than about TikTok.
 *
 * The distinction the publish loop needs: a destination that is having a bad
 * day should be retried and, after enough failures, marked degraded so the
 * backlog stops throwing calls at it. A card asking for something it may not
 * have should be given up on, and the destination left alone — because the very
 * next card, asking for something allowed, will publish perfectly well.
 *
 * Both of these are the second kind. `unaudited_client...` means this app may
 * only post SELF_ONLY; a card that asked for public is refused and one that
 * asks for private is not. Scoring that as a TikTok outage degraded the whole
 * destination and held every good card behind it.
 */
const CARD_LEVEL_CODES = new Set([
  'unaudited_client_can_only_post_to_private_accounts',
  'privacy_level_option_mismatch',
]);

/**
 * Is this failure the card's fault rather than the destination's?
 *
 * `step: 'config'` covers what we refuse before calling out — no privacy level,
 * a non-https image URL, more than 35 images. The codes above are the same
 * thing decided at TikTok's end instead of ours.
 */
export const isCardLevel = (e) =>
  e instanceof TikTokError &&
  !isPlatformLimit(e) &&
  (e.step === 'config' || CARD_LEVEL_CODES.has(e.code));

/**
 * Codes that mean "not now" rather than "not this card" or "TikTok is broken".
 *
 * A third category, and it needs to be separate from both of the others. An
 * unaudited client gets five posts a day; the sixth is refused. That is not the
 * card's fault (it will publish perfectly tomorrow, so abandoning it throws
 * away an approved post) and it is not an outage (TikTok is working exactly as
 * documented, so degrading the destination and burying the backlog behind it is
 * precisely wrong).
 *
 * It is a wait. The card is held, the destination keeps its health, and the
 * owner is told which limit it was and when it lifts — because a post that
 * silently does not happen is the failure this whole exercise started from.
 */
const PLATFORM_LIMIT_CODES = new Set(['spam_risk_too_many_posts', 'rate_limit_exceeded']);

export const isPlatformLimit = (e) =>
  e instanceof TikTokError && (e.step === 'platform_limit' || PLATFORM_LIMIT_CODES.has(e.code));

/** A failure line you can act on: the code and the step, not just the sentence. */
export function describeError(e) {
  if (!(e instanceof TikTokError)) return e?.message || String(e);
  const bits = [];
  if (e.code) bits.push(`code ${e.code}`);
  if (e.step) bits.push(`step ${e.step}`);
  const detail = bits.length ? `${e.message} [${bits.join(', ')}]` : e.message;
  const hint = CODE_HINTS[e.code];
  return hint ? `${detail}\n   ${hint}` : detail;
}

/**
 * One API call.
 *
 * TikTok answers 200 with `error.code: 'ok'` on success and 200 with a real
 * code on most failures, so the HTTP status is not the thing to branch on.
 */
async function api(path, { body = null, token, step } = {}) {
  let res;
  let json;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body ?? {}),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw new TikTokError(`network error: ${e.message}`, { step });
  }

  const err = json.error || {};
  if (!res.ok || (err.code && err.code !== 'ok')) {
    throw new TikTokError(err.message || `HTTP ${res.status}`, {
      step,
      code: err.code,
      logId: err.log_id,
    });
  }
  return json.data || {};
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                      */
/* -------------------------------------------------------------------------- */

/** The URL you open once, in a browser, to connect the account. */
export function authorizeUrl({ state = 'tiyulplus' } = {}) {
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    scope: SCOPES.join(','),
    response_type: 'code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI || '',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

/**
 * Swap an authorization code (or a refresh token) for a live token pair.
 *
 * The token endpoint is form-encoded and unauthenticated, unlike every other
 * call in this file — it is the one place the client secret is sent.
 */
async function token(params, step) {
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    client_secret: process.env.TIKTOK_CLIENT_SECRET || '',
    ...params,
  });

  let res;
  let json;
  try {
    res = await fetch(`${API}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw new TikTokError(`network error: ${e.message}`, { step });
  }

  // The token endpoint reports failures as `error` + `error_description`, a
  // different shape from every other endpoint's `error.code`.
  if (!res.ok || json.error || !json.access_token) {
    throw new TikTokError(json.error_description || json.error || `HTTP ${res.status}`, {
      step,
      code: json.error,
      logId: json.log_id,
    });
  }
  return json;
}

const SECOND = 1000;

function persist(t) {
  store.setTikTokToken({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    // Both clocks matter and they are wildly different lengths: the access
    // token is a day, the refresh token a year. Losing track of the second one
    // is the failure that cannot be repaired without a browser.
    expiresAt: Date.now() + (Number(t.expires_in) || 86_400) * SECOND,
    refreshExpiresAt: Date.now() + (Number(t.refresh_expires_in) || 365 * 86_400) * SECOND,
    openId: t.open_id || store.getTikTokToken()?.openId || null,
    scope: t.scope || null,
  });
}

/**
 * First connection: the code from the redirect URL becomes a stored token.
 *
 * `redirectUri` overrides TIKTOK_REDIRECT_URI for callers who were told which
 * one the code was issued against — the browser flow in src/oauthServer.js is
 * handed it by the callback page. TikTok requires the value here to match the
 * one used at authorize time exactly, so the caller that knows it should say
 * so; everything else keeps getting the configured default.
 */
export async function exchangeCode(code, { redirectUri } = {}) {
  const t = await token(
    {
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri || process.env.TIKTOK_REDIRECT_URI || '',
    },
    'exchange_code'
  );
  persist(t);
  return t;
}

// Refresh with hours to spare rather than minutes. The drip fires every four
// hours, so a token that merely "has not expired yet" at the top of a publish
// can still be dead by the time the retry comes round.
const REFRESH_WHEN_HOURS_LEFT = 6;

/**
 * Keep the access token alive.
 *
 * Returns { refreshed, hoursLeft } and does not throw for a routine "not due".
 */
export async function refreshTikTokToken({ force = false } = {}) {
  const saved = store.getTikTokToken();
  if (!saved?.refreshToken) return { refreshed: false, reason: 'no token configured' };

  const hoursLeft = saved.expiresAt ? (saved.expiresAt - Date.now()) / 3_600_000 : null;
  if (!force && hoursLeft !== null && hoursLeft > REFRESH_WHEN_HOURS_LEFT) {
    return { refreshed: false, hoursLeft, reason: 'not due yet' };
  }

  const t = await token(
    { grant_type: 'refresh_token', refresh_token: saved.refreshToken },
    'refresh_token'
  );
  persist(t);
  const now = store.getTikTokToken();
  return { refreshed: true, hoursLeft: (now.expiresAt - Date.now()) / 3_600_000 };
}

/** Hours until the access token lapses, or null if unknown. */
export function tokenHoursLeft() {
  const saved = store.getTikTokToken();
  if (!saved?.expiresAt) return null;
  return Math.round((saved.expiresAt - Date.now()) / 3_600_000);
}

/** Days until the REFRESH token lapses — the one that needs a browser to replace. */
export function refreshTokenDaysLeft() {
  const saved = store.getTikTokToken();
  if (!saved?.refreshExpiresAt) return null;
  return Math.round((saved.refreshExpiresAt - Date.now()) / 86_400_000);
}

/** The access token to use right now, refreshing first if it is close to lapsing. */
async function liveToken(step) {
  let refreshError = null;
  await refreshTikTokToken().catch((e) => {
    // A refresh failure is only fatal if the current token is also dead, and
    // that is the next check's job — surfacing it here would turn a recoverable
    // publish into a failed one.
    //
    // It is kept rather than only logged, though. When the token turns out to
    // be expired too, the refresh failure IS the explanation, and throwing
    // "token expired" while the reason it could not be renewed scrolls past in
    // a log is how you debug the wrong thing for an afternoon.
    refreshError = e;
    console.error(`tiktok: refresh failed: ${e.message}`);
  });

  const saved = store.getTikTokToken();
  if (!saved?.accessToken) {
    throw new TikTokError(
      refreshError
        ? `no usable TikTok token: refresh failed (${refreshError.message}) — npm run tiktok-token`
        : 'no TikTok token stored — npm run tiktok-token',
      { step, code: refreshError?.code }
    );
  }

  // Expired and un-renewable is a different failure from "not configured", and
  // it has a different fix: the refresh token has to be replaced in a browser.
  if (saved.expiresAt && saved.expiresAt <= Date.now()) {
    const daysLeft = refreshTokenDaysLeft();
    throw new TikTokError(
      `TikTok access token expired ${Math.round((Date.now() - saved.expiresAt) / 60_000)} min ago` +
        (refreshError ? ` and refresh failed: ${refreshError.message}` : '') +
        (daysLeft !== null && daysLeft <= 0
          ? ' — the refresh token has expired too, reconnect with npm run tiktok-token'
          : ''),
      { step, code: refreshError?.code || 'access_token_invalid' }
    );
  }

  return saved.accessToken;
}

/* -------------------------------------------------------------------------- */
/* Creator info — required before every Direct Post                            */
/* -------------------------------------------------------------------------- */

/**
 * Who we are about to post as, and what privacy levels that account may use.
 *
 * TikTok requires this call before a Direct Post, and requires the creator to
 * see the privacy level before it goes out.
 *
 * What the list does NOT tell you is whether this app may actually use those
 * levels. It describes the account, not the client, so an unaudited app is
 * shown every level a public account supports and is refused at init if it
 * picks one. Treat the options as what to offer, never as what will be allowed.
 */
export async function creatorInfo() {
  const t = await liveToken('creator_info');
  const d = await api('/v2/post/publish/creator_info/query/', { token: t, step: 'creator_info' });

  const options = (d.privacy_level_options || []).slice().sort(
    (a, b) => PRIVACY_ORDER.indexOf(a) - PRIVACY_ORDER.indexOf(b)
  );
  return {
    username: d.creator_username || null,
    nickname: d.creator_nickname || null,
    options,
    commentDisabled: Boolean(d.comment_disabled),
  };
}

/**
 * The privacy level to offer by default.
 *
 * Preference order: what the owner picked for this card, then TIKTOK_PRIVACY
 * from .env, then the most private option the account actually has. Never a
 * hardcoded PUBLIC_TO_EVERYONE — defaulting to the loudest possible setting is
 * the wrong way round for a default.
 */
export function defaultPrivacy(options = [], preferred = process.env.TIKTOK_PRIVACY) {
  if (preferred && options.includes(preferred)) return preferred;
  if (options.includes('SELF_ONLY')) return 'SELF_ONLY';
  return options[0] || 'SELF_ONLY';
}

/** The next level in the cycle, for the privacy button in the approval message. */
export function nextPrivacy(current, options = []) {
  if (!options.length) return current;
  const i = options.indexOf(current);
  return options[(i + 1) % options.length];
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

// TikTok downloads the image itself, so "initialised" is not "published".
// Polling turns a generic later failure into a named one we can print.
async function waitForPublish(publishId, tok, { timeoutMs = 120_000, intervalMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  // One transient poll failure is not a failed post. The photos are already
  // uploading at TikTok's end and the publish either completes or does not,
  // regardless of whether one status call timed out — so a network blip here
  // must not be reported as a publish failure, which would send the card back
  // round to be posted a second time.
  let pollErrors = 0;
  const POLL_ERRORS_ALLOWED = 3;

  for (;;) {
    let d;
    try {
      d = await api('/v2/post/publish/status/fetch/', {
        token: tok,
        body: { publish_id: publishId },
        step: 'status',
      });
      pollErrors = 0;
    } catch (e) {
      // An auth or argument error will not fix itself by asking again.
      if (++pollErrors > POLL_ERRORS_ALLOWED || e.code) {
        throw new TikTokError(
          `could not read publish status for ${publishId} after ${pollErrors} attempts: ${e.message}`,
          { step: 'status', code: e.code, logId: e.logId }
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    last = d.status || last;
    if (d.status === 'PUBLISH_COMPLETE') return d;

    if (d.status === 'FAILED') {
      // `fail_reason` is the actionable half and it is not always present;
      // naming the publish_id keeps a failed post findable in TikTok's logs
      // when it is not.
      throw new TikTokError(
        `publish failed: ${d.fail_reason || 'no reason given'} (publish_id ${publishId})`,
        { step: 'status', code: d.fail_reason }
      );
    }

    if (Date.now() > deadline) {
      // Deliberately not a card-level failure. A photo post that is still
      // PROCESSING when we stop watching has very often published a moment
      // later — TikTok downloads every image itself, and a slow fetch of a
      // large deck looks exactly like this. Reporting the publish_id matters
      // more than the timeout does, because that is what makes it checkable
      // rather than a post that may or may not exist.
      throw new TikTokError(
        `still ${last || 'unknown'} after ${Math.round(timeoutMs / 1000)}s — ` +
          `TikTok may still finish it. publish_id ${publishId}`,
        { step: 'status', code: 'status_timeout' }
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A photo post takes at most 35 images. TikTok's number.
const MAX_PHOTOS = 35;

/**
 * Which privacy level this post actually goes out at, and why.
 *
 * The rule that must not bend: never publish MORE widely than the owner was
 * shown. Everything below either uses what they saw or moves strictly toward
 * private, and every path returns a `note` when it did anything other than use
 * their choice verbatim — the approval card promised a privacy level, and a
 * post that quietly went out at a different one breaks the promise the whole
 * Direct Post flow exists to keep.
 *
 * What changed here: a card staged while TikTok was unreachable has no privacy
 * level, and that used to be the end of it — the card was unpublishable forever
 * and /retry could not help, because the level is attached once at staging and
 * never re-read. It is re-read now.
 */
export async function resolvePrivacy(cand, { allowRefetch = true } = {}) {
  const shown = cand.tiktok?.privacy || null;
  const knownOptions = cand.tiktok?.options?.length ? cand.tiktok.options : null;

  // Always ask, rather than trusting what was stored at staging.
  //
  // The stored options are a photograph of the account taken when the card was
  // built, and this pipeline holds approved posts for hours and held ones for
  // days. They go stale in the one direction that matters: a card staged while
  // @tiyulplus was PUBLIC carries options:['PUBLIC_TO_EVERYONE', ...], and
  // believing that list would publish it publicly today — from an unaudited
  // client, against an account that is now private, which TikTok refuses
  // anyway. Trusting the snapshot is how a post goes out at a privacy level
  // the account no longer has.
  //
  // The call is not an extra cost either: TikTok requires creator_info before
  // every Direct Post. Asking here is what the documented flow actually wants.
  let offered = knownOptions;
  let refetchError = null;
  if (allowRefetch) {
    try {
      offered = (await creatorInfo()).options;
    } catch (e) {
      // Fall back to the snapshot. It is worse than a fresh answer and much
      // better than nothing, and the level it produces is still checked below.
      refetchError = e;
    }
  }

  // The owner chose a level the account no longer offers — going private is the
  // only safe direction, and it is said out loud rather than assumed.
  if (shown) {
    if (offered?.length && !offered.includes(shown)) {
      const fallback = defaultPrivacy(offered);
      return {
        privacy: fallback,
        source: 'downgraded',
        offered,
        note:
          `רמת הפרטיות שנבחרה (${privacyHe(shown)}) כבר לא זמינה לחשבון — ` +
          `פורסם ב${privacyHe(fallback)} במקום`,
      };
    }
    return { privacy: shown, source: 'approval', offered, note: null };
  }

  // Nothing was shown. Re-fetch decided it if it could; otherwise fall back to
  // the configured level and finally to the most private one there is.
  if (offered?.length) {
    const chosen = defaultPrivacy(offered);
    return {
      privacy: chosen,
      source: 'refetched',
      offered,
      note: `לא נבחרה רמת פרטיות באישור — נקראה מחדש מטיקטוק ופורסם ב${privacyHe(chosen)}`,
    };
  }

  const chosen = process.env.TIKTOK_PRIVACY || 'SELF_ONLY';
  return {
    privacy: chosen,
    source: refetchError ? 'fallback_after_error' : 'fallback',
    offered: null,
    note:
      `לא נבחרה רמת פרטיות באישור` +
      (refetchError ? ` וקריאת creator_info נכשלה (${refetchError.message})` : '') +
      ` — פורסם ב${privacyHe(chosen)}`,
  };
}

/**
 * Everything that can be checked about a post before a single call goes out.
 *
 * Separated from publishTikTok so the dry run can exercise exactly this and
 * stop. These are the refusals that used to be scattered through the publish
 * path as bare throws; each one now names the specific thing that is wrong
 * rather than the rule it broke.
 *
 * Returns { images, notes } — `notes` being anything that was quietly repaired
 * and therefore has to be said out loud.
 */
export function preflight(cand) {
  const notes = [];

  // A deck publishes its slides in order; a single card publishes as a
  // one-image photo post. Both are the same API call — `photo_images` is an
  // array either way — which is why there is no separate publishDeck().
  let images = cand.deck?.urls?.tiktok?.length ? cand.deck.urls.tiktok : [cand.card?.url];

  const missing = images.filter((u) => !u).length;
  if (!images.length || missing === images.length) {
    throw new TikTokError(
      'no public image URL — TikTok fetches the images itself, so the card must be on a public https host ' +
        '(CARD_PUBLIC_BASE_URLS / CARD_PUBLIC_BASE_URL)',
      { step: 'config' }
    );
  }
  // Some slides rendered and some did not. Publishing the gaps would post a
  // deck with holes in it, so this is a refusal, but it names the count.
  if (missing) {
    throw new TikTokError(
      `${missing} of ${images.length} slides have no public URL — the render wrote them but CARD_PUBLIC_BASE_URL does not cover them`,
      { step: 'config' }
    );
  }

  const notHttps = images.filter((u) => !u.startsWith('https://'));
  if (notHttps.length) {
    throw new TikTokError(
      `every image URL must be https — ${notHttps.length} is not: ${[...new Set(notHttps)].slice(0, 3).join(', ')}`,
      { step: 'config' }
    );
  }

  // THE domain check. TikTok will not fetch an image from a domain that is not
  // verified under URL properties in the developer portal, and it does not
  // reliably say so — an unverified host can simply never be downloaded, which
  // surfaces as a post stuck in PROCESSING rather than as an error. Better to
  // refuse here, by name, than to be told nothing by TikTok.
  const domains = tiktokVerifiedDomains();
  if (!domains.length) {
    throw new TikTokError(
      'no TikTok-verified image domain is configured — set TIKTOK_VERIFIED_DOMAINS to the domains verified ' +
        'under URL properties in the developer portal',
      { step: 'config', code: 'image_host_unverified' }
    );
  }
  const unverified = unverifiedTikTokHosts(images, domains);
  if (unverified.length) {
    throw new TikTokError(
      `image host not verified with TikTok: ${unverified.join(', ')} — verified: ${domains.join(', ')}`,
      { step: 'config', code: 'image_host_unverified' }
    );
  }

  // Self-heal rather than refuse: a deck this long is a bug upstream, but the
  // first 35 slides are a publishable post and losing the whole thing helps
  // nobody. Said out loud, because a post that quietly dropped slides is the
  // kind of thing you find out about from a follower.
  if (images.length > MAX_PHOTOS) {
    notes.push(
      `הדק כלל ${images.length} שקופיות; טיקטוק מקבלת ${MAX_PHOTOS} — פורסמו ${MAX_PHOTOS} הראשונות`
    );
    images = images.slice(0, MAX_PHOTOS);
  }

  return { images, notes };
}

/**
 * Publish one approved card as a photo post.
 *
 * `dryRun` runs every check, refreshes the token and asks TikTok who we are —
 * everything except the one call that creates a post. That line is drawn at
 * `content/init/` because it is the only irreversible step; stopping anywhere
 * earlier would leave the interesting half untested.
 */
export async function publishTikTok(cand, { dryRun = false } = {}) {
  if (!tiktokConfigured()) {
    throw new TikTokError(
      'TikTok is not configured (needs TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, a stored token and ' +
        'CARD_PUBLIC_BASE_URLS or CARD_PUBLIC_BASE_URL)',
      { step: 'config' }
    );
  }

  const { images, notes } = preflight(cand);

  // TikTok's limit, checked before the call rather than discovered by being
  // refused. Not bypassable by the owner override — see TIKTOK_DAILY_CAP.
  const cap = TIKTOK_DAILY_CAP();
  const used = store.tiktokPostsInLast24h();
  if (used >= cap) {
    const freesAt = store.tiktokCapFreesAt();
    const mins = freesAt ? Math.max(1, Math.round((freesAt - Date.now()) / 60_000)) : null;
    throw new TikTokError(
      `TikTok's 24h limit reached: ${used}/${cap} posts already published` +
        (mins ? ` — the next slot frees in about ${mins} min` : ''),
      { step: 'platform_limit', code: 'tiktok_daily_cap' }
    );
  }

  // Before init, so a token that cannot be renewed is reported as a token
  // problem rather than as whatever init says about an expired bearer.
  const t = await liveToken(dryRun ? 'dry_run' : 'init');

  const { privacy, source: privacySource, offered, note } = await resolvePrivacy(cand);
  if (note) notes.push(note);

  if (dryRun) {
    return {
      dryRun: true,
      publishId: null,
      images,
      slides: images.length,
      privacy,
      privacySource,
      offered,
      notes,
      capUsed: used,
      cap,
    };
  }

  const d = await api('/v2/post/publish/content/init/', {
    token: t,
    step: 'init',
    body: {
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
      post_info: {
        title: String(cand.headline || '').slice(0, 90),
        description: cand.tiktokCaption || '',
        privacy_level: privacy,
        disable_comment: false,
        auto_add_music: true,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: images,
      },
    },
  });

  // A 200 with no publish_id means TikTok accepted the request and gave us
  // nothing to track it with. Retrying is right and safe — nothing was created
  // that we could duplicate — so this is not a card-level failure.
  if (!d.publish_id) {
    throw new TikTokError('TikTok accepted the post but returned no publish_id', {
      step: 'init',
      code: 'no_publish_id',
    });
  }

  await waitForPublish(d.publish_id, t);

  return { publishId: d.publish_id, images, slides: images.length, privacy, privacySource, notes };
}
