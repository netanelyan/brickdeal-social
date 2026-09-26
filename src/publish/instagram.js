import * as store from '../store.js';
import { cardHostConfigured } from './imageHosts.js';
import { deckImageUrls } from './deckImages.js';

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
  Boolean(currentToken() && process.env.IG_USER_ID && cardHostConfigured());

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
  constructor(message, { step, code, subcode, creationId } = {}) {
    super(message);
    this.step = step;
    this.code = code;
    this.subcode = subcode;
    // The container this failure happened around, when there was one. Carried on
    // the error so the caller can hold onto it and ask about it later — see
    // publishInstagram()'s resume check.
    this.creationId = creationId;
  }
}

/**
 * Codes that mean "not now" rather than "broken" or "not this card".
 *
 * Graph throttles by app, by user and by page, and every one of those clears on
 * its own within the hour. Treated as a failure they cost three publish
 * attempts each and then degrade the destination — so a busy afternoon ends
 * with Instagram marked down and a backlog held behind it, at the exact moment
 * nothing was wrong.
 *
 * TikTok has had this distinction since its daily cap was implemented; the same
 * argument applies here and the code simply never made it across.
 *
 *   4    application request limit reached
 *   17   user request limit reached
 *   32   page request limit reached
 *   613  calls to this api have exceeded the rate limit
 *
 * 2207051 is the publishing-specific subcode Graph returns with code 4, and is
 * the one that actually turned up.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const RATE_LIMIT_SUBCODES = new Set([2207051]);

export const isPlatformLimit = (e) =>
  e instanceof InstagramError &&
  (RATE_LIMIT_CODES.has(Number(e.code)) || RATE_LIMIT_SUBCODES.has(Number(e.subcode)));

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
    // Already a post. Not one of the states this was written for, and left out
    // it is the worst one: PUBLISHED is neither FINISHED nor an error, so the
    // loop polls a container that will never change again and gives up after a
    // minute — reporting a timeout on a post that is live.
    if (r.status_code === 'PUBLISHED') return;
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
 * Has this container already become a post?
 *
 * The one question that separates "Instagram refused" from "Instagram accepted
 * and then told us it had not". A container carries its own answer — status_code
 * goes to PUBLISHED once media_publish has taken it — so the post itself can be
 * asked, rather than inferred from what the failing call happened to say.
 *
 * Asked twice. The error that made this necessary was code 4, an app-level
 * throttle, and a throttle that refused the publish call can refuse the question
 * about it just as easily; a few seconds is usually the whole difference. Two
 * attempts and no more, because a bot holding the publish path open waiting for
 * a throttle to clear is the outage it was trying to avoid.
 *
 * Never throws. A verification that cannot be completed must leave the caller
 * exactly where it was — reporting the original failure — rather than replacing
 * a wrong answer with a different wrong answer.
 */
async function containerPublished(creationId, { attempts = 2, gapMs = 4_000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((res) => setTimeout(res, gapMs));
    try {
      const r = await graph(creationId, { params: { fields: 'status_code' }, step: 'publish_verify' });
      if (r.status_code === 'PUBLISHED') return true;
      // A definite answer that is not PUBLISHED settles it. Only an error is
      // worth asking again about.
      return false;
    } catch {
      // Throttled, most likely — the reason we are here at all. Try once more.
    }
  }
  return false;
}

/**
 * The last step, and the only one whose failure can be a lie.
 *
 * Graph returns "Application request limit reached" (code 4) from media_publish
 * on posts that went up anyway. Taken at face value that is the worst outcome
 * the pipeline has: the post is live, the bot says it is not, the card goes back
 * on the queue as merely delayed, and the retry publishes it a SECOND time. One
 * true statement from Instagram — the container's own status — costs one GET and
 * turns all of that into a note.
 */
async function publishContainer(igUser, creationId) {
  try {
    const published = await graph(`${igUser}/media_publish`, {
      method: 'POST',
      params: { creation_id: creationId },
      step: 'publish',
    });
    return { mediaId: published.id };
  } catch (e) {
    if (await containerPublished(creationId)) {
      return {
        // Graph gives no way back from a creation_id to the media id it became,
        // and the post being live is the fact that matters. Null rather than a
        // guess.
        mediaId: null,
        notes: [`פורסם למרות שגיאה מ-Graph — ${describeError(e).split('\n')[0]}`],
      };
    }
    // Genuinely not published. The container id travels with the error so the
    // next attempt can ask about this one before creating another.
    e.creationId ||= creationId;
    throw e;
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

  const published = await publishContainer(igUser, parent.id);

  return { ...published, creationId: parent.id, slides: images.length, images };
}

export async function publishInstagram(cand) {
  if (!instagramConfigured()) {
    throw new InstagramError(
      'Instagram is not configured (needs IG_ACCESS_TOKEN, IG_USER_ID and CARD_PUBLIC_BASE_URL)',
      { step: 'config' }
    );
  }
  // Did the LAST attempt at this card already publish it?
  //
  // Only ever set by a publish that failed with a container in hand, so on a
  // first attempt there is nothing here and nothing is asked. On a retry it is
  // the difference between one post and two: the failure that sends a card back
  // to the queue is sometimes a failure Instagram reported after publishing, and
  // the retry has no other way to know that. One GET, before anything is
  // created, and a card that is already live is reported as live.
  if (cand.instagramCreationId && (await containerPublished(cand.instagramCreationId, { attempts: 1 }))) {
    return {
      mediaId: null,
      creationId: cand.instagramCreationId,
      notes: ['כבר היה מפורסם מהניסיון הקודם — לא פורסם שוב'],
    };
  }

  // A deck arrives here with its Instagram-sized slides already rendered, and
  // takes the carousel path. Everything else is one image, as before.
  const deckImages = deckImageUrls(cand, 'instagram');
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

  const published = await publishContainer(igUser, created.id);

  return { ...published, creationId: created.id, imageUrl };
}
