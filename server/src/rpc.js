import { HttpError, okCode } from './store.js';

const ADMIN = ['admin'];
const STAFF = ['admin', 'tech'];
const ANY = ['admin', 'tech', 'host'];

const bad = (msg = 'Invalid argument') => new HttpError(400, 'bad_request', msg);
const str = (v, max = 200) => {
  if (typeof v !== 'string' || !v || v.length > max) throw bad();
  return v;
};
const obj = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  return v;
};
const code = (v) => {
  if (!okCode(v)) throw bad('Invalid code');
  return v;
};
const int = (v) => {
  if (!Number.isInteger(v)) throw bad();
  return v;
};
const personId = (v) => {
  const id = str(v, 100).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9@._+\- ]{0,98}$/.test(id)) throw bad('Use letters, numbers, spaces or an email address');
  return id;
};

/**
 * One method per old `Cloud` operation. The role lists replace the Firestore security rules:
 *   admin = everything, tech = runs the show (no bank edits, no creating/deleting surveys), host = read-only emcee.
 */
export function createRpc({ store, auth, ai, mailer, config }) {
  const M = {
    /* team */
    listTeam: [ADMIN, () => store.users.list().map((u) => ({ email: u.id, name: u.name, role: u.role }))],
    saveTeam: [ADMIN, (user, email, role) => {
      const id = personId(email);
      if (!ANY.includes(role)) throw bad('Unknown role');
      if (id === user.id && role !== 'admin') throw new HttpError(403, 'forbidden', 'You cannot change your own role');
      store.users.upsert(id, role);
      return true;
    }],
    deleteTeam: [ADMIN, (user, email) => {
      const id = personId(email);
      if (id === user.id) throw new HttpError(403, 'forbidden', 'You cannot remove yourself');
      store.users.remove(id);
      return true;
    }],
    loginLink: [ADMIN, (user, email) => auth.createLoginLink(personId(email)).url],
    /** Email a new person their first sign-in link (valid INVITE_TTL_HOURS, works once). */
    emailInvite: [ADMIN, async (user, email) => {
      const id = personId(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) throw bad('That is not an email address');
      if (!store.users.get(id)) throw new HttpError(404, 'no_user', 'Add the person first');
      if (!mailer.enabled) throw new HttpError(503, 'mail_not_configured', 'Email is not set up on the server');
      const { url } = auth.createLoginLink(id, config.inviteTtlMs);
      try {
        await mailer.sendLoginLink({ to: id, url, minutes: Math.round(config.inviteTtlMs / 60_000), invite: true });
      } catch (e) { throw new HttpError(502, 'mail_failed', e.message); }
      return true;
    }],
    mailHealth: [ADMIN, (user, force) => mailer.health(Boolean(force))],

    /* question bank */
    listQuestions: [STAFF, () => store.questions.list()],
    saveQuestion: [ADMIN, (user, q) => store.questions.save(obj(q))],
    deleteQuestion: [ADMIN, (user, id) => { store.questions.remove(str(id)); return true; }],
    seedQuestions: [ADMIN, (user, arr) => {
      if (!Array.isArray(arr) || arr.length > 2000) throw bad();
      store.questions.seed(arr.map(obj));
      return true;
    }],

    /* surveys */
    listSurveys: [ANY, () => store.surveys.list()],
    listReady: [ANY, () => store.surveys.list().filter((s) => s.status === 'ready')],
    listActive: [ANY, () => store.surveys.list().filter((s) => s.status === 'live' || s.status === 'ready')],
    getSurvey: [ANY, (user, id) => store.surveys.get(str(id))],
    createSurvey: [ADMIN, (user, o) => store.surveys.create(obj(o))],
    updateSurvey: [STAFF, (user, id, patch) => { store.surveys.update(str(id), obj(patch)); return true; }],
    deleteSurvey: [ADMIN, (user, id) => { store.surveys.remove(str(id)); return true; }],

    /* survey data blobs: raw / groups / game */
    getData: [ANY, (user, id, name) => {
      str(id); str(name, 40);
      if (user.role === 'host' && name !== 'game') throw new HttpError(403, 'forbidden', 'Not allowed');
      return store.data.get(id, name);
    }],
    setData: [STAFF, (user, id, name, o) => { store.data.set(str(id), str(name, 40), obj(o)); return true; }],

    /* live (phones) and display (projector) */
    codeFree: [STAFF, (user, c) => store.live.free(code(c))],
    liveSet: [STAFF, (user, c, o) => { store.live.set(code(c), obj(o)); return true; }],
    // face-off buzzers: the tech or an emcee opens them, resets them, or names the winner by hand (the fallback)
    faceoff: [ANY, (user, c, action, arg, names) => {
      const k = code(c);
      if (action === 'open') store.faceoff.open(k, obj(names || {}));
      else if (action === 'reset') store.faceoff.reset(k);
      else if (action === 'set') store.faceoff.set(k, str(arg, 1), obj(names || {}));
      else throw new HttpError(400, 'bad_request', 'Unknown face-off action');
      return true;
    }],
    liveUpdate: [STAFF, (user, c, p) => { store.live.update(code(c), obj(p)); return true; }],
    liveGet: [ANY, (user, c) => store.live.get(code(c))],
    liveDelete: [STAFF, (user, c) => { store.live.remove(code(c)); return true; }],
    displaySet: [STAFF, (user, c, o) => { store.display.set(code(c), obj(o)); return true; }],
    displayGet: [ANY, (user, c) => store.display.get(code(c))],

    /* answers */
    countAnswers: [STAFF, (user, c, q) => store.answers.count(code(c), int(q))],
    getBuzzes: [STAFF, (user, c, q) => store.answers.buzzes(code(c), int(q))],
    getAnswers: [STAFF, (user, c) => store.answers.all(code(c))],

    /* AI */
    aiGroup: [STAFF, (user, p) => ai.group(obj(p))],
    aiHealth: [STAFF, (user, force) => ai.health(Boolean(force))],
  };

  return {
    methods: Object.keys(M),
    async call(user, method, args = []) {
      const def = Object.prototype.hasOwnProperty.call(M, method) ? M[method] : null;
      if (!def) throw new HttpError(404, 'no_method', 'Unknown method');
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in');
      if (!def[0].includes(user.role)) throw new HttpError(403, 'forbidden', 'Your role cannot do that');
      if (!Array.isArray(args)) throw bad();
      return await def[1](user, ...args);
    },
  };
}
