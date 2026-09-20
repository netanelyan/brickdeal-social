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
`cards.tiyulplus.com` already runs on alongside BrickDeal.

---

## What is actually being deployed

One long-running Node process. It is **not** a cron job — `bot.js` schedules
itself with `setInterval`, gathers through the day from `RUN_HOUR`, and drips
posts every `POST_INTERVAL_MINUTES`. Killing and restarting it on a timer would
lose the day's state. It wants systemd with `Restart=always`.

It needs **no inbound ports**. Telegram is long-polled, so the bot reaches out.
Only Caddy listens, on 80 and 443, and only to serve the rendered images.

Three things live outside the repository and none of them are in git:

| What | Where | Why it is not in git |
|---|---|---|
| Secrets | `.env` | `.gitignore` covers `.env` and `.env.*` — a `.env.bak` is the same secrets with a different extension |
| State | `data/store.json` | dedupe history, the publish queue, the published log the pillar quotas are computed from, and the TikTok token pair |
| Rendered cards | `CARD_OUTPUT_DIR` | regenerable from the candidate at any time |

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
sudo adduser --system --group --home /srv/tiyul tiyul
sudo -u tiyul git clone https://github.com/netanelyan/tiyul-social /srv/tiyul/app
cd /srv/tiyul/app
sudo -u tiyul npm ci
```

## 3. Chromium, with its system libraries

**This is where a VPS deploy usually fails.** Playwright's Chromium needs a
couple of dozen shared libraries that a minimal server image does not have, and
without them it fails at launch with a missing-`.so` error rather than anything
that mentions Playwright.

```bash
sudo npx playwright install-deps chromium
sudo -u tiyul npx playwright install chromium
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
sudo mkdir -p /var/www/tiyul/cards
sudo chown tiyul:tiyul /var/www/tiyul/cards
```

In the Caddyfile:

```
cards.tiyulplus.com {
    root * /var/www/tiyul
    file_server
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy gets the certificate itself on first request, provided the DNS A record
for `cards.tiyulplus.com` already points at this box.

**Verify it from off the machine before going further.** This is the single
assumption everything downstream rests on, and it is cheap to check:

```bash
sudo -u tiyul touch /var/www/tiyul/cards/probe.jpg
curl -sI https://cards.tiyulplus.com/cards/probe.jpg | head -1   # expect 200
```

If that is not a 200 from another network, Instagram will not be able to fetch a
card either, and the failure it gives you is far less legible than this one.

## 5. `.env`

Copy `.env.example` and fill it in — it documents every variable. Two entries
differ from a laptop:

```ini
CARD_OUTPUT_DIR=/var/www/tiyul/cards
CARD_PUBLIC_BASE_URL=https://cards.tiyulplus.com/cards
```

`CARD_PUBLIC_BASE_URL` must resolve to the same file `CARD_OUTPUT_DIR` writes.
Getting this pair subtly wrong is the most common cause of a card that renders
perfectly and then fails to publish.

```bash
sudo -u tiyul cp .env.example .env
sudo -u tiyul nano .env
sudo chmod 600 .env
```

Set `TZ=Asia/Jerusalem` here as well as in the unit file — `RUN_HOUR=8` means
8am where the audience is, not 8am UTC.

## 6. Prove it works before it runs unattended

```bash
sudo -u tiyul npm test                 # offline, no credentials needed
sudo -u tiyul npm run check-sources    # probes every feed
sudo -u tiyul npm run run-once         # a full pass, publishes nothing
sudo -u tiyul npm run deck-once -- "Dolomites mountain"
```

`deck-once` is the one that exercises Chromium, the bundled fonts, the photo
measurement and the renderer together. If it writes slides into `out/decks/`,
the hard part of this deployment is done.

## 7. systemd

`/etc/systemd/system/tiyul.service`:

```ini
[Unit]
Description=tiyul+ content pipeline
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tiyul
Group=tiyul
WorkingDirectory=/srv/tiyul/app
EnvironmentFile=/srv/tiyul/app/.env
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
ReadWritePaths=/srv/tiyul/app/data /var/www/tiyul/cards

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` does not understand quotes the way a shell does — a value
wrapped in `"` arrives *with* the quote characters. Leave them off.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tiyul
sudo systemctl status tiyul
journalctl -u tiyul -f
```

Then **DM the bot `/start` once** from your own Telegram account. Until you do,
it cannot message you at all, and it ignores everyone whose id is not
`OWNER_ID`. Send `/status` to confirm it is alive.

## 8. TikTok, if you want it

Only after the domain is live, because two of its requirements are about the
domain:

- `cards.tiyulplus.com` must be verified under **URL properties** in the
  developer portal, or every post fails with `url_ownership_unverified`.
- `TIKTOK_REDIRECT_URI` must match what is registered there character for
  character, trailing slash included.

Then `npm run tiktok-token` as the service user, so the token pair lands in
`data/store.json` — where it is refreshed, because the access token lasts about
a day and a value in `.env` would be stale by morning.

---

## Keeping it alive

**Back up `data/`.** It is the only thing here that cannot be rebuilt.

```bash
sudo -u tiyul cp /srv/tiyul/app/data/store.json \
  /srv/tiyul/backup/store-$(date +%F).json
```

**Updating:**

```bash
cd /srv/tiyul/app
sudo -u tiyul git pull
sudo -u tiyul npm ci
sudo -u tiyul npm test
sudo systemctl restart tiyul
```

**Cards accumulate.** They are regenerable, so old ones can go — but not
recent ones, which Instagram and TikTok may still be fetching:

```bash
find /var/www/tiyul/cards -name '*.jpg' -mtime +30 -delete
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
