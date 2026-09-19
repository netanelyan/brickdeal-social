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
    hook_he: {
      type: 'string',
      description:
        'The one reason a traveller would go, in under 40 Hebrew characters. What they will see or feel, not what the institution is. This is the line that has to earn the slide.',
    },
    hook_quote: {
      type: 'string',
      description: 'The sentence in the PAGE TEXT that supports the hook, copied character for character.',
    },
    lines: {
      type: 'array',
      description:
        'One or two practical lines, and no more. Only what someone standing outside would need: price, opening hours, how long a visit takes, when to come. Never an address, never a floor area, never how many items are in the collection.',
      items: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'One emoji that fits the fact. Never a flag.' },
          text: { type: 'string', description: 'The Hebrew line itself, under 26 characters' },
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
  required: ['usable', 'reject_reason', 'name_he', 'hook_he', 'hook_quote', 'lines'],
  additionalProperties: false,
};

const SLIDE_SYSTEM = `You write one slide of a Hebrew travel slideshow for tiyul+.

You are given one place and the text of a page published by the body that speaks
for it. Write the slide: the place's name in Hebrew, one hook, and one or two
practical lines.

WHO IS WATCHING

Someone deciding where to go on their next trip. They are not a museum person,
a history person or an architecture person. They are scrolling, and they will
give this slide about two seconds.

That audience is the whole brief. "2,000 items in the collection" and "1,300
square metres of exhibition space" are facts about an institution's own sense of
importance. "The ceiling everyone photographs" and "free after 16:00" are facts
about a trip. Write the second kind.

THE HOOK

One line, under 40 characters, and it is the only line that has to be
interesting. What will they see, stand in front of, taste, climb? What is the
thing worth crossing a city for?

Good: "התקרה המצוירת שכולם מצלמים", "הנוף מהמרפסת על כל העיר העתיקה",
"אוסף הזכוכית הגדול באירופה".
Bad: "מוזיאון לאומי שנוסד ב-1818", "2,000 פריטים באוסף", "מבנה ניאו-רנסאנס".

If the page gives you nothing a traveller would cross a street for, set usable
to false. A slide with no reason to go is a slide worth dropping.

THE PRACTICAL LINES

One or two. Only what someone standing outside needs to know: price, opening
hours, how long it takes, the day it is closed, when it is free.

NEVER: a street address, a floor area, how many items are in a collection, when
it was founded, who the architect was, the names of departments, an exhibition's
full formal title.

THE RULE THAT OVERRIDES EVERYTHING

Every line, the hook included, needs a quote that appears in the PAGE TEXT
character for character. Copy it; do not tidy it, do not translate it, do not
join two sentences. One line with a quote beats three without. A line whose
quote is not in the page is a fabricated claim published under our name.

FORM

Hebrew. Under 26 characters for a practical line, under 40 for the hook - these
are rendered over a photograph and a longer line wraps into mush. Practical
lines read best as "label: value": כניסה 250 קרונות, סגור בימי שני,
ביקור: שעה וחצי. Drop the word if it is obvious - "שעות: " before a time is
noise.

Prices keep the source's currency. Hyphens, never em dashes. One emoji per line,
chosen for the fact rather than for decoration, never a national flag.`;

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

  const hook = clean(parsed.hook_he);
  const hookQuote = String(parsed.hook_quote || '').trim();
  if (!hook || !hookQuote) throw new RejectedError('no_hook', 'nothing on the page a traveller would go for');

  // Two lines at most. The earlier version allowed four and the decks it made
  // were unreadable at a glance: a wall of small text over a photograph, which
  // is the one thing a slide cannot be. Fewer, larger, better.
  const lines = (parsed.lines || [])
    .map((l) => ({ emoji: clean(l.emoji).slice(0, 4), text: clean(l.text), quote: String(l.quote || '').trim() }))
    .filter((l) => l.text && l.quote)
    .slice(0, 2);

  // The same gate every other post goes through, on the same text that was
  // fetched. The hook is checked with the rest: it is the most interesting
  // claim on the slide, which makes it the one most worth inventing.
  verifyEvidence(
    { evidence: [{ claim: hook, quote: hookQuote }, ...lines.map((l) => ({ claim: l.text, quote: l.quote }))] },
    pageText
  );

  // Length is measured AFTER verification: the quote is what was checked, the
  // text is what is drawn, and a line too long for the slide is a rendering
  // problem rather than grounds to throw a verified fact away.
  const TOO_LONG = Number(process.env.DECK_LINE_MAX || 26);
  return {
    nameHe: clean(parsed.name_he) || place.labelEn || place.name,
    nameEn: place.labelEn || place.name,
    hook: { text: hook, quote: hookQuote, overlong: hook.length > 40 },
    lines: lines.map((l) => ({ ...l, overlong: l.text.length > TOO_LONG })),
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
