#!/usr/bin/env node
/*
 Simulates a hall full of phones against the game server and reports whether it keeps up.

   Local (starts its own throwaway server):   node loadtest/phones.js --spawn --phones 400
   Against your VPS:                          node loadtest/phones.js --url https://game.example.org --token <login token> --phones 400
   (get a token with:  docker compose exec app node src/cli.js add-user loadtest admin   — use the part after ?login=)

 What it does: phones connect over WebSocket (ramped), the "tech" opens a question, phones answer at random moments,
 the tech polls the count like the real console, closes the question, then pushes scoreboard updates.
 It measures: connect time, how long a change takes to reach every phone, answer request time, errors.
 Exit code 1 if p95 fan-out is over --max-p95 ms (default 1000) or any phone failed.
*/
import WebSocket from 'ws';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const N = Number(args.phones || 400);
const RAMP = Number(args.ramp || 10) * 1000;
const QSECS = Number(args.qsecs || 20);
const UPDATES = Number(args.updates || 60);
const MAX_P95 = Number(args['max-p95'] || 1000);

let base = args.url, token = args.token, spawned = null;
if (args.spawn) {
  const { createApp } = await import('../src/index.js');
  spawned = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://localhost' });
  const port = await spawned.listen();
  base = `http://127.0.0.1:${port}`;
  spawned.store.users.upsert('loadtest', 'admin');
  token = spawned.auth.createLoginLink('loadtest').token;
}
if (!base || !token) { console.error('Use --spawn, or --url <https://host> --token <login token>'); process.exit(2); }
base = base.replace(/\/+$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const CODE = 'LT' + Math.random().toString(36).slice(2, 5).toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stats = (arr) => `n=${arr.length} p50=${pct(arr, 0.5)}ms p95=${pct(arr, 0.95)}ms max=${Math.max(0, ...arr)}ms`;

/* --- the tech --- */
let techCookie = '';
{
  const r = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!r.ok) { console.error('Login token rejected:', await r.text()); process.exit(2); }
  techCookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const rpc = async (m, ...a) => {
  const r = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: techCookie }, body: JSON.stringify({ m, a }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${m}: ${j.error}`);
  return j.r;
};

/* --- the phones --- */
const phones = [];
const connectMs = [], answerMs = [], failures = [];
let waiters = [];          // resolved when every phone has seen a doc matching a predicate
const fanout = { open: [], closed: [], display: [] };

class Phone {
  constructor(i) { this.i = i; this.cookie = ''; this.seen = {}; }
  connect() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const ws = this.ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        connectMs.push(Date.now() - t0);
        ws.send(JSON.stringify({ t: 'sub', ch: 'live:' + CODE }));
        ws.send(JSON.stringify({ t: 'sub', ch: 'display:' + CODE }));
        resolve(true);
      });
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.t !== 'doc' || !m.data) return;
        const lat = Date.now() - (m.data.hostNow || 0);
        if (m.ch.startsWith('live:')) {
          if (m.data.phase === 'open' && !this.seen.open) { this.seen.open = true; fanout.open.push(lat); }
          if (m.data.phase === 'closed' && !this.seen.closed) { this.seen.closed = true; fanout.closed.push(lat); }
        } else if (m.data.n === UPDATES - 1) { this.seen.lastDisplay = true; }
        else if (m.data.n != null) fanout.display.push(lat);
        waiters = waiters.filter((w) => !w(this));
      });
      ws.on('error', (e) => { failures.push(`phone ${this.i}: ${e.message}`); resolve(false); });
    });
  }
  async answer(q) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: this.cookie }, body: JSON.stringify({ code: CODE, q, a: ['Honesty', 'Kindness', 'Love', 'Service', 'Prayer', 'Humility'][this.i % 6] + (this.i % 7 === 0 ? ' ' : '') }) });
      const sc = r.headers.getSetCookie?.() || [];
      if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
      if (!r.ok) throw new Error((await r.json()).error);
      answerMs.push(Date.now() - t0);
    } catch (e) { failures.push(`phone ${this.i} answer: ${e.message}`); }
  }
}
const allSeen = (key) => new Promise((resolve) => {
  const check = () => phones.every((p) => p.seen[key]);
  if (check()) return resolve();
  waiters.push(() => { if (check()) { resolve(); return true; } return false; });
});

console.log(`Load test: ${N} phones against ${base} (code ${CODE})`);
await rpc('liveSet', CODE, { phase: 'idle', q: -1, total: 1, hostNow: Date.now() });

// 1. phones arrive over RAMP ms, like people scanning the QR
const t0 = Date.now();
for (let i = 0; i < N; i++) { const p = new Phone(i); phones.push(p); setTimeout(() => p.connect(), (i / N) * RAMP); }
while (connectMs.length + failures.length < N && Date.now() - t0 < RAMP + 30000) await sleep(100);
console.log(`1. connected   ${stats(connectMs)}  (${connectMs.length}/${N})`);

// 2. tech opens the question; every phone must see it
const closesAt = Date.now() + QSECS * 1000;
await rpc('liveUpdate', CODE, { phase: 'open', q: 0, closesAt, question: { en: 'Name a quality' }, hostNow: Date.now() });
await Promise.race([allSeen('open'), sleep(15000)]);
console.log(`2. question open reached phones   ${stats(fanout.open)}  (${fanout.open.length}/${N})`);

// 3. phones answer at random moments; the tech polls the count every 2 s like the real console
let polling = true, polls = 0, lastCount = 0;
(async () => { while (polling) { lastCount = await rpc('countAnswers', CODE, 0); polls++; await sleep(2000); } })();
await Promise.all(phones.map(async (p) => { await sleep(Math.random() * (QSECS - 3) * 1000); await p.answer(0); }));
polling = false;
const finalCount = await rpc('countAnswers', CODE, 0);
console.log(`3. answers     ${stats(answerMs)}  stored ${finalCount}/${N}  (count polled ${polls}x, last seen ${lastCount})`);

// 4. close; late answers must be refused
const tc = Date.now();
await rpc('liveUpdate', CODE, { phase: 'closed', hostNow: tc });
await Promise.race([allSeen('closed'), sleep(15000)]);
console.log(`4. question closed reached phones ${stats(fanout.closed)}  (${fanout.closed.length}/${N})`);
const lateBefore = failures.length;
await phones[0].answer(0);
const lateRefused = failures.length === lateBefore + 1;
failures.length = lateBefore; // that refusal is expected
console.log(`   late answer refused: ${lateRefused ? 'yes' : 'NO (problem)'}`);

// 5. scoreboard updates during the game (≈3 KB each) pushed to everyone
const filler = 'x'.repeat(2800);
for (let n = 0; n < UPDATES; n++) {
  await rpc('displaySet', CODE, { n, hostNow: Date.now(), pad: filler, teams: { A: { name: 'A', score: n * 5 }, B: { name: 'B', score: n * 3 } } });
  await sleep(40);
}
await sleep(1500);
console.log(`5. ${UPDATES} scoreboard updates   ${stats(fanout.display)}  (${fanout.display.length} deliveries, expected ${(UPDATES - 1) * N})`);

if (spawned) {
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`   server+test process memory: ${rss} MB, open sockets ${spawned.wss.clients.size}`);
}

// 6. everyone leaves and the server cleans up
phones.forEach((p) => p.ws && p.ws.terminate());
await sleep(300);
await rpc('liveDelete', CODE);

const p95 = Math.max(pct(fanout.open, 0.95), pct(fanout.closed, 0.95), pct(fanout.display, 0.95));
const problems = [];
if (connectMs.length < N) problems.push(`${N - connectMs.length} phones could not connect`);
if (finalCount < N) problems.push(`only ${finalCount}/${N} answers stored`);
if (fanout.open.length < N) problems.push(`only ${fanout.open.length}/${N} phones saw the question open`);
if (!lateRefused) problems.push('late answer was accepted');
if (failures.length) problems.push(`${failures.length} errors, first: ${failures[0]}`);
if (p95 > MAX_P95) problems.push(`p95 fan-out ${p95}ms is over the ${MAX_P95}ms limit`);

console.log(problems.length ? `\nFAIL\n - ${problems.join('\n - ')}` : `\nPASS — ${N} phones, worst p95 fan-out ${p95} ms`);
if (spawned) await spawned.close();
process.exit(problems.length ? 1 : 0);
