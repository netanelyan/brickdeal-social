import {
  palette,
  tiktokSansDataUri,
  arimoDataUri,
  assistantDataUri,
  heeboDataUri,
  escapeHtml,
} from './theme.js';
import { emojiHtml } from './emojiArt.js';
import { brickConfig } from '../brick/config.js';
import { priceLineHtml } from '../brick/copy.js';
import { SIZES } from './sizes.js';

// A BrickDeal slide, set the way @lego_from_ali sets one.
//
// Deliberately a separate file from deckTemplates.js rather than a third style
// inside it. The two are not variations on a look, they are opposite readings
// of the same brief, and the travel file says so at length — its slides carry
// small, light, unstroked type because "a stroke around every letter is not
// something TikTok's own text tool can produce, so the eye reads it as
// foreign". Folding this in beside that comment would leave the file arguing
// with itself on every render.
//
// BOTH TREATMENTS WERE BUILT AND THE LIGHTER ONE WON. The heavy version came
// first, straight off the reference: type hard against the right edge in a ~7px
// black outline, which is what TikTok's own editor produces and reads as
// somebody typing on a photo in the app. Rendered over our own frames beside
// the posts this channel already publishes, it was the louder of the two and
// the owner picked the other.
//
// So the anatomy below is the TRAVEL channel's, and what carries legibility is
// no longer the outline. At ~2px that is an edge, not a border; the scrim and
// the shadow are doing the work. Which is worth stating plainly, because it is
// the one thing that can go wrong: a home shot of a white wall in daylight is
// the background a fine outline struggles on, and it is also the most common
// one these photographs will produce. `npm run brick-lab` renders that case
// first for exactly this reason.
//
//   - the photograph fills the frame, edge to edge. No card, no border, no
//     blur, no badge, no logo chip.
//   - the text CENTRED: a set name near the top, a hook across the middle.
//   - four lines: the set name and one emoji, largest; then three price lines
//     of equal size - what it costs us, what it lists for, the difference.
//   - one phrase in cream rather than white, because Hebrew has no capitals and
//     a shout has to be carried by colour. One phrase and not the line: if
//     every word is cream then no word is shouted.
//   - a small semi-transparent watermark, bottom centre, clear of TikTok's UI.

/**
 * The type scale for one frame, resolved from brick-config.json.
 *
 * Fractions of the frame's WIDTH by default, and that choice is the whole
 * reason this is a function rather than four constants. "Four percent" of a
 * 1080x1920 frame is 43px against the width and 77px against the height, which
 * is the difference between a caption and a billboard.
 */
export function brickScale({ w, h }) {
  const ov = brickConfig().overlay;
  const basis = ov.sizeBasis === 'height' ? h : w;
  const px = (pct) => Math.max(10, Math.round(basis * pct));
  return {
    ov,
    name: px(ov.namePct),
    line: px(ov.linePct),
    cover: px(ov.coverPct),
    // Measured off the frame rather than off the type. The name and the price
    // lines are within a quarter of each other, so one width reads consistently
    // across both - and at 2px the risk the travel file worried about (a stroke
    // sized for 68px letters closing the counters of 32px ones) does not arise.
    stroke: Math.max(1, Math.round(basis * ov.strokePct)),
    watermark: Math.max(9, Math.round(basis * brickConfig().watermark.sizePct)),
  };
}

/**
 * How far off the bottom the watermark sits.
 *
 * Taken from the frame's own bottom safe area rather than from the configured
 * fraction alone, and the max() is the point. TikTok draws the caption, the
 * handle and the sound over the bottom of the frame; the configured 8.5% of a
 * 1920 frame is 163px, which is comfortably INSIDE that band, so a watermark
 * placed there is a watermark nobody ever sees. The reference puts theirs above
 * the UI, which on a 9:16 means clearing roughly the bottom fifth.
 *
 * Computing it from `bottomSafe` also means the Instagram crop, whose furniture
 * is much shallower, does not inherit a margin sized for TikTok.
 */
export function watermarkBottom({ h, bottomSafe }) {
  const configured = brickConfig().watermark.bottomPct * h;
  return Math.round(Math.max(configured, bottomSafe + h * 0.02));
}

const photoTag = (image) =>
  image?.src
    ? `<img class="photo" src="${escapeHtml(image.src)}" alt="">`
    : `<div class="photo" style="background:linear-gradient(160deg, ${palette.inkSoft}, ${palette.ink})"></div>`;

/**
 * The outline, and the shadow that is actually doing the work.
 *
 * `paint-order: stroke fill` is still the right way to write it: the default
 * order paints the stroke ON TOP of the fill, centred on the glyph, so half of
 * it eats into the letter and Hebrew counters close up. Reversing it leaves the
 * letterform intact and puts the outline entirely outside it.
 *
 * `visible` is the outline you can see, and the doubling is why this takes a
 * number rather than a CSS string — `-webkit-text-stroke` is centred, so half
 * is painted over. At the configured 2px this is a definition edge rather than
 * a border, and legibility over a bright frame comes from the scrim and the
 * shadow below it. Raise `strokePct` toward 0.006 to get the reference's heavy
 * version back; nothing else has to change.
 */
const strokeCss = (visible, shadow) =>
  `paint-order:stroke fill;-webkit-text-stroke:${visible * 2}px rgba(0,0,0,0.85);text-shadow:${shadow};`;

/**
 * The stack, and the order is the whole of it.
 *
 * TikTok Sans first. It has no Hebrew, which is the point: it takes the digits,
 * the ₪ and any stray Latin in a set name — on a slide whose middle three lines
 * are prices, that is most of the characters on the frame — and every Hebrew
 * letter falls past it, glyph by glyph, into Arimo. The app behaves the same
 * way: its own text tool has no Hebrew in this face either and hands those
 * letters to the phone.
 *
 * Assistant and Heebo sit behind Arimo so that a face which fails to parse
 * degrades to legible-but-wrong rather than to tofu — and render/index.js
 * refuses the render in that case anyway, so this is the second line of defence
 * rather than the first.
 */
const STACK = `'TikTok Sans', 'Arimo', 'Assistant', 'Heebo', sans-serif`;

function css(size, scale) {
  const { w, h } = size;
  const ov = scale.ov;
  const wm = brickConfig().watermark;
  const side = Math.round(ov.sidePct * w);

  return `
/* The same four faces the travel channel's slides are set in, declared in the
   order they are reached.

   Each range below is the range the bundled FILE has. Declaring a range wider
   than the file covers is not harmless: it tells Chromium this face can serve
   the requested weight, so the weight is silently ignored rather than
   synthesised, and the type comes out lighter than the CSS says. Arimo is the
   one that matters — a single static SemiBold, declared as the 600 it is.

   font-display is block rather than the default swap. A swap period means
   Chromium is allowed to paint the fallback first, and the screenshot is taken
   as soon as the page settles; blocking makes that race impossible. */
@font-face {
  font-family: 'TikTok Sans';
  src: url('${tiktokSansDataUri()}') format('truetype');
  font-weight: 300 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Arimo';
  src: url('${arimoDataUri()}') format('truetype');
  font-weight: 600;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Assistant';
  src: url('${assistantDataUri()}') format('truetype');
  font-weight: 200 800;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Heebo';
  src: url('${heeboDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:${w}px; height:${h}px; overflow:hidden; background:${palette.ink}; }
body { position:relative; }

/* Edge to edge, cropped rather than letterboxed. A slide with a white band
   down one side is the single most obvious sign of an automated post. */
.photo { position:absolute; inset:0; width:${w}px; height:${h}px; object-fit:cover; }

/* Almost nothing, and it is not a panel.

   Two bands: one takes the edge off a blown-out sky behind a name at the top,
   one darkens the foot of the frame where TikTok draws its own caption in white
   over whatever we supplied. The middle of the picture is left alone, because
   the middle of the picture is the set.

   This is where legibility comes from now that the outline is 2px, so it is
   load-bearing rather than decorative — see the note at the top of this file
   about white walls. */
.scrim {
  position:absolute; inset:0;
  background:linear-gradient(to bottom,
    rgba(4,10,12,0.24) 0%,
    rgba(4,10,12,0.05) 28%,
    rgba(4,10,12,0.04) 60%,
    rgba(4,10,12,${size.h === 1920 ? 0.42 : 0.16}) 100%);
}

/* Centred, and the travel file argued hard against exactly this.
   
   Its reasoning was that centred type over a photograph is what every brand
   template does and almost no person does, and that dead centre is where the
   subject of the picture is — so centred words are words ON the subject. That
   is a good argument about a landscape, where the subject fills the frame. It
   is a weaker one here: a product shot has a model in the lower two thirds and
   room above it, which is where the name goes. The posts this channel already
   publishes are centred, and they are what the owner asked this to match. */
.block {
  position:absolute;
  left:${side}px;
  right:${side}px;
  width:${Math.round(ov.widthPct * w)}px;
  margin-inline:auto;
  direction:rtl;
  text-align:${ov.align};
  font-family:${STACK};
  font-weight:${ov.weight};
  line-height:${ov.lineHeight};
  color:#fff;
  opacity:${ov.opacity};
  ${strokeCss(scale.stroke, ov.shadow)}
}

/* A name sits near the top; a hook sits across the middle. Different jobs, so
   different positions — a set name floated into the centre of a product shot
   lands on the product. */
.block.at-top { top:${Math.round(ov.topPct * h)}px; }
.block.at-mid { top:${Math.round(ov.coverTopPct * h)}px; transform:translateY(-50%); }

.name {
  font-size:${scale.name}px;
  /* Two lines and no more. A set name that needs three is a set name the
     roundup should have shortened, and it is shortened upstream where the
     feed's own "<series> | <product>" split can be used to do it sensibly. */
  display:-webkit-box; -webkit-line-clamp:${ov.maxNameLines}; -webkit-box-orient:vertical;
  overflow:hidden;
  text-wrap:balance;
  margin-bottom:${Math.round(scale.line * 0.55)}px;
}
.name.long { font-size:${Math.round(scale.name * 0.86)}px; }

.line { font-size:${scale.line}px; }

/* Hebrew has no capitals, so the shout is carried by colour. One phrase on a
   cover, and the saving on a slide — which is the one number the whole post is
   an argument about. */
.emph { color:${ov.emphasis}; }
.emph.tight { white-space:nowrap; }

/* The emoji sits on the baseline as an image and reads as stuck under the
   words without this. No stroke or shadow on artwork: those are for
   letterforms, and on a drawing they look like a printing fault. */
.emoji {
  display:inline-block; vertical-align:-0.14em; margin-inline-start:0.14em;
  -webkit-text-stroke:0;
  filter:drop-shadow(0 2px 5px rgba(0,0,0,0.4));
}

.mark {
  position:absolute;
  left:0; right:0;
  bottom:${watermarkBottom(size)}px;
  text-align:center;
  direction:rtl;
  font-family:${STACK};
  font-weight:600;
  font-size:${scale.watermark}px;
  color:rgba(255,255,255,${wm.opacity});
  text-shadow:0 1px 6px rgba(0,0,0,0.5);
}

.cover {
  font-size:${scale.cover}px;
  text-wrap:balance;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
  overflow:hidden;
}
`;
}

/** A name long enough to want the smaller step. */
export const nameClass = (text) => (String(text || '').length > 24 ? ' long' : '');

/**
 * A cover line with one phrase set in cream.
 *
 * Ported from the travel pipeline's `coverTitle`, and the two notes it carried
 * are both still true here. The emphasis is found in the line rather than
 * concatenated around it, so a phrase the writer marked but then reworded
 * simply does not highlight instead of appearing twice. And it is held on one
 * line when it is short: "מחיר מלא" broken across a line end is two coloured
 * fragments rather than one shouted phrase.
 */
export function coverHtml(text, emphasis) {
  const t = String(text || '');
  const e = String(emphasis || '').trim();
  if (!e) return escapeHtml(t);
  const at = t.indexOf(e);
  if (at < 0) return escapeHtml(t);
  return (
    escapeHtml(t.slice(0, at)) +
    `<span class="emph${e.length <= 18 ? ' tight' : ''}">${escapeHtml(e)}</span>` +
    escapeHtml(t.slice(at + e.length))
  );
}

/**
 * One slide.
 *
 * `slide.lines` is what copy.js built: one price line, or three. Both are
 * normal. Three means the comparison could be sourced; one means it could not,
 * and the slide then says what the set costs and nothing about what it is
 * worth — which is the correct thing to say when Brickset has never heard of
 * the set number.
 *
 * No `spot` argument, and that is a departure from the travel slides worth
 * naming. There the placement search decides where the block goes, per
 * photograph. Here it does not get to: the block sits in the same place on
 * every slide, and that sameness is what makes five swipes read as one post.
 */
export function renderBrickSlideHtml(slide, { size = 'tiktok', cover = false } = {}) {
  const s = SIZES[size] || SIZES.tiktok;
  const scale = brickScale(s);
  const wm = brickConfig().watermark;

  let body;
  if (cover) {
    // The hook, and nothing else. No price block on a cover: the first slide's
    // whole job is to stop the scroll, and a number there answers the question
    // the next four slides are for.
    body = `<div class="cover">${coverHtml(slide.hookHe, slide.emphasisHe)}</div>`;
  } else {
    const name =
      escapeHtml(slide.nameHe) + (slide.emoji ? emojiHtml(slide.emoji, { size: '0.9em' }) : '');
    const lines = (slide.lines || [])
      .map((l, i) => {
        // The money bag and the cream both ride the saving line, which is the
        // last one when there is a comparison to make and absent when there is
        // not. Tied to the position rather than to the label, so rewording the
        // labels in the config cannot silently move the emphasis onto the
        // wrong number.
        const isSaving = (slide.lines || []).length === 3 && i === 2;
        return (
          `<div class="line${isSaving ? ' emph' : ''}">${priceLineHtml(l, escapeHtml)}` +
          (isSaving ? emojiHtml('💰', { size: '0.9em' }) : '') +
          `</div>`
        );
      })
      .join('');
    body = `<div class="name${nameClass(slide.nameHe)}">${name}</div>${lines}`;
  }

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css(
    s,
    scale
  )}</style></head><body>
${photoTag(slide.image)}
<div class="scrim"></div>
<div class="block ${cover ? 'at-mid' : 'at-top'}">${body}</div>
${wm.text ? `<div class="mark">${escapeHtml(wm.text)}</div>` : ''}
</body></html>`;
}
