import { brickConfig } from '../brick/config.js';
import * as store from '../store.js';
import {
  publishTikTok,
  tiktokConfigured,
  TIKTOK_DAILY_CAP,
  describeError as describeTikTokError,
  isCardLevel as isCardLevelTikTok,
  isPlatformLimit as isPlatformLimitTikTok,
  isConfigProblem as isConfigProblemTikTok,
} from './tiktok.js';
import {
  ZernioError,
  publishZernioTikTok,
  describeZernioError,
  isCardLevelZernio,
  isConfigProblemZernio,
  isPlatformLimitZernio,
} from './zernio.js';

// Which door a deck leaves by, and what happens when that door fails.
//
// PORTED FROM tiyul-social's src/publish/tiktokRoute.js (2026-10-15), without
// its video and Reel half: a BrickDeal deck is a photo carousel, and Instagram
// keeps the Graph API it has published through for months.
//
// EVERY TIKTOK POST LEAVES PUBLICLY THROUGH ZERNIO, as a photo carousel.
//
// THE TIKTOK INBOX DRAFT IS ONLY THE FALLBACK. When Zernio fails for any reason
// that is not a limit (a limit clears by itself, and the post waits for it), the
// same deck goes to the TikTok inbox as a draft through TikTok's own API, and
// the publish notice says it fell back and why. A post is never lost to the new
// route, and never posted twice: the fallback runs only after Zernio said no,
// never while Zernio is still working on it (see createAndWait in zernio.js).
//
// AND NEVER WHEN THE POST MAY EXIST. A create call that timed out or failed
// with no clear answer is looked up by its idempotency key first (zernio.js);
// a post found that way is the result, and a lookup that could not run either
// leaves the deck to be retried with the same key, not drafted.

/** The zernio route's own ceiling: the lower of TIKTOK_DAILY_CAP and Zernio's 15. */
export const zernioDailyCap = () => Math.min(15, TIKTOK_DAILY_CAP());

// TikTok's four privacy levels. Anything else posts as SELF_ONLY: a wrong value
// can hide a post, never publish one. (config.js refuses an unknown value at
// load as well; this is the second lock.)
const PRIVACY_LEVELS = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
export const privacyLevel = (value) => (PRIVACY_LEVELS.has(value) ? value : 'SELF_ONLY');

export async function publishTikTokRouted(cand, { cfg = brickConfig().tiktok, deps = {}, env = process.env } = {}) {
  const draft = deps.draft || ((c) => publishTikTok(c, { draft: true }));

  const used = (deps.usedLast24h || store.tiktokPostsInLast24h)();
  const cap = (deps.cap || zernioDailyCap)();
  if (used >= cap) {
    throw new ZernioError(`${used} TikTok posts in the last 24 hours, the cap is ${cap}`, { step: 'platform_limit', code: 'zernio_daily_cap' });
  }

  // A deck may carry its own privacy (chosen on the approval card in manual
  // mode); otherwise the config's.
  const privacy = privacyLevel(cand.tiktok?.privacy || cfg.privacy);
  try {
    return await (deps.zernio || publishZernioTikTok)(cand, {
      privacy,
      autoAddMusic: cfg.autoAddMusic,
      commercialContentType: cfg.commercialContentType,
      env,
      // The key an earlier attempt left when it could not tell whether it had
      // made the post. Sent again, Zernio returns that post if it exists.
      idempotencyKey: cand.zernioKey || null,
    });
  } catch (e) {
    if (isPlatformLimitZernio(e) || cfg.fallback !== 'draft') throw e;
    // The post may exist (unconfirmed), or Zernio says it does (exists). A
    // draft on top of either is the duplicate this route promises never to make.
    if (e.unconfirmed || e.exists) throw e;
    // The one departure from tiyul-social: with no TikTok connection of its
    // own there is no inbox to fall back to, and the draft's "TikTok is not
    // configured" would replace the Zernio error that actually explains the
    // failure. So Zernio's error goes up as it is.
    if (!deps.draft && !tiktokConfigured()) throw e;
    const res = await draft({ ...cand, tiktokDraft: true });
    return {
      ...res,
      fellBack: true,
      notes: [...(res.notes || []), `Zernio נכשל ולכן נשלח כטיוטה לתיבה בטיקטוק: ${e.message}`],
    };
  }
}

/* ---------------------------------------------- the questions, for either door */

export const describeTikTokAny = (e) => (e instanceof ZernioError ? describeZernioError(e) : describeTikTokError(e));
export const isCardLevelTikTokAny = (e) => isCardLevelZernio(e) || isCardLevelTikTok(e);
export const isPlatformLimitTikTokAny = (e) => isPlatformLimitZernio(e) || isPlatformLimitTikTok(e);
export const isConfigProblemTikTokAny = (e) => isConfigProblemZernio(e) || isConfigProblemTikTok(e);

/** Whether either door is set up: Zernio for the post, TikTok's own API for the fallback. */
export const tiktokReachable = (env = process.env) => Boolean(String(env.ZERNIO_API_KEY || '').trim()) || tiktokConfigured();
