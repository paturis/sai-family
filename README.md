# Sai Family Feud — hosted web app (GitHub Pages + Firebase)

Build surveys, collect live audience answers on phones, and run the "Survey Says!" game, with a separate screen for
each role. Free tier is enough for one event of about 200 people.

## Pages and who uses them
| Role | Page | Sign-in | What they do |
|---|---|---|---|
| **Admin / organizer** | `index.html` | Google, `role: admin` | Question bank, create/edit/clone/delete surveys, past results, everything the tech can do |
| **IT tech (operator)** | `index.html` | Google, `role: tech` | Launch and run Round 0 (QR, timers), group answers, load the board, then operate the game: reveals, strikes, points, manual score fixes, timers, Fast Money. Cannot edit the bank or delete/clone surveys |
| **Game host (emcee)** | `emcee.html` | Google, `role: host` | Read-only live view on a phone/tablet: current question, cue, all answers (hidden ones visible only to them), what is on the board, strikes, scores |
| **Audience (hall screen)** | `display.html?code=XXXXX` | none | Public scoreboard for the projector: team scores, the board with revealed answers only, strikes (big X), timer, final result. Updates within about a second of the tech's actions |
| **Audience (phones)** | `play.html?code=XXXXX` (the QR) | none (anonymous) | Answer the survey; after it ends they see live scores |

The tech operates from their own laptop while the projector shows `display.html`, so the audience always sees the
scores and revealed answers, and never the controls or the hidden answers. (Press **Audience display** in the game
header to open it.)

## Event flow
1. Admin builds the survey from the question bank. Tech opens it and clicks **Launch**; project the QR.
2. Round 0: tech runs the questions (contestants wait outside). **Tabulate**, fix grouping, **Load into game**.
3. Open `display.html?code=...` on the hall screen. Invite contestants in. **Begin Round 1**.
4. Tech runs the board; the emcee follows on `emcee.html`; the audience watches the display.
5. Every survey is kept: reopen, export CSV, clone, or clone using its results as hints.
Practice mode (button on the sign-in page) runs everything in one browser with a simulated audience.

## One-time setup
1. **Firebase:** create a project; Firestore Database (production mode); Authentication: enable **Google** and **Anonymous**;
   register a Web app and copy its `firebaseConfig`.
2. **Config:** paste it into `firebase-config.js` (not secret).
3. **Rules:** Firestore > Rules tab: replace with `firestore.rules`, Publish.
4. **Approve people:** Firestore > Data > start collection `admins`. One document per person:
   Document ID = their Google email in lowercase; field `role` (string) = `admin`, `tech` or `host`.
5. **GitHub Pages:** new repository, upload the 6 files to the root, Settings > Pages > deploy from `main` / root.
6. Firebase Authentication > Settings > **Authorized domains**: add `YOUR-USERNAME.github.io`.

## Security model
- Only emails in `admins` get in. Admins change everything; techs can update surveys and run games but cannot
  change the bank or create/delete surveys; hosts can only read surveys and the live game.
- Phones sign in anonymously and can write one answer per question, only while it is open, max 80 characters.
- The public scoreboard document contains only what is already on the board; hidden answers are never published.
- No names or emails are collected from the audience.

## Free-tier budget (about 200 phones, 11 questions)
About 2,200 answer writes (limit 20,000/day). Reads about 12,000 for the survey, plus one read per phone/projector
per scoreboard update during the game (each viewer re-reads on every change). Budget roughly 200 viewers x 150 updates
= 30,000 reads, so total stays under the 50,000/day limit but with less headroom: keep phones off the scoreboard if
you are close, or check the live usage in the Firebase console. Verify current quotas: https://firebase.google.com/pricing

## Honest notes
- The Firebase code and security rules could not be run against a live Firebase project here (the emulator was blocked).
  All app logic was tested against an in-memory backend that mirrors the rules. **Rehearse with 5-10 real phones first.**
- Two techs should not operate the same game at once (last save wins).
- The phone countdown can be off by a second or two; the host's timer decides when a question closes.
- English only for now. The game header still says "Sai Five" in a few places when a game uses a different shape.

## Self-hosted option (Docker + SQLite + WebSocket)
This branch also contains a self-hosted backend in `server/` that replaces Firebase: no quotas, no per-IP sign-in limits,
server-side AI grouping with the Gemini key kept on the server, and personal login links instead of Google sign-in.
See [`deploy/README.md`](deploy/README.md). The pages choose their backend from `backend-config.js`
(`firebase` on GitHub Pages, `server` when served by the container), so the original setup keeps working.

## Sound
The projector laptop (on the hall speakers) plays every sound: ding, buzzer, fanfare, applause, countdown ticks, steal alert, intro music.
The tech has a soundboard and volume control. Sounds are original and generated in the browser; put your own files in `sounds/` to
replace any of them (see `sounds/README.txt`). Details in `deploy/README.md`.

## Look and feel
The design follows sathyasai.org: white and airy staff screens, dark navy panels for what the hall sees, orange and blue brand
colours, Open Sans text and Rokkitt slab headings (both self-hosted in `fonts/`, so no internet is needed).
`theme.css` holds the shared colours, buttons, chips and form controls; `console.css` styles the tech/admin console and the
operator screen; the phone, projector and emcee pages carry their own small page styles. To review every screen after a change:
`cd server && npm run shots -- /some/folder` (needs Chrome) walks through the whole app and saves a screenshot of each screen.
