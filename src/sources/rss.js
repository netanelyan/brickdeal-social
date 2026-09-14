import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { fetchText } from '../fetchPage.js';
import { decodeEntities, htmlToText } from '../fetchPage.js';

// One adapter for both RSS 2.0 and Atom — they differ in element names and
// almost nothing else that matters here. gov.uk publishes Atom, UNESCO and JNTO
// publish RSS, and the pipeline downstream shouldn't have to care which.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return '';
};

// Atom <link> is an element with attributes and can repeat by rel; RSS <link>
// is just a string. Prefer rel="alternate", fall back to the first href.
function linkOf(entry) {
  const raw = entry.link;
  if (typeof raw === 'string') return raw.trim();
  const links = arr(raw);
  const alternate = links.find((l) => l && typeof l === 'object' && (l['@_rel'] === 'alternate' || !l['@_rel']));
  const chosen = alternate || links[0];
  if (!chosen) return '';
  if (typeof chosen === 'string') return chosen.trim();
  return String(chosen['@_href'] || chosen['#text'] || '').trim();
}

function dateOf(entry) {
  const raw =
    entry.pubDate || entry.published || entry.updated || entry['dc:date'] || entry.date || null;
  const s = textOf(raw) || (typeof raw === 'string' ? raw : '');
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function summaryOf(entry) {
  const raw =
    entry.description ?? entry.summary ?? entry.content ?? entry['content:encoded'] ?? '';
  const s = textOf(raw) || (typeof raw === 'string' ? raw : '');
  // Feed summaries routinely carry escaped HTML inside the text node.
  return htmlToText(decodeEntities(s)).slice(0, 1500);
}

/**
 * Fetch a feed and normalise it into pipeline items.
 *
 * Never throws for an empty feed — an empty result is a legitimate answer and
 * the caller tallies it. Throws only when the feed itself is unreachable or
 * unparseable, so `npm run check-sources` can tell "nothing new today" apart
 * from "this source is broken".
 */
export async function fetchFeed(source) {
  const { body } = await fetchText(source.url, {
    accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
  });
  return parseFeed(body, source);
}

/**
 * The parsing half, split out from the fetching half so the RSS-vs-Atom
 * handling can be tested against fixtures without going near the network.
 */
export function parseFeed(body, source) {
  let doc;
  try {
    doc = parser.parse(body);
  } catch (e) {
    throw new Error(`unparseable feed: ${e.message}`);
  }

  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? null;
  const feed = doc?.feed ?? null;

  let entries = [];
  if (channel) entries = arr(channel.item);
  else if (feed) entries = arr(feed.entry);
  else if (doc?.channel) entries = arr(doc.channel.item);

  // A feed that carries more than one kind of thing.
  //
  // JNTO publishes its travel news and its corporate wire down the same pipe:
  // of fifteen items, one was a press release about a tool for inbound
  // travellers and fourteen were procurement notices, trade-show exhibitor
  // recruitment and B2B seminars. All fourteen were correctly rejected as too
  // thin — those pages are a title, a date and "back to list" — but not before
  // they had occupied fourteen slots in the ranked list that real candidates
  // could have used, and a source's own URL scheme says which is which long
  // before any of that costs anything.
  //
  // Declared per source in sources.json rather than hardcoded, and the
  // thin-source floor still runs afterwards: this is a cheaper way to reach the
  // same verdict, not a replacement for it.
  const include = source.urlIncludes || null;

  return entries
    .map((entry) => {
      const url = linkOf(entry);
      if (!url) return null;
      if (include && !include.some((frag) => url.includes(frag))) return null;
      const title = htmlToText(decodeEntities(textOf(entry.title) || String(entry.title || ''))).trim();
      if (!title) return null;
      return {
        sourceId: source.id,
        sourceName: source.name,
        authority: source.authority,
        lang: source.lang || 'en',
        pillarHints: source.pillars || [],
        title,
        summary: summaryOf(entry),
        url,
        publishedAt: dateOf(entry),
        // Some feeds carry the whole story in each item and then link every one
        // of them to the same landing page. The Smithsonian's weekly volcano
        // report does exactly this: twenty-one volcanoes, twenty-one substantial
        // descriptions, and one shared `reports_weekly.cfm` link. Identity
        // derived from the URL would collapse all of them into one candidate
        // and silently discard the other twenty.
        //
        // `dedupeBy: "title"` in the registry says so explicitly, per source,
        // rather than guessing — a feed with genuinely duplicate titles should
        // still collapse.
        ...(source.contentInFeed ? { contentInFeed: true } : {}),
        ...(source.dedupeBy === 'title'
          ? { dedupeId: createHash('sha1').update(`${source.id}\n${title}`).digest('hex').slice(0, 12) }
          : {}),
      };
    })
    .filter(Boolean);
}
