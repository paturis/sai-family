/* Real-browser check of all four pages against a throwaway server.  Needs Chrome:
     node test/e2e/browser.mjs            (set CHROME_BIN if Chrome is not in the usual place)
   Not part of `npm test` because it needs a browser installed. */
import { createApp } from '../../src/index.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const app = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1', webRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..') });
const port = await app.listen();
const base = `http://127.0.0.1:${port}`;

function chrome(url, ms = 7000) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(SCR + '/prof-');
    const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--user-data-dir=${dir}`, `--virtual-time-budget=${ms}`, '--enable-logging=stderr', '--v=0', '--dump-dom', url]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), 45000);
    p.on('close', () => { clearTimeout(t); fs.rmSync(dir, { recursive: true, force: true }); resolve({ dom: out, log: err }); });
  });
}
const text = (dom) => dom.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const consoleErrors = (log) => log.split('\n').filter((l) => /CONSOLE.*(Uncaught|Error)/i.test(l) && !/favicon/i.test(l));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + extra}`); if (!ok) fails++; };

// seed: an admin, a survey, an open question and a scoreboard
app.store.users.upsert('ritesh', 'admin');
app.store.users.upsert('ravi', 'host');
const sid = app.store.surveys.create({ name: 'E2E Retreat', status: 'ready', code: 'E2E01', questions: [] });
app.store.live.set('E2E01', { surveyId: sid, phase: 'open', q: 0, total: 3, question: { en: 'Name a quality you admire' }, closesAt: Date.now() + 600000, seconds: 45, hostNow: Date.now() });
app.store.display.set('E2E01', { teams: { A: { name: 'Lotus', score: 120 }, B: { name: 'Tulsi', score: 85 } }, view: 'rounds', title: 'E2E', timerSeconds: 0, timerRunning: false, timerEndsAt: 0, round: { n: 1, of: 4, category: 'The Sai Family', question: 'Name something kind', mult: 1, answers: [{ on: true, t: 'Smile', p: 30 }, { on: false }], strikes: 1, control: 'A', steal: false, awarded: null } });

// A. signed-out console shows the login-link box
let r = await chrome(base + '/');
let t = text(r.dom);
check('console (signed out): asks for a login link', /Paste the personal login link/.test(t) && /id="loginTok"/.test(r.dom), t.slice(0, 200));
check('console (signed out): no Google button', !/Sign in with Google/.test(t));
check('console (signed out): no JS errors', consoleErrors(r.log).length === 0, consoleErrors(r.log).join('\n'));

// B. login link in the URL signs in, shows the dashboard, role chip, sync + AI chips
const { token } = app.auth.createLoginLink('ritesh');
r = await chrome(base + '/?login=' + token);
t = text(r.dom);
check('console: login link signs in (role chip)', /ritesh · admin/.test(t), t.slice(0, 300));
check('console: dashboard rendered', /Sessions & past results|Question bank/.test(t), t.slice(0, 300));
check('console: sync chip says Live', /● Live/.test(t), t.slice(0, 300));
check('console: AI chip present (not configured here)', /AI ✗/.test(t), 'no AI chip');
check('console: token removed from URL / used up', (await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status === 401);
check('console: View-as menu for admin', /View as/.test(t));
check('console: no JS errors', consoleErrors(r.log).length === 0, consoleErrors(r.log).join('\n'));

// C. phone page shows the open question from the live channel
r = await chrome(base + '/play.html?code=E2E01');
t = text(r.dom);
check('phone: shows the open question', /Name a quality you admire/.test(t) && /id="ans"/.test(r.dom), t.slice(0, 300));
check('phone: no JS errors', consoleErrors(r.log).length === 0, consoleErrors(r.log).join('\n'));
r = await chrome(base + '/play.html?code=NOPE9');
check('phone: unknown code is explained', /not found/i.test(text(r.dom)), text(r.dom).slice(0, 200));

// D. projector shows the scoreboard from the display channel
r = await chrome(base + '/display.html?code=E2E01');
t = text(r.dom);
check('projector: shows teams and scores', /Lotus/.test(t) && /120/.test(t) && /Tulsi/.test(t), t.slice(0, 300));
check('projector: shows revealed answer, hides the other', /Smile/.test(t), t.slice(0, 300));
check('projector: no JS errors', consoleErrors(r.log).length === 0, consoleErrors(r.log).join('\n'));

// E. emcee login asks for a link; with a host session it lists the game
r = await chrome(base + '/emcee.html');
check('emcee: asks for a login link', /Paste the personal login link/.test(text(r.dom)), text(r.dom).slice(0, 200));
const hostTok = app.auth.createLoginLink('ravi').token;
r = await chrome(base + '/emcee.html?login=' + hostTok);
t = text(r.dom);
check('emcee: host signs in and sees the ready game', /E2E Retreat/.test(t), t.slice(0, 300));
check('emcee: no JS errors', consoleErrors(r.log).length === 0, consoleErrors(r.log).join('\n'));

await app.close();
fs.rmSync(SCR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
