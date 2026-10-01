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
//   2. Check what came back, on all three counts. It has to be the same model —
//      a generated image that is not is worse than a catalogue shot, because it
//      is a catalogue shot's problem plus a false claim. It has to READ AS A
//      PHOTOGRAPH rather than a drawing. And it has to be free of the seller's
//      own artwork. The identity half is the guard brickdeal-automation's
//      setImage.js has; the other two were added after a deck went out carrying
//      a grey pencil sketch of a Star Destroyer with a red "1500+PCS" badge
//      across it, which every check in this file passed at the time.
//   3. Never silently substitute, and never substitute something unpublishable.
//      A failure falls back to the product photo with its provenance CHANGED,
//      so the approval message says the slide is a catalogue shot and a person
//      decides. But the listing image is an ADVERTISEMENT — badges, prices,
//      captions, age marks, and on this marketplace quite often a drawing
//      rather than a photograph — so it is screened the same way before it is
//      allowed to stand in. When it fails, this file has no picture for that
//      deal and says so, and the deal does not get a slide.

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

/**
 * How many times one slide's photograph may be generated before giving up.
 *
 * Three, and the number is the budget rather than a target: the first attempt
 * succeeds on most sets and nothing after it is paid for. Read from the
 * environment at call time rather than captured at import, so the bill can be
 * capped on a running bot without a redeploy — `IMAGE_GEN_ATTEMPTS=1` turns
 * every retry off.
 *
 * Floored at one. Zero attempts is not a cheaper pipeline, it is a pipeline
 * where every deck silently falls back to catalogue images.
 */
export const attemptsAllowed = () => Math.max(1, Math.round(Number(process.env.IMAGE_GEN_ATTEMPTS ?? '3')) || 1);

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
 *
 * THE THIRD DEPARTURE IS THE PARAGRAPH THAT SAYS THIS IS A PHOTOGRAPH, and it
 * is here because a deck went out with one that was not. A slide came back as a
 * grey pencil sketch — the model, the sofa, the floor, the whole room drawn in
 * graphite — and every guard in this file passed it, because the `Avoid:` list
 * was written against ONE way of not being a photograph. "3D render look, CGI
 * look" is the failure you get when you ask for a photo of a plastic model; a
 * drawing is a different failure and nothing here had ever named it. Neither
 * had anything named greyscale, which is how the same frame lost its colour.
 *
 * THE FOURTH IS THE PARAGRAPH ABOUT THE SELLER'S OWN GRAPHICS, from the same
 * slide. It carried a red `1500+PCS` badge and the words `Desktop Decoration`
 * in English across the middle of the picture, both lifted straight off the
 * marketplace listing the shot was built from. That is not the model drifting:
 * the prompt hands over a listing image and says "the model matches the
 * attached photo exactly", and a badge sitting on top of the model is part of
 * what is attached. `Avoid: text, watermark` four paragraphs later did not
 * outweigh it, and nothing in the instructions had ever told the model that the
 * picture it was given has somebody else's advertising printed over it.
 *
 * Both are also CHECKED after the fact now — see `verifyShot`. A rule in a
 * prompt is a request, and these two are exactly the kind that has to be true.
 */
export function stillPrompt({
  nameHe,
  sizeCm,
  theme,
  colours = 'the colours and distinctive parts visible in the attached photo',
  insist = false,
  insistPhoto = false,
}) {
  const { hold, contact, fraction, landmark } = holdFor({ sizeCm, theme });
  const length = sizeCm ? `${Math.round(sizeCm)} cm` : 'about 25 cm';
  const handed = !hold.includes('NO HAND');

  return `Using the brick-built model in the attached photo, generate a photorealistic vertical 9:16 photo, shot casually on an iPhone in a bright room during the day.
${
  insistPhoto
    ? `
THE LAST ATTEMPT WAS NOT A PHOTOGRAPH. Read this before anything else.

OUTPUT A PHOTOGRAPH. A real frame off a real phone camera, in full natural colour. NOT a drawing. NOT a pencil sketch. NOT line art, an illustration, a painting, a cartoon, an engraving or a 3D render. NOT greyscale, not black and white, not sepia, not a colour-drained or toned image. Every surface in the frame — the model, the floor, the furniture, the wall — is a photographed surface with its real colour and real texture, not a drawn one.

AND NO GRAPHICS ANYWHERE IN IT. The attached picture is an advertisement and has the seller's artwork printed over it. Not one pixel of that artwork appears in what you produce: no badge, no piece count, no price, no English caption, no banner, no arrow, no star, no border, no panel. The frame you make contains a room and a model and nothing else.
`
    : ''
}${
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

Medium: this is a PHOTOGRAPH, in full natural colour. A real camera frame with real grain, real depth of field and real surface texture. It is not a drawing, a pencil sketch, line art, an illustration, a painting, a cartoon or a 3D render, and it is not greyscale, monochrome or colour-drained. Every object in it — the model and the whole room around it — is photographed, not drawn.

The attached picture is a marketplace listing, and the seller has printed artwork over it. Expect a piece-count badge like "1500+PCS", a price, an English caption like "Desktop Decoration", a coloured banner, arrows, stars, a border, or several views collaged into one image. NONE OF THAT IS PART OF THE MODEL AND NONE OF IT IS COPIED. Take the built model out of the picture and leave every piece of that artwork behind. What you generate carries no text, no numbers, no badges, no banners, no borders and no panels anywhere in the frame.

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

Avoid: drawing, sketch, pencil sketch, pencil drawing, graphite, charcoal, line art, outlines, hatching, cross-hatching, illustration, painting, watercolour, cartoon, comic, anime, engraving, woodcut, blueprint, CAD drawing, concept art, storyboard, greyscale, monochrome, black and white, sepia, desaturated, colour-drained, text overlay, caption, English words, price tag, sticker, badge, piece-count badge, "PCS", banner, coloured banner, arrow, star rating, border, frame around the photo, collage, split frame, multiple views in one image, product listing graphics, advertisement layout, smoothed or melted brick surfaces, rounded soft edges, 3D render look, CGI look, high camera angle, looking down at the model, visible roof or top, small toy scale, model reaching the top edge of the frame, model filling the frame from top to bottom, no space above the model, tight crop, close-up, symmetrical composition, centered background object, staged scene, empty grey wall, studio look, blown-out background, window in frame, lamp in frame, glowing wall, backlight, night, evening, dark room, dim light, low light, moody lighting, underexposed, dark shadows, heavy shadows, dark walls, dark furniture, dark surface under the model, dark or black background, the model sitting in shadow, messy clutter, sharp background, portrait mode cutout, floating model, cropped model, text, watermark, brand names, logos, lettering on the model${
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

const VERIFY_PROMPT = `Image 1 is a marketplace seller's photo of a brick-building set. Image 2 is a generated photo that is supposed to show the SAME built model, restaged as a photograph in a real room.

Answer three separate questions about image 2.

1. match — is the model in image 2 the same build as image 1? Judge by the built model itself: shape, colours, main features, figures. Ignore background, lighting, angle, the hand, and photo quality, and ignore the two pictures being in different styles — image 1 is often a sketch or an exploded diagram of the very same build, and that is still a match. A different set from the same franchise, a different scale, or a different vehicle/building of the same kind is NOT a match. If image 2 does not show a built model at all, it is NOT a match.

2. style — what does image 2 LOOK LIKE? Answer with exactly one of these words:
   "photo" — an ordinary colour photograph of a real room.
   "drawing" — hand-drawn or illustrated: pencil sketch, graphite, charcoal, line art with visible outlines or hatching, watercolour, painting, cartoon, comic, engraving, blueprint.
   "greyscale" — photograph-like but drained of colour: black and white, monochrome or sepia.
   IMAGE 2 WAS PRODUCED BY AN IMAGE MODEL. That is expected and is not what this question is about, so do NOT answer "drawing" because the picture is AI-generated, or because it looks clean, tidy, bright or well composed. Judge the visual style and nothing else: a generated picture that reads as a normal colour photo of somebody's living room is "photo". Judge the whole frame, not only the model. This question is about image 2 only — the style of image 1 is irrelevant to it.

3. clean — is image 2 free of overlaid graphics? Answer false if any text, number, piece count, price, English caption, badge, sticker, watermark, logo, coloured banner, arrow, star, border or collage panel is laid over the picture or printed across the model — the kind of artwork a marketplace listing carries. Ignore small incidental text that genuinely belongs to the room, such as a book spine on a shelf or the letters on a keyboard.

Return ONLY a JSON object, no markdown: {"match": true|false, "style": "photo"|"drawing"|"greyscale", "clean": true|false}`;

/**
 * Is this generated picture publishable: the right set, actually a photograph,
 * and free of the seller's artwork?
 *
 * THREE QUESTIONS IN ONE CALL, which is the whole reason they are asked
 * together. The identity check was already being paid for on every generated
 * image; adding two more questions to the same request costs a few dozen tokens
 * and no extra round trip, and the alternative — a second verifier — would
 * double the per-image bill to ask a model that is already looking at the
 * picture something it could have answered the first time.
 *
 * THE OTHER TWO EXIST BECAUSE THIS FUNCTION USED TO WAVE THEM THROUGH. It asked
 * only whether the build matched and told the judge in as many words to "ignore
 * background, lighting, angle, the hand, and photo quality" — so a grey pencil
 * drawing of the correct ship, with the seller's red "1500+PCS" badge still
 * printed across it, was a clean pass. It was the right model. It was also not
 * a photograph and not ours to publish, and the only thing standing between it
 * and TikTok was whether somebody looked at the approval album closely.
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
 * It now says which of the three failed as well, because the caller retries
 * differently for each: a wrong model is retried as-is, a drawing is retried
 * with the medium shouted at the top of the prompt.
 *
 * Fail closed, always. Explain accurately, always.
 */
export async function verifyShot(sourceUrl, generatedBase64, mime = 'image/png') {
  // Nulls rather than falses on the three verdicts, so "the check did not run"
  // is distinguishable from "the check ran and said no". The caller hardens
  // the prompt on a `false` and must not harden it on a timeout.
  const no = (why) => ({ ok: false, match: null, photo: null, clean: null, why });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return no('no ANTHROPIC_API_KEY, so nothing can check the photo');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: VERIFY_MODEL,
        // Three booleans instead of one. Still a single short line of JSON,
        // but 30 tokens was sized for `{"match": true}` and would now truncate
        // the answer into an unparseable fragment — which fails closed, so the
        // symptom would have been every generated photograph quietly rejected.
        max_tokens: 100,
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
      return no(`the check could not run: HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    let text = (data.content || []).map((b) => b.text || '').join('').trim();
    text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
    const said = JSON.parse(text);

    // Each one read strictly. A missing or unrecognised answer is a "no", so a
    // judge that answers two of the three questions cannot have the third one
    // assumed in its favour.
    const match = said.match === true;
    const clean = said.clean === true;

    // THE MEDIUM IS ASKED AS A CLASSIFICATION, NOT A YES/NO, and the first
    // version of this question is the reason why.
    //
    // It asked "is image 2 a PHOTOGRAPH?" and told the judge that an "obvious
    // 3D/CGI render" was not one. Every picture this function is ever shown is
    // generated by an image model, so that is very close to asking "was this
    // made by a machine" — and the honest answer is always yes. Two perfectly
    // good restaged photographs of a Star Destroyer on a desk, the exact output
    // this pipeline exists to produce, were both judged `photo: false`, which
    // would have thrown away every generated image in the project and sent
    // every deck to the catalogue fallback.
    //
    // Naming the three styles instead takes the loaded word out of the question
    // and leaves a judgement about what the picture LOOKS like, which is the
    // only thing that was ever being asked.
    const style = String(said.style || '').toLowerCase().trim();
    const photo = style === 'photo';

    // Reported in the order that decides what to do about it. A wrong model is
    // the worst of the three and the one with no retry worth making; a drawing
    // and a copied badge are both fixable by shouting at the prompt, so they
    // are named separately from each other and from the identity failure.
    const why = !match
      ? 'the photo does not show the same model'
      : !photo
        ? `what came back reads as ${style || 'neither a photo nor anything it could name'}, not a photograph`
        : !clean
          ? "the seller's own text or badges were copied onto the picture"
          : null;

    return { ok: match && photo && clean, match, photo, clean, style, why };
  } catch (e) {
    return no(`the check could not run: ${e.message}`);
  }
}

const SCREEN_PROMPT = `This picture is a product image from a marketplace listing for a brick-building set, and it is a candidate to be published as-is on a social media slide. Judge the picture itself.

1. style — what does it look like? Answer with exactly one of these words:
   "photo" — an ordinary colour photograph of the product.
   "drawing" — hand-drawn or illustrated: pencil sketch, graphite, charcoal, line art, watercolour, painting, cartoon, engraving, blueprint, or a drawn diagram of the parts.
   "greyscale" — photograph-like but drained of colour: black and white, monochrome or sepia.

2. clean — is it free of overlaid graphics? Answer false if it carries any text, number, piece count, price, caption, badge, sticker, watermark, logo, coloured banner, arrow, star, border or age mark, or if it is several views collaged into one image. Ignore small incidental text that is genuinely part of the product or the room.

Return ONLY a JSON object, no markdown: {"style": "photo"|"drawing"|"greyscale", "clean": true|false}`;

/**
 * Can this marketplace image be published exactly as it is?
 *
 * The fallback path's version of `verifyShot`, and it exists because the
 * fallback is what actually shipped the bad slide. A listing image goes onto a
 * slide untouched when generation fails, and the one that went out was the
 * seller's own pencil drawing with a red `1500+PCS` badge, an English caption
 * and a `14+` age mark printed across it — an advertisement, published as
 * though it were a photograph of the product.
 *
 * ONE IMAGE AND TWO QUESTIONS. There is nothing to compare it against here:
 * this IS the source, so identity cannot be wrong and is not asked. What can be
 * wrong is everything else, and it is the same everything else.
 *
 * `ran` is the field the caller branches on, and this is the one check in the
 * file that does NOT fail closed. Everywhere else a check that cannot run is a
 * "no", because the thing it guards against is publishing the wrong product.
 * Here the thing on the other side of the scale is a deck that cannot be built
 * at all: a missing ANTHROPIC_API_KEY would otherwise drop every slide of every
 * deck, and silently turning the whole pipeline off is a worse failure than
 * letting a picture through with a note on the approval card saying it was
 * never looked at.
 */
export async function screenListing(base64, mime = 'image/jpeg') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ran: false, ok: false, why: 'no ANTHROPIC_API_KEY, so nothing looked at it' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: VERIFY_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
              { type: 'text', text: SCREEN_PROMPT },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ran: false, ok: false, why: `the check could not run: HTTP ${res.status} ${body.slice(0, 160)}` };
    }
    const data = await res.json();
    let text = (data.content || []).map((b) => b.text || '').join('').trim();
    text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
    const said = JSON.parse(text);
    const style = String(said.style || '').toLowerCase().trim();
    const clean = said.clean === true;
    const ok = style === 'photo' && clean;
    return {
      ran: true,
      ok,
      style,
      clean,
      why: ok
        ? null
        : style !== 'photo'
          ? `the catalogue picture is ${style || 'not a photograph'} rather than a photograph`
          : "the catalogue picture carries the seller's own text or badges",
    };
  } catch (e) {
    return { ran: false, ok: false, why: `the check could not run: ${e.message}` };
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
 *
 * `photo1` is the bump that matters most so far, because it is not only making
 * an improvement take effect — it is EVICTING BAD PICTURES. The shots written
 * under `bright3` were checked by a verifier that asked whether the model
 * matched and nothing else, so any pencil drawings and any pictures carrying
 * the seller's badges that got through are sitting in the cache right now,
 * indistinguishable from good ones, and would otherwise be served forever
 * without the new checks ever running on them.
 */
const LOOK = 'photo1';

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

  // Up to three attempts, and every retry changes the prompt in response to
  // what measurably came back.
  //
  // IT WAS TWO, on the reasoning that the skill's troubleshooting list is a set
  // of prompt EDITS a person makes after looking at the output, so a third
  // attempt would be "spending money on the same coin flip". That argument was
  // right about repeating an unchanged prompt and is the same argument that
  // justified the second attempt once the retry started HARDENING the prompt
  // instead of repeating it. There are now two independent things a retry can
  // harden — the framing and the medium — and a first attempt can fail both at
  // once, so two attempts could no longer address what came back.
  //
  // The owner asked for this spend in those words, looking at a deck that went
  // out as a pencil drawing: a slightly larger image bill is cheaper than a
  // post that cannot be published. It is bounded at two extra images per set,
  // once, because the result is cached.
  let lastWhy = null;
  let best = null;
  // Sticky, not per-attempt. A drawing on attempt one means every later attempt
  // is told to produce a photograph, including the one that is also being told
  // to leave room above the model.
  let insistOnPhoto = false;

  for (let attempt = 1; attempt <= attemptsAllowed(); attempt++) {
    const prompt = stillPrompt({
      nameHe: deal.product,
      sizeCm,
      theme: deal.theme,
      // Hardened only when a previous attempt failed ON HEADROOM — `best` is
      // only ever set by a picture that already passed every other check. A
      // retry after a wrong model is a retry of the same instruction; shouting
      // the framing rule at it would not make it the right set.
      insist: attempt > 1 && best !== null,
      // A separate switch for a separate failure, so a drawing is not retried
      // with a paragraph about framing and a badly framed photograph is not
      // retried with a paragraph about pencils.
      insistPhoto: insistOnPhoto,
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
    const verdict = await verifyShot(source.url, base64, mime);
    if (!verdict.ok) {
      // The reason, not a guess at it. "did not show the same model" was
      // printed here for every failure of any kind, including the one that was
      // actually happening.
      lastWhy = `attempt ${attempt}: ${verdict.why}`;
      // Both of these are fixed by the same paragraph — it demands a real
      // photograph AND refuses the listing's artwork — so either one turns it
      // on. A copied badge is a sign the model is treating the attached
      // advertisement as the thing to reproduce, which is also how the
      // drawings happen.
      if (verdict.photo === false || verdict.clean === false) insistOnPhoto = true;
      // AND IT IS NOT KEPT AS A FALLBACK, which is the difference between this
      // and the headroom gate below. A badly framed photograph is worth more
      // than a catalogue image, because the renderer can reframe it. A drawing
      // is worth less than one: it cannot be turned into a photograph by
      // anything downstream, and a slide carrying the seller's own red badge is
      // the catalogue image with extra steps.
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
 * A home shot, or the product photo — but only if the product photo is one.
 *
 * The caller that wants a picture if there is an acceptable one. The fallback
 * is still the point of the shape: a deck should keep building when generation
 * is unavailable or refuses, and what changes is the word on the approval
 * message rather than anything silent.
 *
 * WHAT CHANGED IS THAT "A PICTURE NO MATTER WHAT" WAS THE BUG. This used to
 * hand back whatever the marketplace was serving, unconditionally, and the
 * slide that prompted this was exactly that: generation did not produce
 * anything usable, so the listing image went on the slide, and the listing
 * image was a pencil drawing of the set with a red `1500+PCS` badge and an
 * English caption printed over it. The renderer then blew the square up to fill
 * a 9:16 frame and the top of the post was a blurred smear of that badge.
 *
 * So the fallback is now screened, and a listing that is an advertisement is
 * not a picture this pipeline has. Throwing is the right shape for that:
 * buildSlides already drops a deal whose photograph failed and reports why, the
 * feed has hundreds of others, and a deck that cannot find enough is refused
 * loudly by toBrickCandidate rather than published thin.
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
    let photo;
    try {
      photo = await fetchImage(source.url);
    } catch {
      // The address, unscreened, because the bytes could not be had to screen.
      // Last resort and visibly labelled: a URL cannot be measured by the
      // renderer either, so this is the worst-looking slide the pipeline can
      // produce and the approval card says so.
      return { src: source.url, provenance: 'stock', note: `catalogue photo, not checked — ${e.message}` };
    }

    const screen = await screenListing(photo.base64, photo.mime);
    if (screen.ran && !screen.ok) {
      // No usable picture for this deal. Not a slide.
      throw new ShotError(`${e.message}; ${screen.why}`);
    }

    return {
      src: `data:${photo.mime};base64,${photo.base64}`,
      provenance: 'stock',
      note: `catalogue photo${screen.ran ? '' : `, not checked (${screen.why})`} — ${e.message}`,
    };
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

// The two judge prompts are in here so the suite can hold their wording to
// account offline. That is worth doing for these two specifically: the first
// version of the medium question was miscalibrated in a way no unit test would
// normally catch — it read as "was this made by a machine", which is always yes
// here — and the symptom was every good photograph being thrown away.
export const __test = { cacheStem, cachedShot, sniffMime, extFor, CACHE_DIR, VERIFY_PROMPT, SCREEN_PROMPT };
