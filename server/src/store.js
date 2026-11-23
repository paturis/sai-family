import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const newId = () => crypto.randomBytes(9).toString('base64url');
const J = (v) => JSON.stringify(v);
const P = (s) => (s == null ? null : JSON.parse(s));
const plain = (row) => (row ? { ...row } : null);

const CODE_RE = /^[A-Z0-9]{3,12}$/;
export const okCode = (c) => typeof c === 'string' && CODE_RE.test(c);

/**
 * All data access. Everything the old Firestore security rules enforced lives here:
 *  - phones can answer only while the question is open, only for the current question,
 *    one answer per phone per question, 1-80 characters;
 *  - buzz order uses the SERVER clock, first buzz wins (a phone cannot forge a time);
 *  - questions close by themselves on the server when the countdown ends.
 */
export function createStore({ db, hub, closeGraceMs = 500, answerGraceMs = 1500, faceoffHoldMs = 8000, now = () => Date.now(), onEvent = null }) {
  const cache = new Map();
  const S = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  };
  const pub = (ch, data) => hub && hub.publish(ch, data);
  const timers = new Map();
  let seq = 0;

  /* ---------- users ---------- */
  const users = {
    list: () => S('SELECT id,name,role,disabled,created_at FROM users ORDER BY id').all().map(plain),
    get: (id) => plain(S('SELECT id,name,role,disabled,created_at FROM users WHERE id=?').get(id)),
    upsert: (id, role, name) => {
      S(`INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET role=excluded.role, disabled=0`).run(id, name || id, role, now());
    },
    remove: (id) => tx(() => {
      S('DELETE FROM sessions WHERE user_id=?').run(id);
      S('DELETE FROM login_tokens WHERE user_id=?').run(id);
      S('DELETE FROM users WHERE id=?').run(id);
    }),
  };

  /* ---------- question bank ---------- */
  const questions = {
    list: () => S('SELECT id,json FROM questions').all().map((r) => ({ ...P(r.json), id: r.id })),
    save: (doc) => {
      const q = { ...doc };
      let id = q.id;
      delete q.id;
      q.updatedAt = now();
      if (!id) {
        id = newId();
        q.createdAt = q.createdAt || now();
      }
      S(`INSERT INTO questions(id,json,created_at) VALUES(?,?,?)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(id, J(q), q.createdAt || now());
      return id;
    },
    remove: (id) => { S('DELETE FROM questions WHERE id=?').run(id); },
    seed: (arr) => tx(() => {
      for (const q0 of arr) {
        const q = { ...q0, createdAt: now(), updatedAt: now() };
        delete q.id;
        S('INSERT INTO questions(id,json,created_at) VALUES(?,?,?)').run(newId(), J(q), q.createdAt);
      }
    }),
  };

  /* ---------- live (what phones see) ---------- */
  const schedule = (code) => {
    clearTimeout(timers.get(code));
    timers.delete(code);
    const d = live.get(code);
    // Buzzer windows are closed by the tech console (it decides the winner), everything else closes itself.
    if (!d || d.phase !== 'open' || !(d.closesAt > 0) || d.mode === 'buzzer') return;
    const ms = Math.min(2 ** 31 - 1, Math.max(0, d.closesAt + closeGraceMs - now()));
    const t = setTimeout(() => {
      timers.delete(code);
      const c = live.get(code);
      if (c && c.phase === 'open' && c.q === d.q && c.closesAt <= now()) live.update(code, { phase: 'closed', hostNow: now() });
    }, ms);
    t.unref?.();
    timers.set(code, t);
  };

  const live = {
    get: (code) => P((S('SELECT json FROM live WHERE code=?').get(code) || {}).json),
    free: (code) => !S('SELECT 1 AS x FROM live WHERE code=?').get(code),
    set: (code, o) => {
      S(`INSERT INTO live(code,json,updated_at) VALUES(?,?,?)
         ON CONFLICT(code) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`).run(code, J(o), now());
      pub('live:' + code, o);
      if (onEvent) onEvent('live', code);
      schedule(code);
    },
    update: (code, patch) => {
      const cur = live.get(code);
      if (!cur) throw new HttpError(404, 'not_found', 'Unknown code');
      live.set(code, { ...cur, ...patch });
    },
    remove: (code) => {
      clearTimeout(timers.get(code));
      timers.delete(code);
      tx(() => {
        S('DELETE FROM answers WHERE code=?').run(code);
        S('DELETE FROM display WHERE code=?').run(code);
        S('DELETE FROM live WHERE code=?').run(code);
      });
      pub('live:' + code, null);
      pub('display:' + code, null);
      if (onEvent) onEvent('live', code);
    },
  };

  /* ---------- display (projector) ---------- */
  const display = {
    get: (code) => P((S('SELECT json FROM display WHERE code=?').get(code) || {}).json),
    set: (code, o) => {
      S(`INSERT INTO display(code,json,updated_at) VALUES(?,?,?)
         ON CONFLICT(code) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`).run(code, J(o), now());
      pub('display:' + code, o);
    },
  };

  /* ---------- surveys and their data blobs ---------- */
  const surveys = {
    list: () => S('SELECT id,json FROM surveys').all().map((r) => ({ ...P(r.json), id: r.id })),
    get: (id) => {
      const r = S('SELECT id,json FROM surveys WHERE id=?').get(id);
      return r ? { ...P(r.json), id: r.id } : null;
    },
    create: (o) => {
      const id = newId();
      const d = { ...o, createdAt: now() };
      delete d.id;
      S('INSERT INTO surveys(id,json,created_at) VALUES(?,?,?)').run(id, J(d), d.createdAt);
      return id;
    },
    update: (id, patch) => {
      const r = S('SELECT json FROM surveys WHERE id=?').get(id);
      if (!r) throw new HttpError(404, 'not_found', 'Unknown survey');
      const d = { ...P(r.json), ...patch };
      delete d.id;
      S('UPDATE surveys SET json=? WHERE id=?').run(J(d), id);
    },
    remove: (id) => {
      const s = surveys.get(id);
      tx(() => {
        S('DELETE FROM survey_data WHERE survey_id=?').run(id);
        S('DELETE FROM surveys WHERE id=?').run(id);
      });
      if (s && s.code && okCode(s.code)) live.remove(s.code);
    },
  };

  const data = {
    get: (id, name) => P((S('SELECT json FROM survey_data WHERE survey_id=? AND name=?').get(id, name) || {}).json),
    set: (id, name, o) => {
      S(`INSERT INTO survey_data(survey_id,name,json,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(survey_id,name) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`).run(id, name, J(o), now());
      if (name === 'game') pub('game:' + id, o);
    },
  };

  /* ---------- answers and buzzes ---------- */
  const answers = {
    submit: ({ code, uid, q, a, buzz = false }) => {
      const d = live.get(code);
      if (!d) throw new HttpError(404, 'not_found', 'That code was not found');
      const closed = () => new HttpError(409, 'closed', 'This question is closed');
      if (d.phase !== 'open' || !Number.isInteger(q) || q !== d.q) throw closed();
      if (d.closesAt > 0 && now() > d.closesAt + answerGraceMs) throw closed();
      if (Boolean(buzz) !== (d.mode === 'buzzer')) throw closed();
      const text = String(a == null ? '' : a).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!text || text.length > 80) throw new HttpError(400, 'bad_answer', 'Answer must be 1 to 80 characters');
      const t = now() * 1000 + (seq++ % 1000);
      if (buzz) {
        S('INSERT OR IGNORE INTO answers(code,uid,q,a,t) VALUES(?,?,?,?,?)').run(code, uid, q, text, t);
      } else {
        S(`INSERT INTO answers(code,uid,q,a,t) VALUES(?,?,?,?,?)
           ON CONFLICT(code,uid,q) DO UPDATE SET a=excluded.a, t=excluded.t`).run(code, uid, q, text, t);
      }
      if (onEvent) onEvent('answer', code);
    },
    count: (code, q) => S('SELECT count(*) AS n FROM answers WHERE code=? AND q=?').get(code, q).n,
    buzzes: (code, q) => S('SELECT uid,a,t FROM answers WHERE code=? AND q=? ORDER BY t').all(code, q).map(plain),
    all: (code) => {
      const out = {};
      for (const r of S('SELECT q,a FROM answers WHERE code=? ORDER BY q,t').all(code)) (out[r.q] = out[r.q] || []).push(r.a);
      return out;
    },
  };

  /* ---------- face-off buzzers: who answers first for control of the board ----------
     State lives in the live document (live.fo) so every screen sees it. The first valid buzz wins because the
     server handles buzzes one at a time; a phone can only flip "open" to "won", nothing else. */
  const foTimers = new Map();
  const cleanNames = (names) => { const n = (x) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40); return { A: n(names && names.A) || 'Team A', B: n(names && names.B) || 'Team B' }; };
  const foSet = (code, fo) => live.update(code, { fo });
  const foOf = (code) => { const d = live.get(code); if (!d) throw new HttpError(404, 'not_found', 'Unknown code'); return d.fo || { id: '', state: 'idle' }; };
  const teamOk = (t) => { if (t !== 'A' && t !== 'B') throw new HttpError(400, 'bad_request', 'Team must be A or B'); return t; };
  const foHide = (code, id) => {
    clearTimeout(foTimers.get(code));
    const t = setTimeout(() => {
      foTimers.delete(code);
      const d = live.get(code);
      if (d && d.fo && d.fo.id === id && d.fo.state === 'won') foSet(code, { ...d.fo, state: 'idle' });
    }, faceoffHoldMs);
    t.unref?.();
    foTimers.set(code, t);
  };
  const faceoff = {
    /** Step 1: arm. Pads and projector show "get ready"; the question stays hidden; buzzes are ignored. */
    ready: (code, names) => {
      foOf(code);
      clearTimeout(foTimers.get(code));
      foSet(code, { id: crypto.randomBytes(5).toString('hex'), state: 'ready', names: cleanNames(names), at: now() });
    },
    /** Step 2: buzzers go live and the question appears (projector + emcee) in the same instant, so reading it never races the buzzers. */
    open: (code, names, question) => {
      const f = foOf(code);
      clearTimeout(foTimers.get(code));
      const q = String(question == null ? '' : question).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
      foSet(code, { id: f.state === 'ready' ? f.id : crypto.randomBytes(5).toString('hex'), state: 'open', names: f.state === 'ready' && f.names ? f.names : cleanNames(names), q, at: now() });
    },
    /** A phone buzzes. Returns whether it won. */
    buzz: (code, team) => {
      teamOk(team);
      const f = foOf(code);
      if (f.state !== 'open') return { won: false, winner: f.winner || null };
      foSet(code, { ...f, state: 'won', winner: team, by: 'phone', wonAt: now() });
      foHide(code, f.id);
      return { won: true, winner: team };
    },
    /** The fallback: the tech or emcee saw who was first and says so (works even if no buzzers were opened). */
    set: (code, team, names) => {
      teamOk(team);
      const f = foOf(code);
      const id = crypto.randomBytes(5).toString('hex');
      foSet(code, { id, state: 'won', winner: team, by: 'host', wonAt: now(), names: f.names || (names && { A: String(names.A || 'Team A').slice(0, 40), B: String(names.B || 'Team B').slice(0, 40) }) || { A: 'Team A', B: 'Team B' } });
      foHide(code, id);
    },
    reset: (code) => { const f = foOf(code); clearTimeout(foTimers.get(code)); foSet(code, { ...f, state: 'idle' }); },
  };

  return {
    users, questions, surveys, data, live, display, answers, faceoff, tx,
    /** After a restart: close questions whose time ran out, re-arm the rest. */
    rescheduleAll: () => { for (const r of S('SELECT code FROM live').all()) schedule(r.code); },
    close: () => { for (const t of [...timers.values(), ...foTimers.values()]) clearTimeout(t); timers.clear(); foTimers.clear(); },
  };
}
