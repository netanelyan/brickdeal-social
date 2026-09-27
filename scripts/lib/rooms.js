// Stand-in photographs, for looking at slides without paying for real ones.
//
// Not photographs and not trying to be. The real ones are generated per product
// and cost money and a minute each, and none of the questions these are used to
// answer are about the picture — they are about whether the type holds up over
// the three kinds of background a home shot actually produces, and whether five
// slides read as one post.
//
// What they reproduce is the thing that decides legibility: the luminance of
// the region the words land in, and whether a hard edge runs through it. The
// worst case by a distance is a white wall in daylight, which is also the most
// common, so it is first in every list here.
//
// Shared by brick-lab (type iteration) and brick-once --rooms (whole decks).

/**
 * One synthetic room, as an inline SVG data URI.
 *
 * `tall` puts the model up against the top edge, which is the photograph the
 * generator keeps coming back with for a bouquet or a plant and the case the
 * whole layout falls over on. A slide measures its picture and moves it to make
 * room for the type — see src/render/headroom.js — so a lab that only ever
 * renders well-framed stand-ins is a lab that cannot show that working.
 *
 * `preserveAspectRatio="none"` IS LOAD-BEARING HERE AND NOWHERE ELSE. These are
 * 1080x1920 drawings dropped into 1080x1920 frames, so it changes nothing about
 * how they normally render. It matters when the renderer stretches the top
 * strip of the picture vertically to extend a wall: a raster photograph, which
 * is what every real slide carries, stretches: an SVG keeps its own aspect
 * ratio inside whatever box it is given and letterboxes instead, which would
 * make the stand-ins fail at a thing the real photographs do fine.
 */
export const room = ({ wall, shelf, model, accent, label, tall = false }) => ({
  label,
  src:
    'data:image/svg+xml;base64,' +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920" preserveAspectRatio="none">
        <defs>
          <linearGradient id="w" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stop-color="${wall}"/>
            <stop offset="1" stop-color="${shelf}"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1920" fill="url(#w)"/>
        <rect x="0" y="1320" width="1080" height="26" fill="${shelf}" opacity="0.8"/>
        <rect x="0" y="1346" width="1080" height="574" fill="${shelf}"/>
        ${
          tall
            ? `<g opacity="0.95" stroke="${model}" stroke-width="18" fill="none">
                 <path d="M540 1500 L540 150"/><path d="M540 1500 L360 330"/><path d="M540 1500 L720 380"/>
               </g>
               <g opacity="0.95" fill="${accent}">
                 <circle cx="540" cy="150" r="78"/><circle cx="360" cy="320" r="66"/><circle cx="720" cy="370" r="66"/>
                 <circle cx="470" cy="640" r="58"/><circle cx="620" cy="760" r="58"/>
               </g>
               <rect x="430" y="1460" width="220" height="200" rx="30" fill="${model}" opacity="0.95"/>`
            : `<g opacity="0.95">
                 <rect x="300" y="900" width="480" height="420" rx="14" fill="${model}"/>
                 <rect x="360" y="820" width="360" height="90" rx="10" fill="${accent}"/>
                 <circle cx="410" cy="1320" r="52" fill="${accent}"/>
                 <circle cx="670" cy="1320" r="52" fill="${accent}"/>
               </g>`
        }
      </svg>`
    ).toString('base64'),
});

/** The four backgrounds worth testing against, hardest first. */
export const ROOMS = [
  room({ label: 'white wall, daylight', wall: '#F4F2EE', shelf: '#DCD6CC', model: '#C8452F', accent: '#2B4C7E' }),
  // The one the type used to land on. Same white wall, and a model that reaches
  // the top edge of the frame the way a bouquet does.
  room({ label: 'no room above the model', wall: '#F4F2EE', shelf: '#DCD6CC', model: '#2F6B3C', accent: '#B8355C', tall: true }),
  room({ label: 'oak shelf, warm lamp', wall: '#C9A97E', shelf: '#8A6A46', model: '#2F6B3C', accent: '#E0C24A' }),
  room({ label: 'dim bedroom, night', wall: '#2A2E36', shelf: '#171A20', model: '#9C2B2B', accent: '#D8D2C4' }),
];

// Model colours, so five slides of one deck are not five photographs of the
// same object. A real deck's pictures differ because the sets differ, and a
// contact sheet of five identical shapes hides exactly the thing the sheet is
// for: whether the slides read as a series.
const MODELS = [
  ['#C8452F', '#2B4C7E'],
  ['#2F6B3C', '#E0C24A'],
  ['#1F4E79', '#D8D2C4'],
  ['#7A4A9C', '#E8C9A0'],
  ['#B8860B', '#3A3A3A'],
  ['#0F6B6B', '#E8E2D4'],
  ['#8B2F52', '#D9C36B'],
];

/**
 * A different room per slide, cycling the walls slowly and the models quickly.
 *
 * Deliberately not random: the same index gives the same picture on every run,
 * so a change to the type can be compared against the previous contact sheet
 * rather than against a different set of backgrounds.
 */
export function roomFor(i) {
  const walls = [
    ['#F4F2EE', '#DCD6CC'],
    ['#EDE8E0', '#CFC6B8'],
    ['#C9A97E', '#8A6A46'],
    ['#2A2E36', '#171A20'],
  ];
  const [wall, shelf] = walls[Math.floor(i / 2) % walls.length];
  const [model, accent] = MODELS[i % MODELS.length];
  return room({ wall, shelf, model, accent, label: `room ${i + 1}` });
}
