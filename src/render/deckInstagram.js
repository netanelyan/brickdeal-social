import { baseCss, escapeHtml as e, palette, pillarAccent, siteMark } from './theme.js';
import { emojiHtml } from './emojiArt.js';

// The same deck, drawn as a carousel of cards.
//
// A deck has always rendered twice — 1080x1920 for TikTok, 1080x1350 for
// Instagram — but both sizes came out of the same template, so the Instagram
// set was a TikTok slide with less headroom. That is the wrong artefact for the
// grid. A TikTok slide is designed to be legible over a video player's
// furniture, at arm's length, for two seconds, with no branding on it at all;
// an Instagram post sits in a feed next to our own news cards and should look
// like it came from the same account.
//
// So this module renders the deck's CONTENT in the CARD's design language:
// theme.js's baseCss, the same wordmark, the same accent rule under the same
// header, the same type scale. The words and the photographs are identical to
// the TikTok slides — this is one deck published twice, never two decks.
//
// WHAT IS DELIBERATELY DIFFERENT FROM THE TIKTOK SLIDE
//
//   - The text does not move. A TikTok slide runs a placement search to find a
//     quiet region of the photograph, because its text can go anywhere. A card
//     pins its header to the top and its headline to the bottom, so the search
//     is not merely unnecessary here, it would break the thing that makes a run
//     of cards read as a set: they line up. This also means the Instagram set
//     costs no image analysis at all.
//   - The brand is on it. Cards carry the wordmark and the site; TikTok slides
//     carry neither, on purpose (see the note at the end of renderSlideHtml —
//     a URL burned into a photograph reads as an advert).
//   - The slide is numbered. A carousel gives no progress indication of its
//     own, and a six-place list that does not say which place you are on is a
//     list you cannot navigate.

// Every slide is the card size. Imported from theme rather than from the deck's
// SIZES table so that a change to the card dimensions moves both together —
// these are cards, and the day they stop matching the cards is the day this
// stops doing its job.
import { CARD_W, CARD_H } from './theme.js';

const brandMark = () =>
  `<div class="brand"><div class="word">טיול<span>+</span></div><div class="site">${e(siteMark())}</div></div>`;

/**
 * How large the name is allowed to be, by how long it is.
 *
 * Same intent as the cards' headlineSize: a two-word place name should be big,
 * and a long one should not wrap to four lines and push the scrim up over the
 * photograph. Measured in characters because Hebrew has no reliable word-length
 * proxy and the names here are short enough for the count to be a good one.
 */
function nameSize(text) {
  const n = String(text || '').length;
  if (n <= 16) return 92;
  if (n <= 26) return 76;
  if (n <= 38) return 62;
  return 52;
}

function titleSize(text) {
  const n = String(text || '').length;
  if (n <= 20) return 104;
  if (n <= 32) return 86;
  if (n <= 46) return 72;
  return 60;
}

/**
 * The scrims.
 *
 * Two gradients rather than one flat overlay, for the reason the card layouts
 * already found: a single wash over the whole frame dims the photograph
 * everywhere to fix contrast in two places. The top one carries the header, the
 * bottom one carries the name, and the middle of the picture is left alone.
 *
 * Strength comes from the measured scrim when render/photo.js supplied one, and
 * otherwise from the card's own fallback — which is sized for the worst
 * photograph there is, and is the right way to be wrong.
 */
function scrimCss(scrim) {
  const bottom = scrim?.bottom ?? 0.97;
  const top = scrim?.top ?? 0.72;
  return `
  .scrim-top {
    position: absolute; inset: 0 0 auto 0; height: 34%;
    background: linear-gradient(to bottom, rgba(16,32,31,${top}) 0%, rgba(16,32,31,0) 100%);
  }
  .scrim-bottom {
    position: absolute; inset: auto 0 0 0; height: 58%;
    background: linear-gradient(to top, rgba(16,32,31,${bottom}) 0%, rgba(16,32,31,0.86) 34%, rgba(16,32,31,0) 100%);
  }`;
}

const photoTag = (image) =>
  image?.src
    ? `<img class="bg" src="${e(image.src)}" alt="">`
    : // No photograph is not an error — a deck built with no image provider
      // configured renders every slide this way. A flat ink field with the
      // accent showing through reads as a deliberate text card rather than as a
      // picture that failed to load.
      `<div class="bg bg-empty"></div>`;

/**
 * One slide of a deck, as a card.
 *
 * `index` and `total` are 1-based and count the cover, so a six-place deck
 * numbers 1..7 and the cover says 1. That matches what the viewer swipes
 * through, which is the only count they can check it against.
 */
export function renderInstagramSlideHtml(
  slide,
  { cover = false, style = 'minimal', index = 1, total = 1, kicker = '', pillar = 'day' } = {}
) {
  const accent = pillarAccent[pillar] || palette.amber;

  let body;
  if (cover) {
    // The cover is the title and nothing else, exactly as on TikTok. The
    // emphasis phrase keeps its accent colour — it is the one piece of the
    // deck's own design that survives into this one, because it is content
    // rather than decoration: the model chose which words to lift.
    const title = e(slide.titleHe || '');
    const emph = String(slide.emphasisHe || '').trim();
    const marked =
      emph && title.includes(e(emph))
        ? title.replace(e(emph), `<span class="emph">${e(emph)}</span>`)
        : title;
    body = `<div class="title" style="font-size:${titleSize(slide.titleHe)}px">${marked}</div>`;
  } else {
    const name =
      e(slide.nameHe || '') + (slide.flag ? emojiHtml(slide.flag, { size: '0.86em' }) : '');

    // The info style's fields, in the order they appear on every other slide of
    // the deck. Consistency is the whole point of them: they are there to be
    // scanned down the carousel, not read.
    const fields =
      style === 'info'
        ? (slide.fields || [])
            .slice(0, 3)
            .map(
              (f) =>
                `<div class="field">${emojiHtml(f.emoji, { size: '0.95em' })}` +
                `<span>${e(f.labelHe)}: ${e(f.value)}</span></div>`
            )
            .join('')
        : '';

    // The minimal style's single note, parenthesised for the same reason the
    // TikTok slide parenthesises it: on most slides this line is absent, and a
    // bare word under one name out of six reads as a caption that lost its
    // label.
    const field = (slide.fields || [])[0];
    const note =
      style === 'info'
        ? null
        : (slide.bullets || [])[0] || (field ? { text: field.value } : null);

    body =
      `<div class="name" style="font-size:${nameSize(slide.nameHe)}px">${name}</div>` +
      (slide.countryHe ? `<div class="country">${e(slide.countryHe)}</div>` : '') +
      (fields ? `<div class="fields">${fields}</div>` : '') +
      (note ? `<div class="note">(${e(note.text)})</div>` : '');
  }

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>
${baseCss()}
${scrimCss(slide.image?.scrim)}
.card { padding: 0; }
.bg {
  position: absolute; inset: 0;
  width: ${CARD_W}px; height: ${CARD_H}px;
  object-fit: cover;
}
.bg-empty { background: linear-gradient(160deg, ${palette.inkSoft} 0%, ${palette.ink} 70%); }

/* The card's own furniture, over the photograph. Same padding as .card so a
   deck slide and a news card line up when they sit next to each other in the
   grid — which they will, because they are posted to the same account. */
.layer {
  position: absolute; inset: 0; z-index: 2;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 74px 78px 66px;
}
.head { border-bottom: 2px solid var(--accent); }

/* The counter. Latin digits inside an RTL header, so it is isolated like every
   other latin run — without this the slash lands on the wrong side. */
.count {
  font-size: 29px; font-weight: 700; color: var(--accent);
  direction: ltr; unicode-bidi: isolate;
}
.kick { font-size: 26px; font-weight: 600; color: rgba(242,236,224,0.62); margin-top: 8px; }

.foot { display: flex; flex-direction: column; gap: 18px; }
.rule { width: 132px; height: 6px; background: var(--accent); border-radius: 3px; }
.title { font-weight: 900; line-height: 1.08; letter-spacing: -1px; }
.title .emph { color: var(--accent); }
.name { font-weight: 900; line-height: 1.1; letter-spacing: -0.5px; }
.country { font-size: 34px; font-weight: 600; color: rgba(242,236,224,0.72); }
.fields { display: flex; flex-direction: column; gap: 12px; margin-top: 6px; }
.field {
  display: flex; align-items: center; gap: 14px;
  font-size: 32px; font-weight: 600; color: ${palette.paper};
}
.note { font-size: 32px; font-weight: 600; color: rgba(242,236,224,0.72); }
</style></head><body>
<div class="card" style="--accent:${accent}">
  ${photoTag(slide.image)}
  <div class="scrim-top"></div><div class="scrim-bottom"></div>
  <div class="layer">
    <div class="head">
      ${brandMark()}
      <div>
        <div class="count">${index} / ${total}</div>
        ${kicker ? `<div class="kick">${e(kicker)}</div>` : ''}
      </div>
    </div>
    <div class="foot">
      <div class="rule"></div>
      ${body}
    </div>
  </div>
</div>
</body></html>`;
}
