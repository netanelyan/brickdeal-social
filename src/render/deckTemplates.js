import {
  palette,
  heeboDataUri,
  assistantDataUri,
  tiktokSansDataUri,
  rubikDataUri,
  arimoDataUri,
  escapeHtml,
} from './theme.js';
import { emojiHtml } from './emojiArt.js';
import { postConfig } from '../postConfig.js';

// Slideshow slides, set the way the two accounts this channel is modelled on
// set them.
//
// They are not one look, they are two, and trying to average them is what
// produced slides that belonged to neither:
//
//   MINIMAL (lucyysarchive). A photograph, the place's name, the country, the
//   flag under it. Small type — genuinely small, around 2.5% of the frame
//   height — in a normal weight, no outline, placed in whatever part of the
//   picture is empty. The photograph is the post and the words are a caption on
//   it. This is the one to reach for when the picture already answers "what is
//   it" and the only open question is "where is that".
//
//   INFO (adventurers00). Cream type with a bronze outline, the place's name
//   and then the same four measured facts on every slide, in the same order.
//   Louder, and it has to be: these slides are read rather than looked at.
//
// What both do, and what the earlier version of this file did not, is keep the
// type SMALL and the leading TIGHT. Every complaint about the old slides —
// awkward placement, too much space between lines, text eaten by the
// background — traces back to type set a third too large, a 1.34 line-height,
// and an extra flex gap on top of it.

// Both ends of a TikTok frame belong to the app, not to us: the search bar and
// slide counter at the top, the caption and handle at the bottom. The button
// rail down the right side is handled in render/photo.js instead, because it is
// a rectangle rather than a band and only TikTok has one.
// Instagram's numbers are not about furniture — the feed draws almost none over
// the image — they are about composition. At 80 and 110 the placement search
// could put a block within six percent of an edge, and it did whenever the
// quietest part of a photograph happened to be the very top of the sky: type
// pinned to the rim of the frame reads as a mistake rather than as a choice.
// These give it a margin to breathe in without meaningfully narrowing the
// search.
export const SIZES = {
  tiktok: { w: 1080, h: 1920, topSafe: 300, bottomSafe: 400 },
  instagram: { w: 1080, h: 1350, topSafe: 150, bottomSafe: 175 },
};

export const STYLES = ['minimal', 'info'];
export const isStyle = (s) => STYLES.includes(s);

// The info palette, read off the reference slides: a pale butter cream over a
// bronze outline. The warmth is the point — pure white with a black outline is
// what a subtitle burner produces, and it looks it.
const CREAM = '#F7E3A1';
const BRONZE = '#7A4A12';

// The relative luminance of the cream, precomputed.
//
// The placement search needs to know how bright the ink will be in order to
// score contrast against a region, and for the info style the ink never
// changes — it is this cream on every slide. Scored as though it could adapt,
// the search happily put a cream line across a sunlit snowfield with clear blue
// sky immediately above it.
//
// The minimal style passes null instead, because there the ink genuinely does
// adapt and the region is scored on whichever colour it would end up choosing.
export const INK_LUMINANCE = { info: 0.772, minimal: null };

// Which family carries the Hebrew on each style, and how heavy each role is.
//
// Collected here rather than scattered through the stylesheet because the two
// things move together: Rubik at 600 is roughly as dark on the page as
// Assistant at 700, so swapping the family without re-choosing the weights
// changes the colour of the whole slide. Keeping them adjacent makes "the same
// face, a little lighter" a one-line edit instead of a hunt through five rules.
// Arimo 600, chosen by rendering the same slide over the same photograph in
// each candidate and looking at them — which is the only way this question can
// be answered, and why scripts/font-lab.js exists.
//
// Metric-compatible with Arial, which is what older iOS drew Hebrew with. Of
// the five it read most like text somebody typed into the app rather than type
// somebody set, and that is the brief for a photo post.
//
// One weight across both styles. The old table ran minimal at 600 and info at
// 800, which made the same deck's two styles look like two accounts — and the
// weight difference was doing work that the field list already does.
//
// The weight now comes from post-config.json rather than from here — 600 is a
// semibold, and a semibold place name over a photograph is the single loudest
// thing on the slide. The default is 400. These stay as the shape of the table
// and as the fallback for a config that does not answer.
export const FACES = {
  minimal: { family: 'Arimo', name: 600, note: 600, cover: 600 },
  info: { family: 'Arimo', name: 600, field: 600, cover: 600 },
};

/**
 * The type scale for one frame, resolved from post-config.json.
 *
 * `sizeBasis` is the frame's WIDTH by default, and that choice is the whole
 * reason this is a function rather than four constants. "Three percent" of a
 * 1080x1920 frame is 32px against the width and 58px against the height — an
 * eightfold difference in how loud the slide is — and 32px is the size these
 * slides were specified at. Set sizeBasis to "height" in the config for the
 * other reading; nothing else has to change.
 *
 * The length steps stay proportional rather than absolute, so a long name still
 * steps down and the whole scale still moves with one number.
 */
export function typeScale({ w, h }) {
  const ov = postConfig().overlay;
  const basis = ov.sizeBasis === 'height' ? h : w;
  const body = Math.max(10, Math.round(basis * ov.sizePct));
  const cover = Math.max(10, Math.round(basis * ov.coverSizePct));
  const step = (px, f) => Math.max(10, Math.round(px * f));
  return {
    ov,
    body,
    bodyMid: step(body, 0.94),
    bodyLong: step(body, 0.86),
    note: step(body, 0.82),
    field: step(body, 0.9),
    fieldLong: step(body, 0.8),
    cover,
    coverMid: step(cover, 0.92),
    coverLong: step(cover, 0.84),
    coverXlong: step(cover, 0.76),
    // Scaled off the type rather than off the frame. The bronze outline was
    // sized for 68px letters at max(3px, h*0.0028); at 32px the same stroke
    // closes the counters and the name becomes a blob.
    stroke: Math.max(1, Math.round(body * 0.055)),
  };
}

/**
 * Flush left, in a script that runs right to left.
 *
 * `.block` is a flex COLUMN, so its cross axis is horizontal and the direction
 * property decides which end is which: under `direction: rtl`, flex-start is
 * the RIGHT edge and flex-end is the left. So pinning the words to the physical
 * left of the frame — which is what "upper-left or lower-left third" asks for —
 * is align-items: flex-end, and getting that backwards puts a left-placed block
 * of text against its own right edge, in the middle of the picture.
 */
const alignment = (align) =>
  align === 'right'
    ? { items: 'flex-start', text: 'right' }
    : { items: 'flex-end', text: 'left' };

/** One configured weight, applied to every role on the slide. */
const weightsFrom = (ov) => ({ name: ov.weight, note: ov.weight, field: ov.weight, cover: ov.weight });

// The Hebrew face, overridable.
//
// Which typeface Hebrew is set in is the one open question left on these
// slides: TikTok Sans has no Hebrew at all, so what the app puts on screen for
// Hebrew is whatever the PHONE falls back to — SF Hebrew on iOS, Noto Sans
// Hebrew on Android — and there is therefore no single "TikTok Hebrew font" to
// match. Heebo is the bundled default and a reasonable guess.
//
// This seam exists so candidates can be compared in the real renderer rather
// than in a mock-up that has drifted from it: scripts/font-lab.js passes a
// downloaded face in here and renders the same slide in each. Once one is
// chosen it becomes the default and the seam stays, because the question will
// come back the next time somebody looks at an Android screenshot.
const css = ({ w, h, topSafe, bottomSafe }, style, font = null, size = 'tiktok') => {
  const t = typeScale({ w, h });
  const ov = t.ov;
  const align = alignment(ov.align);
  // The configured weight wins over the table, and the table is the fallback
  // for a font-lab run that supplies its own weights.
  const face = { ...(FACES[style] || FACES.minimal), ...weightsFrom(ov), ...(font?.weights || {}) };
  const family = font?.family || face.family;
  // Two lines and no more, in the one declaration that can enforce it. Clamping
  // is what stops a long Hebrew name becoming four lines of small type, which
  // is the shape that reads as a caption card rather than as a caption.
  const clamp = `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${ov.maxLines}; overflow: hidden;`;
  return `
@font-face {
  font-family: 'Heebo';
  src: url('${heeboDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
/* Assistant carries the minimal style's Hebrew. One variable file covers the
   500 on a note, the 600 on a name and the 700 on a cover. Heebo stays declared
   behind it in the family list, so a failure to parse this degrades to
   legible-but-wrong rather than to tofu. */
@font-face {
  font-family: 'Assistant';
  src: url('${assistantDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
${
  font
    ? `@font-face {
  font-family: '${font.family}';
  src: url('${font.dataUri}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}`
    : ''
}
/* TikTok Sans, the app's own typeface, released under the OFL. Latin, Greek and
   Cyrillic only — no Hebrew — so it is listed FIRST and carries exactly the
   glyphs it has: digits, a stray Latin name, a measurement unit. Every Hebrew
   glyph falls through to the next family, per glyph, which is what the app
   itself does with Hebrew text.

   One variable file per family below, where there used to be two static weights
   each. Those static files were corrupt — no sfnt header, no outlines — and had
   therefore never loaded once: every "TikTok Sans" digit and every "Rubik"
   Hebrew letter on every slide ever rendered was quietly Heebo instead. */
@font-face {
  font-family: 'TikTok Sans';
  src: url('${tiktokSansDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Rubik';
  src: url('${rubikDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Arimo';
  src: url('${arimoDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${w}px; height: ${h}px; overflow: hidden; }

/* The Hebrew face differs by style, and this is the single most visible change
   in the whole file.

   The old slides set everything in Rubik Black. Rubik is a display face and at
   900 over a photograph it has the density of a logo — which, with an outline
   and two drop shadows under it, is precisely what "looks like it was added in
   Photoshop" describes. TikTok's own text tool puts down something much
   plainer.

   So MINIMAL uses Assistant at 600 rather than 900. TikTok Sans has no Hebrew
   at all, so the app itself falls back to the phone's system face — SF Hebrew
   on iOS — and Assistant is the closest thing that can lawfully be shipped.
   INFO keeps Rubik, because the chunky outlined look of those reference slides
   genuinely is a display face and reads wrong in anything lighter. */
body {
  direction: rtl;
  font-family: 'TikTok Sans', ${
    `'${family}'`
  }, 'Assistant', 'Heebo', sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  background: ${palette.ink};
  position: relative;
}

.photo {
  position: absolute;
  inset: 0;
  width: ${w}px;
  height: ${h}px;
  object-fit: cover;
}

/* Almost nothing. The photograph is the post; this only takes the edge off a
   blown-out sky and darkens the very bottom, where TikTok draws its caption in
   white over whatever we supplied.

   Which is the point: those two bands protect TikTok's own furniture, and
   INSTAGRAM HAS NONE OF IT. The feed draws nothing over the image, so the 0.42
   at the foot of the frame was darkening the bottom fifth of every Instagram
   slide to make room for a caption bar that is not there — and on a photograph
   that was already dark, that is the whole "the Instagram ones come out too
   dark". What survives on Instagram is the top edge alone, and only enough to
   keep a blown-out sky from glaring. */
.scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom,
    rgba(4,10,12,${size === 'instagram' ? 0.14 : 0.22}) 0%,
    rgba(4,10,12,0.03) 24%,
    rgba(4,10,12,0.03) 62%,
    rgba(4,10,12,${size === 'instagram' ? 0.12 : 0.42}) 100%);
}

/* Local help, and only when the measurement asked for it.

   render/photo.js reports the contrast the chosen region actually offers. Above
   about 4.5:1 this is absent entirely, which is the normal case and the reason
   the slides do not look like they have panels on them. Below it, an elliptical
   wash fades in under the words — soft-edged and centred on the text, so it
   reads as the light in the photograph rather than as a box. It is what stops
   a slide shipping with type nobody can read. */
.assist {
  position: absolute;
  border-radius: 50%;
  filter: blur(${Math.round(h * 0.022)}px);
}

/* Flush to one side, never centred.

   Centred type over a photograph is the arrangement every brand template uses
   and almost no person does, and it was most of why these slides read as an
   advertisement: dead centre is where the subject of the picture is, so centred
   words are words ON the subject, in the one position that cannot look
   incidental.

   The side is a config value and the inversion is explained at alignment() —
   under direction: rtl, flex-END is the physical left.

   Held below full opacity as well. At 100% white the type is brighter than
   anything in the photograph including the sky, which is what makes it read as
   a layer rather than as part of the frame; a little transparency puts it back
   into the picture without costing legibility, because the shadow underneath is
   doing that work. */
.block {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: ${align.items};
  text-align: ${align.text};
  transform: translateY(-50%);
  opacity: ${ov.opacity};
}

/* --- minimal ------------------------------------------------------------ */

/* Every size on this slide comes from one number in post-config.json.

   It used to be a column of hand-tuned fractions of the frame HEIGHT — 0.0265
   for a name, 0.025 and 0.0225 for the two length steps, four more for the
   cover — which meant "make the type smaller" was an edit to nine literals in
   this file and a judgement call about each one. They are now one percentage
   and a set of ratios off it, so the scale moves together and the decision is
   editable by somebody who is not reading this file.

   At the default the name sets at 32px on a 1080-wide frame, against 51px
   before. That is a large change and it is the intended one: the old size was
   read off reference slides at a moment when the type was also outlined and
   centred, and all three together are what made these read as a graphic laid
   over stock rather than as somebody captioning their own photograph.

   The leading opens up as the type shrinks, which is the opposite of what the
   old comment here reasoned — and both are right. 0.98 was holding a 51px name
   together across a wrap; at 32px the same ratio collides the two lines of a
   name, because the absolute gap is what the eye reads and it has been cut by a
   third. Tracking goes back to zero for the same reason: -0.2px is invisible at
   51px and a visible tightening at 32px. */
.name {
  font-size: ${t.body}px;
  font-weight: ${face.name};
  line-height: 1.12;
  letter-spacing: 0;
  ${clamp}
}
/* The flag sits at the END of the name, inline, not on a line of its own.
   Inline means it wraps with the text and stays part of the name; a line of its
   own turned one label into two stacked objects with air between them. */
.name .emoji { margin-inline-start: 0.26em; }
/* Two steps down, not one. sizeClass emits mid and long for every string it is
   given, and for a while only .long had a rule — so every name between twenty
   and thirty characters carried a class that styled nothing and set at full
   size, which is exactly the length at which a Hebrew place name starts to
   wrap. */
.name.mid { font-size: ${t.bodyMid}px; }
.name.long { font-size: ${t.bodyLong}px; }

/* No .flag block any more — see .name .emoji above. The reference puts the flag
   on its own line and it was copied faithfully; in Hebrew, at this size, it
   read as a detached ornament rather than as part of the label. */

/* One short line under the name, for the decks whose shape asked for it. Set
   below the name in size as well as position: the name is what the slide IS.
   Flex for the same reason .field is — the emoji has to land at the start of
   the line, which in Hebrew is its right. */
.note {
  display: flex;
  align-items: center;
  justify-content: ${align.text === 'left' ? 'flex-end' : 'flex-start'};
  gap: 0.3em;
  margin-top: ${Math.round(t.body * 0.34)}px;
  font-size: ${t.note}px;
  font-weight: ${face.note};
  line-height: 1.12;
  opacity: 0.96;
}

/* --- info --------------------------------------------------------------- */

/* NOT a flex row, unlike .field, and the difference is wrapping.

   As a flex row the flag is a sibling of the whole name, so a name long enough
   to take two lines left the flag floating on its own beside the pair of them,
   vertically centred and visibly detached. Inline, the flag is part of the text
   run: it sits at the end of the last line and wraps with it. The bidi problem
   that forced .field to use flex does not arise here, because at the END of an
   RTL line — which is its left — is exactly where a trailing image belongs. */
.title-info {
  font-size: ${t.body}px;
  font-weight: ${face.name};
  line-height: 1.12;
  letter-spacing: 0;
  text-wrap: balance;
  ${clamp}
}
.title-info .emoji { margin-inline-start: 0.28em; }
.title-info.mid { font-size: ${t.bodyMid}px; }
.title-info.long { font-size: ${t.bodyLong}px; }

/* A clear blank line between the name and the numbers, exactly as the
   reference has it. This is the ONLY generous gap on the slide; everywhere else
   the leading does the work, which is what keeps four fields reading as one
   block instead of four separate thoughts. */
.fields {
  margin-top: ${Math.round(t.body * 0.7)}px;
  display: flex;
  flex-direction: column;
  align-items: ${align.items};
}
/* Laid out as a flex row rather than as a line of text, and that is a fix
   rather than a preference.

   The emoji leads the line in the reference — a boot, then "Difficulty: Easy".
   In Hebrew the line starts on the RIGHT, so the emoji belongs on the right.
   Written as inline content it did not go there: an <img> is a neutral run to
   the bidi algorithm, which reordered it to the far left of every field. Flex
   honours the direction property directly, so the first child is the
   right-hand one and there is nothing left to resolve. */
.field {
  display: flex;
  align-items: center;
  justify-content: ${align.text === 'left' ? 'flex-end' : 'flex-start'};
  gap: 0.32em;
  font-size: ${t.field}px;
  font-weight: ${face.field ?? face.name};
  line-height: 1.24;
  white-space: nowrap;
}
.field.long { font-size: ${t.fieldLong}px; }

/* --- cover -------------------------------------------------------------- */

/* A hair larger than a place name and no more — overlay.coverSizePct against
   overlay.sizePct, 34 against 32 by default.

   The cover used to be set a third larger again, and differently per style, on
   the theory that the first slide is a title card. It is not: it is the frame
   somebody decides in half a second whether to swipe past, and type that fills
   a third of it is what tells them it is an advertisement. The four length
   steps stay, because a cover is a sentence and sentences vary; they are ratios
   off the one number now rather than eight more fractions of the frame.

   Clamped to the same two lines as everything else. A cover that needs three is
   a cover that needs rewriting, and the truncation is the signal. */
.cover {
  font-weight: ${face.cover};
  line-height: 1.16;
  letter-spacing: 0;
  font-size: ${t.cover}px;
  text-wrap: balance;
  ${clamp}
}
.cover.mid { font-size: ${t.coverMid}px; }
.cover.long { font-size: ${t.coverLong}px; }
.cover.xlong { font-size: ${t.coverXlong}px; }

/* Hebrew has no capitals, so the one word the reference covers shout — "you
   HAVE to visit WYOMING" — is carried by colour instead.

   Except in the info style, where the whole cover is already cream over bronze
   and a second colour inside it reads as two treatments arguing. The reference
   sets those covers in one colour throughout; the emphasis there is carried by
   the line break and the size, which is enough.

   The emphasis is the one phrase on the cover that must not break: "שאסור
   לפספס" set with שאסור at the end of one line and לפספס at the start of the
   next is two coloured fragments rather than one shouted phrase. Held on one
   line only when it is short, or a long emphasis would force an overflow. */
.emph { color: ${style === 'info' ? 'inherit' : 'var(--accent)'}; }
.emph.tight { white-space: nowrap; }

/* --- shared ------------------------------------------------------------- */

.emoji {
  display: inline-block;
  vertical-align: -0.16em;
  /* No stroke or shadow on artwork. Those are for letterforms; on a drawing
     they look like a printing fault. */
  -webkit-text-stroke: 0;
  filter: drop-shadow(0 2px 5px rgba(0,0,0,0.4));
}
`;
};

/**
 * How the type is painted, given what the photograph underneath it measures.
 *
 * The minimal style has no outline at all. That is the whole difference between
 * type that looks like it came out of the app and type that looks like it was
 * burned in afterwards: a stroke around every letter is not something TikTok's
 * text tool can produce, so the eye reads it as foreign no matter how good the
 * rest of the slide is. Legibility comes from the colour being chosen correctly
 * and from a shadow soft enough that you cannot see it.
 */
function ink(spot, style, { cover = false } = {}) {
  const onDark = spot?.onDark !== false;

  // How hard the shadow works, from how little contrast the region offered.
  // This is the whole reason light type can stay light on a mid-tone sky
  // instead of flipping to near-black the moment the arithmetic tips over.
  const force = Math.max(0, Math.min(1, spot?.shadow ?? 0));

  if (style === 'info') {
    // Cream over bronze on every slide, cover included. It is the one thing
    // that makes the reference's info slides recognisable at a glance, and
    // unlike the minimal style it does not adapt: the outline is what carries
    // it over any photograph.
    return [
      `color: ${CREAM}`,
      'paint-order: stroke fill',
      `-webkit-text-stroke: var(--stroke) ${BRONZE}`,
      `text-shadow: 0 ${2 + Math.round(force * 2)}px ${8 + Math.round(force * 8)}px rgba(0,0,0,${(
        0.3 +
        force * 0.24
      ).toFixed(2)})`,
    ].join(';');
  }

  // The cover is set in the same white or near-black as everything else, and
  // the colour goes on the EMPHASIS alone — one phrase, loud, the rest plain.
  // Tinting the whole line was tried and it loses the thing the tint is for:
  // if every word is cream, no word is shouted.
  const colour = spot?.color || '#FFFFFF';

  // One configured drop shadow, and it is meant to be barely visible.
  //
  // This was two stacked shadows whose radius and opacity both scaled with the
  // measured shortfall — up to a 26px spread at 0.64 alpha, which is not a
  // shadow, it is a dark halo the size of the word. That was doing legibility
  // work that now has a better owner: `assist` measures the same shortfall and
  // fades a soft wash in behind the block, and the type colour still flips to
  // near-black over a genuinely pale frame.
  //
  // Dark type over a pale photograph keeps the inverse treatment — a faint halo
  // of the background's own brightness — because a black drop shadow under
  // near-black letters separates nothing.
  const light = String(postConfig().overlay.shadow);
  const shadow = onDark
    ? light
    : `0 1px 2px rgba(255,255,255,${(0.4 + force * 0.3).toFixed(2)}), ` +
      `0 2px ${12 + Math.round(force * 10)}px rgba(255,255,255,${(0.36 + force * 0.34).toFixed(2)})`;

  return [`color: ${colour}`, '-webkit-text-stroke: 0', `text-shadow: ${shadow}`].join(';');
}

/**
 * Measured in characters, which for one script at one weight is close enough.
 *
 * `xlong` is opt-in: a place name has two steps and a cover has three, and a
 * caller that does not ask for the fourth must never be handed a class the
 * stylesheet has no rule for.
 */
export const sizeClass = (text, { mid = 22, long = 34, xlong = Infinity } = {}) => {
  const n = String(text || '').length;
  if (n > xlong) return ' xlong';
  if (n > long) return ' long';
  if (n > mid) return ' mid';
  return '';
};

/**
 * The cover line, with one word set louder.
 *
 * The word is matched inside the title rather than appended: a model that
 * returns an emphasis which is not in the line has misunderstood, and the right
 * answer then is to set the line plainly, not to invent a layout for it.
 */
export function coverTitle(title, emphasis) {
  const t = String(title || '');
  const e = String(emphasis || '').trim();
  const cls = `cover${sizeClass(t, { mid: 20, long: 30, xlong: 42 })}`;

  const at = e ? t.indexOf(e) : -1;
  if (at < 0) return `<div class="${cls}">${escapeHtml(t)}</div>`;

  const emphCls = `emph${e.length <= 14 ? ' tight' : ''}`;
  return (
    `<div class="${cls}">` +
    escapeHtml(t.slice(0, at)) +
    `<span class="${emphCls}">${escapeHtml(e)}</span>` +
    escapeHtml(t.slice(at + e.length)) +
    `</div>`
  );
}

const photoTag = (image) =>
  image?.src
    ? `<img class="photo" src="${escapeHtml(image.src)}" alt="">`
    : `<div class="photo" style="background:linear-gradient(160deg, ${palette.inkSoft}, ${palette.ink})"></div>`;

/**
 * The local wash behind the text, sized to the block and only drawn when the
 * measured contrast was not enough on its own.
 */
function assistTag(spot, { w, h }, blockH) {
  // Switchable, and off means off. It is a soft-edged radial fade rather than a
  // panel — there is no box on these slides and this is not one — but it is the
  // only thing on the frame that puts anything behind the words, so the switch
  // for "nothing behind the words, ever" belongs here.
  if (!postConfig().overlay.assist) return '';
  const strength = spot?.assist || 0;
  if (strength < 0.06) return '';

  const cw = Math.round(spot.width * w * 1.5);
  const ch = Math.round(blockH * h * 2.4);
  const cx = Math.round(spot.x * w - cw / 2);
  const cy = Math.round(spot.y * h - ch / 2);

  // Dark wash under light type, light wash under dark type. Capped well below
  // opaque: this is meant to bend the photograph a little, not to put a panel
  // on it.
  const alpha = Math.min(0.5, 0.2 + strength * 0.34).toFixed(3);
  const tint = spot.onDark === false ? `255,255,255` : `0,0,0`;

  return (
    `<div class="assist" style="left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;` +
    `background:radial-gradient(closest-side, rgba(${tint},${alpha}) 0%, rgba(${tint},${(alpha * 0.55).toFixed(
      3
    )}) 52%, rgba(${tint},0) 100%)"></div>`
  );
}

/**
 * One slide.
 *
 * `spot` is what render/photo.js measured for THIS photograph at THIS size: the
 * centre of the empty region, how wide it is, and the colour the type has to be
 * to survive there. Everything positional on the slide comes from it, which is
 * why no band or side is passed in any more — there is no fixed layout left to
 * choose between.
 */
export function renderSlideHtml(slide, { size = 'tiktok', cover = false, style = 'minimal', spot = null, font = null } = {}) {
  const s = SIZES[size] || SIZES.tiktok;
  const { w, h } = s;
  const t = typeScale(s);
  const ov = t.ov;

  // A sane default when measurement was unavailable — no photograph, or an
  // image that would not decode. The configured column, in the upper band,
  // white: the same place a measured slide would have put it, so an unmeasured
  // slide in a deck does not visibly jump out of the series. It used to fall
  // back to dead centre at 0.8 of the frame width, which is the one arrangement
  // the rest of this file exists to avoid.
  const place = spot || {
    x: ov.x,
    y: (ov.bands.upper[0] + ov.bands.upper[1]) / 2,
    width: ov.width,
    color: '#FFFFFF',
    onDark: true,
    assist: 0,
    accent: null,
  };

  const blockH = slide.blockH || (cover ? 0.16 : style === 'info' ? 0.22 : 0.1);

  // A guaranteed margin, applied after the search rather than trusted from it.
  // The placement columns already keep clear of the edges, but the guarantee
  // belongs here: whatever any future scoring change does, text cannot end up
  // touching the side of the frame, which is what the first renders did.
  const margin = Math.round(w * 0.06);
  const width = Math.min(Math.round(place.width * w), w - margin * 2);
  const left = Math.max(margin, Math.min(w - margin - width, Math.round((place.x - place.width / 2) * w)));
  const top = Math.round(place.y * h);

  // Cream is the accent over a dark frame and useless over a pale one — it is
  // the same luminance as a bright sky. render/photo.js returns null when the
  // block crosses a band the cream could not survive, and falling back to cream
  // anyway is what let a coloured phrase vanish into a mountain. Over a light
  // frame the emphasis goes to a deep amber instead, which is legible there for
  // the same reason cream is not.
  const accent = place.accent || (place.onDark === false ? '#8A5300' : CREAM);
  // Sized off the type, not off the frame — see typeScale. A stroke that was
  // right around 68px letters closes the counters of 32px ones.
  const vars = [`--accent:${accent}`, `--stroke:${t.stroke}px`].join(';');

  let body;
  if (cover) {
    body = coverTitle(slide.titleHe, slide.emphasisHe);
  } else if (style === 'info') {
    // The name, then a blank line, then the same fields in the same order on
    // every slide of the deck. The consistency is what makes them scan rather
    // than read.
    // The flag inline at the end of the name, so it wraps with the text rather
    // than sitting beside the block.
    const name = escapeHtml(slide.nameHe) + (slide.flag ? emojiHtml(slide.flag, { size: '0.92em' }) : '');

    // Emoji first: in an RTL flex row that is the right-hand end, which is
    // where a Hebrew line starts and where the reference puts it.
    const fields = (slide.fields || [])
      .slice(0, 4)
      .map(
        (f) =>
          `<div class="field${String(f.value).length > 18 ? ' long' : ''}">` +
          `${emojiHtml(f.emoji, { size: '0.95em' })}` +
          `<span>${escapeHtml(f.labelHe)}: ${escapeHtml(f.value)}</span></div>`
      )
      .join('');

    body =
      `<div class="title-info${sizeClass(slide.nameHe, { mid: 18, long: 26 })}">${name}</div>` +
      (fields ? `<div class="fields">${fields}</div>` : '');
  } else {
    // Name, country, flag. Nothing else, unless there is one short note — and
    // even then it is one line, not a sentence.
    const label = [slide.nameHe, slide.countryHe ? `, ${slide.countryHe}` : ''].join('').trim();

    // A measured fact makes a fine note when the deck has one and no written
    // bullet. A summit deck that lands in the minimal style still wants to say
    // how high the summit is — that is the whole reason the fact was fetched —
    // and it reads better here WITHOUT its label: "🗻 3,967 מ׳" says everything
    // "🗻 גובה: 3,967 מ׳" does, in a style whose entire premise is fewer words.
    const field = (slide.fields || [])[0];
    const note =
      (slide.bullets || [])[0] || (field ? { emoji: field.emoji, text: field.value } : null);

    body =
      `<div class="name${sizeClass(label, { mid: 20, long: 30 })}">${escapeHtml(label)}` +
      (slide.flag ? emojiHtml(slide.flag, { size: '0.92em' }) : '') +
      `</div>` +
      // Parenthesised, because on most slides of a deck this line is absent
      // entirely. A bare word under one name out of six reads as a caption that
      // lost its label; "(מאתגר)" reads as an aside, which is what it is.
      //
      // NO EMOJI on this line. A model picking one freely for an arbitrary
      // sentence produces decoration rather than meaning — a sheaf of wheat
      // turned up beside "this is where the Velvet Revolution happened" — and a
      // picture that does not mean anything is worse than no picture. The
      // flag stays because it says which country, and the info style's field
      // emoji stay because they are a fixed set tied to fixed labels: a boot
      // for difficulty, a ruler for distance. Those earn their place; a free
      // choice does not.
      (note ? `<div class="note"><span>(${escapeHtml(note.text)})</span></div>` : '');
  }

  // Nothing at the bottom. Not one reference post carries a domain, and a URL
  // burned into a photograph is the most reliable sign that a post was made by
  // a company rather than a person. The sources travel in the approval message.
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css(
    s,
    style,
    font,
    SIZES[size] ? size : 'tiktok'
  )}</style></head><body>
${photoTag(slide.image)}
<div class="scrim"></div>
${assistTag(place, s, blockH)}
<div class="block" style="${vars};left:${left}px;top:${top}px;width:${width}px;${ink(place, style, {
    cover,
  })}">${body}</div>
</body></html>`;
}
