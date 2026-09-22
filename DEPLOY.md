# Deploying to the VPS

It has to run on a server, and not for the usual reasons. Instagram's
`POST /{ig-user-id}/media` takes an `image_url` **that Instagram's own servers
fetch** — the bytes never travel through our request. TikTok's Content Posting
API works the same way. So a card that only exists on a laptop cannot be
published at all, and `cardPublicUrl()` returning null is exactly why
`publishInstagram()` refuses rather than failing halfway.

Everything else about this deployment follows from that one fact: there is a
web server, it serves a directory, and the renderer writes straight into it.

The target here is Debian/Ubuntu with Caddy, because that is what
`slides.brickdeal.co.il` already runs on alongside BrickDeal.

---

## What is actually being deployed

One long-running Node process. It is **not** a cron job — `bot.js` schedules
itself with `setInterval`, offers a deck through the day from `RUN_HOUR`, and drips
posts every `POST_INTERVAL_MINUTES`. Killing and restarting it on a timer would
lose the day's state. It wants systemd with `Restart=always`.

It needs **no inbound ports**. Telegram is long-polled, so the bot reaches out.
Only Caddy listens, on 80 and 443, and only to serve the rendered images.

Three things live outside the repository and none of them are in git:

| What | Where | Why it is not in git |
|---|---|---|
| Secrets | `.env` | `.gitignore` covers `.env` and `.env.*` — a `.env.bak` is the same secrets with a different extension |
| State | `data/store.json` | dedupe history, the publish queue, the published log the pillar quotas are computed from, and the TikTok token pair |
| Rendered slides | `CARD_OUTPUT_DIR` | regenerable from the deck at any time |
| Generated photographs | `SHOT_CACHE_DIR` | **not** regenerable for free — each one cost a model call |

`data/` is the one that matters. Lose it and the bot forgets what it has
already posted, which means it will happily post it again.

---

## 1. Node

Node 18 is the floor; this was developed on 24. Debian's packaged Node is
usually too old.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 2. A user for it

Don't run it as root. It executes a browser.

```bash
sudo adduser --system --group --home /srv/brickdeal brickdeal
sudo -u brickdeal git clone https://github.com/netanelyan/brickdeal-social /srv/brickdeal/app
cd /srv/brickdeal/app
sudo -u brickdeal npm ci
```

## 3. Chromium, with its system libraries

**This is where a VPS deploy usually fails.** Playwright's Chromium needs a
couple of dozen shared libraries that a minimal server image does not have, and
without them it fails at launch with a missing-`.so` error rather than anything
that mentions Playwright.

```bash
sudo npx playwright install-deps chromium
sudo -u brickdeal npx playwright install chromium
```

Two commands rather than `--with-deps` because the libraries need root and the
browser needs to land in the service user's cache, not root's. If you run the
whole thing under `sudo`, Chromium downloads into `/root/.cache` and the service
cannot see it.

Fonts are **not** a system dependency here. Every face is bundled in `assets/`
and inlined into the HTML as a data URI, precisely so that a server with no
fonts installed renders identically to a laptop. If Hebrew comes out as boxes,
something else is wrong — and the renderer will refuse before it gets there, see
the font guard in `src/render/index.js`.

## 4. The web root Caddy already serves

```bash
sudo mkdir -p /var/www/brickdeal/cards
sudo chown brickdeal:brickdeal /var/www/brickdeal/cards
```

In the Caddyfile:

```
slides.brickdeal.co.il {
    root * /var/www/brickdeal
    file_server
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy gets the certificate itself on first request, provided the DNS A record
for `slides.brickdeal.co.il` already points at this box.

**Verify it from off the machine before going further.** This is the single
assumption everything downstream rests on, and it is cheap to check:

```bash
sudo -u brickdeal touch /var/www/brickdeal/cards/probe.jpg
curl -sI https://slides.brickdeal.co.il/cards/probe.jpg | head -1   # expect 200
```

If that is not a 200 from another network, Instagram will not be able to fetch a
card either, and the failure it gives you is far less legible than this one.

## 5. `.env`

Copy `.env.example` and fill it in — it documents every variable. Two entries
differ from a laptop:

```ini
CARD_OUTPUT_DIR=/var/www/brickdeal/cards
CARD_PUBLIC_BASE_URL=https://slides.brickdeal.co.il/cards
```

`CARD_PUBLIC_BASE_URL` must resolve to the same file `CARD_OUTPUT_DIR` writes.
Getting this pair subtly wrong is the most common cause of a card that renders
perfectly and then fails to publish.

```bash
sudo -u brickdeal cp .env.example .env
sudo -u brickdeal nano .env
sudo chmod 600 .env
```

Set `TZ=Asia/Jerusalem` here as well as in the unit file — `RUN_HOUR=8` means
8am where the audience is, not 8am UTC.

## 6. Prove it works before it runs unattended

```bash
sudo -u brickdeal npm test                 # offline, no credentials needed
sudo -u brickdeal npm run brick-once -- --no-images   # the whole path, publishes nothing
sudo -u brickdeal npm run run-once         # a full pass, publishes nothing
sudo -u brickdeal npm run deck-once -- "Dolomites mountain"
```

`deck-once` is the one that exercises Chromium, the bundled fonts, the photo
measurement and the renderer together. If it writes slides into `out/decks/`,
the hard part of this deployment is done.

## 7. Keeping it running

> **What the live box actually does, as of 2026-09-20.** The production host
> runs this under **pm2 as root from `/opt/brickdeal-social`**, not under systemd
> from `/srv/brickdeal/app`. The unit file below describes the intended shape and is
> still the better one — it drops privileges, caps memory and isolates the
> filesystem, none of which pm2 is doing here — but it is not what is running,
> and a deploy that follows this file to the letter will end up with two copies
> of the bot long-polling the same Telegram token. Reconcile before you follow
> the section below.
>
> The commands for what is actually there:
>
> ```bash
> pm2 list                 # brickdeal should be `online`
> pm2 restart brickdeal
> pm2 logs brickdeal --lines 50
> pm2 save                 # persist the process list across reboots
> ```
>
> Note also that pm2 does not read `.env` for you the way `EnvironmentFile`
> does — `src/env.js` loads it from the working directory, which is why
> `exec cwd` must stay `/opt/brickdeal-social`.

`/etc/systemd/system/brickdeal-social.service`:

```ini
[Unit]
Description=brickdeal+ content pipeline
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brickdeal
Group=brickdeal
WorkingDirectory=/srv/brickdeal/app
EnvironmentFile=/srv/brickdeal/app/.env
Environment=NODE_ENV=production
Environment=TZ=Asia/Jerusalem
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10

# It shares this box. Chromium is the spike — it is held for about five
# minutes after the last render (RENDER_IDLE_MS) and then shut down, so the
# steady state is far below this ceiling.
MemoryMax=1200M

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/srv/brickdeal/app/data /var/www/brickdeal/cards

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` does not understand quotes the way a shell does — a value
wrapped in `"` arrives *with* the quote characters. Leave them off.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brickdeal
sudo systemctl status brickdeal
journalctl -u brickdeal -f
```

Then **DM the bot `/start` once** from your own Telegram account. Until you do,
it cannot message you at all, and it ignores everyone whose id is not
`OWNER_ID`. Send `/status` to confirm it is alive.

## 8. TikTok, if you want it

Only after the domain is live, because two of its requirements are about the
domain:

- `slides.brickdeal.co.il` must be verified under **URL properties** in the
  developer portal, or every post fails with `url_ownership_unverified`.
- `TIKTOK_REDIRECT_URI` must match what is registered there character for
  character, trailing slash included.

Set `TIKTOK_VERIFIED_DOMAINS` to whatever you verified there. It is checked
before init, and an image on any other domain is refused by name rather than
handed over — because TikTok's answer to an unverified host is not reliably an
error, it can simply decline to fetch, and that surfaces as a post stuck in
`PROCESSING` and looks like nothing at all. Left unset it falls back to the host
of the first card base URL, which is right while there is only one; the moment
you add a second via `CARD_PUBLIC_BASE_URLS`, set it explicitly or the new host
will be refused.

`npm run dry-run` exercises all of this — config, token, `creator_info`, the
privacy level, the domain preflight and the 24h cap — and stops at the one call
that would create a post. It points `STORE_PATH` at a copy of `data/store.json`
first, so it is safe to run while the bot is live. Run it after any change to
the card host or the TikTok app.

Then `npm run tiktok-token` as the service user, so the token pair lands in
`data/store.json` — where it is refreshed, because the access token lasts about
a day and a value in `.env` would be stale by morning.

---

## Keeping it alive

**Back up `data/`.** It is the only thing here that cannot be rebuilt.

```bash
sudo -u brickdeal cp /srv/brickdeal/app/data/store.json \
  /srv/brickdeal/backup/store-$(date +%F).json
```

**Updating:**

```bash
cd /srv/brickdeal/app
sudo -u brickdeal git pull
sudo -u brickdeal npm ci
sudo -u brickdeal npm test
sudo systemctl restart brickdeal
```

**Cards accumulate.** They are regenerable, so old ones can go — but not
recent ones, which Instagram and TikTok may still be fetching:

```bash
find /var/www/brickdeal/cards -name '*.jpg' -mtime +30 -delete
```

## When something breaks

| Symptom | Where to look |
|---|---|
| Bot silent, service running | Did you DM it `/start`? Is your id `OWNER_ID`? |
| `Host system is missing dependencies` | Step 3, and check which user owns `~/.cache/ms-playwright` |
| Renders fail mentioning Heebo | The font guard fired — a bundled face did not parse. It is refusing on purpose; a silent fallback would publish tofu boxes |
| `url_ownership_unverified` | TikTok domain verification, step 8 |
| Instagram fetch fails | `curl -I` the exact URL from off the box; check the `CARD_OUTPUT_DIR` / `CARD_PUBLIC_BASE_URL` pair |
| `no places found` on every deck | Overpass, not you. All three mirrors go down together sometimes; it is transient |
| Memory pressure on a shared box | Lower `RENDER_IDLE_MS` so Chromium is released sooner between renders |
