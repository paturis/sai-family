import crypto from 'node:crypto';
import { HttpError } from './store.js';

const DAY = 24 * 3600 * 1000;
export const SESSION_TTL = 30 * DAY;
export const LOGIN_LINK_TTL = 7 * DAY;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAgeSec, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/** Personal login links (no OAuth), 30-day sessions, and anonymous audience device ids. */
export function createAuth({ db, config, secret, now = () => Date.now() }) {
  const hmac = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  function createSession(userId) {
    const sid = rand(32);
    const t = now();
    run('INSERT INTO sessions(hash,user_id,created_at,expires_at,last_seen) VALUES(?,?,?,?,?)', sha256(sid), userId, t, t + SESSION_TTL, t);
    return sid;
  }

  /** The signed-in staff member for a request, or null. Sessions slide: active people stay signed in. */
  function sessionUser(req) {
    const sid = parseCookies(req).sid;
    if (!sid) return null;
    const h = sha256(sid);
    const s = get('SELECT user_id,expires_at,last_seen FROM sessions WHERE hash=?', h);
    if (!s || s.expires_at < now()) return null;
    const u = get('SELECT id,name,role,disabled FROM users WHERE id=?', s.user_id);
    if (!u || u.disabled) return null;
    if (now() - s.last_seen > 3600 * 1000) run('UPDATE sessions SET last_seen=?, expires_at=? WHERE hash=?', now(), now() + SESSION_TTL, h);
    return { id: u.id, name: u.name || u.id, role: u.role };
  }

  function createLoginLink(userId, ttlMs = LOGIN_LINK_TTL) {
    const u = get('SELECT id FROM users WHERE id=?', userId);
    if (!u) throw new HttpError(404, 'no_user', 'No such person');
    const token = rand(32);
    run('INSERT INTO login_tokens(hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(token), userId, now(), now() + ttlMs);
    return { token, url: `${config.publicUrl}/?login=${token}`, expiresAt: now() + ttlMs };
  }

  /** Exchange a one-time login token for a session. Each link works once. */
  function redeem(token) {
    const bad = () => new HttpError(401, 'invalid_link', 'This login link is invalid, already used, or expired. Ask an admin for a new one.');
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw bad();
    const h = sha256(token);
    const row = get('SELECT user_id,expires_at,used_at FROM login_tokens WHERE hash=?', h);
    if (!row || row.used_at || row.expires_at < now()) throw bad();
    const u = get('SELECT id,name,role,disabled FROM users WHERE id=?', row.user_id);
    if (!u || u.disabled) throw bad();
    const claimed = run('UPDATE login_tokens SET used_at=? WHERE hash=? AND used_at IS NULL', now(), h);
    if (!claimed.changes) throw bad();
    return { sid: createSession(u.id), user: { id: u.id, name: u.name || u.id, role: u.role } };
  }

  function logout(req) {
    const sid = parseCookies(req).sid;
    if (sid) run('DELETE FROM sessions WHERE hash=?', sha256(sid));
  }

  /** Anonymous audience identity: a signed random id in a cookie. Returns {uid, setCookie?}. */
  function audience(req) {
    const c = parseCookies(req).uid;
    if (c) {
      const [id, sig] = c.split('.');
      if (id && sig) {
        const a = Buffer.from(sig);
        const b = Buffer.from(hmac(id));
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { uid: id };
      }
    }
    const id = rand(12);
    return {
      uid: id,
      setCookie: cookieHeader('uid', `${id}.${hmac(id)}`, { maxAgeSec: 7 * 86400, secure: config.secureCookies }),
    };
  }

  return { createSession, sessionUser, createLoginLink, redeem, logout, audience };
}

/** Tiny fixed-window rate limiter. */
export function createLimiter(now = () => Date.now()) {
  const hits = new Map();
  setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, 60_000).unref?.();
  return function allow(key, max, windowMs) {
    const t = now();
    let v = hits.get(key);
    if (!v || v.reset < t) hits.set(key, (v = { n: 0, reset: t + windowMs }));
    return ++v.n <= max;
  };
}
