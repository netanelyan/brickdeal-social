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

/* Barely there. The photograph is the post; this only takes the edge off a
   blown-out sky so white type has something to sit against. */
.scrim {
  background:
    linear-gradient(to bottom, rgba(6,14,13,0.34) 0%, rgba(6,14,13,0.06) 26%, rgba(6,14,13,0.10) 62%, rgba(6,14,13,0.58) 100%);
}

/* Legibility comes from the letters themselves, not from a panel behind them.

   The first version put the type on a blurred dark plate. It was perfectly
   readable and it looked like an advertisement: a card floating over a holiday
   photo is a thing a brand makes, and the format's own convention — white text
   with a heavy outline, straight on the image — is what everything else in the
   feed looks like. paint-order is what makes it work: without it the stroke is
   painted over the fill and eats the letterforms from the inside. */
.plate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${Math.round(h * 0.014)}px;
  max-width: 94%;
}
.cover-title, .place, .hook, .line, .eyebrow, .swipe {
  paint-order: stroke fill;
  -webkit-text-stroke: ${Math.round(h * 0.0055)}px rgba(0,0,0,0.92);
  text-shadow: 0 ${Math.round(h * 0.004)}px ${Math.round(h * 0.012)}px rgba(0,0,0,0.55);
}

/* Text sits above the middle, not in it. Centred type lands on whatever the
   subject of the photograph is; the upper third clears it, and it clears the
   app's own furniture at the bottom of the screen too. */
.content {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  padding: ${Math.round(h * 0.22)}px ${Math.round(w * 0.065)}px ${bottomSafe}px;
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
  color: rgba(255,233,168,0.9);
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
  color: rgba(255,248,230,0.92);
  letter-spacing: 1px;
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
  font-size: ${Math.round(h * 0.046)}px;
  font-weight: 900;
  line-height: 1.1;
  color: #FFE9A8;
  text-shadow: 0 4px 22px rgba(0,0,0,0.8), 0 1px 0 rgba(0,0,0,0.6);
}

/* The one line that has to make somebody want to go. Bigger than the practical
   lines and set apart from them, because on the slide as on the trip it is the
   reason and they are the logistics. */
.hook {
  font-size: ${Math.round(h * 0.0345)}px;
  font-weight: 800;
  line-height: 1.26;
  color: #FFFFFF;
  max-width: 94%;
}
.hook.long { font-size: ${Math.round(h * 0.0295)}px; }
/* No divider. A rule between the hook and the facts is furniture — the gap
   already does that job, and every line of decoration moves this further from
   what the feed looks like. */
.rule { display: none; }

.lines { display: flex; flex-direction: column; gap: ${Math.round(h * 0.0125)}px; align-items: center; }
.line {
  font-size: ${Math.round(h * 0.0295)}px;
  font-weight: 700;
  line-height: 1.25;
  color: #FFFFFF;
  display: flex;
  align-items: center;
  gap: 14px;
  /* The emoji is the only LTR run on the slide and it sits at the start of an
     RTL line; isolating it keeps bidi from dragging it into the middle of the
     Hebrew. */
  unicode-bidi: isolate;
}
.line .em { font-size: 1.05em; -webkit-text-stroke: 0; paint-order: normal; }
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
        `<div class="line${l.overlong ? ' long' : ''}"><span class="em">${escapeHtml(l.emoji)}</span><span>${escapeHtml(l.text)}</span></div>`
    )
    .join('');

  // The cover sells the deck and the item slides deliver it, so they are built
  // differently: a cover is a count and a promise, an item slide is a name, the
  // reason to go, and the logistics under a rule.
  const body = cover
    ? `<div class="plate">` +
      (slide.eyebrow ? `<div class="eyebrow">${escapeHtml(slide.eyebrow)}</div>` : '') +
      `<div class="cover-title${coverSize(slide.titleHe)}">${escapeHtml(slide.titleHe)}</div>` +
      (slide.angleHe ? `<div class="cover-angle">${escapeHtml(slide.angleHe)}</div>` : '') +
      `</div>` +
      `<div class="swipe">החליקו ←</div>`
    : `<div class="plate">` +
      `<div class="place">${escapeHtml(slide.nameHe)}</div>` +
      (slide.hook
        ? `<div class="hook${slide.hook.overlong ? ' long' : ''}">${escapeHtml(slide.hook.text)}</div>`
        : '') +
      (lines ? `<div class="rule"></div><div class="lines">${lines}</div>` : '') +
      `</div>`;

  // The source host on a fact slide, the site on the cover, and never both.
  //
  // A screenshot travels without its caption, so a slide making a claim has to
  // say where the claim came from — that rule does not bend for a format. What
  // changed is the volume: printing our own domain next to the source on every
  // slide was branding, and branding on every slide is what an advertisement
  // looks like.
  const foot = cover
    ? `<span class="site">${escapeHtml(siteMark())}</span>`
    : `<span class="src">${escapeHtml(slide.sourceHost || '')}</span>`;

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css(s)}</style></head><body>
${photo(slide.image, s)}
<div class="scrim"></div>
<div class="content">${body}</div>
<div class="foot">${foot}</div>
</body></html>`;
}
