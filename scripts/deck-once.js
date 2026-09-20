import { loadEnv } from '../src/env.js';
loadEnv();

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRequest } from '../src/deck/request.js';
import { titleForRequest } from '../src/deck/ideas.js';
import { buildWithFallback } from '../src/deck/attempt.js';
import { renderDeckSize } from '../src/render/deck.js';
import { closeBrowser } from '../src/render/index.js';
import { writeContactSheet } from './lib/contact-sheet.js';
import { snapshot as usageSnapshot } from '../src/usage.js';

// One real deck, end to end, written to disk instead of to Telegram.
//
//   npm run deck-once -- "Bernese Alps" mountain
//   npm run deck-once -- "japan autumn"
//   npm run deck-once -- "Dolomites trail" "Prague attraction"
//
// Everything the bot does except staging and publishing: the request is
// interpreted, the places are found, the facts are read, the photographs are
// curated, the slides are rendered. This is what to run to find out whether a
// change to a prompt actually improved a deck, because the only honest answer
// to that is a rendered deck.
//
// Nothing is written to the store, so a deck built here can still be staged
// later by the bot. Nothing is published.

const OUT = path.join(process.cwd(), 'out', 'decks');

async function one(request, nth = 0) {
  console.log(`\n── ${request} ${'─'.repeat(Math.max(0, 56 - request.length))}`);

  const req = await resolveRequest(request);
  console.log(`   ${req.via}: ${req.where} / ${req.kind} · want ${req.want}`);
  if (req.alternatives.length) {
    console.log(`   fallbacks: ${req.alternatives.map((a) => `${a.where}/${a.kind}`).join(', ')}`);
  }

  const cover = await titleForRequest({ where: req.where, kind: req.kind, count: req.want }).catch(() => ({
    titleHe: req.titleHe,
  }));
  // Steps the cover rotation on per deck in the batch. Without it every deck in
  // one run shares publishedCount() and comes back in the same shape and voice,
  // which is the repetition the rotation exists to prevent.
  const idea = { ...cover, where: req.where, kind: req.kind, want: req.want, whyNow: 'deck-once', nth };

  // The same ladder the bot climbs, for the same reason: this script exists to
  // answer "what would have been posted", and it cannot answer that if it gives
  // up where the bot would have tried the next region.
  const deck = await buildWithFallback(idea, req.alternatives, {
    onAttempt: (attempt, i, why) => {
      if (i > 0) console.log(`   ↩️ ${why} — trying ${attempt.where} / ${attempt.kind}`);
    },
  });
  if (!deck?.slides?.length) return null;
  deck.id = `once-${String(deck.where).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${deck.category}`;

  console.log(`   "${deck.titleHe}"  [${deck.idea?.emphasisHe || 'no emphasis'}]`);
  console.log(`   style: ${deck.style} · ${deck.slides.length}/${req.want} slides · via ${deck.via || 'map'}`);
  // The counts separate "this region is thin" from "the search is broken",
  // which look identical from a short deck.
  if (deck.counts) {
    console.log(
      `   pool: ${deck.counts.found} found · ${deck.counts.withAuthority} with an authority · ${deck.counts.built} built`
    );
  }
  for (const s of deck.slides) {
    const fields = (s.fields || []).map((f) => `${f.labelHe}: ${f.value}`).join(' · ');
    console.log(
      `     ${s.nameHe}${s.countryHe ? `, ${s.countryHe}` : ''} ${s.flag || ''}${fields ? `  [${fields}]` : ''}`
    );
  }
  for (const d of (deck.dropped || []).slice(0, 6)) {
    console.log(`     ✗ ${d.place}: ${String(d.why).slice(0, 80)}`);
  }

  const slides = await renderDeckSize(deck, { size: 'tiktok', outDir: OUT });
  for (const s of slides) {
    if (!s.spot) continue;
    console.log(
      `     ${String(s.index).padStart(2)} ${s.spot.side.padEnd(6)} y=${s.spot.y.toFixed(2)} ` +
        `lum=${String(s.spot.lum).padEnd(5)} busy=${String(s.spot.busy).padEnd(5)} ${s.spot.color}` +
        `${s.spot.assist > 0.05 ? ` assist=${s.spot.assist.toFixed(2)}` : ''}`
    );
  }
  return {
    titleHe: deck.titleHe,
    style: deck.style,
    size: 'tiktok',
    note: `${deck.where} · ${deck.category}${deck.short ? ` · ביקשנו ${req.want}` : ''}`,
    slides,
    deck,
  };
}

async function main() {
  const requests = process.argv.slice(2).filter(Boolean);
  if (!requests.length) {
    console.error('usage: npm run deck-once -- "<request>" ["<request>" ...]');
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const rendered = [];

  for (const [i, request] of requests.entries()) {
    try {
      const got = await one(request, i);
      if (got) rendered.push(got);
      else console.log('   (nothing buildable)');
    } catch (e) {
      console.error(`   FAILED: ${e.message}`);
    }
  }

  if (rendered.length) {
    const sheet = writeContactSheet(rendered, OUT, { title: 'tiyul+ decks' });
    // The deck objects alongside the pictures, so a slide that looks wrong can
    // be traced back to the place, the query and the source it came from
    // without rebuilding it.
    writeFileSync(
      path.join(OUT, 'decks.json'),
      JSON.stringify(
        rendered.map((r) => ({
          titleHe: r.titleHe,
          style: r.style,
          where: r.deck.where,
          kind: r.deck.category,
          slides: r.deck.slides.map((s) => ({
            nameHe: s.nameHe,
            nameEn: s.nameEn,
            countryHe: s.countryHe,
            fields: s.fields,
            qid: s.qid,
            photo: s.image ? { credit: s.image.credit, query: s.image.viaQuery, why: s.image.why } : null,
          })),
          dropped: r.deck.dropped,
        })),
        null,
        2
      )
    );
    console.log(`\nContact sheet: ${sheet}`);
  }

  console.log(`Model spend: ${JSON.stringify(usageSnapshot())}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
