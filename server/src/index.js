import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { createStore, HttpError, okCode } from './store.js';
import { createAuth, createLimiter, cookieHeader, SESSION_TTL } from './auth.js';
import { createAI } from './ai.js';
import { createRpc } from './rpc.js';
import { createMailer } from './mail.js';

/** Path of a request, safe for odd inputs like "//" (which new URL(req.url, base) would treat as a host). */
const pathOf = (req) => new URL('http://x' + (String(req.url).startsWith('/') ? req.url : '/' + req.url)).pathname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
// Only these file names are served from the web folder (no dotfiles, no rules/config of other stacks).
// Pages of the tech console have real addresses (/sessions, /questions, /live/ID/lobby, …). Any of them, opened directly or
// reloaded, is the same single app: serve index.html (with <base href="/"> so its css, scripts and fonts still load).
const APP_ROUTE = /^\/(?:sessions|questions|team|games|live)(?:\/(?!\.+(?:\/|$))[A-Za-z0-9_.-]+)*\/?$/;
const STATIC_OK = /^(?:(?:fonts|sounds)\/|sounds\/[a-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(html|js|css|png|svg|ico|woff2|mp3|ogg|wav|m4a)$/;
const SOUND_FILE = /^[a-z0-9_-]+\.(mp3|ogg|wav|m4a)$/;
const BIG_FILE = 2 * 1024 * 1024; // larger files (music) are streamed, not kept in memory
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function loadSecret(config) {
  if (config.sessionSecret) return config.sessionSecret;
  if (config.dataDir === ':memory:') return crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const f = path.join(config.dataDir, 'secret.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export async function createApp(overrides = {}) {
  const config = loadConfig(process.env, overrides);
  const db = overrides.db || openDb(config.dataDir);
  const secret = loadSecret(config);
  const hub = new Hub();
  /* Live numbers for the projector, the emcee and the tech: answers so far for the open question and how many devices are
     connected. Recomputed at most 4 times a second, and only while someone is watching. */
  const statsTimers = new Map();
  const statsFor = (code) => {
    const l = store.live.get(code);
    const q = l && Number.isInteger(l.q) ? l.q : -1;
    const devices = hub.count('live:' + code, { audienceOnly: true });
    // who is connected right now, by role. Screens announce themselves with a "hello"; phones are counted by what they watch.
    const presence = { audience: devices, projector: 0, emcee: 0, tech: 0, buzzA: 0, buzzB: 0 };
    for (const ws of wss.clients) if (ws.readyState === 1 && ws.presence && ws.presence.code === code) presence[ws.presence.role]++;
    return { q, count: q >= 0 ? store.answers.count(code, q) : 0, devices, presence };
  };
  const statsSoon = (code) => {
    if (statsTimers.has(code) || !hub.count('stats:' + code)) return;
    const t = setTimeout(() => {
      statsTimers.delete(code);
      if (hub.count('stats:' + code)) hub.publish('stats:' + code, statsFor(code));
    }, 250);
    t.unref?.();
    statsTimers.set(code, t);
  };
  const store = createStore({ db, hub, closeGraceMs: config.closeGraceMs, answerGraceMs: config.answerGraceMs, faceoffHoldMs: overrides.faceoffHoldMs, onEvent: (kind, code) => statsSoon(code) });
  hub.onChange = (ch) => { if (ch.startsWith('live:')) statsSoon(ch.slice(5)); };
  const auth = createAuth({ db, config, secret });
  const ai = createAI({ config, store, db, fetchImpl: overrides.fetchImpl });
  const mailer = createMailer({ config, transportFactory: overrides.mailTransport });
  const rpc = createRpc({ store, auth, ai, mailer, config });
  const limiter = createLimiter();
  const publicHost = new URL(config.publicUrl).host;

  for (const id of config.adminIds) {
    if (!store.users.get(id)) store.users.upsert(id, 'admin');
  }
  store.rescheduleAll();

  /* ---------- helpers ---------- */
  const clientIp = (req) => {
    if (config.trustProxy) {
      const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (x) return x;
    }
    return req.socket.remoteAddress || '?';
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try {
      const h = new URL(o).host;
      return h === req.headers.host || h === publicHost;
    } catch { return false; }
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(body);
  };
  const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) { reject(new HttpError(413, 'too_large', 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'bad_json', 'Bad JSON')); }
    });
    req.on('error', reject);
  });
  const sessionCookie = (sid) => cookieHeader('sid', sid, { maxAgeSec: Math.floor(SESSION_TTL / 1000), secure: config.secureCookies });

  /* ---------- API ---------- */
  async function api(req, res, p) {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
    if (!originOk(req)) throw new HttpError(403, 'bad_origin', 'Cross-site request blocked');
    const body = await readBody(req);

    switch (p) {
      case '/api/rpc': {
        const r = await rpc.call(auth.sessionUser(req), body.m, body.a);
        return json(res, 200, { r: r === undefined ? null : r });
      }
      case '/api/auth/me':
        return json(res, 200, { user: auth.sessionUser(req), mailEnabled: mailer.enabled });
      case '/api/auth/request-link': {
        // Always answers the same way, so it cannot be used to find out who has an account.
        if (!mailer.enabled) throw new HttpError(503, 'mail_not_configured', 'Email sign-in is not set up. Use the login link an admin gave you.');
        const email = String(body.email || '').trim().toLowerCase();
        if (!limiter(`mailip:${clientIp(req)}`, 30, 15 * 60_000)) throw new HttpError(429, 'rate_limited', 'Too many requests, try again in a few minutes');
        const same = () => json(res, 200, { ok: true });
        if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return same();
        if (!limiter(`mail:${email}`, 3, 15 * 60_000)) return same();
        const u = store.users.get(email);
        if (u && !u.disabled) {
          const { url } = auth.createLoginLink(email, config.emailLinkTtlMs);
          mailer.sendLoginLink({ to: email, url, minutes: Math.round(config.emailLinkTtlMs / 60_000) })
            .catch((e) => console.error(`[mail] could not send sign-in email: ${e.message}`));
        }
        return same();
      }
      case '/api/auth/redeem': {
        if (!limiter(`redeem:${clientIp(req)}`, 20, 60_000)) throw new HttpError(429, 'rate_limited', 'Too many attempts, wait a minute');
        const { sid, user } = auth.redeem(body.token);
        return json(res, 200, { user }, { 'Set-Cookie': sessionCookie(sid) });
      }
      case '/api/auth/logout':
        auth.logout(req);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('sid', '', { maxAgeSec: 0, secure: config.secureCookies }) });
      case '/api/join': {
        const { setCookie } = auth.audience(req);
        return json(res, 200, { ok: true }, setCookie ? { 'Set-Cookie': setCookie } : {});
      }
      case '/api/answer':
      case '/api/buzz': {
        const { uid, setCookie } = auth.audience(req);
        if (!limiter(`ans:${uid}`, 60, 60_000)) throw new HttpError(429, 'rate_limited', 'Slow down');
        if (!okCode(body.code)) throw new HttpError(400, 'bad_request', 'Bad code');
        store.answers.submit({ code: body.code, uid, q: body.q, a: body.a, buzz: p === '/api/buzz' });
        return json(res, 200, { ok: true }, setCookie ? { 'Set-Cookie': setCookie } : {});
      }
      case '/api/faceoff/buzz': {
        const { uid, setCookie } = auth.audience(req);
        if (!limiter(`fo:${uid}`, 40, 60_000)) throw new HttpError(429, 'rate_limited', 'Slow down');
        if (!okCode(body.code)) throw new HttpError(400, 'bad_request', 'Bad code');
        const r = store.faceoff.buzz(body.code, body.team);
        return json(res, 200, { ok: true, ...r }, setCookie ? { 'Set-Cookie': setCookie } : {});
      }
      default:
        throw new HttpError(404, 'not_found', 'Unknown endpoint');
    }
  }

  /* ---------- static files ---------- */
  const fileCache = new Map();
  function serveStatic(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'GET only');
    let name;
    try { name = decodeURIComponent(p).replace(/^\/+/, ''); } catch { throw new HttpError(404, 'not_found', 'Not found'); }
    if (name === '') name = 'index.html';
    const appRoute = APP_ROUTE.test('/' + name);
    if (appRoute) name = 'index.html';
    if (!STATIC_OK.test(name)) throw new HttpError(404, 'not_found', 'Not found');
    const file = path.join(config.webRoot, name);
    let st;
    try { st = fs.statSync(file); } catch { throw new HttpError(404, 'not_found', 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'not_found', 'Not found');
    const type = MIME[path.extname(name)] || 'application/octet-stream';
    if (st.size > BIG_FILE) {
      const h = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS };
      res.writeHead(200, h);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    let c = fileCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const buf = fs.readFileSync(file);
      c = { mtime: st.mtimeMs, buf, etag: `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}"` };
      fileCache.set(file, c);
    }
    if (appRoute) {
      const html = c.buf.toString('utf8').replace(/<head>/i, '<head><base href="/">');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS, 'Content-Length': Buffer.byteLength(html) });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    const headers = { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': name.endsWith('.woff2') ? 'public, max-age=604800' : name.startsWith('sounds/') ? 'public, max-age=3600' : 'no-cache', ETag: c.etag, ...SECURITY_HEADERS };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': c.buf.length });
    res.end(req.method === 'HEAD' ? undefined : c.buf);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const p = pathOf(req);
      if (p === '/healthz') {
        db.prepare('SELECT 1').get();
        return json(res, 200, { ok: true, uptime: Math.floor(process.uptime()), sockets: wss.clients.size });
      }
      if (p.startsWith('/api/')) return await api(req, res, p);
      if (p === '/sounds/index.json') { // which of your own sound files are installed (the projector asks once)
        const files = [], packs = {}; // files: your replacements for the built-in sounds; packs: whole alternative sets (sub-folders)
        try {
          const dir = path.join(config.webRoot, 'sounds');
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile() && SOUND_FILE.test(e.name)) files.push(e.name);
            else if (e.isDirectory() && /^[a-z0-9_-]+$/.test(e.name)) packs[e.name] = fs.readdirSync(path.join(dir, e.name)).filter((f) => SOUND_FILE.test(f)).sort();
          }
        } catch { /* no sounds folder */ }
        return json(res, 200, { files: files.sort(), packs });
      }
      if (p === '/backend-config.js') return send(res, 200, 'window.BACKEND="server";', { 'Content-Type': MIME['.js'] });
      return serveStatic(req, res, p);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('[error]', req.method, req.url, e);
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: e instanceof HttpError ? e.message : 'Server error', code: e.code || 'server_error' });
    }
  });

  /* ---------- realtime ---------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const docFor = (ch) => {
    const [kind, id] = ch.split(':');
    if (kind === 'live') return store.live.get(id);
    if (kind === 'stats') return statsFor(id);
    if (kind === 'display') return store.display.get(id);
    if (kind === 'game') return store.data.get(id, 'game');
    return null;
  };
  /** live/display are public by code (like before); the full game state is for signed-in staff and the emcee only. */
  const channelAllowed = (ws, ch) => {
    if (typeof ch !== 'string' || ch.length > 60) return false;
    const i = ch.indexOf(':');
    const kind = ch.slice(0, i), id = ch.slice(i + 1);
    if (kind === 'live' || kind === 'display' || kind === 'stats') return okCode(id);
    if (kind === 'game') return !!ws.user && /^[A-Za-z0-9_-]{4,40}$/.test(id);
    return false;
  };

  server.on('upgrade', (req, socket, head) => {
    if (pathOf(req) !== '/ws') return socket.destroy();
    if (!originOk(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    if (wss.clients.size >= config.maxSockets) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = auth.sessionUser(req);
      ws.alive = true;
      ws.msgs = 0;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { hub.dropAll(ws); if (ws.presence) statsSoon(ws.presence.code); });
    ws.on('message', (raw) => {
      ws.alive = true;
      if (++ws.msgs > 60) return ws.close(1008, 'too many messages');
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'ping') return ws.send('{"t":"pong"}');
      if (m.t === 'hello') { // "I am the projector / an emcee / a tech console, watching this game"
        if (okCode(m.code) && ['projector', 'emcee', 'tech', 'buzzA', 'buzzB'].includes(m.role)) { ws.presence = { code: m.code, role: m.role }; statsSoon(m.code); }
        return;
      }
      if (m.t === 'sub') {
        if (!channelAllowed(ws, m.ch)) return ws.send(JSON.stringify({ t: 'err', ch: m.ch, code: 'forbidden' }));
        if (ws.chs && ws.chs.size >= 8 && !ws.chs.has(m.ch)) return;
        if (m.screen === true) ws.screen = true; // projector / emcee / tech: not counted as audience phones
        hub.subscribe(ws, m.ch);
        return ws.send(JSON.stringify({ t: 'doc', ch: m.ch, data: docFor(m.ch) ?? null }));
      }
      if (m.t === 'unsub' && typeof m.ch === 'string') hub.unsubscribe(ws, m.ch);
    });
  });

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 25_000);
  const reset = setInterval(() => { for (const ws of wss.clients) ws.msgs = 0; }, 10_000);

  return {
    config, db, store, auth, ai, mailer, hub, server, wss, rpc,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address().port))),
    close: async () => {
      clearInterval(beat); clearInterval(reset);
      for (const t of statsTimers.values()) clearTimeout(t);
      store.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

/* ---------- run as a program ---------- */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = await app.listen();
  const key = app.config.geminiKey ? `AI: ${app.config.geminiModel}` : 'AI: GEMINI_API_KEY not set';
  console.log(`[server] listening on :${port}  public ${app.config.publicUrl}  web ${app.config.webRoot}  ${key}`);
  if (app.mailer.enabled) {
    app.mailer.health(true).then((h) => console.log(`[mail] SMTP ${h.host}: ${h.ok ? `ready (from ${h.from})` : `FAILED — ${h.error}`}`));
  } else console.log('[mail] SMTP not configured: sign-in by emailed link is off (login links from the CLI still work)');
  if (app.config.geminiKey) {
    app.ai.health(true).then((h) => console.log(`[ai] self-test: ${h.ok ? `ready (${h.model}, ${h.ms} ms)` : `FAILED — ${h.error}`}`));
  }
  const stop = async (sig) => { console.log(`[server] ${sig}, shutting down`); await app.close(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
