import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startApp, login, until, wait } from './helpers.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server-client.js'), 'utf8');

/** Run the REAL browser file (server-client.js) in a fake browser, against the real server. */
function browser(base, search = '') {
  const u = new URL(base);
  const jar = {};
  const listeners = {};
  const window = { addEventListener: (e, f) => ((listeners[e] ||= []).push(f)) };
  const sandbox = {
    window,
    document: { hidden: false, addEventListener: (e, f) => ((listeners[e] ||= []).push(f)) },
    location: { protocol: 'http:', host: u.host, pathname: '/', search, hash: '' },
    history: { replaceState: (a, b, url) => { sandbox.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } },
    URLSearchParams,
    WebSocket: class extends WebSocket {
      constructor(url) { super(url); sandbox.sockets.push(this); }
    },
    fetch: async (url, opts = {}) => {
      const res = await fetch(base + url, { ...opts, headers: { ...opts.headers, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        if (/Max-Age=0/i.test(c)) delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      return res;
    },
    setTimeout, clearTimeout, setInterval, clearInterval, console, Math, JSON, Object, Array, Promise, Error, String, encodeURIComponent, decodeURIComponent,
    sockets: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { C: window.SrvClient, sandbox, jar, listeners };
}

test('client: login link in the URL signs in and is removed from the address bar', async () => {
  const s = await startApp();
  try {
    s.app.store.users.upsert('ritesh', 'admin');
    const { token } = s.app.auth.createLoginLink('ritesh');
    const b = browser(s.base, '?login=' + token + '&x=1');
    const user = await new Promise((r) => b.C.authInit(r));
    assert.deepEqual({ email: user.email, role: user.role }, { email: 'ritesh', role: 'admin' });
    assert.equal(b.sandbox.location.search, '?x=1', 'token removed from the URL, other params kept');
    assert.equal(await b.C.rpc('listTeam').then((t) => t.length), 1);

    // a second visit with the same (used) link shows a clear error, not a crash
    const b2 = browser(s.base, '?login=' + token);
    const user2 = await new Promise((r) => b2.C.authInit(r));
    assert.equal(user2, null);
    assert.match(b2.C.authError(), /invalid, already used, or expired/);

    // pasting a whole link or just the token both work
    const fresh = s.app.auth.createLoginLink('ritesh');
    const b3 = browser(s.base);
    await new Promise((r) => b3.C.authInit(r));
    await b3.C.signIn(fresh.url);
    assert.equal(b3.C.me().id, 'ritesh');
    assert.equal(b3.C.parseLogin('nonsense'), '');
    [b, b2, b3].forEach((x) => x.C.close());
  } finally { await s.close(); }
});

test('client: session ending mid-use sends the app back to sign-in instead of failing silently', async () => {
  const s = await startApp();
  try {
    const admin = await login(s.app, s.base, 'boss', 'admin');
    const link = (await admin.rpc('saveTeam', 'tech1', 'tech'), (await admin.rpc('loginLink', 'tech1')).body.r);
    const b = browser(s.base);
    const seen = [];
    await b.C.authInit((u) => seen.push(u && u.email));
    await b.C.signIn(link);
    assert.deepEqual(seen, [null, 'tech1']);
    await admin.rpc('deleteTeam', 'tech1');                 // admin removes the person
    await assert.rejects(() => b.C.rpc('listSurveys'), (e) => e.status === 401);
    assert.equal(seen.at(-1), null, 'app was told to show the sign-in screen');
    assert.match(b.C.authError(), /session ended/);
    b.C.close();
  } finally { await s.close(); }
});

test('client: subscribe, drop the connection, reconnect + resubscribe automatically, status reported', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    const b = browser(s.base);
    const statuses = [];
    b.C.onStatus((st) => statuses.push(st));
    const got = [];
    b.C.subscribe('live:RECON', (d) => got.push(d));
    await until(() => got.length === 1);            // current value (null: not created yet)
    assert.equal(got[0], null);
    assert.equal(b.C.status(), 'online');

    await tech.rpc('liveSet', 'RECON', { phase: 'open', q: 0 });
    await until(() => got.length === 2);
    assert.equal(got[1].phase, 'open');

    // the server drops every socket (restart, wifi blip, proxy timeout)
    for (const ws of s.app.wss.clients) ws.terminate();
    await until(() => statuses.includes('offline'));
    await tech.rpc('liveUpdate', 'RECON', { phase: 'closed' });     // changes while the phone was away
    // client reconnects by itself and receives the CURRENT state without any user action
    await until(() => got.at(-1) && got.at(-1).phase === 'closed', 8000);
    assert.equal(b.C.status(), 'online');
    assert.ok(statuses.includes('offline') && statuses.at(-1) === 'online');

    // unsubscribing stops delivery
    const n = got.length;
    const second = [];
    const off = b.C.subscribe('live:RECON', (d) => second.push(d));
    await until(() => second.length >= 1);
    off();
    await tech.rpc('liveUpdate', 'RECON', { phase: 'open' });
    await until(() => got.length > n);
    assert.equal(second.length, 1, 'unsubscribed callback heard nothing more');
    b.C.close();
  } finally { await s.close(); }
});

test('client: network failure marks the connection degraded and recovers', async () => {
  const s = await startApp();
  const b = browser(s.base);
  const statuses = [];
  b.C.onStatus((st) => statuses.push(st));
  b.C.connect();
  await until(() => b.C.status() === 'online');
  await s.close();                                       // server goes away completely
  await assert.rejects(() => b.C.post('/api/auth/me'), (e) => e.code === 'network');
  assert.ok(statuses.includes('offline') || statuses.includes('degraded'));
  b.C.close();
});
