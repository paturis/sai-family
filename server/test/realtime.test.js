import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, client, login, until, wait } from './helpers.js';

const sub = (ws, ch) => ws.send(JSON.stringify({ t: 'sub', ch }));
const docs = (ws, ch) => ws.msgs.filter((m) => m.t === 'doc' && m.ch === ch);

test('subscribing sends the current value, then every change', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    const phone = await client(s.base).ws();

    sub(phone, 'live:ROOM1');
    await until(() => docs(phone, 'live:ROOM1').length === 1);
    assert.equal(docs(phone, 'live:ROOM1')[0].data, null, 'missing code reads as null');

    await tech.rpc('liveSet', 'ROOM1', { phase: 'idle', q: -1 });
    await until(() => docs(phone, 'live:ROOM1').length === 2);
    assert.equal(docs(phone, 'live:ROOM1')[1].data.phase, 'idle');

    await tech.rpc('liveUpdate', 'ROOM1', { phase: 'open', q: 0, closesAt: Date.now() + 5000 });
    await until(() => docs(phone, 'live:ROOM1').length === 3);
    assert.equal(docs(phone, 'live:ROOM1')[2].data.phase, 'open');

    // late joiner gets the latest immediately
    const late = await client(s.base).ws();
    sub(late, 'live:ROOM1');
    await until(() => docs(late, 'live:ROOM1').length === 1);
    assert.equal(docs(late, 'live:ROOM1')[0].data.q, 0);

    // unsubscribed clients hear nothing
    phone.send(JSON.stringify({ t: 'unsub', ch: 'live:ROOM1' }));
    await wait(30);
    await tech.rpc('liveUpdate', 'ROOM1', { phase: 'closed' });
    await until(() => docs(late, 'live:ROOM1').length === 2);
    assert.equal(docs(phone, 'live:ROOM1').length, 3);

    // deleting the session tells everyone
    await tech.rpc('liveDelete', 'ROOM1');
    await until(() => docs(late, 'live:ROOM1').length === 3);
    assert.equal(docs(late, 'live:ROOM1')[2].data, null);
    phone.close(); late.close();
  } finally { await s.close(); }
});

test('display channel is public; game channel needs a signed-in role', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    const host = await login(s.app, s.base, 'host1', 'host');
    const anon = await client(s.base).ws();
    const hostWs = await host.ws();

    await tech.rpc('displaySet', 'SHOW1', { teams: { A: { name: 'A', score: 0 } } });
    sub(anon, 'display:SHOW1');
    await until(() => docs(anon, 'display:SHOW1').length === 1);
    assert.equal(docs(anon, 'display:SHOW1')[0].data.teams.A.name, 'A');
    await tech.rpc('displaySet', 'SHOW1', { teams: { A: { name: 'A', score: 50 } } });
    await until(() => docs(anon, 'display:SHOW1').length === 2);

    const sid = (await login(s.app, s.base, 'adm', 'admin').then((a) => a.rpc('createSurvey', { name: 'x' }))).body.r;
    await tech.rpc('setData', sid, 'game', { S: { hidden: 'answers live here' } });

    sub(anon, 'game:' + sid);
    await until(() => anon.msgs.some((m) => m.t === 'err'));
    assert.equal(docs(anon, 'game:' + sid).length, 0, 'anonymous cannot read the game state');

    sub(hostWs, 'game:' + sid);
    await until(() => docs(hostWs, 'game:' + sid).length === 1);
    assert.equal(docs(hostWs, 'game:' + sid)[0].data.S.hidden, 'answers live here');
    await tech.rpc('setData', sid, 'game', { S: { hidden: 'updated' } });
    await until(() => docs(hostWs, 'game:' + sid).length === 2);

    // junk channels are refused
    sub(anon, 'admin:users'); sub(anon, 'live:bad code');
    await until(() => anon.msgs.filter((m) => m.t === 'err').length >= 3);
    anon.close(); hostWs.close();
  } finally { await s.close(); }
});

test('ping/pong, flooding, and cross-site websockets', async () => {
  const s = await startApp();
  try {
    const ws = await client(s.base).ws();
    ws.send('{"t":"ping"}');
    await until(() => ws.msgs.some((m) => m.t === 'pong'));
    ws.send('not json');           // ignored, connection stays up
    ws.send('{"t":"ping"}');
    await until(() => ws.msgs.filter((m) => m.t === 'pong').length === 2);

    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    for (let i = 0; i < 80; i++) ws.send('{"t":"ping"}');
    assert.equal(await closed, 1008, 'flooding connection is closed');

    const { default: WebSocket } = await import('ws');
    const evil = new WebSocket(s.base.replace('http', 'ws') + '/ws', { headers: { Origin: 'https://evil.example' } });
    const outcome = await new Promise((r) => { evil.on('open', () => r('open')); evil.on('error', () => r('refused')); evil.on('unexpected-response', () => r('refused')); });
    assert.equal(outcome, 'refused');
  } finally { await s.close(); }
});

test('a full survey: phones answer, tech counts, buzz and results all work together', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    await tech.rpc('liveSet', 'FULL1', { phase: 'idle', q: -1, total: 1 });
    const phones = await Promise.all(Array.from({ length: 25 }, async () => ({ c: client(s.base), ws: null })));
    for (const p of phones) { p.ws = await p.c.ws(); sub(p.ws, 'live:FULL1'); }
    await until(() => phones.every((p) => docs(p.ws, 'live:FULL1').length === 1));

    await tech.rpc('liveUpdate', 'FULL1', { phase: 'open', q: 0, closesAt: Date.now() + 5000, question: { en: 'Name a quality' } });
    await until(() => phones.every((p) => docs(p.ws, 'live:FULL1').at(-1).data.phase === 'open'));
    const words = ['Honesty', 'honesty', 'Kindness', 'Love'];
    await Promise.all(phones.map((p, i) => p.c.post('/api/answer', { code: 'FULL1', q: 0, a: words[i % 4] })));
    assert.equal((await tech.rpc('countAnswers', 'FULL1', 0)).body.r, 25);

    await tech.rpc('liveUpdate', 'FULL1', { phase: 'closed' });
    await until(() => phones.every((p) => docs(p.ws, 'live:FULL1').at(-1).data.phase === 'closed'));
    assert.equal((await phones[0].c.post('/api/answer', { code: 'FULL1', q: 0, a: 'late' })).body.code, 'closed');

    const all = (await tech.rpc('getAnswers', 'FULL1')).body.r;
    assert.equal(all[0].length, 25);
    phones.forEach((p) => p.ws.close());
  } finally { await s.close(); }
});

test('stats channel: live answer count and connected devices, public, throttled', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    await tech.rpc('liveSet', 'STAT1', { phase: 'open', q: 2, closesAt: Date.now() + 60000, question: { en: 'Q' } });
    const screen = await client(s.base).ws();
    sub(screen, 'stats:STAT1');
    await until(() => docs(screen, 'stats:STAT1').length >= 1);
    assert.deepEqual(docs(screen, 'stats:STAT1')[0].data, { q: 2, count: 0, devices: 0, presence: { audience: 0, projector: 0, emcee: 0, tech: 0, buzzA: 0, buzzB: 0 } });

    // 3 phones join: devices go up
    const phones = [];
    for (let i = 0; i < 3; i++) { const p = await client(s.base).ws(); sub(p, 'live:STAT1'); phones.push(p); }
    await until(() => (docs(screen, 'stats:STAT1').at(-1).data.devices === 3));

    // 40 answers arrive in a burst: updates are batched, and the last one has the final count
    await Promise.all(Array.from({ length: 40 }, (_, i) => client(s.base).post('/api/answer', { code: 'STAT1', q: 2, a: 'a' + i })));
    await until(() => docs(screen, 'stats:STAT1').at(-1).data.count === 40);
    const burst = docs(screen, 'stats:STAT1').length;
    assert.ok(burst < 20, 'batched, not one message per answer (got ' + burst + ')');

    // next question: the count restarts
    await tech.rpc('liveUpdate', 'STAT1', { q: 3, phase: 'open' });
    await until(() => docs(screen, 'stats:STAT1').at(-1).data.q === 3);
    assert.equal(docs(screen, 'stats:STAT1').at(-1).data.count, 0);

    // a phone leaving lowers the device count
    phones[0].close();
    await until(() => docs(screen, 'stats:STAT1').at(-1).data.devices === 2);
    // nobody watching: no work is done and nothing breaks
    screen.close();
    await wait(50);
    await client(s.base).post('/api/answer', { code: 'STAT1', q: 3, a: 'x' });
    phones.forEach((p) => p.close());
  } finally { await s.close(); }
});

test('presence: the tech can see the projector, emcees, other tech consoles and phones', async () => {
  const s = await startApp();
  try {
    const watcher = await client(s.base).ws();
    sub(watcher, 'stats:PRES1');
    const hello = (ws, role, code = 'PRES1') => ws.send(JSON.stringify({ t: 'hello', code, role }));
    const last = () => docs(watcher, 'stats:PRES1').at(-1).data.presence;
    await until(() => docs(watcher, 'stats:PRES1').length >= 1);
    assert.deepEqual(last(), { audience: 0, projector: 0, emcee: 0, tech: 0, buzzA: 0, buzzB: 0 });

    const projector = await client(s.base).ws(); sub(projector, 'display:PRES1'); hello(projector, 'projector');
    await until(() => last().projector === 1);
    const emcee1 = await client(s.base).ws(); hello(emcee1, 'emcee');
    const emcee2 = await client(s.base).ws(); hello(emcee2, 'emcee');
    const tech1 = await client(s.base).ws(); hello(tech1, 'tech');
    const phones = [];
    for (let i = 0; i < 3; i++) { const p = await client(s.base).ws(); sub(p, 'live:PRES1'); phones.push(p); }
    await until(() => { const p = last(); return p.emcee === 2 && p.tech === 1 && p.audience === 3; });
    assert.deepEqual(last(), { audience: 3, projector: 1, emcee: 2, tech: 1, buzzA: 0, buzzB: 0 });

    // a second tech console is visible (the game must only be run from one)
    const tech2 = await client(s.base).ws(); hello(tech2, 'tech');
    await until(() => last().tech === 2);

    // leaving (closing the page or losing the connection) is noticed
    projector.close();
    await until(() => last().projector === 0);
    emcee1.terminate();
    await until(() => last().emcee === 1);

    // bad hellos change nothing; another game's screens are not counted here
    hello(tech1, 'admin'); hello(tech1, 'tech', 'bad code'); tech1.send(JSON.stringify({ t: 'hello', code: 'PRES1' }));
    const other = await client(s.base).ws(); hello(other, 'projector', 'OTHER1');
    await wait(500);
    assert.deepEqual(last(), { audience: 3, projector: 0, emcee: 1, tech: 2, buzzA: 0, buzzB: 0 });
    [watcher, emcee2, tech1, tech2, other, ...phones].forEach((w) => w.close());
  } finally { await s.close(); }
});

test('static files: pages served, secrets and traversal blocked, backend switch is "server"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(dir, 'play.html'), '<h1>play</h1>');
  fs.writeFileSync(path.join(dir, 'firestore.rules'), 'secret');
  fs.writeFileSync(path.join(dir, '.env'), 'GEMINI_API_KEY=secret');
  fs.writeFileSync(path.join(dir, 'backend-config.js'), 'window.BACKEND="firebase"');
  fs.writeFileSync(path.join(dir, 'theme.css'), 'body{}');
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.writeFileSync(path.join(dir, 'fonts', 'x.woff2'), 'FONT');
  fs.writeFileSync(path.join(dir, 'fonts', 'notes.txt'), 'no');
  fs.mkdirSync(path.join(dir, 'sounds'));
  fs.writeFileSync(path.join(dir, 'sounds', 'buzzer.mp3'), 'MP3DATA');
  fs.writeFileSync(path.join(dir, 'sounds', 'intro.wav'), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(dir, 'sounds', 'Bad Name.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'sounds', 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sounds', 'classic'));
  fs.writeFileSync(path.join(dir, 'sounds', 'classic', 'ding.mp3'), 'DING');
  fs.writeFileSync(path.join(dir, 'sounds', 'classic', 'README.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sounds', 'Not_A_Pack'));
  fs.mkdirSync(path.join(dir, 'sounds', 'classic', 'deep'));
  fs.writeFileSync(path.join(dir, 'sounds', 'classic', 'deep', 'x.mp3'), 'x');
  const s = await startApp({ webRoot: dir });
  try {
    const get = async (p) => fetch(s.base + p);
    assert.equal((await get('/')).status, 200);
    assert.equal(await (await get('/')).text(), '<h1>hi</h1>');
    assert.equal((await get('/play.html')).status, 200);
    assert.equal((await get('/firestore.rules')).status, 404);
    assert.equal((await get('/.env')).status, 404);
    assert.equal((await get('/..%2f..%2fetc%2fpasswd')).status, 404);
    assert.equal((await get('/%2e%2e/secret.html')).status, 404);
    assert.equal((await get('/nothing.html')).status, 404);
    assert.equal(await (await get('/backend-config.js')).text(), 'window.BACKEND="server";', 'dynamic file wins over the static one');

    const first = await get('/play.html');
    const again = await fetch(s.base + '/play.html', { headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(again.status, 304);

    const h = await (await get('/healthz')).json();
    assert.equal(h.ok, true);

    const css = await get('/theme.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const font = await get('/fonts/x.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.match(font.headers.get('cache-control'), /max-age/);
    assert.equal((await get('/fonts/notes.txt')).status, 404, 'only fonts are served from the fonts folder');
    assert.equal((await get('/fonts/../index.html')).status, 200, 'normalised by the client to /index.html');
    assert.equal((await get('/fonts/%2e%2e/secret.html')).status, 404);
    assert.equal((await get('/fonts/..%2fplay.html')).status, 404);

    // your own sound files: small ones cached, big ones streamed, only audio is served, and the projector can ask what is installed
    const mp3 = await get('/sounds/buzzer.mp3');
    assert.equal(mp3.status, 200);
    assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await mp3.text(), 'MP3DATA');
    const big = await get('/sounds/intro.wav');
    assert.equal(big.headers.get('content-type'), 'audio/wav');
    assert.equal(big.headers.get('content-length'), String(3 * 1024 * 1024));
    assert.equal((await big.arrayBuffer()).byteLength, 3 * 1024 * 1024, 'a 3 MB file arrives whole, streamed');
    assert.equal((await fetch(s.base + '/sounds/intro.wav', { method: 'HEAD' })).status, 200);
    assert.equal((await get('/sounds/notes.txt')).status, 404);
    assert.deepEqual((await (await get('/sounds/index.json')).json()).files, ['buzzer.mp3', 'intro.wav'], 'lists only well-named audio files');
    const idx = await (await get('/sounds/index.json')).json();
    assert.deepEqual(idx.packs, { classic: ['ding.mp3'] }, 'sub-folders are sound sets; only well-named audio is listed');
    const cd = await get('/sounds/classic/ding.mp3');
    assert.equal(cd.status, 200);
    assert.equal(cd.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await cd.text(), 'DING');
    assert.equal((await get('/sounds/classic/..%2fbuzzer.mp3')).status, 404);
    assert.equal((await get('/sounds/classic/deep/x.mp3')).status, 404, 'only one level of sound sets');
    assert.equal((await get('/sounds/classic/README.txt')).status, 404);
    assert.equal((await get('/sounds/..%2findex.html')).status, 404);
    assert.equal((await get('/sounds/%2e%2e%2findex.html')).status, 404);

    // odd paths must not crash the server
    assert.equal((await get('//')).status, 200, 'double slash is just the home page');
    assert.equal((await get('//play.html')).status, 200);
    assert.equal((await get('/%E0%A4%A')).status, 404, 'malformed escape');
    assert.equal((await get('/a/../../x.html')).status, 404);
    assert.equal((await get('/healthz')).status, 200, 'still alive');
  } finally { await s.close(); }
});

test('face-off: first buzz wins, late buzz loses, host can set by hand, reset hides it', async () => {
  const s = await startApp({ faceoffHoldMs: 150 });
  try {
    const tech = await login(s.app, s.base, 't', 'tech');
    const host = await login(s.app, s.base, 'h', 'host');
    const sid = s.app.store.surveys.create({ name: 'S', code: 'FOFOF' });
    await tech.rpc('liveSet', 'FOFOF', { phase: 'done', stage: 'gate' });
    const a = client(s.base), b = client(s.base);
    assert.equal((await a.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'A' })).body.won, false, 'not open yet');
    assert.equal((await host.rpc('faceoff', 'FOFOF', 'ready', null, { A: 'Lions', B: 'Tigers' })).status, 200, 'an emcee may arm the buzzers');
    const live = () => s.app.store.live.get('FOFOF').fo;
    assert.equal(live().state, 'ready');
    assert.equal(live().q, undefined, 'the question is not in the document yet');
    assert.equal((await a.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'A' })).body.won, false, 'a buzz while only READY is ignored');
    assert.equal(live().state, 'ready');
    assert.equal((await host.rpc('faceoff', 'FOFOF', 'open', null, {}, 'Name something people do at dawn')).status, 200);
    assert.equal(live().state, 'open');
    assert.equal(live().q, 'Name something people do at dawn', 'the question arrives together with the open buzzers');
    assert.deepEqual(live().names, { A: 'Lions', B: 'Tigers' });
    const [ra, rb] = await Promise.all([a.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'B' }), b.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'A' })]);
    assert.equal([ra, rb].filter((r) => r.body.won).length, 1, 'exactly one winner');
    assert.equal(live().state, 'won');
    assert.equal(live().by, 'phone');
    assert.equal((await a.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'A' })).body.won, false);
    assert.equal((await a.post('/api/faceoff/buzz', { code: 'FOFOF', team: 'C' })).status, 400, 'bad team');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(live().state, 'idle', 'the overlay clears itself');
    assert.equal((await tech.rpc('faceoff', 'FOFOF', 'set', 'B')).status, 200);
    assert.equal(live().winner, 'B'); assert.equal(live().by, 'host');
    await tech.rpc('faceoff', 'FOFOF', 'reset');
    assert.equal(live().state, 'idle');
    assert.equal((await tech.rpc('faceoff', 'FOFOF', 'nope')).status, 400);
    assert.equal((await client(s.base).rpc('faceoff', 'FOFOF', 'open')).status, 401, 'anonymous cannot open');
    assert.equal(s.app.store.live.get('FOFOF').phase, 'done', 'the rest of the live document is untouched');
    void sid;
  } finally { await s.close(); }
});
