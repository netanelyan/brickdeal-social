import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The photograph on a slide.
//
// This is the hardest part of the format to automate and the owner's own
// teardown of the reference account says so outright. What makes @lego_from_ali
// read as a hobbyist sharing a find rather than a store running an ad is that
// the pictures are his own builds, photographed in his own home: a white wall,
// an IKEA shelf, daylight, other sets visible beside it, sometimes a hand in
// frame. A marketplace catalogue image will look like a catalogue image no
// matter what type is laid over it, and a slide that looks like an
// advertisement is a slide nobody watches.
//
// So the picture is generated: the product photo of the thing the link actually
// sells, restaged as a photograph somebody took at home. The prompt below is
// the owner's own, from the `brickdeal-product-shot-prompt` skill, where every
// constraint in it was added to fix a real failure. It is reproduced rather
// than paraphrased for that reason.
//
// THREE RULES THIS FILE ENFORCES, none of them optional:
//
//   1. Build from the photo of the product the affiliate link SELLS, not the
//      nicer official render of the original set. That is the skill's first
//      house rule, and the failure it prevents — a post showing one product
//      while the link sells another — is the one that causes refunds, angry
//      comments and affiliate complaints whatever the caption says.
//   2. Check what came back. A generated image that is not the same model is
//      worse than a catalogue shot, because it is a catalogue shot's problem
//      plus a false claim. Same guard, and largely the same prompt, as
//      brickdeal-automation's setImage.js.
//   3. Never silently substitute. A failure falls back to the product photo
//      with its provenance CHANGED, so the approval message says the slide is
//      a catalogue shot and the decision to publish it anyway is made by a
//      person looking at it.

const MODEL = process.env.IMAGE_GEN_MODEL || 'gemini-2.5-flash-image';
const VERIFY_MODEL = process.env.IMAGE_VERIFY_MODEL || 'claude-haiku-4-5-20251001';
const ENDPOINT = process.env.IMAGE_GEN_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';

const CACHE_DIR = process.env.SHOT_CACHE_DIR
  ? resolve(process.env.SHOT_CACHE_DIR)
  : fileURLToPath(new URL('../../data/shots/', import.meta.url));

export const configured = () => Boolean(process.env.IMAGE_GEN_API_KEY);

export class ShotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShotError';
  }
}

/**
 * How the model is held, from its real size.
 *
 * Straight out of the skill's size bands. The hold is what carries scale in a
 * still photograph — a set balanced on a flat palm reads as a trinket whatever
 * its actual dimensions — so getting this wrong makes a large set look cheap,
 * which is the opposite of the post's argument.
 */
export function holdFor({ sizeCm, theme }) {
  if (theme === 'flowers') {
    return {
      hold: 'The fingers are wrapped around the stems, with the blooms held above the hand.',
      fraction: 'a third',
      landmark: 'the base of the blooms',
    };
  }
  if (!sizeCm || sizeCm < 15) {
    return {
      hold: "An adult man's hand holds the model in the fingers, close to the camera.",
      fraction: 'most',
      landmark: 'the far edge of the model',
    };
  }
  if (sizeCm <= 40) {
    return {
      hold: "An adult man's hand, palm up, holds the model from underneath.",
      fraction: 'one third',
      landmark: 'a third of the way across it',
    };
  }
  return {
    hold: 'The model rests on a desk with one open hand beside it for scale.',
    fraction: 'a quarter',
    landmark: 'a quarter of the way across it',
  };
}

/**
 * The still prompt, filled in.
 *
 * Reproduced from the skill verbatim apart from the substitutions. The `Avoid:`
 * list is the longest part of it and the most load-bearing: it is what stops
 * the output reading as a 3D render, which is the default failure mode when you
 * ask an image model for a photograph of a plastic model.
 *
 * `no text, watermark, brand names, logos, lettering on the model` is in there
 * twice over for a reason that is ours rather than the skill's — a generated
 * logo on a generated clone set would be a trademark on a slide, which is the
 * one thing src/brick/copy.js exists to prevent and cannot see.
 */
export function stillPrompt({ nameHe, sizeCm, theme, colours = 'the colours and distinctive parts visible in the attached photo' }) {
  const { hold, fraction, landmark } = holdFor({ sizeCm, theme });
  const length = sizeCm ? `${Math.round(sizeCm)} cm` : 'about 25 cm';

  return `Using the brick-built model in the attached photo, generate a photorealistic vertical 9:16 photo, shot casually on an iPhone in a bedroom at night.

${hold} Only the hand and a small part of the wrist are visible, entering the frame from the bottom edge. No forearm, no elbow, no arm filling the frame. The palm and fingers make full flat contact with the underside, which sits solidly and heavily on the hand.

Scale: the model is ${length} long and the hand spans only about ${fraction} of its length, fingertips reaching no further than ${landmark}, so it looks big and heavy. The hand and the model are the same distance from the camera, so perspective does not enlarge the hand.

The model matches the attached photo exactly: ${colours}, matte plastic with sharp crisp edges on every brick, clearly visible seams between panels, defined stud edges with small shadows in the gaps.

Framing: the camera is at the model's own height, looking straight at its side, not down at it. The model is the subject, filling about two thirds of the frame width, entirely inside the frame, positioned slightly off center. The camera is not perfectly level, tilted a degree or two, the way a person holds a phone.

Background: a real bedroom at night, tidy but unplanned, photographed from an angle rather than straight on, so the furniture runs at a slight diagonal and objects are partly cut off by the edges of the frame. Ordinary things a person has, a wardrobe, a shelf, a desk edge, a chair, arranged by life and not by a photographer. Nothing centered behind the model, nothing symmetrical, nothing that looks placed for the shot.

Light: the room is dim. No lamp in the frame, no bright glow or hotspot on the wall, no light source behind the model. The background sits in soft shadow with only a faint cool glow off to one side. The model is the brightest thing in the photo, lit softly from the front, from the camera side.

Focus: the model and hand are perfectly sharp. The background is clearly out of focus with soft, even blur, objects reading as simple shapes but not melted into abstract color. Natural lens falloff, not a cutout effect.

Slightly uneven exposure, faint sensor noise in the shadows, no color grading, no studio lighting. Looks like a real photo someone took at home, calm and quiet, not a product advertisement.

Avoid: smoothed or melted brick surfaces, rounded soft edges, 3D render look, CGI look, high camera angle, looking down at the model, visible roof or top, oversized hand, hand close to the camera, small toy scale, symmetrical composition, centered background object, staged scene, empty grey wall, studio look, bright background, lamp in frame, glowing wall, backlight, forearm, arm, elbow, messy clutter, sharp background, portrait mode cutout, floating model, cropped model, deformed hand, extra fingers, two hands, text, watermark, brand names, logos, lettering on the model.`;
}

/**
 * The product photo to build from, and which of the two it was.
 *
 * `sourceImage` present means the bot swapped `image` for the official render.
 * The render is the prettier picture and the wrong one — see rule 1 above.
 */
export const sourceFor = (deal) =>
  deal.sourceImage
    ? { url: deal.sourceImage, kind: 'seller photo' }
    : { url: deal.image, kind: deal.setId ? 'possibly an official render' : 'seller photo' };

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new ShotError(`product photo ${url} returned HTTP ${res.status}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(type)) throw new ShotError(`product photo ${url} is ${type}, not an image`);
  return { base64: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: type.split(';')[0] };
}

async function generate(prompt, photo) {
  const url = `${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(process.env.IMAGE_GEN_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ inline_data: { mime_type: photo.mime, data: photo.base64 } }, { text: prompt }],
        },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ShotError(`image generation failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  const inline = part?.inlineData || part?.inline_data;
  if (!inline?.data) {
    // A refusal comes back as a text part rather than an error, and reporting
    // it as "no image" hides the one thing that would explain it.
    const said = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join(' ');
    throw new ShotError(`image generation returned no image${said ? `: ${said.slice(0, 200)}` : ''}`);
  }

  // The MIME TYPE TRAVELS WITH THE BYTES, and dropping it is what broke this
  // pipeline end to end.
  //
  // This model returns PNG. Every caller downstream assumed JPEG — the verify
  // call declared image/jpeg, the cache was written as .jpg, the data URI said
  // image/jpeg — and the verify call is the one that cannot survive the guess:
  // the API compares the declared type against the actual bytes and refuses the
  // whole request with a 400. Which the verifier caught and reported as "did
  // not show the same model", so a transport error wore the costume of a
  // judgement and every generated photograph was discarded for months.
  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return { bytes: Buffer.from(inline.data, 'base64'), mime };
}

const VERIFY_PROMPT = `Image 1 is a marketplace seller's photo of a brick-building set. Image 2 is a generated photo that is supposed to show the SAME built model, restaged in a room.

Is the model in image 2 the same build as image 1? Judge by the built model itself: shape, colours, main features, figures. Ignore background, lighting, angle, the hand, and photo quality. A different set from the same franchise, a different scale, or a different vehicle/building of the same kind is NOT a match. If image 2 does not show a built model at all, it is NOT a match.

Return ONLY a JSON object, no markdown: {"match": true or false}`;

/**
 * Does the generated photo show the set the link sells?
 *
 * Any failure — no key, an API error, an unparseable answer — is a "no", never
 * a pass. The fallback costs us a nicer photograph; a false pass costs a post
 * that shows one product and sells another.
 *
 * BUT IT SAYS WHICH KIND OF NO IT IS, and that is not a nicety. This returned a
 * bare boolean, so a 400 from a malformed request was indistinguishable from
 * the model looking at two pictures and saying they differ — and the caller
 * reported both as "did not show the same model". The request was malformed for
 * every image ever generated here, and the lie in that sentence is the only
 * reason it went unnoticed: the pipeline looked like it was working and making
 * a judgement, when it was failing and inventing one.
 *
 * Fail closed, always. Explain accurately, always.
 */
export async function verifySameModel(sourceUrl, generatedBase64, mime = 'image/png') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { match: false, why: 'no ANTHROPIC_API_KEY, so nothing can check the photo' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: VERIFY_MODEL,
        max_tokens: 30,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: sourceUrl } },
              // The type the bytes ACTUALLY are. The API compares the two and
              // refuses the request outright when they disagree.
              { type: 'image', source: { type: 'base64', media_type: mime, data: generatedBase64 } },
              { type: 'text', text: VERIFY_PROMPT },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { match: false, why: `the check could not run: HTTP ${res.status} ${body.slice(0, 160)}` };
    }
    const data = await res.json();
    let text = (data.content || []).map((b) => b.text || '').join('').trim();
    text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
    const match = JSON.parse(text).match === true;
    return { match, why: match ? null : 'the photo does not show the same model' };
  } catch (e) {
    return { match: false, why: `the check could not run: ${e.message}` };
  }
}

const cacheStem = (productId, n = 1) => join(CACHE_DIR, `${String(productId).replace(/[^\w.-]/g, '-')}-${n}`);

/**
 * The type the bytes really are, read from the bytes.
 *
 * Nothing that hands us an image can be trusted to describe it: the model's
 * declared type was being dropped, the marketplace serves .png URLs as webp,
 * and the shots already sitting in the cache are PNGs with a .jpg extension.
 * The first four bytes are the only source here that cannot be wrong.
 */
function sniffMime(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  return 'image/png';
}

const extFor = (mime) => (mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png');

/** A cached shot under any extension it may have been written with. */
function cachedShot(stem) {
  for (const ext of ['.png', '.jpg', '.webp']) {
    if (existsSync(stem + ext)) {
      const buf = readFileSync(stem + ext);
      return { buf, mime: sniffMime(buf) };
    }
  }
  return null;
}

/**
 * A home shot for one deal, cached on disk.
 *
 * Generation is slow and costs money per image, and a deck gets rebuilt — a
 * proposal revised, a render re-run after a stylesheet change — so a shot that
 * has already been paid for and passed its check is reused. `n` lets a
 * single-set post ask for several different shots of the same deal.
 *
 * Returns `{ src, provenance, note }`. `provenance` is the field images.js
 * prints on the approval message, and it is the difference between a slide the
 * owner approved knowing it was generated and one they did not.
 */
export async function homeShot(deal, { n = 1, sizeCm = null, force = false } = {}) {
  const stem = cacheStem(deal.productId, n);
  if (!force) {
    const hit = cachedShot(stem);
    if (hit) {
      return { src: `data:${hit.mime};base64,${hit.buf.toString('base64')}`, provenance: 'generated', note: 'cached' };
    }
  }

  const source = sourceFor(deal);
  if (!source.url) throw new ShotError('the deal has no photograph to build from');
  if (!configured()) throw new ShotError('IMAGE_GEN_API_KEY is not set');

  const photo = await fetchImage(source.url);
  const prompt = stillPrompt({ nameHe: deal.product, sizeCm, theme: deal.theme });

  // One retry and no more. The skill's own troubleshooting list is a set of
  // prompt EDITS a person makes after looking at the output, which is not
  // something this can do — so the second attempt is the same prompt against a
  // stochastic model, and a third would only be spending money on the same
  // coin flip.
  let lastWhy = null;
  for (const attempt of [1, 2]) {
    let made;
    try {
      made = await generate(prompt, photo);
    } catch (e) {
      lastWhy = e.message;
      continue;
    }

    const { bytes, mime } = made;
    const base64 = bytes.toString('base64');
    const verdict = await verifySameModel(source.url, base64, mime);
    if (!verdict.match) {
      // The reason, not a guess at it. "did not show the same model" was
      // printed here for every failure of any kind, including the one that was
      // actually happening.
      lastWhy = `attempt ${attempt}: ${verdict.why}`;
      continue;
    }

    const file = stem + extFor(mime);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
    return { src: `data:${mime};base64,${base64}`, provenance: 'generated', note: `from the ${source.kind}` };
  }

  throw new ShotError(lastWhy || 'image generation produced nothing usable');
}

/**
 * A home shot, or the product photo with its provenance told truthfully.
 *
 * The caller that wants a picture no matter what. The fallback is the whole
 * point of the shape: a deck still builds when generation is unavailable or
 * refuses, and what changes is the word on the approval message rather than
 * anything silent.
 */
export async function shotOrProduct(deal, opts = {}) {
  try {
    return await homeShot(deal, opts);
  } catch (e) {
    const source = sourceFor(deal);
    if (!source.url) throw e;
    return { src: source.url, provenance: 'stock', note: `catalogue photo — ${e.message}` };
  }
}

export const __test = { cacheStem, cachedShot, sniffMime, extFor, CACHE_DIR };
