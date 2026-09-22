import { brickConfig } from './config.js';
import { THEME_HE } from './themes.js';

// Which deals go in one post, and in what order.
//
// This is the whole of the editorial judgement that does not need a model. The
// travel pipeline spent an expensive call deciding what a deck should be about
// and then went looking for whether it could be sourced; here the sourcing is
// already done — the feed is a list of things we have already decided to sell —
// so the question collapses to picking five of them and putting the best one
// first.
//
// Three recipes, because the owner asked for three and they behave differently
// on a thin feed: a price roundup can always be filled, a theme roundup often
// cannot, and a single-set post needs nothing but one good deal. That ordering
// is also the fallback order when a requested deck comes up short.

/** The saving a deal will be able to show, in shekels, or 0 if none. */
const savingOf = (d) => (d.comparison?.ok ? d.comparison.saving : 0);

/**
 * How good a slide this deal makes, before anything is rendered.
 *
 * A sourced comparison is worth more than anything else on the list, and by a
 * distance: it is the only thing on the slide that makes the price mean
 * something, and a roundup of five slides that each say only "78₪" has no hook
 * at all. After that, the absolute saving, then the discount as a proportion,
 * then piece count as a tie-break — a big set at a given saving is a better
 * slide than a small one, because the viewer can see the size.
 *
 * Ratings are deliberately NOT in here. Every deal on the feed is already
 * above the bot's own quality bar, so the star rating varies between 4.5 and
 * 5.0 and sorting on it is sorting on noise.
 */
export function slideScore(deal) {
  const saving = savingOf(deal);
  if (!saving) return deal.pieces ? Math.min(40, deal.pieces / 100) : 0;
  const proportion = deal.comparison.listIls > 0 ? saving / deal.comparison.listIls : 0;
  return 1000 + saving + proportion * 500 + Math.min(200, (deal.pieces || 0) / 10);
}

/**
 * The order the slides go out in.
 *
 * Strongest first, second-strongest LAST, and the rest in between. Not a
 * flourish: slide two is what decides whether anybody swipes at all, and the
 * last slide is what they are looking at when they decide whether to follow.
 * Putting the two best at the ends spends them where they are worth most,
 * which a plain descending sort does not.
 */
export function orderSlides(deals) {
  const ranked = [...deals].sort((a, b) => slideScore(b) - slideScore(a));
  if (ranked.length < 3) return ranked;
  const [first, second, ...rest] = ranked;
  return [first, ...rest, second];
}

/**
 * Everything under a price, cheapest ceiling that still fills a deck.
 *
 * The ceiling is part of the hook — "5 sets under 100₪" is a post and "5 sets"
 * is not — so it is chosen to be as low as it can be while still producing a
 * full deck. Walking the configured ceilings upward gets the tightest true
 * claim rather than a round number that happens to be safe.
 */
export function priceRoundup(deals, { want = brickConfig().deck.slides, ceilings = brickConfig().deck.priceCeilings } = {}) {
  for (const ceiling of [...ceilings].sort((a, b) => a - b)) {
    const under = deals.filter((d) => d.price <= ceiling);
    if (under.length >= want) {
      return {
        kind: 'price',
        ceiling,
        subject: `סטים תואמים עד ${ceiling}₪`,
        deals: orderSlides(under.sort((a, b) => slideScore(b) - slideScore(a)).slice(0, want)),
      };
    }
  }
  return null;
}

/**
 * The biggest savings on the feed right now, whatever they cost.
 *
 * The other half of a price roundup and a different post: this one leads on the
 * difference rather than on the price, so an expensive set with a large saving
 * belongs here and would be excluded from the one above.
 *
 * Only deals whose comparison actually resolved are eligible, which is the
 * point — a "biggest savings" deck cannot carry a slide with no saving on it.
 */
export function savingsRoundup(deals, { want = brickConfig().deck.slides } = {}) {
  const withSaving = deals.filter((d) => savingOf(d) > 0);
  if (withSaving.length < want) return null;
  return {
    kind: 'savings',
    subject: 'ההנחות הגדולות של השבוע',
    deals: orderSlides(withSaving.sort((a, b) => savingOf(b) - savingOf(a)).slice(0, want)),
  };
}

/**
 * One theme's best current deals.
 *
 * `theme` may be a key or absent; absent picks the theme that can currently
 * fill the best deck, which is the right default because it is answerable from
 * the feed. A theme roundup is the most likely of the three to come up short —
 * a feed of forty deals spread over twenty themes fills almost none of them —
 * so this returns null rather than padding with something off-theme. A deck
 * titled "Harry Potter" carrying two Technic sets has told the viewer something
 * false, which is the lesson the travel side learned the hard way.
 */
export function themeRoundup(deals, { theme = null, want = brickConfig().deck.slides } = {}) {
  const byTheme = new Map();
  for (const d of deals) {
    if (!d.theme) continue;
    if (!byTheme.has(d.theme)) byTheme.set(d.theme, []);
    byTheme.get(d.theme).push(d);
  }

  const candidates = theme ? [[theme, byTheme.get(theme) || []]] : [...byTheme.entries()];
  const usable = candidates
    .filter(([, ds]) => ds.length >= want)
    .sort((a, b) => b[1].reduce((s, d) => s + slideScore(d), 0) - a[1].reduce((s, d) => s + slideScore(d), 0));

  if (!usable.length) return null;
  const [key, ds] = usable[0];
  return {
    kind: 'theme',
    theme: key,
    subject: THEME_HE[key] || key,
    deals: orderSlides(ds.sort((a, b) => slideScore(b) - slideScore(a)).slice(0, want)),
  };
}

/**
 * One set, across the whole post.
 *
 * Structurally different from the other two and worth being explicit about,
 * because it is the one place this format departs from the reference. There,
 * every post is a roundup and every slide is a different set. A single-set post
 * has only one price block to show, and repeating it five times is not a post,
 * it is a stuck slideshow.
 *
 * So the deal appears once with its full price block and the remaining slides
 * carry one short fact each, drawn from what the feed actually knows — the
 * piece count, the set number, the rating. Anything the feed does not have is
 * simply not a slide, which is why this can return fewer slides than asked for
 * and why it refuses below the configured minimum.
 */
export function singleSet(deal, { want = brickConfig().deck.slides } = {}) {
  if (!deal) return null;

  const facts = [];
  if (deal.pieces) facts.push({ emoji: '🧱', text: `${deal.pieces.toLocaleString('en-US')} חלקים` });
  if (deal.stars) facts.push({ emoji: '⭐', text: `דירוג ${deal.stars} מתוך 5` });
  if (deal.series) facts.push({ emoji: '📦', text: deal.series });
  if (deal.comparison?.ok) {
    facts.push({ emoji: '💰', text: `חיסכון של ${deal.comparison.saving.toLocaleString('en-US')}₪` });
  }

  const slides = [{ deal, showPrices: true }, ...facts.slice(0, want - 1).map((fact) => ({ deal, fact }))];
  if (slides.length < brickConfig().deck.minSlides) return null;

  return { kind: 'set', subject: deal.product, deals: [deal], slides };
}

/**
 * Whatever this feed can currently make, best first.
 *
 * The order is not a preference between formats, it is a statement about which
 * is most likely to be worth watching: a theme roundup is the most specific
 * post available and therefore the best one when it is available at all, a
 * savings roundup has the strongest single hook, and a price roundup can always
 * be built and so is the floor rather than the goal.
 */
export function available(deals, opts = {}) {
  return [themeRoundup(deals, opts), savingsRoundup(deals, opts), priceRoundup(deals, opts)].filter(Boolean);
}
