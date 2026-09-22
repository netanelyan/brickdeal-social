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

/** One synthetic room, as an inline SVG data URI. */
export const room = ({ wall, shelf, model, accent, label }) => ({
  label,
  src:
    'data:image/svg+xml;base64,' +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
        <defs>
          <linearGradient id="w" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stop-color="${wall}"/>
            <stop offset="1" stop-color="${shelf}"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1920" fill="url(#w)"/>
        <rect x="0" y="1320" width="1080" height="26" fill="${shelf}" opacity="0.8"/>
        <rect x="0" y="1346" width="1080" height="574" fill="${shelf}"/>
        <g opacity="0.95">
          <rect x="300" y="900" width="480" height="420" rx="14" fill="${model}"/>
          <rect x="360" y="820" width="360" height="90" rx="10" fill="${accent}"/>
          <circle cx="410" cy="1320" r="52" fill="${accent}"/>
          <circle cx="670" cy="1320" r="52" fill="${accent}"/>
        </g>
      </svg>`
    ).toString('base64'),
});

/** The three backgrounds worth testing against, hardest first. */
export const ROOMS = [
  room({ label: 'white wall, daylight', wall: '#F4F2EE', shelf: '#DCD6CC', model: '#C8452F', accent: '#2B4C7E' }),
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
