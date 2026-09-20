import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';

// Where the empty background is, as a rectangle.
//
// This is the one question in the placement pipeline that arithmetic could not
// answer, and it took four attempts to accept that. The rule being implemented
// is "put the words in the sky or on the water, never across the mountain, the
// temple or the village" — and smoothness, which is what pixels can measure, is
// not the same property. Measured on a real frame, the shaded north face of the
// Eiger came out CALMER than the sky above it. A detector was then built that
// grew regions from the frame edge with a colour predicate; it leaked from blue
// sky into the snowfield the sky was touching and called 72% of the photograph
// background.
//
// Sky-versus-subject is a semantic judgement. A model makes it instantly and
// costs about a cent on a 320px thumbnail, which is a rounding error against
// the curation call that already looked at this photograph.
//
// What the model does NOT decide is where exactly the text sits, what colour it
// is, or how hard the shadow works. It returns a region; render/photo.js then
// searches inside it with the same measurements as before and can reject it
// outright if it turns out to be busy or low-contrast. Semantics from the
// model, arithmetic from the pixels.

const MODEL = process.env.TEXTBOX_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.TEXTBOX_EFFORT || 'low';

let client = null;
const getClient = () => (client ??= new Anthropic());

const SCHEMA = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description: 'False when the frame is filled edge to edge and there is no empty background at all.',
    },
    x0: { type: 'number', description: 'Left edge of the empty region, 0 at the left of the frame, 1 at the right.' },
    y0: { type: 'number', description: 'Top edge, 0 at the top of the frame, 1 at the bottom.' },
    x1: { type: 'number', description: 'Right edge, greater than x0.' },
    y1: { type: 'number', description: 'Bottom edge, greater than y0.' },
    what: {
      type: 'string',
      description: 'What that region is, in three words or fewer: "clear blue sky", "open water", "pale cloud".',
    },
  },
  required: ['found', 'x0', 'y0', 'x1', 'y1', 'what'],
  additionalProperties: false,
};

const SYSTEM = `You are given one photograph that is about to have a place name written across it.

Return the rectangle where those words should go.

WHAT YOU ARE LOOKING FOR

Empty BACKGROUND: open sky, plain cloud, still water, a blank field of snow that
is clearly sky-side rather than the mountain itself. Somewhere the eye reads as
nothing.

WHAT YOU MUST NOT RETURN

Any part of the SUBJECT. If the photograph is of a mountain, the rectangle does
not touch the mountain. If it is a temple, it does not touch the temple. If it
is a village on a shore, it does not touch the village — the water beside it is
correct, the rooftops are not.

This is the entire point of the question. A rectangle that is technically smooth
but sits across the peak is the wrong answer, and it is the answer that keeps
being given, because a snowfield looks calm. Calm is not the test. Being the
thing BEHIND the subject is the test.

HOW BIG

Big enough to hold two lines of text with air around them: at least a quarter of
the frame's width and a tenth of its height. Prefer the largest clean region
over a marginally cleaner small one, and prefer a region that is generously
clear of the subject over one that just grazes past it.

Give the rectangle of the clean area itself, not a tight box around where you
imagine the words. The caller decides the exact position inside it.

IF THERE IS NONE

A close-up of a facade, a forest filling the frame, a crowd — some photographs
genuinely have nowhere. Set found to false. The caller darkens a patch and
writes there instead, which is the right outcome and much better than a
confident rectangle across somebody's face.`;

/**
 * The empty region of one photograph, or null.
 *
 * `thumb` is a base64 JPEG at 320px wide, produced by the same Chromium pass
 * that measures the frame — the image has been decoded there already, so the
 * thumbnail is nearly free and keeps the token cost of this call small.
 *
 * Returns nulls rather than throwing on every failure path. A missing hint
 * costs a worse-placed slide; a throw would cost the deck.
 */
export async function findTextRegion(thumb, { place = '' } = {}) {
  if (!thumb) return null;

  let res;
  try {
    res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1000,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumb } },
            {
              type: 'text',
              text: place
                ? `This slide is titled "${place}". Where do the words go?`
                : 'Where do the words go?',
            },
          ],
        },
      ],
    });
  } catch (e) {
    console.error(`textbox: ${e.message}`);
    return null;
  }

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return null;

  const parsed = JSON.parse(text);
  if (!parsed.found) return null;

  const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
  const box = { x0: clamp(parsed.x0), y0: clamp(parsed.y0), x1: clamp(parsed.x1), y1: clamp(parsed.y1), what: parsed.what };

  // A degenerate or absurdly small rectangle is a misunderstanding rather than
  // an answer, and the pixel fallback is better than honouring it.
  if (box.x1 - box.x0 < 0.15 || box.y1 - box.y0 < 0.06) return null;
  return box;
}
