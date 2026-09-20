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

const KEEP_SCHEMA = {
  type: 'object',
  properties: {
    keep: {
      type: 'array',
      description:
        'The NAME of each entry to keep, in the order given. The name only - the part before the dash, without the description that follows it.',
      items: { type: 'string' },
    },
    why: { type: 'string', description: 'Under fifteen words, English, on what was dropped and why' },
  },
  required: ['keep', 'why'],
  additionalProperties: false,
};

const KEEP_SYSTEM = `You are given entries from a travel guide's page about one destination.

Two questions, and an entry has to pass BOTH to be kept.

FIRST: is it a place at all?

Some entries are PLACES. Others are sections of the guide - advice about
flights, where to stay, when to visit, how to get around, or the destination
itself as a heading.

A place, for this purpose, is somewhere a traveller physically stands: a
temple, a lake, a quarter, a market, a peak, a museum, a beach. It can be
photographed, and a photograph of it would show something specific.

Drop, always:

  - the destination itself ("Kyoto", "Kyoto - the city")
  - anything about getting there: flights, airports, transfers, car hire
  - anything about planning: when to go, how long to stay, what it costs,
    where to sleep, what to pack
  - a region so broad that a photograph of it would show anything at all

This matters because each survivor becomes one slide with its name written
across a photograph. "Flights from Tel Aviv" as a slide in a slideshow about
Kyoto is the single most embarrassing thing this channel could publish, and it
happened, which is why you are being asked.

SECOND: is it the thing THIS deck is about?

The deck has a subject and it is stated below. Every slide has to be an example
of it. This is not a preference about balance - a deck titled "the most
beautiful mountains in Italy" that ends on a photograph of a market has told
the viewer something false, and that has happened too.

The guide files places into broad buckets, so the bucket cannot answer this and
you are seeing the names instead. Judge what the place IS:

  mountain   a thing that RISES: a peak, a summit, a massif, a ridge, and a
             named summit is still one when there is a terrace or a cable car
             on top of it. NOT a lake below it, not the valley it stands in,
             not the town you drive through to reach it, and obviously not a
             market or a museum in that town.
  trail      a walking route you follow from one end to the other. NOT the lake
             at the end of it and NOT the town the trailhead is in.
  waterfall  falling water. Nothing else.
  beach      a beach.
  museum     a museum or a gallery.
  food       a market, a food hall, a restaurant, a cafe.
  attraction the WIDEST of these, deliberately - it is the catch-all a city
             deck uses, and judging it narrowly empties good decks. Anything a
             traveller goes to in order to look at it: a castle, a palace, a
             temple, a church, a monument, a tower, a quarter, a square, a
             garden, a famous grove, a viewpoint, a bridge, a zoo. It does NOT
             have to be a building and it does NOT have to be old. Drop only
             what is plainly something else - a restaurant, a shop, a hotel, a
             station - or a whole separate town.

A NOTE ON HOW HARD TO PUSH. The failure being corrected is a market on a
mountain deck: a slide that makes the cover a lie. It is not "this is a
slightly odd choice". Drop what is the WRONG KIND OF THING, and keep what is
merely a weaker example of the right one.

When the name alone cannot settle it, the description is there. When it still
cannot be settled, keep it when the deck's subject is the catch-all one and
drop it otherwise - the narrow kinds are where a wrong slide shows.

Keep the good ones in the order given. Keeping very few, or none, is a correct
answer and often the right one: this page may simply not be about that subject.
Do not pad the list to make it look useful.`;

/**
 * The entries whose names the model asked to keep.
 *
 * Both sides are reduced to the name before any dash, because the entries go
 * out as "name — description" and come back in whichever of those two shapes
 * the model felt was meant by "the name". A place whose own name contains a
 * dash — "סאס פורדוי - מרפסת הדולומיטים" — reduces the same way on both sides,
 * so it still matches itself.
 *
 * Separate and exported because the failure it prevents is invisible: an
 * exact-string lookup against the wrong shape returns an empty list, which is
 * indistinguishable from "the model rejected everything", and Prague shipped
 * zero slides out of ten good ones before anybody noticed.
 */
export function keepByName(places, names) {
  const head = (s) =>
    String(s || '')
      .split(/\s+[—–-]\s+/)[0]
      .trim();
  const keep = new Set((names || []).map(head).filter(Boolean));
  return places.filter((p) => keep.has(head(p.nameHe)) || keep.has(String(p.nameHe).trim()));
}

/**
 * Which of these entries are actually places, and of the kind this deck wants.
 *
 * One call per deck, on the shortlist, before anything is drafted or any
 * photograph is fetched. Cheap, and it is the only thing standing between a
 * guide page's "Flights from Ben Gurion" section and a slide with those words
 * set across a photograph of Kyoto.
 *
 * It answers the second question because it is the only step that can. The
 * guide's categories are four or five broad buckets — a lake, a valley and a
 * summit are all "טבע" — so a category filter cannot tell a mountain deck from
 * a lake deck, and the Overpass tags that could are on the other route. What
 * this step has is the NAMES, which is what a person would use.
 */
export async function keepVisitable(places, { where, kind = null }) {
  if (places.length < 2) return places;

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: KEEP_SCHEMA } },
    system: [{ type: 'text', text: KEEP_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `DESTINATION: ${where}`,
          kind ? `THIS DECK IS ABOUT: ${kind}` : 'THIS DECK HAS NO SUBJECT - judge only whether each entry is a place.',
          '',
          'ENTRIES:',
          // The description as well as the name, because "אגם סוראפיס" and
          // "סאס פורדוי" are both two Italian words to anybody who has not been
          // there, and one of them is a lake.
          ...places.map((p) => `  ${p.nameHe}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ''}`),
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return places;

  // Matched on the NAME, however much of the line came back.
  //
  // The entries are handed over as "name — description" so the subject can be
  // judged, and asked for by name. A model that echoes the whole line instead
  // is not wrong about anything that matters, but an exact-string lookup finds
  // none of its answers and the deck silently becomes empty — which is what
  // happened to Prague: ten good quarters and castles kept, Kutná Hora
  // correctly dropped as a separate town, and zero slides built.
  //
  // A filter must never fail CLOSED because of a formatting detail, so the name
  // is taken off the front of whatever came back rather than demanded whole.
  const kept = keepByName(places, JSON.parse(text).keep || []);

  // With no subject asked for, a filter that removes everything has
  // misunderstood the list rather than found it all unusable, and an empty deck
  // is worse than an unfiltered one.
  //
  // WITH a subject, the opposite is true and the old guard was actively
  // harmful: "this page has no trails on it" is a correct and common answer,
  // and overriding it hands the deck back every market on the page. An empty
  // result here costs nothing — buildDeck falls through to the map route, whose
  // Overpass tags cannot return a market for a summit query.
  if (kind) return kept;
  return kept.length >= 2 ? kept : places;
}

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
