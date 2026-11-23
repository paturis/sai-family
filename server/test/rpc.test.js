import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, login } from './helpers.js';

/* The old rules, as a matrix: who may call what. */

test('permissions: admin / tech / host / anonymous', async () => {
  const s = await startApp();
  try {
    const admin = await login(s.app, s.base, 'a', 'admin');
    const tech = await login(s.app, s.base, 't', 'tech');
    const host = await login(s.app, s.base, 'h', 'host');
    const anon = client(s.base);
    const st = async (c, m, ...a) => (await c.rpc(m, ...a)).status;

    // anonymous: nothing
    assert.equal(await st(anon, 'listSurveys'), 401);
    assert.equal(await st(anon, 'liveSet', 'ABC12', {}), 401);

    // team + question bank + survey create/delete: admin only
    for (const [m, ...a] of [['listTeam'], ['saveQuestion', { en: 'x' }], ['createSurvey', { name: 'n' }], ['loginLink', 't']]) {
      assert.equal(await st(admin, m, ...a), 200, 'admin ' + m);
      assert.equal(await st(tech, m, ...a), 403, 'tech ' + m);
      assert.equal(await st(host, m, ...a), 403, 'host ' + m);
    }

    // survey id for the rest
    const sid = (await admin.rpc('createSurvey', { name: 'S', status: 'ready' })).body.r;
    assert.equal(await st(tech, 'deleteSurvey', sid), 403);

    // staff: bank read, survey update, live control, data, answers
    assert.equal(await st(tech, 'listQuestions'), 200);
    assert.equal(await st(host, 'listQuestions'), 403);
    assert.equal(await st(tech, 'updateSurvey', sid, { status: 'live' }), 200);
    assert.equal(await st(host, 'updateSurvey', sid, { status: 'x' }), 403);
    assert.equal(await st(tech, 'liveSet', 'ABC12', { phase: 'idle' }), 200);
    assert.equal(await st(host, 'liveSet', 'ABC12', { phase: 'idle' }), 403);
    assert.equal(await st(tech, 'countAnswers', 'ABC12', 0), 200);
    assert.equal(await st(host, 'countAnswers', 'ABC12', 0), 403);
    assert.equal(await st(tech, 'aiHealth'), 200);
    assert.equal(await st(host, 'aiHealth'), 403);

    // host: read surveys and the game blob only
    assert.equal(await st(host, 'listReady'), 200);
    assert.equal(await st(host, 'getSurvey', sid), 200);
    await tech.rpc('setData', sid, 'game', { S: { ok: 1 } });
    await tech.rpc('setData', sid, 'raw', { answers: { 0: ['secret'] } });
    assert.equal(await st(host, 'getData', sid, 'game'), 200);
    assert.equal(await st(host, 'getData', sid, 'raw'), 403);
    assert.equal(await st(host, 'setData', sid, 'game', {}), 403);

    // unknown methods and prototype tricks
    assert.equal(await st(admin, 'nope'), 404);
    assert.equal(await st(admin, 'constructor'), 404);
    assert.equal(await st(admin, '__proto__'), 404);
  } finally { await s.close(); }
});

test('team: no self-demotion or self-removal, ids validated, login link returned', async () => {
  const s = await startApp();
  try {
    const admin = await login(s.app, s.base, 'boss', 'admin');
    assert.equal((await admin.rpc('saveTeam', 'boss', 'tech')).status, 403);
    assert.equal((await admin.rpc('deleteTeam', 'boss')).status, 403);
    assert.equal((await admin.rpc('saveTeam', 'Ravi Kumar', 'tech')).status, 200);
    assert.equal((await admin.rpc('saveTeam', '../../etc', 'tech')).status, 400);
    assert.equal((await admin.rpc('saveTeam', 'x', 'superuser')).status, 400);
    const team = (await admin.rpc('listTeam')).body.r;
    assert.deepEqual(team.map((t) => t.email).sort(), ['boss', 'ravi kumar']);
    const link = (await admin.rpc('loginLink', 'Ravi Kumar')).body.r;
    assert.match(link, /\/\?login=[A-Za-z0-9_-]{30,}$/);
    // the link really signs Ravi in as tech
    const ravi = client(s.base);
    const r = await ravi.post('/api/auth/redeem', { token: link.split('login=')[1] });
    assert.equal(r.body.user.role, 'tech');
  } finally { await s.close(); }
});

test('data round-trips the way the app expects (same shapes as Firestore)', async () => {
  const s = await startApp();
  try {
    const admin = await login(s.app, s.base, 'a', 'admin');
    const id = (await admin.rpc('saveQuestion', { en: 'Q1', kind: 'round', answers: [{ en: 'A', count: 5 }] })).body.r;
    const q2 = (await admin.rpc('saveQuestion', { id, en: 'Q1 edited', kind: 'round' })).body.r;
    assert.equal(q2, id, 'saving with an id updates in place');
    const bank = (await admin.rpc('listQuestions')).body.r;
    assert.equal(bank.length, 1);
    assert.equal(bank[0].en, 'Q1 edited');
    assert.ok(bank[0].updatedAt && bank[0].id === id);

    await admin.rpc('seedQuestions', [{ en: 'S1' }, { en: 'S2' }]);
    assert.equal((await admin.rpc('listQuestions')).body.r.length, 3);

    const sid = (await admin.rpc('createSurvey', { name: 'Retreat', questions: [], status: 'draft' })).body.r;
    await admin.rpc('updateSurvey', sid, { status: 'ready', code: 'ABCDE' });
    const sv = (await admin.rpc('getSurvey', sid)).body.r;
    assert.equal(sv.name, 'Retreat');
    assert.equal(sv.status, 'ready');
    assert.equal(sv.id, sid);
    assert.ok(sv.createdAt);
    assert.equal((await admin.rpc('listReady')).body.r.length, 1);
    await admin.rpc('updateSurvey', sid, { status: 'live' });
    assert.equal((await admin.rpc('listReady')).body.r.length, 0);
    assert.equal((await admin.rpc('listActive')).body.r.length, 1, 'a running survey is visible to the emcee');
    await admin.rpc('updateSurvey', sid, { status: 'closed' });
    assert.equal((await admin.rpc('listActive')).body.r.length, 0);
    await admin.rpc('updateSurvey', sid, { status: 'ready' });

    assert.equal((await admin.rpc('getData', sid, 'groups')).body.r, null);
    await admin.rpc('setData', sid, 'groups', { groups: { 0: [] }, nextId: 3 });
    assert.deepEqual((await admin.rpc('getData', sid, 'groups')).body.r, { groups: { 0: [] }, nextId: 3 });

    assert.equal((await admin.rpc('codeFree', 'ABCDE')).body.r, true);
    await admin.rpc('liveSet', 'ABCDE', { phase: 'idle', q: -1 });
    assert.equal((await admin.rpc('codeFree', 'ABCDE')).body.r, false);
    assert.equal((await admin.rpc('liveGet', 'ABCDE')).body.r.phase, 'idle');
    await admin.rpc('liveUpdate', 'ABCDE', { phase: 'open', q: 0 });
    assert.deepEqual((await admin.rpc('liveGet', 'ABCDE')).body.r, { phase: 'open', q: 0 });
    assert.equal((await admin.rpc('liveUpdate', 'ZZZZZ', { x: 1 })).status, 404);

    // deleting a survey removes its data, live doc and answers
    await admin.rpc('displaySet', 'ABCDE', { teams: {} });
    await admin.rpc('deleteSurvey', sid);
    assert.equal((await admin.rpc('getSurvey', sid)).body.r, null);
    assert.equal((await admin.rpc('liveGet', 'ABCDE')).body.r, null);
    assert.equal((await admin.rpc('displayGet', 'ABCDE')).body.r, null);
    assert.equal((await admin.rpc('getData', sid, 'groups')).body.r, null);
  } finally { await s.close(); }
});

test('bad input is rejected, not crashed on', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 't', 'tech');
    assert.equal((await tech.rpc('liveSet', 'bad code!', {})).status, 400);
    assert.equal((await tech.rpc('liveSet', 'ABC12', 'not an object')).status, 400);
    assert.equal((await tech.rpc('countAnswers', 'ABC12', 'x')).status, 400);
    assert.equal((await tech.post('/api/rpc', { m: 'listSurveys', a: 'nope' })).status, 400);
    const r = await fetch(s.base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: tech.cookie() }, body: '{bad json' });
    assert.equal(r.status, 400);
    assert.equal((await fetch(s.base + '/api/rpc')).status, 405);
  } finally { await s.close(); }
});

test('the old "Fast Money" label is renamed to "Sai Five" in questions saved earlier', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { openDb } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  let db = openDb(dir);
  db.prepare('INSERT INTO questions(id,json,created_at) VALUES(?,?,1)').run('q1', JSON.stringify({ en: 'Name x', kind: 'fast', category: 'Fast Money' }));
  db.prepare('INSERT INTO surveys(id,json,created_at) VALUES(?,?,1)').run('s1', JSON.stringify({ name: 'S', questions: [{ en: 'Name y', kind: 'fast', category: 'Fast Money' }] }));
  db.close();
  db = openDb(dir);
  assert.equal(JSON.parse(db.prepare('SELECT json FROM questions WHERE id=?').get('q1').json).category, 'Sai Five');
  assert.equal(JSON.parse(db.prepare('SELECT json FROM surveys WHERE id=?').get('s1').json).questions[0].category, 'Sai Five');
  db.close();
});
