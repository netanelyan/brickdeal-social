// Where rendered cards are served from, and which of those domains TikTok will
// actually fetch from.
//
// Two different questions that look like one:
//
//   1. WHERE DO WE PUT THE IMAGE. Instagram and TikTok both fetch the bytes
//      themselves, so a card has to sit on a public https URL. That used to be
//      one value, CARD_PUBLIC_BASE_URL. It is now a list, because one host is a
//      single point of failure for the only step in the pipeline that cannot be
//      retried locally.
//
//   2. WILL TIKTOK FETCH IT. This is NOT the same question, and treating it as
//      the same is the trap this module exists to close. TikTok only downloads
//      images from a domain verified under URL properties in the developer
//      portal. Point a card at an unverified host and TikTok does not tell you
//      that is what went wrong — the post fails with url_ownership_unverified
//      at best, and at worst simply never fetches. Adding a second image host
//      is therefore the exact moment this becomes silent, so the check is a
//      preflight that runs before init and names the domain it refused.
//
// The second list is declared, not inferred. Deriving "verified" from "wherever
// we happen to serve from" would make the check agree with any mistake it was
// written to catch.

const splitList = (raw) =>
  String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The hostname of a URL, lowercased and without a trailing dot, or null. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

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

/**
 * Domains TikTok has been told we own.
 *
 * Declared in TIKTOK_VERIFIED_DOMAINS. When it is unset we fall back to the
 * host of the primary base URL, which is exactly the behaviour that existed
 * before this file — a single host, assumed verified because it was the only
 * one. That keeps an untouched .env working while still refusing any SECOND
 * host somebody adds without verifying it, which is the case worth catching.
 */
export function tiktokVerifiedDomains(env = process.env) {
  const declared = splitList(env.TIKTOK_VERIFIED_DOMAINS).map((d) =>
    d.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  );
  if (declared.length) return declared;

  const host = hostOf(primaryCardBaseUrl(env));
  return host ? [host] : [];
}

/**
 * Is this URL on a verified domain?
 *
 * Matched on a domain-label boundary, the same rule the source allowlist uses:
 * verifying `brickdeal.co.il` covers `slides.brickdeal.co.il`, and must not be
 * satisfied by `brickdeal.co.il.attacker.example` or `evilbrickdeal.co.il`.
 */
export function isVerifiedForTikTok(url, domains = tiktokVerifiedDomains()) {
  const host = hostOf(url);
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * The distinct hosts among these URLs that TikTok would refuse, in order.
 *
 * Returns hosts rather than URLs because the fix is per-domain — you verify a
 * domain in the portal, not a filename — and a deck of eight slides on one bad
 * host should say that host once instead of eight times.
 */
export function unverifiedTikTokHosts(urls, domains = tiktokVerifiedDomains()) {
  const bad = [];
  for (const u of urls) {
    if (isVerifiedForTikTok(u, domains)) continue;
    const label = hostOf(u) || String(u);
    if (!bad.includes(label)) bad.push(label);
  }
  return bad;
}
