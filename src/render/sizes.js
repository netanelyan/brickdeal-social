// The two frames a slideshow is rendered at, and what each platform draws over.
//
// Both ends of a TikTok frame belong to the app rather than to us: the search
// bar and the slide counter at the top, the caption, the handle and the sound
// at the bottom. Anything placed inside those bands is placed underneath
// somebody else's interface.
//
// Instagram's numbers are not about furniture — the feed draws almost nothing
// over the image — they are about composition. At 80 and 110 a block could sit
// within six percent of an edge, and type pinned to the rim of a frame reads as
// a mistake rather than as a choice.
//
// Lifted out of the old deckTemplates.js when that file went with the travel
// pipeline. It is geometry, it is shared by every renderer here, and it is the
// one thing in that file that was never about a particular look.
export const SIZES = {
  tiktok: { w: 1080, h: 1920, topSafe: 300, bottomSafe: 400 },
  instagram: { w: 1080, h: 1350, topSafe: 150, bottomSafe: 175 },
};
