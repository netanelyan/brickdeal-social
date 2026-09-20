import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { renderHtml, CARD_W, CARD_H } from './templates.js';

// Card rendering: HTML -> JPEG, via headless Chromium.
//
// Chromium is doing the one job nothing else here can do — real bidi text
// layout for Hebrew. Hand-rolling that with a canvas library is how you end up
// with reversed strings and mis-shaped final letters, so the browser does it.
//
// JPEG, not PNG, because Instagram's Content Publishing API only accepts JPEG
// for image posts. Telegram takes either, so one format covers both.

let browserPromise = null;
let idleTimer = null;

// How long a launched Chromium is kept warm after the last render.
//
// The cards for a run come in a burst a few seconds apart, then nothing happens
// for a day. Keeping the browser for the burst avoids paying the ~1.5s launch
// per card; keeping it for the other 23 hours just holds ~200MB resident on a
// VPS that is also running BrickDeal. Five minutes covers a run, including a
// re-render from an edit, with room to spare.
const IDLE_SHUTDOWN_MS = Number(process.env.RENDER_IDLE_MS ?? 5 * 60_000);

// Shared rather than private because the photo measuring in ./photo.js runs in
// the same Chromium: it decodes each slide's image to a canvas and reads the
// pixels back, which is a page and a browser, and launching a second one to do
// it would double the resident memory for no gain.
export function getBrowser() {
  // Chromium takes a second or two to start; a handful of cards a day would
  // otherwise pay that every time. Launched lazily so `npm start` doesn't need it.
  browserPromise ??= chromium.launch({ args: ['--font-render-hinting=none'] });
  return browserPromise;
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!(IDLE_SHUTDOWN_MS > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    closeBrowser().catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  // Do not let a warm browser be the reason the process cannot exit — scripts
  // like render-samples finish and should just end.
  idleTimer.unref?.();
}

export async function closeBrowser() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

/**
 * A candidate id is not automatically a safe filename.
 *
 * Most ids are hex digests, but a source may supply its own `dedupeId` — the
 * climate adapter uses `climate:dubai:2025`, which is meaningful and readable
 * and completely illegal as a Windows filename. That cost two paid drafting
 * calls per run before it was caught, because the render is the *last* step:
 * the money is spent by the time the write fails.
 *
 * Linux would have accepted the colon and hidden the problem, then handed
 * Instagram a URL containing `%3A` to fetch. Restricting the stem to characters
 * that are unambiguous in both a path and a URL settles both cases at once.
 */
export function safeStem(id) {
  const clean = String(id)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return clean || 'card';
}

export const cardOutputDir = () =>
  process.env.CARD_OUTPUT_DIR || path.join(process.cwd(), 'out', 'cards');

/**
 * Public HTTPS URL for a rendered card.
 *
 * Instagram's `POST /{ig-user-id}/media` takes an `image_url` that *Instagram's
 * own servers fetch* — the bytes never travel through our request. So a card
 * that only exists on local disk cannot be published, and this returning null
 * is exactly why publishInstagram() refuses rather than failing halfway.
 */
export function cardPublicUrl(filename) {
  const base = process.env.CARD_PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(filename)}`;
}

/**
 * Render a draft to a JPEG on disk.
 *
 * Returns { file, filename, url, bytes }. `url` is null until
 * CARD_PUBLIC_BASE_URL is set — Telegram publishing works without it.
 */
export async function renderCard(draft, { id, data = null, image = null, outDir = cardOutputDir() } = {}) {
  // Measured before the card is built, because the scrim is part of the
  // stylesheet rather than something that can be adjusted afterwards.
  //
  // Only for the photo layouts: the text-led cards are a flat dark ground by
  // design and have no photograph to measure. Failure is silent and falls back
  // to the old constants — a scrim sized for the worst photograph is what the
  // card had before this existed, and it is not worth losing a card over.
  //
  // Imported here rather than at the top of the file because ./photo.js imports
  // getBrowser from this module: a static import back would close the cycle,
  // and the measuring module is the one that should depend on the renderer
  // rather than the other way round. The module is cached after the first card.
  let shot = image;
  if (image?.src) {
    const scrim = await import('./photo.js')
      .then((m) => m.measureCardScrims([image.src]))
      .then(([s]) => s)
      .catch(() => null);
    if (scrim?.bottom != null) shot = { ...image, scrim };
  }

  return renderToJpeg(renderHtml(draft, { data, image: shot }), {
    stem: id,
    width: CARD_W,
    height: CARD_H,
    outDir,
  });
}

/**
 * Any HTML, at any size, to a JPEG on disk.
 *
 * Extracted from renderCard when slideshows arrived at 1080x1920 and the same
 * deck had to be re-rendered at 1080x1350 for Instagram. The font guard below
 * is the reason this is shared rather than copied: it is the check that stops a
 * card of tofu boxes being published, it is subtle enough to get wrong, and a
 * second renderer without it would fail silently in exactly the way the first
 * one used to.
 */
export async function renderToJpeg(html, { stem, width = CARD_W, height = CARD_H, outDir = cardOutputDir() } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // Explicit, so a VPS with a different system locale can't change how the
    // page lays out or which fallback font Chromium reaches for.
    locale: 'he-IL',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: 'load' });

    // The failure this guards against is silent, which is what makes it worth
    // a hard check: if the bundled font hasn't parsed, Chromium falls back, and
    // for Hebrew on a bare Linux box the fallback is very often tofu boxes.
    // A card full of ▯▯▯ still screenshots perfectly happily.
    //
    // NOTE: `document.fonts.check('900 100px Heebo')` is the obvious way to
    // write this and it does NOT work — it returns true whenever the text can
    // be rendered by *something*, fallback included, so it reports success on a
    // page with no @font-face at all. Verified against a bare page before
    // replacing it. The two checks below test the thing we actually care about:
    // that our own @font-face rule loaded, and that it is what's being drawn.
    await page.evaluate(() => document.fonts.ready);
    const font = await page.evaluate(async () => {
      const face = [...document.fonts].find((f) => f.family.replace(/['"]/g, '') === 'Heebo');

      // Width comparison against a family that cannot exist. If Heebo failed,
      // both spans fall back to the same face and measure identically.
      const measure = (family) => {
        const el = document.createElement('span');
        el.textContent = 'מסלול טיול בחו״ל';
        el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:900 100px ${family}`;
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      };

      return {
        status: face?.status ?? 'missing',
        distinct: Math.abs(measure("'Heebo'") - measure("'__no_such_font__'")) > 0.5,
        // Every OTHER face the page declared, forced to resolve.
        //
        // The check above was written when Heebo carried all the Hebrew and it
        // still earns its place — it proves a font reached the page at all. But
        // the slides now set Hebrew in Assistant and the info style sets it in
        // Rubik, and a face that fails to PARSE falls through to the next
        // family silently: the render succeeds, the text is legible, and it is
        // in the wrong typeface. Four of the bundled files turned out to be
        // corrupt and had never once loaded, which is exactly that failure.
        //
        // load() is what makes this meaningful. @font-face is lazy: a declared
        // face that nothing has drawn with yet sits at "unloaded", which is not
        // an error and must not be treated as one — doing that refused every
        // render outright. Asking for it explicitly resolves the question,
        // after which "error" means the bytes are not a font.
        others: await Promise.all(
          [...document.fonts]
            .filter((f) => f.family.replace(/['"]/g, '') !== 'Heebo')
            .map(async (f) => {
              try {
                await f.load();
              } catch {
                /* status carries the answer */
              }
              return { family: f.family.replace(/['"]/g, ''), status: f.status };
            })
        ),
      };
    });

    if (font.status !== 'loaded' || !font.distinct) {
      throw new Error(
        `Heebo did not load (@font-face status: ${font.status}, distinct from fallback: ${font.distinct}) — ` +
          'refusing to render, because the Hebrew would come out as tofu boxes'
      );
    }

    const broken = font.others.filter((f) => f.status === 'error');
    if (broken.length) {
      throw new Error(
        `these faces are not valid fonts: ${broken.map((f) => f.family).join(', ')} — ` +
          'refusing to render, because the text would silently come out in a fallback typeface'
      );
    }

    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });

    mkdirSync(outDir, { recursive: true });
    const filename = `${safeStem(stem)}.jpg`;
    const file = path.join(outDir, filename);
    // Atomic, same as the store: Instagram may fetch this URL moments after we
    // hand it over, and a half-written JPEG would be served as a broken image.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, file);

    return { file, filename, url: cardPublicUrl(filename), bytes: buf.length };
  } finally {
    await context.close().catch(() => {});
    scheduleIdleShutdown();
  }
}
