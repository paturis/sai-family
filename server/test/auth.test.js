import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, login } from './helpers.js';

test('login link works once, creates a session, logout ends it', async () => {
  const s = await startApp();
  try {
    s.app.store.users.upsert('ritesh', 'admin');
    const { token } = s.app.auth.createLoginLink('ritesh');
    const c = client(s.base);
    assert.equal((await c.post('/api/auth/me')).body.user, null);

    const r = await c.post('/api/auth/redeem', { token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user, { id: 'ritesh', name: 'ritesh', role: 'admin' });
    assert.equal((await c.post('/api/auth/me')).body.user.id, 'ritesh');

    // the same link cannot be used again, by anyone
    assert.equal((await client(s.base).post('/api/auth/redeem', { token })).body.code, 'invalid_link');

    await c.post('/api/auth/logout');
    assert.equal((await c.post('/api/auth/me')).body.user, null);
  } finally { await s.close(); }
});

test('bad, expired and disabled logins are refused', async () => {
  const s = await startApp();
  try {
    s.app.store.users.upsert('bob', 'tech');
    const c = client(s.base);
    assert.equal((await c.post('/api/auth/redeem', { token: 'x'.repeat(40) })).status, 401);
    assert.equal((await c.post('/api/auth/redeem', { token: 'short' })).status, 401);
    assert.equal((await c.post('/api/auth/redeem', {})).status, 401);

    const expired = s.app.auth.createLoginLink('bob', -1000);
    assert.equal((await c.post('/api/auth/redeem', { token: expired.token })).body.code, 'invalid_link');

    const ok = s.app.auth.createLoginLink('bob');
    s.app.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run('bob');
    assert.equal((await c.post('/api/auth/redeem', { token: ok.token })).body.code, 'invalid_link');
  } finally { await s.close(); }
});

test('removing a person signs them out everywhere', async () => {
  const s = await startApp();
  try {
    const admin = await login(s.app, s.base, 'boss', 'admin');
    const tech = await login(s.app, s.base, 'helper', 'tech');
    assert.equal((await tech.post('/api/auth/me')).body.user.id, 'helper');
    assert.equal((await admin.rpc('deleteTeam', 'helper')).status, 200);
    assert.equal((await tech.post('/api/auth/me')).body.user, null);
    assert.equal((await tech.rpc('listSurveys')).status, 401);
  } finally { await s.close(); }
});

test('audience cookie is signed: a forged uid is replaced', async () => {
  const s = await startApp();
  try {
    const c = client(s.base);
    await c.post('/api/join');
    assert.ok(c.jar.uid, 'device cookie issued');
    const real = decodeURIComponent(c.jar.uid);
    const forged = client(s.base);
    forged.jar.uid = encodeURIComponent('victim.' + 'A'.repeat(real.split('.')[1].length));
    await forged.post('/api/join');
    assert.ok(!decodeURIComponent(forged.jar.uid).startsWith('victim.'), 'forged cookie was replaced');
  } finally { await s.close(); }
});

test('cross-site requests are blocked', async () => {
  const s = await startApp();
  try {
    const r = await fetch(s.base + '/api/auth/me', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(r.status, 403);
    const same = await fetch(s.base + '/api/auth/me', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.base }, body: '{}' });
    assert.equal(same.status, 200);
  } finally { await s.close(); }
});

test('ADMIN_IDS creates the first admin', async () => {
  const s = await startApp({ adminIds: ['first@example.org'] });
  try {
    assert.equal(s.app.store.users.get('first@example.org').role, 'admin');
  } finally { await s.close(); }
});
