import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';

// Does this deck want anything under the name?
//
// Not a rule per category, because the right answer is not a property of the
// category. A mountain carries its name and nothing else — the photograph has
// already said everything, and a bullet about opening hours under a peak is
// absurd. A cathedral in a city is different: the picture shows a beautiful
// building and the viewer still does not know what it IS, so two short lines
// earn their place.
//
// Hardcoding that as trail=none, museum=bullets gets the common cases right and
// then fails on the interesting ones: a famous viewpoint in a city wants
// nothing, a hike with a genuinely strange story wants a line. So the deck
// decides for itself, once, and then every slide in it looks the same — the
// consistency within a deck is what makes it scan.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

let client = null;
const getClient = () => (client ??= new Anthropic());

const SCHEMA = {
  type: 'object',
  properties: {
    bullets: {
      type: 'boolean',
      description: 'True if every slide should carry one or two short lines under the place name.',
    },
    why: { type: 'string', description: 'Under twelve words, English' },
  },
  required: ['bullets', 'why'],
  additionalProperties: false,
};

const SYSTEM = `You decide whether one travel slideshow needs text under its place names.

THE DEFAULT IS NO.

A slide is a photograph and the name of what is in it. Every word added past
that competes with the picture, and the posts that work hardest at this add
nothing at all.

SAY NO when the photograph carries the whole idea:

  mountains, lakes, fjords, waterfalls, beaches, viewpoints, canyons, islands
  - anything where the answer to "what is it" is visible in the frame, and the
  only question left is "where is that". A name and a country is the entire
  slide.

SAY YES only when knowing the name leaves an obvious question unanswered:

  a building in a city, a museum, a market, a neighbourhood, a restaurant - a
  viewer sees a handsome facade and has no idea what is inside, what happened
  there, or why it is on a list. One or two short lines answer that.

If it is genuinely borderline, say no. A deck can always be re-run; a slide
overloaded with text is the thing being corrected here.`;

/**
 * One call per deck, before any bullets are drafted.
 *
 * Shown the place names rather than just the category, because "5 places in
 * Prague" made of viewpoints and "5 places in Prague" made of museums want
 * different answers and the category label is the same.
 */
export async function decideShape({ where, kind, places = [] }) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `DECK: ${kind} in ${where}`,
          '',
          'The places:',
          ...places.map((p) => `  ${p.nameHe}${p.category ? ` (${p.category})` : ''}`),
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return { bullets: false, why: 'no answer, defaulting to name only' };

  const parsed = JSON.parse(text);
  return { bullets: Boolean(parsed.bullets), why: String(parsed.why || '').slice(0, 80) };
}
