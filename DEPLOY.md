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
    # The admin panel and TikTok's browser connect, both inside the bot process
    # on one port. Everything under these two prefixes is proxied; everything
    # else is still a static file, which is what Instagram and TikTok fetch.
    #
    # The order matters. `handle` blocks are evaluated in order and the first
    # match wins, so the static file_server has to be last or it would answer
    # /api/ with a 404 from disk.
    handle /api/* {
        reverse_proxy 127.0.0.1:8787
    }
    handle /tiktok/* {
        reverse_proxy 127.0.0.1:8787
    }
    # The page itself: /, /app.js, /app.css. Listed explicitly rather than
    # proxying everything, so a mistyped path cannot reach the panel.
    handle /app.js {
        reverse_proxy 127.0.0.1:8787
    }
    handle /app.css {
        reverse_proxy 127.0.0.1:8787
    }
    handle / {
        reverse_proxy 127.0.0.1:8787
    }

    handle {
        root * /var/www/brickdeal
        file_server
    }
}
```

**The panel must not be reached over plain HTTP.** It binds `127.0.0.1` for that
reason and the bot warns at boot if `WEB_BIND` says otherwise: this endpoint can
publish to Instagram and TikTok, and binding `0.0.0.0` would put it on the open
internet on port 8787, past the thing holding the certificate.

If you would rather the panel had its own hostname — worth it, because the
slides host is public by necessity and the panel is not — give it one and leave
`slides.brickdeal.co.il` serving only files:

```
panel.brickdeal.co.il {
    reverse_proxy 127.0.0.1:8787
}
```

and keep only the `/tiktok/*` block on the slides host, since TikTok's redirect
URI is registered against that domain.

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

The panel's own entries are all optional and the defaults are the right ones:

```ini
WEB_BIND=127.0.0.1            # do not change this without reading §4
WEB_PORT=8787
WEB_PUBLIC_URL=https://panel.brickdeal.co.il   # only so /site can print it
```

Leave `WEB_SESSION_SECRET` empty unless you want it here with the other secrets;
a key is generated on first use and kept in the store, so restarts do not sign
everybody out.

One more thing worth knowing about this file: the pacing values in it
(`POST_INTERVAL_MINUTES`, `DECKS_PER_DAY`, `RUN_HOUR`, and the rest) are now the
**defaults**, not the last word. Anything changed on the panel's settings page
is stored in `data/store.json` and wins. The page says which of the two each
value is currently coming from, and offers to clear it back to `.env`.

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

Once the bot is running, check the panel from the box and then from off it:

```bash
curl -s localhost:8787/api/session          # {"user":null,"accounts":0,...}
curl -sI https://panel.brickdeal.co.il/ | head -1     # expect 200 through Caddy
```

A `"user":null` is the right answer — that is the login page's normal state. If
`accounts` is `0`, §8 is the step you still owe it.

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
> pm2 list                 # brickdeal-social should be `online`
> pm2 restart brickdeal-social
> pm2 logs brickdeal-social --lines 50
> pm2 save                 # persist the process list across reboots
>
> **The name is `brickdeal-social`, not `brickdeal`.** The box runs four pm2
> processes, and `brickdeal` is the deals bot from brickdeal-automation —
> `pm2 restart brickdeal` restarts the wrong one and leaves this unchanged.
>
> Updating, as it is actually done:
>
> ```bash
> cd /opt/brickdeal-social
> git pull --ff-only
> npm ci
> npm test
> pm2 restart brickdeal-social
> ```
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

## 8. The first account on the panel

The panel starts with the bot and refuses everybody until an account exists. The
first one cannot be made from the panel — there is nobody to authorise it — so
it is made here, which is the right credential for "create the first
administrator": shell access to the server.

```bash
sudo -u brickdeal npm run admin -- add netanel --name="נתנאל"
```

It asks for a password twice, without echoing it. `--generate` invents a strong
one and prints it once instead.

**Stop the bot first, or pass `--force` knowing why.** `src/store.js` holds the
whole of `data/store.json` in memory and saves it whole, so an account written
by this short-lived process while the bot is running would be rolled back by the
bot's next save. The tool checks for a recently-touched store and refuses rather
than doing that silently. This only applies to the bootstrap: every account
after the first is made from the panel, inside the bot's own process, with
nothing to stop.

```bash
pm2 stop brickdeal-social
sudo -u brickdeal npm run admin -- add netanel
pm2 start brickdeal-social
```

Then open the panel and sign in. `/site` in Telegram reports where it is
listening and how many accounts exist; `npm run admin -- list` does the same
from the terminal.

Other things this tool does, all of which also need the bot stopped:

```bash
npm run admin -- password <username>        # the way back in from a forgotten one
npm run admin -- role <username> viewer     # owner | admin | viewer
npm run admin -- remove <username>
npm run admin -- signout-all                # replaces the session signing key
```

## 9. TikTok, if you want it

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

### If the panel is the thing that is broken

| What you see | What it is |
|---|---|
| `panel: 127.0.0.1:8787 is already in use` at boot | a stale process still holds the port. The bot carries on without the panel deliberately — publishing does not need it. `pm2 restart` after killing the old one. |
| Caddy answers 502 | the bot is not running, or is running without the panel (see the line above in `pm2 logs`). |
| The page loads but every button fails with "הבקשה לא אומתה" | the browser has a session the server no longer recognises — somebody ran `signout-all`, or `WEB_SESSION_SECRET` changed. Reload the page. |
| Signing in says "too many attempts" | six wrong passwords locks that username for five minutes. It is per username, so it clears itself. |
| Everybody is locked out | `npm run admin -- password <username>`, with the bot stopped. |
| An account added from the terminal vanished | it was added while the bot was running and the bot's next save rolled it back. That is what the `--force` warning was about. |

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
