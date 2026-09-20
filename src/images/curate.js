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
    subject: {
      type: 'integer',
      description:
        'How much of the frame the named thing itself occupies, 0-10. 8+ means it dominates and is unmistakable. 3 means it is somewhere in the picture if you know where to look. Be strict.',
    },
    why: { type: 'string', description: 'Six words at most, English, on what decided it' },
  },
  required: ['pick', 'shows_place', 'subject', 'why'],
  additionalProperties: false,
};

// How prominent the named thing has to be before a photograph is worth using.
//
// Tuned against a real failure: a deck of Alpine summits came back with a
// picture of a bird against cloud with a snowfield along the bottom edge, and
// another where the peak was a grey wedge behind a valley full of trees and a
// farmhouse. Both genuinely were the right mountain; neither showed it. A
// viewer cannot tell a slide labelled "Eiger" is the Eiger if the Eiger is
// eight percent of the frame, and a slideshow of near-misses is worse than a
// shorter one.
// Five rather than six: at six, three well-known Kyoto temples in a row came
// back with no usable photograph at all and left a deck of three. The bird and
// the valley score two or three, which is what this is for; a temple sharing
// its frame with a courtyard scores five and is a perfectly good slide.
const MIN_SUBJECT = Number(process.env.CURATE_MIN_SUBJECT || 5);

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

AND IT MUST ACTUALLY SHOW IT

Being the right place is not enough. The named thing has to be the SUBJECT -
large in the frame, unmistakable, the thing your eye lands on first. Score that
in the subject field, out of ten, and be hard about it.

  9  the peak fills the frame, lit, nothing competing with it
  6  clearly the subject, but sharing the frame with a village or a valley
  3  it is in there somewhere, behind trees, small, low in the corner
  0  a bird, a cloud, a lake that happens to be near it

A picture of a mountain range with a bird in the sky and a snowfield along the
bottom edge is a photograph of a bird. A valley with a farmhouse, trees, a road
and a grey summit somewhere at the back is a photograph of a valley. Both of
those shipped on slides that named a mountain, and they are the reason this
field exists. When the best candidate is a 4, say 0 and let the caller look
again - there is always another query, and a slide that does not show its own
subject is not worth the place it takes.

Between two that both show the place, take the one that shows it BIGGER, even
if the smaller one has nicer light.

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
        'Pick the one that shows THIS PLACE, large in the frame, and would stop a thumb.',
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

  // Nor one where the place is technically present and visually absent. Refused
  // here rather than in the prompt alone, because "be strict" is advice and a
  // threshold is a rule — and the caller's response to null is exactly right:
  // try the next query, then drop the place.
  const subject = Number(parsed.subject);
  if (Number.isFinite(subject) && subject < MIN_SUBJECT) return null;

  return {
    index: pick - 1,
    why: String(parsed.why || '').slice(0, 60),
    subject: Number.isFinite(subject) ? subject : null,
  };
}

// Words that turn a library search from "a picture of X" into "a picture worth
// looking at of X". Appended rather than replacing the place name, because the
// place still has to be in the frame.
//
// Not all at once: each is tried as its own query, so a place that has a famous
// sunrise gets the sunrise and a place that does not still gets its bare name.
export const CINEMATIC_TERMS = ['golden hour', 'sunrise', 'landscape', 'viewpoint', 'aerial view'];

/**
 * Query variants for one place, and the ORDER is the load-bearing part.
 *
 * The bare name goes first. It used to go last, behind "aerial view", and that
 * single ordering is why summit decks came back with photographs of valleys:
 * "Eiger aerial view" returns a drone shot of the Bernese Oberland in which the
 * Eiger is one grey shape among several, while "Eiger" returns the north face.
 * The library is better at the plain noun than at our adjectives, and the
 * curator's own light-and-depth rubric is what earns the cinematic result — it
 * does not need the query to beg for one.
 */
export function cinematicQueries(nameEn, where) {
  // Deduped: a cover asks for the city by name and the region IS the city, so
  // without this every cover query read "Prague Prague golden hour".
  const base = [...new Set([nameEn, where].filter(Boolean).flatMap((s) => s.split(/\s+/)))].join(' ');
  if (!base.trim()) return [];

  const bare = String(nameEn || '').trim();
  // The name on its own, then the name with the region for disambiguation,
  // then the cinematic variants for a place that returned nothing usable.
  return [...new Set([bare, base, ...CINEMATIC_TERMS.map((t) => `${base} ${t}`)].filter(Boolean))];
}
