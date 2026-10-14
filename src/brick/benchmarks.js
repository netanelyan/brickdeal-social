// The covers whose views are known, for the two prompts that are shown them:
// the hook writer in build.js and the scorer in score.js.
//
// Until this account has measured enough posts of its own, that is the
// reference account's: its three biggest covers, one from the middle of the
// table and its three weakest, as they were counted on 2026-10-05. The brand
// name in the originals is replaced with "סטים", because this channel never
// writes it. See "What the numbers changed" in the README.

export const REFERENCE = {
  source: 'reference',
  winners: [
    { text: 'בואו תראו כמה כסף אתם יכולים לחסוך אם תזמינו מאלי אקספרס', views: 208_700 },
    { text: 'הסניף הכי זול בארץ, הכל ברבע מחיר', views: 153_800 },
    { text: 'אם אתם אוהבים לקנות סטים במחירים של הארץ תמשיכו לגלול', views: 146_500 },
  ],
  middle: [{ text: 'ועדיין אתם ממשיכים לשלם ביוקר??', views: 14_700 }],
  losers: [
    { text: 'הפסקתי לשלם ביוקר על התחביב שלי', views: 929 },
    { text: 'במחיר של סט אחד תקנו 8', views: 1_033 },
    { text: 'מה הזמנתי VS מה קיבלתי', views: 1_082 },
  ],
};

/** How many of this account's own posts must have views before they replace the reference. */
export const OWN_MIN = 10;

/**
 * The benchmark covers: this account's own top and bottom three by real
 * views once at least OWN_MIN of its posts have been measured, the
 * reference account's until then.
 *
 * `measured` is rows with a cover and a view count (see store.measuredPosts).
 * Only posts that actually reached the feed count. An inbox draft's views say
 * nothing about the cover the bot wrote, because a person finished it.
 */
export function benchmarks(measured = []) {
  const own = measured
    .filter((p) => p.hook && Number.isFinite(p.views))
    .sort((a, b) => b.views - a.views);
  if (own.length < OWN_MIN) return REFERENCE;
  const row = (p) => ({ text: p.hook, views: p.views, score: Number.isFinite(p.total) ? p.total : null });
  return {
    source: 'own',
    n: own.length,
    winners: own.slice(0, 3).map(row),
    middle: [],
    losers: own.slice(-3).reverse().map(row),
  };
}

/** One cover per line, with its views, the way both prompts print them. */
export const benchmarkLines = (rows) =>
  rows.map((r) => `  ${r.text}    ${Number(r.views).toLocaleString('en-US')} views`).join('\n');
