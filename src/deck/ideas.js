import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { KINDS, kindIds } from '../sources/places.js';

// What deck to make. The step before any data is fetched.
//
// The order matters and it is the opposite of the news pipeline's. There, a
// source publishes something and we decide whether it is worth a post. Here we
// decide what would be worth watching and then go and find out whether it can
// be sourced — which is how a person plans a channel, and the only way to
// arrive at "five markets in Osaka" when no feed has ever mentioned Osaka.
//
// The cost of that order is that an idea can turn out to be unsourceable, and
// several will. That is handled downstream by dropping slides and saying so,
// never by inventing the fact that was missing.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.IDEAS_EFFORT || 'medium';

let client = null;
const getClient = () => (client ??= new Anthropic());

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      description: 'Deck ideas, best first',
      items: {
        type: 'object',
        properties: {
          title_he: {
            type: 'string',
            description:
              'The cover slide, in Hebrew. Names the place and what the list is. No question marks, no "ידעתם ש", no filler adjectives.',
          },
          where: {
            type: 'string',
            description:
              'The region to search, in English, as a place a map would know: "Prague", "Kyoto", "Dolomites", "Osaka". Not a country unless the deck really is country-wide.',
          },
          kind: {
            type: 'string',
            enum: kindIds(),
            description: 'Which category of place this deck is made of',
          },
          want: { type: 'integer', description: 'How many places the deck should carry, 5 to 7' },
          angle_he: {
            type: 'string',
            description:
              'One Hebrew sentence: what a viewer gets from this that they would not get from a guidebook index.',
          },
          why_now: {
            type: 'string',
            description:
              'English. Why this month rather than any other — season, opening hours, a festival, weather. "no seasonal reason" is an acceptable and honest answer.',
          },
          search_terms: {
            type: 'array',
            description:
              'English search terms for finding each place page on an official site: the words that would appear in a title about the place, e.g. ["opening hours", "tickets", "visit"].',
            items: { type: 'string' },
          },
        },
        required: ['title_he', 'where', 'kind', 'want', 'angle_he', 'why_now', 'search_terms'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

const SYSTEM = `You plan slideshow posts for tiyul+, a Hebrew travel channel for Israeli travellers.

A deck is a TikTok photo slideshow: a cover slide that names the list, then one
slide per place with two to four short lines of fact — opening hours, ticket
price, how long it takes, how hard it is, what it is known for.

WHAT MAKES A GOOD DECK

A viewer should be able to act on it. "Five museums in Prague" is actionable;
"five beautiful places in Europe" is a screensaver. Name the city or the range,
not the continent.

The list has to have an organising idea beyond "these exist". The best ones
answer a question a traveller actually has: what is worth the ticket, what is
open on a Monday, what can be done in half a day, where locals eat, what is
walkable from the station.

Israeli travellers are the audience. Direct flights, kosher-adjacent practicality,
school holidays and the Jewish calendar are all legitimate reasons to choose a
destination — but the deck itself is about the place, not about being Israeli.

HARD CONSTRAINTS

Every fact on every slide will have to be quoted, word for word, from the
official website of the place itself or of the body that manages it. If a
category of place does not have official websites, the deck cannot be made.
Museums, temples, castles, galleries, markets, zoos and parks have them.
Waterfalls, beaches, viewpoints and most hiking routes usually do not — propose
those only when the places are managed by a park or regional authority that
publishes about them.

Do not propose a deck about a place that is at war, under evacuation, or where
the practical answer for a traveller right now is "do not go".

Do not repeat a deck that has already been published; the recent ones are listed.

VOICE

Hebrew, warm, specific, no hype. A cover that names a subject and withholds the
story beats one that narrates it. Hyphens, never em dashes.`;

export const hasApiKey = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * Ask for deck ideas.
 *
 * `recent` is what has already gone out — titles and regions — so the model can
 * avoid repeating itself. `season` is passed rather than computed inside the
 * prompt, because the model has no clock and a deck about cherry blossom in
 * October is the kind of mistake that reads as automation.
 */
export async function proposeIdeas({ count = 4, recent = [], today = new Date() } = {}) {
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set — idea generation is required');

  const month = today.toLocaleString('en-GB', { month: 'long' });
  const user = [
    `TODAY: ${today.toISOString().slice(0, 10)} (${month})`,
    `PROPOSE: ${count} deck ideas, ranked best first.`,
    '',
    'CATEGORIES AVAILABLE (a deck must be exactly one of these):',
    ...Object.entries(KINDS).map(([id, k]) => `  ${id} — ${k.he}`),
    '',
    recent.length
      ? ['ALREADY PUBLISHED (do not repeat, and avoid the same city twice in a row):', ...recent.map((r) => `  ${r}`)].join('\n')
      : 'ALREADY PUBLISHED: nothing yet.',
  ].join('\n');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: IDEAS_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new Error('idea generation refused');
  if (res.stop_reason === 'max_tokens') throw new Error('idea generation hit max_tokens');

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('idea generation returned no text');

  const parsed = JSON.parse(text);
  return (parsed.ideas || []).map(normaliseIdea).filter(Boolean);
}

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title_he: { type: 'string', description: 'The cover line, Hebrew, under 40 characters' },
    eyebrow_he: { type: 'string', description: 'The city or region in Hebrew, one or two words' },
    angle_he: { type: 'string', description: 'One Hebrew sentence under the title: what the viewer gets' },
    search_terms: {
      type: 'array',
      description: 'English words likely to appear in the title of an official page about such a place',
      items: { type: 'string' },
    },
  },
  required: ['title_he', 'eyebrow_he', 'angle_he', 'search_terms'],
  additionalProperties: false,
};

/**
 * A cover for a deck somebody asked for by name.
 *
 * `/deck Prague museum` used to title itself "Prague · museum", which is a
 * filename rather than a cover — English, in a Hebrew channel, naming a
 * category instead of promising anything. A deck the model chose gets a written
 * title; one you chose deserves the same.
 */
export async function titleForRequest({ where, kind, count = 5, today = new Date() }) {
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TITLE_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `TODAY: ${today.toISOString().slice(0, 10)}`,
          `A deck of ${count} ${KINDS[kind]?.he || kind} in ${where} has been requested by name.`,
          'Write its cover: the title line, the city in Hebrew, and the one-sentence angle.',
          'The title names the subject and withholds the story. It is not a question and it does not begin with "ידעתם".',
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('title generation returned no text');

  const parsed = JSON.parse(text);
  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  return {
    titleHe: clean(parsed.title_he),
    eyebrowHe: clean(parsed.eyebrow_he),
    angleHe: clean(parsed.angle_he),
    searchTerms: (parsed.search_terms || []).map(clean).filter(Boolean).slice(0, 4),
  };
}

/**
 * Everything the schema cannot state.
 *
 * `want` is clamped rather than trusted: the slide count is a format decision,
 * not a per-idea one, and a model that asks for eleven has misunderstood the
 * format rather than found a richer list.
 */
export function normaliseIdea(raw) {
  if (!raw?.title_he || !raw?.where || !KINDS[raw.kind]) return null;
  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  return {
    titleHe: clean(raw.title_he),
    where: clean(raw.where),
    kind: raw.kind,
    want: Math.min(7, Math.max(5, Number(raw.want) || 5)),
    angleHe: clean(raw.angle_he),
    whyNow: clean(raw.why_now),
    searchTerms: (raw.search_terms || []).map(clean).filter(Boolean).slice(0, 4),
  };
}
