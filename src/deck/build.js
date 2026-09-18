import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { shortlist, authorityDomains, KINDS } from '../sources/places.js';
import { searchConfigured, findOnAny, remaining as searchRemaining } from '../search.js';
import { fetchReadable } from '../fetchPage.js';
import { verifyEvidence, RejectedError } from '../verify.js';
import { findImage } from '../images.js';

// An idea becomes a deck, or it doesn't.
//
// Per place, four things have to go right in order, and any of them may fail:
//
//   1. an authority for it exists          (Wikidata: its own site, its operator,
//                                           or the body that contains it)
//   2. a page on that authority is FOUND   (site-restricted search)
//   3. that page can be FETCHED and read   (the existing 403-aware fetcher)
//   4. a fact on it survives quoting       (verifyEvidence, unchanged)
//
// A place that fails any step is dropped and the reason is kept. That is the
// design: the alternative to dropping a place is writing a slide from the
// model's memory, which is the exact failure this whole pipeline is built to
// make impossible. A deck that wanted five places and found three says so on
// the approval card.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.DECK_EFFORT || 'medium';

let client = null;
const getClient = () => (client ??= new Anthropic());

const SLIDE_SCHEMA = {
  type: 'object',
  properties: {
    usable: {
      type: 'boolean',
      description: 'false when the page says nothing concrete enough to put on a slide',
    },
    reject_reason: { type: 'string', description: 'English, short, when usable is false' },
    name_he: {
      type: 'string',
      description: 'The place name as Israelis would write it in Hebrew. Transliterate; do not translate.',
    },
    lines: {
      type: 'array',
      description:
        'Two to four fact lines for the slide. Each is one short Hebrew phrase, under 34 characters, of the form "label: value" — opening hours, price, how long it takes, how hard it is, what it holds.',
      items: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'One emoji that fits the fact. Never a flag.' },
          text: { type: 'string', description: 'The Hebrew line itself, under 34 characters' },
          quote: {
            type: 'string',
            description:
              'The sentence from the PAGE TEXT that states this fact, copied character for character. Never paraphrased, never assembled from two places.',
          },
        },
        required: ['emoji', 'text', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['usable', 'reject_reason', 'name_he', 'lines'],
  additionalProperties: false,
};

const SLIDE_SYSTEM = `You write one slide of a Hebrew travel slideshow for tiyul+.

You are given one place and the text of a page published by the body that
speaks for it. Write the slide: the place's name in Hebrew, and two to four fact
lines drawn from that page.

THE ONLY RULE THAT MATTERS

Every line needs a quote, and the quote must appear in the PAGE TEXT character
for character. Copy it; do not tidy it, do not translate it, do not join two
sentences. If the page does not state a fact plainly, you have three lines
instead of four, or you set usable to false. A line without a quote in the page
is a fabricated claim published under our name.

WHAT MAKES A GOOD LINE

Concrete and actionable: opening hours, closing day, ticket price, how long a
visit takes, how far the walk is, how steep, what the collection holds, what it
is the oldest or largest of. A number beats an adjective every time.

Not: "one of the most beautiful museums in Europe", "a must-see", "an
unforgettable experience". Not the founding date unless it is genuinely the
point of the place.

FORM

Hebrew. Under 34 characters a line, because it is rendered over a photograph and
a longer line wraps into mush. "label: value" reads best - שעות פתיחה: 9:00-17:00,
כניסה: 250 קרונות, זמן ביקור: שעה וחצי.

Prices keep the source's currency. Times keep the source's format. Hyphens,
never em dashes. One emoji per line, chosen for the fact rather than for
decoration, and never a national flag.`;

/** Turn one place plus one fetched page into a slide, or explain why not. */
export async function draftSlide(place, pageText, { url }) {
  const user = [
    `PLACE: ${place.labelEn || place.name}`,
    place.labelHe ? `HEBREW LABEL ON WIKIDATA: ${place.labelHe}` : null,
    `CATEGORY: ${KINDS[place.kind]?.he || place.kind}`,
    `PAGE PUBLISHED BY: ${new URL(url).hostname}`,
    '',
    'PAGE TEXT (the only thing you may draw facts from):',
    '---',
    pageText,
    '---',
    '',
    'Write the slide. Copy every quote verbatim from the PAGE TEXT above.',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SLIDE_SCHEMA } },
    system: [{ type: 'text', text: SLIDE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new RejectedError('refused', 'slide drafting refused');
  if (res.stop_reason === 'max_tokens') throw new RejectedError('truncated', 'slide drafting hit max_tokens');

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new RejectedError('no_text', 'slide drafting returned no text');

  const parsed = JSON.parse(text);
  if (!parsed.usable) throw new RejectedError('thin_page', parsed.reject_reason || 'page says nothing concrete');

  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const lines = (parsed.lines || [])
    .map((l) => ({ emoji: clean(l.emoji).slice(0, 4), text: clean(l.text), quote: String(l.quote || '').trim() }))
    .filter((l) => l.text && l.quote);

  if (lines.length < 2) throw new RejectedError('thin_page', `only ${lines.length} usable line(s)`);

  // The same gate every other post goes through, on the same text that was
  // fetched. Nothing about a slideshow earns it a softer check.
  verifyEvidence({ evidence: lines.map((l) => ({ claim: l.text, quote: l.quote })) }, pageText);

  // Lines are capped AFTER verification: the quote is what was checked, the
  // text is what is drawn, and a line too long for the slide is a rendering
  // problem rather than grounds to throw the verified fact away.
  const TOO_LONG = Number(process.env.DECK_LINE_MAX || 34);
  return {
    nameHe: clean(parsed.name_he) || place.labelEn || place.name,
    nameEn: place.labelEn || place.name,
    lines: lines.slice(0, 4).map((l) => ({ ...l, overlong: l.text.length > TOO_LONG })),
    sourceUrl: url,
    sourceHost: new URL(url).hostname.replace(/^www\./, ''),
    qid: place.qid,
  };
}

/**
 * Find the page on an authority domain that talks about this place.
 *
 * Search is preferred over the recorded homepage because a homepage rarely
 * states opening hours, and a slide made from a homepage is a slide with no
 * facts. The homepage is the fallback, not the target.
 */
export async function findPage(place, searchTerms = []) {
  const domains = authorityDomains(place);
  if (!domains.length) return { url: null, why: 'no authority domain' };

  if (searchConfigured() && searchRemaining() > 0) {
    const name = place.labelEn || place.name;
    const term = searchTerms[0] || 'visit';
    const hit = await findOnAny(`${name} ${term}`, domains, { num: 3 });
    if (hit.url) return { url: hit.url, via: 'search', domain: hit.domain };
  }

  // No search configured, or it found nothing on any authority domain.
  const fallback = place.officialUrl || place.operatorUrl || place.withinUrl;
  return fallback
    ? { url: fallback, via: 'wikidata', domain: domains[0] }
    : { url: null, why: 'nothing found on any authority domain' };
}

/**
 * Build a deck from one idea.
 *
 * Walks the pool in ranked order and stops as soon as it has what the idea
 * asked for, so a deck of five costs five searches and five drafting calls
 * rather than the whole pool's worth.
 */
export async function buildDeck(idea, { wantImages = true } = {}) {
  const pool = await shortlist({ where: idea.where, kind: idea.kind, want: idea.want });

  const slides = [];
  const dropped = [];

  for (const place of pool.places) {
    if (slides.length >= idea.want) break;

    const found = await findPage(place, idea.searchTerms);
    if (!found.url) {
      dropped.push({ place: place.labelEn || place.name, why: found.why });
      continue;
    }

    let pageText = '';
    try {
      pageText = (await fetchReadable(found.url)).text || '';
    } catch (e) {
      dropped.push({ place: place.labelEn || place.name, why: `fetch failed: ${e.message}`, url: found.url });
      continue;
    }

    let slide;
    try {
      slide = await draftSlide(place, pageText, { url: found.url });
    } catch (e) {
      dropped.push({
        place: place.labelEn || place.name,
        why: e instanceof RejectedError ? `${e.reason}: ${String(e.detail || '').slice(0, 120)}` : e.message,
        url: found.url,
      });
      continue;
    }

    if (wantImages) {
      // Stock and catalogue only. The AI provider is excluded by policy rather
      // than by preference: a generated image may never name a real place, and
      // every slide here is about one.
      slide.image = await findImage(
        { imageQuery: `${slide.nameEn} ${idea.where}`, placeEn: slide.nameEn, countryEn: idea.where },
        { order: ['catalogue', 'stock'] }
      ).catch(() => null);
      if (!slide.image) slide.imageMiss = `no photograph for "${slide.nameEn}"`;
    }

    slides.push({ ...slide, via: found.via, domain: found.domain });
  }

  return {
    kind: 'deck',
    idea,
    titleHe: idea.titleHe,
    where: idea.where,
    category: idea.kind,
    counts: { ...pool.counts, asked: idea.want, built: slides.length },
    area: pool.area,
    slides,
    dropped,
    // A deck that came up short is still publishable — five is a target, not a
    // format requirement — but the approval card has to say it, because a
    // three-slide deck and a three-slide idea look identical afterwards.
    short: slides.length < idea.want,
    createdAt: new Date().toISOString(),
  };
}
