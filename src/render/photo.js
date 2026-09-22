import { getBrowser } from './index.js';

// Where the words go, and what colour they are — decided by looking at the
// pixels rather than by asking a model.
//
// The previous version asked the vision call which third of the picture was
// "emptiest" and got back a word: top, middle, bottom. Three answers for a
// photograph, and the text was then centred inside whichever third it named.
// That is how a title ended up across the middle of a garden, and how white
// type ended up on a white sky.
//
// A model is the right tool for "is this the Eiger" and the wrong tool for
// "what is the mean luminance of the region the text will occupy". The second
// question has an exact answer, it is free, and it is the one that decides
// whether the slide is legible. So the photograph is drawn to a small canvas in
// the renderer's own Chromium and measured.
//
// What comes back is not a band but a position: the centre of the text block as
// a fraction of the frame, the colour to set it in, and how much help it needs
// from a scrim. The renderer applies that literally.

// The sampling grid. 45x80 keeps the 9:16 of the frame, which matters because
// every measurement below is taken in frame coordinates rather than image ones
// — the photograph is cover-cropped on the way in, exactly as CSS will crop it,
// so a region that measures empty here is empty in the render.
//
// Deliberately coarse. At this size a cell is ~24 real pixels, which is the
// scale legibility actually operates at: a lawn full of fine texture averages
// to a calm green, and that is correct, because type sits on it perfectly well.
// Sampling finer makes grass look as busy as a skyline.
const GW = 45;
const GH = 80;

/** sRGB -> relative luminance, the same curve WCAG contrast is defined on. */
const CONTRAST_WHITE = (l) => 1.05 / (l + 0.05);
const CONTRAST_BLACK = (l) => (l + 0.05) / 0.05;

// TikTok's own furniture, in frame fractions. The button rail down the right
// and the caption across the bottom are drawn by the app over our image, and
// text underneath them is text nobody reads. The top bar and the bottom caption
// are already handled by topSafe/bottomSafe; this is the rail, which is the one
// that has no equivalent on Instagram and so cannot be a constant in SIZES.
const RAIL = { x0: 0.76, x1: 1.0, y0: 0.42, y1: 0.86 };

/**
 * Measure several photographs at once.
 *
 * One page for the whole deck rather than one per slide: the work per image is
 * a decode and a 3,600-pixel read, and the page setup costs more than both.
 */
async function sampleGrids(sources, { gw = GW, gh = GH } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
  const page = await context.newPage();
  try {
    await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
    return await page.evaluate(
      async ({ srcs, gw, gh }) => {
        const lin = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
        const out = [];

        for (const src of srcs) {
          if (!src) {
            out.push(null);
            continue;
          }
          const img = new Image();
          img.src = src;
          try {
            await img.decode();
          } catch {
            out.push(null);
            continue;
          }

          // The same crop CSS will apply. object-fit: cover keeps the centre
          // and throws away the overflowing axis, so measuring the whole image
          // would measure pixels the viewer never sees.
          const iw = img.naturalWidth;
          const ih = img.naturalHeight;
          const want = gw / gh;
          const have = iw / ih;
          const sw = have > want ? ih * want : iw;
          const sh = have > want ? ih : iw / want;
          const sx = (iw - sw) / 2;
          const sy = (ih - sh) / 2;

          const canvas = new OffscreenCanvas(gw, gh);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, gw, gh);
          const data = ctx.getImageData(0, 0, gw, gh).data;

          const lum = new Array(gw * gh);
          const sat = new Array(gw * gh);
          const hue = new Array(gw * gh);
          for (let i = 0; i < gw * gh; i++) {
            const r = data[i * 4] / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;
            lum[i] = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            sat[i] = mx === 0 ? 0 : (mx - mn) / mx;
            if (mx === mn) {
              hue[i] = 0;
            } else {
              const d = mx - mn;
              let h;
              if (mx === r) h = ((g - b) / d) % 6;
              else if (mx === g) h = (b - r) / d + 2;
              else h = (r - g) / d + 4;
              hue[i] = (h * 60 + 360) % 360;
            }
          }
          // A small JPEG alongside the numbers. The page has already decoded
          // the image, so producing it here costs almost nothing, and it saves
          // sending a 1080x1920 frame to a vision call that only needs to see
          // where the sky is.
          let thumb = null;
          try {
            const tw = 320;
            const th = Math.round((tw * gh) / gw);
            const tc = new OffscreenCanvas(tw, th);
            tc.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);
            const blob = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
            const buf = new Uint8Array(await blob.arrayBuffer());
            let bin = '';
            for (const byte of buf) bin += String.fromCharCode(byte);
            thumb = btoa(bin);
          } catch {
            /* the numbers are what matter; the thumbnail is an optimisation */
          }

          out.push({ lum, sat, hue, thumb });
        }
        return out;
      },
      { srcs: sources, gw, gh }
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/** Mean, spread and texture of one rectangle of the grid, in cell coordinates. */
function region(grid, x0, y0, x1, y1) {
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(GW, Math.ceil(x1));
  const cy1 = Math.min(GH, Math.ceil(y1));
  if (cx1 <= cx0 || cy1 <= cy0) return null;

  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let satSum = 0;
  // Texture, measured as the mean step between neighbouring cells. Spread alone
  // cannot tell a smooth gradient from a chequerboard, and the difference
  // between those two is the whole question: type reads beautifully on a
  // gradient and not at all on a chequerboard.
  let edge = 0;
  let edgeN = 0;

  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const i = y * GW + x;
      const l = grid.lum[i];
      sum += l;
      sumSq += l * l;
      satSum += grid.sat[i];
      n++;
      if (x + 1 < cx1) {
        edge += Math.abs(grid.lum[i + 1] - l);
        edgeN++;
      }
      if (y + 1 < cy1) {
        edge += Math.abs(grid.lum[i + GW] - l);
        edgeN++;
      }
    }
  }

  // The darkest and brightest BANDS of the box, not the darkest and brightest
  // cells. A single stray pixel is not what defeats a line of text; a whole
  // strip of it is, and a strip is what a ridge crossing the lower half of the
  // block looks like.
  //
  // This is here because the mean is a liar for exactly the case that keeps
  // going wrong. A cover spanning bright sky at the top and dark rock at the
  // bottom averages to a comfortable mid-tone, gets set in near-black on the
  // strength of that average, and its last line vanishes into the mountain.
  let lo = 1;
  let hi = 0;
  for (let y = cy0; y < cy1; y++) {
    let rowSum = 0;
    let rowN = 0;
    for (let x = cx0; x < cx1; x++) {
      rowSum += grid.lum[y * GW + x];
      rowN++;
    }
    const rowMean = rowSum / rowN;
    if (rowMean < lo) lo = rowMean;
    if (rowMean > hi) hi = rowMean;
  }

  const mean = sum / n;
  return {
    mean,
    lo,
    hi,
    sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    sat: satSum / n,
    edge: edgeN ? edge / edgeN : 0,
  };
}

/**
 * Which cells are BACKGROUND — sky, cloud, open water — rather than subject.
 *
 * This exists because "smooth" and "background" are not the same thing, and
 * the difference is what put a place name across a mountain instead of in the
 * sky beside it. Measured on a real frame, the shaded rock face of the Eiger
 * scored CALMER than the sky above it: texture 0.018 against 0.024, because
 * wispy cloud has more local variation than uniform rock in shadow. Every
 * tuning of the texture weights makes that worse, not better — the scorer was
 * answering the wrong question.
 *
 * What separates sky from a mountain is not how smooth it is, it is that sky
 * runs off the top of the frame and water runs off the bottom. A subject is
 * enclosed; a background is not. So: find the smooth cells, group the ones that
 * touch each other, and keep the groups that reach an edge and are big enough
 * to matter.
 *
 * Returns a mask of 0/1 per cell, or null when nothing qualifies — which is a
 * real answer for a close-up of a facade, and the caller falls back to the
 * calmest region it can find plus the wash.
 */
function backgroundMask(grid) {
  const n = GW * GH;
  const B = 3;
  const bw = Math.ceil(GW / B);
  const bh = Math.ceil(GH / B);

  // Per-block colour and flatness. Blocks rather than cells because sky is not
  // locally flat — cloud and haze wander — it is flat over a LARGE area, while
  // rock is the reverse: calm between any two adjacent cells and wildly
  // different a little further on.
  const lum = new Float32Array(bw * bh);
  const sat = new Float32Array(bw * bh);
  const hx = new Float32Array(bw * bh);
  const hy = new Float32Array(bw * bh);
  const spread = new Float32Array(bw * bh);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let sumSq = 0;
      let satSum = 0;
      let cx = 0;
      let cy = 0;
      let c = 0;
      for (let y = by * B; y < Math.min(GH, by * B + B); y++) {
        for (let x = bx * B; x < Math.min(GW, bx * B + B); x++) {
          const i = y * GW + x;
          const l = grid.lum[i];
          sum += l;
          sumSq += l * l;
          satSum += grid.sat[i];
          const rad = (grid.hue[i] * Math.PI) / 180;
          cx += Math.cos(rad) * grid.sat[i];
          cy += Math.sin(rad) * grid.sat[i];
          c++;
        }
      }
      const b = by * bw + bx;
      const mean = sum / c;
      lum[b] = mean;
      sat[b] = satSum / c;
      hx[b] = cx / c;
      hy[b] = cy / c;
      spread[b] = Math.sqrt(Math.max(0, sumSq / c - mean * mean));
    }
  }

  const sorted = Float32Array.from(spread).sort();
  const flatCut = Math.max(0.045, sorted[Math.floor(sorted.length * 0.35)]);

  // Grown from the frame edge, not thresholded globally.
  //
  // Flatness alone cannot tell a white snowfield from white cloud — three
  // successive tunings proved that, each failing in a different direction. What
  // does separate them is CONTINUITY: sky is the thing that runs off the top of
  // the frame and stays the same colour all the way, and water runs off the
  // bottom the same way. A subject is enclosed.
  //
  // So the region is grown from the edge blocks, and a neighbour joins only if
  // it is flat AND close in tone to what has been collected so far. That
  // predicate is what stops a blue sky leaking down into the snowfield it
  // happens to touch — which is precisely how an earlier version came back
  // claiming seventy percent of a photograph of the Eiger was background.
  const grow = (seeds) => {
    const inRegion = new Uint8Array(bw * bh);
    const queue = [];
    let sumL = 0;
    let sumHx = 0;
    let sumHy = 0;
    let count = 0;

    for (const b of seeds) {
      if (spread[b] > flatCut || inRegion[b]) continue;
      inRegion[b] = 1;
      queue.push(b);
      sumL += lum[b];
      sumHx += hx[b];
      sumHy += hy[b];
      count++;
    }
    if (!count) return null;

    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % bw;
      const y = (i - x) / bw;
      const meanL = sumL / count;
      const meanHx = sumHx / count;
      const meanHy = sumHy / count;

      const consider = (j, ok) => {
        if (!ok || inRegion[j] || spread[j] > flatCut) return;
        // Tone has to match what the region already is. The luminance test does
        // most of the work; the hue test catches the case where a pale sky and
        // a pale rock face happen to sit at the same brightness.
        if (Math.abs(lum[j] - meanL) > 0.16) return;
        const dot = hx[j] * meanHx + hy[j] * meanHy;
        const mag = Math.hypot(hx[j], hy[j]) * Math.hypot(meanHx, meanHy);
        // Only meaningful when both are actually coloured; near-grey blocks
        // have no reliable hue and are judged on luminance alone.
        if (mag > 0.02 && dot / mag < 0.55) return;
        inRegion[j] = 1;
        queue.push(j);
        sumL += lum[j];
        sumHx += hx[j];
        sumHy += hy[j];
        count++;
      };
      consider(i - 1, x > 0);
      consider(i + 1, x < bw - 1);
      consider(i - bw, y > 0);
      consider(i + bw, y < bh - 1);
    }

    return count >= bw * bh * 0.05 ? inRegion : null;
  };

  const topSeeds = Array.from({ length: bw }, (_, x) => x);
  const bottomSeeds = Array.from({ length: bw }, (_, x) => (bh - 1) * bw + x);
  const sky = grow(topSeeds);
  const water = grow(bottomSeeds);
  if (!sky && !water) return null;

  const mask = new Uint8Array(n);
  for (let b = 0; b < bw * bh; b++) {
    if (!(sky?.[b] || water?.[b])) continue;
    const bx = b % bw;
    const by = (b - bx) / bw;
    for (let y = by * B; y < Math.min(GH, by * B + B); y++) {
      for (let x = bx * B; x < Math.min(GW, bx * B + B); x++) mask[y * GW + x] = 1;
    }
  }
  return mask;
}

/**
 * A mask from an explicit rectangle, in frame fractions.
 *
 * Used when the background region was identified by something other than the
 * pixel heuristic — see the note on backgroundMask about why that is the normal
 * case rather than the exception.
 */
function maskFromBox(box) {
  if (!box) return null;
  // Checked in frame fractions BEFORE rounding to cells. A zero-width
  // rectangle rounds outward to one cell and would otherwise come back as a
  // sliver of a mask that nothing can be placed inside — a confident-looking
  // answer to a question that was not answered.
  if (!(box.x1 - box.x0 > 0) || !(box.y1 - box.y0 > 0)) return null;
  const mask = new Uint8Array(GW * GH);
  const x0 = Math.max(0, Math.floor(box.x0 * GW));
  const x1 = Math.min(GW, Math.ceil(box.x1 * GW));
  const y0 = Math.max(0, Math.floor(box.y0 * GH));
  const y1 = Math.min(GH, Math.ceil(box.y1 * GH));
  if (x1 <= x0 || y1 <= y0) return null;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * GW + x] = 1;
  return mask;
}

/** How much of a box lies on background, 0..1. */
function coverage(mask, x0, y0, x1, y1) {
  if (!mask) return 0;
  let inside = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(GH, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(GW, Math.ceil(x1)); x++) {
      total++;
      inside += mask[y * GW + x];
    }
  }
  return total ? inside / total : 0;
}

/** Saturation-weighted circular mean of hue — the photograph's own colour. */
function dominantHue(grid, x0, y0, x1, y1) {
  let sx = 0;
  let sy = 0;
  let w = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(GH, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(GW, Math.ceil(x1)); x++) {
      const i = y * GW + x;
      const weight = grid.sat[i] * grid.sat[i];
      const rad = (grid.hue[i] * Math.PI) / 180;
      sx += Math.cos(rad) * weight;
      sy += Math.sin(rad) * weight;
      w += weight;
    }
  }
  if (w < 0.0001) return null;
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

/** How much of a box lies under TikTok's button rail, as a fraction of the box. */
function railOverlap(cx, cy, bw, bh) {
  const x0 = Math.max(cx - bw / 2, RAIL.x0);
  const x1 = Math.min(cx + bw / 2, RAIL.x1);
  const y0 = Math.max(cy - bh / 2, RAIL.y0);
  const y1 = Math.min(cy + bh / 2, RAIL.y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  return ((x1 - x0) * (y1 - y0)) / (bw * bh);
}

/**
 * Choose where one block of text goes on one photograph, and what colour it is.
 *
 * `blockH` is how tall the text will be as a fraction of the frame; a name on
 * its own and a name over four field lines want different amounts of quiet, and
 * searching with the wrong height finds a gap the text does not fit in.
 */
/**
 * Contrast between a region and the ink that will actually sit on it.
 *
 * `inkLum` null means the ink adapts — the minimal style picks white or
 * near-black per slide, so the region is scored on whichever it would pick. A
 * number means the ink is fixed, which is the info style: it is cream on every
 * slide by design, and cream has a relative luminance of about 0.77, so it
 * needs a DARK region and gains nothing from a bright one.
 *
 * Scoring the info style as though it could go near-black is what put a cream
 * line across a sunlit snowfield with clean blue sky directly above it.
 */
function inkContrast(mean, inkLum) {
  if (inkLum === null || inkLum === undefined) {
    return Math.max(CONTRAST_WHITE(mean), CONTRAST_BLACK(mean));
  }
  const a = inkLum + 0.05;
  const b = mean + 0.05;
  return a > b ? a / b : b / a;
}

function place(grid, { topSafe, bottomSafe, blockH, blockW = 0.46, rail = true, inkLum = null, mask = null, hint = null, confine = null }) {
  const boxes = [];
  // Three columns, each already inside the frame's margin.
  //
  // The centres used to be 0.3 and 0.7 with a 0.56 width, which put the edge of
  // a side box at 0.02 — two percent of the frame — and the first renders had
  // Hebrew running off the left edge of the picture. A block of text needs air
  // around it more than it needs width, so the boxes are narrower and pulled in.
  // Never narrower than the text needs.
  //
  // A cover set in a 0.36-wide column is four words stacked one per line, which
  // is what "the arrangement is not harmonic" describes: three short lines and
  // one long one, ragged down the left. The width a block needs is a property
  // of the text, so it comes in as blockW and nothing below may go under it.
  const wide = (bw) => Math.max(blockW, bw);
  const columns = confine
    ? // One column, where the design says the words go.
      //
      // The free sweep below is the right search for "put this wherever the
      // photograph is quietest" and the wrong one for "put this in the
      // upper-left or lower-left third" — given three columns and thirteen
      // rows it will find dead centre whenever the middle of the frame happens
      // to be sky, which on a landscape is most of the time.
      //
      // What the measurement is still for, and it is most of what it was for:
      // WHICH of the two allowed bands this particular photograph can carry,
      // what colour the type has to be there, and how much help it needs. That
      // is the part a person cannot do by eye for six slides a day.
      [{ side: confine.x < 0.42 ? 'left' : confine.x > 0.58 ? 'right' : 'center', cx: confine.x, bw: wide(confine.width) }]
    : [
        { side: 'right', cx: 0.66, bw: wide(0.52) },
        { side: 'center', cx: 0.5, bw: wide(0.76) },
        { side: 'left', cx: 0.34, bw: wide(0.52) },
      ];

  const yMin = topSafe + blockH / 2;
  const yMax = 1 - bottomSafe - blockH / 2;
  if (yMax <= yMin) return null;

  // The allowed rows, when the caller confined the search.
  //
  // Each band is sampled rather than taken as a single y, so a band that is
  // half sky and half ridge can still be entered at the sky end. Clamped into
  // the safe range rather than intersected with it: a band that falls entirely
  // inside the app's own furniture would otherwise contribute no candidates at
  // all, and the slide would come back unplaced.
  const bandRows = (band) => {
    const lo = Math.max(yMin, Math.min(yMax, band[0] + blockH / 2));
    const hi = Math.max(yMin, Math.min(yMax, band[1] - blockH / 2));
    const n = 5;
    if (!(hi > lo)) return [lo];
    return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1));
  };
  const confinedYs = confine ? confine.bands.flatMap(bandRows) : null;

  // Candidates aimed AT the hinted region, not just the standing grid.
  //
  // The three fixed columns are a reasonable sweep of a whole frame and a poor
  // way to search a particular rectangle: when the background was a narrow band
  // of sky off to one side, no column fell inside it and the winning box scored
  // zero coverage — the hint was obtained and then effectively ignored. These
  // are centred on the region that was actually identified.
  // Skipped entirely when the search is confined. The hint's whole purpose is
  // to aim candidates at wherever the sky actually is, which is precisely the
  // freedom being withdrawn — and a hint candidate carries its own cx, so it
  // would walk straight out of the allowed column.
  if (hint && !confine) {
    // Widened to what the text needs even when the hinted region is narrower.
    // The box then spills past the region, its coverage drops, and the scorer
    // prefers a wider patch of background elsewhere — which is the right answer
    // rather than squeezing the words into a column.
    const hw = Math.max(blockW, Math.min(0.8, (hint.x1 - hint.x0) * 0.92));
    const hcx = Math.min(1 - hw / 2 - 0.06, Math.max(hw / 2 + 0.06, (hint.x0 + hint.x1) / 2));
    const lo = Math.max(yMin, hint.y0 + blockH / 2);
    const hi = Math.min(yMax, hint.y1 - blockH / 2);
    if (hi >= lo) {
      const n = 7;
      for (let k = 0; k < n; k++) {
        const cy = n === 1 ? lo : lo + ((hi - lo) * k) / (n - 1);
        columns.push({ side: hcx < 0.42 ? 'left' : hcx > 0.58 ? 'right' : 'center', cx: hcx, bw: hw, cy });
      }
    }
  }

  const STEPS = 13;
  for (const col of columns) {
    // A column carrying its own cy is a hint candidate and is placed exactly
    // there; the standing columns are swept down the frame as before.
    const ys =
      col.cy !== undefined
        ? [col.cy]
        : confinedYs || Array.from({ length: STEPS }, (_, s) => yMin + ((yMax - yMin) * s) / (STEPS - 1));
    for (const cy of ys) {
      const stats = region(
        grid,
        (col.cx - col.bw / 2) * GW,
        (cy - blockH / 2) * GH,
        (col.cx + col.bw / 2) * GW,
        (cy + blockH / 2) * GH
      );
      if (!stats) continue;

      // Quiet. Texture is weighted above spread: a box straddling a bright sky
      // and a dark ridge has a huge spread and is still perfectly legible,
      // whereas a box of foliage has a modest spread and is hopeless.
      const busy = Math.min(1, stats.sd * 1.5 + stats.edge * 9);

      // Legibility, capped: past about 7:1 more contrast buys nothing, and
      // without the cap every box in a black sky beats every good box.
      // Worst-band contrast, for the same reason colourFor uses it: a box whose
      // average is comfortable but whose lower half is a ridge is not a good
      // box, and ranking it on the average is how one got chosen.
      const worst =
        inkLum === null
          ? Math.max(CONTRAST_WHITE(stats.hi ?? stats.mean), CONTRAST_BLACK(stats.lo ?? stats.mean))
          : Math.min(inkContrast(stats.lo ?? stats.mean, inkLum), inkContrast(stats.hi ?? stats.mean, inkLum));
      const legible = Math.min(1, worst / 7);

      // How much of the box is on background rather than on the subject. This
      // dominates everything else, because it is the thing being asked for: the
      // words go in the sky or on the water, and never across the mountain, the
      // temple or the village — even when the mountain happens to measure
      // calmer, which it frequently does.
      const onBackground = coverage(
        mask,
        (col.cx - col.bw / 2) * GW,
        (cy - blockH / 2) * GH,
        (col.cx + col.bw / 2) * GW,
        (cy + blockH / 2) * GH
      );

      // A box that is mostly-but-not-entirely on background is worse than the
      // fraction suggests: the tail of a word crossing onto a ridge is exactly
      // the thing that reads as careless. Squaring punishes partial overlap
      // without forbidding it outright.
      const clear = onBackground * onBackground;

      const penalty = rail ? railOverlap(col.cx, cy, col.bw, blockH) * 0.85 : 0;

      // No centring prior any more. It was worth a tenth and it pulled text
      // toward the middle of the frame, which is precisely where the subject
      // usually is — it was quietly arguing against the rule above it.
      boxes.push({
        side: col.side,
        cx: col.cx,
        cy,
        bw: col.bw,
        stats,
        busy,
        legible,
        penalty,
        onBackground,
        score: mask ? clear * 0.62 + (1 - busy) * 0.2 + legible * 0.18 - penalty : (1 - busy) * 0.6 + legible * 0.4 - penalty,
      });
    }
  }

  if (!boxes.length) return null;
  boxes.sort((a, b) => b.score - a.score);

  // When nothing could be placed on background at all — a frame filled edge to
  // edge, or a sky that lies entirely inside the app's own safe margin — the
  // coverage term is zero everywhere and ranks nothing. Re-rank on the measures
  // that still mean something, and let the caller know the words are going on
  // the subject so the wash can come in behind them.
  if (mask && (boxes[0].onBackground ?? 0) < 0.15) {
    boxes.sort((a, b) => (1 - b.busy) * 0.6 + b.legible * 0.4 - b.penalty - ((1 - a.busy) * 0.6 + a.legible * 0.4 - a.penalty));
    boxes[0].strandedOnSubject = true;
  }
  return boxes[0];
}

/**
 * The colour for text sitting on a measured region.
 *
 * White or near-black, decided by which one the background can actually carry —
 * this is the "check the image colour and use black or white appropriately"
 * rule, made arithmetic. The accent is offered separately: a pale tint of the
 * photograph's own hue, which is what both reference accounts reach for on a
 * cover, and which only works over a dark frame.
 */
function colourFor(stats, hue, inkLum = null) {
  // White until the background is genuinely pale, rather than whichever of
  // white and black wins the contrast arithmetic.
  //
  // Strict contrast puts dark type on anything above about 0.22 luminance,
  // which is most skies — and near-black lettering on a mid grey-blue sky is
  // both legible and wrong: it reads as a watermark, and it is nothing any
  // reference post does. The references keep light type until the frame is
  // actually bright, and make up the difference with a heavier shadow. So the
  // threshold sits high and `shadow` below carries the rest.
  // Judged on the WORST band of the block, not on its average.
  //
  // White type has to survive the brightest strip it crosses and dark type the
  // darkest; a block that spans both is the case where the average says
  // "comfortable" and one line of the title disappears into a mountain. Picking
  // by worst case means the colour that wins is the one that works everywhere
  // in the block, and when neither does, the number that says so is honest and
  // the wash comes in.
  const lo = stats.lo ?? stats.mean;
  const hi = stats.hi ?? stats.mean;
  const whiteWorst = CONTRAST_WHITE(hi);
  const blackWorst = CONTRAST_BLACK(lo);
  // White until the frame is genuinely pale, as before — the references keep
  // light type well past the point where the arithmetic would flip, and
  // near-black on a mid grey-blue sky reads as a watermark. Past that point the
  // worst band decides, which is what stops a title being half-legible.
  const onDark = hi < 0.5 ? true : whiteWorst >= blackWorst;

  // Not pure black. A true #000 over a photograph reads as a hole punched in
  // it; the reference slides that use dark type use something just off it.
  const color = onDark ? '#FFFFFF' : '#14110E';

  // Measured against the ink that will actually be used. For the info style
  // that is cream on every slide, so the shadow and the wash below have to be
  // sized for cream — not for whichever of white and black the minimal style
  // would have chosen here.
  const contrast =
    inkLum === null
      ? onDark
        ? whiteWorst
        : blackWorst
      : Math.min(inkContrast(lo, inkLum), inkContrast(hi, inkLum));

  // How hard the shadow behind the type has to work, 0 to 1. This is the first
  // line of defence and it is invisible: a deeper, tighter shadow under white
  // type on a mid-tone sky, which is what the reference posts do.
  const shadow = Math.max(0, Math.min(1, (5 - contrast) / 3.4));

  // The wash comes in below about 3.8:1 rather than below 2.6:1.
  //
  // The old threshold was set when contrast was measured on the block's AVERAGE,
  // where 2.6 was a sensible floor. Measured on the worst band it crosses, a
  // block straddling bright sky and dark rock reports around 3.4 — legible in
  // the abstract, and in practice the line that lands on the rock is the one
  // that disappears. That case has to get help, and a well-placed block sits at
  // 7:1 or better and still gets none.
  const assist = Math.max(0, Math.min(1, (3.8 - contrast) / 2.2));

  // The accent is warm, and it is warm on purpose.
  //
  // Tinting it with the photograph's OWN hue was the obvious idea and it is
  // wrong: the text sits on that hue, so a pale version of it is camouflage. A
  // cover over a blue sky came back in pale blue and read as plain white. What
  // the reference accounts actually do is put a warm colour on a cool picture —
  // butter yellow on a green hillside, pink on a green-and-purple aurora — and
  // the warmth is what separates it from everything behind it.
  //
  // So cream by default, and rose for the one case cream cannot survive: a
  // photograph that is itself yellow, which is most golden-hour frames.
  const yellowish = hue !== null && hue > 20 && hue < 75 && stats.sat > 0.3;
  const accent = onDark ? (yellowish ? 'hsl(344, 72%, 86%)' : '#F7E3A1') : null;

  return { color, onDark, accent, assist, shadow, contrast };
}

/**
 * Analyse every photograph in a deck for one output size.
 *
 * Returns one entry per input, in order, each either null (no photograph, or it
 * would not decode) or a placement the renderer can apply without interpreting
 * anything further.
 */
export async function analyseSlides(items, { topSafe, bottomSafe, height, inkLum = null, regionHint = null, confine = null }) {
  const grids = await sampleGrids(items.map((it) => it.src || null));
  const top = topSafe / height;
  const bottom = bottomSafe / height;

  // Where the background is, asked for once per slide when a hint source is
  // supplied. Sequential rather than parallel: it is one cheap call per slide
  // and the deck is seven slides, so the concurrency is not worth the burst.
  // Not asked for at all when the placement is confined: the answer decides
  // where to aim, there is nowhere left to aim, and it is a model call per
  // slide. Six slides a deck, every deck.
  const hints = [];
  for (const [i, grid] of grids.entries()) {
    if (!grid || !regionHint || confine) {
      hints.push(null);
      continue;
    }
    hints.push(await regionHint(grid.thumb, items[i], i).catch(() => null));
  }

  const out = [];
  for (const [i, grid] of grids.entries()) {
    if (!grid) {
      out.push(null);
      continue;
    }
    const blockH = items[i].blockH ?? 0.12;
    // The hint wins when there is one; the pixel heuristic is the fallback.
    const mask = maskFromBox(hints[i]) || backgroundMask(grid);
    const hintBox = hints[i] || null;
    const spot = place(grid, {
      topSafe: top,
      bottomSafe: bottom,
      blockH,
      blockW: items[i].blockW ?? 0.46,
      rail: items[i].rail !== false,
      inkLum,
      mask,
      hint: hintBox,
      confine,
    });
    if (!spot) {
      out.push(null);
      continue;
    }

    const hue = dominantHue(
      grid,
      (spot.cx - spot.bw / 2) * GW,
      (spot.cy - blockH / 2) * GH,
      (spot.cx + spot.bw / 2) * GW,
      (spot.cy + blockH / 2) * GH
    );
    const paint = colourFor(spot.stats, hue, inkLum);

    // Contrast is not the only way a photograph defeats type.
    //
    // colourFor works from mean luminance, which says nothing about texture —
    // and a region can measure a comfortable 8:1 while being a field of dark
    // branches with bright sky between them, where every letter crosses four
    // edges. That is the "cannot see the text" case that survived the contrast
    // fix. Where the whole frame is busy and there was nowhere quiet to go, the
    // wash comes in on busyness instead, and takes whichever of the two reasons
    // is asking for more.
    const fromBusy = Math.max(0, Math.min(1, (spot.busy - 0.45) / 0.35));
    // Stranded on the subject because the frame offered nowhere else. This is
    // the agreed fallback: take the calmest spot available and fade a wash in
    // behind the words so the slide still ships legibly.
    const stranded = spot.strandedOnSubject ? 0.45 : 0;
    const assist = Math.max(paint.assist, fromBusy, stranded);

    out.push({
      side: spot.side,
      x: spot.cx,
      y: spot.cy,
      width: spot.bw,
      ...paint,
      assist,
      // Kept for the approval message and for judging a run afterwards: "the
      // text is in the wrong place" is much easier to act on when the numbers
      // that put it there are recorded.
      lum: Number(spot.stats.mean.toFixed(3)),
      busy: Number(spot.busy.toFixed(3)),
      sat: Number(spot.stats.sat.toFixed(3)),
      // How much of the block landed on sky or water. Reported so a slide that
      // looks wrong can be argued about with the number that placed it, and so
      // the caller knows when the pixels gave up and a vision call is worth it.
      onBackground: Number((spot.onBackground ?? 0).toFixed(3)),
      hasBackground: Boolean(mask),
      viaHint: Boolean(hints[i]),
      strandedOnSubject: Boolean(spot.strandedOnSubject),
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Scrims, sized to the photograph rather than to the worst photograph         */
/* -------------------------------------------------------------------------- */

// The Instagram card's scrim colour, #10201F, as relative luminance.
//
// Precomputed because it is a constant of the design rather than of the
// photograph, and because the arithmetic below runs per band per card.
const SCRIM_LUM = 0.0124;

/** The grid a 4:5 card is measured on, keeping the card's own aspect. */
const CARD_GW = 48;
const CARD_GH = 60;

const toSrgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const toLinear = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));

/**
 * What a band of this luminance measures once the scrim is over it.
 *
 * Composited in sRGB, because that is where the browser does it — averaging the
 * linear luminances instead reports a scrim as darker than it renders, which
 * would size every scrim too light. The band's colour is collapsed to a grey of
 * the same luminance first; that is an approximation, and an acceptable one at
 * a grid this coarse, because what is being decided is whether white type
 * clears a contrast threshold rather than what the pixel is.
 */
export const underScrim = (lum, alpha, scrimLum = SCRIM_LUM) =>
  toLinear(toSrgb(lum) * (1 - alpha) + toSrgb(scrimLum) * alpha);

/**
 * The lightest scrim this band can take and still carry white type.
 *
 * Searched rather than solved. The compositing above is not invertible in one
 * line once the sRGB transfer curve is in it, the answer is wanted to two
 * decimal places, and a hundred iterations of three multiplications is free.
 *
 * `floor` is not a legibility number — it is the separation that makes the
 * headline read as a deliberate block of type rather than as words that
 * happened to land on a dark part of the picture. Without it an already-dark
 * photograph gets no scrim at all, which is legible and looks like an accident.
 */
export function scrimAlpha(lum, { want = 8, floor = 0, ceiling = 0.97 } = {}) {
  for (let a = Math.max(0, floor); a <= ceiling; a += 0.01) {
    if (CONTRAST_WHITE(underScrim(lum, a)) >= want) return Math.round(a * 100) / 100;
  }
  return ceiling;
}

/**
 * How dark each of a card's two scrims has to be, measured off its photograph.
 *
 * The scrims used to be constants — 0.97 at the foot of the frame and 0.72
 * across the top — and constants have to be sized for the worst photograph
 * there is, which is a white sky. Over a photograph that is already dark, the
 * same numbers paint near-black over near-black: the bottom half of the picture
 * stops existing and the card reads as murky rather than as moody. That is the
 * "sometimes a bit too dark", and "sometimes" is the tell — it is a property of
 * the photograph, so it has to be measured off the photograph.
 *
 * Judged on the BRIGHTEST row of each band, not the mean, for the same reason
 * the placement scorer is: a band that is dark except for one bright strip
 * averages to comfortable and loses the line of text that lands on the strip.
 *
 * Returns nulls when there is nothing to measure, and the caller then falls
 * back to the constants — a card that cannot be measured is exactly the case
 * the worst-photograph numbers were written for.
 */
export async function measureCardScrims(sources) {
  const grids = await sampleGrids(sources, { gw: CARD_GW, gh: CARD_GH }).catch(() => []);

  // Where each scrim actually has to work, as fractions of the card's height.
  // The bottom scrim is 52% tall but its opaque end is the foot of the frame,
  // which is where the headline sits; the top one only has to lift the brand
  // mark off the sky.
  const BANDS = { bottom: [0.58, 1.0], top: [0.0, 0.18] };

  return sources.map((_, i) => {
    const grid = grids[i];
    if (!grid) return { top: null, bottom: null };

    const brightestRow = ([y0, y1]) => {
      let worst = 0;
      for (let y = Math.floor(y0 * CARD_GH); y < Math.ceil(y1 * CARD_GH); y++) {
        let sum = 0;
        for (let x = 0; x < CARD_GW; x++) sum += grid.lum[y * CARD_GW + x];
        worst = Math.max(worst, sum / CARD_GW);
      }
      return worst;
    };

    return {
      // The headline is set at 60px and heavier, so it clears its threshold
      // well before the subhead beneath it does; the subhead is what `want`
      // is sized for.
      bottom: scrimAlpha(brightestRow(BANDS.bottom), { want: 8, floor: 0.34 }),
      // Only a wordmark and a place name, both small but both short — a lighter
      // target, and a much lower floor, because there is no block of type here
      // that needs to read as a block.
      top: scrimAlpha(brightestRow(BANDS.top), { want: 6, floor: 0.12, ceiling: 0.72 }),
    };
  });
}

// sampleGrids is exported for calibration rather than for use: when a placement
// looks wrong the only way to find out why is to read the numbers the scorer
// read, region by region, and compare the box it chose against the box a person
// would have chosen. Guessing at those numbers is how a scoring bug survives.
export const __test = { place, colourFor, region, railOverlap, sampleGrids, inkContrast, backgroundMask, maskFromBox, coverage, GW, GH };
