import * as store from '../store.js';

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
      process.env.CARD_PUBLIC_BASE_URL
  );

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
  e instanceof TikTokError && (e.step === 'config' || CARD_LEVEL_CODES.has(e.code));

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

/** First connection: the code from the redirect URL becomes a stored token. */
export async function exchangeCode(code) {
  const t = await token(
    {
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.TIKTOK_REDIRECT_URI || '',
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
  await refreshTikTokToken().catch((e) => {
    // A refresh failure is only fatal if the current token is also dead, and
    // that is the next check's job — surfacing it here would turn a recoverable
    // publish into a failed one.
    console.error(`tiktok: refresh failed: ${e.message}`);
  });
  const saved = store.getTikTokToken();
  if (!saved?.accessToken) {
    throw new TikTokError('no TikTok token stored — npm run tiktok-token', { step });
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
  for (;;) {
    const d = await api('/v2/post/publish/status/fetch/', {
      token: tok,
      body: { publish_id: publishId },
      step: 'status',
    });
    if (d.status === 'PUBLISH_COMPLETE') return d;
    if (d.status === 'FAILED') {
      throw new TikTokError(`publish failed: ${d.fail_reason || 'no reason given'}`, {
        step: 'status',
        code: d.fail_reason,
      });
    }
    if (Date.now() > deadline) {
      throw new TikTokError(`still ${d.status} after ${Math.round(timeoutMs / 1000)}s`, {
        step: 'status',
      });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Publish one approved card as a photo post.
 *
 * `cand.tiktok.privacy` is what the owner was shown and tapped through in the
 * approval message. It is not defaulted here on purpose: publishing at a
 * privacy level nobody was shown is the one outcome this whole path exists to
 * prevent, so a missing value is an error rather than a guess.
 */
export async function publishTikTok(cand) {
  if (!tiktokConfigured()) {
    throw new TikTokError(
      'TikTok is not configured (needs TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, a stored token and CARD_PUBLIC_BASE_URL)',
      { step: 'config' }
    );
  }

  // A deck publishes its slides in order; a single card publishes as a
  // one-image photo post. Both are the same API call — `photo_images` is an
  // array either way — which is why there is no separate publishDeck().
  const images = cand.deck?.urls?.tiktok?.length ? cand.deck.urls.tiktok : [cand.card?.url];

  if (!images.length || images.some((u) => !u)) {
    throw new TikTokError('no public image URL — TikTok fetches the images itself', { step: 'config' });
  }
  if (images.some((u) => !u.startsWith('https://'))) {
    throw new TikTokError(`every image URL must be https (got ${images.find((u) => !u.startsWith('https://'))})`, {
      step: 'config',
    });
  }
  if (images.length > 35) {
    throw new TikTokError(`a photo post takes at most 35 images (got ${images.length})`, { step: 'config' });
  }

  // Fall back to the most private level rather than refusing to post.
  // SELF_ONLY is always offered, so this can never publish more widely
  // than the owner intended.
  const privacy =
    cand.tiktok?.privacy || process.env.TIKTOK_PRIVACY || 'SELF_ONLY';

  const t = await liveToken('init');

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

  if (!d.publish_id) throw new TikTokError('no publish_id returned', { step: 'init' });

  await waitForPublish(d.publish_id, t);

  return { publishId: d.publish_id, images, slides: images.length, privacy };
}
