// Does the score predict views?
//
// The scorer decides what is posted in auto mode, and nothing about it is
// known to be right. It was written from the reference account's numbers and
// a list of rules, and the only test that counts is whether the decks it rates
// higher are the ones people watch more. This is that test, computed the same
// way for /score and for the panel.
//
// SPEARMAN, NOT PEARSON. Views on this account are a long tail: a few hundred
// on most posts and the occasional few thousand. One of those would decide a
// Pearson coefficient on its own, so the question asked is about order, "do
// higher scores come with more views", which is what the rank correlation
// measures.
//
// THE BAR IS CHANCE. With n posts, a rank correlation above 1.645/sqrt(n-1) is
// one that chance alone produces less than one time in twenty (one-sided, by
// the normal approximation). Below it the score cannot be told apart from a
// coin, and after MIN_POSTS measured posts the verdict says so in those words.
//
// One caveat the numbers cannot fix: only decks that passed the threshold are
// ever posted, so every measured score sits in the top of the range. That
// narrows what the score can show, and it is said in the README.

export const MIN_POSTS = 20;

/** Ranks, with ties sharing their average rank. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Spearman's rho, or null with fewer than three pairs or no spread. */
export function spearman(xs, ys) {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  return pearson(ranks(xs), ranks(ys));
}

/** The correlation chance alone exceeds one time in twenty, for n pairs. */
export const chanceBar = (n) => (n > 1 ? 1.645 / Math.sqrt(n - 1) : 1);

/**
 * One judge against views: the correlation over the posts that have both a
 * score from it and a view count, and a verdict in plain words.
 */
export function judgeAgainstViews(posts, scoreOf) {
  const measured = posts.filter((p) => scoreOf(p) != null && p.views != null);
  const n = measured.length;
  const rho = spearman(
    measured.map(scoreOf),
    measured.map((p) => p.views)
  );
  const bar = chanceBar(n);
  return { n, rho, bar, verdict: verdictFor(n, rho, bar) };
}

/**
 * The board: the last posts with their score (and the second judge's, when
 * one is set) and views, each judge's correlation, and a verdict in words.
 *
 * `rows` is newest first, as store.scoredItems returns them.
 */
export function scoreboard(rows) {
  const posts = rows.map((r) => ({
    id: r.id,
    headline: r.headline || null,
    hook: r.hook || null,
    recipe: r.recipe || null,
    score: Number.isFinite(r.total) ? r.total : null,
    model: r.model || null,
    sub: r.sub || null,
    compareScore: Number.isFinite(r.compare?.total) ? r.compare.total : null,
    compareModel: r.compare?.model || null,
    views: Number.isFinite(r.views) ? r.views : null,
    likes: r.likes ?? null,
    url: r.url || null,
    publishedAt: r.publishedAt || r.ts || null,
    viewsAt: r.viewsAt || null,
  }));
  const primary = judgeAgainstViews(posts, (p) => p.score);
  const compared = posts.some((p) => p.compareScore != null);
  const second = compared ? judgeAgainstViews(posts, (p) => p.compareScore) : null;
  return {
    posts,
    ...primary,
    minPosts: MIN_POSTS,
    // The second judge, when one has scored any of these posts. Same test,
    // same bar; it decided nothing, so this is the only place it can show
    // whether it would have been the better judge.
    compare: second ? { model: posts.find((p) => p.compareModel)?.compareModel || null, ...second } : null,
  };
}

function verdictFor(n, rho, bar) {
  if (n < MIN_POSTS) {
    return { state: 'early', he: `עוד מוקדם לדעת: ${n} פוסטים נמדדו, צריך ${MIN_POSTS}.` };
  }
  if (rho == null || rho < bar) {
    return {
      state: 'no',
      he:
        `הציון לא מנבא צפיות. על ${n} פוסטים הקשר בין הציון לצפיות הוא ρ = ${rho == null ? '—' : rho.toFixed(2)}, ` +
        `ומקרה לבד מגיע ל-${bar.toFixed(2)}. כרגע הסף מסנן לפי משהו שלא קשור לכמה אנשים צופים.`,
    };
  }
  return { state: 'yes', he: `הציון מנבא צפיות: ρ = ${rho.toFixed(2)} על ${n} פוסטים, מעל ${bar.toFixed(2)} שמקרה לבד היה נותן.` };
}
