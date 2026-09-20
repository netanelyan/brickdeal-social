import { readFileSync } from 'node:fs';

// Design tokens and the shared stylesheet for every card.
//
// Card size is 1080x1350 (4:5) — the tallest ratio Instagram accepts, which
// gives the text-led layouts the most room. Telegram is happy with it too, so
// one render serves both destinations.

export const CARD_W = 1080;
export const CARD_H = 1350;

export const palette = {
  ink: '#10201F', // near-black with a green cast — the base for text cards
  inkSoft: '#1B302E',
  paper: '#F2ECE0', // warm off-white, used as the text colour on dark cards
  paperDim: 'rgba(242, 236, 224, 0.62)',
  amber: '#E8A33D', // primary accent
  clay: '#C8613C', // secondary accent — alerts, "avoid" months
  sage: '#7FA88A', // tertiary — "good" months
  line: 'rgba(242, 236, 224, 0.14)',
};

// Per-pillar accent, so a run of cards reads as one system while still being
// distinguishable at a glance in the channel.
export const pillarAccent = {
  inCity: palette.amber,
  day: palette.amber,
  route: palette.amber,
  tip: palette.sage,
  timing: palette.sage,
  conditions: palette.clay,
  entry: palette.clay,
};

// The font is bundled and inlined as a data URI rather than linked, for one
// specific reason: a webfont that fails to load doesn't error, it silently
// falls back — and the fallback for Hebrew on a headless Linux VPS is usually
// tofu boxes. Inlining removes the network from the path entirely, and
// render/index.js still asserts the font is loaded before it screenshots.
let fontDataUri = null;
export function heeboDataUri() {
  if (fontDataUri) return fontDataUri;
  const buf = readFileSync(new URL('../../assets/fonts/Heebo.ttf', import.meta.url));
  fontDataUri = `data:font/ttf;base64,${buf.toString('base64')}`;
  return fontDataUri;
}

/**
 * The site, as it should read on the card.
 *
 * A screenshot travels further than the post it came from and arrives with no
 * caption attached, so the card has to carry the address on its own. Derived
 * from SITE_URL rather than written out again, and stripped back to the bare
 * host — the protocol and the www are noise at 20px.
 */
// TikTok Sans, bundled the same way and for the same reason as Heebo: a
// webfont that fails to load does not error, it silently falls back.
//
// ONE VARIABLE FILE, not two static weights — and the two static weights that
// used to sit here were not fonts at all. They were committed with a sfnt
// header of 0x64ad0200, no glyf table and no CFF table, so Chromium rejected
// both on every render since the day they were added. Nothing failed: the
// renderer simply fell through to the next family, and every "TikTok Sans"
// digit on every slide was actually Heebo. The same was true of Rubik below.
//
// That is precisely the silent-fallback failure this file's comments have
// warned about from the beginning, and it survived because nothing checked. It
// is checked now — see the face audit in render/index.js.
let tiktokCache = null;
export function tiktokSansDataUri() {
  if (tiktokCache) return tiktokCache;
  const buf = readFileSync(new URL('../../assets/fonts/TikTokSans.ttf', import.meta.url));
  tiktokCache = `data:font/ttf;base64,${buf.toString('base64')}`;
  return tiktokCache;
}

// Assistant, for the minimal style's Hebrew.
//
// The question "which font does TikTok use for Hebrew" has no answer, and
// finding that out is what settled this. TikTok Sans — the app's own typeface,
// which TikTok publishes under the OFL — has no Hebrew coverage whatsoever:
// Latin, Greek and Cyrillic only. So the app never draws Hebrew in a TikTok
// font. The PHONE falls back: SF Hebrew on iOS, Noto Sans Hebrew on Android.
// What anyone means by "the TikTok font" for Hebrew is whichever of those their
// own handset shows them.
//
// Apple's SF Hebrew cannot be shipped for the same reason Apple's emoji cannot
// — it is theirs, it comes with their operating systems, and rendering happens
// on Linux. Assistant is the closest licensable relative: humanist, slightly
// wider than Heebo, open counters, and it is what Hebrew interfaces reach for
// when they want to look like the system rather than like a brand.
//
// One variable file for every weight the slides ask for — 500 on a note, 600 on
// a name, 700 on a cover — at 97KB, which is less than a single static Rubik.
let assistantCache = null;
export function assistantDataUri() {
  if (assistantCache) return assistantCache;
  const buf = readFileSync(new URL('../../assets/fonts/Assistant.ttf', import.meta.url));
  assistantCache = `data:font/ttf;base64,${buf.toString('base64')}`;
  return assistantCache;
}

// Rubik, for the info style's Hebrew.
//
// Heebo is a text face — it extends Roboto, and set at this size over a
// photograph it reads as a caption. Rubik is a display face with real weight at
// 800, it is what Israeli social graphics are actually set in, and it holds an
// outline without the letterforms closing up.
//
// One variable file, for the reason given above TikTok Sans: the two static
// weights that used to be here were corrupt and had never once loaded.
let rubikCache = null;
export function rubikDataUri() {
  if (rubikCache) return rubikCache;
  const buf = readFileSync(new URL('../../assets/fonts/Rubik.ttf', import.meta.url));
  rubikCache = `data:font/ttf;base64,${buf.toString('base64')}`;
  return rubikCache;
}

export function siteMark() {
  const raw = process.env.SITE_URL || 'https://tiyulplus.com';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return String(raw).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function baseCss() {
  return `
@font-face {
  font-family: 'Heebo';
  src: url('${heeboDataUri()}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  width: ${CARD_W}px;
  height: ${CARD_H}px;
  overflow: hidden;
}

/* RTL is set on the root, not per-element, so bidi resolution happens once and
   every nested run inherits the right base direction. */
body {
  direction: rtl;
  text-align: right;
  font-family: 'Heebo', sans-serif;
  font-feature-settings: 'kern' 1;
  -webkit-font-smoothing: antialiased;
  background: ${palette.ink};
  color: ${palette.paper};
}

.card {
  position: relative;
  width: ${CARD_W}px;
  height: ${CARD_H}px;
  display: flex;
  flex-direction: column;
  padding: 74px 78px 66px;
  background: ${palette.ink};
}

/* A latin word (a domain, a code, an airport) sitting inside a Hebrew line is
   the classic RTL rendering bug: without isolation, neighbouring punctuation
   gets pulled to the wrong side of it. This is the fix, applied everywhere a
   latin run can appear. */
.ltr {
  direction: ltr;
  unicode-bidi: isolate;
  display: inline-block;
}

/* --- header ------------------------------------------------------------- */
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 30px;
  border-bottom: 2px solid var(--accent);
}
/* The wordmark and the address, stacked. In an RTL column flex-start is the
   right edge, which is where the header already puts the brand. */
.brand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1;
  color: ${palette.paper};
}
.brand .word {
  font-size: 44px;
  font-weight: 900;
  letter-spacing: -0.5px;
}
.brand .word span { color: var(--accent); }
/* Quiet on purpose: legible in a screenshot, invisible while you're reading the
   headline. Latin inside an RTL card, so it is isolated like every other latin
   run — without this the dot in the hostname can jump to the wrong end. */
.brand .site {
  margin-top: 9px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.7px;
  color: rgba(242, 236, 224, 0.45);
  direction: ltr;
  unicode-bidi: isolate;
}
.kicker {
  font-size: 29px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.2px;
}

/* --- body --------------------------------------------------------------- */
.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 34px;
  padding: 46px 0;
  min-height: 0;
}

.headline {
  font-weight: 900;
  line-height: 1.12;
  letter-spacing: -1px;
  text-wrap: balance;
}
.headline.xl { font-size: 104px; }
.headline.lg { font-size: 86px; }
.headline.md { font-size: 70px; }
.headline.sm { font-size: 56px; }

.subhead {
  font-size: 40px;
  font-weight: 400;
  line-height: 1.42;
  color: ${palette.paperDim};
  text-wrap: pretty;
}

.rule {
  width: 132px;
  height: 8px;
  border-radius: 4px;
  background: var(--accent);
}

`;
}
