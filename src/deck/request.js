import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { KINDS, kindIds } from '../sources/places.js';
import { canonicalKind } from '../sources/tiyulplus.js';

// What "/deck Italy mountains" actually means.
//
// The old parser was one line: take the last word, look it up in a synonym
// table, treat everything before it as the region. It works for exactly the
// shape it was written for and fails silently for everything else — an unknown
// last word came back unchanged, went into the Overpass query as a category
// that does not exist, and the command answered with a stack trace's worth of
// "unknown kind: alps".
//
// Which is the real problem: the command is supposed to answer with a
// slideshow. Somebody typing "/deck japan autumn" at midnight has told us
// plenty; refusing on a grammar technicality is the worst possible response.
//
// So: try the cheap parse, and when it does not land, ask. One low-effort call
// turns any phrase — Hebrew, English, a country, a mood — into a region a map
// knows and a category the pipeline has. It is the difference between a command
// that works when you phrase it correctly and one that works.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

let client = null;
const getClient = () => (client ??= new Anthropic());

const SCHEMA = {
  type: 'object',
  properties: {
    where: {
      type: 'string',
      description:
        'The region to search, in English, as a place a map would know: "Prague", "Dolomites", "Bernese Alps", "Kyoto". Narrow enough to have a bounding box worth searching - a country is acceptable only when the deck really is country-wide.',
    },
    kind: { type: 'string', enum: kindIds(), description: 'Which category of place this deck is made of' },
    want: { type: 'integer', description: 'How many places the deck should carry, 4 to 7' },
    title_he: { type: 'string', description: 'A working cover line in Hebrew. It will be rewritten later.' },
    alternatives: {
      type: 'array',
      description:
        'Two other category/region pairs worth trying if the first comes back thin, best first. At least one of them MUST name a different region from the main answer - a thin region is thin in every category, so a same-region fallback fails the same way the first attempt did.',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string' },
          kind: { type: 'string', enum: kindIds() },
        },
        required: ['where', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['where', 'kind', 'want', 'title_he', 'alternatives'],
  additionalProperties: false,
};

const SYSTEM = `You turn a short request for a travel slideshow into something buildable.

The request comes from the person who runs the channel, typed quickly, in
Hebrew or English, and it may be a region, a category, both, a season, or a
vague mood. Your job is to return a REGION a map can resolve and a CATEGORY
from the list, every time.

THE REGION

It has to be somewhere OpenStreetMap has a bounding box for, and small enough
that the places inside it belong on one list. "The Alps" is a real answer;
"Europe" is not. When a country is named and it is large, narrow to the part
travellers mean: Italy + mountains is the Dolomites, Japan + temples is Kyoto,
Switzerland + peaks is the Bernese Alps.

THE CATEGORY

Exactly one, from the list given. Choose the one the region is actually known
for when the request does not say - a request naming only "Santorini" is a
deck about viewpoints, not about museums.

THE ALTERNATIVES

Two fallbacks, in case the first search comes back thin.

The FIRST may be a different category in the same region. The SECOND must name
a DIFFERENT REGION - a neighbouring one, or the nearest better-known place of
the same sort.

That rule exists because of a real failure: a request for the Amalfi Coast came
back with three fallbacks all set on the Amalfi Coast, the map had nothing
tagged there, and all three failed identically. If a region is thin, every
category in it is thin, and only a different region gets out of that.

Do not repeat the first answer.

NEVER refuse. There is always a defensible region and category for any request.
If the request is a single word with no category at all, pick the thing that
place is most famous for and say so in the title.`;

/**
 * The cheap parse: does the phrase already name a category we have?
 *
 * Tried from both ends because both are things people type — "/deck Prague
 * museum" and "/deck mountains Italy" are the same request. Returns null when
 * neither end is a category, which is when the model is worth paying for.
 */
export function parseLocally(arg) {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const last = canonicalKind(parts[parts.length - 1]);
  if (KINDS[last]) return { where: parts.slice(0, -1).join(' '), kind: last, via: 'parsed' };

  const first = canonicalKind(parts[0]);
  if (KINDS[first]) return { where: parts.slice(1).join(' '), kind: first, via: 'parsed' };

  return null;
}

/**
 * Any request to an idea that can actually be built.
 *
 * `want` is clamped rather than trusted: the slide count is a format decision,
 * not a per-request one.
 */
export async function resolveRequest(arg, { today = new Date() } = {}) {
  const local = parseLocally(arg);

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `TODAY: ${today.toISOString().slice(0, 10)}`,
          '',
          'CATEGORIES AVAILABLE:',
          ...Object.entries(KINDS).map(([id, k]) => `  ${id} — ${k.he}`),
          '',
          `REQUEST: ${arg}`,
          local
            ? `\nA plain reading of that gives region "${local.where}", category "${local.kind}". Use it unless the region is too broad to search, in which case narrow it.`
            : '\nIt does not name a category outright. Work out what was meant.',
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) {
    // The model is the fallback, not the only path. If it fails and the plain
    // parse worked, the plain parse is still a perfectly good request.
    if (local) return { ...local, want: 5, titleHe: '', alternatives: [] };
    throw new Error('could not work out what to build');
  }

  const parsed = JSON.parse(text);
  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();

  return {
    where: clean(parsed.where) || local?.where || '',
    kind: KINDS[parsed.kind] ? parsed.kind : local?.kind || 'attraction',
    want: Math.min(7, Math.max(4, Number(parsed.want) || 5)),
    titleHe: clean(parsed.title_he),
    via: local ? 'parsed+checked' : 'interpreted',
    alternatives: (parsed.alternatives || [])
      .filter((a) => a?.where && KINDS[a.kind])
      .map((a) => ({ where: clean(a.where), kind: a.kind }))
      .slice(0, 2),
  };
}
