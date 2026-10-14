import { loadEnv } from '../src/env.js';
loadEnv();

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDeck } from '../src/brick/build.js';
import { renderBrickDeckSize } from '../src/render/brickDeck.js';
import { captionFor, instagramCaptionFor, dressing } from '../src/brick/caption.js';
import { closeBrowser } from '../src/render/index.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { roomFor } from './lib/rooms.js';
import { sampleDeals } from './fixtures/deals.js';
import { gates, modelScore, contactSheet, decide, scoreLine, SUBSCORES } from '../src/brick/score.js';
import { tiktokRoute, routeHe } from '../src/brick/candidate.js';
import { publishZernio } from '../src/publish/zernio.js';
import { brickConfig } from '../src/brick/config.js';

// The whole path, printed, publishing nothing.
//
//   npm run brick-once
//   npm run brick-once -- "harry-potter"
//   npm run brick-once -- "harry-potter" "100" "בונסאי"   one sheet, three decks
//   npm run brick-once -- --fixture       a generated feed, no network
//   npm run brick-once -- --rooms         stand-in photographs, no image calls
//   npm run brick-once -- --no-images     no photographs at all
//   npm run brick-once -- --no-score      skip the scorer's model call
//
// Every deck is scored as auto mode would score it, and the request TikTok
// would get through Zernio is printed, sent to a fake client that records it
// and answers like Zernio. Nothing reaches Zernio or TikTok, with or without
// a ZERNIO_API_KEY.
//
// Writes to out/brick/ instead of to Telegram, with a contact sheet. Touches
// neither the store nor any destination, so it is safe to run on the VPS.
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

async function main() {
  mkdirSync(OUT, { recursive: true });

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
  console.log(`  ${path.join(OUT, 'index.html')}\n`);
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

  if (deck.dropped.length) {
    console.log('\n  dropped');
    for (const d of deck.dropped) console.log(`    ${d.id} — ${d.why}`);
  }
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
  cand.tiktokRoute = tiktokRoute(deck.slides);
  cand.tiktokDraft = cand.tiktokRoute.path === 'draft';
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

  let result;
  if (noScore) {
    console.log('    stage B: skipped (--no-score)');
    result = { stage: 'A', pass: false, gates: a.failures, total: null };
  } else {
    const sheet = await contactSheet(cand, { outDir: OUT });
    console.log(`    contact sheet: ${sheet.file}`);
    const b = await modelScore(cand, { sheet: sheet.base64 });
    const label = a.ok ? 'stage B' : 'stage B (shown for the dry run only; production would not reach it)';
    if (!b.ok) {
      console.log(`    ${label}: FAILED CLOSED — ${b.error}`);
    } else {
      console.log(`    ${label}: ${b.total}/100 from ${b.model} · threshold ${brickConfig().score.threshold}`);
      console.log(`      ${SUBSCORES.map((k) => `${k} ${b.sub[k]}`).join(' · ')} · weakest: ${b.weakest}`);
      if (b.notes) console.log(`      judge: ${b.notes}`);
    }
    result = a.ok
      ? b.ok
        ? { stage: 'B', pass: b.total >= brickConfig().score.threshold, total: b.total, sub: b.sub, weakest: b.weakest, threshold: brickConfig().score.threshold, gates: [] }
        : { stage: 'B', pass: false, total: null, error: b.error, gates: [], threshold: brickConfig().score.threshold }
      : { stage: 'A', pass: false, gates: a.failures, total: null, threshold: brickConfig().score.threshold, why: a.failures.map((f) => f.why).join('; ') };
  }
  const next = decide(result, { attempt: 1 });
  console.log(
    `    decision: ${{ publish: 'PUBLISH', cover: 'rebuild once with a new cover', recipe: 'rebuild once with different sets', drop: 'DROP' }[next]}` +
      (result.total == null ? '' : ` (${scoreLine(result)})`)
  );
  console.log(`    tiktok route: ${cand.tiktokRoute.path} — ${routeHe(cand.tiktokRoute)}`);
}

/** What Zernio would be sent, through a fake client that records it. */
async function zernioOne(cand) {
  console.log('\n  Zernio (mock client — nothing is sent anywhere)');
  // The fake answers creator-info as an account allowing every level, and the
  // post as published. The checks in publishZernio still run against it.
  const sent = [];
  const mock = {
    creatorInfo: async () => ({
      creator: { nickname: '(mock account)', canPostMore: true },
      privacyLevels: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].map((value) => ({ value })),
      postingLimits: { interactionSettings: { allow_comment: { enabled: true } } },
      commercialContentTypes: [{ value: 'none' }],
    }),
    createPost: async (body, { idempotencyKey }) => {
      sent.push({ body, idempotencyKey });
      return { status: 201, json: { post: { _id: 'mock-post-1', status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: null }] } } };
    },
  };
  // publishZernio refuses without these. Placeholders are enough for a client
  // that never leaves this process.
  process.env.ZERNIO_API_KEY ||= 'mock-key';
  process.env.ZERNIO_TIKTOK_ACCOUNT_ID ||= 'mock-account';
  try {
    const out = await publishZernio(cand, { client: mock });
    const { body, idempotencyKey } = sent[0];
    console.log(`    POST ${process.env.ZERNIO_API_BASE || 'https://zernio.com/api/v1'}/posts`);
    console.log('    Authorization: Bearer <ZERNIO_API_KEY>');
    console.log(`    Idempotency-Key: ${idempotencyKey}`);
    console.log(indent(JSON.stringify(body, null, 2)));
    console.log(`    -> mock answered: zernio ${out.postId} · ${out.status}${out.draft ? ' · inbox draft' : ''}`);
    for (const n of out.notes || []) console.log(`    note: ${n}`);
  } catch (e) {
    console.log(`    publishZernio refused before sending: ${e.message}`);
  }
}

main().catch(async (e) => {
  console.error(`\n  failed: ${e.message}\n`);
  if (e.feedDropped?.length) {
    for (const d of e.feedDropped.slice(0, 10)) console.error(`    ${d.id} — ${d.why}`);
  }
  await closeBrowser();
  process.exitCode = 1;
});
