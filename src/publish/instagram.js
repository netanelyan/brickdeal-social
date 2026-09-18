import * as store from '../store.js';

// Instagram publishing, through the official Graph API only.
//
// Two auth paths exist and they are not interchangeable:
//
//   IG_AUTH=instagram  (default) — "Instagram API with Instagram Login".
//       Host graph.instagram.com. No Facebook Page required at all. Tokens are
//       long-lived (60 days) and MUST be refreshed before they lapse.
//   IG_AUTH=facebook             — "Instagram API with Facebook Login".
//       Host graph.facebook.com. Requires a linked Facebook Page. The Page
//       token it yields never expires, so there is nothing to refresh.
//
// The default is `instagram` because it needs no Page and two permissions
// instead of four. The cost is that its token expires, which is why
// refreshToken() exists and why bot.js calls it on boot and daily. A 60-day
// token with no refresh is a pipeline that works perfectly until it silently
// stops two months in — the exact failure the Page-token path avoided.
//
// The publishing handshake itself is identical on both:
//   1. POST /{ig-user-id}/media         with image_url  -> a creation_id
//   2. POST /{ig-user-id}/media_publish with creation_id -> the published post
//
// In step 1 the bytes do NOT travel through our request — we hand Instagram a
// URL and Instagram's servers fetch it themselves. That is why rendered cards
// must live somewhere publicly reachable over https (CARD_PUBLIC_BASE_URL), and
// why a card that only exists on local disk cannot be published.

const VERSION = process.env.GRAPH_API_VERSION || 'v21.0';

export const authMode = () => (process.env.IG_AUTH || 'instagram').toLowerCase();

export const graphHost = () =>
  authMode() === 'facebook' ? 'https://graph.facebook.com' : 'https://graph.instagram.com';

export const instagramConfigured = () =>
  Boolean(currentToken() && process.env.IG_USER_ID && process.env.CARD_PUBLIC_BASE_URL);

/**
 * The token actually in use.
 *
 * A refreshed token is persisted to the store, so it survives restarts and
 * outlives the seed value in .env. The env var is the starting point, not the
 * source of truth — otherwise every refresh would be forgotten on restart and
 * the pipeline would die at day 60 anyway.
 */
export function currentToken() {
  return store.getIgToken()?.token || process.env.IG_ACCESS_TOKEN || null;
}

export class InstagramError extends Error {
  constructor(message, { step, code, subcode } = {}) {
    super(message);
    this.step = step;
    this.code = code;
    this.subcode = subcode;
  }
}

// Graph error codes worth naming, because the message alone does not say what to
// do. Deliberately short: a wrong guess about what an unknown code means is
// worse than printing the code and letting you look it up.
const CODE_HINTS = {
  190: 'הטוקן פג או נפסל — npm run ig-token',
  102: 'הסשן נפסל — npm run ig-token',
  4: 'חריגה ממכסת הקריאות — יתפנה מעצמו',
  17: 'חריגה ממכסת הקריאות — יתפנה מעצמו',
  32: 'חריגה ממכסת הקריאות — יתפנה מעצמו',
  613: 'חריגה ממכסת הקריאות — יתפנה מעצמו',
  9: 'חריגה ממכסת הפרסום היומית (25 ב-24 שעות)',
};

/**
 * A failure line you can act on.
 *
 * Graph's `message` on its own is often a sentence like "API access blocked"
 * that names a symptom and no cause. The code, the subcode and the step are what
 * separate a dead token from a throttle from an app-level restriction, and they
 * were being dropped on the floor before this existed.
 */
export function describeError(e) {
  if (!(e instanceof InstagramError)) return e?.message || String(e);
  const bits = [];
  if (e.code != null) bits.push(`code ${e.code}`);
  if (e.subcode != null) bits.push(`subcode ${e.subcode}`);
  if (e.step) bits.push(`step ${e.step}`);
  const detail = bits.length ? `${e.message} [${bits.join(', ')}]` : e.message;
  const hint = CODE_HINTS[e.code];
  return hint ? `${detail}\n   ${hint}` : detail;
}

async function graph(path, { method = 'GET', params = {}, step, token = currentToken() } = {}) {
  const url = new URL(`${graphHost()}/${VERSION}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  let res;
  let json;
  try {
    res =
      method === 'GET'
        ? await fetch(`${url}?${body}`, { method: 'GET' })
        : await fetch(url, {
            method,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw new InstagramError(`network error: ${e.message}`, { step });
  }

  if (!res.ok || json.error) {
    const err = json.error || {};
    throw new InstagramError(err.message || `HTTP ${res.status}`, {
      step,
      code: err.code,
      subcode: err.error_subcode,
    });
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Token refresh                                                              */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;
// Refresh with plenty of runway. Instagram will not refresh a token younger
// than 24 hours, and refuses outright once one has actually expired — so the
// window has to be wide enough that a few days of downtime can't strand it.
const REFRESH_WHEN_DAYS_LEFT = 20;

/**
 * Refresh the long-lived token if it is getting close to expiry.
 *
 * Only meaningful on the Instagram Login path; the Facebook path's Page token
 * has no expiry, so this is a no-op there.
 *
 * Returns { refreshed, daysLeft } and never throws for a routine "not due yet".
 */
export async function refreshToken({ force = false } = {}) {
  if (authMode() === 'facebook') return { refreshed: false, reason: 'page tokens do not expire' };

  const token = currentToken();
  if (!token) return { refreshed: false, reason: 'no token configured' };

  const saved = store.getIgToken();
  const expiresAt = saved?.expiresAt ?? null;
  const daysLeft = expiresAt ? (expiresAt - Date.now()) / DAY_MS : null;

  // With no recorded expiry we cannot know how long is left, so refresh once to
  // establish one. That is also the first-run case, straight after .env is set.
  if (!force && daysLeft !== null && daysLeft > REFRESH_WHEN_DAYS_LEFT) {
    return { refreshed: false, daysLeft, reason: 'not due yet' };
  }

  const r = await graph('refresh_access_token', {
    params: { grant_type: 'ig_refresh_token' },
    step: 'refresh_token',
    token,
  });

  if (!r.access_token) throw new InstagramError('refresh returned no token', { step: 'refresh_token' });

  const newExpiry = Date.now() + (Number(r.expires_in) || 60 * 24 * 3600) * 1000;
  store.setIgToken({ token: r.access_token, expiresAt: newExpiry });

  return { refreshed: true, daysLeft: (newExpiry - Date.now()) / DAY_MS };
}

/** Days until the stored token lapses, or null if unknown / not applicable. */
export function tokenDaysLeft() {
  if (authMode() === 'facebook') return null;
  const saved = store.getIgToken();
  if (!saved?.expiresAt) return null;
  return Math.round((saved.expiresAt - Date.now()) / DAY_MS);
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many posts remain in Instagram's rolling 24-hour window (the cap is 25).
 * Worth asking before publishing rather than discovering it as a failure.
 */
export async function remainingQuota() {
  const r = await graph(`${process.env.IG_USER_ID}/content_publishing_limit`, {
    params: { fields: 'quota_usage,config' },
    step: 'quota',
  });
  const row = r.data?.[0];
  if (!row) return null;
  const cap = row.config?.quota_total ?? 25;
  return Math.max(0, cap - (row.quota_usage ?? 0));
}

// Instagram fetches and processes the image asynchronously, so a creation_id is
// not immediately publishable. Publishing too early fails with a generic error;
// polling status_code turns that into an answer we can act on.
async function waitForContainer(creationId, { timeoutMs = 60_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await graph(creationId, { params: { fields: 'status_code,status' }, step: 'container_status' });
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new InstagramError(`container ${r.status_code}: ${r.status || 'no detail'}`, {
        step: 'container_status',
      });
    }
    if (Date.now() > deadline) {
      throw new InstagramError(`container still ${r.status_code} after ${timeoutMs}ms`, {
        step: 'container_status',
      });
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/**
 * Publish one card. Refuses up front when it cannot work, rather than failing
 * between the two steps — a half-completed publish is the one state with no
 * clean recovery.
 */
/**
 * Publish a deck as a carousel.
 *
 * Three steps rather than two, and the extra one is where it goes wrong: each
 * slide gets its own container created with `is_carousel_item=true`, then a
 * CAROUSEL container is created with those ids in order, then that is
 * published. The child containers are NOT published individually — doing so
 * posts every slide as its own separate post, which is unrecoverable.
 *
 * Order is preserved because `children` is a comma-separated list and Instagram
 * honours its order; the ids are collected in slide order and never sorted.
 */
async function publishInstagramCarousel(cand, images) {
  const igUser = process.env.IG_USER_ID;

  if (images.length < 2 || images.length > 10) {
    // Instagram's own bounds. A one-slide deck is a single image post and a
    // caller that lands here with one has a bug worth seeing.
    throw new InstagramError(`a carousel takes 2-10 images (got ${images.length})`, { step: 'config' });
  }

  const children = [];
  for (const [i, imageUrl] of images.entries()) {
    const child = await graph(`${igUser}/media`, {
      method: 'POST',
      params: { image_url: imageUrl, is_carousel_item: 'true' },
      step: `carousel_child_${i + 1}`,
    });
    if (!child.id) throw new InstagramError(`slide ${i + 1} returned no container id`, { step: 'carousel_child' });
    children.push(child.id);
  }

  // Each child is fetched and processed by Instagram independently, so all of
  // them have to be finished before the parent can be created.
  for (const [i, id] of children.entries()) {
    await waitForContainer(id).catch((e) => {
      throw new InstagramError(`slide ${i + 1}: ${e.message}`, { step: 'carousel_child_status' });
    });
  }

  const parent = await graph(`${igUser}/media`, {
    method: 'POST',
    params: {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption: cand.instagramCaption || '',
    },
    step: 'carousel_container',
  });
  if (!parent.id) throw new InstagramError('no carousel container id returned', { step: 'carousel_container' });

  await waitForContainer(parent.id);

  const published = await graph(`${igUser}/media_publish`, {
    method: 'POST',
    params: { creation_id: parent.id },
    step: 'publish',
  });

  return { mediaId: published.id, creationId: parent.id, slides: images.length, images };
}

export async function publishInstagram(cand) {
  if (!instagramConfigured()) {
    throw new InstagramError(
      'Instagram is not configured (needs IG_ACCESS_TOKEN, IG_USER_ID and CARD_PUBLIC_BASE_URL)',
      { step: 'config' }
    );
  }
  // A deck arrives here with its Instagram-sized slides already rendered, and
  // takes the carousel path. Everything else is one image, as before.
  const deckImages = cand.deck?.urls?.instagram || [];
  if (deckImages.length > 1) {
    if (deckImages.some((u) => !u?.startsWith('https://'))) {
      throw new InstagramError('every slide URL must be https', { step: 'config' });
    }
    return publishInstagramCarousel(cand, deckImages.slice(0, 10));
  }

  const imageUrl = cand.card?.url || deckImages[0];
  if (!imageUrl) {
    throw new InstagramError('no public card URL — Instagram fetches the image itself', { step: 'config' });
  }
  if (!imageUrl.startsWith('https://')) {
    // Instagram will not fetch over plain http; catching it here names the real
    // problem instead of surfacing Graph's generic "media could not be fetched".
    throw new InstagramError(`card URL must be https (got ${imageUrl})`, { step: 'config' });
  }

  const igUser = process.env.IG_USER_ID;

  const created = await graph(`${igUser}/media`, {
    method: 'POST',
    params: { image_url: imageUrl, caption: cand.instagramCaption || '' },
    step: 'create_container',
  });
  if (!created.id) throw new InstagramError('no creation_id returned', { step: 'create_container' });

  await waitForContainer(created.id);

  const published = await graph(`${igUser}/media_publish`, {
    method: 'POST',
    params: { creation_id: created.id },
    step: 'publish',
  });

  return { mediaId: published.id, creationId: created.id, imageUrl };
}
