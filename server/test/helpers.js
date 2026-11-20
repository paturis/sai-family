import { createApp } from '../src/index.js';
import WebSocket from 'ws';

export async function startApp(overrides = {}) {
  const app = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://localhost', closeGraceMs: 30, answerGraceMs: 200, ...overrides });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  return { app, port, base, close: () => app.close() };
}

/** A browser-like client that keeps cookies. */
export function client(base) {
  const jar = {};
  const remember = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i), val = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c)) delete jar[name]; else jar[name] = val;
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const post = async (path, body = {}, headers = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie(), ...headers }, body: JSON.stringify(body) });
    remember(res);
    const j = await res.json().catch(() => null);
    return { status: res.status, body: j };
  };
  return {
    jar, post, cookie,
    rpc: async (m, ...a) => (await post('/api/rpc', { m, a })),
    ws: () => new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: cookie() } });
      ws.msgs = [];
      ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    }),
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await wait(10);
  }
  throw new Error('timed out waiting for condition');
}

/** Sign a person in through the real login-link flow. */
export async function login(app, base, id, role) {
  app.store.users.upsert(id, role);
  const { token } = app.auth.createLoginLink(id);
  const c = client(base);
  const r = await c.post('/api/auth/redeem', { token });
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r));
  return c;
}
