import test from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { startApp, client, login, wait, until } from './helpers.js';

/** A pretend mail transport that records what would have been sent. */
function fakeMail({ failWith } = {}) {
  const sent = [];
  const factory = () => ({
    sendMail: async (msg) => { if (failWith) throw new Error(failWith); sent.push(msg); },
    verify: async () => { if (failWith) throw new Error(failWith); return true; },
  });
  return { sent, factory };
}
const MAIL_CFG = { smtpUser: 'game@example.org', smtpPass: 'secret', smtpFrom: 'game@example.org' };
const linkIn = (msg) => (msg.text.match(/https?:\/\/\S+\?login=[A-Za-z0-9_-]+/) || [])[0];

test('request-link: an approved email gets a one-time link, and it signs them in', async () => {
  const m = fakeMail();
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
  try {
    s.app.store.users.upsert('ravi@example.org', 'tech');
    const c = client(s.base);
    assert.equal((await c.post('/api/auth/me')).body.mailEnabled, true);

    const r = await c.post('/api/auth/request-link', { email: ' Ravi@Example.org ' });
    assert.equal(r.status, 200);
    await until(() => m.sent.length === 1);
    const msg = m.sent[0];
    assert.equal(msg.to, 'ravi@example.org');
    assert.deepEqual(msg.from, { name: 'One Sai Family game show', address: 'game@example.org' });
    assert.match(msg.subject, /sign-in link/i);
    assert.match(msg.text, /works once and expires in 15 minutes/);
    assert.match(msg.html, /expires in 15 minutes/);
    const url = linkIn(msg);
    assert.ok(url, 'link in the email');

    const signin = await c.post('/api/auth/redeem', { token: url.split('login=')[1] });
    assert.equal(signin.body.user.role, 'tech');
    assert.equal((await client(s.base).post('/api/auth/redeem', { token: url.split('login=')[1] })).status, 401, 'one use only');
  } finally { await s.close(); }
});

test('request-link: unknown, disabled and malformed addresses get the same answer and no email', async () => {
  const m = fakeMail();
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
  try {
    s.app.store.users.upsert('off@example.org', 'tech');
    s.app.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run('off@example.org');
    s.app.store.users.upsert('ritesh', 'admin'); // a name, not an email: cannot be emailed
    const c = client(s.base);
    const answers = [];
    for (const email of ['stranger@example.org', 'off@example.org', 'ritesh', 'not an email', '', 'a@b', 'x'.repeat(200) + '@example.org']) {
      const r = await c.post('/api/auth/request-link', { email });
      answers.push([r.status, JSON.stringify(r.body)]);
    }
    assert.ok(answers.every((a) => a[0] === 200 && a[1] === '{"ok":true}'), 'identical answers: no way to discover who has an account');
    await wait(60);
    assert.equal(m.sent.length, 0);
  } finally { await s.close(); }
});

test('request-link: flooding one address or one source is limited', async () => {
  const m = fakeMail();
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
  try {
    s.app.store.users.upsert('ravi@example.org', 'tech');
    const c = client(s.base);
    for (let i = 0; i < 6; i++) await c.post('/api/auth/request-link', { email: 'ravi@example.org' });
    await wait(80);
    assert.equal(m.sent.length, 3, 'only 3 emails per address per 15 minutes');

    let blocked = 0;
    for (let i = 0; i < 40; i++) if ((await c.post('/api/auth/request-link', { email: `x${i}@example.org` })).status === 429) blocked++;
    assert.ok(blocked >= 5, 'one source cannot spray requests, got ' + blocked);
  } finally { await s.close(); }
});

test('emailed links expire quickly (server-side, per EMAIL_LINK_TTL_MIN)', async () => {
  const m = fakeMail();
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory, emailLinkTtlMs: 80 });
  try {
    s.app.store.users.upsert('ravi@example.org', 'tech');
    const c = client(s.base);
    await c.post('/api/auth/request-link', { email: 'ravi@example.org' });
    await until(() => m.sent.length === 1);
    const token = linkIn(m.sent[0]).split('login=')[1];
    await wait(150);
    assert.equal((await c.post('/api/auth/redeem', { token })).body.code, 'invalid_link');

    // a link requested earlier stops working when the person is removed
    const s2 = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
    try {
      s2.app.store.users.upsert('gone@example.org', 'tech');
      await client(s2.base).post('/api/auth/request-link', { email: 'gone@example.org' });
      await until(() => m.sent.length === 2);
      s2.app.store.users.remove('gone@example.org');
      assert.equal((await client(s2.base).post('/api/auth/redeem', { token: linkIn(m.sent[1]).split('login=')[1] })).status, 401);
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('mail not configured: email sign-in is off and says so, everything else still works', async () => {
  const s = await startApp();
  try {
    const c = client(s.base);
    assert.equal((await c.post('/api/auth/me')).body.mailEnabled, false);
    const r = await c.post('/api/auth/request-link', { email: 'a@b.org' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'mail_not_configured');
    const admin = await login(s.app, s.base, 'boss', 'admin');
    const h = (await admin.rpc('mailHealth')).body.r;
    assert.equal(h.ok, false);
    assert.equal(h.configured, false);
    assert.equal((await admin.rpc('emailInvite', 'x@example.org')).status, 404, 'person must exist first');
    s.app.store.users.upsert('x@example.org', 'tech');
    assert.equal((await admin.rpc('emailInvite', 'x@example.org')).status, 503);
  } finally { await s.close(); }
});

test('admin can email an invite (24 h link); only admins; only to existing email addresses', async () => {
  const m = fakeMail();
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
  try {
    const admin = await login(s.app, s.base, 'boss', 'admin');
    const tech = await login(s.app, s.base, 'helper', 'tech');
    await admin.rpc('saveTeam', 'ravi@example.org', 'tech');
    await admin.rpc('saveTeam', 'Plain Name', 'tech');

    assert.equal((await tech.rpc('emailInvite', 'ravi@example.org')).status, 403);
    assert.equal((await admin.rpc('emailInvite', 'plain name')).status, 400, 'a name has no mailbox');
    assert.equal((await admin.rpc('emailInvite', 'nobody@example.org')).status, 404);

    assert.equal((await admin.rpc('emailInvite', 'ravi@example.org')).status, 200);
    assert.equal(m.sent.length, 1);
    assert.match(m.sent[0].subject, /added to the One Sai Family game show/);
    assert.match(m.sent[0].text, /expires in 24 hours/);
    const ravi = client(s.base);
    assert.equal((await ravi.post('/api/auth/redeem', { token: linkIn(m.sent[0]).split('login=')[1] })).body.user.role, 'tech');

    assert.equal((await admin.rpc('mailHealth')).body.r.ok, true);
    assert.equal((await tech.rpc('mailHealth')).status, 403);
  } finally { await s.close(); }
});

test('send failures are explained to the admin, and never leak to the person asking', async () => {
  const m = fakeMail({ failWith: 'Invalid login: 535 5.7.139 Authentication unsuccessful, basic authentication is disabled.' });
  const s = await startApp({ ...MAIL_CFG, mailTransport: m.factory });
  try {
    s.app.store.users.upsert('ravi@example.org', 'tech');
    const admin = await login(s.app, s.base, 'boss', 'admin');
    const h = (await admin.rpc('mailHealth', true)).body.r;
    assert.equal(h.ok, false);
    assert.match(h.error, /SMTP AUTH may be disabled/, 'tells the admin what to fix');
    const inv = await admin.rpc('emailInvite', 'ravi@example.org');
    assert.equal(inv.status, 502);
    assert.match(inv.body.error, /SMTP AUTH may be disabled/);
    // the person requesting a link just sees the generic answer
    const r = await client(s.base).post('/api/auth/request-link', { email: 'ravi@example.org' });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  } finally { await s.close(); }
});

test('real SMTP conversation: login, message, and a wrong password is reported', async () => {
  const received = [];
  const server = new SMTPServer({
    authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) {
      if (auth.username === 'game@example.org' && auth.password === 'right-password') return cb(null, { user: auth.username });
      cb(new Error('535 5.7.3 Authentication unsuccessful'));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => { received.push({ raw, user: session.user, to: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address }); cb(); });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.server.address().port;
  const smtp = { smtpHost: '127.0.0.1', smtpPort: port, smtpRequireTls: false, smtpUser: 'game@example.org', smtpFrom: 'game@example.org' };
  const good = await startApp({ ...smtp, smtpPass: 'right-password' });
  const bad = await startApp({ ...smtp, smtpPass: 'wrong' });
  try {
    good.app.store.users.upsert('ravi@example.org', 'tech');
    assert.equal((await good.app.mailer.health(true)).ok, true);
    await client(good.base).post('/api/auth/request-link', { email: 'ravi@example.org' });
    await until(() => received.length === 1, 4000);
    assert.equal(received[0].user, 'game@example.org', 'authenticated with the configured account');
    assert.deepEqual(received[0].to, ['ravi@example.org']);
    assert.equal(received[0].from, 'game@example.org');
    const body = received[0].raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    assert.match(body, /\?login=[A-Za-z0-9_-]{30,}/, 'the link is in the message');
    assert.match(body, /Subject: Your sign-in link/);
    assert.match(body, /multipart\/alternative/, 'plain text and HTML versions');

    const h = await bad.app.mailer.health(true);
    assert.equal(h.ok, false);
    assert.match(h.error, /Authentication unsuccessful|SMTP AUTH/i);
    assert.doesNotMatch(JSON.stringify(h), /wrong/, 'password is never reported');
  } finally {
    await good.close(); await bad.close();
    await new Promise((r) => server.close(r));
  }
});
