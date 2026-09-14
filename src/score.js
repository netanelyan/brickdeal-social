import { pillarDeficits } from './pillars.js';
import * as store from './store.js';
import { candidateId } from './candidate.js';

// Ranking raw source items, before anything expensive happens to them.
//
// This runs on titles and summaries only — deliberately, because the next step
// is a drafting call per item. Scoring after drafting would mean paying for
// twenty drafts to publish three. So this is a cheap sort whose only job is to
// put the two or three most promising items at the front of the queue; the real
// quality gate is the drafting step's own "usable: false", the trip rule in
// src/candidate.js, and the verification that follows both.

const AUTHORITY_WEIGHT = {
  government: 1.0,
  intergovernmental: 0.95,
  'official-dmo': 0.85,
  airline: 0.85,
  dataset: 0.9,
};

// Concrete detail is the difference between a post worth reading and a headline
// that could have been written without the source. Numbers, dates and money are
// the cheapest available proxy for it.
const SPECIFIC = /\d{2,}|\d+\s*(?:%|km|℃|°C|€|\$|£)|\b(?:20\d\d|from \d|until \d)\b/i;

// Official tourism bodies publish to two audiences from one feed: travellers,
// and the travel trade. The trade half — operator recruitment, B2B showcases,
// press-briefing invitations, award announcements — is perfectly real and
// completely useless to someone planning a trip. Verified against JNTO's live
// feed, where these outranked everything else on authority alone.
//
// A penalty rather than a filter, and matched in both languages a bilingual DMO
// feed actually uses: on a quiet day a trade item that genuinely concerns
// travellers can still surface, and the drafting step gets the final say.
const TRADE_NOISE =
  /商談会|募集|フォーラム|取材|セミナー|説明会|出展|受賞|\b(?:trade (?:show|fair|mission)|b2b|webinar|roadshow|press (?:conference|briefing)|call for (?:applications|entries|papers)|now open for registration|appointment of|has been awarded)\b/i;

// The two conditions, as far as a title and a summary can carry them.
//
// The real gate is the drafting step — it has read the page and it answers both
// questions properly. But the drafting step costs money and runs at most a
// dozen times a day, so if the ranking still puts eruptions and calving glaciers
// at the front, the whole budget is spent producing rejections and the good item
// eight places down never gets drafted at all. That is what happened: half the
// enabled registry is a natural-phenomena wire, and it won on recency every day.
//
// So the same question is asked cheaply here, in the only vocabulary a headline
// offers. Both are nudges rather than filters: a closure at a volcano is a
// perfectly good "conditions" post, and it will match both lists and net out
// roughly neutral, which is the correct treatment for an item that could go
// either way.
const SPECTACLE =
  /\b(?:erupt\w*|eruption|lava|ash (?:plume|cloud)|volcan\w*|earthquake|magnitude \d|tsunami|waterspout|tornado|hurricane|cyclone|typhoon|wildfire|flood(?:s|ing|ed)?|landslide|mudslide|iceberg|calving|glacier|avalanche|sinkhole|shipwreck|meteor|aurora|solar flare|penguin\w*|whale\w*|migration of)\b/i;

// The other half: vocabulary that only appears when something is actually
// reachable, bookable, open, shut, or about to be.
const ACTIONABLE =
  /\b(?:open(?:s|ed|ing)? (?:to (?:the )?(?:public|visitors)|its doors)|reopen\w*|closed? (?:for|until|to)|closure|shut(?:s|ting)? |visitor cent\w+|opening hours|ticket(?:s|ing)?|book(?:ing|able)|reservation|timed entry|permit|entry (?:requirement|fee|rule)|visa|border|timetable|new (?:route|service|line|flight)|direct flight|non-stop|season|peak|off-peak|shoulder|crowd\w*|queue|free (?:entry|admission)|discount|city pass|day pass|itinerar\w+|walking route|neighbo?urhood|district|quarter|market|museum|opens? in \w+)\b/i;

const DAY_MS = 86_400_000;

function recencyScore(publishedAt, now) {
  if (!publishedAt) return 0.4; // undated isn't disqualifying — a fact doesn't expire
  const age = (now - Date.parse(publishedAt)) / DAY_MS;
  if (!Number.isFinite(age)) return 0.4;
  if (age < 0) return 0.6; // clock skew or a future-dated post
  if (age <= 2) return 1.0;
  if (age <= 7) return 0.8;
  if (age <= 21) return 0.55;
  if (age <= 60) return 0.3;
  return 0.15;
}

export function scoreItem(item, { deficits = pillarDeficits(), now = Date.now() } = {}) {
  const authority = AUTHORITY_WEIGHT[item.authority] ?? 0.7;
  const recency = recencyScore(item.publishedAt, now);

  // Push toward whichever pillars the feed has been light on lately, so the mix
  // spreads out actively rather than merely staying under the cap.
  const hints = item.pillarHints?.length ? item.pillarHints : [];
  const deficit = hints.length ? Math.max(...hints.map((p) => deficits[p] ?? 0)) : 0;

  const text = `${item.title} ${item.summary || ''}`;
  const specific = SPECIFIC.test(text) ? 0.2 : 0;
  const trade = TRADE_NOISE.test(text) ? -0.5 : 0;

  // Sized against the rest of the formula deliberately. Authority contributes at
  // most 0.35 and recency at most 0.3, so -0.6 is enough that a fresh eruption
  // from a government source no longer outranks a mundane item about a museum
  // reopening — which is the exact swap this whole change is for.
  const spectacle = SPECTACLE.test(text) ? -0.6 : 0;
  const actionable = ACTIONABLE.test(text) ? 0.3 : 0;

  // A thin *item* rarely drafts well — but a thin title alone doesn't mean
  // that. FCDO publishes one entry per country, titled just "Norway", with the
  // actual change described in the summary; penalising on title length alone
  // sent the single best entry-change source to the bottom of the ranking.
  const summaryLen = item.summary?.length || 0;
  const thin = item.title.length < 25 && summaryLen < 200 ? -0.25 : 0;

  // Evergreen used to be a penalty here. It is now a bonus, and that is a
  // deliberate reversal rather than a tuning nudge.
  //
  // The old reasoning was sound for a news desk: an item that will be just as
  // available tomorrow should lose to something that actually happened, or the
  // climate source — generated on demand, never ageing, never running dry —
  // would lead every run.
  //
  // But leading every run turned out to be closer to right than the wire was. A
  // post about an ash cloud disrupting flights to Catania is useful to the few
  // people flying there this week and stale by the weekend; "7 rain days in
  // Phuket in February, 28 in October" is useful to anyone booking Thailand,
  // ever, and it is the kind of thing people save. Saving is what builds a
  // following. The channel is a travel desk, not a wire.
  //
  // The news thread is kept — a border rule changing genuinely matters — but it
  // is now one thread among many rather than the spine of the feed.
  const evergreen = item.evergreen ? 0.2 : 0;

  // Enough text to work with. Past a couple of paragraphs more length stops
  // meaning more substance, so this saturates rather than growing.
  const body = Math.min(0.15, summaryLen / 4000);

  // Recency was 0.3, the second-largest term in the formula. That is the right
  // weight for a feed whose job is to tell you what just happened, and the wrong
  // one for a feed whose job is to be worth saving. At 0.12 a fresh item still
  // wins a tie against an identical stale one, which is all recency should ever
  // have been deciding here.
  return (
    authority * 0.35 +
    recency * 0.12 +
    deficit * 0.8 +
    specific +
    body +
    thin +
    trade +
    evergreen +
    spectacle +
    actionable
  );
}

/**
 * Rank items and return the most promising, newest-relevant first.
 *
 * Two things happen here that a plain sort wouldn't do:
 *   - already-seen items are dropped before ranking, so a feed that republishes
 *     the same entry daily can't crowd out everything else;
 *   - at most `perSource` items from any one source survive, so the single most
 *     prolific feed doesn't become the whole day's output.
 */
// The climate source interrogates a dataset rather than waiting for someone to
// publish, so it is the only one that always has something to say. It was capped
// at one a day to stop it leading the feed; it is now capped at two, because
// leading the feed is closer to the job than the wire was.
//
// Still capped rather than uncapped, and the reason has not changed: two weather
// cards in a row reads like a forecast feed. The fix for "not enough evergreen"
// is more evergreen SOURCES asking different questions of different datasets,
// not the same question about a different city three times a day.
const PER_SOURCE_CAP = { 'open-meteo-climate': 2 };

export function rank(items, { perSource = 2, limit = 12, now = Date.now() } = {}) {
  const deficits = pillarDeficits();

  const scored = items
    // Dropped before ranking, both of them: an item already tried today, and an
    // item already published. The second is the one /redo cannot be allowed to
    // undo — clearing `seen` is exactly what /redo is for, and it must not also
    // resurrect something real followers have already received.
    .filter((it) => {
      const id = candidateId(it);
      return !store.hasSeen(id) && !store.hasPublished(id);
    })
    .map((it) => ({ item: it, score: scoreItem(it, { deficits, now }) }))
    .sort((a, b) => b.score - a.score);

  const perSourceCount = {};
  const out = [];
  for (const { item, score } of scored) {
    const n = perSourceCount[item.sourceId] || 0;
    if (n >= (PER_SOURCE_CAP[item.sourceId] ?? perSource)) continue;
    perSourceCount[item.sourceId] = n + 1;
    out.push({ item, score });
    if (out.length >= limit) break;
  }
  return out;
}
