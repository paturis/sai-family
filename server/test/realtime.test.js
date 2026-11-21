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
    assert.deepEqual(docs(screen, 'stats:STAT1')[0].data, { q: 2, count: 0, devices: 0 });

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

    // odd paths must not crash the server
    assert.equal((await get('//')).status, 200, 'double slash is just the home page');
    assert.equal((await get('//play.html')).status, 200);
    assert.equal((await get('/%E0%A4%A')).status, 404, 'malformed escape');
    assert.equal((await get('/a/../../x.html')).status, 404);
    assert.equal((await get('/healthz')).status, 200, 'still alive');
  } finally { await s.close(); }
});
