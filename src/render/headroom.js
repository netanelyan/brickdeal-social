// The room above the model, measured — and made when it is not there.
//
// Every slide in this format is four lines of Hebrew over a photograph, and the
// whole layout rests on one assumption: that the photograph has empty space at
// the top for those lines to sit in. Three separate things have been done to
// make that true and all three are best-effort:
//
//   - the prompt asks for it (src/images/homeShot.js, the Headroom paragraph),
//   - the 4:5 crop is biased upward so it does not throw the room away
//     (photoAnchorPct in ./sizes.js),
//   - the scrim's top band darkens whatever is up there (./brickSlide.js).
//
// A deck shipped with the type across a Christmas tree, a nightshade plant and
// a bouquet of tulips anyway, because none of those three can do anything about
// the actual failure: an image generator handed back a photograph of a tall
// subject filling the frame top to bottom. You cannot fix that with a prompt
// you have already written or a crop of a picture that has no spare picture in
// it.
//
// SO THE PHOTOGRAPH IS MEASURED AND THEN MOVED. This file finds where the
// subject actually starts, works out where it has to start for the type to
// clear it, and produces a geometry that puts it there. Two levers, in order of
// what they cost:
//
//   1. DROP the photograph down the frame. Free in the sense that nothing is
//      invented, paid for by cropping the bottom — which is where the hand
//      enters — so it is bounded per frame by `photoDropMaxPct`.
//   2. ZOOM OUT. Keeps everything in the picture and makes the subject smaller;
//      paid for with slivers down the sides that are not photograph. Bounded by
//      `photoZoomMin`, and only reached when the drop was not enough.
//
// Whatever the levers expose at the top is filled, and the fill is why this
// reads as a photograph rather than as a letterbox. Preferred fill is the
// picture's OWN top strip stretched upward: these shots open on a plain
// out-of-focus wall, and a wall stretched vertically by a factor under two is
// not a thing an eye can see. When the strip is too thin for that, or the sides
// are open, the backdrop is the same photograph blurred — which is the room the
// picture was taken in, out of focus, and reads as depth rather than as a band.
//
// WHAT IS MEASURED IS SHARPNESS, not content, and that distinction is the whole
// detector. The prompt puts the background out of focus and the model in focus,
// so the subject is the sharpest thing in the frame by construction. A blurred
// shelf, a picture frame on the far wall, the edge of a desk — all things the
// type sits over perfectly happily — have a fraction of the local contrast a
// brick edge has. Measuring "is anything there" would find the whole room;
// measuring "is anything SHARP there" finds the model.
//
// Two of the functions below run in Chromium rather than in node, because the
// only image decoder in this project is the browser the renderer already has
// open. They are written as ordinary exported functions and handed to the page
// as source text; nothing in them may close over anything in this module.

/* -------------------------------------------------------------------------- */
/* Pure — decisions, testable in node                                          */
/* -------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where the subject starts, as a fraction of the image's height.
 *
 * `energy` is one number per row: how sharp the sharpest part of that row is,
 * across the middle of the frame. See sampleImage below for how it is taken.
 *
 * Judged on two thresholds at once, relative and absolute, because each one
 * alone has a failure this format will actually hit. Relative alone (a fraction
 * of the sharpest row in the picture) turns the grain of a photograph of a bare
 * wall into a subject, since dividing by a small peak makes everything large.
 * Absolute alone cannot survive the range of exposure and contrast a generated
 * room comes back with. So a subject has to be sharp compared to the rest of
 * this picture AND sharp in plain terms.
 *
 * `run` rows have to hold it. A single row over the line is a compression
 * artefact or the top edge of a blurred shelf; a model is a hundred rows tall.
 *
 * Returns 1 when there is nothing sharp anywhere — a legitimate answer for a
 * catalogue photo on a white sweep, and the caller reads it as "all of this is
 * empty", which is correct: type can go anywhere on it.
 */
export function subjectTopRow(energy, { enter = 0.3, stay = 0.18, floor = 0.05, run = 4 } = {}) {
  const n = energy?.length || 0;
  if (!n) return 1;
  const sorted = [...energy].sort((a, b) => a - b);
  const peak = sorted[Math.min(n - 1, Math.floor(n * 0.97))];
  if (!(peak >= floor)) return 1;

  for (let y = 0; y < n; y++) {
    if (energy[y] < enter * peak || energy[y] < floor * 0.7) continue;
    let held = 1;
    const want = Math.min(run, n - y);
    for (let k = 1; k < want; k++) if (energy[y + k] >= stay * peak) held++;
    if (held >= want) return y / n;
  }
  return 1;
}

/**
 * Where the photograph goes, so that the subject clears the type.
 *
 * All lengths are frame pixels; `subject` is the fraction from subjectTopRow.
 * `need` is the y the subject is not allowed to start above — in practice the
 * bottom of the rendered text block plus a little air, measured off the DOM
 * rather than assumed, because a two-line set name and a one-line one do not
 * end in the same place.
 *
 * Returns null when the photograph is already fine, and null is the common case
 * on a shot that came back the way the prompt asked for. Nothing is moved,
 * scaled or filled unless the measurement says it has to be, so a good
 * photograph renders exactly as it did before this file existed.
 *
 * THE ZOOM IS ANCHORED ON THE PHOTOGRAPH'S BOTTOM EDGE, which is the only
 * anchor that helps. Shrinking about the centre moves the subject's top down by
 * half of what it takes off the subject's height and moves its bottom up by the
 * other half, so it buys headroom and loses the hold; shrinking about the
 * bottom edge keeps the hand where it is and spends the whole shrink on the
 * thing being asked for.
 */
export function fitPhoto({
  frameW,
  frameH,
  imgW,
  imgH,
  subject,
  need,
  anchorPct = 0.5,
  dropMax = 0,
  zoomMin = 1,
}) {
  if (!(frameW > 0 && frameH > 0 && imgW > 0 && imgH > 0)) return null;

  // Where the picture sits today: object-fit: cover, anchored per ./sizes.js.
  const s0 = Math.max(frameW / imgW, frameH / imgH);
  const w0 = s0 * imgW;
  const h0 = s0 * imgH;
  const y0 = -(h0 - frameH) * clamp(anchorPct, 0, 1);

  const top0 = y0 + h0 * subject;
  if (top0 >= need) return null;

  const drop = Math.min(need - top0, Math.max(0, dropMax));
  const y1 = y0 + drop;

  // Fixed under the zoom, and it is already at or below the frame's bottom edge
  // because the natural presentation covers and a drop only pushes it further
  // down. That is what makes the bottom of every slide real photograph.
  const bottom = y1 + h0;

  let z = 1;
  if (y1 + h0 * subject < need && subject < 1) {
    z = clamp((bottom - need) / (h0 * (1 - subject)), zoomMin, 1);
  }

  const w = w0 * z;
  const h = h0 * z;
  const y = bottom - h;
  const x = (frameW - w) / 2;

  // What the levers exposed. `band` is bare frame above the photograph; `sides`
  // is bare frame down both edges, which only a zoom can produce.
  const band = Math.max(0, y);
  const sides = w < frameW - 0.5;

  // The strip available to stretch: the subject-free top of the photograph, at
  // the scale it is actually drawn.
  //
  // THE TOP BAND IS FILLED WITH THIS WHENEVER THERE IS ANY OF IT, including
  // when the sides are open and a blurred backdrop is going in behind anyway.
  // The backdrop is the wrong thing to put behind the type specifically: it is
  // the whole photograph covered, so the subject appears in it, out of focus,
  // directly above the sharp one — a bouquet with a ghost of itself over the
  // words. The wall does not have that problem because the wall is all it is.
  //
  // Which means the stretch factor is no longer bounded by what looks right at
  // 1:1. A thin strip over a deep band is a big multiplication, and what that
  // smears is a soft vertical gradient in a wall, so `soften` blurs the strip
  // in proportion — it was out of focus to begin with, and more of it reads as
  // depth rather than as a fault.
  //
  // It is not unbounded, though, and the bound is mechanical rather than
  // aesthetic: the browser is being asked to draw the picture at
  // (band + strip) / strip times its height, and a ten-pixel strip under a deep
  // band asks for a background tens of thousands of pixels tall. Past forty it
  // is a wash of one colour anyway, and a wash is what the blurred backdrop
  // would give with a photograph behind it.
  const strip = h * subject;
  const stretch = band > 0.5 && strip >= 10 && (band + strip) / strip <= 40;
  const k = stretch ? (band + strip) / strip : 1;

  // The fill is drawn with a bleed all round, and the bleed is not cosmetic.
  //
  // A CSS blur fades a box's own edges into transparency, so a blurred fill
  // sized exactly to the band would come back with a soft transparent line
  // along the top of the frame — the artefact it was added to avoid, in the one
  // place the eye is already looking. So the box overhangs the frame by more
  // than the blur can reach, and the background is scaled so the strip still
  // lands exactly where the photograph's own copy of it is.
  const bleed = 64;
  const tall = band + strip + bleed;

  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    zoom: Number(z.toFixed(4)),
    drop: Math.round(drop),
    band: Math.round(band),
    sides,
    stretch: stretch
      ? {
          // Across the whole frame when the picture no longer reaches the
          // edges, rather than only across the picture. The alternative is a
          // sliver of blurred backdrop up each side of the band, which is the
          // one place on the slide where the backdrop shows the subject — the
          // corners of the type's own space, out of focus. Filling the frame
          // costs a horizontal stretch of the wall, which a wall does not
          // record, and the strip is wall by definition.
          left: sides ? -bleed : Math.round(x - bleed),
          top: -bleed,
          width: Math.round((sides ? frameW : w) + bleed * 2),
          height: Math.round(tall),
          // Where the picture sits inside that box, and how big it has to be
          // drawn for its top strip to fill the band.
          bgX: sides ? 0 : bleed,
          bgW: Math.round((sides ? frameW : w) + (sides ? bleed * 2 : 0)),
          bgH: Math.round(tall / subject),
          soften: Math.round(clamp((k - 1.6) * 3.5, 0, 18)),
          // The join with the photograph underneath, which is the same rows of
          // the same picture at a different vertical scale.
          //
          // NEVER LONGER THAN THE STRIP. The fade reveals what is under the
          // fill, and what is under the fill above the photograph's own top
          // edge is the backdrop — so a fade that reaches past that edge puts
          // a blurred ghost of the subject directly under the last line of
          // type, which is where a bouquet's blooms showed through.
          fade: Math.max(6, Math.round(Math.min(110, strip * 0.9))),
          // Kept for the composite the scrim is measured on.
          band: Math.round(band),
          strip: Math.round(strip),
          srcH: Math.max(1, Math.round(imgH * subject)),
        }
      : null,
    blur: sides || (band > 0.5 && !stretch),
    // Where the subject ends up, and whether that was enough. `short` is the
    // honest outcome for a photograph that fills the frame top to bottom: both
    // levers ran out, the type still lands on the set, and the scrim below is
    // all that is left. It is reported rather than hidden.
    top: Math.round(bottom - h * (1 - subject)),
    short: Math.max(0, Math.round(need - (bottom - h * (1 - subject)))),
  };
}

/* -------------------------------------------------------------------------- */
/* Pure — the scrim, sized to the picture instead of to the worst picture      */
/* -------------------------------------------------------------------------- */

const CONTRAST_WHITE = (l) => 1.05 / (l + 0.05);
const toSrgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const toLinear = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));

// The scrim's colour, rgba(4,10,12), as relative luminance.
const SCRIM_LUM = 0.0035;

/**
 * What a band of this luminance measures once the scrim is over it.
 *
 * Composited in sRGB because that is where the browser does it. Averaging
 * linear luminances instead reports a scrim as darker than it renders, which
 * sizes every scrim too light — the error runs the wrong way, so it is not the
 * harmless kind.
 */
export const underScrim = (lum, alpha) => toLinear(toSrgb(lum) * (1 - alpha) + toSrgb(SCRIM_LUM) * alpha);

/**
 * The lightest scrim this band can take and still carry white type.
 *
 * Searched rather than solved: the compositing above is not invertible in one
 * line once the transfer curve is in it, and a hundred iterations of three
 * multiplications is free.
 *
 * `want` is deliberately under the WCAG numbers. The type on these slides is
 * not bare white — it carries a dark outline and a soft shadow, which is what
 * the format decided should do the work — so the scrim is there to stop a white
 * wall swallowing the letters, not to carry them alone. Sized for 4.5:1 it
 * paints a grey band across the top of every bright slide, which is the thing
 * the fixed 0.36 was already doing and half the reason the type looked stuck on.
 */
export function scrimAlpha(lum, { want = 3, floor = 0.1, ceiling = 0.55 } = {}) {
  for (let a = Math.max(0, floor); a <= ceiling; a += 0.01) {
    if (CONTRAST_WHITE(underScrim(lum, a)) >= want) return Math.round(a * 100) / 100;
  }
  return ceiling;
}

/* -------------------------------------------------------------------------- */
/* In-page — the decoder, and the composite the scrim is measured on           */
/* -------------------------------------------------------------------------- */

/**
 * One image, sampled to a row profile. RUNS IN CHROMIUM.
 *
 * 200 cells across, which is chosen against the thing being detected rather
 * than for tidiness. Downsampling is a low-pass filter, so sampling coarsely
 * blurs the sharp and the blurred into the same thing and destroys the only
 * signal here: at 200 wide a 20px background blur is still five cells of soft
 * ramp while a brick edge is still one cell of cliff.
 *
 * Per row, the mean of the sharpest twelfth of its cells across the middle of
 * the frame. A mean over the whole row would lose a plant stem in a wall; a
 * maximum would find one compression artefact. The middle of the frame because
 * that is where the type is and where the subject is; a coat hook in the corner
 * is not a reason to move a photograph.
 *
 * Throws on a cross-origin image, which is a getImageData security error rather
 * than anything this can check first — the caller treats a throw as "not
 * measurable" and leaves the slide alone.
 */
export async function sampleImage(src, cfg) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!(iw > 0 && ih > 0)) throw new Error('no pixels');

  const gw = Math.min(cfg.gw, iw);
  const gh = Math.max(8, Math.round((gw * ih) / iw));
  const canvas = new OffscreenCanvas(gw, gh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;

  const lum = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    lum[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }

  const x0 = Math.max(1, Math.round(gw * cfg.x0));
  const x1 = Math.min(gw - 1, Math.round(gw * cfg.x1));
  const rows = [];
  for (let y = 0; y < gh; y++) {
    const cells = [];
    for (let x = x0; x < x1; x++) {
      const i = y * gw + x;
      let e = Math.abs(2 * lum[i] - lum[i - 1] - lum[i + 1]);
      if (y > 0 && y < gh - 1) e += Math.abs(2 * lum[i] - lum[i - gw] - lum[i + gw]);
      cells.push(e);
    }
    cells.sort((a, b) => b - a);
    const take = Math.max(1, Math.round(cells.length / 12));
    let sum = 0;
    for (let k = 0; k < take; k++) sum += cells[k];
    rows.push(sum / take);
  }

  return { iw, ih, rows };
}

/**
 * The brightest row of the region the type will occupy. RUNS IN CHROMIUM.
 *
 * Measured off a small copy of the FINISHED composite — backdrop, photograph
 * and wall-fill, in the positions the fit just chose — rather than off the
 * original image, because after a drop or a zoom the original says nothing
 * about what is behind the words any more.
 *
 * The brightest row rather than the mean, for the same reason the fit measures
 * the subject rather than the picture: a band that is dark except for one
 * bright strip averages comfortable and loses the line of type that lands on
 * the strip.
 */
export async function composeLuma(src, cfg, geom, rect) {
  const img = new Image();
  img.src = src;
  await img.decode();

  const cw = 120;
  const ch = Math.max(8, Math.round((cw * cfg.frameH) / cfg.frameW));
  const k = cw / cfg.frameW;
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  if (geom.blur) {
    // Same backdrop the page draws: covered, overscanned a little so the blur
    // has something to eat at the edges, and softened.
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * 1.12;
    const bw = img.naturalWidth * s;
    const bh = img.naturalHeight * s;
    try {
      ctx.filter = 'blur(3px)';
    } catch {
      /* the numbers survive without it */
    }
    ctx.drawImage(img, (cw - bw) / 2, (ch - bh) / 2, bw, bh);
    ctx.filter = 'none';
  }

  ctx.drawImage(img, geom.x * k, geom.y * k, geom.w * k, geom.h * k);

  if (geom.stretch) {
    const f = geom.stretch;
    ctx.drawImage(
      img,
      0,
      0,
      img.naturalWidth,
      f.srcH,
      (f.left + f.bgX) * k,
      f.top * k,
      f.bgW * k,
      f.height * k
    );
  }

  const x0 = Math.max(0, Math.floor(rect.x * k));
  const x1 = Math.min(cw, Math.ceil((rect.x + rect.w) * k));
  const y0 = Math.max(0, Math.floor(rect.y * k));
  const y1 = Math.min(ch, Math.ceil((rect.y + rect.h) * k));
  if (x1 <= x0 || y1 <= y0) return 0;

  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const lin = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  let worst = 0;
  for (let y = 0; y < y1 - y0; y++) {
    let sum = 0;
    for (let x = 0; x < x1 - x0; x++) {
      const i = (y * (x1 - x0) + x) * 4;
      sum +=
        0.2126 * lin(data[i] / 255) + 0.7152 * lin(data[i + 1] / 255) + 0.0722 * lin(data[i + 2] / 255);
    }
    worst = Math.max(worst, sum / (x1 - x0));
  }
  return worst;
}

/* -------------------------------------------------------------------------- */
/* The script the slide carries                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the sampler reads a frame, and how far the fit is allowed to go.
 *
 * `x0`/`x1` bound the columns the subject is looked for in: the type block is
 * 84% of the frame wide and centred, so anything outside this is not something
 * the words can land on.
 */
export const SAMPLE = { gw: 200, x0: 0.1, x1: 0.9 };

// Air between the last line of type and the top of the model, as a fraction of
// the frame. Nothing subtle: at zero the two touch and the slide reads as the
// type resting on the set rather than sitting above it.
export const PAD_PCT = 0.025;

/**
 * The measurement, the fit and the scrim, as a script the slide page runs.
 *
 * IN THE PAGE RATHER THAN IN A PASS BEFOREHAND, deliberately. Every caller that
 * renders a slide gets this — the deck, the two single-slide redraws, the lab —
 * without any of them having to know it exists or thread a measurement through.
 * A pre-pass is a thing a fifth caller forgets to run, and the failure mode of
 * forgetting is a slide with the type across the model, which is where this
 * started.
 *
 * It also means the block's real height is available. The type is measured off
 * the DOM after layout rather than estimated from the font sizes, so a two-line
 * set name pushes the photograph further down than a one-line one does, exactly
 * as much as it needs to.
 *
 * `window.__slideReady` is the contract with renderToJpeg: it waits for that
 * promise before screenshotting. It resolves on every path, including failure,
 * because a slide that cannot be measured must still render — the geometry then
 * stays exactly as the stylesheet wrote it.
 */
export function fitScript({ frameW, frameH, anchorPct, dropMax, zoomMin, scrim, bottomA, enabled }) {
  const cfg = {
    frameW,
    frameH,
    anchorPct,
    dropMax,
    zoomMin,
    padPx: Math.round(PAD_PCT * frameH),
    sample: SAMPLE,
    scrim,
    bottomA,
    enabled,
  };

  return `<script>
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const CONTRAST_WHITE = (l) => 1.05 / (l + 0.05);
const toSrgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const toLinear = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
const SCRIM_LUM = ${SCRIM_LUM};
const underScrim = ${underScrim.toString()};
${subjectTopRow.toString()}
${fitPhoto.toString()}
${scrimAlpha.toString()}
${sampleImage.toString()}
${composeLuma.toString()}

// A hard stop, because the screenshot is waiting on this.
//
// Everything below is best-effort — a photograph that cannot be decoded, a
// cross-origin image that taints the canvas, a browser that does not have
// OffscreenCanvas — and every one of those paths already resolves. The race is
// for the one that does not: a decode that never settles would otherwise hang
// the render forever rather than produce an unimproved slide.
window.__slideReady = Promise.race([
  new Promise((done) => setTimeout(done, 8000)),
  (async () => {
    const cfg = ${JSON.stringify(cfg)};
    const note = (o) => { document.documentElement.dataset.fit = JSON.stringify(o); };
    try {
      const photo = document.querySelector('img.photo');
      const src = photo && photo.getAttribute('src');
      if (!cfg.enabled || !src) return note({ fit: 'none' });

      const m = await sampleImage(src, cfg.sample);
      const subject = subjectTopRow(m.rows);

      const block = document.querySelector('.block');
      const r = block ? block.getBoundingClientRect() : null;
      const need = r ? r.bottom + cfg.padPx : cfg.frameH * 0.36;

      const plan = fitPhoto({
        frameW: cfg.frameW, frameH: cfg.frameH, imgW: m.iw, imgH: m.ih,
        subject, need, anchorPct: cfg.anchorPct, dropMax: cfg.dropMax, zoomMin: cfg.zoomMin,
      });

      // The geometry the composite is measured on, whether or not anything moved.
      const s0 = Math.max(cfg.frameW / m.iw, cfg.frameH / m.ih);
      const geom = plan || {
        x: Math.round((cfg.frameW - s0 * m.iw) / 2),
        y: Math.round(-(s0 * m.ih - cfg.frameH) * cfg.anchorPct),
        w: Math.round(s0 * m.iw), h: Math.round(s0 * m.ih),
        top: null, band: 0, stretch: null, blur: false, zoom: 1, drop: 0, short: 0,
      };

      if (plan) {
        if (plan.blur) {
          const back = document.querySelector('img.backdrop');
          if (back) { back.src = src; back.hidden = false; }
        }
        photo.style.cssText +=
          ';inset:auto;object-fit:fill;left:' + plan.x + 'px;top:' + plan.y + 'px;width:' +
          plan.w + 'px;height:' + plan.h + 'px;';

        // The photograph's own edges, wherever they are now inside the frame.
        //
        // A shrunk picture over a blurred one is two pictures until the join
        // is softened: a hard vertical line down each side and a hard
        // horizontal one across the top, which together read as a snapshot
        // pasted onto a background. Faded over 40px they read as the same
        // photograph going out of focus. Only the edges that are actually
        // exposed are faded — fading an edge that sits against the frame's own
        // edge would put a dark rim around the slide.
        const fades = [];
        if (plan.sides) fades.push('linear-gradient(to right, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%)');
        if (plan.band > 0.5 && !plan.stretch) fades.push('linear-gradient(to bottom, transparent 0, #000 40px, #000 100%)');
        if (fades.length) {
          photo.style.cssText +=
            '-webkit-mask-image:' + fades.join(',') + ';mask-image:' + fades.join(',') +
            ';-webkit-mask-composite:source-in;mask-composite:intersect;';
        }

        if (plan.stretch) {
          const fill = document.querySelector('.wallfill');
          if (fill) {
            // The source strip stretched vertically, drawn OVER the top of the
            // photograph rather than beside it. Over, because then the strip
            // and the picture meet at the same row of the same image, and the
            // join is a change of vertical scale in a wall instead of a seam
            // between two different things.
            const f = plan.stretch;
            fill.hidden = false;
            fill.style.cssText +=
              ';left:' + f.left + 'px;top:' + f.top + 'px;width:' + f.width + 'px;height:' +
              f.height + 'px;background-image:url("' + src + '");background-position:' +
              f.bgX + 'px 0;background-size:' + f.bgW + 'px ' + f.bgH + 'px;' +
              (f.soften ? 'filter:blur(' + f.soften + 'px);' : '') +
              '-webkit-mask-image:linear-gradient(to bottom,#000 0,#000 ' + (f.height - f.fade) +
              'px,transparent ' + f.height + 'px);mask-image:linear-gradient(to bottom,#000 0,#000 ' +
              (f.height - f.fade) + 'px,transparent ' + f.height + 'px);';
          }
        }
      }

      // The scrim, sized to what the type actually ended up over.
      //
      // Written as a whole gradient rather than as one variable in the
      // stylesheet's: the band has to hold its measured value across the block
      // and let go just under it, and where "just under it" is depends on how
      // tall the block turned out to be. A fixed set of stops with a variable
      // alpha would be measured at the top of the frame and applied a third of
      // the way down at a quarter of its strength.
      let alpha = null;
      const scrim = document.querySelector('.scrim');
      if (r && scrim && !scrim.classList.contains('end-scrim')) {
        try {
          const lum = await composeLuma(src, cfg, geom, { x: r.x, y: r.y, w: r.width, h: r.height });
          alpha = scrimAlpha(lum, cfg.scrim);
          // Held at full strength across the block, then let go SLOWLY. The
          // band is invisible as a band only while nothing about it has an
          // edge: over a plain wall a short ramp reads as a horizontal line
          // across the picture, which is a worse artefact than the wash it was
          // trying to avoid. So it holds to the last line of type and takes a
          // fifth of the frame to fade out under it.
          const hold = ((r.bottom + cfg.padPx * 0.5) / cfg.frameH) * 100;
          const gone = Math.min(74, hold + 20);
          scrim.style.background =
            'linear-gradient(to bottom,' +
            'rgba(4,10,12,' + alpha + ') 0%,' +
            'rgba(4,10,12,' + alpha + ') ' + Math.max(0, (r.top / cfg.frameH) * 100).toFixed(1) + '%,' +
            'rgba(4,10,12,' + (alpha * 0.94).toFixed(3) + ') ' + hold.toFixed(1) + '%,' +
            'rgba(4,10,12,' + (alpha * 0.34).toFixed(3) + ') ' + ((hold + gone) / 2).toFixed(1) + '%,' +
            'rgba(4,10,12,0.04) ' + gone.toFixed(1) + '%,' +
            'rgba(4,10,12,' + cfg.bottomA + ') 100%)';
        } catch (e) { /* the stylesheet's own gradient stands */ }
      }

      note({ fit: plan ? 'moved' : 'as shot', subject: Number(subject.toFixed(3)),
             need: Math.round(need), top: geom.top, band: geom.band,
             zoom: geom.zoom, drop: geom.drop, short: geom.short,
             fill: plan ? (plan.stretch ? 'wall' : plan.blur ? 'blur' : 'none') : 'none',
             scrim: alpha });
    } catch (e) {
      note({ fit: 'failed', why: String((e && e.message) || e) });
    }
  })(),
]);
</script>`;
}

/* -------------------------------------------------------------------------- */
/* node — measuring a photograph before it is ever put on a slide              */
/* -------------------------------------------------------------------------- */

/**
 * How much empty room a photograph has above its subject, 0..1.
 *
 * For the generator's own gate: a shot with no room is a shot the renderer has
 * to bend a picture to save, and the cheapest time to find that out is while
 * the thing that made it is still holding a source photo and a prompt.
 *
 * Runs in the renderer's Chromium, which is the only image decoder here, and
 * shares the browser rather than launching a second one. Returns null when it
 * cannot measure — no browser, an undecodable buffer — and every caller treats
 * null as "no opinion" rather than as a failure, because a measurement that
 * cannot run must never be the reason a paid-for photograph is thrown away.
 */
export async function headroomOf(dataUri) {
  let context = null;
  try {
    const { getBrowser } = await import('./index.js');
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
    const m = await page.evaluate(
      `(${sampleImage.toString()})(${JSON.stringify(dataUri)}, ${JSON.stringify(SAMPLE)})`
    );
    return { subject: subjectTopRow(m.rows), width: m.iw, height: m.ih };
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
    const { scheduleIdleShutdown } = await import('./index.js').catch(() => ({}));
    scheduleIdleShutdown?.();
  }
}

export const __test = { clamp, SCRIM_LUM };
