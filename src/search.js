// Finding the page, on a domain we already trust, that states a given fact.
//
// This exists because of a gap the map data cannot close. OpenStreetMap and
// Wikidata will tell you that Tre Cime di Lavaredo is a famous route in the
// Dolomites; neither will tell you the URL of the park authority's page about
// it, and a fact we cannot fetch is a fact we cannot quote.
//
// Google Programmable Search is used ONLY to locate a page on a domain that has
// already been judged acceptable by the caller. It never decides what is true
// and never widens the allowlist: every query is site-restricted, the results
// are re-checked against the requested domain before being returned, and what
// comes back is a URL that still has to be fetched and quoted from like any
// other source. A search engine in this pipeline is a filing cabinet, not an
// authority.
//
// The free tier is 100 queries a day. A deck of five places costs about five,
// so the budget is real but ample — and `remaining()` reports it rather than
// letting the quota run out mid-deck as an unexplained failure.

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

export class SearchError extends Error {
  constructor(message, { step, status } = {}) {
    super(message);
    this.step = step;
    this.status = status;
  }
}

export const searchConfigured = () =>
  Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX);

// Counted in-process rather than persisted. The number that matters is "did
// this run exhaust the quota", and a run is one process; a daily total that
// survives restarts would be a nicer report and a worse signal.
let spent = 0;
export const spentToday = () => spent;
export const dailyBudget = () => Number(process.env.GOOGLE_CSE_DAILY || 90);
export const remaining = () => Math.max(0, dailyBudget() - spent);
export const resetBudget = () => {
  spent = 0;
};

/**
 * The registrable domain, for comparing a result against what was asked for.
 *
 * Deliberately the same rule the source allowlist uses: match on a label
 * boundary, so `evil-nm.cz` and `nm.cz.attacker.com` are not `nm.cz`. Google is
 * asked for one site and generally obeys, but "generally" is not a guarantee we
 * should be resting an allowlist on.
 */
export function sameSite(url, domain) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const want = String(domain || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  if (!want) return false;
  return host === want || host.endsWith(`.${want}`);
}

/**
 * Search one site for one thing.
 *
 * Returns [] rather than throwing when the site simply has no such page —
 * that is an ordinary answer, and the caller (a deck losing one slide) handles
 * it better than an exception would. Configuration and quota problems DO throw,
 * because they are silent killers otherwise: a deck that quietly finds nothing
 * for every place looks exactly like a region nobody writes about.
 */
export async function searchSite(query, domain, { num = 5 } = {}) {
  if (!searchConfigured()) {
    throw new SearchError('Google CSE is not configured (GOOGLE_CSE_KEY, GOOGLE_CSE_CX)', { step: 'config' });
  }
  if (!domain) throw new SearchError('searchSite requires a domain to restrict to', { step: 'config' });
  if (remaining() <= 0) {
    throw new SearchError(`daily search budget spent (${dailyBudget()})`, { step: 'budget' });
  }

  const params = new URLSearchParams({
    key: process.env.GOOGLE_CSE_KEY,
    cx: process.env.GOOGLE_CSE_CX,
    q: query,
    num: String(Math.min(10, Math.max(1, num))),
    // siteSearch is the API's own restriction and is enforced server-side; the
    // sameSite() filter below is the belt to that's braces.
    siteSearch: domain,
    siteSearchFilter: 'i',
  });

  let res;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new SearchError(`network error: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, { step: 'fetch' });
  }
  spent++;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.message || `HTTP ${res.status}`;
    // 429 here is the daily quota, not a momentary throttle, and retrying it
    // just burns the next day's allowance too.
    throw new SearchError(reason, { step: 'search', status: res.status });
  }

  return (body.items || [])
    .filter((i) => sameSite(i.link, domain))
    .map((i) => ({ url: i.link, title: i.title, snippet: i.snippet || '' }));
}

/**
 * The first page on any of several trusted domains that mentions a place.
 *
 * Domains are tried in order, and order is meaning: the caller passes the
 * place's own official site first, then whoever manages or administers it. The
 * first hit wins rather than the best-scoring across all of them, because
 * "closest to the horse's mouth" beats "better written".
 */
export async function findOnAny(query, domains, { num = 3 } = {}) {
  const tried = [];
  for (const domain of domains.filter(Boolean)) {
    if (remaining() <= 0) break;
    try {
      const hits = await searchSite(query, domain, { num });
      tried.push({ domain, hits: hits.length });
      if (hits.length) return { ...hits[0], domain, tried };
    } catch (e) {
      tried.push({ domain, error: e.message });
      // A budget or config failure is fatal for every remaining domain too.
      if (e.step === 'budget' || e.step === 'config') break;
    }
  }
  return { url: null, tried };
}
