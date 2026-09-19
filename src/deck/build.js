import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { shortlist, authorityDomains, KINDS } from '../sources/places.js';
import { searchConfigured, findOnAny, remaining as searchRemaining } from '../search.js';
import { fetchReadable } from '../fetchPage.js';
import { verifyEvidence, RejectedError } from '../verify.js';
import { findImage } from '../images.js';
import * as unsplash from '../images/unsplash.js';
import * as pexels from '../images/pexels.js';
import { pickCinematic, cinematicQueries } from '../images/curate.js';
import { destinationPlaces, pick } from '../sources/tiyulplus.js';
import { coverForDeck } from './ideas.js';
import { fieldsFor, hasFields } from './fields.js';
import { decideShape } from './shape.js';
import { vocabForPrompt } from './emoji.js';

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

const SLIDE_SYSTEM_V2 = `You write one slide of a Hebrew travel slideshow for tiyul+.

You are given one place and a page about it. Write the slide: the place's name,
one line saying what it IS, and one short practical line.

THE VOICE

A travel page run by a person, talking to a friend who is deciding where to go.
Not a guidebook, not a visitor centre, not a tutorial.

The single biggest tell of a tutorial is the logistics-first slide: opening
hours, ticket prices, how long to allow. Nobody stops scrolling for opening
hours. They stop for "a chapel decorated with the bones of forty thousand
people" and then, having stopped, they want to know roughly what it costs.

THE LINE THAT MATTERS

What is this place, in one line, under 42 characters. The thing that makes
somebody say "wait, what?" - what it holds, what happened there, what you see,
what is strange or oldest or only about it.

Good:  כנסייה שמעוטרת בעצמות של 40 אלף אנשים
       בית הקפה שבו ישבו קפקא ואיינשטיין
       ספרייה בארוקית שנראית כמו סט של סרט
Bad:   מוזיאון לאומי שנוסד ב-1818
       נגיש לכיסאות גלגלים
       שעות פתיחה: 10:00-18:00
       מומלץ להקצות כשעתיים

If the page does not say anything a person would repeat to a friend, set usable
to false.

THE PRACTICAL LINE

At most one, and it is optional. A price, a "free", a "closed Mondays", a "one
hour by train". Never opening hours as a range of clock times, never "allow N
hours", never accessibility, never an address.

THE RULE THAT OVERRIDES EVERYTHING

Both lines need a quote that appears in the PAGE TEXT character for character.
Copy it; do not tidy it, do not translate it, do not join two sentences. One
line with a quote beats two without. A line whose quote is not in the page is a
fabricated claim published under our name.

FORM

Hebrew. Under 42 characters for the what-it-is line, under 24 for the practical
one. Hyphens, never em dashes.

THE EMOJI

One, on the practical line, and it goes AFTER the text - never before it.

It is a reaction, not a label. The channel's voice is this set:

  ${vocabForPrompt()}

Faces and hands doing the reacting. 🥱 next to a long queue, 🫠 next to a
closing day, 💪 next to a climb, 🫣 next to a price. A clock beside an hour and
a train beside a train journey is what a timetable does - pick the pictogram
only when nothing in the set above says it better. Never a national flag.`;

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

const SLIDE_SCHEMA_V2 = {
  type: 'object',
  properties: {
    usable: { type: 'boolean', description: 'false when the page says nothing worth repeating to a friend' },
    reject_reason: { type: 'string', description: 'English, short, when usable is false' },
    what_it_is: {
      type: 'string',
      description:
        'One Hebrew line under 42 characters: what this place IS or holds, the bit that makes someone stop scrolling. Not its category, not its founding date.',
    },
    what_quote: { type: 'string', description: 'The sentence in the PAGE TEXT that says it, character for character' },
    practical: {
      type: 'string',
      description:
        'Optional. One Hebrew line under 24 characters - a price, "חינם", a closing day, "שעה ברכבת". Empty string if the page has none worth printing.',
    },
    practical_quote: { type: 'string', description: 'Its quote from the PAGE TEXT, or an empty string' },
    practical_emoji: { type: 'string', description: 'One emoji for the practical line, or an empty string' },
  },
  required: ['usable', 'reject_reason', 'what_it_is', 'what_quote', 'practical', 'practical_quote', 'practical_emoji'],
  additionalProperties: false,
};

const BULLETS_SCHEMA = {
  type: 'object',
  properties: {
    usable: { type: 'boolean', description: 'false when the page says nothing worth a line' },
    bullets: {
      type: 'array',
      description: 'One or two short Hebrew lines. Two at the very most, and one is usually better.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The line itself, under 30 Hebrew characters' },
          quote: {
            type: 'string',
            description: 'The sentence in the PAGE TEXT that says it, character for character',
          },
        },
        required: ['text', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['usable', 'bullets'],
  additionalProperties: false,
};

const BULLETS_SYSTEM = `You write one or two short lines under a place name on a travel slide.

The photograph shows a handsome building; the viewer does not know what it is.
Your lines answer that, and nothing else.

WHAT EARNS A LINE

What is inside, what happened there, what it is the oldest or only one of, what
you actually do there. The thing someone would repeat to a friend.

  הספרייה הבארוקית שנראית כמו סט של סרט
  כאן קרתה מהפכת הקטיפה
  בית הקפה שבו ישבו קפקא ואיינשטיין

WHAT DOES NOT

Opening hours. Ticket prices. How long to allow. Accessibility. The address.
The founding date on its own. The architect. Anything a viewer would look up
later rather than be interested in now. A line that could sit under any place
of its type is not a line, it is filler.

FORM

Hebrew, under 30 characters, no full stop. Two lines at most and one is usually
better. Every line needs a quote that appears in the PAGE TEXT character for
character - copy it, do not tidy it. A line you cannot quote does not go on the
slide, and a slide with one good line beats one with two where the second was
invented.`;

/** One or two lines under a name, for decks whose shape asked for them. */
export async function draftBulletsFromEntry(place, pageText) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: BULLETS_SCHEMA } },
    system: [{ type: 'text', text: BULLETS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [`PLACE: ${place.nameHe}`, '', 'PAGE TEXT:', '---', pageText, '---'].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return [];

  const parsed = JSON.parse(text);
  if (!parsed.usable) return [];

  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const bullets = (parsed.bullets || [])
    .map((b) => ({ text: clean(b.text), quote: String(b.quote || '').trim() }))
    .filter((b) => b.text && b.quote)
    .slice(0, 2);

  if (!bullets.length) return [];

  // Same gate as everything else. A bullet is shorter than a sentence and just
  // as capable of being wrong.
  verifyEvidence({ evidence: bullets.map((b) => ({ claim: b.text, quote: b.quote })) }, pageText);

  return bullets;
}

const FIELDS_SCHEMA = {
  type: 'object',
  properties: {
    usable: { type: 'boolean', description: 'false when the page does not state these values' },
    reject_reason: { type: 'string', description: 'English, short, when usable is false' },
    values: {
      type: 'array',
      description: 'One entry per requested field, in the order they were requested.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The field key exactly as requested' },
          value: {
            type: 'string',
            description:
              'The value only, no label and no emoji - "5.3 ק\\"מ", "קל", "שעה וחצי". Empty string when the page does not say.',
          },
          quote: {
            type: 'string',
            description: 'The sentence in the PAGE TEXT stating it, character for character. Empty when no value.',
          },
        },
        required: ['key', 'value', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['usable', 'reject_reason', 'values'],
  additionalProperties: false,
};

const FIELDS_SYSTEM = `You fill in a fixed set of fields for one place on a Hebrew travel slideshow.

This is not writing. Every slide in the deck carries the same fields in the same
order, and your job is to read the page and supply the VALUES - nothing else.

  a value:      "5.3 ק"מ"   "קל"   "שעה וחצי"   "45 דקות ברכבת"
  not a value:  "מסלול קל של 5.3 ק"מ שלוקח בערך שעה וחצי"

No labels, no emoji, no sentences, no adjectives that are not in the source.

Every value needs a quote that appears in the PAGE TEXT character for
character. A field the page does not state gets an empty value and an empty
quote - that is normal and it is far better than a guess. If the page states
none of them, set usable to false.`;

/** Fill one slide's fields from its entry, quoting every value. */
export async function draftFieldsFromEntry(place, pageText, kind) {
  const spec = fieldsFor(kind);

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: FIELDS_SCHEMA } },
    system: [{ type: 'text', text: FIELDS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `PLACE: ${place.nameHe}`,
          '',
          'FIELDS TO FILL, in order:',
          ...spec.map((f) => `  ${f.key} — ${f.labelHe}`),
          '',
          'PAGE TEXT (the only thing you may draw from):',
          '---',
          pageText,
          '---',
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new RejectedError('refused', 'field drafting refused');

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new RejectedError('no_text', 'field drafting returned no text');

  const parsed = JSON.parse(text);
  if (!parsed.usable) throw new RejectedError('thin_entry', parsed.reject_reason || 'page states none of the fields');

  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const byKey = new Map((parsed.values || []).map((v) => [v.key, v]));

  const fields = [];
  const evidence = [];
  for (const f of spec) {
    const got = byKey.get(f.key);
    const value = clean(got?.value);
    if (!value) continue;
    fields.push({ ...f, value, quote: String(got.quote || '').trim() });
    evidence.push({ claim: `${f.labelHe}: ${value}`, quote: String(got.quote || '').trim() });
  }

  if (!fields.length) throw new RejectedError('thin_entry', 'no field had a value');

  // Unchanged: the same gate every other post goes through. Fields are shorter
  // than prose but they are still claims, and a wrong distance is a wrong claim.
  verifyEvidence({ evidence }, pageText);

  return {
    nameHe: place.nameHe,
    nameEn: place.nameEn,
    fields,
    sourceUrl: place.sourceUrl,
    sourceHost: 'tiyulplus.com',
    qid: place.id,
  };
}

/**
 * One slide, written from our own destination page.
 *
 * The entry on tiyulplus.com is already written for a traveller, so this is a
 * compression job rather than a research one: the interesting sentence is in
 * there, and the model's task is to find it and cut it to slide length without
 * inventing anything on the way.
 */
export async function draftSlideFromEntry(place, pageText) {
  const user = [
    `PLACE: ${place.nameHe}${place.nameEn && place.nameEn !== place.nameHe ? ` (${place.nameEn})` : ''}`,
    place.category ? `CATEGORY: ${place.category}` : null,
    place.price ? `PRICE BAND ON THE PAGE: ${place.price}` : null,
    place.duration ? `TYPICAL VISIT: ${place.duration}` : null,
    '',
    'PAGE TEXT (the only thing you may draw from):',
    '---',
    pageText,
    '---',
    '',
    'Write the slide. Copy every quote verbatim from the PAGE TEXT above.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SLIDE_SCHEMA_V2 } },
    system: [{ type: 'text', text: SLIDE_SYSTEM_V2, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new RejectedError('refused', 'slide drafting refused');
  if (res.stop_reason === 'max_tokens') throw new RejectedError('truncated', 'slide drafting hit max_tokens');

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new RejectedError('no_text', 'slide drafting returned no text');

  const parsed = JSON.parse(text);
  if (!parsed.usable) throw new RejectedError('thin_entry', parsed.reject_reason || 'nothing worth repeating');

  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const hook = clean(parsed.what_it_is);
  const hookQuote = String(parsed.what_quote || '').trim();
  if (!hook || !hookQuote) throw new RejectedError('no_hook', 'no line worth putting on a slide');

  const practical = clean(parsed.practical);
  const practicalQuote = String(parsed.practical_quote || '').trim();
  const evidence = [{ claim: hook, quote: hookQuote }];
  if (practical && practicalQuote) evidence.push({ claim: practical, quote: practicalQuote });

  verifyEvidence({ evidence }, pageText);

  return {
    nameHe: place.nameHe,
    nameEn: place.nameEn,
    hook: { text: hook, quote: hookQuote, overlong: hook.length > 42 },
    lines:
      practical && practicalQuote
        ? [{ emoji: clean(parsed.practical_emoji).slice(0, 4) || '•', text: practical, quote: practicalQuote, overlong: practical.length > 24 }]
        : [],
    sourceUrl: place.sourceUrl,
    sourceHost: 'tiyulplus.com',
    qid: place.id,
  };
}

/**
 * A photograph for each slide, and never the same one twice.
 *
 * The first real deck put one stock photograph of Prague on three different
 * museums, because the image search falls back to the city when it cannot find
 * the place — and "Prague" returns the same top result every time. A deck where
 * half the slides share a picture reads as fake before a word is read.
 *
 * So the query leads with the place's own English name, and anything already
 * used in this deck is refused even if it is the best match for the next one.
 */
/**
 * One photograph, chosen by looking at several.
 *
 * Every earlier version asked a library for "Mala Strana Prague" and took what
 * came back, which is how a deck ended up with a tram wire across one slide and
 * something over the lens on the cover. Neither is visible in metadata, so the
 * only fix is to look.
 *
 * Two changes do the work. The queries now ask for the photograph rather than
 * the place — "Mala Strana Prague aerial view" finds a different kind of
 * picture from "Mala Strana Prague". And the shortlist is judged on the
 * thumbnails before anything is downloaded at size.
 *
 * `used` is shared across a deck so the same photograph cannot appear twice.
 */
async function cinematicImage({ nameEn, where, used, label }) {
  const libraries = [unsplash, pexels].filter((lib) => lib.configured());
  if (!libraries.length) return null;

  for (const lib of libraries) {
    for (const q of cinematicQueries(nameEn, where)) {
      let pool = [];
      try {
        pool = await lib.candidates(q, { n: 6 });
      } catch (e) {
        console.error(`images: candidates "${q}" failed — ${e.message}`);
        continue;
      }

      const fresh = pool.filter((c) => !used.has(c.key));
      if (!fresh.length) continue;

      let chosen = null;
      try {
        chosen = await pickCinematic(fresh.map((c) => c.thumb), {
          place: label,
          placeEn: nameEn,
          where,
          types: fresh.map((c) => c.thumbType),
        });
      } catch (e) {
        // No falling back to the library's own top hit. That fallback is what
        // put a photograph of a different baroque garden under a slide named
        // Strahov: the library cannot know what the place looks like, and a
        // mislabelled slide costs more than a missing one.
        console.error(`images: curation failed — ${e.message}`);
        chosen = null;
      }

      // Null covers both "none of these is good enough" and "I am not sure any
      // of these is the place". Both are real answers, and both mean: try the
      // next query, then give up on this place.
      if (!chosen) continue;

      const pick = fresh[chosen.index];
      const got = await lib.fetchChosen(pick).catch(() => null);
      if (!got?.src) continue;

      used.add(pick.key);
      return {
        ...got,
        why: chosen.why,
        // Where the words go on this particular photograph.
        band: chosen.band,
        side: chosen.side,
        chosenFrom: fresh.length,
        viaQuery: q,
      };
    }
  }
  return null;
}

export async function imagesForSlides(slides, where, { cover = null } = {}) {
  const used = new Set();

  // The cover is claimed first so it cannot end up with slide one's
  // photograph. A deck that opens on the same picture it shows you next looks
  // like it ran out of material before it started.
  if (cover) {
    const shot = await cinematicImage({ nameEn: where, where, used, label: where });
    if (shot) cover.image = shot;
  }


  for (const slide of slides) {
    const picked = await cinematicImage({
      nameEn: slide.nameEn,
      where,
      used,
      label: slide.nameHe,
    });
    slide.image = picked;
    // "None of these was good enough, or none of them was this place" is a
    // real answer, and the caller drops the place on it.
    if (!picked) slide.imageMiss = `no photograph of "${slide.nameEn}" that is both this place and worth looking at`;
  }
  return slides;
}

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
/**
 * A deck from our own destination page.
 *
 * Preferred over the map route whenever the city is covered, and it is better
 * on every axis that shows up on a slide: Hebrew names, descriptions written
 * for travellers, a curated list, a rating to sort by. One page fetch serves
 * the whole deck, so it costs one request rather than a search and a fetch per
 * place.
 */
export async function buildDeckFromSite(idea, { wantImages = true } = {}) {
  const { places, url, covered } = await destinationPlaces(idea.where);
  if (!covered) return null;

  // The page text every quote is checked against is the page that was fetched.
  // Concatenating the entries keeps that true while letting one drafting call
  // see only its own place.
  const picked = pick(places, { kind: idea.kind, want: idea.want + 3 });

  const slides = [];
  const dropped = [];

  const withFields = hasFields(idea.kind);

  // Asked once per deck, and applied to every slide in it. A mountain deck
  // comes back "no" and costs nothing further; a city deck comes back "yes"
  // and pays for one drafting call per place.
  const shape = withFields
    ? { bullets: false, why: 'this kind carries fixed fields instead' }
    : await decideShape({ where: idea.where, kind: idea.kind, places: picked.slice(0, idea.want) }).catch((e) => {
        console.error(`deck: shape decision failed, name only — ${e.message}`);
        return { bullets: false, why: 'decision failed' };
      });

  for (const place of picked) {
    if (slides.length >= idea.want) break;

    // A name-only slide costs nothing and cannot fail. There is no drafting
    // call because there is nothing to draft, and nothing to verify because a
    // place's name is not a claim about it — which is the whole reason the
    // reference posts can carry seven slides without a word of prose.
    if (!withFields) {
      // Bullets are best-effort: a place the page says nothing quotable about
      // still gets its slide, with its name alone. Losing the place over a
      // missing line would be the wrong trade.
      const bullets = shape.bullets
        ? await draftBulletsFromEntry(place, place.description).catch((e) => {
            console.error(`deck: bullets for ${place.nameHe} failed — ${e.message}`);
            return [];
          })
        : [];

      slides.push({
        n: slides.length + 1,
        nameHe: place.nameHe,
        nameEn: place.nameEn,
        fields: [],
        bullets,
        sourceUrl: place.sourceUrl,
        sourceHost: 'tiyulplus.com',
        qid: place.id,
      });
      continue;
    }

    try {
      const slide = await draftFieldsFromEntry(place, place.description, idea.kind);
      slides.push({ ...slide, n: slides.length + 1 });
    } catch (e) {
      dropped.push({
        place: place.nameHe,
        why: e instanceof RejectedError ? `${e.reason}: ${String(e.detail || '').slice(0, 120)}` : e.message,
        url,
      });
    }
  }

  const coverSlot = {};
  if (wantImages) {
    await imagesForSlides(slides, idea.where, { cover: coverSlot });

    // A place whose photograph could not be found — or could not be trusted to
    // be that place — leaves the deck rather than appearing over somebody
    // else's garden. Renumbered afterwards so the list still counts 1..n.
    for (let i = slides.length - 1; i >= 0; i--) {
      if (slides[i].image) continue;
      dropped.push({ place: slides[i].nameHe, why: slides[i].imageMiss || 'no photograph', url });
      slides.splice(i, 1);
    }
    slides.forEach((s, i) => {
      s.n = i + 1;
    });
  }

  // The cover is written now, from the slides that exist, rather than from the
  // idea that asked for them. A title is a promise about contents and it should
  // not be made before the contents are known.
  const cover = slides.length
    ? await coverForDeck({ where: idea.where, kind: idea.kind, slides, hint: idea.titleHe }).catch((e) => {
        console.error(`deck: cover generation failed, keeping the working title — ${e.message}`);
        return null;
      })
    : null;
  const titled = cover ? { ...idea, ...cover } : idea;

  return {
    kind: 'deck',
    idea: titled,
    titleHe: titled.titleHe,
    where: idea.where,
    category: idea.kind,
    via: 'tiyulplus',
    // Reported so the approval message can say why a deck has lines under its
    // names and the previous one did not.
    shape,
    counts: {
      found: places.length,
      withWikidata: places.length,
      withAuthority: picked.length,
      asked: idea.want,
      built: slides.length,
    },
    area: { displayName: idea.where, query: idea.where },
    slides,
    coverImage: coverSlot.image || null,
    dropped,
    short: slides.length < idea.want,
    createdAt: new Date().toISOString(),
  };
}

export async function buildDeck(idea, { wantImages = true } = {}) {
  // Our own page first. The map route stays for everywhere it does not cover —
  // it is slower, thinner and needs a search budget, but it works anywhere.
  const fromSite = await buildDeckFromSite(idea, { wantImages }).catch((e) => {
    console.error(`deck: tiyulplus route failed, falling back to the map — ${e.message}`);
    return null;
  });
  if (fromSite?.slides.length) return fromSite;

  const pool = await shortlist({ where: idea.where, kind: idea.kind, want: idea.want });

  const slides = [];
  const dropped = [];

  // Name only, always, on this route.
  //
  // It used to hunt an authority page per place and draft prose from it, which
  // is why "mountains in Italy" came back with nothing: a peak has no official
  // website, and the search landed on a cantonal news index. A mountain slide
  // carries its name — there is no claim to source, so there is nothing to
  // fail. The fields path stays for kinds that declare fields, and those still
  // quote an authority.
  const withFields = hasFields(idea.kind);

  for (const place of pool.places) {
    if (slides.length >= idea.want) break;

    const nameHe = place.labelHe || place.labelEn || place.name;
    const nameEn = place.labelEn || place.name;

    if (!withFields) {
      slides.push({
        n: slides.length + 1,
        nameHe,
        nameEn,
        fields: [],
        bullets: [],
        qid: place.qid,
        sourceUrl: place.officialUrl || null,
        sourceHost: place.officialUrl ? new URL(place.officialUrl).hostname.replace(/^www\./, '') : 'wikidata',
      });
      continue;
    }

    const found = await findPage(place, idea.searchTerms);
    if (!found.url) {
      dropped.push({ place: nameEn, why: found.why });
      continue;
    }

    let pageText = '';
    try {
      pageText = (await fetchReadable(found.url)).text || '';
    } catch (e) {
      dropped.push({ place: nameEn, why: `fetch failed: ${e.message}`, url: found.url });
      continue;
    }

    try {
      const slide = await draftFieldsFromEntry({ ...place, nameHe, nameEn }, pageText, idea.kind);
      slides.push({ ...slide, n: slides.length + 1, sourceUrl: found.url, via: found.via, domain: found.domain });
    } catch (e) {
      dropped.push({
        place: nameEn,
        why: e instanceof RejectedError ? `${e.reason}: ${String(e.detail || '').slice(0, 120)}` : e.message,
        url: found.url,
      });
    }
  }

  // Same curation and the same drop rule as the other route: a place whose
  // photograph cannot be found, or cannot be trusted to be that place, leaves.
  if (wantImages) {
    const coverSlot = {};
    await imagesForSlides(slides, idea.where, { cover: coverSlot });
    for (let i = slides.length - 1; i >= 0; i--) {
      if (slides[i].image) continue;
      dropped.push({ place: slides[i].nameEn, why: slides[i].imageMiss || 'no photograph' });
      slides.splice(i, 1);
    }
    slides.forEach((s, i) => {
      s.n = i + 1;
    });
    pool.coverImage = coverSlot.image || null;
  }

  // Written last, from the places that survived, exactly as on the other route.
  const cover = slides.length
    ? await coverForDeck({ where: idea.where, kind: idea.kind, slides, hint: idea.titleHe }).catch(() => null)
    : null;
  if (cover) {
    idea = { ...idea, ...cover };
  }

  return {
    kind: 'deck',
    idea,
    titleHe: idea.titleHe,
    where: idea.where,
    category: idea.kind,
    counts: { ...pool.counts, asked: idea.want, built: slides.length },
    area: pool.area,
    coverImage: pool.coverImage || null,
    shape: { bullets: false, why: 'map route carries names only' },
    slides,
    dropped,
    // A deck that came up short is still publishable — five is a target, not a
    // format requirement — but the approval card has to say it, because a
    // three-slide deck and a three-slide idea look identical afterwards.
    short: slides.length < idea.want,
    createdAt: new Date().toISOString(),
  };
}
