import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';

// Looking at the photographs before choosing one.
//
// Every version of this pipeline until now picked a photograph without ever
// seeing it: the libraries rank by their own relevance and popularity, and the
// only thing the code could read was the alt text. That is why decks came back
// with a tram wire across the frame, a construction tarp behind the spires, and
// something over the lens on the cover. None of that is visible in metadata.
//
// So the candidates are fetched as thumbnails and looked at. The rubric below
// is the whole point of the module — it is what "cinematic" means when it has
// to be applied a hundred times a week without taste being available.
//
// Cheap on purpose: 200px thumbnails, one call per slide, and only the winner
// is downloaded at full size.

const MODEL = process.env.CURATE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.CURATE_EFFORT || 'low';

let client = null;
const getClient = () => (client ??= new Anthropic());

const SCHEMA = {
  type: 'object',
  properties: {
    pick: {
      type: 'integer',
      description:
        'The 1-based number of the best photograph, or 0 if none of them both SHOWS THIS PLACE and is good enough.',
    },
    shows_place: {
      type: 'boolean',
      description:
        'True only if the chosen photograph actually depicts the named place - not merely the same city or region.',
    },
    band: {
      type: 'string',
      enum: ['top', 'middle', 'bottom'],
      description:
        'Which horizontal third of the CHOSEN photograph is emptiest - open sky, water, grass, snow - and can hold text without covering the subject.',
    },
    side: {
      type: 'string',
      enum: ['right', 'center', 'left'],
      description: 'Which side of that band is emptiest. "center" when the whole band is open.',
    },
    why: { type: 'string', description: 'Six words at most, English, on what decided it' },
  },
  required: ['pick', 'shows_place', 'band', 'side', 'why'],
  additionalProperties: false,
};

const SYSTEM = `You choose one photograph for a slide in a travel slideshow.

WHAT IS BEING LOOKED FOR

A photograph that makes somebody stop scrolling. In practice that means:

  - DEPTH. Something near, something far, a valley or a street receding. A flat
    wall photographed straight on is the opposite of this.
  - LIGHT. Golden hour, low sun, mist, dramatic sky. Flat midday light on a grey
    day is what a snapshot looks like.
  - A VANTAGE. Shot from above, from across a valley, from a hill. Eye level in
    a busy square is a tourist's photo.
  - ROOM AT THE TOP OR BOTTOM for text to sit in - sky, water, grass.

REJECT, and prefer a worse-composed photograph over any of these:

  - anything across the frame: wires, cables, scaffolding, a crane, a tarp
  - text, a watermark, a signboard, a logo
  - crowds of tourists, or a person posing for the camera
  - a flat building facade with no depth
  - obvious over-editing: neon-saturated skies, a fake-looking sunset

  - ANY large dark or blurred shape intruding at an edge or corner: a finger
    over the lens, a hat brim, a coat shoulder, an out-of-focus leaf or branch
    in the extreme foreground. Do not rationalise these as framing. Natural
    framing is sharp, recognisable and symmetrical - an arch, a window, a row
    of trees. A soft brown mass over the top of the sky is a thumb, and it is
    the single most common way a photograph that scores well on light and depth
    is nonetheless unusable.

A person walking away from camera, small in a landscape, is GOOD - it gives
scale and it is what the best travel posts do. A person facing the camera is a
portrait, and this is not a portrait.

IT MUST BE THIS PLACE

The slide names a place, and the photograph has to show THAT place - not another
building in the same city, not a nice view of the same country. A slide reading
"Strahov Monastery" over a photograph of a different baroque garden is the one
mistake that costs a travel page its credibility, and a viewer who has been
there spots it instantly.

If you are not confident the picture shows the named place, say 0. Being unsure
is itself the answer: a deck that drops a place is fine, a deck that mislabels
one is not.

WHERE THE TEXT WILL GO

Also say which third of the chosen picture is emptiest, and which side of it -
open sky, still water, a field of snow, a lawn. The words are placed there, so
this is not a note about composition; it decides whether the text lands on the
mountain or beside it.

If nothing here both shows the place and is worth looking at, say 0. The caller
tries another search and then drops the place, which is the correct outcome.`;

/**
 * Pick the most cinematic of several candidates.
 *
 * `thumbs` are small JPEG buffers in the same order as the candidates. Returns
 * a 0-based index, or null when none of them is good enough — which the caller
 * treats as "try another query", not as an error.
 */
export async function pickCinematic(thumbs, { place = '', where = '', placeEn = '', types = [] } = {}) {
  if (!thumbs.length) return null;

  const content = [
    {
      type: 'text',
      text: [
        `PLACE: ${place || placeEn || 'unknown'}${placeEn && place !== placeEn ? ` (${placeEn})` : ''}${
          where ? `, ${where}` : ''
        }`,
        `${thumbs.length} candidate${thumbs.length === 1 ? '' : 's'} follow${thumbs.length === 1 ? 's' : ''}, numbered from 1.`,
        'Pick the one that shows THIS PLACE and would stop a thumb, and say where its empty space is.',
      ].join('\n'),
    },
  ];

  for (const [i, buf] of thumbs.entries()) {
    content.push({ type: 'text', text: `${i + 1}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: types[i] || 'image/jpeg', data: buf.toString('base64') },
    });
  }

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return null;

  const parsed = JSON.parse(text);
  const pick = Number(parsed.pick);
  if (!Number.isInteger(pick) || pick < 1 || pick > thumbs.length) return null;

  // A picture it is not sure about is a picture we do not use. The deck can
  // afford to be one place shorter; it cannot afford to name a place and show
  // somewhere else.
  if (parsed.shows_place === false) return null;

  return {
    index: pick - 1,
    why: String(parsed.why || '').slice(0, 60),
    band: ['top', 'middle', 'bottom'].includes(parsed.band) ? parsed.band : 'bottom',
    side: ['right', 'center', 'left'].includes(parsed.side) ? parsed.side : 'center',
  };
}

// Words that turn a library search from "a picture of X" into "a picture worth
// looking at of X". Appended rather than replacing the place name, because the
// place still has to be in the frame.
//
// Not all at once: each is tried as its own query, so a place that has a famous
// aerial gets the aerial and a place that does not still gets its sunset.
export const CINEMATIC_TERMS = ['aerial view', 'golden hour', 'sunrise', 'landscape', 'viewpoint'];

/** Query variants for one place, most cinematic first. */
export function cinematicQueries(nameEn, where) {
  // Deduped: a cover asks for the city by name and the region IS the city, so
  // without this every cover query read "Prague Prague aerial view".
  const base = [...new Set([nameEn, where].filter(Boolean).flatMap((s) => s.split(/\s+/)))].join(' ');
  if (!base.trim()) return [];
  return [...CINEMATIC_TERMS.map((t) => `${base} ${t}`), base];
}
