import * as store from '../store.js';
import * as notify from '../notify.js';
import { emit } from './bus.js';
import * as jobs from './jobs.js';
import { telegram as surface } from './surface.js';
import { publishNext } from './publish.js';
import { proposeDeck as planDeck, buildProposed, draftHook } from '../brick/build.js';
import { toBrickCandidate, brickApprovalMessage } from '../brick/candidate.js';
import { proposalMessage, proposalWarning } from '../brick/proposal.js';
import { renderBrickCover, renderBrickSlideAt } from '../render/brickDeck.js';
import { cachedShotFor, shotOrProduct } from '../images/homeShot.js';
import { creatorInfo, defaultPrivacy, nextPrivacy, privacyHe, describeError as describeTikTokError } from '../publish/tiktok.js';
import { targetsForKind, targetsHe, liveTargets } from '../publish/targets.js';
import { runOverridden, noteOverride } from '../override.js';

// Every marketing action, once, with no idea which surface asked for it.
//
// WHY THIS FILE EXISTS
//
// All of this used to live inside bot.js, inside Telegraf handlers, interleaved
// with ctx.answerCbQuery and ctx.editMessageCaption. That was fine while Telegram
// was the only way in. The moment a website could approve a deck too, every one
// of these actions had exactly two possible futures: a second implementation that
// drifts, or this.
//
// Drift is not hypothetical here. Approving a deck is not "set a flag" — it
// decides whether TikTok gets a draft now or a queue slot later, refunds the
// day's quota on a rejection, and settles the card so it cannot be tapped twice.
// A browser button that reimplemented three of those four would look like it
// worked for weeks.
//
// THE RULES EVERY ACTION HERE FOLLOWS
//
//   1. It does the work through src/store.js, which is the single writer.
//   2. It records who asked, in the audit trail, because there is now more than
//      one person who could have.
//   3. It emits on the bus, so the OTHER surface stops showing something untrue.
//   4. It returns a plain object. No ctx, no res, no HTML, no Telegram markup.
//   5. Anything slow returns a job instead of blocking, because the two callers
//      time out at 90 seconds and at whatever the proxy says.

/** The local date, not the UTC one — see the note in bot.js. */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Who did this, in a few words, for a status line a human reads.
 *
 * The surface is part of the answer rather than a detail. "approved by Netanel"
 * is ambiguous when Netanel has a phone and a laptop; "approved · from the site"
 * tells you where to go and look at what else happened around it.
 */
export function describeActor(actor) {
  if (!actor) return null;
  const name = actor.name || actor.username || null;
  if (actor.kind === 'web') return name ? `${name} · מהאתר` : 'מהאתר';
  if (actor.kind === 'telegram') return name ? `${name} · מטלגרם` : 'מטלגרם';
  if (actor.kind === 'timer') return 'אוטומטי';
  return name;
}

/** The audit line and the bus event, which every action wants in the same breath. */
function record(action, actor, detail = {}) {
  store.note({
    action,
    actor: actor ? { kind: actor.kind, id: actor.id ?? null, name: actor.name || actor.username || null } : null,
    ...detail,
  });
  emit(action, { actor: describeActor(actor), ...detail });
}

const say = (text) => surface().say(text).catch(() => {});

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Ask TikTok who we would be posting as, and which privacy levels it allows.
 *
 * Done at staging rather than at publish time, because the answer has to be on
 * the card you are looking at when you tap approve — that is TikTok's rule for
 * Direct Post and the reason this call exists. A failure here does not block
 * staging: the card still goes out for approval carrying the reason, and the
 * publish attempt is what fails, loudly, with the same message.
 */
export async function attachTikTok(cand) {
  if (!cand.publishTargets?.includes('tiktok')) return cand;
  // A draft has no privacy level to show you. TikTok asks you in the app when
  // you post it, so asking creator_info here would spend a call to display a
  // choice that is not yours to make.
  if (cand.tiktokDraft) return cand;
  try {
    const info = await creatorInfo();
    return {
      ...cand,
      tiktok: {
        username: info.username,
        options: info.options,
        privacy: defaultPrivacy(info.options),
      },
    };
  } catch (e) {
    const detail = describeTikTokError(e);
    console.error('tiktok: creator_info failed:', detail);
    return { ...cand, tiktok: { error: detail, options: [] } };
  }
}

/**
 * Put a built deck in front of whoever is watching, on every surface.
 *
 * The Telegram coordinates come back from the send and are stored ON the staged
 * item. That is the one piece of state that makes two surfaces work: without it,
 * approving in the browser leaves a card in the chat with live buttons over a
 * post that has already published, and a second tap on that card is precisely
 * what the approval flow exists to prevent.
 */
export async function stage(candidate, { actor = null } = {}) {
  const cand = await attachTikTok(candidate);
  const key = store.addStaging(cand);

  let tg = null;
  try {
    tg = await surface().sendApproval(key, cand);
  } catch (e) {
    // A send that fails leaves a post staged and INVISIBLE in Telegram. It has
    // to be added before the send — the key is what the buttons carry — so the
    // item exists, is counted by /pending, and has no card in the chat to act
    // on. The likeliest cause is Telegram refusing a burst. Not worth failing
    // the post over: the post is fine, it is on the website, and /resend picks
    // it up.
    console.error(`stage: card did not reach Telegram — ${e?.message || e}`);
    await say(`⚠️ פוסט נוצר אבל הכרטיס לא נשלח (${store.stagingSize()} ממתינים) · /resend · או באתר`);
  }

  if (tg) {
    store.updateStaging(key, { tg });
    // Stamped after the send, so the quiet alarm measures cards that actually
    // arrived — not ones that were built and then failed to reach you.
    store.noteStagedAt();
  } else if (!surface().live) {
    // No Telegram attached at all (a script, a test, a website-only install).
    // The card still reached a surface, so the quiet alarm must not read this as
    // silence — it would alert every hour on an install that is working.
    store.noteStagedAt();
  }

  record('staged', actor, { key, headline: cand.headline, kind: cand.kind });
  return { key, cand: store.getStaging(key) };
}

/**
 * Approve one staged post.
 *
 * `tg` may be handed in by the Telegram surface when the tap arrived on a card
 * whose coordinates predate this feature; otherwise the stored ones are used. So
 * an approval settles the card either way and neither surface has to know which.
 */
export async function approve(key, { actor = null, tg = null } = {}) {
  const cand = store.takeStaging(key);
  if (!cand) return { ok: false, reason: 'gone', said: 'כבר טופל' };
  store.clearPendingEdit(key);

  // A draft is a handoff, not a publish, so there is nothing for the drip to
  // pace. It goes to the TikTok inbox now and waits there; the interval exists
  // so the FEED does not arrive in bursts, and an inbox is not a feed.
  // Instagram is a real post and keeps its place in the queue.
  const targets = cand.pendingTargets?.length ? cand.pendingTargets : cand.publishTargets || [];
  const draftNow = Boolean(cand.tiktokDraft) && targets.includes('tiktok');
  const queued = draftNow ? targets.filter((t) => t !== 'tiktok') : targets;

  if (queued.length) store.enqueue({ ...cand, pendingTargets: queued });
  const pos = store.queueSize();
  const said = draftNow
    ? queued.length
      ? `✅ טיוטה לטיקטוק · ${pos} בתור לאינסטגרם`
      : '✅ נשלח לטיוטות בטיקטוק'
    : `✅ אושר — ${pos} בתור`;

  const who = describeActor(actor);
  await surface().settle(tg || cand.tg, who ? `${said} · ${who}` : said, cand);

  record('approved', actor, { key, headline: cand.headline, targets: queued, draftNow, queueSize: pos });

  // After the card is settled, so a slow upload cannot leave the message looking
  // undecided while it runs.
  if (draftNow) {
    jobs.run('טיוטה לטיקטוק', () => publishNext({ ...cand, pendingTargets: ['tiktok'] }), {
      actor: who,
      meta: { headline: cand.headline },
    });
  }

  return { ok: true, said, queueSize: pos, draftNow, headline: cand.headline };
}

export async function reject(key, { actor = null, tg = null } = {}) {
  const cand = store.takeStaging(key);
  if (!cand) return { ok: false, reason: 'gone', said: 'כבר טופל' };
  store.clearPendingEdit(key);
  // Give the day's quota slot back. A rejected card is not one of "the best two
  // or three a day", and charging the day for it meant rejecting the morning's
  // three ended the day. DECK_BACKLOG_MAX is what stops the refund turning into
  // an endless supply.
  store.noteRejected(localDay());

  const who = describeActor(actor);
  await surface().settle(tg || cand.tg, who ? `❌ נדחה · ${who}` : '❌ נדחה', cand);
  record('rejected', actor, { key, headline: cand.headline });
  return { ok: true, said: '❌ נדחה', headline: cand.headline };
}

/**
 * Cycle the TikTok privacy level for one staged card.
 *
 * The card is rewritten in place on every surface so the level about to be
 * published is always the level printed on the thing you are looking at — a
 * button that changed hidden state would defeat the point of showing it.
 */
export async function cyclePrivacy(key, { actor = null, tg = null } = {}) {
  const cand = store.getStaging(key);
  if (!cand) return { ok: false, reason: 'gone', said: 'כבר טופל' };

  const options = cand.tiktok?.options || [];
  if (options.length < 2) return { ok: false, reason: 'no-options', said: 'אין רמות פרטיות אחרות זמינות' };

  const privacy = nextPrivacy(cand.tiktok.privacy, options);
  store.updateStaging(key, { tiktok: { ...cand.tiktok, privacy } });
  const updated = store.getStaging(key);

  await surface().rewriteApproval(tg || updated.tg, key, updated);
  record('privacy', actor, { key, headline: cand.headline, privacy });
  return { ok: true, privacy, said: `🔒 ${privacyHe(privacy)}` };
}

/**
 * A new cover line, and slide one re-drawn to carry it.
 *
 * The rest of the deck is untouched — same five slides, same photographs, same
 * URLs. Only the hook changes, which is the thing that is actually wrong when a
 * cover is wrong. It costs one short model call; the photographs are already
 * paid for and come back out of the shot cache.
 */
export function newCover(key, { actor = null } = {}) {
  const cand = store.getStaging(key);
  if (!cand || cand.kind !== 'deck') return { ok: false, reason: 'gone', said: 'כבר טופל' };

  const who = describeActor(actor);
  const job = jobs.run(
    'שער חדש',
    async (progress) => {
      const deck = cand.deck;

      // The photograph the cover is drawn over, from the cache it was written to
      // during the build. Checked BEFORE the model call: if the shot is gone
      // there is nothing to draw on, and finding that out after paying for a line
      // would be the wrong order.
      const first = deck.slides?.[0];
      const image = first?.productId ? cachedShotFor(first.productId, 1) : null;
      if (!image) {
        const msg = '⚠️ התמונה של השקופית הראשונה כבר לא במטמון — צריך לבנות מחדש';
        await say(msg);
        return { ok: false, message: msg };
      }

      progress('כותב שער חדש...');

      // The line on screen, and any it already replaced, handed over as things
      // not to write again. Without this the second call returns the first
      // answer: same recipe in, same sentence out.
      deck.pastHooks = [...new Set([...(deck.pastHooks || []), deck.hookHe].filter(Boolean))];

      const drawn = await draftHook(
        {
          kind: deck.recipe,
          subject: deck.subject,
          theme: deck.theme || null,
          ceiling: deck.ceiling || null,
          agorotCeiling: deck.agorotCeiling || null,
          deals: (deck.slides || []).map((s) => ({
            product: s.nameHe,
            price: s.deal?.price,
            comparison: s.deal?.comparison,
          })),
        },
        { avoid: deck.pastHooks }
      );

      if (drawn.hook === deck.hookHe || deck.pastHooks.includes(drawn.hook)) {
        const msg = `🔁 יצא אותו שער — נסה שוב\n\n"${drawn.hook}"`;
        await say(msg);
        return { ok: false, message: msg, hook: drawn.hook };
      }

      deck.hookHe = drawn.hook;
      deck.emphasisHe = drawn.emphasis;
      deck.hookFrom = drawn.from;

      progress('מצייר את השער...');

      // Every size the deck was rendered for, so the two stay in step. A cover
      // re-drawn for TikTok alone would leave Instagram publishing the old line.
      for (const size of ['tiktok', 'instagram']) {
        if (!Array.isArray(deck[size]) || !deck[size].length) continue;
        deck[size][0] = await renderBrickCover(deck, { size, image });
      }
      if (Array.isArray(deck.preview) && deck.preview.length) {
        deck.preview[0] = deck[deck.instagram ? 'instagram' : 'tiktok'][0];
      }

      store.updateStaging(key, { deck, card: deck.preview?.[0] || cand.card });
      const fresh = store.getStaging(key);
      console.log(`deck: new cover · ${drawn.from} · "${drawn.hook}"`);

      // A fresh card, because the old one is no longer what would publish. The
      // previous card's buttons were taken away at the tap — see the caller.
      const tg = await surface().sendApproval(key, fresh);
      if (tg) store.updateStaging(key, { tg });

      record('cover', actor, { key, headline: fresh.headline, hook: drawn.hook, from: drawn.from });
      return { ok: true, hook: drawn.hook, from: drawn.from };
    },
    { actor: who, meta: { key, headline: cand.headline } }
  );

  return { ok: true, job, said: '🔁 כותב שער חדש...' };
}

/**
 * A different photograph for one slide.
 *
 * THIS ONE COSTS MONEY, which is why every surface says so before starting. The
 * cover re-draw re-uses the cached shot because the picture is meant to stay the
 * same; here the whole point is a different picture, so it must generate.
 *
 * `n` is the slide number as a person reads it off the card — 1-based, cover
 * excluded — because that is the number they are looking at.
 */
export function newPhoto(key, n, { actor = null } = {}) {
  const cand = store.getStaging(key);
  if (!cand || cand.kind !== 'deck') return { ok: false, reason: 'gone', said: 'אין מצגת שממתינה לאישור' };

  const at = Number(n) - 1;
  const slide = cand.deck?.slides?.[at];
  if (!slide) {
    return {
      ok: false,
      reason: 'no-slide',
      said: `אין שקופית ${n} ב"${cand.headline}" — יש ${cand.deck?.slides?.length || 0}`,
    };
  }

  const deal = { productId: slide.productId, product: slide.nameHe, ...(slide.deal || {}) };
  if (!deal.image && !deal.sourceImage) {
    return {
      ok: false,
      reason: 'no-source',
      said: `⚠️ השקופית הזו נבנתה לפני שהמקור נשמר — צריך לבנות מחדש\n("${slide.nameHe}")`,
    };
  }

  const who = describeActor(actor);
  const job = jobs.run(
    'תמונה חדשה',
    async (progress) => {
      progress(`מייצר תמונה לשקופית ${n} — ${slide.nameHe}`);
      // force, because a cached shot is exactly what we are trying to get away
      // from. shotOrProduct falls back to the catalogue photo rather than
      // failing, and says so in its provenance — which the approval card prints.
      const image = await shotOrProduct(deal, { n: at + 1, sizeCm: slide.deal?.sizeCm ?? null, force: true });

      const deck = cand.deck;
      deck.slides[at] = { ...slide, image: { provenance: image.provenance, note: image.note || null } };

      progress('מצייר את השקופית...');
      for (const size of ['tiktok', 'instagram']) {
        if (!Array.isArray(deck[size]) || !deck[size][at + 1]) continue;
        deck[size][at + 1] = await renderBrickSlideAt(deck, at, { size, image });
      }
      if (Array.isArray(deck.preview) && deck.preview[at + 1]) {
        deck.preview[at + 1] = deck[deck.instagram ? 'instagram' : 'tiktok'][at + 1];
      }

      store.updateStaging(key, { deck });
      const fresh = store.getStaging(key);
      console.log(`deck: new photo for slide ${n} · ${image.provenance} · ${slide.nameHe}`);

      const tg = await surface().sendApproval(key, fresh);
      if (tg) store.updateStaging(key, { tg });

      record('photo', actor, { key, headline: fresh.headline, slide: n, provenance: image.provenance });
      return { ok: true, slide: n, provenance: image.provenance };
    },
    { actor: who, meta: { key, headline: cand.headline, slide: n } }
  );

  return {
    ok: true,
    job,
    said: `🖼️ מייצר תמונה חדשה לשקופית ${n} — "${slide.nameHe}" (קריאה אחת למודל)`,
  };
}

/**
 * Send the approval cards again.
 *
 * For the case where a post exists and its card does not. Spaced out on purpose:
 * the likeliest reason the first attempt failed is that several went at once and
 * Telegram refused the burst, and resending at the same rate would reproduce
 * exactly that.
 */
export function resend({ actor = null } = {}) {
  const rows = store.stagingItems();
  if (!rows.length) return { ok: false, reason: 'empty', said: 'אין ממתינים' };

  const job = jobs.run(
    'שליחה מחדש',
    async (progress) => {
      let sent = 0;
      for (const [i, { key, cand }] of rows.entries()) {
        progress(`${i + 1}/${rows.length}`);
        try {
          const tg = await surface().sendApproval(key, cand);
          // The new coordinates replace the old ones, so settling later edits the
          // card that is actually on screen rather than the one that never
          // arrived.
          if (tg) store.updateStaging(key, { tg });
          sent += 1;
        } catch (e) {
          console.error(`resend: ${cand.headline} — ${e?.message || e}`);
        }
        // A second and a half between cards. The per-chat burst limit is what is
        // being worked around, and a deck is an album plus a message.
        await new Promise((r) => setTimeout(r, 1500));
      }
      await say(`📨 ${sent}/${rows.length} נשלחו`);
      record('resent', actor, { sent, of: rows.length });
      return { sent, of: rows.length };
    },
    { actor: describeActor(actor) }
  );

  return { ok: true, job, count: rows.length, said: `📨 שולח מחדש ${rows.length} כרטיסים...` };
}

export function clearPending({ actor = null } = {}) {
  const n = store.clearStaging();
  record('cleared:pending', actor, { count: n });
  return { ok: true, count: n, said: `🧹 נוקו ${n} פריטים ממתינים` };
}

// ---------------------------------------------------------------------------
// Proposals — the text stage, before anything is paid for
// ---------------------------------------------------------------------------

/**
 * Plan a deck and put it in front of the admins, having spent nothing.
 *
 * The proposal is where a deck stops until it is answered. Everything below it —
 * the cover call, one generated photograph per slide, twelve renders — takes
 * minutes and real money, and all of it used to happen before anything had been
 * seen.
 *
 * Owner-triggered work runs under runOverridden: a deck asked for by name is the
 * case the override was written for. "Two Harry Potter decks back to back" is a
 * legitimate request; it is only a problem if it happens without anyone saying
 * so, which is what the disclosure on the card prevents.
 */
export function proposeDeck({ request = null, actor = null, reason = '/deck' } = {}) {
  const who = describeActor(actor);
  const job = jobs.run(
    'הצעת מצגת',
    async (progress) => {
      progress(request ? `קורא את הפיד — ${request}` : 'קורא את הפיד');
      return runOverridden(reason, async () => {
        let proposal;
        try {
          proposal = await planDeck(request || null);
        } catch (e) {
          // The feed's own rejections are the useful part of this failure: "every
          // deal is stale" and "the feed did not parse" look identical otherwise,
          // and only one of them is something to fix here.
          const why = e.feedDropped?.length
            ? ['', ...e.feedDropped.slice(0, 5).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`)].join('\n')
            : '';
          await say(notify.withDetail(`❌ לא הצלחתי להציע מצגת${why}`, e));
          throw e;
        }

        const key = store.addProposal({ proposal });
        const warning = proposalWarning(proposal);
        const tg = await surface()
          .sendProposal(key, `${proposalMessage(proposal)}${warning ? `\n\n⚠️ ${warning}` : ''}`)
          .catch((e) => {
            console.error(`proposal: card did not reach Telegram — ${e?.message || e}`);
            return null;
          });
        if (tg) store.updateProposal(key, { tg });

        record('proposed', actor, { key, subject: proposal.subject, recipe: proposal.recipe, warning });
        return { key, subject: proposal.subject, warning };
      });
    },
    { actor: who, meta: { request } }
  );
  return { ok: true, job, said: '⏳ מחפש מצגת להציע' };
}

/**
 * Re-plan a proposal from a free-text instruction.
 *
 * NOT a model call, and that is deliberate. The request language is small and
 * closed — a theme, a price, or a set name — and `chooseRecipe` already
 * interprets all three, falling through to something buildable rather than
 * answering with a complaint. Asking a model to translate "cheaper" into "under
 * 100₪" would be paying for a worse version of a function that already exists.
 *
 * It re-reads the feed, so a set that sold out between the two messages is gone
 * from the new proposal rather than carried forward.
 */
export function reviseProposal(key, instruction, { actor = null } = {}) {
  const held = store.getProposal(key);
  if (!held) return { ok: false, reason: 'gone', said: 'ההצעה הזו כבר לא ממתינה' };
  const said = String(instruction || '').trim();
  if (!said) return { ok: false, reason: 'empty', said: 'צריך לכתוב מה לשנות' };

  const who = describeActor(actor);
  const job = jobs.run(
    'שינוי הצעה',
    async (progress) => {
      progress(`מתכנן מחדש — ${said}`);
      return runOverridden('/deck', async () => {
        let proposal;
        try {
          proposal = await planDeck(said);
        } catch (e) {
          await say(notify.withDetail('❌ השינוי נכשל', e));
          throw e;
        }
        if (!store.updateProposal(key, { proposal })) {
          return { ok: false, message: 'ההצעה הזו כבר לא ממתינה' };
        }

        const warning = proposalWarning(proposal);
        const tg = await surface()
          .sendProposal(key, `🤖 עודכן:\n\n${proposalMessage(proposal)}${warning ? `\n\n⚠️ ${warning}` : ''}`)
          .catch(() => null);
        if (tg) store.updateProposal(key, { tg });

        record('revised', actor, { key, instruction: said, subject: proposal.subject });
        return { ok: true, key, subject: proposal.subject, warning };
      });
    },
    { actor: who, meta: { key, instruction: said } }
  );

  return { ok: true, job, said: '🤖 משנה את ההצעה...' };
}

export async function rejectProposal(key, { actor = null, tg = null } = {}) {
  const held = store.getProposal(key);
  if (!held) return { ok: false, reason: 'gone', said: 'כבר טופל' };
  store.clearProposal(key);

  const who = describeActor(actor);
  await surface().settleProposal(tg || held.tg, who ? `❌ נדחה · ${who}` : '❌ נדחה');
  record('proposal:rejected', actor, { key, subject: held.proposal?.subject });
  return { ok: true, said: '❌ נדחה' };
}

/**
 * Build a proposal that was approved, and stage what comes out.
 *
 * Re-enters runOverridden: the override is what lets a deck the owner asked for
 * step over the repeat guards, and an AsyncLocalStorage context cannot survive
 * the wait for somebody to tap a button.
 *
 * The destination is chosen here, before anything is built — which is the only
 * point at which choosing it saves anything. A deck renders twelve slides across
 * two aspect ratios; picking the platform first halves that, and the approval
 * card then previews the crop that is actually going out.
 */
export function buildProposal(key, { targets = ['instagram'], draft = false, actor = null } = {}) {
  const held = store.getProposal(key);
  if (!held) return { ok: false, reason: 'gone', said: 'כבר טופל' };

  // Said at the tap, not after the build. Choosing a destination that is not
  // connected is allowed — the deck is built and held until it is — but learning
  // that after waiting for the photographs is the wrong order to find it out in.
  const configured = targetsForKind('deck');
  const missing = targets.filter((t) => !configured.includes(t));
  const said = missing.length
    ? `⏳ בונה — ${targetsHe(missing)} עוד לא מחובר, הפוסט ימתין`
    : draft
      ? '⏳ בונה — טיקטוק יחכה לך בטיוטות'
      : '⏳ בונה';

  const who = describeActor(actor);
  // runOverridden wraps the whole job body, not just the planning. The override
  // is what lets a deck somebody asked for by name step over the repeat guards,
  // and those guards run during the BUILD — toBrickCandidate asks brickRepeats
  // what this deck looks like a repeat of. An AsyncLocalStorage context cannot
  // survive the wait for a button, so it is re-entered here rather than inherited
  // from whichever surface started this.
  const job = jobs.run(
    'בניית מצגת',
    (progress) => runOverridden('/deck', async () => {
      const current = store.getProposal(key);
      if (!current) return { ok: false, message: 'ההצעה הזו כבר לא ממתינה' };
      const { proposal } = current;
      store.clearProposal(key);

      // Progress rewrites the proposal message instead of sending new ones. A
      // deck takes minutes, and silence looks like a hang — that is why these
      // lines exist at all. But each one as a fresh message meant four buzzes to
      // learn three things you could not act on.
      const step = async (text) => {
        progress(text);
        await surface().editText(current.tg, `⏳ ${proposal.subject}\n${text}`);
      };

      try {
        await step('כותב שער...');
        const built = await buildProposed(proposal, { onProgress: (s) => step(s) });

        if (!built?.slides?.length) {
          const msg = [
            `😕 לא נשארו שקופיות ב"${proposal.subject}"`,
            ...(built?.dropped || []).slice(0, 4).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`),
          ].join('\n');
          await say(msg);
          return { ok: false, message: msg };
        }

        // Rendered for the chosen destination only, and staged owing just that.
        const cand = await toBrickCandidate(built, { targets, tiktokDraft: draft });

        if (store.hasPublished(cand.id)) {
          const msg = `⏭️ המצגת הזו כבר פורסמה (${cand.id}) — נסה רעיון אחר`;
          await say(msg);
          return { ok: false, message: msg };
        }

        // The proposal message has done its job. Removing it means the deck
        // arrives as one album and one approval card, with no stale "⏳ building"
        // line left above them contradicting the finished thing underneath.
        await surface().remove(current.tg);

        const staged = await stage(cand, { actor });
        console.log(
          `deck: staged ${built.slides.length} slides · ${built.recipe} · cover from ${built.hookFrom}` +
            (built.dropped.length ? ` · ${built.dropped.length} dropped` : '')
        );
        record('built', actor, {
          key: staged.key,
          subject: proposal.subject,
          slides: built.slides.length,
          targets,
          draft,
        });
        return { ok: true, key: staged.key, slides: built.slides.length, headline: cand.headline };
      } catch (e) {
        const why = e.deck?.dropped?.length
          ? ['', ...e.deck.dropped.slice(0, 5).map((d) => `   ✗ ${d.id}: ${String(d.why).slice(0, 90)}`)].join('\n')
          : '';
        await say(notify.withDetail(`❌ בניית המצגת נכשלה${why}`, e));
        throw e;
      }
    }),
    { actor: who, meta: { key, targets, draft } }
  );

  return { ok: true, job, said, missing };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * Publish the next queued post now, rather than at the next drip.
 *
 * The drip is POST_INTERVAL_MINUTES apart so the channel does not arrive in
 * bursts. Asking for the next one immediately steps over that, and how far over
 * is worth saying: "posted 10 minutes after the last one instead of 240" is the
 * difference between a deliberate double-post and one you will be surprised by.
 */
export async function publishNow({ actor = null } = {}) {
  const intervalMs = store.setting('POST_INTERVAL_MINUTES') * 60_000;
  const sinceLast = store.lastPublishedAt() ? Date.now() - store.lastPublishedAt() : null;
  const ok = await runOverridden('/next', async () => {
    if (sinceLast !== null && sinceLast < intervalMs) {
      noteOverride('מרווח', `${Math.round(sinceLast / 60_000)}/${store.setting('POST_INTERVAL_MINUTES')} דק׳`);
    }
    return publishNext();
  });
  record('publish:next', actor, { ok });
  return { ok, said: ok ? '📤 פורסם הפריט הבא' : 'התור ריק' };
}

/**
 * Publish one specific queued post, now, out of turn.
 *
 * The same act as publishNow with a choice attached, so it carries the same
 * disclosure — plus one of its own: this post jumped the queue, which is a thing
 * somebody did on purpose and which the posts behind it did not.
 *
 * `n` is 1-based because it is the number the list printed. Asking a person to
 * subtract one is how the wrong post gets published.
 */
export async function publishAt(n, { actor = null } = {}) {
  // Taken out BEFORE publishing, so a slow publish cannot have the drip pick the
  // same post up underneath it. If publishing then fails, the post follows the
  // ordinary failure path — held or requeued — exactly as it would have from the
  // drip.
  const item = store.takeQueuedAt(n);
  if (!item) return { ok: false, reason: 'no-item', said: `אין פריט ${n} בתור` };

  const minutes = store.setting('POST_INTERVAL_MINUTES');
  const sinceLast = store.lastPublishedAt() ? Date.now() - store.lastPublishedAt() : null;
  const ok = await runOverridden('/post', async () => {
    noteOverride('סדר התור', `#${n} לפני התור`);
    if (sinceLast !== null && sinceLast < minutes * 60_000) {
      noteOverride('מרווח', `${Math.round(sinceLast / 60_000)}/${minutes} דק׳`);
    }
    return publishNext(item);
  });
  record('publish:at', actor, { n, headline: item.headline, ok });
  return { ok, headline: item.headline, said: ok ? '📤 פורסם' : 'לא פורסם — ראו את ההודעה' };
}

/**
 * Send a queued post to TikTok drafts now, without waiting for the drip.
 *
 * The same act approval performs automatically, available for anything already in
 * the queue — a post approved before this existed, or one whose TikTok half was
 * requeued after a failure.
 *
 * Only the TikTok half moves. Anything else the post still owes goes back on the
 * queue and keeps its turn, because that half is a real publish and the drip
 * exists for it.
 */
export function draftAt(n, { actor = null } = {}) {
  const item = store.takeQueuedAt(n);
  if (!item) return { ok: false, reason: 'no-item', said: `אין פריט ${n} בתור` };

  const targets = item.pendingTargets?.length ? item.pendingTargets : item.publishTargets || [];
  if (!targets.includes('tiktok')) {
    // Put it back exactly as it was. Taking a post out of the queue to say it was
    // the wrong one would be a worse answer than the error.
    store.enqueue(item);
    return { ok: false, reason: 'not-tiktok', said: `הפריט הזה לא מיועד לטיקטוק (${targetsHe(targets) || 'אין יעד'})` };
  }

  const rest = targets.filter((t) => t !== 'tiktok');
  if (rest.length) store.enqueue({ ...item, pendingTargets: rest });

  const job = jobs.run('טיוטה לטיקטוק', () => publishNext({ ...item, pendingTargets: ['tiktok'] }), {
    actor: describeActor(actor),
    meta: { headline: item.headline },
  });
  record('draft:at', actor, { n, headline: item.headline });
  return { ok: true, job, headline: item.headline, said: `⏳ שולח לטיוטות: ${item.headline}` };
}

/**
 * Empty the publish queue.
 *
 * Deliberately separate from clearPending rather than folded into it. Those are
 * things nobody has answered yet; this is something already said yes to, and a
 * command that threw both away on one word would be the wrong shape for the more
 * expensive of the two mistakes.
 */
export function clearQueue({ actor = null } = {}) {
  const n = store.clearQueue();
  record('cleared:queue', actor, { count: n });
  return {
    ok: Boolean(n),
    count: n,
    said: n ? `🧹 רוקנתי את התור — ${n} פוסטים שאושרו לא יפורסמו` : '📦 התור כבר ריק',
  };
}

// ---------------------------------------------------------------------------
// Held posts
// ---------------------------------------------------------------------------

/**
 * Put every held post back on the queue and un-degrade the destinations that
 * were refusing them.
 *
 * This is the deliberate "I have fixed it" signal. Nothing retries by itself once
 * a destination is marked degraded, because while Instagram is blocked at the API
 * a retry is a wasted call and a repeated alert — so something has to say the
 * block is gone, and it should be a person.
 */
export async function retryHeld({ actor = null } = {}) {
  const rows = store.releaseHeld();
  const targets = new Set();
  for (const h of rows) for (const t of h.targets) targets.add(t);
  // Also clear anything degraded but with nothing held behind it.
  for (const t of liveTargets()) targets.add(t);
  for (const t of targets) store.clearDegraded(t);

  for (const h of rows) store.enqueue({ ...h.cand, publishAttempts: 0, pendingTargets: h.targets });
  record('retry', actor, { count: rows.length, targets: [...targets] });

  if (!rows.length) {
    return { ok: true, count: 0, said: 'אין מה להחזיר לתור. סימנתי את כל היעדים כתקינים — הפרסום הבא ינסה שוב.' };
  }
  const ok = await publishNext();
  return {
    ok,
    count: rows.length,
    said: `🔁 ${rows.length} פוסטים חזרו לתור. ${ok ? 'הראשון פורסם' : 'עדיין נכשל'}`,
  };
}

/**
 * Give up on the held backlog, and un-degrade the destinations it was stuck on.
 *
 * retryHeld assumes the held cards can succeed once the destination is back. Some
 * cannot: a card is frozen at approval with what its destinations said then, and
 * for TikTok that includes the privacy level, read once at staging and never
 * again. A card approved while TikTok was unreachable has none, so it fails the
 * instant it is picked up — and retry re-enqueues it verbatim, so it fails
 * identically every time while re-degrading TikTok behind it.
 *
 * What is discarded is only what a destination still OWED. Every target that
 * already published did so before the card was held.
 */
export async function clearHeld({ actor = null } = {}) {
  const rows = store.heldItems();
  if (!rows.length) return { ok: false, reason: 'empty', said: '✅ אין פוסטים מוחזקים' };

  const lost = new Set();
  for (const h of rows) for (const t of h.targets) lost.add(t);

  const n = store.clearHeld();
  // The point of the command. Un-degrading is what lets the NEXT post reach the
  // destination, and it is the half that retry could not deliver on its own here.
  for (const t of liveTargets()) store.clearDegraded(t);
  record('cleared:held', actor, { count: n, lost: [...lost] });

  return {
    ok: true,
    count: n,
    said: [
      `🗑️ ${n} פוסטים מוחזקים נמחקו.`,
      `ויתרנו על: ${targetsHe([...lost])}`,
      'מה שכבר פורסם נשאר. כל היעדים סומנו כתקינים - הפוסט הבא ינסה מחדש.',
    ].join('\n'),
  };
}

export { brickApprovalMessage, proposalMessage, proposalWarning };
