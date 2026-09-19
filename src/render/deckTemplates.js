import { palette, heeboDataUri, tiktokSansDataUri, escapeHtml, siteMark } from './theme.js';
import { scoreEmoji } from '../deck/emoji.js';
import { emojiHtml } from './emojiArt.js';

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

// The two colours the whole slide is made of, taken off the reference posts:
// a pale butter cream with a bronze outline. Warmer than white, and it is the
// warmth that stops it reading as a caption burned in by software.
const CREAM = '#F7DC8E';
const BRONZE = 'rgba(92,58,16,0.95)';

const css = ({ w, h, bottomSafe }) => `
@font-face {
  font-family: 'Heebo';
  src: url('${heeboDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
/* TikTok Sans, the app's own typeface, released by TikTok under the OFL.
   It has no Hebrew coverage — Latin, Greek and Cyrillic only — so it cannot
   carry this channel on its own. Listed FIRST anyway: the browser takes each
   glyph from the first family that has it, so Latin names, prices and the
   score come out in the platform's own letterforms while every Hebrew glyph
   falls through to Heebo. That mixed run is what the app itself does with
   Hebrew text, which is the look we are after. */
@font-face {
  font-family: 'TikTok Sans';
  src: url('${tiktokSansDataUri(700)}') format('truetype');
  font-weight: 400 800;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'TikTok Sans';
  src: url('${tiktokSansDataUri(900)}') format('truetype');
  font-weight: 900;
  font-style: normal;
  font-display: block;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
body {
  direction: rtl;
  text-align: center;
  /* TikTok Sans first so Latin and digits take the platform's letterforms;
     Hebrew has no coverage there and falls through to Heebo per glyph. */
  font-family: 'TikTok Sans', 'Heebo', sans-serif;
  -webkit-font-smoothing: antialiased;
  background: ${palette.ink};
  color: #FFF8E6;
  position: relative;
}
.photo, .scrim, .content { position: absolute; inset: 0; }
.photo { object-fit: cover; width: ${w}px; height: ${h}px; }

/* Barely there. The photograph is the post; this only takes the edge off a
   blown-out sky so white type has something to sit against. */
.scrim {
  background:
    linear-gradient(to bottom, rgba(6,14,13,0.26) 0%, rgba(6,14,13,0.04) 28%, rgba(6,14,13,0.08) 64%, rgba(6,14,13,0.46) 100%);
}

/* The app's own text tool, not an imitation of one.

   Two earlier attempts were wrong in opposite directions. A blurred panel
   behind the whole block read as an advertisement. A heavy outline on every
   letter read as a badly edited image — which is exactly what a thick stroke
   looks like when it is applied by something that is not the TikTok editor.

   What the editor actually does is put each LINE on its own rounded, slightly
   translucent slab, sized to the words. That is the shape people recognise,
   and it is the reason it is legible over any photograph. box-decoration-break
   is what keeps a wrapped line from breaking into two ragged slabs. */
.plate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${Math.round(h * 0.004)}px;
  max-width: 94%;
}
.slab {
  display: inline;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  /* Cream fill, bronze outline, straight on the photograph — the treatment on
     the reference posts. Not a dark slab behind the words, and not the heavy
     black stroke tried before it: that one was thick enough to read as an
     external editor's doing. ~5px at this size is what the reference carries.
     paint-order keeps the stroke behind the fill, or it eats the letterforms
     from the inside. */
  color: ${CREAM};
  paint-order: stroke fill;
  -webkit-text-stroke: ${Math.round(h * 0.0028)}px ${BRONZE};
  text-shadow: 0 ${Math.round(h * 0.0025)}px ${Math.round(h * 0.008)}px rgba(0,0,0,0.5);
  line-height: 1.34;
}

/* The block sits in the middle of the frame, as one group.
   Not pinned high, not pinned low: the lines stay together and the group is
   centred between the top of the image and the app's own furniture at the
   bottom, so a two-line slide and a five-line slide both look deliberate
   rather than like the same layout with a gap in it. */
.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: ${Math.round(h * 0.1)}px ${Math.round(w * 0.065)}px ${bottomSafe}px;
  gap: ${Math.round(h * 0.016)}px;
}

/* The cover carries the whole promise of the deck, so it gets the biggest type
   on any slide and nothing else competes with it. */
.cover-title {
  font-size: ${Math.round(h * 0.062)}px;
  font-weight: 900;
  line-height: 1.34;
  letter-spacing: -0.5px;
}
/* Set at full size, a title of any length wraps to four lines and becomes the
   entire slide - the photograph stops existing and the promise stops reading as
   a promise. Two steps down by length keeps it to two or three lines. */
.cover-title.mid { font-size: ${Math.round(h * 0.06)}px; }
.cover-title.long { font-size: ${Math.round(h * 0.05)}px; }
/* The city, small and above the title. A cover that opens with "פראג" tells a
   scroller in one word whether this is for them, before they have read
   anything else. */
.eyebrow {
  font-size: ${Math.round(h * 0.026)}px;
  font-weight: 800;
  letter-spacing: 3px;
  margin-bottom: ${Math.round(h * 0.004)}px;
}
/* The format's own convention. A slideshow that does not say it is a slideshow
   gets read as a single image and swiped past. */
.swipe {
  position: absolute;
  left: 0; right: 0;
  bottom: ${Math.round(bottomSafe * 0.72)}px;
  font-size: ${Math.round(h * 0.024)}px;
  font-weight: 800;
  letter-spacing: 1px;
}
.cover-angle {
  font-size: ${Math.round(h * 0.028)}px;
  font-weight: 600;
  line-height: 1.35;
  text-shadow: 0 2px 16px rgba(0,0,0,0.8);
  max-width: 82%;
  margin-top: ${Math.round(h * 0.012)}px;
}

.place {
  font-size: ${Math.round(h * 0.042)}px;
  font-weight: 900;
  line-height: 1.32;
}

/* Ours, and it has to read as an opinion rather than a measurement. Warm,
   loud, and set apart from the sourced lines above it - 11/10 is the format's
   way of saying "we loved this", and nobody mistakes it for data. */
.score {
  font-size: ${Math.round(h * 0.03)}px;
  font-weight: 900;
  line-height: 1.32;
}

/* The one line that has to make somebody want to go. Bigger than the practical
   lines and set apart from them, because on the slide as on the trip it is the
   reason and they are the logistics. */
.hook {
  font-size: ${Math.round(h * 0.0325)}px;
  font-weight: 800;
  line-height: 1.32;
  max-width: 94%;
}
.hook.long { font-size: ${Math.round(h * 0.0285)}px; }
/* No divider. A rule between the hook and the facts is furniture — the gap
   already does that job, and every line of decoration moves this further from
   what the feed looks like. */
.rule { display: none; }

.lines { display: flex; flex-direction: column; gap: ${Math.round(h * 0.0125)}px; align-items: center; }
.line {
  font-size: ${Math.round(h * 0.0295)}px;
  font-weight: 700;
  line-height: 1.25;
  display: flex;
  align-items: center;
  gap: 14px;
  /* The emoji is the only LTR run on the slide and it sits at the start of an
     RTL line; isolating it keeps bidi from dragging it into the middle of the
     Hebrew. */
  unicode-bidi: isolate;
}
.line .em { font-size: 1.05em; -webkit-text-stroke: 0; paint-order: normal; }
/* The artwork sits ON the line rather than under it. A 1em image aligns to the
   baseline by default, which next to Hebrew reads as a picture that fell off
   the text. No stroke or shadow on it either - those are for letterforms, and
   on a drawing they look like a printing fault. */
.emoji {
  display: inline-block;
  vertical-align: -0.16em;
  -webkit-text-stroke: 0;
  filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));
}
/* A line the drafting step made too long still renders, one step smaller,
   rather than wrapping into three lines of mush or being silently dropped —
   the fact was verified, and hiding a verified fact is the worse failure. */
.line.long { font-size: ${Math.round(h * 0.0245)}px; }

/* No slide counter. TikTok draws its own, and a second one in our styling was
   the tell that this was made somewhere else and uploaded.
   The attribution stays, because a claim without its source is not something
   this pipeline ships — but small, low, and quiet enough not to read as a
   logo. The brand appears on the cover and nowhere else. */
.foot {
  position: absolute;
  left: 0; right: 0;
  bottom: ${Math.round(bottomSafe * 0.34)}px;
  display: flex;
  justify-content: center;
  gap: 12px;
  font-size: ${Math.round(h * 0.0155)}px;
  font-weight: 600;
  color: rgba(255,255,255,0.62);
  text-shadow: 0 2px 8px rgba(0,0,0,0.9);
}
.site { font-weight: 700; color: rgba(255,255,255,0.72); direction: ltr; }
.src { direction: ltr; }
`;

/** Measured in characters, which for one script at one weight is close enough. */
export const coverSize = (title) => {
  const n = String(title || '').length;
  if (n > 30) return ' long';
  if (n > 20) return ' mid';
  return '';
};

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

  // Capped here as well as in drafting. A deck staged before the cap existed is
  // still in the queue with four lines on a slide, and the template is the last
  // place that can stop it going out as a wall of small text.
  const lines = (slide.lines || [])
    .slice(0, 2)
    .map(
      (l) =>
        `<div class="line${l.overlong ? ' long' : ''}"><span class="slab">${escapeHtml(l.text)} <span class="em">${emojiHtml(l.emoji)}</span></span></div>`
    )
    .join('');

  // The cover sells the deck and the item slides deliver it, so they are built
  // differently: a cover is a count and a promise, an item slide is a name, the
  // reason to go, and the logistics under a rule.
  // Every line is its own slab. `display:inline` on the inner span is what
  // makes the background hug the words rather than the column.
  const slab = (cls, text) => `<div class="${cls}"><span class="slab">${escapeHtml(text)}</span></div>`;

  const body = cover
    ? `<div class="plate">` +
      (slide.eyebrow ? slab('eyebrow', slide.eyebrow) : '') +
      slab(`cover-title${coverSize(slide.titleHe)}`, slide.titleHe) +
      (slide.angleHe ? slab('cover-angle', slide.angleHe) : '') +
      `</div>`
    : `<div class="plate">` +
      slab('place', slide.nameHe) +
      (slide.hook ? slab(`hook${slide.hook.overlong ? ' long' : ''}`, slide.hook.text) : '') +
      (lines ? `<div class="lines">${lines}</div>` : '') +
      // The number alone, with an emoji. Labelling it "הדירוג שלנו" was the
      // tutorial voice again: on a real page the score is just there, and
      // everyone already knows whose opinion it is.
      (slide.score
        ? `<div class="score"><span class="slab">${escapeHtml(slide.score)} ${emojiHtml(scoreEmoji(slide.score))}</span></div>`
        : '') +
      `</div>`;

  // Nothing at the bottom of a fact slide. A URL burned into a photograph is
  // the single most reliable sign that a post was made by a company rather
  // than a person, and the sources have not gone anywhere: every slide's URL
  // is in the approval message, and the caption carries the site.
  const foot = cover ? `<span class="site">${escapeHtml(siteMark())}</span>` : '';

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css(s)}</style></head><body>
${photo(slide.image, s)}
<div class="scrim"></div>
<div class="content">${body}</div>
${foot ? `<div class="foot">${foot}</div>` : ''}
</body></html>`;
}
