import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Every slide of every deck on one page.
//
// Reviewing slideshows one JPEG at a time does not work: the thing being judged
// is whether six slides read as a series, whether the type is the same size on
// all of them, whether two of them ended up with the same photograph. All of
// that is visible in a row and invisible one file at a time.
//
// The measurements go under each slide because "the text is in the wrong place"
// is much easier to act on when the numbers that put it there are printed
// beside it — a region that measured busy 0.4 chose badly for a reason, and the
// reason is fixable.

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * @param decks  [{ titleHe, style, size, note, slides: [{ file, index, nameHe, spot }] }]
 * @param out    directory the sheet is written into; slide paths are made
 *               relative to it so the file works when opened directly.
 */
export function writeContactSheet(decks, out, { title = 'deck lab' } = {}) {
  const card = (slide) => {
    const s = slide.spot;
    return `
    <figure>
      <img src="${esc(path.relative(out, slide.file).replace(/\\/g, '/'))}" alt="" loading="lazy">
      <figcaption>
        <b>${slide.index}</b> ${esc(slide.nameHe || '')}
        ${
          s
            ? `<span class="m">${esc(s.side)} · y ${s.y.toFixed(2)} · lum ${s.lum} · busy ${s.busy}` +
              `${s.assist > 0.05 ? ` · <i>assist ${s.assist.toFixed(2)}</i>` : ''}</span>`
            : '<span class="m">no photograph</span>'
        }
      </figcaption>
    </figure>`;
  };

  const html = `<!doctype html><html lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0e1112; color:#e9e4d9; font:14px/1.55 -apple-system, system-ui, sans-serif; margin:0; padding:26px 22px 60px; }
  h1 { font-size:21px; margin:0 0 4px; font-weight:650; letter-spacing:-0.2px; }
  .sub { color:#88918b; margin:0 0 4px; font-size:13px; }
  h2 { font-size:18px; margin:32px 0 4px; font-weight:600; direction:rtl; text-align:right; }
  .meta { color:#88918b; font-size:12px; margin:0 0 12px; direction:rtl; text-align:right; }
  .row { display:flex; gap:13px; overflow-x:auto; padding-bottom:12px; scrollbar-width:thin; }
  figure { margin:0; flex:0 0 auto; width:236px; }
  img { width:236px; aspect-ratio:9/16; object-fit:cover; display:block; border-radius:9px; background:#000; }
  figcaption { font-size:12px; padding-top:6px; color:#c4bfb4; direction:rtl; text-align:right; }
  .m { display:block; color:#79817b; font-size:11px; font-variant-numeric:tabular-nums; direction:ltr; text-align:left; }
  i { font-style:normal; color:#d6a05c; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="sub">${new Date().toISOString().slice(0, 16).replace('T', ' ')} · slide 1 is the cover · scroll each row sideways</p>
${decks
  .map(
    (d) => `<h2>${esc(d.titleHe)}</h2>
<p class="meta">${esc(d.style)} · ${esc(d.size || 'tiktok')} · ${d.slides.length} שקופיות${
      d.note ? ` · ${esc(d.note)}` : ''
    }</p>
<div class="row">${d.slides.map(card).join('')}</div>`
  )
  .join('\n')}
</body></html>`;

  const file = path.join(out, 'index.html');
  writeFileSync(file, html);
  return file;
}
