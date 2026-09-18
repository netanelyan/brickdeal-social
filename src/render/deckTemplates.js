import { palette, heeboDataUri, escapeHtml, siteMark } from './theme.js';

// Slideshow slides. A different animal from the news card, on purpose.
//
// The card is a designed object: a typographic system, generous margins, an
// accent per pillar. It reads as a publication, which is exactly right in an
// Instagram feed and exactly wrong on TikTok, where the same restraint reads as
// an advertisement and gets scrolled past.
//
// So a slide is a photograph with words on it. Full bleed, no frame, no card,
// heavy type set straight over the image with a dark scrim behind it for
// legibility. That is the native grammar of the format, and the reference posts
// that work all share it.
//
// Two sizes from one template. 1080x1920 for TikTok; 1080x1350 for the
// Instagram carousel, because Instagram crops anything taller in the feed and
// the crop lands on the text. Sizes differ in more than the box: type scales
// with the height, and the safe area at the bottom is deeper on the TikTok
// version, where the app's own caption and buttons sit over the image.

export const SIZES = {
  tiktok: { w: 1080, h: 1920, bottomSafe: 420 },
  instagram: { w: 1080, h: 1350, bottomSafe: 120 },
};

const css = ({ w, h, bottomSafe }) => `
@font-face {
  font-family: 'Heebo';
  src: url('${heeboDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
body {
  direction: rtl;
  text-align: center;
  font-family: 'Heebo', sans-serif;
  -webkit-font-smoothing: antialiased;
  background: ${palette.ink};
  color: #FFF8E6;
  position: relative;
}
.photo, .scrim, .content { position: absolute; inset: 0; }
.photo { object-fit: cover; width: ${w}px; height: ${h}px; }

/* Two gradients, not one. A single top-to-bottom wash either leaves the middle
   of the image muddy or leaves the text at the top unreadable; darkening both
   ends and leaving the centre alone keeps the photograph looking like a
   photograph while the type stays legible over it. */
.scrim {
  background:
    linear-gradient(to bottom, rgba(6,14,13,0.72) 0%, rgba(6,14,13,0.10) 34%, rgba(6,14,13,0.12) 56%, rgba(6,14,13,0.86) 100%);
}

.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: ${Math.round(h * 0.06)}px ${Math.round(w * 0.075)}px ${bottomSafe}px;
  gap: ${Math.round(h * 0.018)}px;
}

/* The cover carries the whole promise of the deck, so it gets the biggest type
   on any slide and nothing else competes with it. */
.cover-title {
  font-size: ${Math.round(h * 0.072)}px;
  font-weight: 900;
  line-height: 1.12;
  letter-spacing: -0.5px;
  color: #FFE9A8;
  text-shadow: 0 4px 26px rgba(0,0,0,0.75), 0 1px 0 rgba(0,0,0,0.55);
}
.cover-angle {
  font-size: ${Math.round(h * 0.028)}px;
  font-weight: 600;
  line-height: 1.35;
  color: rgba(255,248,230,0.92);
  text-shadow: 0 2px 16px rgba(0,0,0,0.8);
  max-width: 82%;
  margin-top: ${Math.round(h * 0.012)}px;
}

.place {
  font-size: ${Math.round(h * 0.048)}px;
  font-weight: 900;
  line-height: 1.1;
  color: #FFE9A8;
  text-shadow: 0 4px 22px rgba(0,0,0,0.8), 0 1px 0 rgba(0,0,0,0.6);
  margin-bottom: ${Math.round(h * 0.012)}px;
}

.lines { display: flex; flex-direction: column; gap: ${Math.round(h * 0.0125)}px; align-items: center; }
.line {
  font-size: ${Math.round(h * 0.0295)}px;
  font-weight: 700;
  line-height: 1.25;
  color: #FFF8E6;
  text-shadow: 0 3px 18px rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  gap: 14px;
  /* The emoji is the only LTR run on the slide and it sits at the start of an
     RTL line; isolating it keeps bidi from dragging it into the middle of the
     Hebrew. */
  unicode-bidi: isolate;
}
.line .em { font-size: 1.05em; }
/* A line the drafting step made too long still renders, one step smaller,
   rather than wrapping into three lines of mush or being silently dropped —
   the fact was verified, and hiding a verified fact is the worse failure. */
.line.long { font-size: ${Math.round(h * 0.0245)}px; }

.counter {
  position: absolute;
  top: ${Math.round(h * 0.035)}px;
  left: ${Math.round(w * 0.06)}px;
  font-size: ${Math.round(h * 0.022)}px;
  font-weight: 800;
  color: rgba(255,248,230,0.92);
  background: rgba(6,14,13,0.45);
  border-radius: 999px;
  padding: 6px 16px;
  direction: ltr;
}

.foot {
  position: absolute;
  left: 0; right: 0;
  bottom: ${Math.round(bottomSafe * 0.42)}px;
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: ${Math.round(h * 0.019)}px;
  font-weight: 600;
  color: rgba(255,248,230,0.78);
  text-shadow: 0 2px 10px rgba(0,0,0,0.8);
}
.foot .dot { opacity: 0.5; }
.site { font-weight: 800; color: rgba(255,233,168,0.92); direction: ltr; }
.src { direction: ltr; }
`;

const photo = (image, size) =>
  image?.src
    ? `<img class="photo" src="${escapeHtml(image.src)}" alt="">`
    : `<div class="photo" style="background:linear-gradient(160deg, ${palette.inkSoft}, ${palette.ink})"></div>`;

/**
 * One slide.
 *
 * `index` is 1-based and `total` includes the cover, so the counter reads the
 * way the platform's own counter does.
 */
export function renderSlideHtml(slide, { index, total, size = 'tiktok', cover = false } = {}) {
  const s = SIZES[size] || SIZES.tiktok;

  const body = cover
    ? `<div class="cover-title">${escapeHtml(slide.titleHe)}</div>` +
      (slide.angleHe ? `<div class="cover-angle">${escapeHtml(slide.angleHe)}</div>` : '')
    : `<div class="place">${escapeHtml(slide.nameHe)}</div>` +
      `<div class="lines">${(slide.lines || [])
        .map(
          (l) =>
            `<div class="line${l.overlong ? ' long' : ''}"><span class="em">${escapeHtml(l.emoji)}</span><span>${escapeHtml(l.text)}</span></div>`
        )
        .join('')}</div>`;

  // The source host is printed on every fact-bearing slide. A screenshot
  // travels without its caption, so a slide that makes a claim has to carry
  // where the claim came from — the same rule the news card's footer follows.
  const foot = cover
    ? `<span class="site">${escapeHtml(siteMark())}</span>`
    : `<span class="src">${escapeHtml(slide.sourceHost || '')}</span><span class="dot">·</span><span class="site">${escapeHtml(siteMark())}</span>`;

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css(s)}</style></head><body>
${photo(slide.image, s)}
<div class="scrim"></div>
<div class="counter">${index}/${total}</div>
<div class="content">${body}</div>
<div class="foot">${foot}</div>
</body></html>`;
}
