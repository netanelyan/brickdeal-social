// TikTok photo carousels, posted publicly through Zernio.
//
// PORTED FROM tiyul-social's src/publish/zernio.js (2026-10-15), so the two bots
// post to TikTok the same way: carouselBody, accountIdFor, createAndWait,
// platformPart and the three error questions are the same functions with the
// same logic. What differs is this repo's candidate shape (the slides come
// from deckImageUrls, the title from the cover hook) and that there is no
// video path: a BrickDeal deck is a carousel and nothing else. The draft
// fallback and the daily cap are in tiktokRoute.js, as they are there.
//
// WHY A THIRD PARTY AT ALL. Our own TikTok app is unaudited, so TikTok lets it
// post only privately, and every TikTok post this bot made was a draft in the
// account's inbox, finished by hand in the app. Zernio's TikTok app posts
// publicly through the same Content Posting API.
//
// WHAT IT CAN DO TO THE ACCOUNT. Publish, upload, and list our own videos. No
// TikTok scope deletes a post, and no API here can unpublish one: a wrong
// public post comes down by hand. That is what the scorer and /pause are for.
//
// The shape of the request is copied from docs.zernio.com/platforms/tiktok: the
// carousel's images as `mediaItems`, the caption in `tiktokSettings.description`
// (the 90-character `content` becomes the photo title, with hashtags and URLs
// stripped), TikTok's two consent flags, and `publishNow`, without which Zernio
// schedules the post instead of publishing it.
//
// No AI-label field. Zernio rejects `video_made_with_ai` on a direct photo
// post, and nothing is sent in its place.
//
// No sound id. Zernio's `musicSoundInfo` is for video posts only; a carousel
// gets `auto_add_music` and TikTok chooses the track.

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { deckImageUrls } from './deckImages.js';

const BASE = () => (process.env.ZERNIO_BASE || 'https://zernio.com/api/v1').replace(/\/$/, '');

export const zernioConfigured = (env = process.env) => Boolean(String(env.ZERNIO_API_KEY || '').trim());

export class ZernioError extends Error {
  constructor(message, { step, code = null, status = null, category = null, unconfirmed = false, exists = false, idempotencyKey = null } = {}) {
    super(message);
    this.name = 'ZernioError';
    this.step = step;
    this.code = code;
    this.status = status;
    // Zernio's own errorCategory: user_content, auth_expired, platform_error.
    this.category = category;
    // The create call ended without a clear answer and the lookup could not
    // settle it either: the post may exist. Never followed by a draft, and a
    // retry sends `idempotencyKey` again so Zernio returns the post if it does.
    this.unconfirmed = unconfirmed;
    // Zernio says this content is already a post (409 content_duplicate).
    this.exists = exists;
    this.idempotencyKey = idempotencyKey;
  }
}

/** One request. `fetchImpl` is the selftest's door; production uses fetch. */
async function call(path, { method = 'GET', body = null, env = process.env, fetchImpl = fetch, step = 'request', headers = {} } = {}) {
  let res;
  try {
    res = await fetchImpl(`${BASE()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${String(env.ZERNIO_API_KEY || '').trim()}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ZernioError(`network error: ${e.message}`, { step, code: 'network' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error && typeof json.error === 'object' ? json.error : json;
    throw new ZernioError(err?.message || (typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`), {
      step,
      code: err?.code || err?.type || `http_${res.status}`,
      status: res.status,
    });
  }
  return json;
}

/**
 * The connected account's Zernio id, for 'tiktok'.
 *
 * ZERNIO_TIKTOK_ACCOUNT_ID wins when set; otherwise the one connected, active
 * account on that platform. Two of them is a question for the owner, not a
 * guess.
 */
export async function accountIdFor(platform, { env = process.env, fetchImpl } = {}) {
  const pinned = String(env[`ZERNIO_${platform.toUpperCase()}_ACCOUNT_ID`] || '').trim();
  if (pinned) return pinned;
  const { accounts = [] } = await call(`/accounts?platform=${platform}&status=connected`, { env, fetchImpl, step: 'accounts' });
  const live = accounts.filter((a) => a.platform === platform && a.isActive !== false && !a.needsReconnection);
  if (!live.length) throw new ZernioError(`no connected ${platform} account in Zernio - connect it in the Zernio dashboard`, { step: 'config', code: 'no_account' });
  if (live.length > 1) {
    throw new ZernioError(`${live.length} ${platform} accounts in Zernio - set ZERNIO_${platform.toUpperCase()}_ACCOUNT_ID to the one to post to`, {
      step: 'config',
      code: 'ambiguous_account',
    });
  }
  return live[0]._id;
}

export const tiktokAccountId = (opts = {}) => accountIdFor('tiktok', opts);

/**
 * The cover hook as TikTok's photo title: 90 characters, no hashtags and no
 * links. Zernio strips both itself; stripping them here means the title that
 * goes out is the one this returns. Cut at a word, never inside one.
 */
export function coverTitle(hook) {
  const clean = String(hook || '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+\.(?:com|co\.il)\S*/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= 90) return clean;
  const cut = clean.slice(0, 90);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

/**
 * The request body for one carousel. Pure, so the tests can read it.
 *
 * Two departures from tiyul-social's, both about this repo rather than about
 * Zernio: the title is the deck's cover hook (a deck's `headline` is a name for
 * the queue that never appears on a slide), and `commercialContentType` is sent
 * from brick-config.json. `draft` is never set by the bot; brick-once sets it
 * for a test post that has to land in the inbox.
 */
export function carouselBody(cand, { accountId, privacy, autoAddMusic, commercialContentType = 'none', draft = false }) {
  const images = deckImageUrls(cand, 'tiktok');
  return {
    content: coverTitle(cand.deck?.hookHe || cand.headline),
    mediaItems: images.map((url) => ({ type: 'image', url })),
    platforms: [{ platform: 'tiktok', accountId }],
    tiktokSettings: {
      privacy_level: privacy,
      allow_comment: true,
      media_type: 'photo',
      photo_cover_index: 0,
      description: String(cand.tiktokCaption || '').slice(0, 4000),
      auto_add_music: Boolean(autoAddMusic),
      commercialContentType,
      // TikTok's legal requirements, sent on every post (docs.zernio.com/platforms/tiktok).
      content_preview_confirmed: true,
      express_consent_given: true,
      ...(draft ? { draft: true } : {}),
    },
    publishNow: true,
  };
}

/** The TikTok post id inside a public URL (…/video/<id> or …/photo/<id>), or null. */
export const postIdFromUrl = (url) => /\/(?:video|photo)\/(\d{8,25})/.exec(String(url || ''))?.[1] || null;

/** One platform's half of a Zernio post, as { status, url, postId, error, category }. */
export function platformPart(post, platform) {
  const p = (post?.platforms || []).find((x) => x.platform === platform) || {};
  const url = p.platformPostUrl || null;
  return {
    status: p.status || post?.status || null,
    url,
    postId: p.platformPostId ? String(p.platformPostId) : platform === 'tiktok' ? postIdFromUrl(url) : null,
    error: p.errorMessage || null,
    category: p.errorCategory || null,
  };
}

export const tiktokPart = (post) => platformPart(post, 'tiktok');

export async function getPost(id, { env = process.env, fetchImpl } = {}) {
  const { post } = await call(`/posts/${encodeURIComponent(id)}`, { env, fetchImpl, step: 'status' });
  return post || null;
}

/**
 * Create one Zernio post and wait until the platform has it.
 *
 * When the create call ends without a clear answer, the post is looked up by
 * its idempotency key before anything else happens; see the catch below.
 *
 * A post Zernio accepted and is still working on when the wait runs out is NOT an
 * error: it may well go out, and treating it as a failure is what would post it
 * twice (a retry, or the TikTok draft fallback, on top of the post Zernio still
 * finishes). It comes back `pending`, recorded under Zernio's id, and the daily
 * views job finds out what became of it.
 */
async function createAndWait(body, platform, { env, fetchImpl, pollMs, timeoutMs, idempotencyKey = null, lookups = 3 }) {
  // One key per post, sent as Zernio's Idempotency-Key and stored on the post's
  // metadata, where a read returns it. A retry that sends the same key gets the
  // original post back instead of a second one; the lookup below finds the post
  // by it when the create call did not say whether it made one.
  const key = idempotencyKey || `zernio-${randomUUID()}`;
  const sent = { ...body, metadata: { ...(body.metadata || {}), idempotencyKey: key } };

  let created;
  try {
    created = await call('/posts', { method: 'POST', body: sent, env, fetchImpl, step: 'create', headers: { 'idempotency-key': key } });
    if (!created?.post?._id) throw new ZernioError('Zernio accepted the post but returned no id', { step: 'create', code: 'no_id' });
  } catch (e) {
    // Zernio's content dedup: this content is already a post. A draft of it
    // would be the duplicate the dedup exists to stop.
    if (e instanceof ZernioError && e.status === 409 && /duplicate/i.test(`${e.code} ${e.message}`)) {
      e.exists = true;
      throw e;
    }
    if (!createUncertain(e)) throw e;

    // No clear answer: a timeout, a dropped connection, a 5xx. The post may
    // well exist, and falling back to a draft now is how a deck became a public
    // post AND a draft. So look for it first, a few times, because a post that
    // is still being saved may not be listed yet.
    let found = null;
    let lookupError = null;
    for (let i = 0; i < lookups && !found; i++) {
      if (i) await new Promise((r) => setTimeout(r, pollMs));
      try {
        found = await findPostByKey(key, { accountId: body.platforms?.[0]?.accountId, env, fetchImpl });
        lookupError = null;
      } catch (le) {
        lookupError = le;
      }
    }
    if (!found && lookupError) {
      throw new ZernioError(`${e.message}; the lookup failed too (${lookupError.message}), so whether the post exists is unknown`, {
        step: 'create',
        code: e.code,
        status: e.status,
        unconfirmed: true,
        idempotencyKey: key,
      });
    }
    // Looked for and not there: nothing was made, and a fallback is safe.
    if (!found) throw e;
    created = { post: found, recovered: true };
  }
  const id = created.post._id;

  let part = platformPart(created.post, platform);
  const deadline = Date.now() + timeoutMs;
  while (!['published', 'failed', 'cancelled'].includes(part.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    // The post exists: Zernio gave it an id. A status that could not be read
    // leaves it pending, the same as one the wait ran out on, and never a
    // failure a draft would follow.
    let post;
    try {
      post = await getPost(id, { env, fetchImpl });
    } catch {
      break;
    }
    part = platformPart(post, platform);
  }
  if (part.status === 'failed' || part.status === 'cancelled') {
    throw new ZernioError(`TikTok refused the post: ${part.error || part.status}`, { step: 'status', code: part.category || part.status, category: part.category });
  }
  return { id, part, pending: part.status !== 'published', created, sent, key, recovered: Boolean(created.recovered) };
}

/**
 * Whether a create call that failed may still have made the post: no answer,
 * a server error, or Zernio still working on the first request. A clear
 * rejection (a 4xx) made nothing.
 */
export const createUncertain = (e) =>
  e instanceof ZernioError &&
  (e.code === 'network' || e.code === 'no_id' || e.status === 408 || e.status >= 500 || (e.status === 409 && /idempotency/i.test(`${e.code} ${e.message}`)));

/**
 * The post this bot created with `key`, or null. Lists the account's posts from
 * the last two days and matches the key stored on each post's metadata.
 */
export async function findPostByKey(key, { accountId, env = process.env, fetchImpl } = {}) {
  const fromDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ fromDate, limit: '50', page: String(page) });
    if (accountId) q.set('accountId', accountId);
    const json = await call(`/posts?${q}`, { env, fetchImpl, step: 'lookup' });
    const hit = (json?.posts || []).find((p) => p?.metadata?.idempotencyKey === key);
    if (hit) return hit;
    if (page >= (Number(json?.pagination?.pages) || 1) || !(json?.posts || []).length) break;
  }
  return null;
}

/**
 * Publish one carousel to TikTok and wait until TikTok has it.
 *
 * Returns { publishId, zernioId, postId, url, images, slides, privacy, notes,
 * draft, music, via, status, pending, resolveLater }. The public URL often
 * arrives later (TikTok resolves it asynchronously); the daily views job fills
 * it in.
 */
export async function publishZernioTikTok(
  cand,
  {
    privacy,
    autoAddMusic = true,
    commercialContentType = 'none',
    draft = false,
    env = process.env,
    fetchImpl,
    pollMs = 5_000,
    timeoutMs = 180_000,
    accountId = null,
    idempotencyKey = null,
  } = {}
) {
  if (!zernioConfigured(env)) throw new ZernioError('ZERNIO_API_KEY is not set', { step: 'config', code: 'not_configured' });
  const images = deckImageUrls(cand, 'tiktok');
  if (images.length < 2) throw new ZernioError(`a TikTok carousel needs 2 to 35 images, this one has ${images.length}`, { step: 'config', code: 'card_images' });
  if (images.length > 35) throw new ZernioError(`TikTok takes at most 35 images, this one has ${images.length}`, { step: 'config', code: 'card_images' });

  const account = accountId || (await tiktokAccountId({ env, fetchImpl }));
  const body = carouselBody(cand, { accountId: account, privacy, autoAddMusic, commercialContentType, draft });
  const { id, part, pending, created, sent, key, recovered } = await createAndWait(body, 'tiktok', { env, fetchImpl, pollMs, timeoutMs, idempotencyKey });

  const notes = [];
  if (!autoAddMusic) notes.push('בלי מוזיקה אוטומטית');
  if (draft) notes.push('נשלח כטיוטה לתיבה בטיקטוק');
  if (recovered) notes.push(`הקריאה ל-Zernio לא ענתה, אבל הפוסט נמצא לפי המפתח שלו (${id})`);
  if (pending) notes.push(`Zernio עדיין מעבד את הפוסט (${id}), הבדיקה היומית תגיד מה יצא ממנו`);
  else if (!part.url && !draft) notes.push(privacy === 'SELF_ONLY' ? 'פרטי: אין כתובת ציבורית עד שהופכים לציבורי' : 'הכתובת הציבורית תגיע בהמשך');
  console.log(`tiktok: zernio ${id} -> ${part.status}${draft ? ' (inbox draft)' : ''}${part.url ? ` ${part.url}` : ''}`);
  return {
    publishId: id,
    zernioId: id,
    postId: part.postId,
    url: part.url,
    images,
    slides: images.length,
    privacy,
    privacySource: 'config',
    notes,
    draft: Boolean(draft),
    music: Boolean(autoAddMusic),
    via: 'zernio',
    status: part.status,
    pending,
    resolveLater: !part.url,
    // What was sent and what Zernio answered to it, for brick-once to print.
    response: created,
    body: sent,
    idempotencyKey: key,
    recovered,
  };
}

/* ------------------------------------------------------------ classification */

// The same questions src/ops/publish.js asks every destination's errors.

/** Refusing everyone right now, and clears by itself: rate limits and TikTok's daily cap. */
export const isPlatformLimitZernio = (e) =>
  e instanceof ZernioError && (e.status === 429 || /rate|limit|spam_risk|too_many/i.test(`${e.code} ${e.message}`) || e.code === 'zernio_daily_cap');

/** Broken until somebody fixes the connection: key, account, expired authorisation. */
export const isConfigProblemZernio = (e) =>
  e instanceof ZernioError &&
  (e.status === 401 || e.status === 403 || e.category === 'auth_expired' || ['not_configured', 'no_account', 'ambiguous_account'].includes(e.code));

/** This post can never go: its images, its content. */
export const isCardLevelZernio = (e) => e instanceof ZernioError && (e.category === 'user_content' || e.code === 'card_images' || e.exists);

export const describeZernioError = (e) => `Zernio${e?.step ? ` (${e.step})` : ''}: ${e?.message || e}`;

/* ------------------------------------------------- reading, for this repo only */

/**
 * Who the TikTok account is and which privacy levels it allows, for /tiktok,
 * the panel's probe and the approval card in manual mode. Not on the publish
 * path, which sends the configured level and lets Zernio refuse it.
 */
export async function creatorSummary({ env = process.env, fetchImpl } = {}) {
  const id = await tiktokAccountId({ env, fetchImpl });
  const info = await call(`/accounts/${encodeURIComponent(id)}/tiktok/creator-info?mediaType=photo`, { env, fetchImpl, step: 'creator_info' });
  const order = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
  const options = (info?.privacyLevels || [])
    .map((l) => (typeof l === 'string' ? l : l?.value))
    .filter(Boolean)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { username: info?.creator?.nickname || null, options, canPostMore: info?.creator?.canPostMore !== false };
}

/**
 * Views for the posts Zernio made, across as many pages as the window has.
 * Each row is `{ ids, platformPostId, url, publishedAt, views, likes,
 * comments, shares }`. The id is matched three ways because the docs show
 * three: `_id`, `postId`, and `latePostId` for a post Zernio scheduled.
 */
export async function fetchViews({ fromDate, toDate, maxPages = 5, env = process.env, fetchImpl } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ platform: 'tiktok', limit: '100', page: String(page) });
    if (fromDate) q.set('fromDate', fromDate);
    if (toDate) q.set('toDate', toDate);
    const json = await call(`/analytics?${q}`, { env, fetchImpl, step: 'analytics' });
    for (const p of json?.posts || []) {
      const a = p.analytics || {};
      // A count Zernio has not synced yet is not zero views. Read as zero it
      // would be a post nobody watched, and the worst cover in the benchmarks.
      const synced = !p.syncStatus || p.syncStatus === 'synced' || p.syncStatus === 'partial';
      rows.push({
        ids: [p._id, p.postId, p.latePostId].filter(Boolean),
        platformPostId: p.platformPostId || null,
        url: p.platformPostUrl || null,
        publishedAt: p.publishedAt || null,
        views: synced && typeof a.views === 'number' && Number.isFinite(a.views) ? a.views : null,
        likes: Number(a.likes) || 0,
        comments: Number(a.comments) || 0,
        shares: Number(a.shares) || 0,
      });
    }
    const pages = Number(json?.pagination?.pages) || 1;
    if (page >= pages || !(json?.posts || []).length) break;
  }
  return rows;
}

/**
 * One local file into Zernio's storage, for a run with no public host behind
 * it (brick-once on a laptop). POST /v1/media/presign, then a PUT of the bytes
 * to the URL it returns, which carries no Authorization header. Returns the
 * `publicUrl` a post can use; Zernio keeps the upload for seven days and copies
 * it to permanent storage when a post uses it.
 */
export async function uploadMedia(file, { contentType = 'image/jpeg', env = process.env, fetchImpl = fetch } = {}) {
  const size = statSync(file).size;
  const presigned = await call('/media/presign', {
    method: 'POST',
    body: { filename: basename(file), contentType, size },
    env,
    fetchImpl,
    step: 'presign',
  });
  if (!presigned?.uploadUrl || !presigned?.publicUrl) {
    throw new ZernioError('Zernio returned no upload URL', { step: 'presign', code: 'no_upload_url' });
  }
  let put;
  try {
    put = await fetchImpl(presigned.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: readFileSync(file),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ZernioError(`upload failed: ${e.message}`, { step: 'upload', code: 'network' });
  }
  if (!put.ok) throw new ZernioError(`upload refused: HTTP ${put.status}`, { step: 'upload', status: put.status });
  return presigned.publicUrl;
}
