import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headroomOf } from '../render/headroom.js';

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
// The frame the slides are cut to. Overridable only because the day this
// pipeline renders something that is not 9:16, the photograph has to follow.
const ASPECT_RATIO = process.env.IMAGE_GEN_ASPECT || '9:16';
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
  // A HAND IS ONLY ALLOWED TO BE HOLDING SOMETHING.
  //
  // Each band now carries its own `contact` sentence. That sentence used to be
  // one hardcoded line appended to all three — "the palm and fingers make full
  // flat contact with the underside, which sits solidly and heavily on the
  // hand" — which contradicted the band it mattered most for: a large set was
  // asked to rest on a DESK and to sit flat on a PALM in the same breath. The
  // model split the difference and produced what shipped, a 45cm car balanced
  // across an open palm, which reads as neither held nor put down.
  //
  // An open hand lying next to a model is worse than no hand at all. It is a
  // hand doing nothing, and the eye reads it as a mistake.
  if (theme === 'flowers') {
    return {
      hold: 'The fingers are wrapped around the stems, gripping them, with the blooms held above the hand.',
      contact: 'The fingers close right around the stems and take their weight.',
      fraction: 'a third',
      landmark: 'the base of the blooms',
    };
  }
  if (!sizeCm || sizeCm < 15) {
    return {
      hold: "An adult man's hand holds the model, gripped between the fingers and thumb.",
      contact: 'The fingers are closed on it and clearly carrying it. It is held, not balanced.',
      fraction: 'most',
      landmark: 'the far edge of the model',
    };
  }
  if (sizeCm <= 40) {
    return {
      hold: "An adult man's hand, palm up, carries the model from underneath, fingers curled up around its near edge.",
      contact:
        'The palm makes full contact with the underside and the fingertips curl over the edge, so it is visibly being carried rather than resting on an open flat hand.',
      fraction: 'one third',
      landmark: 'a third of the way across it',
    };
  }
  // Too big for one hand to hold convincingly, so nothing holds it. NO HAND IN
  // THE FRAME AT ALL: scale comes from the ordinary objects around it, which is
  // how a person photographs something they cannot pick up one-handed anyway.
  return {
    hold: 'The model sits on a desk. NO HAND and no part of a person is anywhere in the frame.',
    contact:
      'It rests on the desk surface on its own wheels or base, with an everyday object near it — a keyboard, a mug, a phone — giving the scale instead.',
    fraction: 'a quarter',
    landmark: 'a quarter of the way across it',
  };
}

/**
 * The still prompt, filled in.
 *
 * Reproduced from the skill apart from the substitutions and the light. The
 * `Avoid:` list is the longest part of it and the most load-bearing: it is what
 * stops the output reading as a 3D render, which is the default failure mode
 * when you ask an image model for a photograph of a plastic model.
 *
 * THE ONE DELIBERATE DEPARTURE FROM THE SKILL IS THE LIGHT. It staged the shot
 * in a bedroom at night with the room dim and the model the only lit thing in
 * it, which is a genuinely good-looking photograph and the wrong one for this.
 * A slide is watched at thumbnail size in a feed, where a dark frame is a dark
 * smudge that gets scrolled past before the set in it is legible, and the type
 * laid over it has to fight the one bright area for the same attention. So the
 * room is bright and the light is daylight.
 *
 * THE SECOND DEPARTURE IS THE HEADROOM PARAGRAPH, and it is here because a
 * slide is not a photograph — it is a photograph with four lines of Hebrew
 * across the top of it. Everything downstream was written assuming this shot
 * leaves empty room above the model for those lines to sit in, and nothing in
 * the prompt ever asked for it: the only framing instruction was about WIDTH
 * ("filling about two thirds of the frame width"), which a car obeys and a
 * bouquet held up in the fist does not. Tall subjects came back filling the
 * frame top to bottom and the type landed on them.
 *
 * It is stated as a fraction of the frame rather than as "leave space", because
 * a fraction is the only form of it that survives the 4:5 crop — see the
 * anchor note in render/sizes.js, which is the other half of the same fix.
 *
 * THE WIDTH RULE NOW GIVES WAY TO THE HEIGHT RULE, which is the part the first
 * version of this got wrong. Asking for two thirds of the width AND the lower
 * two thirds of the height is not one instruction, it is two, and for a tall
 * narrow subject they contradict: a bouquet two thirds of the frame wide is
 * taller than the frame. The model resolved that contradiction the way it was
 * written, width first, and a deck went out with the type across a nightshade
 * plant, a Christmas tree and a bunch of tulips. So the width is now explicitly
 * the one that yields.
 *
 * `insist` HARDENS IT FOR A SECOND ATTEMPT, and is only ever passed after the
 * first one came back measurably wrong — see the headroom gate in homeShot()
 * below. Two thirds becomes a half, and the rule moves to the top of the
 * prompt, where instructions carry more weight than they do six paragraphs
 * down.
 *
 * WHAT DID NOT CHANGE IS THE MODEL ITSELF. A set that is black is photographed
 * black — the whole pipeline exists to show the thing the link sells, and rule
 * 1 above outranks how a frame looks. What the prompt asks for is that a dark
 * set be lit and legible rather than sitting in shadow, which is a lighting
 * instruction; "make the subject brighter" would be a different set.
 *
 * `no text, watermark, brand names, logos, lettering on the model` is in there
 * twice over for a reason that is ours rather than the skill's — a generated
 * logo on a generated clone set would be a trademark on a slide, which is the
 * one thing src/brick/copy.js exists to prevent and cannot see.
 */
export function stillPrompt({
  nameHe,
  sizeCm,
  theme,
  colours = 'the colours and distinctive parts visible in the attached photo',
  insist = false,
}) {
  const { hold, contact, fraction, landmark } = holdFor({ sizeCm, theme });
  const length = sizeCm ? `${Math.round(sizeCm)} cm` : 'about 25 cm';
  const handed = !hold.includes('NO HAND');

  return `Using the brick-built model in the attached photo, generate a photorealistic vertical 9:16 photo, shot casually on an iPhone in a bright room during the day.
${
  insist
    ? `
THE MOST IMPORTANT THING ABOUT THIS PHOTO IS HOW MUCH SPACE IS ABOVE THE MODEL. The whole model sits inside the BOTTOM HALF of the frame. Its highest point — the topmost leaf, petal, flower, tip, aerial, spire, anything that sticks up — is below the halfway line of the frame, and the entire top half of the frame is empty: plain wall, or the far side of the room, out of focus, with nothing in it at all. The photographer stood well back. The model is therefore SMALLER in the frame than it would otherwise be, and that is correct and deliberate. Do not fill the frame with it.
`
    : ''
}
${hold}${
    handed
      ? ' Only the hand and a small part of the wrist are visible, entering the frame from the bottom edge. No forearm, no elbow, no arm filling the frame.'
      : ''
  } ${contact}

Scale: the model is ${length} long${
    handed
      ? ` and the hand spans only about ${fraction} of its length, fingertips reaching no further than ${landmark}, so it looks big and heavy. The hand and the model are the same distance from the camera, so perspective does not enlarge the hand.`
      : ', and the objects around it are their real everyday size, so it reads as big.'
  }

The model matches the attached photo exactly: ${colours}, matte plastic with sharp crisp edges on every brick, clearly visible seams between panels, defined stud edges with small shadows in the gaps.

Framing: the camera is at the model's own height, looking straight at its side, not down at it. The model is the subject, entirely inside the frame and positioned slightly off center. It fills about two thirds of the frame width — or less, whatever it takes to obey the headroom rule below, which always wins: for a tall model, a bouquet or a plant, it will be narrower than that, and that is right. The camera is not perfectly level, tilted a degree or two, the way a person holds a phone.

Headroom: the whole model sits in the lower ${insist ? 'half' : 'two thirds'} of the frame. The ${
    insist ? 'top half' : 'top third'
  } is empty room above it — plain wall, or the far side of the room, out of focus — with nothing in it. The highest point of the model, ${
    handed ? 'held up in the hand, ' : ''
  }including any leaf, petal, tip or part that sticks up from it, is below that line and comes nowhere near the top edge. The person taking the photo stepped back far enough to leave that space above it, so the model takes up less of the frame than it would in a photo framed tight around it.

Background: a real room in daylight, tidy but unplanned, photographed from an angle rather than straight on, so the furniture runs at a slight diagonal and objects are partly cut off by the edges of the frame. Ordinary things a person has in a bright home, a pale wall, a shelf, a desk edge, a chair, arranged by life and not by a photographer. Nothing centered behind the model, nothing symmetrical, nothing that looks placed for the shot.

Light: the room is bright, full of soft daylight from a window off to one side and slightly in front of the model. Everything in the frame is clearly lit and easy to read, with open, gentle shadows and no dark corners. The model is still the brightest thing in the photo, lit softly from the front, from the camera side. No window or lamp visible in the frame, no hotspot or glare on the wall, no light source behind the model.

Focus: the model and hand are perfectly sharp. The background is clearly out of focus with soft, even blur, objects reading as simple shapes but not melted into abstract color. Natural lens falloff, not a cutout effect.

Slightly uneven exposure on the bright side, clean shadows, no color grading, no studio lighting. Looks like a real photo someone took at home on a bright afternoon, calm and quiet, not a product advertisement.

Avoid: smoothed or melted brick surfaces, rounded soft edges, 3D render look, CGI look, high camera angle, looking down at the model, visible roof or top, small toy scale, model reaching the top edge of the frame, model filling the frame from top to bottom, no space above the model, tight crop, close-up, symmetrical composition, centered background object, staged scene, empty grey wall, studio look, blown-out background, window in frame, lamp in frame, glowing wall, backlight, night, evening, dark room, dim light, low light, moody lighting, underexposed, dark shadows, heavy shadows, dark walls, dark furniture, dark surface under the model, dark or black background, the model sitting in shadow, messy clutter, sharp background, portrait mode cutout, floating model, cropped model, text, watermark, brand names, logos, lettering on the model${
    handed
      ? ', oversized hand, hand close to the camera, forearm, arm, elbow, deformed hand, extra fingers, two hands, open flat hand with the model merely resting on it, hand lying beside the model instead of holding it'
      : ', hand, hands, fingers, thumb, wrist, arm, any part of a person, anybody holding the model'
  }.`;
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
      // THE SHAPE OF THE FRAME IS A PARAMETER, NOT A REQUEST.
      //
      // The prompt opens by asking for a "vertical 9:16 photo" and the model
      // ignored it every time: every shot came back 1024x1024. The renderer
      // then object-fit: covers that square into a 1080x1920 slide, which
      // scales it to 1920 tall and throws away 420px from EACH side — 41% of
      // the picture, off the left and right, which is where a car's front and
      // back are. That is the set getting cut off.
      //
      // Asked for properly here it returns 768x1344, which is 9:16 exactly.
      //
      // 9:16 rather than anything else because that is the TikTok frame and
      // TikTok is what these decks are for. The Instagram 4:5 render crops the
      // same photo vertically instead.
      //
      // THAT CROP IS NOT FREE, WHICH THIS COMMENT USED TO CLAIM IT WAS. It
      // said the 4:5 frame trims above and below the model rather than through
      // it, "the right way round, since the model sits in the lower middle and
      // the type sits over empty space above it" — and the second half of that
      // sentence is the problem with the first. The empty space above the model
      // is the space the type needs, and a centred crop takes 285px of it. The
      // crop is biased upward in render/sizes.js for exactly this reason.
      generationConfig: { imageConfig: { aspectRatio: ASPECT_RATIO } },
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

/**
 * What makes a cached shot the same shot.
 *
 * The aspect ratio is in here so that changing it invalidates the cache instead
 * of silently serving pictures cut to the old shape. Every shot on disk when
 * that was written was 1024x1024, and without it they would have outlived the
 * fix — a cached square is indistinguishable from a fresh one to everything
 * downstream.
 *
 * LOOK is the same argument applied to the prompt, and it was added the first
 * time the prompt changed what the photograph looks like rather than what is in
 * it. The shots were staged in a dim bedroom at night and are now staged in
 * daylight; nothing about a cached file records which of the two it is, so
 * without a token in the key the change would have applied only to sets nobody
 * had posted yet and the feed would have gone out half dark, indefinitely,
 * with every file looking perfectly valid.
 *
 * BUMP IT WHENEVER AN EDIT TO `stillPrompt` CHANGES THE PICTURE. It is a
 * deliberate re-spend: every set costs one more generation the next time it is
 * used. That is the price of the edit actually taking effect, and it is smaller
 * than it looks — only sets that come round again are ever paid for.
 */
const LOOK = 'bright3';

/**
 * How much of a shot has to be empty above the model, as a fraction of its
 * height, before the slide renderer has to bend the picture to fit the type.
 *
 * Derived rather than picked. The renderer can push a photograph down the
 * frame for free — see photoDropMaxPct in render/sizes.js — and past that it
 * has to shrink it, which opens slivers down the sides that are not
 * photograph. 0.27 is the point where the harder of the two frames, Instagram's
 * 4:5, still clears the type on the drop alone. Above it the fit is invisible;
 * below it the slide still works and starts to look handled.
 */
export const HEADROOM_MIN = 0.27;

const cacheStem = (productId, n = 1) =>
  join(
    CACHE_DIR,
    `${String(productId).replace(/[^\w.-]/g, '-')}-${n}-${ASPECT_RATIO.replace(':', 'x')}-${LOOK}`
  );

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

  // One retry and no more. The skill's own troubleshooting list is a set of
  // prompt EDITS a person makes after looking at the output, which is not
  // something this can do in general — so a third attempt would be spending
  // money on the same coin flip.
  //
  // WHAT THE SECOND ATTEMPT IS FOR HAS CHANGED, and it now costs real money it
  // did not cost before. It used to run only when the first came back showing
  // a different model, which is rare. It now also runs when the first came
  // back with the model filling the frame, which is not rare at all — it is
  // most tall subjects — and in that case the prompt is hardened rather than
  // repeated, because repeating a prompt the model has already ignored is the
  // coin flip and rewriting it is not.
  //
  // The spend is deliberate and it is bounded at one extra image per set, once,
  // since the result is cached. It buys the only version of this fix that
  // produces a good photograph: everything downstream of here can move a
  // picture around a frame, and none of it can put room into a picture that
  // has none.
  let lastWhy = null;
  let best = null;
  for (const attempt of [1, 2]) {
    // Hardened only when the first attempt failed ON HEADROOM. A retry after a
    // wrong model is a retry of the same instruction; shouting the framing
    // rule at it would not make it the right set.
    const prompt = stillPrompt({
      nameHe: deal.product,
      sizeCm,
      theme: deal.theme,
      insist: attempt > 1 && best !== null,
    });

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

    // How much room it left above the model. A null means the measurement
    // could not run at all, and that is never a reason to throw away a
    // photograph that has been paid for and has passed its identity check — it
    // is treated as "no opinion", which is what it is.
    const room = await headroomOf(`data:${mime};base64,${base64}`);
    const subject = room?.subject ?? null;
    if (!best || (subject ?? 1) > (best.subject ?? 1)) best = { bytes, mime, base64, subject, attempt };
    if (subject === null || subject >= HEADROOM_MIN) return keep(stem, best, source);
    lastWhy = `attempt ${attempt}: the model starts ${Math.round(subject * 100)}% down the frame, leaving no room above it for the type`;
  }

  // The best of what came back, rather than nothing.
  //
  // A photograph that shows the right set and is framed badly is worth more
  // than the catalogue image this would otherwise fall back to, because the
  // renderer can do something about framing and can do nothing about a picture
  // that looks like an advertisement. The note says which it is, so the
  // approval message can too.
  if (best) return keep(stem, best, source);

  throw new ShotError(lastWhy || 'image generation produced nothing usable');
}

/** A shot to disk, and the answer the caller gets back. */
function keep(stem, best, source) {
  const file = stem + extFor(best.mime);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, best.bytes);
  renameSync(tmp, file);
  const tight = best.subject !== null && best.subject < HEADROOM_MIN;
  return {
    src: `data:${best.mime};base64,${best.base64}`,
    provenance: 'generated',
    note:
      `from the ${source.kind}` +
      (best.attempt > 1 ? `, on the second attempt` : '') +
      (tight ? ` — little room above the model, so the slide re-frames it` : ''),
  };
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

    // THE BYTES, NOT THE ADDRESS, and it is not an optimisation.
    //
    // A slide measures its own photograph in a canvas to decide where the type
    // can go, and a canvas that has drawn an image from another origin refuses
    // to be read back — so a picture that arrives as a marketplace URL cannot
    // be measured, and the slide falls back to the unmeasured geometry and the
    // heaviest scrim. Which is exactly backwards: the catalogue fallback is the
    // worst-framed picture in the pipeline, a product centred on white with
    // nothing above it, and it is the one that needs the fit most.
    //
    // Inlined here rather than by the renderer because this is where a fetch
    // already lives, and a failure has somewhere sensible to go: the URL, which
    // is what this returned before.
    try {
      const photo = await fetchImage(source.url);
      return {
        src: `data:${photo.mime};base64,${photo.base64}`,
        provenance: 'stock',
        note: `catalogue photo — ${e.message}`,
      };
    } catch {
      return { src: source.url, provenance: 'stock', note: `catalogue photo — ${e.message}` };
    }
  }
}

/**
 * A shot that has ALREADY been paid for, or null. Never generates.
 *
 * For re-rendering a slide after the deck was staged. By then the photographs
 * have been stripped out of the candidate — they are megabytes of base64 each
 * and the store is rewritten whole on every save — so the picture has to come
 * back from somewhere, and the only honest somewhere is the cache it was
 * written to when it was made.
 *
 * Null rather than a fresh generation on a miss, and that is the whole point of
 * having it separate from homeShot(). Re-drawing a cover is meant to cost
 * nothing; silently spending a model call because a cache file was pruned is
 * exactly the kind of invisible bill a retry button should never run up.
 */
export function cachedShotFor(productId, n = 1) {
  const hit = cachedShot(cacheStem(productId, n));
  if (!hit) return null;
  return { src: `data:${hit.mime};base64,${hit.buf.toString('base64')}`, provenance: 'generated', note: 'cached' };
}

export const __test = { cacheStem, cachedShot, sniffMime, extFor, CACHE_DIR };
