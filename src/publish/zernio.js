import { randomUUID } from 'node:crypto';
import * as store from '../store.js';
import { cardHostConfigured } from './imageHosts.js';
import { deckImageUrls, renderedSizes } from './deckImages.js';
import { brickConfig } from '../brick/config.js';

// TikTok, through Zernio.
//
// This replaced a direct client for TikTok's Content Posting API. That client
// could not put a sound on a photo post that anybody chose, could not post
// publicly until the app passed TikTok's audit, and so sent every deck to the
// creator's inbox to be finished by hand. Zernio posts through an app that
// has passed the audit, so a deck can go out as a real, public post with
// `auto_add_music` on, and nobody has to touch it.
//
// One request does all of it:
//
//   GET  /v1/accounts/{id}/tiktok/creator-info?mediaType=photo
//        which privacy levels this account allows, and whether it can post
//   POST /v1/posts
//        the slides, the caption and the TikTok settings
//
// Four things about Zernio that the code below depends on, all from
// docs.zernio.com/platforms/tiktok and checked there on 2026-10-14:
//
//   1. A 207 is a 2xx. A post TikTok refused comes back with HTTP 207 and
//      `post.status: "failed"`, and `res.ok` is true. So the code reads
//      `post.status` and never trusts the HTTP status on its own.
//   2. `musicSoundInfo` (a chosen track) is for VIDEO posts only, on Business
//      app connections. A photo carousel gets `auto_add_music` and nothing
//      else. So there is no list of sound ids here to rotate through.
//   3. `video_made_with_ai: true` is REJECTED on a direct photo post. A deck
//      with generated photographs therefore cannot be labelled through the
//      API at all. It goes to the inbox as a draft instead
//      (`tiktokSettings.draft`), and a person adds the label in the app. See
//      the AI-photo policy in candidate.js.
//   4. `auto_add_music` attaches nothing while a commercial-content toggle is
//      on. bot.js says so at boot rather than quietly changing either setting.

const DEFAULT_BASE = 'https://zernio.com/api/v1';

/** Everything a publish needs: a key, the account, and somewhere public for the slides. */
export const zernioConfigured = (env = process.env) =>
  Boolean(env.ZERNIO_API_KEY && env.ZERNIO_TIKTOK_ACCOUNT_ID && cardHostConfigured(env));

// Every privacy level TikTok defines, in the order the approval card cycles
// them. What is actually allowed comes from creator-info. This table is only
// the Hebrew for whatever comes back.
export const PRIVACY_HE = {
  PUBLIC_TO_EVERYONE: 'ציבורי',
  MUTUAL_FOLLOW_FRIENDS: 'חברים',
  FOLLOWER_OF_CREATOR: 'עוקבים',
  SELF_ONLY: 'פרטי (רק אני)',
};
const PRIVACY_ORDER = Object.keys(PRIVACY_HE);
export const privacyHe = (level) => PRIVACY_HE[level] || level;

/** The level the approval card offers first: the configured one, if the account allows it. */
export function defaultPrivacy(options = [], preferred = brickConfig().tiktok.privacy) {
  if (preferred && options.includes(preferred)) return preferred;
  return options[0] || preferred;
}

/** The next level in the cycle, for the privacy button in manual mode. */
export function nextPrivacy(current, options = []) {
  if (!options.length) return current;
  return options[(options.indexOf(current) + 1) % options.length];
}

/**
 * How many TikTok posts this bot may make in 24 hours.
 *
 * Ours, and deliberately below anybody else's. Zernio allows 15 photo posts a
 * day on a Business app connection, and TikTok has a per-account API limit of
 * its own that it does not publish. Drafts count against both, so they count
 * here too. Five is the number the direct client ran under, and nothing this
 * bot schedules comes close to it.
 */
export const TIKTOK_DAILY_CAP = () => Math.max(1, Number(process.env.TIKTOK_DAILY_CAP ?? '5'));

// TikTok's own numbers for a photo post.
const MAX_PHOTOS = 35;
const MAX_TITLE = 90;
const MAX_DESCRIPTION = 4000;

/**
 * A failure, with the one fact publish.js branches on: which kind it is.
 *
 *   limit       not now. A daily cap, a rate limit, TikTok at capacity. The
 *               card waits and the destination keeps its health.
 *   card        not this card. Bad media, a duplicate, a moderation flag.
 *               Retrying cannot change it, so it is abandoned.
 *   connection  not until somebody fixes something: the key, the connected
 *               account, a privacy level the account does not allow. Held,
 *               and TikTok is stood down at once.
 *   transient   anything else: a 5xx, a timeout, a message nobody has seen.
 *               Retried, and three in a row degrade the destination.
 *
 * `idempotencyKey` is set only when a retry should reuse it, which is when
 * nothing definite came back. See publishZernio.
 */
export class ZernioError extends Error {
  constructor(message, { kind = 'transient', step = null, code = null, status = null, postId = null, idempotencyKey = null } = {}) {
    super(message);
    this.name = 'ZernioError';
    this.kind = kind;
    this.step = step;
    this.code = code;
    this.status = status;
    this.postId = postId;
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Which kind of failure a Zernio answer is.
 *
 * Pure, so the mapping can be tested without a network. It reads the status,
 * Zernio's machine `code`, and the message, because TikTok's own refusals
 * arrive only as sentences inside `platforms[].errorMessage`. The sentences
 * matched here are the ones Zernio documents in its TikTok error table.
 */
export function classify({ status = null, code = null, message = '' } = {}) {
  const m = String(message || '').toLowerCase();
  const c = String(code || '');

  if (
    status === 429 ||
    c === 'rate_limited' ||
    c === 'idempotency_conflict' ||
    /too many posts in the last 24 hours|at capacity|daily active user quota|pending drafts|posts per hour|rate limit|too many requests/.test(m)
  ) {
    return { kind: 'limit' };
  }

  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    ['missing_credentials', 'invalid_credentials', 'ACCOUNT_DISCONNECTED', 'ACCOUNT_NOT_ENABLED_FOR_POSTING', 'PROFILE_OVER_LIMIT', 'privacy_not_allowed', 'commercial_not_allowed'].includes(c) ||
    /missing required tiktok permissions|reconnect|privacy level .*not available|unauthori[sz]ed|forbidden/.test(m)
  ) {
    return { kind: 'connection' };
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    c === 'content_duplicate' ||
    c === 'invalid_field_value' ||
    /duplicate content|spam_risk|flagged|download failed|returned an error|invalid/.test(m)
  ) {
    return { kind: 'card' };
  }

  return { kind: 'transient' };
}

export const isPlatformLimit = (e) => e instanceof ZernioError && e.kind === 'limit';
export const isCardLevel = (e) => e instanceof ZernioError && e.kind === 'card';
export const isConfigProblem = (e) => e instanceof ZernioError && e.kind === 'connection';

const HINTS = {
  limit: 'מגבלת פרסום של טיקטוק או של Zernio. הפוסט ממתין ויפורסם כשהמכסה תתפנה.',
  connection: 'צריך תיקון ידני: מפתח ה-API של Zernio, החשבון המחובר שם, או רמת הפרטיות ב-brick-config.json.',
  card: 'הפוסט הזה לא יעבור כפי שהוא. ניסיון חוזר לא ישנה את זה.',
};

/** A failure line you can act on: what happened, which kind it is, and what to do. */
export function describeError(e) {
  if (!(e instanceof ZernioError)) return e?.message || String(e);
  const bits = [e.kind, e.code && `code ${e.code}`, e.status && `HTTP ${e.status}`, e.postId && `zernio ${e.postId}`].filter(Boolean);
  const hint = HINTS[e.kind];
  return `${e.message} [${bits.join(', ')}]${hint ? `\n   ${hint}` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* The HTTP client                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A Zernio client. Injectable, so the suite and `brick-once` can hand in a fake
 * one and see exactly what would have been sent.
 *
 * Read from the environment when it is made rather than at import, the way the
 * rest of this pipeline reads its dials.
 */
export function createClient({
  apiKey = process.env.ZERNIO_API_KEY,
  base = process.env.ZERNIO_API_BASE || DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  const root = String(base).replace(/\/+$/, '');

  async function call(method, path, { body = null, query = null, headers = {}, step } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null))}` : '';
    let res;
    let json;
    try {
      res = await fetchImpl(`${root}${path}${qs}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      throw new ZernioError(`network error talking to Zernio: ${e.message}`, { kind: 'transient', step });
    }

    if (!res.ok) {
      const message = json?.error || json?.message || `HTTP ${res.status}`;
      throw new ZernioError(`Zernio refused ${method} ${path}: ${message}`, {
        ...classify({ status: res.status, code: json?.code, message }),
        step,
        code: json?.code || null,
        status: res.status,
        postId: json?.existingPostId || null,
      });
    }
    return { status: res.status, json };
  }

  return {
    async creatorInfo(accountId, { mediaType = 'photo' } = {}) {
      const { json } = await call('GET', `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info`, {
        query: { mediaType },
        step: 'creator_info',
      });
      return json;
    },
    // Returns the raw answer, 207 included. Reading what it means is
    // interpretPost's job, because a 207 can be any of three outcomes.
    createPost(body, { idempotencyKey } = {}) {
      return call('POST', '/posts', {
        body,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
        step: 'create',
      });
    },
    async analytics(query = {}) {
      const { json } = await call('GET', '/analytics', { query, step: 'analytics' });
      return json;
    },
  };
}

// The client publishNext and the analytics job use when none is handed in.
// Replaceable so the suite and `brick-once --mock-zernio` can drive the whole
// publish path against a fake one; nothing else sets it.
let override = null;
export const setClient = (client) => {
  override = client;
};
const defaultClient = () => override || createClient();

/* -------------------------------------------------------------------------- */
/* What gets sent                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The cover hook as TikTok's photo title.
 *
 * Zernio puts `content` in the title field, which takes 90 characters with
 * hashtags and URLs stripped. They are stripped here instead, so the title
 * that goes out is the one this function returns. Cut at a word, never
 * inside one.
 */
export function coverTitle(hook) {
  const clean = String(hook || '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+\.(?:com|co\.il)\S*/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= MAX_TITLE) return clean;
  const cut = clean.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

/**
 * The body of POST /v1/posts for one deck. Pure, and held to a snapshot in
 * the suite.
 *
 * `privacy_level`, `content_preview_confirmed` and `express_consent_given`
 * are TikTok's requirements. `allow_duet` and `allow_stitch` are left out
 * because they do not apply to photo posts. `video_made_with_ai` is left out
 * because a direct photo post rejects it (see the header).
 */
export function requestBody({
  accountId,
  hook,
  caption,
  images,
  privacy,
  allowComment = true,
  autoAddMusic = true,
  commercialContentType = 'none',
  draft = false,
}) {
  return {
    content: coverTitle(hook),
    mediaItems: images.map((url) => ({ type: 'image', url })),
    platforms: [{ platform: 'tiktok', accountId }],
    tiktokSettings: {
      media_type: 'photo',
      photo_cover_index: 0,
      privacy_level: privacy,
      allow_comment: Boolean(allowComment),
      auto_add_music: Boolean(autoAddMusic),
      description: String(caption || '').slice(0, MAX_DESCRIPTION),
      commercialContentType,
      content_preview_confirmed: true,
      express_consent_given: true,
      // The inbox, for a deck that has to be labelled by hand. TikTok ignores
      // the sound and the privacy level on a draft. The creator picks both in
      // the app when they post it.
      ...(draft ? { draft: true } : {}),
    },
    publishNow: true,
  };
}

/**
 * Everything that can be checked about a deck before a call goes out.
 *
 * TikTok fetches nothing from us directly now: Zernio downloads the slides and
 * hands them to TikTok, so the old rule about domains verified in TikTok's
 * developer portal no longer applies. What remains is that the slides exist,
 * are the 9:16 renders, and are on a public https URL Zernio can reach.
 */
export function preflight(cand) {
  const notes = [];
  let images = deckImageUrls(cand, 'tiktok');
  if (cand.kind === 'deck' && !images.length) {
    const has = renderedSizes(cand);
    throw new ZernioError(
      `this deck has no 1080x1920 renders${has.length ? ` (it has: ${has.join(', ')})` : ''} — rebuild it with TikTok among its targets`,
      { kind: 'card', step: 'preflight' }
    );
  }
  if (!images.length) images = [cand.card?.url].filter(Boolean);
  if (!images.length) {
    throw new ZernioError('no public image URL: set CARD_PUBLIC_BASE_URL so Zernio can fetch the slides', {
      kind: 'card',
      step: 'preflight',
    });
  }
  const notHttps = images.filter((u) => !String(u).startsWith('https://'));
  if (notHttps.length) {
    throw new ZernioError(`every slide URL must be https — ${notHttps.length} is not: ${notHttps.slice(0, 2).join(', ')}`, {
      kind: 'card',
      step: 'preflight',
    });
  }
  if (images.length > MAX_PHOTOS) {
    notes.push(`הדק כלל ${images.length} שקופיות; טיקטוק מקבלת ${MAX_PHOTOS} — פורסמו ${MAX_PHOTOS} הראשונות`);
    images = images.slice(0, MAX_PHOTOS);
  }
  return { images, notes };
}

/**
 * Hold creator-info against what this post is about to ask for.
 *
 * The privacy level is checked against the levels TikTok reports for the
 * account and refused, loudly, when it is not among them. It is never moved
 * to a level the account does allow: a post that went out at a different
 * privacy level from the configured one is something nobody asked for.
 * Refused as a connection problem, so TikTok is stood down and the owner is
 * told once, rather than every deck failing the same way in turn.
 */
export function checkCreator(info, { privacy, commercialContentType = 'none' } = {}) {
  const notes = [];
  const levels = (info?.privacyLevels || []).map((l) => (typeof l === 'string' ? l : l?.value)).filter(Boolean);
  if (!levels.length) {
    throw new ZernioError('creator-info returned no privacy levels for this account', {
      kind: 'connection',
      step: 'creator_info',
      code: 'no_privacy_levels',
    });
  }
  if (!levels.includes(privacy)) {
    throw new ZernioError(
      `privacy level ${privacy} is not allowed for this TikTok account — it allows ${levels.join(', ')}. ` +
        'Change tiktok.privacy in brick-config.json or the account settings in TikTok.',
      { kind: 'connection', step: 'creator_info', code: 'privacy_not_allowed' }
    );
  }
  if (info?.creator?.canPostMore === false) {
    throw new ZernioError('TikTok says this account cannot post more right now', {
      kind: 'limit',
      step: 'creator_info',
      code: 'cannot_post_more',
    });
  }
  const offered = (info?.commercialContentTypes || []).map((t) => (typeof t === 'string' ? t : t?.value)).filter(Boolean);
  if (commercialContentType !== 'none' && offered.length && !offered.includes(commercialContentType)) {
    throw new ZernioError(
      `commercialContentType ${commercialContentType} is not available for this account — it offers ${offered.join(', ')}`,
      { kind: 'connection', step: 'creator_info', code: 'commercial_not_allowed' }
    );
  }
  // TikTok forbids turning on an interaction the creator turned off in the
  // app, so the post follows the account here and says so.
  const allowComment = info?.postingLimits?.interactionSettings?.allow_comment?.enabled !== false;
  if (!allowComment) notes.push('התגובות כבויות בהגדרות החשבון בטיקטוק — הפוסט עלה בלי תגובות');
  return { privacy, allowComment, levels, notes };
}

/**
 * What a POST /v1/posts answer means. Throws for a failed post and returns
 * the facts worth recording for anything else.
 *
 * `scheduled` and `publishing` are accepted, not failed. Zernio uses them for
 * a post it is holding past a daily cap and for one whose platform hit a
 * transient error. It publishes both by itself, and posting the deck a
 * second time would make a duplicate.
 */
export function interpretPost(res, { draft = false } = {}) {
  const post = res?.json?.post || {};
  const postId = post._id || post.id || null;
  const entry = (post.platforms || []).find((p) => p?.platform === 'tiktok') || post.platforms?.[0] || {};
  const status = post.status || entry.status || null;

  if (status === 'failed' || entry.status === 'failed') {
    const message = entry.errorMessage || res?.json?.error || res?.json?.message || 'Zernio reported the post as failed';
    throw new ZernioError(`TikTok refused the post: ${message}`, {
      ...classify({ status: null, code: entry.errorCode || res?.json?.code, message }),
      step: 'publish',
      code: entry.errorCode || null,
      status: res?.status ?? null,
      postId,
    });
  }
  if (!postId) {
    throw new ZernioError(`Zernio answered HTTP ${res?.status} with no post id`, { kind: 'transient', step: 'publish' });
  }

  return {
    postId,
    status,
    url: entry.platformPostUrl || null,
    draft: Boolean(draft || entry.platformSpecificData?.isDraft),
    // An over-cap or retrying post is accepted but not yet live.
    pending: ['scheduled', 'publishing', 'pending'].includes(status),
  };
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One deck to TikTok, through Zernio. A real post, or an inbox draft when the
 * deck carries generated photographs and the AI-photo policy routed it there
 * (`cand.tiktokDraft`, set in candidate.js).
 *
 * THE IDEMPOTENCY KEY outlives a retry that learned nothing. After a timeout
 * or a 5xx it is not known whether Zernio made the post, and sending the same
 * key again returns the original if it did. After a definite answer (the post
 * exists and failed) the key is thrown away: Zernio would hand back the same
 * failed post forever.
 *
 * `dryRun` runs every check, asks creator-info, and returns the exact body and
 * key without creating anything.
 */
export async function publishZernio(cand, { client = defaultClient(), dryRun = false } = {}) {
  if (!zernioConfigured()) {
    throw new ZernioError('Zernio is not configured: needs ZERNIO_API_KEY, ZERNIO_TIKTOK_ACCOUNT_ID and CARD_PUBLIC_BASE_URL', {
      kind: 'connection',
      step: 'preflight',
      code: 'not_configured',
    });
  }

  const settings = brickConfig().tiktok;
  const { images, notes } = preflight(cand);

  const cap = TIKTOK_DAILY_CAP();
  const used = store.tiktokPostsInLast24h();
  if (used >= cap) {
    const freesAt = store.tiktokCapFreesAt();
    const mins = freesAt ? Math.max(1, Math.round((freesAt - Date.now()) / 60_000)) : null;
    throw new ZernioError(
      `the TikTok daily cap is reached: ${used}/${cap} in 24 hours${mins ? ` — the next slot frees in about ${mins} min` : ''}`,
      { kind: 'limit', step: 'preflight', code: 'tiktok_daily_cap' }
    );
  }

  const accountId = process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
  // A level chosen on the approval card in manual mode wins over the config.
  const wanted = cand.tiktok?.privacy || settings.privacy;
  const creator = checkCreator(await client.creatorInfo(accountId, { mediaType: 'photo' }), {
    privacy: wanted,
    commercialContentType: settings.commercialContentType,
  });
  notes.push(...creator.notes);

  const draft = Boolean(cand.tiktokDraft);
  const body = requestBody({
    accountId,
    hook: cand.deck?.hookHe || cand.headline,
    caption: cand.tiktokCaption || '',
    images,
    privacy: creator.privacy,
    allowComment: creator.allowComment,
    autoAddMusic: settings.autoAddMusic,
    commercialContentType: settings.commercialContentType,
    draft,
  });
  const idempotencyKey = cand.zernioKey || `brickdeal-${cand.id || 'post'}-${randomUUID()}`;

  if (dryRun) return { dryRun: true, body, idempotencyKey, images, slides: images.length, draft, privacy: creator.privacy, notes };

  let res;
  try {
    res = await client.createPost(body, { idempotencyKey });
  } catch (e) {
    if (e instanceof ZernioError) e.idempotencyKey = e.kind === 'transient' ? idempotencyKey : null;
    throw e;
  }

  const out = interpretPost(res, { draft });
  if (out.pending) notes.push(`Zernio קיבלה את הפוסט ומחזיקה אותו (${out.status}) — הוא יעלה לבד`);
  console.log(
    `tiktok: zernio ${out.postId} -> ${out.status}${out.draft ? ' (inbox draft)' : ''}${out.url ? ` ${out.url}` : ''}`
  );
  return { ...out, images, slides: images.length, privacy: creator.privacy, notes };
}

/**
 * Views for the posts Zernio made, newest first, across as many pages as the
 * window has. Each row is `{ postId, platformPostId, url, publishedAt, views,
 * likes, comments, shares }`.
 *
 * The id is matched three ways because the docs show three: the TikTok page
 * returns `_id`, and the schema names `postId`, plus `latePostId` for a post
 * that Zernio scheduled. Any of them can be the id POST /v1/posts gave back.
 */
export async function fetchViews({ client = defaultClient(), fromDate, toDate, maxPages = 5 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await client.analytics({ platform: 'tiktok', fromDate, toDate, limit: 100, page });
    for (const p of json?.posts || []) {
      const a = p.analytics || {};
      rows.push({
        ids: [p._id, p.postId, p.latePostId].filter(Boolean),
        platformPostId: p.platformPostId || null,
        url: p.platformPostUrl || null,
        publishedAt: p.publishedAt || null,
        views: Number.isFinite(Number(a.views)) ? Number(a.views) : null,
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
