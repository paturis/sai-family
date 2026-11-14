# Adding a new game to the SSSIO game platform

Every game (Feud, Jeopardy, Antakshari, and whatever comes next) shares the same platform:
Google sign-in, the Team tab (admin / tech / host), the content library, sessions with history,
the join code, the projector page (`display.html`) and the emcee page (`emcee.html`).
A game is one small plug-in object in `games.js`. Nothing else in the app changes.

## The contract

```js
GAMES.register({
  id:'myGame', label:'My Game', icon:'🎲', itemLabel:'card', itemsLabel:'Cards',
  kinds:[['card','Card']],                    // item types shown in the editor
  fields:[{k:'en',label:'Prompt',t:'textarea',full:1}, {k:'answer',label:'Answer',t:'text'},
          {k:'tags',label:'Sets / tags',t:'tags',full:1}],   // t: text | textarea | select | kind | tags
  defaults:{kind:'card'},
  row(item)        { return {a:item.en, b:item.answer, chip:'Card'} },   // one line in the library
  summary(items)   { return items.length+' cards' },                      // shown on the session screen
  validate(items)  { return items.length?'':'Pick at least one card.' },  // '' = fine
  init(items, sv)  { return {game:'myGame', teams:[...], ...} },          // new game state (JSON only)
  act(S, action, d){ /* mutate S; d = the button's data-* values (and d.v for inputs) */ return S },
  tech(S)          { /* HTML for the IT tech. Buttons: data-g="myGame" data-act="..."  Inputs: data-gi="myGame" data-act="..." */ },
  host(S)          { /* HTML for the emcee (read-only; may show hidden answers) */ },
  publicState(S,sv){ /* JSON for the audience screen. NEVER include hidden answers. */ },
  display(D)       { /* HTML for the projector, built from publicState */ }
});
```

## What you get for free

* A library tab for the game on the Dashboard (add / edit / delete items, tags, starter content).
* Sessions: pick items, name it, save, clone, delete, re-run later; history is kept.
* A 5-letter code, `display.html?code=XXXXX` for the hall screen, and the emcee list.
* Role rules: admins build content and sessions, techs run any session, hosts watch read-only.
* Autosave of the game state (so another laptop can take over) and the public mirror for the projector.

## Steps

1. Add the object above to `games.js` (copy the Jeopardy block as a starting point).
2. Optional: add starter content as `window.GAME_SEEDS.myGame = [...]` in `seed_games.js`
   (each item: `{game:'myGame', kind, en, ..., tags:[]}`).
3. Rebuild (`python3 build.py`), run `node test_games.js`, upload `index.html`, `display.html`, `emcee.html`.

No Firestore rules change is needed: the same `questions`, `surveys` and `display` collections are used,
with a `game` field on each document.
