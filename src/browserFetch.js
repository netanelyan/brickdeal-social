import { chromium } from 'playwright';

// A second way to fetch a source page: a real browser, for sources that answer
// a plain fetch with 403.
//
// This is NOT impersonation, and the distinction is the whole reason it is
// allowed here. fetchPage.js deliberately sends an honest agent string with a
// contact URL rather than a pinned Chrome string, because a bot claiming to be
// Chrome is both untrue and the thing operators eventually block. Reaching for
// Playwright does not walk that back: it stops claiming to be a browser and
// starts being one. The agent string below still says who we are.
//
// It exists because UNESCO's article pages return 403 to a plain fetch while
// serving the feed that links to them perfectly well. The choice there is a
// browser fetch or losing the World Heritage Centre as a source.
//
// WHAT THIS CHANGES ABOUT THE SECURITY POSTURE — stated plainly, because it is
// a real change. Everywhere else, fetched content is only ever regex-matched
// and shown to the model; it is never rendered or evaluated. Here the page is
// rendered and its scripts do run. They run inside headless Chromium's sandbox,
// in a throwaway context with no storage and no credentials, and what comes
// back out is text that is still only ever regex-matched and shown to the
// model. Nothing the page contains is evaluated in our process, and the
// allowlist check on the final URL still happens in verify.js afterwards.

let browserPromise = null;
let idleTimer = null;

const IDLE_SHUTDOWN_MS = Number(process.env.FETCH_BROWSER_IDLE_MS ?? 60_000);
const NAV_TIMEOUT_MS = Number(process.env.FETCH_BROWSER_TIMEOUT_MS ?? 25_000);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/tiyul-plus-0.1 Safari/537.36 (+https://tiyulplus.com)';

function getBrowser() {
  browserPromise ??= chromium.launch();
  return browserPromise;
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!(IDLE_SHUTDOWN_MS > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    closeFetchBrowser().catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  // A warm browser must never be the reason a one-off script cannot exit.
  idleTimer.unref?.();
}

export async function closeFetchBrowser() {
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
 * Fetch a page through headless Chromium and return it shaped exactly like
 * fetchText(), so the caller's text extraction stays on one path.
 *
 * Returning HTML rather than extracted text is deliberate: htmlToText() and
 * stripBoilerplate() then apply identically to both fetch routes, so a quote
 * checked against a browser-fetched page is checked against text produced the
 * same way as every other page. Two extraction paths would mean the evidence
 * check behaves differently depending on how the page happened to arrive.
 */
export async function fetchViaBrowser(url, { timeoutMs = NAV_TIMEOUT_MS } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    javaScriptEnabled: true,
    // No storage, no credentials, nothing that persists between two fetches.
    storageState: undefined,
    acceptDownloads: false,
  });

  try {
    const page = await context.newPage();

    // We want text. Images, media and fonts are bytes we would throw away, and
    // on a VPS that is also rendering cards they are the bulk of the transfer.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = res?.status() ?? 0;
    if (status && status >= 400) {
      throw Object.assign(new Error(`HTTP ${status}`), { code: 'http_error', status });
    }

    const body = await page.content();
    return {
      body,
      finalUrl: page.url() || url,
      contentType: res?.headers()?.['content-type'] || 'text/html',
    };
  } finally {
    await context.close().catch(() => {});
    scheduleIdleShutdown();
  }
}
