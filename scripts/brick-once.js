import { loadEnv } from '../src/env.js';
loadEnv();

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDeck } from '../src/brick/build.js';
import { renderBrickDeckSize } from '../src/render/brickDeck.js';
import { renderBrickSlideHtml } from '../src/render/brickSlide.js';
import { captionFor, instagramCaptionFor, dressing } from '../src/brick/caption.js';
import { closeBrowser } from '../src/render/index.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { roomFor } from './lib/rooms.js';
import { sampleDeals } from './fixtures/deals.js';
import { gates, modelScore, contactSheet, decide, scoreLine, SUBSCORES } from '../src/brick/score.js';
import { publishZernioTikTok, uploadMedia, zernioConfigured } from '../src/publish/zernio.js';
import { privacyLevel } from '../src/publish/tiktokRoute.js';
import { brickConfig } from '../src/brick/config.js';

// The whole path, printed.
//
//   npm run brick-once
//   npm run brick-once -- "harry-potter"
//   npm run brick-once -- "harry-potter" "100" "בונסאי"   one sheet, three decks
//   npm run brick-once -- --fixture       a generated feed, no network
//   npm run brick-once -- --rooms         stand-in photographs, no image calls
//   npm run brick-once -- --no-images     no photographs at all
//   npm run brick-once -- --no-score      skip the scorer's model calls
//   npm run brick-once -- --zernio        A REAL TIKTOK DRAFT: see below
//
// Every deck is scored as auto mode would score it, and the request TikTok
// would get through Zernio is printed in full, the API key redacted.
//
// Without --zernio, that request goes to a fake client that records it and
// answers like Zernio, and nothing reaches Zernio or TikTok.
//
// WITH --zernio IT IS REAL. The slides are uploaded to Zernio's own storage
// (a laptop has no public host for them), and the deck is posted through the
// real API as an INBOX DRAFT: `tiktokSettings.draft = true` is forced for this
// run, whatever the config says, so it lands in the TikTok app to be checked
// and nothing reaches the profile. It needs ZERNIO_API_KEY and refuses to run
// without it. Each media URL is then fetched from here and its status printed.
//
// The Zernio key is account-wide and the account holds more than one TikTok
// account, so before anything is built the pinned ZERNIO_TIKTOK_ACCOUNT_ID is
// looked up with GET /v1/accounts?platform=tiktok, and the run stops unless its
// username is ZERNIO_TIKTOK_USERNAME (brickdealil when that is unset).
//
// Writes to out/brick/ instead of to Telegram, with a contact sheet.
//
// Every expensive step degrades rather than failing, and this script is where
// that gets checked: with no BRICKSET_API_KEY every slide loses its comparison
// and keeps its price, with no ANTHROPIC_API_KEY the cover falls back to the
// configured pool, and with no IMAGE_GEN_API_KEY the photographs fall back to
// the catalogue images with their provenance told truthfully. A deck still
// comes out of all three, which is the property worth having.

const OUT = path.join(process.cwd(), 'out', 'brick');

const argv = process.argv.slice(2);
const useRooms = argv.includes('--rooms');
const noImages = argv.includes('--no-images') || useRooms;
const useFixture = argv.includes('--fixture');
const noScore = argv.includes('--no-score');
const realZernio = argv.includes('--zernio');

// Several requests build several decks onto one sheet. A deck is only really
// judgeable next to another one — whether five slides read as a series, whether
// two posts in a day would look like the same post — and that is invisible one
// build at a time.
const requests = argv.filter((a) => !a.startsWith('--'));

const money = (n) => `${Math.round(n).toLocaleString('en-US')}₪`;
const indent = (text) =>
  String(text)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

/* -------------------------------------------------------------------------- */
/* What the run spent                                                         */
/* -------------------------------------------------------------------------- */

// Every model and image call goes through fetch: homeShot's generation and its
// two vision checks call it directly, and the Anthropic SDK uses it underneath.
// So the bill is counted here, at the one door they all use, without touching
// any of them.
const spend = { anthropic: {}, gemini: { calls: 0, images: 0, inputTokens: 0, outputTokens: 0 }, zernio: 0, other: 0 };

function countSpend() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    const res = await real(input, init);
    try {
      if (url.startsWith('https://api.anthropic.com/')) {
        const json = await res.clone().json();
        const model = json?.model || 'unknown';
        const m = (spend.anthropic[model] ??= { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
        m.calls++;
        m.input += json?.usage?.input_tokens || 0;
        m.output += json?.usage?.output_tokens || 0;
        m.cacheWrite += json?.usage?.cache_creation_input_tokens || 0;
        m.cacheRead += json?.usage?.cache_read_input_tokens || 0;
      } else if (url.includes('generativelanguage.googleapis.com')) {
        const json = await res.clone().json();
        spend.gemini.calls++;
        const parts = json?.candidates?.[0]?.content?.parts || [];
        if (parts.some((p) => p.inlineData || p.inline_data)) spend.gemini.images++;
        spend.gemini.inputTokens += json?.usageMetadata?.promptTokenCount || 0;
        spend.gemini.outputTokens += json?.usageMetadata?.candidatesTokenCount || 0;
      } else if (url.includes('zernio.com')) {
        spend.zernio++;
      } else {
        spend.other++;
      }
    } catch {
      /* a body that is not JSON is not a model call */
    }
    return res;
  };
}

// $ per million tokens, from the published rates on 2026-10-15. Stated, so the
// estimate can be checked rather than trusted.
const RATES = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};
const GEMINI_IMAGE = { input: 0.3, output: 30 }; // gemini-2.5-flash-image, $ per million tokens

function spendReport() {
  console.log('\n  spend');
  let total = 0;
  for (const [model, m] of Object.entries(spend.anthropic)) {
    const key = Object.keys(RATES).find((k) => model.startsWith(k));
    const [inRate, outRate] = RATES[key] || [null, null];
    const cost = inRate == null ? null : (m.input * inRate + m.cacheWrite * inRate * 1.25 + m.cacheRead * inRate * 0.1 + m.output * outRate) / 1e6;
    if (cost != null) total += cost;
    console.log(
      `    ${model}: ${m.calls} call(s) · ${m.input} in + ${m.cacheWrite} cache-write + ${m.cacheRead} cache-read · ${m.output} out` +
        (cost == null ? ' · rate unknown' : ` · ~$${cost.toFixed(4)}`)
    );
  }
  const g = spend.gemini;
  const gCost = (g.inputTokens * GEMINI_IMAGE.input + g.outputTokens * GEMINI_IMAGE.output) / 1e6;
  total += gCost;
  console.log(`    image generation: ${g.calls} call(s), ${g.images} image(s) · ${g.inputTokens} in · ${g.outputTokens} out · ~$${gCost.toFixed(4)}`);
  console.log(`    zernio: ${spend.zernio} request(s) · other: ${spend.other}`);
  console.log(`    total, estimated: ~$${total.toFixed(4)}`);
}

/* -------------------------------------------------------------------------- */

async function main() {
  countSpend();
  mkdirSync(OUT, { recursive: true });

  if (realZernio && !zernioConfigured()) {
    console.error('\n  --zernio posts a real draft and needs ZERNIO_API_KEY in .env; nothing was built.\n');
    process.exitCode = 1;
    return;
  }
  if (realZernio && !(await accountCheck())) {
    process.exitCode = 1;
    return;
  }

  // The fixture is written to disk rather than injected, so it goes through
  // exactly the same loader, the same validation and the same freshness rule as
  // the live feed. A fixture that took a shortcut past those would be testing a
  // path that does not exist in production.
  if (useFixture) {
    const file = path.join(OUT, 'fixture-deals.json');
    writeFileSync(file, JSON.stringify(sampleDeals(), null, 2));
    process.env.BRICKDEAL_FEED_FILE = file;
    delete process.env.BRICKDEAL_FEED_URL;
    console.log(`  feed: generated fixture at ${file}`);
  }

  const sheets = [];
  for (const [n, request] of (requests.length ? requests : [null]).entries()) {
    sheets.push(await buildOne(request, n));
  }

  writeContactSheet(sheets, OUT, { title: `brick-once — ${sheets.map((d) => d.titleHe).join(' · ')}` });
  await closeBrowser();

  const total = sheets.reduce((t, d) => t + d.slides.length, 0);
  console.log(`\n  ${total} slides in ${sheets.length} deck(s)`);
  console.log(`  ${path.join(OUT, 'index.html')}`);
  spendReport();
  console.log('');
}

async function buildOne(request, n) {
  console.log(`\n  building${request ? ` "${request}"` : ''}\n`);
  const deck = await buildDeck(request, {
    wantImages: !noImages,
    onProgress: (s) => console.log(`    ${s}`),
  });
  deck.id = `once-${n}`;

  // Stand-in photographs, so a whole deck can be looked at without paying for
  // real ones. Assigned HERE rather than inside the build, deliberately: the
  // builder must never be able to put a picture on a slide that nothing
  // generated for that product, because a slide whose photograph is not of the
  // set it names is the one failure this pipeline most has to avoid. A dev
  // script faking it for a contact sheet is a different thing from the builder
  // learning how.
  if (useRooms) {
    deck.slides = deck.slides.map((s, i) => ({
      ...s,
      image: { src: roomFor(n * 3 + i).src, provenance: 'stock', note: 'stand-in, not a real photograph' },
    }));
  }

  console.log(`\n  ${deck.titleHe}`);
  console.log(
    `  recipe: ${deck.recipe}` +
      // Two ceilings, two units. `ceiling` is shekels and `agorotCeiling` is
      // agorot a piece; printing either with the other's sign is the bug the
      // second field exists to make impossible.
      (deck.ceiling ? ` (under ${deck.ceiling}₪)` : '') +
      (deck.agorotCeiling ? ` (under ${deck.agorotCeiling} agorot a piece)` : '') +
      (deck.theme ? ` · ${deck.theme}` : '')
  );
  console.log(
    `  cover:  "${deck.hookHe}"${deck.emphasisHe ? `   [shout: ${deck.emphasisHe}]` : ''}   [${deck.hookFrom}]`
  );
  coverCheck(deck, n);

  const rateNote = Object.entries(deck.rates)
    .map(([c, r]) => `${c}/ILS ${r.rate} on ${r.date}`)
    .join(', ');
  console.log(`  rates:  ${rateNote || 'none needed'}`);

  console.log('\n  slides');
  for (const s of deck.slides) {
    const c = s.deal.comparison;
    // A single-set post's later slides carry a fact rather than a price block,
    // so printing the price under all of them reads as five identical slides
    // when they are nothing of the sort. What a slide SAYS is what to print.
    const carriesPrices = s.lines.length > 1 || Boolean(s.lines[0]?.value);
    // Same rule again for a per-piece deck, which HAS a comparison on most of
    // its sets and does not print one. Falling through to the branch below
    // would report a saving the slide never shows, on the one deck built to
    // make a different argument.
    const claim = !carriesPrices
      ? s.lines.map((l) => l.label).join(' · ')
      : deck.recipe === 'perPiece'
        ? s.lines.map((l) => `${l.label}: ${l.value}`).join(' · ')
        : c?.ok
          ? `${money(c.paid)} vs ${money(c.listIls)} (${c.source.region} ${c.source.amount} ${c.source.currency}) saves ${money(c.saving)}`
          : `${money(s.deal.price)} · no comparison — ${c?.why || 'unknown'}`;
    console.log(`    ${s.rank ? `#${s.rank} ` : ''}${s.emoji} ${s.nameHe}`);
    console.log(`       ${claim}`);
    console.log(`       photo: ${s.image?.provenance || 'none'}${s.image?.note ? ` (${s.image.note})` : ''}`);
  }

  console.log('\n  dropped');
  if (deck.dropped.length) for (const d of deck.dropped) console.log(`    ${d.id} — ${d.why}`);
  else console.log('    none');
  if (deck.feedDropped?.length) {
    console.log(`\n  feed: ${deck.feedDropped.length} record(s) were not usable`);
    for (const d of deck.feedDropped.slice(0, 6)) console.log(`    ${d.id} — ${d.why}`);
  }

  // One hook AND one tag block, drawn once and handed to both, exactly as the
  // publisher does it. Printing the two side by side is what caught them
  // diverging in the first place, so they stay side by side.
  const dress = dressing(deck);
  console.log('\n  TikTok description\n');
  console.log(indent(captionFor(deck, dress)));
  console.log('\n  Instagram caption\n');
  console.log(indent(instagramCaptionFor(deck, dress)));

  console.log('\n  rendering');
  const slides = await renderBrickDeckSize(deck, { size: 'tiktok', outDir: OUT });
  console.log(`    cover: ${slides[0]?.file}`);

  // The deck as auto mode would hand it to the scorer and the publisher.
  const cand = {
    kind: 'deck',
    id: deck.id,
    headline: deck.titleHe,
    deck: { ...deck, tiktok: slides, preview: slides },
    tiktokCaption: captionFor(deck, dress),
    instagramCaption: instagramCaptionFor(deck, dress),
    publishTargets: ['tiktok'],
  };
  await scoreOne(cand);
  await zernioOne(cand);

  return {
    titleHe: deck.titleHe,
    style: deck.recipe,
    size: 'tiktok',
    note: `${deck.subject} · "${deck.hookHe}"`,
    slides: slides.map((s) => ({ ...s, spot: null })),
  };
}

/**
 * Whose TikTok the pinned account id is, asked of Zernio before anything is
 * built or sent. True only when it is the expected username.
 */
async function accountCheck() {
  const id = String(process.env.ZERNIO_TIKTOK_ACCOUNT_ID || '').trim();
  const want = String(process.env.ZERNIO_TIKTOK_USERNAME || 'brickdealil').replace(/^@/, '').toLowerCase();
  const base = (process.env.ZERNIO_BASE || 'https://zernio.com/api/v1').replace(/\/$/, '');
  console.log(`\n  account check: GET ${base}/accounts?platform=tiktok`);
  if (!id) {
    console.error('    STOP: ZERNIO_TIKTOK_ACCOUNT_ID is not set, and the key reaches more than one TikTok account\n');
    return false;
  }
  let json;
  try {
    const res = await fetch(`${base}/accounts?platform=tiktok`, {
      headers: { authorization: `Bearer ${String(process.env.ZERNIO_API_KEY).trim()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${json?.error || ''}`);
  } catch (e) {
    console.error(`    STOP: the account list could not be read: ${e.message}\n`);
    return false;
  }
  for (const a of json.accounts || []) {
    console.log(`    ${a._id === id ? '>>' : '  '} ${a._id} ${a.platform} @${a.username || a.displayName || '?'}${a.isActive === false ? ' (inactive)' : ''}`);
  }
  const acc = (json.accounts || []).find((a) => a._id === id);
  const name = String(acc?.username || '').toLowerCase();
  if (!acc || acc.platform !== 'tiktok' || name !== want) {
    console.error(`    STOP: ${id} is ${acc ? `@${acc.username || '?'} on ${acc.platform}` : 'not in this Zernio account'}, not @${want}; nothing was built or sent\n`);
    return false;
  }
  console.log(`    ${id} is @${acc.username}: carrying on`);
  return true;
}

/**
 * The cover line, checked for direction: written to a UTF-8 file, its first
 * code points printed, and held against the HTML the cover is rendered from.
 *
 * A terminal can show Hebrew backwards; the string cannot be backwards and
 * still read right on the slide, because the slide's own bidi algorithm would
 * reverse it a second time. The code points are the only thing that settles
 * which it is.
 */
function coverCheck(deck, n) {
  const hook = String(deck.hookHe || '');
  const file = path.join(OUT, n ? `cover-${n}.txt` : 'cover.txt');
  writeFileSync(file, `${hook}\n`, 'utf8');
  const points = [...hook].slice(0, 5).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  const html = renderBrickSlideHtml({ hookHe: deck.hookHe, emphasisHe: deck.emphasisHe, image: null }, { cover: true });
  const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  console.log(`  cover.txt: ${file}`);
  console.log(`    first code points: ${points.join(' ')}  ("${[...hook].slice(0, 5).join('')}")`);
  console.log(`    the slide's HTML carries it in the same order: ${text.includes(hook.replace(/\s+/g, ' ')) ? 'yes' : 'NO'}`);
}

/**
 * The scorer, as auto mode runs it, with the reasons printed.
 *
 * Stage B normally runs only for a deck that passed stage A. Here it runs
 * either way, because this is where the judge's answer gets looked at; when
 * stage A failed, the line says production would have stopped there.
 */
async function scoreOne(cand) {
  console.log('\n  score');
  const a = gates(cand);
  if (a.ok) console.log('    stage A: every gate passed');
  else {
    console.log(`    stage A: ${a.failures.length} gate(s) failed — auto mode stops here and rebuilds or drops`);
    for (const f of a.failures) console.log(`      ✗ ${f.gate}: ${f.why}   [fix: ${f.fix}]`);
  }

  const { threshold, model, compareModel } = brickConfig().score;
  let result;
  if (noScore) {
    console.log('    stage B: skipped (--no-score)');
    result = { stage: 'A', pass: a.ok, gates: a.failures, total: null };
  } else {
    const sheet = await contactSheet(cand, { outDir: OUT });
    console.log(`    contact sheet: ${sheet.file}`);
    const label = a.ok ? 'stage B' : 'stage B (shown for the dry run only; production would not reach it)';
    const show = (b, role) => {
      if (!b.ok) return console.log(`    ${label}, ${role} ${b.model}: FAILED CLOSED — ${b.error}`);
      console.log(`    ${label}, ${role} ${b.model}: ${b.total}/100 · threshold ${threshold}`);
      console.log(`      ${SUBSCORES.map((k) => `${k} ${b.sub[k]}`).join(' · ')} · weakest: ${b.weakest}`);
      if (b.notes) console.log(`      judge: ${b.notes}`);
    };
    const [b, c] = await Promise.all([
      modelScore(cand, { sheet: sheet.base64, model }),
      compareModel ? modelScore(cand, { sheet: sheet.base64, model: compareModel }) : null,
    ]);
    show(b, 'judge');
    if (c) show(c, 'compare (decides nothing)');
    result = a.ok
      ? b.ok
        ? { stage: 'B', pass: b.total >= threshold, total: b.total, sub: b.sub, weakest: b.weakest, threshold, gates: [] }
        : { stage: 'B', pass: false, total: null, error: b.error, gates: [], threshold }
      : { stage: 'A', pass: false, gates: a.failures, total: null, threshold, why: a.failures.map((f) => f.why).join('; ') };
  }
  const next = decide(result, { attempt: 1 });
  console.log(
    `    decision: ${{ publish: 'PUBLISH', cover: 'rebuild once with a new cover', recipe: 'rebuild once with different sets', drop: 'DROP' }[next]}` +
      (result.total == null ? '' : ` (${scoreLine(result)})`)
  );
}

/**
 * What Zernio is sent, in full, and what it answered.
 *
 * Mock by default: a fake fetch that answers the account lookup and the post
 * like Zernio. With --zernio, the real API, the slides uploaded to Zernio's
 * storage first, and the post forced to an inbox draft.
 */
async function zernioOne(cand) {
  const cfg = brickConfig().tiktok;
  const privacy = privacyLevel(cfg.privacy);
  console.log(`\n  Zernio (${realZernio ? 'REAL — an inbox draft, forced for this run' : 'mock client — nothing is sent anywhere'})`);

  let target = cand;
  if (realZernio) {
    // A laptop has no public host for the slides, so they go to Zernio's own
    // storage first and the post uses those addresses.
    console.log('    uploading the slides to Zernio storage');
    const urls = [];
    for (const s of cand.deck.tiktok) urls.push(await uploadMedia(s.file));
    target = { ...cand, deck: { ...cand.deck, tiktok: cand.deck.tiktok.map((s, i) => ({ ...s, url: urls[i] })) } };
  }

  const sent = [];
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST' && u.endsWith('/posts')) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: async () => ({ post: { _id: 'mock-post-1', status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: null }] } }) };
    }
    if (u.includes('/accounts?')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ _id: 'mock-account', platform: 'tiktok', isActive: true }] }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not mocked' }) };
  };
  const env = realZernio ? process.env : { ...process.env, ZERNIO_API_KEY: process.env.ZERNIO_API_KEY || 'mock-key' };

  let out;
  try {
    out = await publishZernioTikTok(target, {
      privacy,
      autoAddMusic: cfg.autoAddMusic,
      commercialContentType: cfg.commercialContentType,
      draft: realZernio,
      env,
      ...(realZernio ? { pollMs: 5_000, timeoutMs: 180_000 } : { fetchImpl: mockFetch, pollMs: 1, timeoutMs: 10 }),
    });
  } catch (e) {
    console.log(`    publishZernioTikTok refused or failed: ${e.message}${e.code ? ` [${e.code}]` : ''}${e.status ? ` HTTP ${e.status}` : ''}`);
    return;
  }

  console.log(`    POST ${(process.env.ZERNIO_BASE || 'https://zernio.com/api/v1').replace(/\/$/, '')}/posts`);
  console.log('    Authorization: Bearer <redacted>');
  console.log(`    Idempotency-Key: ${out.idempotencyKey}`);
  console.log(indent(JSON.stringify(out.body, null, 2)));
  console.log('    response:');
  console.log(indent(JSON.stringify(out.response, null, 2)));
  console.log(`    -> zernio post ${out.zernioId} · ${out.status}${out.draft ? ' · inbox draft' : ''}${out.url ? ` · ${out.url}` : ''}`);
  for (const note of out.notes || []) console.log(`    note: ${note}`);

  // Every image the post points at, fetched from here: a laptop is outside
  // the server, which is the question.
  console.log('    media URLs:');
  for (const item of out.body.mediaItems) {
    let status;
    try {
      const res = await fetch(item.url, { method: 'GET', signal: AbortSignal.timeout(20_000) });
      status = `${res.status} ${res.headers.get('content-type') || ''} ${res.headers.get('content-length') || '?'} bytes`;
    } catch (e) {
      status = `unreachable: ${e.message}`;
    }
    console.log(`      ${status} · ${item.url}`);
  }
}

main().catch(async (e) => {
  console.error(`\n  failed: ${e.message}\n`);
  if (e.feedDropped?.length) {
    for (const d of e.feedDropped.slice(0, 10)) console.error(`    ${d.id} — ${d.why}`);
  }
  await closeBrowser();
  spendReport();
  process.exitCode = 1;
});
