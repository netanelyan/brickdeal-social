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
      description: 'The 1-based number of the best photograph, or 0 if none of them is good enough',
    },
    why: { type: 'string', description: 'Six words at most, English, on what decided it' },
  },
  required: ['pick', 'why'],
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

If every candidate is a plain snapshot, say 0. A slide with a weak photograph is
worse than one that falls back, and the caller handles 0 properly.`;

/**
 * Pick the most cinematic of several candidates.
 *
 * `thumbs` are small JPEG buffers in the same order as the candidates. Returns
 * a 0-based index, or null when none of them is good enough — which the caller
 * treats as "try another query", not as an error.
 */
export async function pickCinematic(thumbs, { place = '', where = '' } = {}) {
  if (!thumbs.length) return null;
  if (thumbs.length === 1) return 0;

  const content = [
    {
      type: 'text',
      text: [
        `PLACE: ${place || 'unknown'}${where ? `, ${where}` : ''}`,
        `${thumbs.length} candidates follow, numbered from 1.`,
        'Pick the one that would stop a thumb. It must also plausibly show this place.',
      ].join('\n'),
    },
  ];

  for (const [i, buf] of thumbs.entries()) {
    content.push({ type: 'text', text: `${i + 1}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
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
  return { index: pick - 1, why: String(parsed.why || '').slice(0, 60) };
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
