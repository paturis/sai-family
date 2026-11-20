# Self-hosting the game show (Docker + your Caddy)

One small container: a Node server with SQLite, WebSocket realtime and server-side AI grouping. It also serves the four
web pages, so there is no GitHub Pages, no Firebase and no Google sign-in. About 30 MB of RAM at 400 phones.

```
phones / projector / tech laptop  ──https──►  your Caddy  ──►  sai-gameshow:8080 (this container)  ──►  SQLite in a Docker volume
                                    (also wss://…/ws)                                  └─►  Gemini (key stays here)
```

## First-time setup (about 10 minutes)

1. **DNS:** point a name (e.g. `game.example.org`) at the VPS.
2. **Get the code** on the VPS (`git clone`, branch `self-hosted`) and go to `deploy/`.
3. **Settings:**
   ```bash
   cp .env.example .env && chmod 600 .env
   nano .env        # PUBLIC_URL, GEMINI_API_KEY, ADMIN_IDS, CADDY_NETWORK
   ```
   `docker network ls` shows the network your Caddy container is on; put its name in `CADDY_NETWORK`.
4. **Start it:**
   ```bash
   docker compose up -d --build
   docker compose logs -f app     # expect:  [server] listening …   and   [ai] self-test: ready (gemini-3.5-flash-lite, … ms)
   ```
5. **Caddy:** add the block from `Caddyfile.example` to the Caddyfile you already run and reload it
   (`docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile`). Caddy gets the HTTPS certificate by itself.
   If Caddy runs directly on the host instead of in Docker, see the comment in `docker-compose.yml` (publish `127.0.0.1:8080`).
6. **Your login link:**
   ```bash
   docker compose exec app node src/cli.js login-link ritesh
   ```
   Open the printed link: you are signed in as admin for 30 days on that browser.
7. **Add the team** in the app (Team tab). Use people's **email addresses**: with email set up (below) the app emails them a
   sign-in link straight away; otherwise it shows the link to copy and send yourself (WhatsApp is fine).
   Every link works **once**. You can also do it on the server: `docker compose exec app node src/cli.js add-user ravi@example.org tech`.
8. **Load the question bank:** Dashboard → Question bank → add the starter questions (same as before).

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

Roles: **admin** does everything, **tech** runs the show (no bank edits, no creating or deleting surveys), **host** is the
read-only emcee screen (`/emcee.html`).

## Check it works BEFORE the event

- **AI:** the top bar shows `AI ✓ ready`. If it shows ✗, click **🩺 AI status** on the tabulate screen: it says exactly what
  is wrong (key missing, key rejected, model name wrong, quota…). Fix `.env`, `docker compose up -d`.
- **Sync:** the top bar shows `● Live`. Pull the network cable on a phone or the laptop: it shows `● Offline — reconnecting…`
  and recovers by itself.
- **Load test** (from your laptop, 400 simulated phones):
  ```bash
  docker compose exec app node src/cli.js add-user loadtest admin     # copy the token after ?login=
  cd ../server && npm install && node loadtest/phones.js --url https://game.example.org --token <token> --phones 400
  docker compose exec app node src/cli.js remove-user loadtest
  ```
  Expect `PASS`. Run it while your other services are busy to see the real picture on a shared VPS.
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
