# tiyul+ · טיול+

A Hebrew travel-content pipeline for Israeli travellers. It reads primary
sources, drafts a post, renders a card, sends it to one person on Telegram for
approval, and publishes to Instagram and TikTok only when that person taps
approve.

Nothing publishes without a human tap. No claim is made without a source that
was fetched, right then, from a domain on an allowlist.

<p align="center">
  <img src="assets/samples/card-volcano.jpg" width="270" alt="Card: the alert level at Mount Aso">
  <img src="assets/samples/card-europe-heat.jpg" width="270" alt="Card: the air conditioning missing from most homes in Europe">
  <img src="assets/samples/card-phuket.jpg" width="270" alt="Card: Phuket, 7 rain days in February">
</p>

<p align="center"><em>Real output. Left to right: a Smithsonian volcano report, a NASA
Earth Observatory piece, and ten years of ERA5 climate normals.</em></p>

---

## The loop

```
sources → rank → draft (Claude) → verify → render → Telegram → you tap ✅ → Instagram
                                    ↑                              ↓        + TikTok
                              reject with a reason            queue, drip out
```

1. **Gather.** Twenty enabled feeds and one dataset, fetched live.
2. **Rank.** A cheap sort on titles and summaries, because the next step costs
   money. Authority, recency, specificity, topic balance.
3. **Draft.** One Claude call returns Hebrew copy, a layout choice, an image
   query, and a verbatim quote for every claim it makes.
4. **Verify.** The quotes must literally appear in the page that was fetched.
   No fares, no decimals on a card, no word used twice in a headline.
5. **Render.** Headless Chromium, because Hebrew needs real bidirectional text
   layout. 1080×1350 JPEG.
6. **Approve.** A Telegram DM with the card, the source URL, where the image
   came from, how many quotes were checked, and — when TikTok is a destination —
   the privacy level it would publish at, with a button to change it.
7. **Publish.** Instagram Graph API and the TikTok Content Posting API. One post
   drips out every four hours; a destination that fails is retried on its own,
   without re-posting to the one that worked.

## Two kinds of post

A **card** is one verified claim from one source, 1080×1350, and it goes to
Instagram and the Telegram channel. That is the loop above.

A **deck** is a slideshow — a cover and five to seven places — and it goes to
TikTok and Instagram. It is built the other way round: Claude proposes what
would be worth watching, and only then does the pipeline go looking for whether
it can be sourced.

**A slide carries a place name and nothing else, unless a number decides
something.** That is copied from the posts this channel is modelled on, and it
was arrived at the hard way: the first decks put a sentence under each name, and
a sentence on a slide reads as a guidebook no matter how it is set.

### Two styles, chosen per deck

The reference accounts use two different systems and averaging them produced
slides that belonged to neither. So a deck picks one, once, and every slide in
it matches:

| | **minimal** | **info** |
|---|---|---|
| looks like | a photograph you captioned | a card you would screenshot |
| type | Heebo 600, ~2.6% of the frame, **no outline** | Rubik 800, cream `#F7E3A1` over a bronze outline |
| colour | white or near-black, measured per photograph | always cream |
| carries | name, country, flag, at most one short note | name, flag, and the same fields in the same order |
| chosen when | most slides have fewer than one measured fact | most slides have one or more |

The type is deliberately **small**. A place name sits at about 2.6% of the frame
height, which feels wrong in a design tool and is right in a feed: it reads as
somebody captioning their own photograph rather than as a graphic laid over
stock. The minimal style carries **no outline at all** — a stroke around every
letter is not something TikTok's own text tool can produce, so the eye reads it
as foreign however good the rest of the slide is.

### Where the words go is measured, not guessed

`src/render/photo.js` draws each photograph to a 45×80 grid in the renderer's own
Chromium and reads the pixels back. For every candidate position it has the mean
luminance, the spread, and the texture — the mean step between neighbouring
cells, which is what tells a smooth gradient from a chequerboard. It returns the
centre of the quietest region as a fraction of the frame, the colour the type
has to be to survive there, and how hard the shadow has to work.

This replaced asking the vision model which third of the picture was "emptiest".
A model is the right tool for *is this actually the Eiger* and the wrong tool for
*what is the mean luminance of the region the text will occupy* — the second has
an exact answer, it is free, and it is the one that decides whether the slide is
legible. TikTok's button rail is excluded as a rectangle, which is why text on a
TikTok slide drifts left and on the Instagram render does not.

```
idea (Claude) → places (OpenStreetMap + Wikidata) → facts → photographs (curated by looking)
   → measure each photograph → render 1080×1920 and 1080×1350
   → Telegram album → you tap ✅ → TikTok + Instagram
```

**OpenStreetMap chooses the places; it never states a fact.** A place's tags
select it and rank it by how many language Wikipedias write about it, and then
every *sentence* on a slide is quoted from the official site of the place, of the
body that runs it, or of the body that contains it — checked
character-for-character, exactly like a card.

**The one documented exception is a structured measurement.** A summit has no
official website, no operator and no opening hours, so there is no page to quote
and summit decks came back as bare names — with the one fact anybody wants, the
height, sitting unread in Wikidata's P2044. `src/deck/facts.js` reads those
properties directly: an elevation, a length, a founding year. A property is not
prose. Nothing is written, the value is copied with its unit normalised, and the
QID travels with it. Prose about a place still needs its official page.

**Every name is Hebrew.** Wikidata has a Hebrew label for the famous places and
not for the rest, and the old code fell back to the English one — which is how
"Piz Bernina" and "Aletschhorn" shipped on a Hebrew slide. `src/deck/hebrew.js`
transliterates the rest and then *checks*: a name that still contains a Latin
letter is not used and the place is dropped.

`/deck` builds one from an idea of the model's choosing. `/deck Prague museum`
builds the one you asked for — and so does `/deck mountains Italy`,
`/deck japan autumn` or `/deck Santorini`, because the request is parsed when it
parses and interpreted when it does not. A thin result falls back to another
category or region rather than answering with a failure.

## What makes it different from "an AI wrote a post"

**A claim without a quote does not ship.** The drafting step returns
`evidence: [{ claim, quote }]`, and every `quote` is checked to appear
character-for-character in the text that was actually fetched. A model asked for
a quote will occasionally paraphrase one — and a paraphrased quote is precisely
the case where the claim came from the model's memory rather than the source.

**The rules are code, not prompt text.** A style rule that lives only in a
prompt holds until the model meets a source that pushes against it. The fare
ban, the rounding rule, the repeated-word check, the allowlist and the quote
check are all enforced after the model has spoken, and each returns a reason you
can read in Hebrew. So is the shape of the copy: a headline outside 3-11 words,
a caption past four sentences, a filler adjective (מדהים, מרהיב, קסום...), or a
post that opens on a rhetorical question or "ידעתם ש" is sent back for another
draft rather than published. The brief also carries one real published post as
the standard every draft is measured against — headline that names and
withholds, subhead that answers, two-sentence caption, one emoji, two hashtags.

**Every filter is visible.** Rejections arrive as a digest with the reason and
the URL. A filter you cannot see is a filter you cannot disagree with.

## Sources

Primary sources only — the publisher of the fact, not someone reporting it.

| Source | What it gives |
|---|---|
| FCDO travel advice (`gov.uk`) | entry rules, safety changes, per country |
| UNESCO World Heritage Centre | new inscriptions, site decisions |
| NASA Earth Observatory | one specific place on Earth per day, from orbit |
| Smithsonian Global Volcanism Program | eruptions and unrest, weekly |
| JNTO (Japan) | Japanese-language travel news, plus the English Travel Japan blog |
| Kyoto City Tourism Association | festival seats, guided tours, tax rules — the things a visitor books |
| This is Athens (City of Athens) | closures, car-free days, what's new in the most-flown city |
| Tourism Authority of Thailand | the newsroom, with its trade half scored down |
| Vietnam National Authority of Tourism | islands, street food, heritage villages |
| My Helsinki, Sydney.com + Visit NSW (Destination NSW) | neighbourhood and day-trip guides with addresses; the Blue Mountains from Sydney |
| Visit Sevilla (Turismo de Sevilla) | a "¿Sabías que…" series — one odd fact per post about a street, a painting, a tower |
| Visit Sicily, Visit Lazio (regional governments) | the places the national portal never names: Ustica, the Nebrodi, a walk out of Frosinone |
| Visit Greenland, Tahiti Tourisme | slow feeds, long essays — when to go, a new marine reserve |
| Destination BC, Tourism Panama | seasonal long-form and trail-and-waterfall lists with named places |
| Open-Meteo ERA5 | ten years of daily values → monthly climate normals |

The official-DMO batch came from probing ~150 tourism-board and city-guide
domains for a feed our parser accepts, then reading what each one actually
publishes; a second pass over ~360 more (regions, provinces, states, parks,
museums, met offices) found that national boards almost never publish a feed
and regional ones often do. Twenty-two more are declared and switched off, each
with the probe result recorded in `sources.json` rather than quietly omitted —
the Cyprus feed is a restaurant directory, the Maldives one is resort marketing,
the US park feeds are mostly fatalities, Emilia-Romagna's item links all resolve
to its homepage, UNESCO's intangible-heritage feed is committee minutes except
for one week in December. `npm run check-sources` re-probes every enabled
one; `npm run eval-feed <url>` sizes up a candidate before it goes in.

The allowlist matches on a domain-label boundary, so `evil-gov.uk` and
`gov.uk.attacker.com` do not pass as `gov.uk`.

## Cards

Ten layouts in two families. Photo-led is the default — this is a travel
channel, and a wall of typography is what a spreadsheet looks like. Text-led is
for the cases with no single place to photograph: a rule spanning many
countries, a comparison, a figure with no address.

**The card carries the headline and nothing else.** The subhead is written, and
it opens the description instead. A card that answers its own headline gives
nobody a reason to tap "more".

Headlines name a subject rather than narrating it. `קרחון ענק צף במיצר` is a
complete sentence, so it answers itself; `הקרחון הענק בין גרינלנד לאיסלנד` is a
definite noun phrase that names a specific thing and withholds the story. The
verb is what gives it away.

Images are commercial-license stock, our own catalogue, or AI-generated — never
lifted from a news article or a business's page. Which one it was is printed in
the approval message. AI imagery may only ever be generic; a prompt naming the
post's own place is rejected in code.

A photo post should almost never fall back to a text card, so the picture is
looked for five times before giving up: the scene the draft asked for, a broader
second search it also supplies, the place by its English name, the country. Each
search ranks the library's thirty results by their own descriptions — a scene
beats a person posing in front of it, a product shot is refused outright — and
asks for a portrait first, anything second. The bytes come from the CDN as an
exact 1080×1350 crop rather than the 800×1200 thumbnail that was being upscaled
before. A `fact` card about somewhere with a name is promoted to `photoFull` in
code, because on a travel channel a dark card with a headline is a photograph
that was not asked for.

## Running it

Requires Node 18+ (developed on 24) and no build step.

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env      # then fill it in
npm test                  # 744 offline checks, no credentials needed
npm run check-sources     # probe every feed
npm run eval-feed <url>   # size up a feed before adding it
npm run run-once          # a full pass, printed to the terminal, publishes nothing
npm start
```

Slides cannot be reviewed by reading the HTML — Hebrew shaping, bidi, where a
line breaks, whether white type survives on that particular sky, all of it
happens at render time. Two scripts exist to look at them:

```bash
npm run deck-lab                      # fixed content, cached photographs, no model calls
npm run deck-once -- "Dolomites trails" "Kyoto temples"
```

`deck-lab` is the fast one: hand-written fixtures against real photographs, so a
number in the stylesheet can be argued with in about fifteen seconds.
`deck-once` is the whole pipeline — request, places, facts, curation, render —
written to `out/decks/` instead of to Telegram, with a contact sheet showing
every slide in a row and the measurements that placed each block underneath it.
Neither writes to the store and neither publishes anything.

TikTok, if you want it, is connected once with `npm run tiktok-token` — it
prints an authorization URL, you paste back the address you land on, and the
token pair is stored. Nothing about it goes in `.env` except the client key,
secret and redirect URI, because the access token lasts a day and is refreshed
continuously.

You need a Telegram bot token, your own Telegram user id, an Anthropic API key,
a Pexels key for photos, and an Instagram Business account with the Graph API.
[`SETUP.md`](SETUP.md) walks through each one, including the parts of Meta's
dashboard that are genuinely confusing.

[`DEPLOY.md`](DEPLOY.md) covers the VPS: it has to run there, because Instagram
fetches the card image from a public URL rather than receiving bytes.

### Commands in the bot

`/run` gather now · `/run 7` gather more than the daily target, overriding the
quotas and reporting each one it stepped over · `/redo` forget what was seen and
re-run, for testing a change · `/status` · `/health` every destination
separately, with its last error · `/usage` tokens and cost · `/igquota` ·
`/tiktok` connection, tokens and available privacy levels · `/sources` every
feed with its last success and error, `/sources off <id>` to stand one down ·
`/mix` topic balance · `/why` last run's rejections · `/queue` `/next`
`/pending`

**The owner is not rate-limited by any of this.** Every guard here — the topic
quotas, the dedupe window, the daily target, the drip interval — protects the
feed from the pipeline, not from the person who owns it, who can already publish
anything by hand. So an owner-triggered post steps over all of them. What it
does not do is step over them quietly: each bypass is recorded with the
measurement that would have blocked it, shown on the approval card before you
tap, and sent again before the post goes out. Two Dolomites decks back to back
is a decision the bot will carry out and name.

Platform limits are a different category and are never bypassed. TikTok allows
an unaudited client five posts a day; the sixth is held, not failed, and the
message says when the slot frees.

## Layout of the code

| Path | What it does |
|---|---|
| `bot.js` | Telegraf bot: owner lock, staging, approve/reject, timers |
| `src/pipeline.js` | the daily loop, with a ceiling on drafting calls |
| `src/draft.js` | the Claude call and the whole editorial brief |
| `src/verify.js` | **the gate** — allowlist, quotes, fares, rounding, repeats |
| `src/score.js` | ranking before anything expensive happens |
| `src/render/` | templates, theme, Chromium |
| `src/render/photo.js` | measures each photograph: where the words go, what colour they are |
| `src/render/deckTemplates.js` | the two slide styles, minimal and info |
| `src/deck/facts.js` | structured measurements off Wikidata properties |
| `src/deck/hebrew.js` | every place name in Hebrew, and the check that it is |
| `src/deck/request.js` | turns anything typed after `/deck` into something buildable |
| `src/deck/flags.js` | countries in Hebrew, with their flag |
| `src/sources/` | feed adapters and the climate dataset |
| `src/publish/` | Instagram Graph API, publish targets |
| `src/images.js` | image provenance policy |
| `src/usage.js` | token accounting, exposed as `/usage` |
| `scripts/` | selftest, source probe, card-hosting check, one-off runs |

## Honest caveats

**The evidence check proves sourcing, not truth.** It proves a claim appears in
a page fetched from an allowlisted authority. If FCDO is wrong, this will
faithfully repeat FCDO being wrong. "Verified" here means *traceable*.

**The quote check is strict and will produce false rejections.** A model that
summarises two sentences into one loses the whole draft. Better to re-run than
to loosen it: a fuzzy quote match is indistinguishable from no check at all.

**Twenty-one of fifty-four declared sources work.** The rest are off with the
probe result recorded. A further eleven were probed on 2026-09-20 — Smartraveller,
USGS, the NHC, WHO, the Met Office, Canada, NPS, TfL, Go Tokyo, Visit Malta and
Turismo Roma — and not one cleared the bar: two 404s, three empty shells, one
feed abandoned in 2019, one stale since February, one timeout, and USGS, whose
109 fresh items all link to a JavaScript application that serves 155 characters
of "supported browsers" to a fetcher. `npm run find-feeds <site>` was written
during that pass and reads a site's declared `<link rel="alternate">` instead of
guessing paths; it is the reason the Malta and Roma feeds were found at all,
both of which then turned out to be empty. The two most wanted are `gov.il` and the Israel Airports
Authority, both behind Imperva. There is now a real browser fetch
(`src/browserFetch.js`), written to get past UNESCO's 403 — whether it is enough
for Imperva, which is a considerably more determined wall, is untested. Most
official tourism boards (Spain, Portugal, Greece, Dubai, Georgia, the Nordics)
publish no feed at all; those would need a page scraper, not a URL.

**The DMO sources are promotional by nature.** A city guide's feed is its events
calendar and its own campaigns. The scorer nudges performers and trade items
down and the drafting step declines what is not a trip, but the drafting step
costs money and the nudges are tuned on one week of items — `/usage` reports
how much drafting was thrown away, and that number is the one to watch.

**Counting feed items is not the same question as "does this source work".**
UNESCO served ten items a run and showed a green tick in `check-sources` for a
month while every article page behind those items returned 403 — the source was
contributing nothing and the probe said it was fine. `check-sources` now takes a
sample of items all the way through `verifySource()`, which is the actual gate.
The general lesson is that a health check measuring the cheap half of a pipeline
reports on the half that was never going to break.

**TikTok publishes privately until the app passes review.** An unaudited
Content Posting API client is offered `SELF_ONLY` and nothing else, so posts go
out visible to the account itself. That is not a bug to work around — it is what
the approval card shows you, what `/tiktok` reports, and what the review
recording is supposed to demonstrate. The privacy button grows more options the
moment TikTok grants them.

**The TikTok card is one image, not a carousel.** Photo posts accept up to 35,
the pipeline renders one, and one is what is sent. Nothing in the publisher
would object to more — but there is no second slide to send, so the post is a
single-image photo post.

**Some content thresholds are tuned on small samples.** The thin-source floors
were measured against one day of items. They are env-overridable and every
rejection reports the count it measured against the floor it used, so if they
start eating good sources the digest says so in numbers.

**Topic quotas only bind once there is a sample.** Below `QUOTA_MIN_SAMPLE`
published posts the shares are noise and nothing is capped.

**The publish retry rule is about double-posting, not importance.** If nothing
published, the item goes back on the queue, up to three attempts, then it is
dropped loudly. If *something* published, it is not retried, because retrying
would duplicate whichever destination succeeded.

## Three things that were only findable by running it

**`document.fonts.check()` does not check what it sounds like it checks.** The
guard against Hebrew rendering as tofu boxes was `document.fonts.check('900
100px Heebo')`, which reads exactly like "is Heebo available". It returns true
whenever the text can be rendered by *anything*, fallback included — on a page
with no `@font-face` rule at all it still returns `true`. The guard written to
catch a silent failure was itself silently passing. It now checks that a
`FontFace` for Heebo exists with `status === 'loaded'` **and** that Hebrew set in
Heebo measures differently from Hebrew set in a family that cannot exist.

**Cookie banners are an evidence-integrity problem, not a tidiness one.** A
gov.uk page's extracted text opened with ~500 characters of consent boilerplate.
The obvious cost is wasted prompt. The real cost is that a quote lifted from a
cookie notice would have passed verification and published.

**A word count silently disabled a quarter of the source registry.** The
evidence check required four words, splitting on spaces. Japanese does not put
spaces between words, so every Japanese quote counted as one word and was
rejected as "too short to be evidence" — meaning JNTO could never produce a
candidate, and the rejection blamed the drafting step for something it had done
correctly. No fixture would have caught it, because the fixture would have been
in English.

## Security

- Every credential lives in `.env`, which is gitignored along with every
  `.env.*` variant. Nothing else reads one.
- `data/` is gitignored, so cloning this does not leak what has been posted.
- The bot checks `ctx.from.id` against `OWNER_ID` in middleware registered
  before every other handler, and refuses to start without it. A missing config
  value fails closed rather than opening the bot to whoever finds the username.
- The bot also refuses to start with no publish destination configured — an
  approval queue with nowhere to publish silently eats what you approve.
- Fetched page content is only ever regex-matched and shown to the model. It is
  never evaluated in this process and never shelled out to. The one place HTML
  *is* rendered is our own templates, where every interpolated value goes
  through `escapeHtml()`.
- **The one exception, stated plainly:** a source that answers a plain fetch
  with 403 is retried through headless Chromium (`src/browserFetch.js`), and
  there the page really is rendered and its scripts really do run. They run in
  Chromium's sandbox, in a throwaway context with no storage and no
  credentials, with images, media and fonts blocked; what comes back out is
  HTML that goes through the same `htmlToText()` path as every other page. Only
  403 is retried — a 404 is a dead link and a 429 is a rate limit, and neither
  is fixed by asking again.
- Telegram messages are sent without `parse_mode`. A scraped title containing a
  stray `*` would otherwise break Markdown parsing and drop the message — which,
  for an approval card, means silently not asking.

## Licence

Not currently licensed for reuse. The bundled Heebo font is under the SIL Open
Font License; photographs come from Pexels under its own licence.
