import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';
import { KINDS, kindIds } from '../sources/places.js';
import { namesPlace } from './region.js';
import { loadDestinations } from '../sources/climate.js';

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

/**
 * The destinations this channel is actually for.
 *
 * destinations.json is 102 places across 61 countries, chosen — its own comment
 * says so — "for where Israelis actually fly, not for coverage of the globe".
 * Until now only the climate adapter read it, and the idea generator, which is
 * the one step that DECIDES where a post is set, had never seen it.
 *
 * That omission is most of why the feed drifted to Kyoto. Asked for a beautiful
 * travel slideshow with nothing but its own prior to go on, a model returns the
 * postcard answer; handed a list of places this audience books flights to, it
 * has somewhere better to start.
 *
 * A preference, not a whitelist. The Dolomites are not in the file and are a
 * perfectly good deck, and a list that forbade everything outside itself would
 * make the file a cage rather than a starting point.
 */
let destinationMenu = null;
function destinationsForPrompt() {
  if (destinationMenu) return destinationMenu;
  try {
    const rows = loadDestinations();
    destinationMenu = rows.map((d) => `  ${d.en} — ${d.he}, ${d.country}`).join('\n');
  } catch {
    // The file is optional as far as this call is concerned. A missing or
    // malformed catalogue should cost the grounding, never the idea.
    destinationMenu = '';
  }
  return destinationMenu;
}

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
          places_he: {
            type: 'array',
            description: 'The places the deck would carry, in Hebrew, in order, exactly `want` of them. Real, named, specific places a visitor could stand in - not categories and not districts. This is the PLAN shown to the owner before anything is built; the build sources its own places and may not find every one of these, so name the ones you are most confident actually exist and are known by these names.',
            items: { type: 'string' },
          },
        },
        required: ['title_he', 'where', 'kind', 'want', 'angle_he', 'why_now', 'search_terms', 'places_he'],
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

WHERE TO SET IT

A list of destinations this channel covers is supplied with the request. START
THERE. It is 102 places chosen for where this audience actually flies, and a
deck set in one of them is a deck someone reading this page might book.

It is a preference and not a whitelist. Somewhere not on the list is fine when
it is genuinely better — the Dolomites are not on it and make an excellent
deck — but "somewhere not on the list" should be a choice you could defend,
not the first place that came to mind. Asked for a beautiful travel slideshow
with nothing to go on, the honest answer is Kyoto every time, and a feed of
that is a feed about one city.

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
story beats one that narrates it. Hyphens, never em dashes.

HOW A COVER IS ACTUALLY WRITTEN

The cover is ONE short line. Five to eight words. These four are the spec — not
illustrations of a spec, the spec itself:

  הרים באיסלנד שלא נראים אמיתיים
  מקומות בשווייץ שאתם חייבים לראות לפני שזה מאוחר מדי
  המקומות הכי טובים בנורווגיה לראות את האורות הצפוניים
  המפלים הכי יפים בסקנדינביה

Read what they have in common, because it is the opposite of what a careful
writer reaches for.

NO COUNT. None of them says how many. "טופ 6" and "6 מקומות" are not wrong,
they are just rarely what this page sounds like, and they will be asked for
explicitly when they are wanted.

NAME WHERE IT IS. Every one of those four says where, and it is never optional.
A scroller who cannot tell which country the photograph is in has no reason to
save the post, and a deck of six Icelandic waterfalls titled "המפלים הכי יפים
בעולם" is not withholding a story, it is withholding the only fact that makes
the list usable.

The place is HANDED TO YOU with the deck and it is the only one you may use:

  every slide in one country  →  that country.        "באיסלנד", "בשווייץ"
  several countries, one area →  that area.           "בסקנדינביה", "בבלקן"
  nothing in common at all    →  "בעולם", and nowhere else.

Do not name a city, a valley or a national park instead of what you were given,
and do not add a second place beside it. One place, the one supplied.

A BROAD PLURAL NOUN opens it: הרים, מפלים, מקומות, חופים, ערים, כפרים. Not a
category from a database.

ONE STRONG CLAUSE, and it may be any of these:

  a superlative     — הכי יפים בעולם, הכי טובים ל...
  a picture         — שלא נראים אמיתיים, שנראים כמו סרט
  an obligation     — שאתם חייבים לראות, שאסור לפספס
  a time pressure   — לפני שזה מאוחר מדי, פעם אחת בחיים לפחות

Superlatives are welcome here. "הכי יפים בעולם" is a claim nobody can check and
everybody understands, and it is exactly how this kind of page talks.

THE CLAUSE HAS TO BE TRUE OF WHAT IS ACTUALLY ON THE SLIDES

"שלא נראים אמיתיים" and "שנראים כמו סרט" are claims about how somewhere LOOKS.
They belong to landscape. A deck of houses titled "מקומות בפורטוגל שלא נראים
אמיתיים" is contradicted by its own first swipe, and the swipe is the proof —
a cover is the one line a viewer checks against the pictures immediately.

  mountain, waterfall, beach, trail
      How it looks. Unreal, cinematic, the most beautiful, worth the walk.

  museum, attraction, food
      What it is worth and what you would do there. What is worth the ticket,
      what is open on a Monday, where locals actually eat.
      NEVER "does not look real" and never "like a film" - a museum does not
      look unreal, it looks like a building, and the photograph will say so.

If the strongest honest line for a category is quieter than you would like,
take the quieter line. A cover that oversells is found out in one swipe.

STOP WHEN THE LINE IS DONE

The commonest failure is not a bad opening, it is a good opening that keeps
going. "המקומות הכי טובים בנורווגיה לראות את האורות הצפוניים" is finished. Any
clause after it — what you will find there, how many there are, why now — is
the caption's job and belongs nowhere near the cover.

Read your line back and cut everything after the point where it could have
stopped. If two clauses both earn their place, you have written two covers and
should keep the better one.

A deck about something a photograph already shows does not need the photograph
described. An aurora deck is not "the skies that do not look real" — the sky is
in the picture. Name the place and what the list is FOR.

NEVER "פעם אחת בחיים" ON ITS OWN. It is always "פעם אחת בחיים לפחות" - the
bare form promises the place is a one-time visit, and the point of the line is
that it is worth going back to.

USE SIMPLE WORDS

  BAD:   המפלים באיסלנד שעוצרים לך את הנשימה
  GOOD:  המפלים הכי יפים באיסלנד

"עוצר נשימה", "חוויה בלתי נשכחת", "פנינה נסתרת", "קסום", "מרהיב", "ייחודי" are
advertising words. A person does not say them out loud and a scroller does not
read them.

ONE CLAUSE, AND NO COLON

A colon turns the line into a title and a subtitle, which is a magazine spread
and not a slide somebody sees for a second and a half:

  BAD:   סנטוריני שאתם לא מכירים: חורבות ומצודות מול הים
  GOOD:  הסנטוריני שאתם לא מכירים

No colon, no dash holding two halves together, no comma splicing a second
thought onto the first.

DO NOT NAME ONE PLACE FROM THE LIST

The cover is about the promise, not about slide four. Naming a single place
promises that one thing and makes the other five feel like padding. The country
or area the whole deck sits in is the opposite of that and is required; a
waterfall's name is not.

NO STATISTICS

How few people go, what time it opens, how long the queue is, how cold the
water is. Those belong on a slide. A cover wants something felt, not counted.

WHAT KILLS A COVER

Describing the MECHANISM instead of the appeal:

  BAD:  פסגות באלפים שמגיעים אליהן ברכבל
  GOOD: הפסגות הכי יפות באלפים

Nobody opens a slideshow because of how you get somewhere.

Also fatal: a neutral catalogue title ("מוזיאונים בפראג"), a question, "ידעתם
ש", and any attempt to be clever at the cost of being clear.

IF A COUNT IS ASKED FOR

Then the number is a NUMERAL and "טופ" is borrowed: טופ 5, טופ 3. Never spelled
out — "חמישה מוזיאונים" is how a newspaper writes. Count correctly; a deck of
four places does not say 5.

NEVER on a cover: a second explanatory line, a city label above the title, a
list of what the slides contain, opening hours, prices, or the words
"שעות פתיחה" in any arrangement whatsoever.`;

// The cover is written to a rotation, not left to the model's favourite.
//
// Told only to "vary it", a model asked once per deck has no memory of the last
// deck and converges on whichever phrasing it likes best — six decks in a row
// came back "טופ N ... שאסור לפספס". Variety across posts is a property of the
// SEQUENCE, and nothing inside a single call can see the sequence.
//
// These five shapes are the four covers the channel was specified by, plus the
// counted form for when it is wanted. An earlier version of this list was built
// around numbers and place names — "טופ 6 מקומות בקיוטו..." — and every cover it
// produced was rejected. The lesson is in the shapes now: most covers carry no
// count and name nowhere.
//
// Every shape carries the place now. Where it SITS in the line differs — after
// the noun for three of them, after the superlative for one, at the end for the
// counted one — and that is most of what keeps five covers in a row from
// reading as one template with the nouns swapped.
export const COVER_SHAPES = [
  {
    id: 'unreal',
    brief:
      'A plain plural noun, then the place, then a clause saying it does not look real. No "ה" on the noun, no count, and NO pronoun — "הרים באיסלנד שלא נראים אמיתיים", never "הרים שאתם לא תאמינו שהם אמיתיים".',
    voice: 'none',
    examples: ['הרים באיסלנד שלא נראים אמיתיים', 'מקומות בפורטוגל שנראים כמו סרט'],
  },
  {
    id: 'superlative',
    brief:
      'ה + plural noun + הכי + adjective + the place. The place closes the line, which is where this shape puts it. A flat claim, no pronoun.',
    voice: 'none',
    examples: ['המפלים הכי יפים באיסלנד', 'הכפרים הכי יפים באיטליה'],
  },
  {
    id: 'urgency',
    // The one shape that takes a pronoun. In the four covers this channel was
    // specified by, "אתם" appears exactly once and it is on the obligation.
    brief:
      'Plural noun + the place + שאתם חייבים לראות + a twist that puts time pressure on it. The place goes between the noun and the clause.',
    voice: 'you',
    examples: ['מקומות בשווייץ שאתם חייבים לראות לפני שזה מאוחר מדי', 'מפלים באיסלנד שחייבים לראות פעם אחת בחיים לפחות'],
  },
  {
    id: 'best-for',
    // The activity has to be something done with the body. "לגעת בעבר" came
    // back from an early run and is the failure this brief is guarding against:
    // an abstraction dressed up as an activity.
    brief:
      'ה + noun + הכי טובים + the place + a PHYSICAL thing you go there to do: see the northern lights, watch a sunrise, swim, ski, walk. Never an abstraction like "לגעת בעבר" or "להרגיש חופש".',
    voice: 'none',
    examples: ['המקומות הכי טובים בנורווגיה לראות את האורות הצפוניים', 'המקומות הכי טובים ביוון לראות זריחה'],
  },
  {
    id: 'top-n',
    // The one counted shape. It exists because the channel's own first example
    // was "טופ 4 פסגות שאסור לפספס באלפים" — one cover in five, not the default.
    brief: 'טופ + numeral + noun + a clause + the place at the end. The only shape that counts.',
    voice: 'you',
    examples: ['טופ 4 פסגות שאסור לפספס באלפים', 'טופ 5 מסלולים שאסור לפספס בסלובניה'],
  },
];

// Who the line talks to — a property of the SHAPE, not a second wheel spun
// beside it.
//
// Rotating the voice independently put "אתם" on a shape that has no room for
// it: "פסגות שאתם לא תאמינו שהן אמיתיות" where the spec says
// "הרים שלא נראים אמיתיים". In the four covers this channel was specified by,
// the pronoun appears exactly once, on the obligation — so that is where it
// lives.
export const COVER_VOICES = {
  you: { id: 'you', brief: 'Talk straight at them: אתם, לכם, שלכם.', example: 'מקומות שאתם חייבים לראות' },
  none: { id: 'none', brief: 'Impersonal. No pronoun at all.', example: 'המפלים הכי יפים בעולם' },
};

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
    // The catalogue, last, so it reads as the menu to choose from rather than
    // as background. Its absence is what left the model choosing from its own
    // prior, which for "a beautiful travel slideshow" is the postcard answer.
    destinationsForPrompt()
      ? ['', 'DESTINATIONS THIS CHANNEL COVERS — start here:', destinationsForPrompt()].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');

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

/**
 * Adjust a proposed deck, in the owner's own words.
 *
 * The instruction arrives as a Telegram reply — "make it autumn", "Osaka not
 * Kyoto", "six places, not five", "the angle is too guidebooky" — and is passed
 * through verbatim rather than parsed. Parsing it would mean guessing at a
 * grammar, and the whole reason this exists is that the alternative to guessing
 * is retyping the whole /deck command.
 *
 * Runs BEFORE anything is built, which is the only point at which a title is
 * still cheap to change: once a deck is rendered its cover is a JPEG with the
 * title baked into it, and toDeckCandidate has dropped the photograph it would
 * need to draw a new one.
 *
 * Deliberately conservative about what it touches. A reply that says nothing
 * about the region must not quietly relocate the deck — the owner is correcting
 * one thing, not re-commissioning it.
 */
export async function reviseIdea(idea, instruction, { today = new Date() } = {}) {
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set — revision needs it');
  const said = String(instruction || '').trim();
  if (!said) throw new Error('nothing to apply — the reply was empty');

  // A free-form idea is revised AS a free-form idea.
  //
  // This used IDEAS_SCHEMA for everything, and that schema has no concept of
  // free form — so "fix the title" on an aurora deck came back as a category
  // deck of attractions in Northern Norway: cable cars, a planetarium, two ice
  // hotels. A different post, from a request that asked for one line to change.
  //
  // Which kind of deck this is was decided when you typed /deck free. A
  // revision may change anything in it; it may not change what it is.
  if (idea.freeform) return reviseFreeform(idea, said, { today });

  const month = today.toLocaleString('en-GB', { month: 'long' });
  const user = [
    `TODAY: ${today.toISOString().slice(0, 10)} (${month})`,
    'REVISE the deck idea below and return exactly 1 idea.',
    '',
    'THE IDEA AS IT STANDS:',
    `  title_he: ${idea.titleHe}`,
    `  where: ${idea.where}`,
    `  kind: ${idea.kind}`,
    `  want: ${idea.want}`,
    `  angle_he: ${idea.angleHe || ''}`,
    `  why_now: ${idea.whyNow || ''}`,
    '',
    'CATEGORIES AVAILABLE (the revision must be exactly one of these):',
    ...Object.entries(KINDS).map(([id, k]) => `  ${id} — ${k.he}`),
    '',
    'WHAT THE OWNER REPLIED, VERBATIM:',
    said,
    '',
    'Change what was asked for and keep everything else as it is. If the reply',
    'says nothing about the region, the region does not move; if it says nothing',
    'about the category, the category does not change. A correction to the title',
    'is a correction to the title.',
  ].join('\n');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: IDEAS_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new Error('revision refused');
  if (res.stop_reason === 'max_tokens') throw new Error('revision hit max_tokens');

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('revision returned no text');

  const [revised] = (JSON.parse(text).ideas || []).map(normaliseIdea).filter(Boolean);
  // normaliseIdea returns null for a title, region or category it cannot use.
  // Failing here keeps the original proposal intact and answerable, rather than
  // replacing it with something half-formed that fails later during the build.
  if (!revised) throw new Error('the revision came back unusable — the idea is unchanged');
  return revised;
}

const FREEFORM_SCHEMA = {
  type: 'object',
  properties: {
    title_he: {
      type: 'string',
      description:
        'The cover, Hebrew, one short line, under 48 characters. Names where it is. Follows every cover rule in the brief, including that the clause must be true of what is on the slides.',
    },
    emphasis_he: {
      type: 'string',
      description: 'The phrase copied EXACTLY from title_he that is set in colour. Under 16 characters.',
    },
    where_en: {
      type: 'string',
      description: 'The region or country these places are in, in English, for the image search. "Norway", "Lofoten", "Iceland".',
    },
    subject_en: {
      type: 'string',
      description:
        'What the PHOTOGRAPHS have to show, in English, two or three words. This is added to every image search and the chooser is told to reject a frame that does not show it. For "northern lights in Norway" it is "northern lights" - NOT "Norway" and NOT "landscape". Name the thing a viewer came to look at.',
    },
    country_he: { type: 'string', description: 'The country in Hebrew, as Israelis write it. Empty if they span countries.' },
    places: {
      type: 'array',
      description:
        'Five to seven real, named, specific places that answer the request. Somewhere a visitor can stand. NOT categories, NOT regions, NOT phenomena - for "northern lights in Norway" these are the towns and viewpoints people actually go to, not "the aurora".',
      items: {
        type: 'object',
        properties: {
          name_he: { type: 'string', description: 'The place in Hebrew, as Israelis write it' },
          name_en: { type: 'string', description: 'The same place in English, as a map would know it - used to find a photograph' },
          note_he: {
            type: 'string',
            description:
              'At most four words, Hebrew, or empty. Something a photograph cannot say: "מעל הקוטב הצפוני". NOT a sentence and NOT a claim that needs checking - a free-form deck carries no sourced facts.',
          },
        },
        required: ['name_he', 'name_en', 'note_he'],
        additionalProperties: false,
      },
    },
  },
  required: ['title_he', 'emphasis_he', 'where_en', 'subject_en', 'country_he', 'places'],
  additionalProperties: false,
};

/**
 * A deck from a request the categories cannot express.
 *
 * The ordinary route finds places by OpenStreetMap tag, which is why `kind` is
 * one of seven: each maps to an Overpass query. "Northern lights" is not a kind
 * of PLACE, so that route had nothing to map it to, picked the nearest category
 * and silently built something else.
 *
 * Here the model names the places instead. What makes that acceptable is what
 * the deck then carries: NAMES AND PHOTOGRAPHS, NO FACTS. Every fact on an
 * ordinary slide is quoted from an official page because a wrong opening time
 * is a wrong claim; a free-form slide claims nothing, so there is nothing to
 * verify and nothing to get wrong.
 *
 * The one risk left is a place that does not exist, and the image curator
 * already refuses that: it is told to answer 0 when it cannot confirm the
 * photograph shows the named place, and a place with no photograph is dropped.
 * An invented name therefore costs a slide rather than producing a false one.
 */
export async function freeformIdea(request, { today = new Date() } = {}) {
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set');
  const asked = String(request || '').trim();
  if (!asked) throw new Error('nothing was asked for');

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: FREEFORM_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `TODAY: ${today.toISOString().slice(0, 10)}`,
          "",
          'THE REQUEST, VERBATIM:',
          asked,
          "",
          'This deck is FREE FORM: the categories cannot express what was asked, so you',
          'name the places yourself. It will carry names and photographs only - no opening',
          'hours, no prices, no facts of any kind - so choose places that are worth looking',
          'at and that a photograph will obviously be of.',
          "",
          'Answer the request as it was made. Do not substitute a nearby subject you find',
          'easier: a request for the northern lights is about where to see them.',
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new Error('free-form idea refused');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('free-form idea returned no text');

  const parsed = JSON.parse(text);
  const clean = (v) => String(v || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const places = (parsed.places || [])
    .map((p) => ({ nameHe: clean(p.name_he), nameEn: clean(p.name_en), noteHe: clean(p.note_he) }))
    .filter((p) => p.nameHe && p.nameEn)
    .slice(0, 7);
  if (places.length < 3) throw new Error(`only ${places.length} usable places came back`);

  return {
    freeform: true,
    asked,
    titleHe: clean(parsed.title_he),
    emphasisHe: clean(parsed.emphasis_he),
    whereEn: clean(parsed.where_en),
    // What the pictures must be OF. A deck about the northern lights whose
    // slides are daytime fjords is a deck about fjords — the names were right
    // and every photograph answered a different question.
    subjectEn: clean(parsed.subject_en),
    countryHe: clean(parsed.country_he),
    places,
    want: places.length,
  };
}

/**
 * Revise a free-form idea without turning it into something else.
 *
 * Same schema it was made with, so what comes back is still names, photographs
 * and a subject. The places are handed back in and kept unless the instruction
 * is about them — "fix the title" should cost the title and nothing else.
 */
async function reviseFreeform(idea, said, { today = new Date() } = {}) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: FREEFORM_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          `TODAY: ${today.toISOString().slice(0, 10)}`,
          "",
          'THE ORIGINAL REQUEST, VERBATIM:',
          idea.asked,
          "",
          'THE FREE-FORM DECK AS IT STANDS:',
          `  title_he: ${idea.titleHe}`,
          `  emphasis_he: ${idea.emphasisHe}`,
          `  where_en: ${idea.whereEn}`,
          `  subject_en: ${idea.subjectEn}`,
          ...idea.places.map((p, i) => `  ${i + 1}. ${p.nameHe} / ${p.nameEn}${p.noteHe ? ` (${p.noteHe})` : ''}`),
          "",
          'WHAT THE OWNER REPLIED, VERBATIM:',
          said,
          "",
          'Change what was asked and keep everything else EXACTLY as it is. A reply',
          'about the title changes the title and leaves the places alone, in order,',
          'with their notes. This stays a free-form deck: names and photographs, no',
          'facts.',
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  if (res.stop_reason === 'refusal') throw new Error('revision refused');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('revision returned no text');

  const parsed = JSON.parse(text);
  const clean = (v) => String(v || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const places = (parsed.places || [])
    .map((p) => ({ nameHe: clean(p.name_he), nameEn: clean(p.name_en), noteHe: clean(p.note_he) }))
    .filter((p) => p.nameHe && p.nameEn)
    .slice(0, 7);

  return {
    ...idea,
    titleHe: clean(parsed.title_he) || idea.titleHe,
    emphasisHe: clean(parsed.emphasis_he) || idea.emphasisHe,
    whereEn: clean(parsed.where_en) || idea.whereEn,
    subjectEn: clean(parsed.subject_en) || idea.subjectEn,
    // Fewer than three back means the revision lost the deck rather than
    // changing it — keep what was there.
    places: places.length >= 3 ? places : idea.places,
    want: places.length >= 3 ? places.length : idea.want,
  };
}

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title_he: {
      type: 'string',
      description:
        'The cover, Hebrew, under 48 characters. Counts the places and names the destination. The ONLY text on the cover.',
    },
    emphasis_he: {
      type: 'string',
      description:
        'The phrase copied EXACTLY from title_he that is set in colour. Take the phrase that paints the picture - "שנראים כמו סרט", "שלא נראות אמיתיות" - rather than the destination, because that is the part the eye should land on. Keep it under 16 characters so it holds on one line.',
    },
    place_he: {
      type: 'string',
      description:
        'The place named inside title_he, copied EXACTLY as it appears there, preposition included: "באיסלנד", "בסקנדינביה", "בעולם". Empty string only if the deck was told to name nowhere.',
    },
    eyebrow_he: { type: 'string', description: 'Unused. Return an empty string.' },
    angle_he: { type: 'string', description: 'Unused. Return an empty string.' },
    search_terms: {
      type: 'array',
      description: 'English words likely to appear in the title of an official page about such a place',
      items: { type: 'string' },
    },
    places_he: {
      type: 'array',
      description: 'The places the deck would carry, in Hebrew, in order, exactly `want` of them. Real, named, specific places a visitor could stand in - not categories and not districts. This is the PLAN shown to the owner before anything is built; the build sources its own places and may not find every one of these, so name the ones you are most confident actually exist and are known by these names.',
      items: { type: 'string' },
    },
  },
  required: ['title_he', 'emphasis_he', 'place_he', 'eyebrow_he', 'angle_he', 'search_terms', 'places_he'],
  additionalProperties: false,
};

/**
 * One line, not a title and a subtitle.
 *
 * "The cover is ONE line of text" has been in the brief from the beginning and
 * a cover still came back as "סנטוריני שאתם לא מכירים: חורבות ומצודות מול הים".
 * The half before the colon is almost always the line that was wanted, so it is
 * kept — and only when it can stand on its own, because half of a short title
 * is not a title.
 */
export const oneClause = (line) => {
  // Comma as well as colon. Told not to use a colon, the next cover came back
  // as "הסנטוריני שאתם לא מכירים, חורבות ומצודות" — the same two halves held
  // together by different punctuation. The rule is one thought, so it is the
  // splice that is banned rather than the character.
  const cut = String(line || '').split(/\s*[:|,،]\s*/)[0].trim();
  return cut.length >= 12 ? cut : String(line || '');
};

/**
 * The phrase to set in colour, when the model's own choice did not survive.
 *
 * The emphasis has to appear in the title verbatim or the renderer cannot find
 * it, and cutting a comma splice can take the model's chosen phrase away with
 * the half it removed — which left one cover with no coloured phrase at all.
 * The closing clause is what should be coloured anyway, so it is recoverable:
 * in Hebrew that clause almost always opens with ש, and failing that the last
 * two words carry it.
 */
export function emphasisFrom(title) {
  const line = String(title || '').trim();
  if (!line) return '';

  const words = line.split(/\s+/);
  const at = words.findLastIndex((w) => /^ש/.test(w) && w.length > 2);
  if (at > 0) {
    const clause = words.slice(at).join(' ');
    if (clause.length <= 22) return clause;
  }

  const tail = words.slice(-2).join(' ');
  return tail.length <= 22 && words.length > 2 ? tail : '';
}

/**
 * Which shape, voice and picture this cover uses.
 *
 * A COUNTER, not a hash of the deck — and that took two attempts to get right.
 *
 * Hashing the deck made the choice stable across re-runs, which sounded
 * valuable and is not: the deck id is built from the region, the category and
 * the place ids, deliberately NOT from the title, precisely so the cover can be
 * rewritten without the deck counting as a different deck. Nothing needed the
 * stability.
 *
 * What it cost was real. Seven decks drawing independently from six buckets
 * clustered — four landed on the same picture, and two came back with the
 * identical closing phrase, which is the exact complaint the rotation exists to
 * answer. Hashing harder does not fix that; independent draws collide, and with
 * seven samples they collide often.
 *
 * A counter cannot collide. Consecutive posts step through the list, and
 * because the three lists are different lengths the combination does not repeat
 * for thirty decks. `n` comes from how many decks have already gone out.
 */
export function rotationFor(n = 0) {
  const i = Math.max(0, Math.trunc(Number(n) || 0));
  return {
    shape: COVER_SHAPES[i % COVER_SHAPES.length],
    voice: COVER_VOICES[COVER_SHAPES[i % COVER_SHAPES.length].voice],
  };
}

/**
 * The paragraph that tells the cover where the deck is.
 *
 * Written from the slides rather than from the idea, and handed down as a
 * single instruction with no choice in it. The earlier version passed the
 * country as a hint — "use it if the region is a name travellers would not
 * recognise" — and the model, reading a brief three paragraphs above that said
 * covers name nowhere, declined every time. Six Icelandic waterfalls went out
 * under "מפלים שאתם חייבים לראות פעם אחת בחיים".
 */
function whereBrief(place) {
  if (place?.scope === 'country') {
    return [
      `WHERE THIS DECK IS: ${place.he}. Every place on it is in that one country,`,
      'so the cover says so. This is not optional and it is not a hint: a cover',
      `for these slides that does not carry "${place.he}" is wrong.`,
    ];
  }
  if (place?.scope === 'region') {
    return [
      `WHERE THIS DECK IS: ${place.he}. The places are spread over more than one`,
      'country, but they all sit in that one area, and the area is what a viewer',
      `reads as the destination. The cover says "${place.he}" and does NOT name`,
      'any of the individual countries.',
    ];
  }
  return [
    'WHERE THIS DECK IS: nowhere in particular. These places have no country and',
    'no region in common, so the cover names none of them - "בעולם" is the only',
    'place word available to it.',
  ];
}

export async function coverForDeck({
  where,
  kind,
  slides = [],
  hint = '',
  countryHe = null,
  place = null,
  nth = 0,
}) {
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set');

  // Seeded on what the deck IS, so a rebuild of the same deck writes the same
  // cover and the next deck writes a different-shaped one.
  const { shape, voice } = rotationFor(nth);

  // `countryHe` is the old single-country hint, kept working for callers that
  // have not been taught to compute a place: one country is what it always
  // meant.
  const spot = place || (countryHe ? { scope: 'country', he: countryHe } : { scope: 'none', he: null });
  const wanted = spot.scope === 'none' ? null : spot.he;

  const ask = [
    `A deck about ${where} is finished. It has ${slides.length} places, in this order:`,
    '',
    ...slides.map((s, i) => `${i + 1}. ${s.nameHe}`),
    '',
    hint ? `The working title was: ${hint}` : null,
    '',
    `Write its cover: ONE line describing THESE places - if they are castles`,
    'and squares it is not a deck about museums. It must carry a reason to',
    'care, not a description of how you get there.',
    '',
    ...whereBrief(spot),
    '',
    `SHAPE FOR THIS ONE: ${shape.brief}`,
    ...shape.examples.map((e) => `  ${e}`),
    '',
    `VOICE FOR THIS ONE: ${voice.brief}`,
    `  ${voice.example}`,
    'Let the voice shape the sentence; do not wedge a pronoun into a',
    'comparison. "שנראים כמו אגדה" is right and "שנראים לכם כמו אגדה" is',
    'not — if the voice does not fit naturally, write the line without it.',
    '',
    'Use that shape and that voice. They rotate between posts so the page',
    'does not read as a template; this is the turn for these two.',
    '',
    'Five to eight words. Simple words, nothing a person would not say out',
    'loud. Unless the shape is the counted one, do NOT put a number on it.',
    '',
    'Then copy the phrase that carries the hook out of it, character for',
    'character, as the emphasis, and the place word out of it as place_he.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const write = async (messages) => {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TITLE_SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    recordUsage(res.usage, MODEL);
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('cover generation returned no text');
    return { raw: text, parsed: JSON.parse(text) };
  };

  const turns = [{ role: 'user', content: ask }];
  let { raw, parsed } = await write(turns);

  const clean = (s) => String(s || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();

  // The colon rule, enforced rather than requested.
  //
  // "One line, not a title plus a subtitle" has been in the brief from the
  // beginning and a cover still came back as
  // "סנטוריני שאתם לא מכירים: חורבות ומצודות מול הים". The half before the
  // colon is almost always the line that was wanted, so it is kept — and only
  // if it can stand on its own, because half of a short title is not a title.
  let titleHe = oneClause(clean(parsed.title_he));

  // Checked, not requested, for the same reason the colon rule is.
  //
  // One correction only. A model that has been shown its own line and told
  // which word is missing fixes it on the first try or is not going to; a loop
  // here would spend four calls to arrive at the same place, and the fallback
  // is a cover that is merely vaguer than it should be rather than a broken
  // deck.
  if (wanted && !namesPlace(titleHe, wanted)) {
    turns.push({ role: 'assistant', content: raw });
    turns.push({
      role: 'user',
      content: [
        `That cover does not say where these places are. It has to carry "${wanted}".`,
        '',
        'Write it again, same shape and same voice, with the place in it. Do not',
        'lengthen the line to make room - drop an adjective if you need the words.',
      ].join('\n'),
    });
    const retry = await write(turns).catch(() => null);
    if (retry) {
      const second = oneClause(clean(retry.parsed.title_he));
      if (namesPlace(second, wanted)) {
        titleHe = second;
        parsed = retry.parsed;
      } else {
        console.error(`deck: cover would not name ${wanted} — keeping "${titleHe}"`);
      }
    }
  }

  return {
    titleHe,
    // Copied out of the title rather than invented, so the renderer can find it
    // in the string and set it louder. A phrase that is not in the title is
    // dropped rather than appended — including one that only survived in the
    // half of the line the colon rule just removed.
    emphasisHe: titleHe.includes(clean(parsed.emphasis_he))
      ? clean(parsed.emphasis_he)
      : emphasisFrom(titleHe),
    eyebrowHe: '',
    angleHe: '',
  };
}

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
    places: (parsed.places_he || []).map(clean).filter(Boolean).slice(0, 8),
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
    // The places the deck INTENDS to carry, shown on the proposal so the
    // decision you make there is about content rather than about a title. Not
    // a promise: the build sources its own places from the site or the map, and
    // may not find every one of these. The approval card after the build is
    // where the real list appears.
    places: (raw.places_he || []).map(clean).filter(Boolean).slice(0, 8),
  };
}
