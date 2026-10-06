import { brickConfig } from './config.js';
import { THEME_HE, fitsTheme } from './themes.js';

// Which deals go in one post, and in what order.
//
// This is the whole of the editorial judgement that does not need a model. The
// travel pipeline spent an expensive call deciding what a deck should be about
// and then went looking for whether it could be sourced; here the sourcing is
// already done — the feed is a list of things we have already decided to sell —
// so the question collapses to picking five of them and putting the best one
// first.
//
// Four recipes, and what separates them is what each one needs from the feed:
// a price roundup can always be filled, a theme roundup often cannot, a
// per-piece roundup needs piece counts but no retail price at all, and a
// single-set post needs nothing but one good deal. `available` below puts them
// in the order they are worth watching, which is also the order a requested
// deck falls through when it comes up short.

/** The saving a deal will be able to show, in shekels, or 0 if none. */
const savingOf = (d) => (d.comparison?.ok ? d.comparison.saving : 0);

/**
 * What one piece of this set costs, in agorot, or null if it cannot be said.
 *
 * The hobby's own yardstick. Price per part is what a builder compares two sets
 * with when neither is on sale — the published bands put a good buy around ten
 * to fifteen US cents a piece and anything under six as excellent — and a
 * compatible set at four agorot a piece is roughly a tenth of that. It is the
 * one number on this feed that lands harder with somebody who already builds
 * than with somebody who does not, which is exactly the audience worth having.
 *
 * AGOROT RATHER THAN SHEKELS, and that is not a presentation choice made late.
 * Every set worth putting in one of these decks lands between 0.03₪ and 0.20₪ a
 * piece, so in shekels the whole range is decimals — and copy.js refuses
 * decimals on a slide for good reason. In agorot the same range is 3 to 20, a
 * whole number with a unit, which is a thing a slide can say.
 *
 * Returns null below half an agora rather than rounding to zero. "0 אגורות
 * לחלק" is not a cheaper claim than "1 אגורה", it is a broken one, and a set
 * that genuinely prices that low has a piece count the feed got wrong.
 */
export function agorotPerPiece(deal) {
  const price = Number(deal?.price);
  const pieces = Number(deal?.pieces);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(pieces) || pieces <= 0) return null;
  const agorot = (price / pieces) * 100;
  return agorot >= 0.5 ? agorot : null;
}

/**
 * What makes two rows THE SAME SET rather than the same listing.
 *
 * The feed is a list of listings, and a popular set is sold by a dozen sellers
 * at a dozen prices. Every score in this file is computed from the set — its
 * saving, its RRP, its piece count — so duplicate listings do not merely appear
 * together, they score IDENTICALLY and cluster at the top. A deck of five then
 * comes back as the same car four times, which is what shipped.
 *
 * `setId` is the real answer and is present whenever the scraper recognised a
 * set number. The name is the fallback and a weak one — these names are written
 * per listing, so the same car arrives as "black sports car with spoiler" and
 * "V8 race car" — but a weak fallback still catches the reposts of one seller.
 * With neither, the listing is its own set and nothing is collapsed.
 */
export const setKey = (d) =>
  d.setId ? `set:${d.setId}` : d.product ? `name:${String(d.product).toLowerCase().replace(/\s+/g, ' ').trim()}` : `id:${d.productId}`;

/**
 * One listing per set — the cheapest one.
 *
 * Cheapest rather than best-scoring, and deliberately: at this point in the
 * pipeline nothing has been priced yet, so every duplicate of a set scores the
 * same and "best" is a coin toss. Price is known, it is the number the slide is
 * an argument about, and picking anything other than the cheapest would mean
 * showing a worse deal than the one we could have shown.
 */
export function oneListingPerSet(deals) {
  const best = new Map();
  for (const d of deals) {
    const key = setKey(d);
    const held = best.get(key);
    if (!held) {
      best.set(key, d);
      continue;
    }
    // Cheapest wins; more pieces breaks a tie, because at equal price the
    // bigger box is the better slide.
    const better = d.price < held.price || (d.price === held.price && (d.pieces || 0) > (held.pieces || 0));
    if (better) best.set(key, d);
  }
  // Feed order, not Map order, so nothing downstream inherits a reordering it
  // did not ask for.
  const keep = new Set([...best.values()]);
  return deals.filter((d) => keep.has(d));
}

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
 *
 * `score` is an argument because "strongest" is a property of the DECK, not of
 * a deal. On every roundup that argues from price it is `slideScore` and always
 * was; on a per-piece deck the strongest slide is the one with the lowest
 * agorot figure, and ordering that deck by saving would put a slide the post is
 * not about in the two positions the post is decided in.
 */
export function orderSlides(deals, score = slideScore) {
  const ranked = [...deals].sort((a, b) => score(b) - score(a));
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
 * The most brick per shekel on the feed, whatever the sets are.
 *
 * The third roundup, and the one that argues from something the other two
 * cannot reach. A price deck says a set is cheap; a savings deck says it is
 * cheaper than the original brand. Both are arguments about the label. This one
 * is an argument about the box: ten thousand pieces for 420₪ is four agorot a
 * piece, and a builder who has ever priced a set knows what that number means
 * without being told.
 *
 * IT NEEDS NO COMPARISON, which is the practical reason it earns a place rather
 * than being a variation on `savingsRoundup`. A saving needs Brickset to have
 * heard of the set number and needs an exchange rate on the day; roughly half
 * this feed fails one or the other, and those sets are invisible to the savings
 * deck no matter how good they are. Piece count and price are on every usable
 * feed record by definition, so this recipe can be filled from exactly the
 * deals the strongest existing recipe has to throw away.
 *
 * The ceiling walks upward like `priceRoundup`'s and for the same reason — the
 * tightest true claim is a better hook than a safe round number — and the floor
 * under the piece count is the standard caveat on this metric: per-piece
 * figures flatter sets made of few large elements, so a set too small for the
 * number to mean anything is not allowed to anchor a deck built on it.
 */
export function pricePerPiece(
  deals,
  {
    want = brickConfig().deck.slides,
    agorotCeilings = brickConfig().deck.agorotCeilings,
    minPieces = brickConfig().deck.minPieces,
  } = {}
) {
  // Measured once, here, so the ceiling the deck claims and the figure the
  // slide prints cannot come out of two different divisions.
  const rated = deals
    .map((deal) => ({ deal, agorot: agorotPerPiece(deal) }))
    .filter(({ deal, agorot }) => agorot !== null && Number(deal.pieces) >= minPieces);

  const by = new Map(rated.map(({ deal, agorot }) => [deal, agorot]));
  // Lowest wins, so the score is the figure negated — `orderSlides` reads its
  // scorer as "bigger is stronger" and every other recipe agrees with it.
  const cheapest = (d) => -(by.get(d) ?? Infinity);

  for (const ceiling of [...agorotCeilings].sort((a, b) => a - b)) {
    const under = rated.filter(({ agorot }) => agorot <= ceiling);
    if (under.length >= want) {
      const picked = under.sort((a, b) => a.agorot - b.agorot).slice(0, want).map(({ deal }) => deal);
      return {
        kind: 'perPiece',
        // Not `ceiling`. That field is shekels everywhere else in this pipeline
        // — brick-once prints it with a ₪ on the end — and a second unit in the
        // same field is the kind of thing that stays correct until somebody
        // reads it somewhere new.
        agorotCeiling: ceiling,
        subject: `סטים עד ${ceiling} אגורות לחלק`,
        deals: orderSlides(picked, cheapest),
      };
    }
  }
  return null;
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
 *
 * AND THE LABEL ON A DEAL IS NOT ENOUGH TO PUT IT IN ONE. The feed's theme is
 * an upstream guess, and a deck titled "five car sets" went out opening on a
 * pinball machine the feed had filed under מכוניות. `fitsTheme` asks the name
 * of the thing in the photograph instead; see themes.js.
 */
export function themeRoundup(deals, { theme = null, want = brickConfig().deck.slides } = {}) {
  const byTheme = new Map();
  for (const d of deals) {
    if (!d.theme || !fitsTheme(d, d.theme)) continue;
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
 * savings roundup has the strongest single hook, a per-piece roundup makes the
 * case the savings deck could not source, and a price roundup can always be
 * built and so is the floor rather than the goal.
 *
 * Per-piece sits BELOW savings and not above it, on one distinction: a saving
 * is checked against somebody else's published retail price, and a per-piece
 * figure is arithmetic on our own two numbers. Both are true; only one of them
 * is true according to a source outside this repository, and that is the one
 * that should go out when both are available.
 */
export function available(deals, opts = {}) {
  return [
    themeRoundup(deals, opts),
    savingsRoundup(deals, opts),
    pricePerPiece(deals, opts),
    priceRoundup(deals, opts),
  ].filter(Boolean);
}
