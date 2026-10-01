import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import * as store from '../store.js';
import * as jobs from './jobs.js';
import { snapshot as usageSnapshot, usageReport } from '../usage.js';
import { brickApprovalMessage, photoSummary } from '../brick/candidate.js';
import { proposalMessage, proposalWarning } from '../brick/proposal.js';
import { liveTargets, targetsForKind, allowedForKind, TARGET_HE } from '../publish/targets.js';
import { instagramConfigured, tokenDaysLeft, authMode } from '../publish/instagram.js';
import {
  tiktokConfigured,
  tokenHoursLeft as tiktokHoursLeft,
  refreshTokenDaysLeft as tiktokRefreshDaysLeft,
  missingScopes as tiktokMissingScopes,
  privacyHe,
  TIKTOK_DAILY_CAP,
} from '../publish/tiktok.js';
import { configured as imagesEnabled } from '../images/homeShot.js';
import { brickConfig } from '../brick/config.js';

// What is going on, as data rather than as a message.
//
// Telegram's /status and /health answer these questions already, and they answer
// them as Hebrew paragraphs — which is right for a chat and useless for anything
// else. A web page needs the same facts as numbers it can lay out, sort and
// colour, and building a second set of readers for it would mean two definitions
// of "how many are waiting".
//
// So the facts are gathered here once. src/notify.js keeps formatting them for
// Telegram; the website renders the same objects. When the two disagree about
// what is in the queue, it is a rendering bug rather than a reporting one.
//
// Nothing here writes. Nothing here is slow: no API is called, because a
// dashboard that refreshes every few seconds must not spend an Instagram quota
// call each time. Whatever genuinely requires asking a platform is its own
// endpoint and its own button.

/**
 * A rendered slide, trimmed to what a browser needs.
 *
 * `file` never leaves the process. The website serves images by FILENAME through
 * an authenticated route, because a JSON payload carrying absolute server paths
 * is both useless to the page and an invitation to build a path-traversal read
 * out of them. `url` is included when the public host is configured, since that
 * is what Instagram and TikTok will actually fetch and is worth being able to
 * check by eye.
 */
const slideView = (s) =>
  s
    ? {
        filename: s.filename || (s.file ? basename(s.file) : null),
        url: s.url || null,
        bytes: s.bytes || null,
        // Whether the bytes are still on disk. A deck approved days ago whose
        // renders were swept is exactly the thing you want to know BEFORE
        // approving it, and the page cannot tell a missing file from a slow one.
        onDisk: s.file ? existsSync(s.file) : false,
      }
    : null;

/** One staged post, in full, for a page that has to be enough to decide on. */
export function stagedView({ key, cand }) {
  const deck = cand.deck || {};
  const sizes = ['tiktok', 'instagram'].filter((size) => Array.isArray(deck[size]) && deck[size].length);
  return {
    key,
    kind: cand.kind || 'card',
    headline: cand.headline,
    subject: deck.subject || cand.sourceName || null,
    hook: deck.hookHe || null,
    emphasis: deck.emphasisHe || null,
    hookFrom: deck.hookFrom || null,
    recipe: deck.recipe || null,
    theme: deck.theme || null,
    // The approval text Telegram shows, verbatim. Not for want of structure —
    // everything in it is also below — but because it is the exact sentence the
    // other surface is deciding on, and two surfaces that word the same decision
    // differently is how two admins come to believe different things.
    approvalText: brickApprovalMessage(cand),
    caption: cand.tiktokCaption || cand.instagramCaption || cand.channelCaption || null,
    instagramCaption: cand.instagramCaption || null,
    targets: cand.pendingTargets?.length ? cand.pendingTargets : cand.publishTargets || [],
    allowed: allowedForKind(cand.kind),
    tiktokDraft: Boolean(cand.tiktokDraft),
    tiktok: cand.tiktok
      ? {
          username: cand.tiktok.username || null,
          privacy: cand.tiktok.privacy || null,
          privacyHe: cand.tiktok.privacy ? privacyHe(cand.tiktok.privacy) : null,
          options: (cand.tiktok.options || []).map((o) => ({ value: o, label: privacyHe(o) })),
          error: cand.tiktok.error || null,
        }
      : null,
    photos: photoSummary(deck.slides || []),
    notes: cand.notes || [],
    overrides: cand.overrides || [],
    dropped: deck.dropped || [],
    sizes,
    // The preview set is what Telegram's album showed. Every size is offered as
    // well, so an admin can look at the crop that is actually going to the other
    // platform rather than trusting that it is fine.
    preview: (deck.preview || []).map(slideView).filter(Boolean),
    renders: Object.fromEntries(sizes.map((size) => [size, deck[size].map(slideView).filter(Boolean)])),
    slides: (deck.slides || []).map((s, i) => ({
      n: i + 1,
      name: s.nameHe,
      emoji: s.emoji || null,
      productId: s.productId || null,
      price: s.deal?.price ?? null,
      setId: s.deal?.setId ?? null,
      sizeCm: s.deal?.sizeCm ?? null,
      url: s.deal?.url || null,
      // The price claim and where it came from — the region, the currency, the
      // rate and the date it was taken on. This is the part the approval flow
      // exists for: a slide states a saving, and a saving with no source behind it
      // does not ship.
      comparison: s.deal?.comparison
        ? {
            ok: Boolean(s.deal.comparison.ok),
            paid: s.deal.comparison.paid ?? null,
            listIls: s.deal.comparison.listIls ?? null,
            saving: s.deal.comparison.saving ?? null,
            why: s.deal.comparison.why || null,
            source: s.deal.comparison.source || null,
          }
        : null,
      image: s.image || null,
    })),
    createdAt: cand.createdAt || null,
    // Whether a Telegram card exists for this. A post with none is the case
    // /resend was written for, and the website is the surface that can actually
    // show it rather than counting it.
    inTelegram: Boolean(cand.tg?.messageId),
  };
}

/** One proposal — the text stage, before anything has been paid for. */
export function proposalView(key, held) {
  const p = held.proposal || {};
  return {
    key,
    subject: p.subject || null,
    recipe: p.recipe || null,
    theme: p.theme || null,
    ceiling: p.ceiling || null,
    agorotCeiling: p.agorotCeiling || null,
    text: proposalMessage(p),
    warning: proposalWarning(p),
    rates: p.rates || {},
    feedDropped: p.feedDropped || [],
    proposedAt: held.proposedAt || null,
    inTelegram: Boolean(held.tg?.messageId),
    deals: (p.deals || []).map((d) => ({
      product: d.product,
      productId: d.productId || null,
      price: d.price ?? null,
      setId: d.setId ?? null,
      url: d.url || null,
      comparison: d.comparison || null,
    })),
  };
}

export const pending = () => ({
  staged: store.stagingItems().map(stagedView),
  proposals: store.proposalItems().map(({ key, held }) => proposalView(key, held)),
});

/** The queue, in the order it will actually go out. */
export const queue = () =>
  store.queuedItems().map((c, i) => {
    const owed = (c.pendingTargets?.length ? c.pendingTargets : c.publishTargets || []).filter((t) =>
      allowedForKind(c.kind).includes(t)
    );
    return {
      n: i + 1,
      kind: c.kind || 'card',
      headline: c.headline,
      id: c.id,
      targets: owed,
      // Only when TikTok is still owed. Approval sends the draft immediately and
      // queues the rest, so the remainder is Instagram-only — and calling that
      // "draft" describes a handoff that already happened.
      draft: Boolean(c.tiktokDraft && owed.includes('tiktok')),
      attempts: c.publishAttempts || 0,
      cover: slideView(c.deck?.preview?.[0] || c.card),
      slides: (c.deck?.preview || []).length || null,
    };
  });

export const held = () =>
  store.heldItems().map((h, i) => ({
    n: i + 1,
    headline: h.cand?.headline || null,
    kind: h.cand?.kind || 'card',
    targets: h.targets || [],
    error: h.error || null,
    ts: h.ts,
    cover: slideView(h.cand?.deck?.preview?.[0] || h.cand?.card),
  }));

export const published = ({ limit = 40 } = {}) =>
  store.recentPublished().slice(0, limit).map((p) => ({
    ts: p.ts,
    id: p.id,
    headline: p.headline || null,
    topic: p.topic || null,
    place: p.place || null,
    telegram: Boolean(p.telegram),
    instagram: Boolean(p.instagram),
    tiktok: Boolean(p.tiktok),
    tiktokDraft: Boolean(p.tiktokDraft),
    tiktokAt: p.tiktokAt || null,
  }));

/**
 * Per-destination health, and what is holding anything back.
 *
 * The stored degraded flag is reported, not the applied one: a destination inside
 * its cooldown and a destination due a probe are different answers to "why is
 * nothing going out", and isDegraded() alone cannot tell them apart.
 */
export const health = () => {
  const targets = [...new Set([...liveTargets(), ...store.healthTargets()])];
  return targets.map((target) => ({
    target,
    label: TARGET_HE[target] || target,
    ...store.targetHealth(target),
    degraded: store.isDegradedLatched(target),
    blocking: store.isDegraded(target),
    recoveryDueAt: store.recoveryDueAt(target),
    configured: liveTargets().includes(target),
  }));
};

/** Tokens, scopes and caps — everything knowable without calling an API. */
export const connections = () => ({
  instagram: instagramConfigured()
    ? {
        configured: true,
        tokenDaysLeft: tokenDaysLeft(),
        authMode: authMode(),
        lastOkAt: store.lastOkAt('instagram'),
      }
    : { configured: false },
  tiktok: tiktokConfigured()
    ? {
        configured: true,
        tokenHoursLeft: tiktokHoursLeft(),
        refreshTokenDaysLeft: tiktokRefreshDaysLeft(),
        scope: store.getTikTokToken()?.scope || null,
        // Decks go out as drafts, so video.upload is the one that matters.
        missingScopes: tiktokMissingScopes({ draft: true }),
        dailyCap: TIKTOK_DAILY_CAP(),
        usedInLast24h: store.tiktokPostsInLast24h(),
        capFreesAt: store.tiktokCapFreesAt(),
        lastOkAt: store.lastOkAt('tiktok'),
      }
    : { configured: false },
  images: imagesEnabled(),
});

/** The dashboard: every number, in one read, with nothing slow in it. */
export function overview() {
  const day = new Date();
  const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return {
    now: Date.now(),
    counts: {
      staged: store.stagingSize(),
      proposals: store.proposalSize(),
      queue: store.queueSize(),
      held: store.heldCount(),
      publishedToday: store.publishedToday(),
      stagedToday: store.stagedToday(dayKey) - store.rejectedToday(dayKey),
      rejectedToday: store.rejectedToday(dayKey),
      publishedEver: store.publishedCount(),
    },
    schedule: {
      postIntervalMinutes: store.setting('POST_INTERVAL_MINUTES'),
      decksPerDay: store.setting('DECKS_PER_DAY'),
      deckBacklogMax: store.setting('DECK_BACKLOG_MAX'),
      runHour: store.setting('RUN_HOUR'),
      gatherUntilHour: store.setting('GATHER_UNTIL_HOUR'),
      gatherEveryHours: store.setting('GATHER_EVERY_HOURS'),
      quietAlertHours: store.setting('QUIET_ALERT_HOURS'),
    },
    lastStagedAt: store.lastStagedAt(),
    lastPublishedAt: store.lastPublishedAt(),
    lastPublishedKind: store.lastPublishedKindOf(),
    targets: {
      live: liveTargets(),
      byKind: { card: targetsForKind('card'), deck: targetsForKind('deck') },
    },
    health: health(),
    connections: connections(),
    usage: usageSnapshot(),
    usageReport: usageReport(),
    jobs: jobs.list().slice(0, 12),
  };
}

/** The marketing copy rules, as the config file currently parses. */
export const marketingConfig = () => {
  try {
    return { ok: true, config: brickConfig() };
  } catch (e) {
    // brickConfig() throws on an unusable file, deliberately and loudly. The
    // settings page is the one place that must survive it rather than 500 — it is
    // where the broken file gets fixed.
    return { ok: false, error: String(e.message || e) };
  }
};

export const audit = ({ limit = 100 } = {}) => store.auditTrail({ limit });
