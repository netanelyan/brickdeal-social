import Anthropic from '@anthropic-ai/sdk';
import { record as recordUsage } from '../usage.js';

// Every name on a slide, in Hebrew.
//
// The channel is Hebrew and the slides were shipping "Piz Bernina" and
// "Aletschhorn" in Latin, which is the most visible possible sign that nobody
// looked at the post before it went out. It happened for a dull reason:
// Wikidata has a Hebrew label for the famous places and not for the rest, and
// the code fell back to the English label whenever the Hebrew one was missing.
//
// A fallback to English is the wrong shape of fallback. The right one is to
// transliterate, which is what an Israeli writing about the place would do, and
// which a model is genuinely good at — it is a spelling task in a language with
// settled conventions, not a judgement call.
//
// The guard afterwards matters as much as the call. A name that comes back
// still containing Latin letters is not used, and the place is dropped: a deck
// one slide shorter is a small cost, and it is paid once, whereas an English
// name on a Hebrew slide is the thing being fixed.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

let client = null;
const getClient = () => (client ??= new Anthropic());

const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;

/**
 * Is this a Hebrew name we are willing to print?
 *
 * Hebrew letters present and no Latin ones. Digits and punctuation are fine —
 * "K2" would fail this and that is the correct answer for a channel that writes
 * "קיי 2"; a genuinely numeric name can be added to the exceptions when one
 * turns up rather than by loosening the rule for everything.
 */
export const isHebrew = (s) => {
  const t = String(s || '').trim();
  return Boolean(t) && HEBREW.test(t) && !LATIN.test(t);
};

const SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      description: 'One entry per place, in the order given.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id exactly as supplied' },
          name_he: {
            type: 'string',
            description:
              'The place name in Hebrew letters only. Empty string if you are not confident how Israelis write it.',
          },
        },
        required: ['id', 'name_he'],
        additionalProperties: false,
      },
    },
  },
  required: ['names'],
  additionalProperties: false,
};

const SYSTEM = `You write place names in Hebrew for an Israeli travel channel.

You are given place names in Latin script. Return each one as an Israeli would
write it in Hebrew. This is spelling, not translation.

THE ESTABLISHED NAME WINS

Where Hebrew already has a settled name for a place, use it - even when it is
not what the letters would give you.

  Mont Blanc      -> מון בלאן
  Matterhorn      -> מאטרהורן
  Jungfrau        -> יונגפראו
  Dolomites       -> הדולומיטים
  Lake Bled       -> אגם בלד
  Cinque Terre    -> צ׳ינקווה טרה

TRANSLITERATE THE REST, BY SOUND

Follow how the name is pronounced in ITS OWN language, not how it looks in
English. That is the difference between a name an Israeli recognises and one
that looks like it was typed by a machine.

  Piz Bernina     -> פיץ ברנינה
  Aletschhorn     -> אלטשהורן
  Seceda          -> סצ׳דה
  Grossglockner   -> גרוסגלוקנר
  Chamonix        -> שמוני            (French: the x is silent)
  Zermatt         -> צרמט

DO NOT TRANSLATE THE MEANING

A name is a name. "Lago di Braies" is אגם בראייס, never "האגם של בראייס"; a
"Horn" stays הורן and does not become קרן. The only words that translate are the
generic ones Hebrew always translates: Lake -> אגם, Mount -> הר, Valley -> עמק.

FORM

Hebrew letters only. No Latin characters anywhere in the answer, not even for a
number or a roman numeral. No nikud. No explanation.

If you do not know how Israelis write a particular place and cannot work it out
from its own language's pronunciation, return an empty string for it. An empty
answer costs one slide; a guess that reads wrong costs the channel's voice.`;

/**
 * Hebrew names for a list of places, in one call.
 *
 * Keyed by qid so the caller can look each one up without relying on the model
 * returning them in order — it usually does, and "usually" is not good enough
 * when the consequence is a mountain labelled with a different mountain's name.
 *
 * Places that already have a Hebrew label on Wikidata are not sent: that label
 * is better than anything this can produce, and every one omitted is tokens not
 * spent.
 */
export async function hebrewNames(places) {
  const out = new Map();
  const need = places.filter((p) => !p.labelHe && (p.labelEn || p.name));
  if (!need.length) return out;

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          'Write each of these in Hebrew:',
          '',
          ...need.map((p) => `${p.qid}: ${p.labelEn || p.name}`),
        ].join('\n'),
      },
    ],
  });

  recordUsage(res.usage, MODEL);
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) return out;

  for (const row of JSON.parse(text).names || []) {
    const name = String(row.name_he || '').trim();
    // The guard, applied to the model's own answer. Asking for Hebrew only and
    // checking for Hebrew only are different things, and the second one is what
    // actually keeps Latin off a slide.
    if (row.id && isHebrew(name)) out.set(row.id, name);
  }
  return out;
}
