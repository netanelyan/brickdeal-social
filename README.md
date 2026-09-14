# tiyul+ · טיול+

A Hebrew travel-content pipeline for Israeli travellers. It reads primary
sources, drafts a post, renders a card, sends it to one person on Telegram for
approval, and publishes to Instagram only when that person taps approve.

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
                                    ↑                              ↓
                              reject with a reason            queue, drip out
```

1. **Gather.** Six enabled feeds and one dataset, fetched live.
2. **Rank.** A cheap sort on titles and summaries, because the next step costs
   money. Authority, recency, specificity, topic balance.
3. **Draft.** One Claude call returns Hebrew copy, a layout choice, an image
   query, and a verbatim quote for every claim it makes.
4. **Verify.** The quotes must literally appear in the page that was fetched.
   No fares, no decimals on a card, no word used twice in a headline.
5. **Render.** Headless Chromium, because Hebrew needs real bidirectional text
   layout. 1080×1350 JPEG.
6. **Approve.** A Telegram DM with the card, the source URL, where the image
   came from, and how many quotes were checked.
7. **Publish.** Instagram Graph API. One post drips out every four hours.

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
can read in Hebrew.

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
| JNTO (Japan) | Japanese-language travel news |
| Open-Meteo ERA5 | ten years of daily values → monthly climate normals |

Seven more are declared and switched off, each with the probe result recorded in
`sources.json` rather than quietly omitted. `npm run check-sources` re-probes
every one.

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

## Running it

Requires Node 18+ (developed on 24) and no build step.

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env      # then fill it in
npm test                  # 164 offline checks, no credentials needed
npm run check-sources     # probe every feed
npm run run-once          # a full pass, printed to the terminal, publishes nothing
npm start
```

You need a Telegram bot token, your own Telegram user id, an Anthropic API key,
a Pexels key for photos, and an Instagram Business account with the Graph API.
[`SETUP.md`](SETUP.md) walks through each one, including the parts of Meta's
dashboard that are genuinely confusing.

[`DEPLOY.md`](DEPLOY.md) covers the VPS: it has to run there, because Instagram
fetches the card image from a public URL rather than receiving bytes.

### Commands in the bot

`/run` gather now · `/redo` forget what was seen and re-run, for testing a change
· `/status` · `/usage` tokens and cost · `/igquota` · `/mix` topic balance ·
`/why` last run's rejections · `/queue` `/next` `/pending`

## Layout of the code

| Path | What it does |
|---|---|
| `bot.js` | Telegraf bot: owner lock, staging, approve/reject, timers |
| `src/pipeline.js` | the daily loop, with a ceiling on drafting calls |
| `src/draft.js` | the Claude call and the whole editorial brief |
| `src/verify.js` | **the gate** — allowlist, quotes, fares, rounding, repeats |
| `src/score.js` | ranking before anything expensive happens |
| `src/render/` | templates, theme, Chromium |
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

**Six of thirteen declared sources work.** The rest are off with the probe result
recorded. The two most wanted are `gov.il` and the Israel Airports Authority,
both behind Imperva. There is now a real browser fetch (`src/browserFetch.js`),
written to get past UNESCO's 403 — whether it is enough for Imperva, which is a
considerably more determined wall, is untested.

**Counting feed items is not the same question as "does this source work".**
UNESCO served ten items a run and showed a green tick in `check-sources` for a
month while every article page behind those items returned 403 — the source was
contributing nothing and the probe said it was fine. `check-sources` now takes a
sample of items all the way through `verifySource()`, which is the actual gate.
The general lesson is that a health check measuring the cheap half of a pipeline
reports on the half that was never going to break.

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
