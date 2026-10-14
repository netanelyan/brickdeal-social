import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { record as recordUsage } from '../usage.js';
import { brickConfig } from './config.js';
import { unusable } from './feed.js';
import { assertCopy, assertNoUrl, shekels, agorotText } from './copy.js';
import { agorotPerPiece } from './recipes.js';
import { MAX_HOOK_WORDS } from './build.js';
import { benchmarks, benchmarkLines } from './benchmarks.js';
import { renderToJpeg } from '../render/index.js';
import { measuredPosts } from '../store.js';

// Whether a built deck is good enough to post without anybody looking at it.
//
// In auto mode this is the only thing between a deck and TikTok, so it is built
// the way every other check in this pipeline is: anything it cannot establish
// counts against the deck. Two stages, and a deck has to pass the first to be
// shown to the second.
//
//   A. HARD GATES. Deterministic, and any one failure drops the deck. Almost
//      all of them already exist somewhere and are called here rather than
//      written again: the freshness rule in feed.js, the verdicts homeShot.js's
//      vision checks left on each photograph, the trademark guard in copy.js,
//      the word limit in build.js.
//   B. ONE MODEL CALL that looks at the whole deck as a contact sheet next to
//      the price table it was built from, and scores five parts from 0 to 100.
//      The total is the weighted average of the parts, worked out here rather
//      than trusted from the model, so the weights in brick-config.json mean
//      what they say and two calls cannot disagree with their own arithmetic.
//      An answer that does not parse, or an API error, is a failed deck.
//
// Every score is returned whole and kept on the deck, because the next
// question is whether any of it predicts views. See /score.

export const SUBSCORES = ['hook', 'slide1', 'photos', 'savings', 'variety'];

const MODEL = () => process.env.SCORE_MODEL || 'claude-opus-5-5';
// Models that take the server-side refusal fallback. A judge that is refused
// would otherwise drop the deck, which is safe but wasteful.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

let client = null;
const getClient = () => (client ??= new Anthropic());

/* -------------------------------------------------------------------------- */
/* Stage A                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The hard gates. Returns `{ ok, failures }`; each failure names its gate, the
 * reason, and what a rebuild would have to change to fix it — a new `cover`,
 * or a different `recipe` (different sets).
 */
export function gates(cand, { now = Date.now() } = {}) {
  const deck = cand?.deck || {};
  const slides = deck.slides || [];
  const failures = [];
  const fail = (gate, why, fix) => failures.push({ gate, why, fix });

  // 1. Every price claim, held to feed.js's rule at the moment of scoring,
  //    which can be hours after the feed was read.
  for (const s of slides) {
    const why = unusable(
      {
        productId: s.productId,
        name: s.nameHe,
        price: s.deal?.price,
        link: s.deal?.link,
        image: s.deal?.image,
        sourceImage: s.deal?.sourceImage,
        priceCheckedAt: s.deal?.priceCheckedAt,
      },
      { now }
    );
    if (why) fail('freshness', `${s.nameHe}: ${why}`, 'recipe');
  }

  // 2. Every photograph passed a vision check. `checked` is set by
  //    homeShot.js and nowhere else: true for a generated shot that passed
  //    verifyShot and for a catalogue photo screenListing actually looked at.
  for (const s of slides) {
    if (s.image?.checked === true) continue;
    fail(
      'photo',
      `${s.nameHe}: ${!s.image ? 'no photograph' : s.image.provenance === 'stock' ? 'a catalogue photo nothing screened' : 'a photograph nothing checked'}`,
      'recipe'
    );
  }

  // 3. No trademark, in anything a model or the feed wrote. The comparison
  //    label and the swipe line name the brand on purpose (see `copy` in
  //    brick-config.json) and are written by hand, so they are not checked.
  const written = [
    ['the cover line', deck.hookHe, 'cover'],
    ['the cover emphasis', deck.emphasisHe, 'cover'],
    ['the deck title', deck.titleHe, 'cover'],
    ...slides.map((s) => [`the name "${s.nameHe}"`, s.nameHe, 'recipe']),
    ['the TikTok caption', cand?.tiktokCaption, 'recipe'],
    ['the Instagram caption', cand?.instagramCaption, 'recipe'],
  ];
  for (const [where, text, fix] of written) {
    if (!text) continue;
    try {
      assertCopy(text, where);
      if (where.includes('caption')) assertNoUrl(text, where);
    } catch (e) {
      fail('copy', e.message, fix);
    }
  }

  // 4. Eight sets, with a cover in front and the end card behind.
  const want = brickConfig().deck.slides;
  if (slides.length !== want) fail('frames', `${slides.length} sets, the format is ${want}`, 'recipe');
  const frames = framesOf(cand);
  if (!frames.length) fail('frames', 'nothing was rendered', 'recipe');
  else {
    if (!frames[0]?.cover) fail('frames', 'the first frame is not the cover', 'recipe');
    if (!frames.at(-1)?.end) fail('frames', 'there is no end card (endCard.askHe is empty?)', 'recipe');
    if (frames.length !== slides.length + 2) fail('frames', `${frames.length} frames for ${slides.length} sets`, 'recipe');
  }

  // 5. The cover within the word limit.
  const words = String(deck.hookHe || '').split(/\s+/).filter(Boolean).length;
  if (!words) fail('cover', 'there is no cover line', 'cover');
  else if (words > MAX_HOOK_WORDS) fail('cover', `the cover is ${words} words, the limit is ${MAX_HOOK_WORDS}`, 'cover');

  return { ok: failures.length === 0, failures };
}

/** The 9:16 frames, which are what TikTok shows; the preview size otherwise. */
const framesOf = (cand) => {
  const deck = cand?.deck || {};
  return Array.isArray(deck.tiktok) && deck.tiktok.length ? deck.tiktok : deck.preview || [];
};

/* -------------------------------------------------------------------------- */
/* Stage B                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every slide's claim, as a table the judge can read beside the picture: what
 * we charge, the list price, the saving and the ratio, or the per-piece
 * arithmetic on a per-piece deck.
 */
export function priceTable(cand) {
  const deck = cand?.deck || {};
  const perPiece = deck.recipe === 'perPiece';
  const rows = (deck.slides || []).map((s, i) => {
    const c = s.deal?.comparison;
    const name = `${s.rank ? `#${s.rank} ` : ''}${s.nameHe}`;
    if (perPiece) {
      const each = agorotPerPiece(s.deal || {});
      return `frame ${i + 2}: ${name} | ${shekels(s.deal?.price)} | ${Number(s.deal?.pieces || 0).toLocaleString('en-US')} pieces | ${each ? agorotText(each) : '?'} a piece`;
    }
    if (c?.ok) {
      const pct = Math.round((Number(c.paid) / Number(c.listIls)) * 100);
      return `frame ${i + 2}: ${name} | ours ${shekels(c.paid)} | list ${shekels(c.listIls)} (${c.source?.region || '?'} ${c.source?.amount ?? '?'} ${c.source?.currency || ''}) | saving ${shekels(c.saving)} | ${pct}% of list`;
    }
    return `frame ${i + 2}: ${name} | ours ${shekels(s.deal?.price)} | no comparison (${c?.why || 'unknown'})`;
  });
  return [
    `Recipe: ${deck.recipe || '?'}${deck.theme ? ` (${deck.theme})` : ''} · ${(deck.slides || []).length} sets`,
    `Cover line (frame 1): ${deck.hookHe || '(none)'}`,
    '',
    ...rows,
  ].join('\n');
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'integer', description: 'The cover line, 0-100.' },
    slide1: { type: 'integer', description: 'Frame 2, the first set, 0-100.' },
    photos: { type: 'integer', description: 'Photographs and legibility across every frame, 0-100.' },
    savings: { type: 'integer', description: 'How big and how believable the savings are, 0-100.' },
    variety: { type: 'integer', description: 'How different the sets are from each other, 0-100.' },
    notes: { type: 'string', description: 'One sentence: the change that would most improve this post.' },
  },
  required: ['hook', 'slide1', 'photos', 'savings', 'variety', 'notes'],
  additionalProperties: false,
};

/** The judge's brief, with the measured covers in it. Stable between calls, so it caches. */
export function scoreSystem(b = benchmarks()) {
  const measured =
    b.source === 'own'
      ? `THIS CHANNEL'S OWN POSTS, ${b.n} measured. Most-watched covers:\n${benchmarkLines(b.winners)}\n\nLeast-watched:\n${benchmarkLines(b.losers)}`
      : `THE REFERENCE ACCOUNT (102 posts, median about 5,000 views). Its biggest covers:\n${benchmarkLines(b.winners)}\n\nA mid-table one:\n${benchmarkLines(b.middle)}\n\nIts weakest:\n${benchmarkLines(b.losers)}`;

  return `You judge a Hebrew TikTok photo carousel before it is posted, for a channel that shows Israeli builders what compatible building-brick sets cost on AliExpress, against the original brand's list price.

You are given the whole post as one contact sheet, frames numbered in order: frame 1 is the cover, the frames after it are one set each, and the last is the end card. Under it is the price table the slides were built from.

Score five parts from 0 to 100. Be a hard judge. 70 means "worth posting as it is", 50 is forgettable, and above 90 is rare.

hook: the cover line on frame 1. Does it talk TO THE VIEWER about THEIR money, the way the measured winners below do (אתם, תראו, תמשיכו לגלול, paying Israeli prices, where it is cheaper)? Or does it talk about "me", do arithmetic at the viewer, or describe the picture, like the losers? Is it legible on the frame, and would it stop a scroll?

slide1: frame 2, the first set, which decides whether anybody swipes. A set people want, a saving that is big and plain on the frame, a striking photograph.

photos: every frame. Each photograph must read as a real photograph of a real build: not a drawing, not a 3D render, not a marketplace advertisement with badges, prices or English text on it. The set must be the clear subject, and the Hebrew type must be readable over it on every frame. One bad frame pulls this down hard.

savings: from the price table. How big are the savings, and how believable? 70 to 90 percent off a set people know is the format's whole argument. Small savings, a set with no comparison, or a list price implausibly high for what the set is score low. A per-piece deck (recipe: perPiece) argues the price of one piece instead and never shows a list price, by design: judge how low and believable the price per piece is, and do not mark it down for the missing comparison.

variety: are the sets different from each other in theme, shape, colour and price, or is it the same kind of thing again and again?

MEASURED COVERS, WITH VIEWS. This is what the hook is judged against.

${measured}

Return the JSON object only.`;
}

/**
 * The judge's answer, read strictly.
 *
 * JSON or nothing: a fenced block, a sentence around the object, a missing
 * part, a part that is a string, or a part outside 0 to 100 is a failed
 * answer, and a failed answer is a failed deck. Returns `{ ok: true, sub,
 * total, weakest, notes }` or `{ ok: false, error }`.
 */
export function parseScore(text, { weights = brickConfig().score.weights } = {}) {
  let said;
  try {
    said = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, error: `the answer was not JSON: ${String(text ?? '').slice(0, 80)}` };
  }
  if (!said || typeof said !== 'object' || Array.isArray(said)) return { ok: false, error: 'the answer was not a JSON object' };

  const sub = {};
  for (const k of SUBSCORES) {
    const v = said[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      return { ok: false, error: `${k} is ${JSON.stringify(v)}, not a number from 0 to 100` };
    }
    sub[k] = Math.round(v);
  }
  return {
    ok: true,
    sub,
    total: weightedTotal(sub, weights),
    weakest: weakestOf(sub),
    notes: typeof said.notes === 'string' ? said.notes.slice(0, 300) : null,
  };
}

export const weightedTotal = (sub, weights) => {
  const sum = SUBSCORES.reduce((t, k) => t + (weights[k] || 0), 0);
  return Math.round(SUBSCORES.reduce((t, k) => t + (weights[k] || 0) * sub[k], 0) / sum);
};

/** The lowest part, ties going to the cover: it is the cheapest one to rebuild. */
export const weakestOf = (sub) => SUBSCORES.reduce((low, k) => (sub[k] < sub[low] ? k : low), SUBSCORES[0]);

const SHEET_DIR = () =>
  process.env.SCORE_SHEET_DIR ? resolve(process.env.SCORE_SHEET_DIR) : fileURLToPath(new URL('../../data/scores/', import.meta.url));

/**
 * Every frame of the deck on one image, numbered, for the judge.
 *
 * Kept out of CARD_OUTPUT_DIR, which is public. Written to data/scores/ so
 * the sheet a deck was judged on can be looked at afterwards.
 */
export async function contactSheet(cand, { outDir = SHEET_DIR() } = {}) {
  const frames = framesOf(cand).filter((f) => f?.file);
  if (!frames.length) throw new Error('no rendered frames on disk to judge');
  const W = 288;
  const H = 512;
  const GAP = 12;
  const COLS = 5;
  const rows = Math.ceil(frames.length / COLS);
  const width = COLS * W + (COLS + 1) * GAP;
  const height = rows * (H + 30) + GAP;
  const cells = frames
    .map(
      (f, i) =>
        `<figure><img src="data:image/jpeg;base64,${readFileSync(f.file).toString('base64')}"><figcaption>${i + 1}</figcaption></figure>`
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; background:#111; }
    .grid { display:grid; grid-template-columns:repeat(${COLS}, ${W}px); gap:${GAP}px; padding:${GAP}px; }
    figure { margin:0; } img { width:${W}px; height:${H}px; object-fit:cover; display:block; }
    figcaption { color:#eee; font:bold 16px sans-serif; text-align:center; height:18px; }
  </style></head><body><div class="grid">${cells}</div></body></html>`;
  const out = await renderToJpeg(html, { stem: `sheet-${cand.id || 'deck'}`, width, height, outDir, face: null });
  return { file: out.file, base64: readFileSync(out.file).toString('base64') };
}

/**
 * Stage B: one call, strict answer. Never throws; `{ ok: false, error }` for
 * anything that is not a clean score.
 */
export async function modelScore(cand, { api = null, sheet = null, weights = brickConfig().score.weights } = {}) {
  const model = MODEL();
  try {
    const image = sheet || (await contactSheet(cand)).base64;
    const c = api || getClient();
    const fallbacks = FALLBACK_MODELS.has(model) && process.env.SCORE_FALLBACKS !== 'off';
    const params = {
      model,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCORE_SCHEMA } },
      system: [{ type: 'text', text: scoreSystem(benchmarks(measuredPosts())), cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: priceTable(cand) },
          ],
        },
      ],
    };
    const res = fallbacks
      ? await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await c.messages.create(params);
    recordUsage(res.usage, res.model || model);

    if (res.stop_reason === 'refusal') return { ok: false, error: `the judge refused (${res.stop_details?.category || 'no category'})` };
    if (res.stop_reason === 'max_tokens') return { ok: false, error: 'the judge ran out of tokens before answering' };
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseScore(text, { weights });
    return parsed.ok ? { ...parsed, model: res.model || model } : parsed;
  } catch (e) {
    return { ok: false, error: `the judge could not run: ${e.message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Score one built deck. Never throws.
 *
 * `{ at, stage, pass, total, sub, weakest, notes, threshold, gates, error, why }`.
 * `stage` is where it stopped: 'A' when a gate failed, 'B' otherwise.
 */
export async function scoreDeck(cand, { now = Date.now(), api = null, sheet = null } = {}) {
  const { threshold, weights } = brickConfig().score;
  const at = new Date(now).toISOString();
  const a = gates(cand, { now });
  if (!a.ok) {
    return { at, stage: 'A', pass: false, total: null, sub: null, threshold, gates: a.failures, why: a.failures.map((f) => f.why).join('; ') };
  }
  const b = await modelScore(cand, { api, sheet, weights });
  if (!b.ok) {
    return { at, stage: 'B', pass: false, total: null, sub: null, threshold, gates: [], error: b.error, why: b.error };
  }
  const pass = b.total >= threshold;
  return {
    at,
    stage: 'B',
    pass,
    total: b.total,
    sub: b.sub,
    weakest: b.weakest,
    notes: b.notes,
    model: b.model,
    threshold,
    gates: [],
    why: pass ? null : `${b.total} < ${threshold}, weakest: ${b.weakest}`,
  };
}

/**
 * What to do with a scored deck: 'publish', a rebuild with a new 'cover', a
 * rebuild with a different 'recipe', or 'drop'.
 *
 * One rebuild, then drop. A rebuild fixes what failed: a new cover when only
 * the cover broke a gate or the cover is the weakest part, different sets for
 * anything else. A judge that could not answer gets a new cover too, which is
 * the cheapest rebuild that asks it again.
 */
export function decide(result, { attempt = 1, maxAttempts = 2 } = {}) {
  if (result?.pass) return 'publish';
  if (attempt >= maxAttempts) return 'drop';
  if (result?.stage === 'A') return (result.gates || []).every((g) => g.fix === 'cover') ? 'cover' : 'recipe';
  if (result?.error) return 'cover';
  return result?.weakest === 'hook' ? 'cover' : 'recipe';
}

export const SUBSCORE_HE = { hook: 'שער', slide1: 'שקופית ראשונה', photos: 'תמונות', savings: 'חיסכון', variety: 'גיוון' };

/** One line for a log or a message: the score and its parts, or why there is none. */
export const scoreLine = (r) =>
  !r
    ? 'לא נוקד'
    : r.total == null
      ? `נפסל בשלב ${r.stage}: ${r.why}`
      : `${r.total}/100 (סף ${r.threshold}) · ${SUBSCORES.map((k) => `${SUBSCORE_HE[k]} ${r.sub[k]}`).join(' · ')}`;
