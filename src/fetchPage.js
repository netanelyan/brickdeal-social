// Fetching a source page and reducing it to readable text.
//
// This is load-bearing for the primary-source rule, not a convenience: the
// drafting step is only ever shown text that came back from the source URL
// itself, and src/verify.js checks the drafted claim against this same text.
// If a page can't be fetched, the candidate dies here rather than being drafted
// from the model's own recollection of the place.

// Identify honestly rather than impersonating a browser.
//
// This started as a pinned Chrome string, which is both untrue and ages badly:
// a bot claiming to be Chrome 120 forever eventually looks like exactly the
// thing operators block. A named agent with a contact URL is what a scheduled
// fetcher is supposed to send, and it is what lets an operator ask us to stop
// rather than silently blocking us.
//
// Verified equal on all six enabled sources before switching — both strings
// returned 200 everywhere.
const UA = 'tiyul-plus/0.1 (+https://tiyulplus.com)';

const DEFAULT_TIMEOUT_MS = 20_000;

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'timeout' | 'http_error' | 'network' | 'too_large' | 'not_html'
  }
}

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept, 'accept-language': 'en,he;q=0.8' },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new FetchError('timeout', `timed out after ${timeoutMs}ms`);
    throw new FetchError('network', e.message);
  }
  clearTimeout(timer);

  // The status rides along on the error so a caller can tell a bot wall (403)
  // apart from a dead link (404) without parsing the message.
  if (!res.ok) throw Object.assign(new FetchError('http_error', `HTTP ${res.status}`), { status: res.status });

  // A source page that is 5MB of minified app bundle isn't going to yield a
  // claim worth publishing, and we'd rather not hold it in memory.
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 5_000_000) throw new FetchError('too_large', `${len} bytes`);

  const body = await res.text();
  return { body, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
}

const BLOCK_TAGS = 'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

/**
 * Strip HTML down to plain text, preserving paragraph boundaries.
 *
 * Deliberately regex-based rather than a DOM parse: nothing here is rendered or
 * executed, it is only ever read, matched against, and shown to the drafting
 * model. Same posture as BrickDeal — scraped content is never fed to anything
 * that could act on it.
 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Site chrome, dropped whole. These rarely nest inside themselves, so the
  // non-greedy match is safe, and removing them here is much cheaper than
  // trying to filter their text out line by line afterwards.
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  // Inline tags collapse to nothing, not to a space. Replacing them with a
  // space is the obvious move and it detaches punctuation from its sentence:
  // `<p>From <b>October</b>.</p>` came out as "From October ." — which then
  // fails an exact-quote check for a claim that was genuinely in the source.
  // Block-level structure is already preserved by the newline pass above.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return stripBoilerplate(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  ).join('\n');
}

// Cookie banners, consent text, nav labels and licence footers survive the tag
// stripping above as ordinary sentences. On gov.uk they were the first ~500
// characters of every page.
//
// This is not just prompt hygiene. src/verify.js proves a claim by checking the
// drafted quote appears verbatim in this text — so anything left in here is
// something a claim can legally be grounded in. A quote lifted from a cookie
// notice would pass verification and publish. Dropping the boilerplate keeps
// the evidence check meaningful.
const BOILERPLATE =
  /^(?:accept|reject|view|hide|manage|change)\b.*\bcookie|^cookies?\b|\bcookie settings\b|^skip to |^sign in\b|^menu$|^search\b|^back to top$|^is this page useful\??$|^report a problem|^all content is available under|open government licence|©\s*crown copyright|^share this page$|^follow us\b|^subscribe\b|^privacy (?:policy|notice)$|^terms (?:and conditions|of use)$|^accessibility statement$|^we\b.{0,40}\buse\b.{0,60}\bcookies\b|^we[’']d like to set additional cookies\b|^you have (?:accepted|rejected) additional cookies\b/i;

export function stripBoilerplate(lines) {
  const kept = lines.filter((l) => !BOILERPLATE.test(l));
  if (!kept.length) return lines;

  // Distrust the filter only when it removed the overwhelming majority of a
  // substantial page — that points at patterns misreading the page's structure
  // rather than a page that genuinely was mostly consent text.
  //
  // The first version of this guard required the kept lines to outnumber a
  // fixed threshold, which meant a short page (a five-line advisory, say) fell
  // back to the unstripped text and quietly put cookie notices back into the
  // evidence pool — the exact thing this function exists to prevent.
  const size = (ls) => ls.reduce((n, l) => n + l.length, 0);
  const before = size(lines);
  if (before > 2000 && size(kept) < before * 0.15) return lines;

  return kept;
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', deg: '°', euro: '€', pound: '£', shy: '',
};

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// Sources that answer a plain fetch with 403 are not refusing us the content —
// they serve the feed that links to these very pages. They are refusing the
// shape of the request. A real browser is the documented way past that, and it
// is the only status worth retrying: a 404 is a dead link and a 429 is a rate
// limit, neither of which a second request fixes.
//
// Off by default in tests via FETCH_BROWSER_FALLBACK=0, because the offline
// suite must not reach for Chromium.
const browserFallbackEnabled = () => process.env.FETCH_BROWSER_FALLBACK !== '0';

/** Fetch a URL and hand back its readable text, capped to something a prompt can hold. */
export async function fetchReadable(url, { maxChars = 12_000, ...opts } = {}) {
  let fetched;
  try {
    fetched = await fetchText(url, opts);
  } catch (e) {
    if (!(e.status === 403 && browserFallbackEnabled())) throw e;
    // Imported lazily so nothing that merely parses a feed pays for Playwright,
    // and so a box without Chromium still runs everything that never hits a 403.
    const { fetchViaBrowser } = await import('./browserFetch.js');
    try {
      fetched = await fetchViaBrowser(url);
    } catch (browserErr) {
      // Report the original refusal, not the retry's failure — "HTTP 403" is
      // the fact worth acting on, and burying it under a Playwright stack is
      // how a blocked source gets misfiled as a broken browser.
      throw Object.assign(e, { browserRetry: browserErr.message });
    }
  }

  const { body, finalUrl, contentType } = fetched;
  const text = /json/i.test(contentType) ? body : htmlToText(body);
  return {
    finalUrl,
    contentType,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  };
}
