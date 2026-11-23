# Self-hosting the game show (Docker + your Caddy)

One small container: a Node server with SQLite, WebSocket realtime and server-side AI grouping. It also serves the four
web pages, so there is no GitHub Pages, no Firebase and no Google sign-in. About 30 MB of RAM at 400 phones.

```
phones / projector / tech laptop  ──https──►  your Caddy  ──►  sai-gameshow:8080 (this container)  ──►  SQLite in a Docker volume
                                    (also wss://…/ws)                                  └─►  Gemini (key stays here)
```

## First-time setup (about 10 minutes)

1. **DNS:** point `gameshow.sathyasai.org` at the VPS.
2. **Get the code** on the VPS and go to `deploy/`:
   ```bash
   git clone -b self-hosted git@github.com:paturis/sai-family.git && cd sai-family/deploy
   ```
3. **Settings:**
   ```bash
   cp .env.example .env && chmod 600 .env
   nano .env        # at least PUBLIC_URL (https), ADMIN_IDS and GEMINI_API_KEY
   ```
4. **Start it:**
   ```bash
   docker compose up -d --build
   docker compose logs -f app     # expect:  [server] listening …   and   [ai] self-test: ready (…)
   ```
5. **It is exposed through your caddy-docker-proxy** by the labels and the `caddy` network already in `docker-compose.yml`
   (`gameshow.sathyasai.org`, WebSockets included). If your Caddy's Docker network is not called `caddy`, change it in the `networks:` block
   (`docker network ls` shows the name). `PUBLIC_URL` in `.env` must match: `https://gameshow.sathyasai.org`.
6. **Your login link:**
   ```bash
   docker compose exec app node src/cli.js login-link <the name in ADMIN_IDS>
   ```
   Open the printed link: you are signed in as admin for 30 days on that browser.
7. **Add the team** in the app (Team tab). Use people's **email addresses**: with email set up (below) the app emails them a
   sign-in link straight away; otherwise it shows the link to copy and send yourself (WhatsApp is fine).
   Every link works **once**. You can also do it on the server: `docker compose exec app node src/cli.js add-user ravi@example.org tech`.
8. **Load the question bank:** Dashboard → Question bank → add the starter questions.

## Email sign-in (Microsoft 365)

People open the app, type their email, and receive a one-time link (works once, expires in 15 minutes by default). Only
addresses that are on the Team list get an email, and the page answers identically for everyone else, so it can't be used to
find out who has an account. Emailed links are random values stored hashed on the server and checked there (single use,
revocable the moment you remove someone, which a self-contained signed token could not do).

1. Put the mailbox in `.env`: `SMTP_USER`, `SMTP_PASS` (and leave `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`).
2. `docker compose up -d`, then check it works: `docker compose exec app node src/cli.js mail-test you@example.org`.
   The logs also say `[mail] SMTP smtp.office365.com: ready` or the exact reason it failed, and admins see a `Mail ✓/✗` chip.
3. **Microsoft may refuse the login.** Microsoft has been switching off password-based SMTP ("basic auth") for Microsoft 365 during
   2026. If `mail-test` says SMTP AUTH is disabled: ask your Microsoft 365 admin to enable *Authenticated SMTP* for that mailbox
   (and use an app password if MFA is on), or switch to a different mailbox/provider. Until it works, everything else still does:
   admins can copy login links from the Team tab or the CLI.
4. The sender must be the mailbox itself (or one it has "Send as" rights for), set with `SMTP_FROM`.

## The four screens on the day

Each person has their own screen, and each screen has one job. The **Links** button in the tech console lists all the addresses.

1. **Projector laptop** — open `/display.html?code=XXXXX` once, press **F** for full screen, and leave it. It needs no sign-in and
   no one touches it. By itself it shows: a "welcome" screen, the join **QR code** and code (with a live count of phones that have
   joined), each survey **question** with the live answer count and countdown, "Counting the votes", "Contestants, please come up",
   and then the game board, strikes, scores and the steal banner. It keeps the screen awake and reconnects on its own.
2. **Tech laptop** — the console (`/`). Sees everything and controls everything, including **who is connected right now**: chips show
   whether the projector is live (green) or NOT connected (red), how many emcees and audience phones are on, and a warning if a second tech
   console is open (two consoles can overwrite each other). The tech's own preview window is never mistaken for a projector. It controls: the survey, the board with the hidden answers
   dimmed, strikes, awards, score corrections, timers, and a **live preview of the projector** with an Intermission / Blank override.
3. **Emcee phone** — `/emcee.html`, signed in as a host. Follows the survey (question, answer count, seconds left), then switches
   to the board by itself when the game starts, showing the hidden answers, strikes and scores. Read-only.
4. **Audience phones** — the QR code. One short answer per question, then live scores.

### Sound (all played by the projector laptop)
The hall speakers go on the **projector laptop**, so that is the laptop that plays every sound; the tech laptop stays silent while a
projector is connected. On the projector page click **"Click here once to turn the sound on"** (browsers require one click) and
you will hear a test ding. After that it is automatic: a ding for each revealed answer, a buzzer for a strike, a fanfare and applause
when a round is awarded, a chime when a survey question opens, ticks in the last 5 seconds of any countdown, a buzzer when time runs
out, a steal alert, and an intro jingle when the game begins. Undoing something never makes a sound.

The tech has a **soundboard** in the Projector panel (ding, buzzer, applause, drum roll, fanfare, intro music, looping "thinking"
music, stop) with a volume slider and a sound on/off switch. They only send a cue; the projector laptop plays it.

**Sound sets.** The built-in sounds are always the default. The tech can switch to an alternative set in the Sound box of the Projector
panel: "Classic game show (your own files)" uses whatever you put in `sounds/classic/` (names in `sounds/classic/README.txt`), and any
sound missing from that folder still uses the built-in one. Those files are deliberately **not** in this repository, and git ignores audio
in that folder, because recordings of the TV show are copyrighted and the repository is public. Copy them straight onto the server
(`sai-family/sounds/classic/`), then rebuild (`docker compose up -d --build`) or use the bind mount in `docker-compose.yml`, and reload the projector page.

All sounds are original and made in the browser, so nothing needs downloading. To use **your own sounds or music** put files such as
`buzzer.mp3` or `intro.mp3` in the `sounds/` folder (names and formats in `sounds/README.txt`), rebuild or bind-mount it (see the
comment in `docker-compose.yml`), and reload the projector page. Only use audio you have the right to use: recordings from TV
game shows are copyrighted.

### Taking mistakes back (tech)
Everything the tech does on the board can be undone: reveals, hides, strikes, who has control, awarding a round (even to the wrong
team), score corrections and Fast Money. **Z** or **Ctrl/⌘+Z** undoes the last action, **Shift+Z** redoes it, and the sidebar shows the
last action plus a list of recent ones. **X** adds a strike and **Shift+X** removes one. After an award the sidebar says
"Wrong team? Press Undo." The projector and emcee follow every undo instantly.

## Check it works BEFORE the event

- **AI:** the top bar shows `AI ✓ ready`. If it shows ✗, click **🩺 AI status** on the tabulate screen: it says exactly what
  is wrong (key missing, key rejected, model name wrong, quota…). Fix `.env`, `docker compose up -d`.
- **Sync:** the top bar shows `● Live`. Pull the network cable on a phone or the laptop: it shows `● Offline — reconnecting…`
  and recovers by itself.
- **Load test** (from your laptop, 400 simulated phones):
  ```bash
  docker compose exec app node src/cli.js add-user loadtest admin     # copy the token after ?login=
  cd ../server && npm install && node loadtest/phones.js --url https://gameshow.sathyasai.org --token <token> --phones 400
  docker compose exec app node src/cli.js remove-user loadtest
  ```
  Expect `PASS`. Run it while your other services are busy to see the real picture on a shared VPS.
- **All four screens, automated:** `cd server && npm run e2e:views` runs a whole show (tech, projector, emcee, audience) in real browsers and checks every stage, every undo and that the projector plays each sound at the right moment. `npm run e2e:sounds` checks that every built-in sound is audible, not clipped and the right length (set `SOUNDS_OUT=/folder` to also save WAV files to listen to).
- **Real phones:** 10+ people on the venue wifi (or mobile data), full 45-minute run with a stopwatch.

## Day to day

| Task | Command |
|---|---|
| Logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update to new code | `git pull && docker compose up -d --build` |
| New login link | `docker compose exec app node src/cli.js login-link <name>` (copy and send it yourself) |
| Test the email setup | `docker compose exec app node src/cli.js mail-test you@example.org` |
| Who has access | `docker compose exec app node src/cli.js list-users` |
| Backup now | `./backup.sh` (copies to `deploy/backups/`; run it before the event and nightly from cron) |

**Restore a backup** (stops the app for a few seconds):
```bash
docker compose stop app
docker run --rm -v "$(docker volume ls -q | grep gameshow-data)":/data -v "$PWD/backups":/b alpine \
  sh -c 'cp /b/gameshow-YYYYMMDD-HHMMSS.db /data/gameshow.db && rm -f /data/gameshow.db-wal /data/gameshow.db-shm'
docker compose start app
```

## If something goes wrong on the day

- **Server restarts:** phones and the console reconnect on their own and get the current state. Questions whose time ran out
  while it was down are closed automatically. The tech's game state is saved on every change (and resumes after a reload).
- **VPS or venue internet is down:** run the same stack on the tech laptop (`docker compose up -d` with
  `PUBLIC_URL=http://<laptop-LAN-IP>:8080` and `ports: ["8080:8080"]`). Phones on the same wifi open that address. Create
  logins with the CLI. AI grouping needs internet; the old grouping still works without it.
- **Back to Firebase:** nothing here changes GitHub Pages. The original pages on `main` keep using Firebase.

## Security notes

- The container runs as a non-root user with a read-only filesystem, no Linux capabilities, 512 MB / 1 CPU limits.
- Login links (emailed or copied) are random 256-bit values, stored hashed, single use; emailed ones expire in 15 minutes. Sessions are `HttpOnly`, `SameSite=Lax`, `Secure` over https.
- Phones can only answer the **current, open** question (1–80 characters, one answer each); buzz order uses the server clock.
- Hidden answers are never sent to phones or the projector; the full game state goes only to signed-in staff and the emcee.
- Cross-site requests and cross-site WebSockets are refused. Secrets live only in `.env` and the data volume.

## Limits to know

- One server process, one SQLite file: comfortable for thousands of phones, not meant for several servers.
- The game state still has "last save wins" if two techs run the same game at once. Use one tech console.
- Open file limit is set to 65,535 on the container; check your Caddy's own limit with
  `docker exec <caddy> sh -c 'cat /proc/1/limits | grep "open files"'` (it needs about 2 descriptors per phone).
