import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login } from './helpers.js';

/** A pretend Gemini that returns whatever `respond(prompt)` says, and records calls. */
function fakeGemini(respond) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    calls.push({ url, key: opts.headers['x-goog-api-key'], body, prompt });
    const r = await respond(prompt, calls.length);
    if (r.status && r.status !== 200) return { ok: false, status: r.status, json: async () => r.json || { error: { message: 'boom' } } };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(r.data) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }) };
  };
  return { fetchImpl, calls };
}

// answers: 0 Kindness, 1 kindness(case dup -> merged), 2 Being nice, 3 Prayer, 4 pray, 5 lol idiot, 6 Amor, 7 prayer and service
const ANSWERS = ['Kindness', 'kindness', 'Being nice', 'Prayer', 'pray', 'lol idiot', 'Amor', 'prayer and service', 'Kindness'];

async function setup(respond, extra = {}) {
  const g = fakeGemini(respond);
  const s = await startApp({ geminiKey: 'test-key', geminiModel: 'gemini-test', fetchImpl: g.fetchImpl, ...extra });
  const tech = await login(s.app, s.base, 'tech1', 'tech');
  const sid = s.app.store.surveys.create({ name: 'S', code: 'AIAIA' });
  s.app.store.data.set(sid, 'raw', { answers: { 0: ANSWERS } });
  return { s, g, tech, sid };
}
const call = (tech, sid, extra = {}) => tech.rpc('aiGroup', { surveyId: sid, q: 0, question: 'Name a quality', anchors: [{ en: 'Kindness' }, { en: 'Love' }], ...extra });
// unique answers as numbered in the prompt (most common first, then arrival order):
// 0 Kindness(x3)  1 Being nice  2 Prayer  3 pray  4 lol idiot  5 Amor  6 prayer and service
const GOOD = { groups: [{ label: 'kindness', members: [0, 1] }, { label: 'Prayer', members: [2, 3, 6, 99] }, { label: 'love', members: [5] }], discard: [4] };

test('groups answers, snaps to your board answers, drops the offensive one, counts duplicates', async () => {
  const { s, g, tech, sid } = await setup(() => ({ data: GOOD }));
  try {
    const r = (await call(tech, sid)).body.r;
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0].key, 'test-key', 'key is sent by the server');
    assert.match(g.calls[0].url, /models\/gemini-test:generateContent$/);
    assert.equal(g.calls[0].body.generationConfig.responseMimeType, 'application/json');
    assert.match(g.calls[0].prompt, /"Kindness"/, 'anchors are in the prompt');
    assert.match(g.calls[0].prompt, /0: Kindness/, 'unique answers are numbered');

    const byLabel = Object.fromEntries(r.groups.map((x) => [x.label, x.v]));
    assert.deepEqual(byLabel.Kindness, { Kindness: 3, 'Being nice': 1 }, 'snapped to anchor wording; case-duplicates merged with count 3');
    assert.deepEqual(byLabel.Love, { Amor: 1 }, 'lowercase "love" snapped to the anchor "Love"');
    assert.deepEqual(byLabel.Prayer, { Prayer: 1, pray: 1, 'prayer and service': 1 });
    assert.deepEqual(r.discarded, ['lol idiot']);
    assert.equal(r.groups[0].label, 'Kindness', 'sorted biggest first');
    assert.equal(r.cached, false);
    assert.deepEqual(r.usage, { in: 100, out: 20 });
  } finally { await s.close(); }
});

test('same input is answered from the cache, no second model call', async () => {
  const { s, g, tech, sid } = await setup(() => ({ data: GOOD }));
  try {
    await call(tech, sid);
    const again = (await call(tech, sid)).body.r;
    assert.equal(again.cached, true);
    assert.equal(g.calls.length, 1);
    // a different question text is a different request
    await call(tech, sid, { question: 'Another question' });
    assert.equal(g.calls.length, 2);
  } finally { await s.close(); }
});

test('answers the model forgot become their own groups; a model that over-discards is ignored', async () => {
  const forgetful = { groups: [{ label: 'Kindness', members: [0, 1] }, { label: 'Prayer', members: [2, 3, 6] }], discard: [] };
  let t = await setup(() => ({ data: forgetful }));
  try {
    const r = (await call(t.tech, t.sid)).body.r;
    const all = r.groups.flatMap((g) => Object.keys(g.v));
    assert.ok(all.includes('lol idiot') && all.includes('Amor'), 'nothing is lost');
  } finally { await t.s.close(); }

  const greedy = { groups: [{ label: 'Kindness', members: [0, 1, 2, 3, 6] }], discard: [4, 5] };
  t = await setup(() => ({ data: greedy }));
  try {
    const r = (await call(t.tech, t.sid)).body.r;
    assert.equal(r.discarded.length, 0, 'discarding 2 of 7 (over 25%) is not trusted');
  } finally { await t.s.close(); }
});

test('retries transient errors, gives up on bad keys, surfaces clear messages', async () => {
  let n = 0;
  let t = await setup(() => (++n < 3 ? { status: 503 } : { data: GOOD }), { });
  try {
    const r = await call(t.tech, t.sid);
    assert.equal(r.status, 200);
    assert.equal(t.g.calls.length, 3, 'two failures then success');
  } finally { await t.s.close(); }

  t = await setup(() => ({ status: 403, json: { error: { message: 'API key not valid' } } }));
  try {
    const r = await call(t.tech, t.sid);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /API key not valid/);
    assert.equal(t.g.calls.length, 1, 'a rejected key is not retried');
  } finally { await t.s.close(); }

  t = await setup(() => ({ status: 429 }));
  try {
    const r = await call(t.tech, t.sid);
    assert.equal(r.status, 429);
    assert.equal(t.g.calls.length, 3);
  } finally { await t.s.close(); }

  t = await setup(() => ({ data: { groups: [{ label: 'x', members: [0] }] } }));
  try {
    const r = await call(t.tech, t.sid);
    assert.equal(r.status, 502, 'a response that covers under half the answers is rejected');
    assert.match(r.body.error, /did not cover/);
  } finally { await t.s.close(); }
});

test('no key configured, no answers, wrong role', async () => {
  const s = await startApp({ geminiKey: '' });
  try {
    const tech = await login(s.app, s.base, 'tech1', 'tech');
    const host = await login(s.app, s.base, 'host1', 'host');
    const sid = s.app.store.surveys.create({ name: 'S' });
    s.app.store.data.set(sid, 'raw', { answers: { 0: ['a'] } });
    const r = await call(tech, sid);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /GEMINI_API_KEY/);
    assert.equal((await call(tech, sid, { q: 7 })).body.code, 'no_answers');
    assert.equal((await call(host, sid)).status, 403);
    assert.equal((await call(tech, 'nope')).status, 404);
    const h = (await tech.rpc('aiHealth')).body.r;
    assert.equal(h.ok, false);
    assert.equal(h.configured, false);
  } finally { await s.close(); }
});

test('reads live answers when no saved results exist yet (grouping while the survey runs)', async () => {
  const { s, tech, sid } = await setup(() => ({ data: GOOD }));
  try {
    s.app.store.data.set(sid, 'raw', {}); // no saved answers for q0 -> falls back to the answers table
    s.app.store.live.set('AIAIA', { phase: 'open', q: 0, closesAt: Date.now() + 9999 });
    for (const [i, a] of ANSWERS.entries()) s.app.store.answers.submit({ code: 'AIAIA', uid: 'u' + i, q: 0, a });
    const r = (await call(tech, sid)).body.r;
    assert.ok(r.groups.length >= 2);
  } finally { await s.close(); }
});

test('health check: ok, and reports the error when the model fails', async () => {
  let ok = true;
  const { s, g, tech } = await setup(() => (ok ? { data: { ok: true } } : { status: 404, json: { error: { message: 'model not found' } } }));
  try {
    let h = (await tech.rpc('aiHealth')).body.r;
    assert.equal(h.ok, true);
    assert.equal(h.model, 'gemini-test');
    await tech.rpc('aiHealth');
    assert.equal(g.calls.length, 1, 'cached for a minute');
    ok = false;
    h = (await tech.rpc('aiHealth', true)).body.r;
    assert.equal(h.ok, false);
    assert.match(h.error, /model not found/);
  } finally { await s.close(); }
});
