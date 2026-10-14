// Where rendered cards are served from.
//
// Instagram and Zernio both fetch the bytes themselves, so a card has to sit
// on a public https URL. That used to be one value, CARD_PUBLIC_BASE_URL. It is
// now a list, because one host is a single point of failure for the only step
// in the pipeline that cannot be retried locally.
//
// There was a second half to this file: which of those domains TikTok had been
// told we own, because TikTok's own API downloads images only from a domain
// verified in its developer portal. TikTok now goes through Zernio, which
// fetches the slides itself and hands them on, so that check went with the
// direct client.

const splitList = (raw) =>
  String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Every base URL a card may be served from, in preference order.
 *
 * CARD_PUBLIC_BASE_URLS (plural) is the list; CARD_PUBLIC_BASE_URL (singular)
 * is still read and appended, so an existing .env keeps working untouched and a
 * deployment can migrate by adding rather than editing.
 */
export function cardBaseUrls(env = process.env) {
  const declared = [...splitList(env.CARD_PUBLIC_BASE_URLS)];
  if (env.CARD_PUBLIC_BASE_URL) declared.push(String(env.CARD_PUBLIC_BASE_URL).trim());

  const seen = new Set();
  const out = [];
  for (const raw of declared) {
    const clean = raw.replace(/\/+$/, '');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * The base URL a freshly rendered card is published under.
 *
 * The first entry wins. Rendering picks one host rather than round-robining,
 * because the file is written to one CARD_OUTPUT_DIR and a URL on a host that
 * does not serve that directory is a 404 the publisher cannot see coming.
 * Extra hosts in the list are for serving the same directory (a second CDN, a
 * fallback domain), not for spreading files across unrelated roots.
 */
export const primaryCardBaseUrl = (env = process.env) => cardBaseUrls(env)[0] || null;

/** Is any image host configured at all? */
export const cardHostConfigured = (env = process.env) => cardBaseUrls(env).length > 0;
