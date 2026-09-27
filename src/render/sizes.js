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
//
// `photoAnchorPct` IS WHERE A PHOTOGRAPH THAT DOES NOT FIT THE FRAME IS CUT,
// and on the 4:5 render it is the difference between a slide that works and one
// that does not.
//
// The shots are generated 9:16, because that is the TikTok frame. Dropped into
// a 1080x1350 slide they are scaled to the width and 570px of height has to go
// somewhere. `object-fit: cover` defaults to taking it evenly, 285 off the top
// and 285 off the bottom — and the top of one of these photographs is the empty
// room above the model, which is the only thing on the frame the type has to sit
// on. A centred crop therefore removes the headroom and hands the type back a
// photograph whose subject now starts under it. That is not a hypothetical; it
// is what a bouquet and a Christmas tree came out looking like.
//
// So the cut is biased upward: a third off the top, two thirds off the bottom.
// Not a top-anchored crop, which would take all 570 off the bottom and with it
// the hand entering the frame — the hold is what carries scale in these shots
// and cutting it is a worse trade than a little headroom. A third keeps the
// model's top at roughly the same fraction of the 4:5 frame as it sits at in
// the 9:16 one, which is the property the type placement is written against.
//
// The 9:16 render has no slack at all and the value is inert there.
//
// `photoDropMaxPct` AND `photoZoomMin` ARE THE TWO LEVERS render/headroom.js IS
// ALLOWED TO PULL when the crop above cannot save a photograph — when the shot
// came back with the model filling the frame and there is no room above it to
// preserve. Neither is free, so both are bounded here rather than in the code
// that uses them:
//
//   photoDropMaxPct — how far down the frame the picture may be pushed, as a
//   fraction of the frame's height. Paid for by cropping the bottom, and the
//   bottom is where the hand enters. TikTok can afford more of it because the
//   app draws its own caption over the foot of the frame anyway, so the last
//   fifth of that picture is half lost before we touch it; the Instagram frame
//   is seen whole, and 0.10 is about where the wrist goes and the fingers stay.
//
//   photoZoomMin — how far the picture may be shrunk once the drop has run
//   out. This keeps everything in the photograph and makes the subject smaller,
//   and it is the lever that costs a sliver of non-photograph down each side,
//   filled with the same picture blurred. 0.8 is a fifth off the width, which
//   is the most that still reads as a photograph in a frame rather than a
//   picture pasted onto one.
export const SIZES = {
  tiktok: {
    w: 1080,
    h: 1920,
    topSafe: 300,
    bottomSafe: 400,
    photoAnchorPct: 0.5,
    photoDropMaxPct: 0.14,
    photoZoomMin: 0.8,
  },
  instagram: {
    w: 1080,
    h: 1350,
    topSafe: 150,
    bottomSafe: 175,
    photoAnchorPct: 0.33,
    photoDropMaxPct: 0.1,
    photoZoomMin: 0.8,
  },
};
