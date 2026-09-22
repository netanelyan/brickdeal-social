import { baseCss, escapeHtml as e, palette, pillarAccent, siteMark, SCRIM_INK, CARD_W, CARD_H } from './theme.js';

// The layout set.
//
// Two families. The photo family puts a photograph in charge and lets the words
// sit underneath it; the text-led family needs no photograph at all, which is
// what actually sidesteps image licensing rather than managing it — a fact, a
// set of tips, a seasonal strip and an entry-rule change are all better served
// by type than by a stock photo of somewhere the post isn't even about.
//
// Every layout is 1080x1350 (4:5), the tallest ratio Instagram accepts.
//
// THE CARD CARRIES THE HEADLINE AND NOTHING ELSE.
//
// The draft still has a `subhead` and it is still worth writing — it just does
// not belong here. It opens the description instead, so the card poses and the
// caption answers. A card that already says everything gives nobody a reason to
// tap "more", and on Instagram the tap is the whole game.
//
// This is why you will not find `d.subhead` rendered in any layout below.

export const PHOTO_LAYOUTS = ['photoFull', 'photoBand', 'photoFrame'];
export const TEXT_LAYOUTS = ['fact', 'numbers', 'compare', 'tips', 'whenToGo', 'alert', 'route'];
export const LAYOUTS = [...PHOTO_LAYOUTS, ...TEXT_LAYOUTS];

export const isPhotoLayout = (l) => PHOTO_LAYOUTS.includes(l);

// What a photo layout degrades to when no image is available. Never an empty
// frame — in v1, with no image provider configured, this is the path that
// actually runs every time.
export const PHOTO_FALLBACK = 'fact';

export const LAYOUT_HE = {
  photoFull: 'תמונה מלאה',
  photoBand: 'תמונה + פס טקסט',
  photoFrame: 'תמונה ממוסגרת',
  fact: 'כרטיס עובדה',
  numbers: 'כרטיס מספר',
  compare: 'מיתוס מול מציאות',
  tips: 'כרטיס טיפים',
  whenToGo: 'מתי ללכת',
  alert: 'עדכון כניסה',
  route: 'קו חדש',
};

const HE_MONTH_ABBR = ['ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יונ', 'יול', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'];

// Hebrew sets tighter than Latin at the same point size, so these thresholds
// are tuned against rendered Hebrew rather than borrowed from an English layout.
function headlineSize(text, { max = 'xl' } = {}) {
  const n = String(text || '').length;
  if (max === 'md') return n > 60 ? 'sm' : 'md';
  if (max === 'lg' || n > 46) return n > 70 ? 'md' : 'lg';
  return n > 30 ? 'lg' : 'xl';
}

// The card carries no source line. That is a presentation decision, not a
// weakening of the sourcing rule: the approval message still prints the full
// source URL unconditionally on every candidate, and nothing publishes without
// a tap on that message. What changed is that the artefact people scroll past
// is a hook rather than a citation.

// "יפן · יפן" happened: for a country-level post the model fills place and
// country with the same word. Dedupe rather than print it twice.
const placeLine = (d) => {
  const parts = [d.place, d.country].map((x) => String(x || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' · ');
};

// The wordmark carries the address under it. Evaluated per render rather than
// frozen at import, so a change to SITE_URL takes effect without a restart.
const brandMark = () =>
  `<div class="brand"><div class="word">טיול<span>+</span></div><div class="site">${e(siteMark())}</div></div>`;

/* -------------------------------------------------------------------------- */
/* Text-led shell                                                             */
/* -------------------------------------------------------------------------- */

// The header label used to be the pillar name — "מתי ללכת", "עובדה מפתיעה".
// That is a taxonomy label, and it reads like one: it tells the reader which
// bucket the post came out of, which is a fact about our filing system rather
// than about the place. The place name does the same job of orienting the
// reader and is actually information, so it goes here and comes out of the
// footer. Cards with no place simply show the brand mark alone.
function shell({ accent, kicker, body, extraCss = '' }) {
  return `<style>${baseCss()}${extraCss}</style>
<div class="card" style="--accent:${accent}">
  <div class="head">
    ${brandMark()}
    <div class="kicker">${e(kicker || '')}</div>
  </div>
  <div class="body">${body}</div>
</div>`;
}

/* -------------------------------------------------------------------------- */
/* Photo family — the picture leads, the words sit under it                   */
/* -------------------------------------------------------------------------- */

// The strength each scrim falls back to when the photograph could not be
// measured — the old constants, which were sized for the worst photograph there
// is. Correct for a white sky, and the reason a card over an already-dark
// picture came out murky; see measureCardScrims in ./photo.js.
export const SCRIM_FALLBACK = { bottom: 0.97, top: 0.72 };

/**
 * The two scrims, at whatever strength this photograph turned out to need.
 *
 * The SHAPE of each gradient is fixed and the strength scales it. That split is
 * the point: where the stops sit is a design decision about how the type meets
 * the picture, and how dark they get is a measurement. Scaling the whole ramp
 * by one number keeps the first from drifting every time the second changes.
 */
const photoCss = (scrim = null) => {
  const b = scrim?.bottom ?? SCRIM_FALLBACK.bottom;
  const t = scrim?.top ?? SCRIM_FALLBACK.top;
  const at = (share) => `rgba(${SCRIM_INK},${(b * share).toFixed(3)})`;
  return `
  .photo-card { padding: 0; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  /* Two scrims, not one. The bottom carries the text and needs to be nearly
     opaque where the words sit; the top only has to lift the brand mark off a
     bright sky. A single full-height gradient would either wash out the
     photograph or leave the headline unreadable over a pale horizon. */
  .scrim-bottom {
    position: absolute; left: 0; right: 0; bottom: 0; height: 52%;
    background: linear-gradient(to top,
      ${at(1)} 0%, ${at(0.97)} 34%,
      ${at(0.64)} 66%, rgba(${SCRIM_INK},0) 100%);
  }
  .scrim-top {
    position: absolute; left: 0; right: 0; top: 0; height: 22%;
    background: linear-gradient(to bottom, rgba(${SCRIM_INK},${t.toFixed(3)}), rgba(${SCRIM_INK},0));
  }
  .layer { position: relative; z-index: 2; display: flex; flex-direction: column; height: 100%; }

  /* The header, where it sits on the photograph rather than on a ground.

     The scrim above it is sized so that WHITE type clears a contrast threshold,
     and the kicker is not white — it is the accent. Sage sits at luminance
     0.345, and a bright cloud under a correctly-measured top scrim lands at
     about 0.35, so the place name and the thing behind it end up at the same
     lightness and the word disappears into the picture. Making the scrim
     heavier does not fix it either: drive the background down far enough for a
     mid-luminance accent and the top fifth of every photograph goes black.

     A shadow does not care what is behind it. The tight one draws the glyph's
     own edge and is what makes the letterform legible; the wide one lifts the
     whole word off the picture so it reads as type on a photograph rather than
     as part of it. Same two-shadow idiom the TikTok slides use.

     photoFrame's header is deliberately not included: it sits above the
     picture, on the card's own ground, where a shadow would be noise. Nor is
     photoBand's, which is on a solid pill and never touches the photograph. */
  .layer .head .kicker,
  .layer .head .brand {
    text-shadow: 0 1px 2px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.40);
  }
`;
};

/** photoFull — full-bleed picture, the description sitting in the bottom third. */
function photoFullCard(d, accent, image) {
  // The headline is capped a size smaller than on the text cards. This layout's
  // job is to be mainly a picture, and an 86px headline wrapping to three lines
  // pushes the scrim halfway up the frame and buries the photograph.
  return `<style>${baseCss()}${photoCss(image?.scrim)}
    .layer { padding: 66px 78px 58px; justify-content: space-between; }
    .pf-text { display: flex; flex-direction: column; gap: 20px; }
    .pf-text .subhead { font-size: 36px; }
    .head { border-bottom: none; padding-bottom: 0; }
  </style>
  <div class="card photo-card" style="--accent:${accent}">
    <img class="bg" src="${e(image.src)}" alt="">
    <div class="scrim-top"></div><div class="scrim-bottom"></div>
    <div class="layer">
      <div class="head">${brandMark()}<div class="kicker">${e(placeLine(d))}</div></div>
      <div class="pf-text">
        <div class="rule"></div>
        <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>
        
      </div>
    </div>
  </div>`;
}

/** photoBand — picture on top, a solid band of type beneath it. */
function photoBandCard(d, accent, image) {
  return `<style>${baseCss()}${photoCss(image?.scrim)}
    .photo-card { display: flex; flex-direction: column; }
    .pb-img { position: relative; height: 60%; flex: none; overflow: hidden; }
    .pb-img .bg { position: absolute; }
    .pb-chip {
      position: absolute; z-index: 2; top: 44px; right: 48px;
      display: flex; align-items: center; gap: 18px;
      background: rgba(${SCRIM_INK},0.82); backdrop-filter: blur(2px);
      padding: 14px 26px; border-radius: 999px;
    }
    /* The chip is a pill, so the stacked brand is scaled down rather than
       allowed to set the chip's height from the header's 44px wordmark. */
    .pb-chip .brand .word { font-size: 32px; }
    .pb-chip .brand .site { font-size: 15px; margin-top: 5px; letter-spacing: 0.5px; }
    .pb-chip .kicker { font-size: 22px; }
    .pb-body {
      flex: 1; min-height: 0; display: flex; flex-direction: column;
      justify-content: center; gap: 26px; padding: 54px 78px 58px;
      border-top: 6px solid var(--accent);
    }
  </style>
  <div class="card photo-card" style="--accent:${accent}">
    <div class="pb-img">
      <img class="bg" src="${e(image.src)}" alt="">
      <div class="scrim-top"></div>
      <div class="pb-chip">${brandMark()}<div class="kicker">${e(placeLine(d))}</div></div>
    </div>
    <div class="pb-body">
      <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>
      
    </div>
  </div>`;
}

/** photoFrame — inset picture with a gallery caption under it. */
function photoFrameCard(d, accent, image) {
  return `<style>${baseCss()}${photoCss(image?.scrim)}
    .photo-card { padding: 62px 66px 56px; }
    .pfr-img {
      position: relative; height: 700px; flex: none;
      border-radius: 20px; overflow: hidden; margin-top: 30px;
    }
    .pfr-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 22px; padding-top: 40px; }
    .head { border-bottom: none; padding-bottom: 0; }
  </style>
  <div class="card photo-card" style="--accent:${accent}">
    <div class="head">${brandMark()}<div class="kicker">${e(placeLine(d))}</div></div>
    <div class="pfr-img"><img class="bg" src="${e(image.src)}" alt=""></div>
    <div class="pfr-body">
      <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>
      
    </div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Text-led layouts                                                           */
/* -------------------------------------------------------------------------- */

function factCard(d, accent) {
  return shell({
    accent,
    kicker: placeLine(d),
    body: `
      <div class="rule"></div>
      <div class="headline ${headlineSize(d.headline)}">${e(d.headline)}</div>
      `,
  });
}

/** numbers — one figure carries the whole card. */
function numbersCard(d, accent) {
  const s = d.stat || {};
  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .stat { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap; }
      .stat-value {
        font-size: 232px; font-weight: 900; line-height: 0.88;
        letter-spacing: -6px; color: var(--accent);
        /* The figure is the point of this card, and a Hebrew label sitting
           beside a Latin numeral is exactly where bidi reorders things. Isolate
           it so "12" never ends up on the wrong side of "אלף". */
        direction: ltr; unicode-bidi: isolate;
      }
      .stat-unit { font-size: 62px; font-weight: 800; color: var(--accent); }
      .stat-label { font-size: 34px; font-weight: 600; color: ${palette.paperDim}; }
      .body { gap: 30px; }`,
    // Deliberately only the figure and the headline. The first version also
    // rendered stat.label AND the subhead, which meant the same fact appeared
    // three times in three registers - the card read like a paragraph with a
    // big number stuck on top. The card is the hook; the caption carries the
    // detail.
    body: `
      <div class="stat">
        <div class="stat-value">${e(s.value)}</div>
        ${s.unit ? `<div class="stat-unit">${e(s.unit)}</div>` : ''}
      </div>
      <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>`,
  });
}

/** compare — two panels, for myth-vs-reality and before-vs-after. */
function compareCard(d, accent) {
  const c = d.compare || {};
  const panel = (title, text, colour, mark) => `
    <div class="cmp" style="--c:${colour}">
      <div class="cmp-head"><span class="cmp-mark">${mark}</span>${e(title)}</div>
      <div class="cmp-text">${e(text)}</div>
    </div>`;

  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .cmps { display: flex; flex-direction: column; gap: 28px; }
      .cmp { border-right: 8px solid var(--c); padding: 26px 30px 28px; background: ${palette.inkSoft}; border-radius: 14px; }
      .cmp-head { display: flex; align-items: center; gap: 14px; font-size: 34px; font-weight: 800; color: var(--c); margin-bottom: 12px; }
      .cmp-mark { font-size: 30px; }
      .cmp-text { font-size: 33px; line-height: 1.4; color: ${palette.paper}; }
      .body { gap: 36px; }`,
    body: `
      <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>
      <div class="cmps">
        ${panel(c.aTitle, c.aText, palette.clay, '✕')}
        ${panel(c.bTitle, c.bText, palette.sage, '✓')}
      </div>`,
  });
}

function tipsCard(d, accent) {
  const items = d.bullets
    .map(
      (b, i) => `
      <li class="tip">
        <div class="num">${i + 1}</div>
        <div class="tip-body">
          <div class="tip-title">${e(b.title)}</div>
          <div class="tip-text">${e(b.text)}</div>
        </div>
      </li>`
    )
    .join('');

  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .tips { list-style: none; display: flex; flex-direction: column; gap: 34px; }
      .tip { display: flex; gap: 26px; align-items: flex-start; }
      .num {
        flex: 0 0 62px; height: 62px; border-radius: 50%;
        background: var(--accent); color: ${palette.ink};
        font-size: 34px; font-weight: 900;
        display: flex; align-items: center; justify-content: center;
      }
      .tip-body { flex: 1; min-width: 0; }
      .tip-title { font-size: 40px; font-weight: 800; line-height: 1.2; margin-bottom: 8px; }
      .tip-text { font-size: 32px; font-weight: 400; line-height: 1.4; color: ${palette.paperDim}; }
      /* Centred rather than top-aligned: three short tips leave ~280px of dead
         space at the bottom otherwise, which reads as a truncated card. */
      .body { justify-content: center; gap: 44px; }`,
    body: `
      <div class="headline ${headlineSize(d.headline, { max: 'lg' })}">${e(d.headline)}</div>
      <ul class="tips">${items}</ul>`,
  });
}

function whenToGoCard(d, accent, data) {
  const months = data?.months || [];
  const colour = { good: palette.sage, shoulder: palette.amber, avoid: palette.clay };

  // Drawn from the climate data itself, never from anything the model wrote —
  // so what the card claims and what the source says cannot drift apart. In an
  // RTL grid the first cell lands on the right, which is where a Hebrew reader
  // expects January.
  const cells = months
    .map(
      (m) => `
      <div class="m">
        <div class="m-bar" style="background:${colour[m.verdict] || 'rgba(242,236,224,0.2)'}"></div>
        <div class="m-name">${HE_MONTH_ABBR[m.month]}</div>
      </div>`
    )
    .join('');

  const legend = [
    ['מומלץ', palette.sage],
    ['בסדר', palette.amber],
    ['פחות', palette.clay],
  ]
    .map(([label, c]) => `<div class="lg"><i style="background:${c}"></i>${label}</div>`)
    .join('');

  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .strip { display: grid; grid-template-columns: repeat(12, 1fr); gap: 10px; }
      .m { display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .m-bar { width: 100%; height: 96px; border-radius: 8px; }
      .m-name { font-size: 22px; font-weight: 600; color: ${palette.paperDim}; }
      .legend { display: flex; gap: 30px; justify-content: flex-start; }
      .lg { display: flex; align-items: center; gap: 10px; font-size: 26px; color: ${palette.paperDim}; }
      .lg i { width: 22px; height: 22px; border-radius: 6px; display: inline-block; }`,
    body: `
      <div class="headline ${headlineSize(d.headline, { max: 'lg' })}">${e(d.headline)}</div>
      
      <div class="strip">${cells}</div>
      <div class="legend">${legend}</div>`,
  });
}

function alertCard(d, accent) {
  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .badge {
        align-self: flex-start;
        background: ${palette.clay}; color: ${palette.paper};
        font-size: 28px; font-weight: 800;
        padding: 12px 26px; border-radius: 999px;
      }`,
    body: `
      <div class="badge">שינוי בכללי הכניסה</div>
      <div class="headline ${headlineSize(d.headline, { max: 'lg' })}">${e(d.headline)}</div>
      `,
  });
}

/** route — a new or returning line out of TLV. Never fares. */
function routeCard(d, accent) {
  const r = d.route || {};
  const meta = [
    r.operator ? ['מפעילה', r.operator] : null,
    r.startsOn ? ['מתחיל', r.startsOn] : null,
  ].filter(Boolean);

  return shell({
    accent,
    kicker: placeLine(d),
    extraCss: `
      .leg { display: flex; align-items: center; gap: 26px; }
      .ep { font-size: 66px; font-weight: 900; line-height: 1.1; white-space: nowrap; }
      .ep.to { color: var(--accent); }
      /* The connector points from origin to destination. In an RTL row the
         origin sits on the right, so the arrowhead belongs on the left end —
         drawn rather than typed, because the ✈ glyph's own direction varies by
         font and would silently point the wrong way. */
      .link { flex: 1; display: flex; align-items: center; min-width: 40px; }
      .link .dash { flex: 1; height: 4px; border-radius: 2px; background: repeating-linear-gradient(
          to right, var(--accent) 0 16px, transparent 16px 28px); }
      .link .tip {
        width: 0; height: 0; margin-left: -2px;
        border-top: 12px solid transparent; border-bottom: 12px solid transparent;
        border-right: 18px solid var(--accent);
      }
      .meta { display: flex; flex-direction: column; gap: 16px; }
      .row { display: flex; gap: 16px; font-size: 32px; align-items: baseline; }
      .row .k { color: ${palette.paperDim}; min-width: 130px; }
      .row .v { font-weight: 700; }
      .body { gap: 40px; }`,
    body: `
      <div class="leg">
        <div class="ep">${e(r.from || 'תל אביב')}</div>
        <div class="link"><div class="tip"></div><div class="dash"></div></div>
        <div class="ep to">${e(r.to)}</div>
      </div>
      <div class="headline ${headlineSize(d.headline, { max: 'md' })}">${e(d.headline)}</div>
      ${meta.length ? `<div class="meta">${meta.map(([k, v]) => `<div class="row"><div class="k">${k}</div><div class="v">${e(v)}</div></div>`).join('')}</div>` : ''}
      `,
  });
}

/* -------------------------------------------------------------------------- */

/**
 * Build the full HTML document for a card.
 *
 * `draft` is a normalised draft (src/draft.js).
 * `data` carries any structured payload a layout draws directly (climate months).
 */
export function renderHtml(draft, { data = null, image = null } = {}) {
  const accent = pillarAccent[draft.pillar] || palette.amber;
  const d = draft;

  // A photo layout without a photograph is an empty frame, so it degrades to
  // the text card instead. With no image provider configured this is not an
  // edge case — it is what happens on every render.
  const layout = isPhotoLayout(d.layout) && !image?.src ? PHOTO_FALLBACK : d.layout;

  let inner;
  switch (layout) {
    case 'photoFull':
      inner = photoFullCard(d, accent, image);
      break;
    case 'photoBand':
      inner = photoBandCard(d, accent, image);
      break;
    case 'photoFrame':
      inner = photoFrameCard(d, accent, image);
      break;
    case 'numbers':
      inner = numbersCard(d, accent);
      break;
    case 'compare':
      inner = compareCard(d, accent);
      break;
    case 'tips':
      inner = tipsCard(d, accent);
      break;
    case 'whenToGo':
      inner = whenToGoCard(d, accent, data);
      break;
    case 'alert':
      inner = alertCard(d, accent);
      break;
    case 'route':
      inner = routeCard(d, accent);
      break;
    case 'fact':
    default:
      inner = factCard(d, accent);
  }

  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>tiyul+ card</title></head>
<body>${inner}</body>
</html>`;
}

export { CARD_W, CARD_H };
