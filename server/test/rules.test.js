import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, login, wait, until } from './helpers.js';

/* These replace the old Firestore security rules: what a phone may write, and when. */

async function openQuestion(tech, code, q, extra = {}) {
  await tech.rpc('liveSet', code, { phase: 'open', q, closesAt: Date.now() + 60000, question: { en: 'Q' }, total: 5, ...extra });
}

test('phone can answer only while open, only the current question, 1-80 chars, one per phone', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    const phone = client(s.base);

    // unknown code
    assert.equal((await phone.post('/api/answer', { code: 'NOPE1', q: 0, a: 'x' })).status, 404);

    await tech.rpc('liveSet', 'ABC12', { phase: 'idle', q: -1 });
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 0, a: 'x' })).body.code, 'closed', 'idle = closed');

    await openQuestion(tech, 'ABC12', 0);
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 0, a: 'Kindness' })).status, 200);
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 1, a: 'wrong q' })).body.code, 'closed', 'wrong question');
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 0, a: '' })).body.code, 'bad_answer');
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 0, a: 'x'.repeat(81) })).body.code, 'bad_answer');
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: '0', a: 'string q' })).body.code, 'closed', 'q must be an integer');

    // changing the answer replaces it: still one row for this phone
    assert.equal((await phone.post('/api/answer', { code: 'ABC12', q: 0, a: 'Love' })).status, 200);
    assert.equal(s.app.store.answers.count('ABC12', 0), 1);
    assert.deepEqual(s.app.store.answers.all('ABC12'), { 0: ['Love'] });

    // a second phone adds a second row
    assert.equal((await client(s.base).post('/api/answer', { code: 'ABC12', q: 0, a: 'Honesty' })).status, 200);
    assert.equal(s.app.store.answers.count('ABC12', 0), 2);

    // phone cannot use the buzz endpoint in survey mode
    assert.equal((await phone.post('/api/buzz', { code: 'ABC12', q: 0, a: '0|Team' })).body.code, 'closed');
  } finally { await s.close(); }
});

test('the server closes a question by itself when the countdown ends', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    await tech.rpc('liveSet', 'TIMER', { phase: 'open', q: 0, closesAt: Date.now() + 80, question: { en: 'Q' } });
    assert.equal(s.app.store.live.get('TIMER').phase, 'open');
    await until(() => s.app.store.live.get('TIMER').phase === 'closed', 1500);
    assert.equal((await client(s.base).post('/api/answer', { code: 'TIMER', q: 0, a: 'late' })).body.code, 'closed');

    // +15 s style extension re-arms the timer
    await tech.rpc('liveSet', 'TIMER2', { phase: 'open', q: 0, closesAt: Date.now() + 60, question: { en: 'Q' } });
    await tech.rpc('liveUpdate', 'TIMER2', { closesAt: Date.now() + 400 });
    await wait(200);
    assert.equal(s.app.store.live.get('TIMER2').phase, 'open', 'extended, still open');
    await until(() => s.app.store.live.get('TIMER2').phase === 'closed', 1500);
  } finally { await s.close(); }
});

test('a question that expired while the server was down is closed on restart', async () => {
  const s = await startApp();
  try {
    s.app.store.live.set('OLD01', { phase: 'open', q: 2, closesAt: Date.now() - 5000 });
    s.app.store.live.update('OLD01', { phase: 'open' });
    s.app.store.rescheduleAll();
    await until(() => s.app.store.live.get('OLD01').phase === 'closed', 1500);
  } finally { await s.close(); }
});

test('buzzer: server clock decides, first buzz wins, a phone cannot forge a time', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    await openQuestion(tech, 'BUZZ1', 4, { mode: 'buzzer', teams: ['A', 'B'] });
    const p1 = client(s.base), p2 = client(s.base), cheat = client(s.base);

    assert.equal((await p1.post('/api/buzz', { code: 'BUZZ1', q: 4, a: '0|A' })).status, 200);
    await wait(5);
    assert.equal((await p2.post('/api/buzz', { code: 'BUZZ1', q: 4, a: '1|B' })).status, 200);
    // the cheat tries to supply an early timestamp: ignored, server stamps arrival time
    assert.equal((await cheat.post('/api/buzz', { code: 'BUZZ1', q: 4, a: '1|B', t: 0 })).status, 200);

    const list = (await tech.rpc('getBuzzes', 'BUZZ1', 4)).body.r;
    assert.equal(list.length, 3);
    assert.equal(list[0].a, '0|A', 'first to arrive is first');
    assert.ok(list[0].t < list[1].t && list[1].t < list[2].t);

    // pressing again does not move you earlier or later: first press counts
    await wait(5);
    await p1.post('/api/buzz', { code: 'BUZZ1', q: 4, a: '1|B' });
    assert.equal((await tech.rpc('getBuzzes', 'BUZZ1', 4)).body.r[0].a, '0|A');

    // survey submit is refused in buzzer mode
    assert.equal((await client(s.base).post('/api/answer', { code: 'BUZZ1', q: 4, a: 'x' })).body.code, 'closed');
    // buzzer windows are closed by the tech, not by the server timer
    await tech.rpc('liveUpdate', 'BUZZ1', { closesAt: Date.now() + 10 });
    await wait(150);
    assert.equal(s.app.store.live.get('BUZZ1').phase, 'open');
  } finally { await s.close(); }
});

test('rate limit stops one phone flooding', async () => {
  const s = await startApp();
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    await openQuestion(tech, 'FLOOD', 0);
    const p = client(s.base);
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await p.post('/api/answer', { code: 'FLOOD', q: 0, a: 'a' + i })).status === 429) limited++;
    assert.ok(limited >= 9, 'over 60/min is refused, got ' + limited);
  } finally { await s.close(); }
});
