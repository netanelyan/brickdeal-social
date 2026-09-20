import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeContactSheet } from './lib/contact-sheet.js';

// Rebuild the contact sheet from whatever slides are on disk.
//
//   npm run contact-sheet            # out/decks
//   npm run contact-sheet -- out/lab
//
// deck-once writes a sheet covering the decks IT built, which is right for a
// single run and wrong the moment a second run tops up a deck that failed the
// first time: the sheet then lists three decks and the folder holds seven. This
// reads the folder instead, so the sheet always describes what is actually
// there.
//
// Filenames carry everything needed to group them — deck-<id>-<size>-<nn>.jpg —
// which is the same property that makes TikTok publish the slides in order.

const dir = path.resolve(process.argv[2] || path.join('out', 'decks'));

const slides = readdirSync(dir)
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => {
    const m = f.match(/^deck-(.+)-(tiktok|instagram)-(\d+)\.jpg$/);
    return m ? { file: path.join(dir, f), deck: m[1], size: m[2], index: Number(m[3]) } : null;
  })
  .filter(Boolean);

if (!slides.length) {
  console.error(`No slides in ${dir}`);
  process.exitCode = 1;
} else {
  // decks.json, when a run left one, carries the titles and the style. Without
  // it the sheet still works — it just labels each row with the deck's id.
  const metaFile = path.join(dir, 'decks.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : [];
  const titleFor = (id) =>
    meta.find((d) => id.includes(String(d.where).replace(/[^a-z0-9]+/gi, '-').toLowerCase()))?.titleHe || id;
  const styleFor = (id) =>
    meta.find((d) => id.includes(String(d.where).replace(/[^a-z0-9]+/gi, '-').toLowerCase()))?.style || '';

  const groups = new Map();
  for (const s of slides) {
    const key = `${s.deck}|${s.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const decks = [...groups.entries()]
    .map(([key, list]) => {
      const [deck, size] = key.split('|');
      return {
        titleHe: titleFor(deck),
        style: styleFor(deck),
        size,
        note: deck,
        slides: list.sort((a, b) => a.index - b.index).map((s) => ({ ...s, nameHe: '', spot: null })),
      };
    })
    .sort((a, b) => a.note.localeCompare(b.note));

  const sheet = writeContactSheet(decks, dir, { title: `tiyul+ · ${decks.length} decks` });
  console.log(`${slides.length} slides in ${decks.length} decks`);
  console.log(`Contact sheet: ${sheet}`);
}
