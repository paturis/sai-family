/* The whole show, with the four real screens in four separate browsers:
     tech laptop (index.html)  ·  projector laptop (display.html)  ·  emcee phone (emcee.html)  ·  audience phones (simulated)
   Checks that every screen shows the right thing at every stage, and that mistakes can be taken back.
     node test/e2e/views.mjs        (needs Chrome; set CHROME_BIN if it is not in the usual place) */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/index.js';

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const app = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1', webRoot: root });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
import fs from 'node:fs';
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const snap = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + String(extra).slice(0, 220)}`); if (!ok) fails++; };

async function ctxPage(w, h) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined).catch(() => {}));
  return p;
}
const text = (p) => p.evaluate(() => document.body.innerText);
async function waitText(p, re, ms = 8000) {
  const t0 = Date.now(); let t = '';
  while (Date.now() - t0 < ms) { t = await text(p); if (re.test(t)) return true; await sleep(120); }
  waitText.last = t.replace(/\s+/g, ' ').slice(0, 300); return false;
}
async function waitFn(p, fn, arg, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(120); }
  return false;
}
// a DOM click: the page may repaint between locating and clicking the element, which makes a real mouse click flaky
const tc = async (p, sel) => { await p.waitForSelector(sel, { timeout: 15000 }); await p.evaluate((s) => document.querySelector(s).click(), sel); };
const consoleHook = (p, fn, ...a) => p.evaluate(fn, ...a);

/* simulated audience phones (their own cookies, like real devices) */
class Phone {
  constructor() { this.cookie = ''; }
  async answer(code, q, a) {
    const r = await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: this.cookie }, body: JSON.stringify({ code, q, a }) });
    const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return r.status;
  }
}
import WebSocket from 'ws';
const phonesWs = [];
function joinPhone(code) { return new Promise((res) => { const ws = new WebSocket(base.replace('http', 'ws') + '/ws'); ws.on('open', () => { ws.send(JSON.stringify({ t: 'sub', ch: 'live:' + code })); phonesWs.push(ws); res(ws); }); }); }

/* ---------- set up: tech signs in and creates a survey ---------- */
app.store.users.upsert('boss', 'admin');
app.store.users.upsert('ravi@example.org', 'host');
const tech = await ctxPage(1440, 900);
await tech.goto(`${base}/?login=${app.auth.createLoginLink('boss').token}&__test=1`, { waitUntil: 'networkidle0' });
await tech.waitForSelector('.a-tabs', { timeout: 10000 });
const hash = () => tech.evaluate(() => location.pathname);
check('URL: the dashboard is /sessions', await waitFn(tech, () => location.pathname === '/sessions'), await hash());
await tc(tech, '[data-a="tab"][data-t="bank"]');
check('URL: the question bank tab is /questions', await waitFn(tech, () => location.pathname === '/questions'), await hash());
await tech.goBack();
check('URL: Back returns to Sessions (page and address)', await waitFn(tech, () => location.pathname === '/sessions' && document.querySelector('.a-tabs .on').dataset.t === 'surveys'), await hash());
await tech.goForward();
check('URL: Forward returns to the question bank', await waitFn(tech, () => location.pathname === '/questions' && document.querySelector('.a-tabs .on').dataset.t === 'bank'), await hash());
await tc(tech, '[data-a="tab"][data-t="surveys"]');
await tech.evaluate(async () => {
  const { A, loadAll, openSv, orderQs } = window.__console;
  await Cloud.seedQuestions(window.SEED_QUESTIONS); await loadAll();
  const pick = (k, n) => A.bank.filter((q) => (q.kind || 'round') === k).slice(0, n);
  const qs = [...pick('round', 4), ...pick('fast', 5)].map((q) => ({ bankId: q.id, en: q.en, kind: q.kind || 'round', category: q.category || '', title: q.title || '', multiplier: q.multiplier || 1, source: q.source || 'discourse', optional: false, cue: '', answers: q.answers || [] }));
  const id = await Cloud.createSurvey({ name: 'Camp Show', status: 'draft', questions: orderQs(qs), code: '' });
  await loadAll(); await openSv(id);
});
check('URL: an open session is /sessions/ID', await waitFn(tech, () => /^\/sessions\/[^/]+$/.test(location.pathname)), await hash());
await tc(tech, '[data-a="launch"]');
await tech.waitForSelector('[data-a="open0"]', { timeout: 8000 });
check('URL: the lobby is /live/ID/lobby', await waitFn(tech, () => /^\/live\/[^/]+\/lobby$/.test(location.pathname)), await hash());
const code = await tech.evaluate(() => window.__console.A.sv.code);
console.log('survey launched with code', code);

/* ---------- projector laptop: opens the one URL and stays on it ---------- */
check('TECH sees "Projector NOT connected" before anyone opens the projector page', await waitText(tech, /Projector NOT connected/), waitText.last);
const proj = await ctxPage(1920, 1080);
await proj.goto(`${base}/display.html?code=${code}`, { waitUntil: 'networkidle0' });
const installRecorder = () => proj.evaluate(() => { window.__played = []; const o = Sound.play; Sound.play = function (n) { const r = o.apply(this, arguments); window.__played.push([n, r]); return r; }; });
const played = () => proj.evaluate(() => window.__played.map((x) => x[0]));
const count = (n) => proj.evaluate((n) => window.__played.filter((x) => x[0] === n).length, n);
await installRecorder();
check('PROJECTOR asks for one click to turn the sound on', await waitText(proj, /Click here once to turn the sound on/), waitText.last);
await proj.click('#snd');                                  // the person at the projector laptop clicks once
check('PROJECTOR sound is on after that one click (and says so)', await waitText(proj, /Sound on/) && await proj.evaluate(() => Sound.state().unlocked), waitText.last);
check('PROJECTOR confirmed with a test ding that really played', (await proj.evaluate(() => window.__played.filter((x) => x[0] === 'ding' && x[1] === true).length)) === 1);
await sleep(600); await snap(proj, 'p1-projector-lobby');
check('TECH sees the projector connected as soon as it opens', await waitText(tech, /Projector connected/), waitText.last);
check('PROJECTOR lobby: join QR code, code and instructions', await waitText(proj, new RegExp(`Scan to play[\\s\\S]*${code}`)) && await proj.evaluate(() => !!document.querySelector('.qr svg')), waitText.last);

const phones = Array.from({ length: 12 }, () => new Phone());
for (let i = 0; i < 5; i++) await joinPhone(code);
check('PROJECTOR lobby: shows how many phones joined (5)', await waitText(proj, /5 phones connected/), waitText.last);
check('TECH lobby: also shows 5 phones connected', await waitText(tech, /5 phones connected/), waitText.last);
check('TECH connection chip: 5 phones', await waitFn(tech, () => (document.querySelector('[data-conn="audience"]') || {}).textContent.includes('5 phones')));

/* ---------- emcee phone ---------- */
const emcee = await ctxPage(430, 900);
await emcee.goto(`${base}/emcee.html?login=${app.auth.createLoginLink('ravi@example.org').token}`, { waitUntil: 'networkidle0' });
check('EMCEE list shows the running survey', await waitText(emcee, /Camp Show[\s\S]*Survey in progress/), waitText.last);
await emcee.click('[data-a="open"]');
await sleep(400); await snap(tech, 't1-tech-lobby'); await snap(emcee, 'e1-emcee-waiting');
check('TECH connection chip: 1 emcee once the emcee opens the show', await waitFn(tech, () => (document.querySelector('[data-conn="emcee"]') || {}).textContent.includes('1 emcee')));
check('EMCEE sees "waiting for the first question" and phone count', await waitText(emcee, /Waiting for the first question[\s\S]*Phones connected: 5/), waitText.last);

/* ---------- survey questions ---------- */
const words = ['Honesty', 'Kindness', 'Love', 'Service', 'Humility'];
await tc(tech, '[data-a="open0"]');
check('URL: collecting is /live/ID/question/1', await waitFn(tech, () => /\/question\/1$/.test(location.pathname)), await hash());
await tech.goBack(); await sleep(400);
check('URL: Back is blocked during a live session (stays on the question)', await tech.evaluate(() => /\/question\/1$/.test(location.pathname) && !!document.getElementById('r0Count')), await hash());
check('PROJECTOR question: number, text, countdown', await waitText(proj, /QUESTION 1 OF 9/) && await waitFn(proj, () => /^\d+$/.test((document.getElementById('qt') || {}).textContent || '')), waitText.last);
const q1 = await tech.evaluate(() => window.__console.items()[0].r.question.en);
check('PROJECTOR shows the actual question text', (await text(proj)).includes(q1.slice(0, 30)));
check('PROJECTOR played the question chime', (await played()).includes('sting'));
check('EMCEE sees the same question', await waitText(emcee, /QUESTION 1 OF 9/) && (await text(emcee)).includes(q1.slice(0, 30)), waitText.last);
for (let i = 0; i < 7; i++) await phones[i].answer(code, 0, words[i % 5]);
check('PROJECTOR live count rises to 7', await waitFn(proj, () => (document.getElementById('qc') || {}).textContent === '7'), await text(proj));
check('EMCEE live count rises to 7', await waitFn(emcee, () => (document.getElementById('ecount') || {}).textContent === '7'));
check('TECH live count rises to 7', await waitFn(tech, () => (document.getElementById('r0Count') || {}).textContent === '7'));
await snap(proj, 'p2-projector-question'); await snap(emcee, 'e2-emcee-question'); await snap(tech, 't2-tech-collecting');
await tc(tech, '[data-a="close"]');
check('PROJECTOR "time is up" with the total', await waitText(proj, /Time is up[\s\S]*7 answers received/), waitText.last);
check('PROJECTOR played the time-up buzzer', (await played()).includes('timeup'));
check('EMCEE "time is up" too', await waitText(emcee, /TIME IS UP[\s\S]*7 answers received/), waitText.last);
for (let q = 1; q < 9; q++) {
  await tc(tech, '[data-a="next"]'); await sleep(350);
  for (let i = 0; i < 12; i++) await phones[i].answer(code, q, words[(i + q) % 5]);
}
await sleep(300);

/* ---------- counting, then the gate, then the game ---------- */
await tc(tech, '[data-a="next"]');                                   // Finish & tabulate
await tech.waitForSelector('.r0-table', { timeout: 15000 });
check('URL: tabulating is /live/ID/tabulate/1 and follows the question tab', await waitFn(tech, () => /\/tabulate\/1$/.test(location.pathname)) && (await tech.evaluate(() => { document.querySelector('[data-a="tab"][data-i="2"]').click(); return true; })) && await waitFn(tech, () => /\/tabulate\/3$/.test(location.pathname)), await hash());
await tech.evaluate(() => document.querySelector('[data-a="tab"][data-i="0"]').click());
await sleep(300); await snap(proj, 'p3-projector-counting'); await snap(tech, 't3-tech-tabulate');
check('PROJECTOR "counting the votes" while the tech works', await waitText(proj, /Counting the votes/), waitText.last);
check('EMCEE told the votes are being counted', await waitText(emcee, /SURVEY COMPLETE[\s\S]*counting the votes/i), waitText.last);
/* bank candidates + AI merge undo (Gemini stubbed in the page) */
await tech.evaluate(() => { window.__console.A.tabQ = 0; window.__console.paint(); });
const candInfo = await tech.evaluate(() => ({ chips: document.querySelectorAll('.r0-cands .r0-chipb').length, adds: document.querySelectorAll('[data-a="addcand"]').length, rows: document.querySelectorAll('.t-tab tbody tr').length }));
check('TABULATE shows the bank\'s candidate answers as chips', candInfo.chips > 0, JSON.stringify(candInfo));
const before = candInfo.rows;
const addable = candInfo.adds > 0;
if (addable) {
  await tc(tech, '.r0-cands [data-a="addcand"]');
  check('TABULATE picking a candidate adds it to the list, flagged as from the bank', await tech.evaluate((n) => document.querySelectorAll('.t-tab tbody tr').length === n + 1 && /From the bank/.test(document.querySelector('.t-tab').textContent), before));
  await tc(tech, '[data-a="rmgroup"]');
  check('TABULATE can remove a bank-only answer again', await tech.evaluate((n) => document.querySelectorAll('.t-tab tbody tr').length === n, before));
} else check('TABULATE (all candidates already on the list)', true);
const groupsBefore = await tech.evaluate(() => JSON.stringify(window.__console.A.groups[0].map((g) => g.label)));
await tech.evaluate(() => { window.__console.Cloud.aiGroup = async () => ({ groups: [{ label: 'Everything', v: { x: 3 } }, { label: 'Other', v: { y: 2 } }] }); });
await tc(tech, '[data-a="aiq"]');
check('AI merge replaced the groups', await waitFn(tech, () => window.__console.A.groups[0].length === 2 && window.__console.A.groups[0][0].label === 'Everything'));
check('Undo AI merge button is enabled', await tech.evaluate(() => { const b = document.querySelector('[data-a="aiundo"]'); return !!b && !b.disabled; }));
await tc(tech, '[data-a="aiundo"]');
check('Undo AI merge restores the earlier groups exactly', await tech.evaluate((g) => JSON.stringify(window.__console.A.groups[0].map((x) => x.label)) === g, groupsBefore), groupsBefore);
check('Undo button disabled again once used', await tech.evaluate(() => document.querySelector('[data-a="aiundo"]').disabled));
/* anchors carry the bank's points; new answers start from the votes; points are editable per question and rank the board */
await tc(tech, '.r0-cands [data-a="addcand"]');
const anchorInfo = await tech.evaluate(() => { const g = window.__console.A.groups[0].find((x) => x.bank), bank = window.__console.items()[0].r.answers; return g && { anchor: g.anchor, pts: g.pts, ok: bank.some((b) => b.en === g.label && Number(b.count) === Number(g.pts)) }; });
check('ANCHORS: a bank answer you pick comes with the bank\'s points', !!anchorInfo && anchorInfo.anchor === true && anchorInfo.ok, JSON.stringify(anchorInfo));
await tc(tech, '[data-a="rmgroup"]');
await tech.evaluate(() => { const A = window.__console.A, bank = window.__console.items()[0].r.answers; window.__console.Cloud.aiGroup = async () => ({ groups: [{ label: bank[1].en, v: { zzz: 2 } }, { label: 'Brand New Idea', v: { yyy: 1 } }] }); });
await tc(tech, '[data-a="aiq"]');
const mapped = await waitFn(tech, () => window.__console.A.groups[0].some((g) => g.label === 'Brand New Idea'));
const mappedInfo = await tech.evaluate(() => { const A = window.__console.A, bank = window.__console.items()[0].r.answers, g = A.groups[0]; const a = g.find((x) => x.label === bank[1].en), n = g.find((x) => x.label === 'Brand New Idea'); return { a: a && [a.anchor, a.pts, Number(bank[1].count)], n: n && [!!n.anchor, n.pts] }; });
check('AI MERGE: answers that fit a bank answer join it (with its points); the rest become new answers (points from votes)', mapped && mappedInfo.a[0] === true && mappedInfo.a[1] === mappedInfo.a[2] && mappedInfo.n[0] === false && !mappedInfo.n[1], JSON.stringify(mappedInfo));
await tc(tech, '[data-a="aiundo"]');
await tech.evaluate(() => { const i = document.querySelector('.t-tab .pt-in'); i.value = '77'; i.dispatchEvent(new Event('change', { bubbles: true })); });
check('POINTS: typing a number sets the points for that answer and it ranks first', await waitFn(tech, () => { const i = document.querySelector('.t-tab .pt-in'); return i && i.value === '77' && i.classList.contains('edited'); }));
await tc(tech, '[data-a="ptsreset"]');
check('POINTS: Reset points restores the bank / vote points', await waitFn(tech, () => !document.querySelector('.t-tab .pt-in.edited') && document.querySelector('.t-tab .pt-in').value !== '77'));

await tc(tech, '[data-a="apply"]');
await tech.waitForSelector('[data-a="begin"]', { timeout: 8000 });
check('URL: the gate is /live/ID/gate', await waitFn(tech, () => /\/gate$/.test(location.pathname)), await hash());
await sleep(300); await snap(proj, 'p4-projector-gate'); await snap(emcee, 'e3-emcee-gate');
check('PROJECTOR gate: "contestants please come up"', await waitText(proj, /Thank you, audience![\s\S]*Contestants/), waitText.last);
check('EMCEE told to invite the contestants', await waitText(emcee, /Invite the contestants up/), waitText.last);
await tc(tech, '[data-a="begin"]');
check('URL: the board is /live/ID/board/round/1', await waitFn(tech, () => /\/board\/round\/1$/.test(location.pathname)), await hash());
check('PROJECTOR switches to the game board by itself', await waitFn(proj, () => document.querySelectorAll('.a').length === 5, null, 10000), await text(proj));
check('PROJECTOR played the intro music when the game began', (await played()).includes('intro'));
check('EMCEE follows to the board automatically (hidden answers visible)', await waitFn(emcee, () => document.querySelectorAll('.ans').length === 5, null, 12000), await text(emcee));
check('TECH sees the hidden answers dimmed with a lock', await tech.evaluate(() => document.querySelectorAll('.answer .peek').length >= 5));
check('TECH shows the projector panel with a live preview', await tech.evaluate(() => !!document.querySelector('#projPanel .proj-preview iframe') && !document.getElementById('projPanel').classList.contains('hidden')));
const preview = tech.frames().find((f) => f.url().includes('display.html'));
check('TECH projector preview is the real projector page showing the board', !!preview && await waitFn(preview, () => document.querySelectorAll('.a').length === 5, null, 8000));

/* ---------- face-off buzzers: two team pads (own phones), emcee QR codes, projector overlay, control passes with Undo ---------- */
const padA = await ctxPage(390, 800), padB = await ctxPage(390, 800);
await padA.goto(`${base}/buzz.html?code=${code}&team=A`, { waitUntil: 'networkidle0' });
await padB.goto(`${base}/buzz.html?code=${code}&team=B`, { waitUntil: 'networkidle0' });
check('EMCEE shows a QR code for each team buzzer page', await waitFn(emcee, () => document.querySelectorAll('.foqr svg').length === 2), await text(emcee));
check('TECH sees both team pads connected', await waitFn(tech, () => /✓[^✕]*pad[\s\S]*✓[^✕]*pad/.test(document.getElementById('sidebar').innerText) || document.querySelectorAll('#sidebar .r0-chip.ok').length >= 2));
check('PAD shows "Get ready" before the buzzers open', await waitText(padA, /Get ready/), waitText.last);
await tc(tech, '[data-fo="ready"]');
check('PROJECTOR shows "Get ready" and no question', await waitFn(proj, () => /get ready/i.test(document.getElementById('fo').innerText) && !/Name something/.test(document.getElementById('fo').innerText)), await proj.evaluate(() => document.getElementById('fo').innerText));
check('PADS show "Get ready…" and no buzz button yet', await waitText(padA, /Get ready…/) && await padA.evaluate(() => !document.getElementById('pad')), waitText.last);
check('EMCEE sees the question hidden while the buzzers are only ready', await waitText(emcee, /Question hidden until you open the buzzers/), waitText.last);
check('TECH shows READY with an Open button', await waitText(tech, /Buzzers READY/) && await tech.evaluate(() => !!document.querySelector('[data-fo="open"]')), waitText.last);
await tc(tech, '[data-fo="open"]');
check('PROJECTOR shows the question together with "Buzzers open!"', await waitFn(proj, () => /Name something/.test(document.getElementById('fo').innerText)), await proj.evaluate(() => document.getElementById('fo').innerText));
check('EMCEE sees the question again once the buzzers are open', await waitText(emcee, /Name something/), waitText.last);
check('PROJECTOR shows "Buzzers open!"', await waitText(proj, /buzzers open!/i), waitText.last);
check('PROJECTOR played the buzzers-open sound (and the browser let it play)', await proj.evaluate(() => window.__played.some((x) => x[0] === 'faceoff' && x[1] === true)));
await sleep(300); await snap(proj, 'fo1-projector-open'); await snap(emcee, 'fo1-emcee'); await snap(tech, 'fo1-tech');
check('Both PADS show a BUZZ button', await waitFn(padA, () => !!document.getElementById('pad')) && await waitFn(padB, () => !!document.getElementById('pad')));
check('EMCEE sees the buzzers are open', await waitText(emcee, /Buzzers are OPEN/), waitText.last);
const ctlBefore = await tech.evaluate(() => window.__console && document.querySelector('[data-control].active') && document.querySelector('[data-control].active').dataset.control);
await snap(padA, 'fo2-pad-open');
await padB.click('#pad');
check('PROJECTOR shows Team B buzzed first', await waitText(proj, /buzzed first!/) && /Team B|TEAM B/.test(await text(proj)), waitText.last);
await sleep(300); await snap(proj, 'fo3-projector-won'); await snap(padB, 'fo3-pad-winner'); await snap(padA, 'fo3-pad-loser');
check('PROJECTOR played the buzz-in sound (and the browser let it play)', await proj.evaluate(() => window.__played.some((x) => x[0] === 'buzzin' && x[1] === true)), JSON.stringify(await proj.evaluate(() => window.__played.slice(-6))));
check('Winning PAD says YOU BUZZED FIRST', await waitText(padB, /YOU BUZZED FIRST/), waitText.last);
check('Other PAD says the other team buzzed first', await waitText(padA, /buzzed first/) && !/YOU BUZZED/.test(await text(padA)), waitText.last);
check('TECH gives Team B control automatically', await waitFn(tech, () => (document.querySelector('[data-control].active') || {}).dataset.control === 'B'), ctlBefore);
check('TECH can Undo that (control goes back)', await (async () => { await tech.click('[data-undo]'); return waitFn(tech, (b) => (document.querySelector('[data-control].active') || {}).dataset.control === b, ctlBefore || 'A'); })());
await tc(tech, '[data-fo="set"][data-t="A"]');
check('Fallback: the tech names Team A by hand, projector shows it', await waitText(proj, /buzzed first!/), waitText.last);
await tc(tech, '[data-fo="reset"]');
check('Reset clears the projector overlay', await waitFn(proj, () => !document.getElementById('fo').classList.contains('on')));
await padA.close(); await padB.close();
/* an emcee who opens the show AFTER the game began, whose phone wakes with a dead connection, still catches up by itself */
const emc2 = await ctxPage(430, 900);
await emc2.evaluateOnNewDocument(() => { const W = window.WebSocket; window.__wss = []; window.WebSocket = function (...a) { const w = new W(...a); window.__wss.push(w); return w; }; window.WebSocket.prototype = W.prototype; });
await emc2.goto(`${base}/emcee.html?login=${app.auth.createLoginLink('ravi@example.org').token}`, { waitUntil: 'networkidle0' });
await emc2.waitForSelector('[data-a="open"]', { timeout: 8000 }); await emc2.click('[data-a="open"]');
check('EMCEE (joined mid-game) shows the face-off panel', await waitFn(emc2, () => !!document.querySelector('[data-a="foready"]')), await text(emc2));
await tc(tech, '[data-fo="ready"]');
check('EMCEE (joined mid-game) sees READY without refreshing', await waitText(emc2, /Buzzers READY/), waitText.last);
await tc(tech, '[data-fo="open"]');
check('EMCEE (joined mid-game) sees OPEN without refreshing', await waitText(emc2, /Buzzers are OPEN/), waitText.last);
await tc(tech, '[data-fo="reset"]');
await waitFn(emc2, () => !/Buzzers are OPEN/.test(document.body.innerText));
await emc2.evaluate(() => window.__wss.forEach((w) => { w.onmessage = () => {}; w.send = () => {}; }));   // the connection silently dies
await tc(tech, '[data-fo="ready"]'); await sleep(1200);
check('(sanity) a deaf emcee page does not see the change', !/Buzzers READY/.test(await text(emc2)));
await emc2.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));                // the phone wakes up
check('EMCEE with a dead connection notices on wake and catches up by itself', await waitText(emc2, /Buzzers READY/, 12000), waitText.last);
await tc(tech, '[data-fo="reset"]');
await emc2.close();
/* deep link: a bookmarked address lands on the right page after sign-in */
const deep = await ctxPage(1280, 800);
await deep.goto(`${base}/questions?login=${app.auth.createLoginLink('boss').token}`, { waitUntil: 'networkidle0' });
check('URL: opening /questions after sign-in lands on the question bank', await waitFn(deep, () => location.pathname === '/questions' && document.querySelector('.a-tabs .on') && document.querySelector('.a-tabs .on').dataset.t === 'bank'), await deep.evaluate(() => location.pathname));
await deep.close();
/* the other games (Jeopardy, Antakshari…) also play through the projector */
const otherSnd = await proj.evaluate(() => {
  const out = [], o = Sound.play; Sound.play = function (n) { out.push(n); return true; };
  soundForDoc({ game: 'jeopardy', teams: [{ score: 0 }, { score: 0 }] }, { game: 'jeopardy', teams: [{ score: 200 }, { score: 0 }] });
  soundForDoc({ game: 'jeopardy', teams: [{ score: 200 }, { score: 0 }] }, { game: 'jeopardy', teams: [{ score: 0 }, { score: 0 }] });
  soundForLive({ mode: 'buzzer', phase: 'idle', q: 1 }, { mode: 'buzzer', phase: 'open', q: 1 });
  soundForLive({ mode: 'buzzer', phase: 'open', q: 1 }, { mode: 'buzzer', phase: 'locked', q: 1 });
  Sound.play = o; return out;
});
check('PROJECTOR sounds for the other games: points up = ding, down = buzzer, buzzers ready, buzz-in', JSON.stringify(otherSnd) === '["ding","buzzer","faceoff","buzzin"]', JSON.stringify(otherSnd));


/* ---------- running the board: reveal, strike, award, and take each one back ---------- */
check('TECH header chips stay visible while running the game', await tech.evaluate(() => { const h = document.getElementById('connHdr'); return !h.classList.contains('hidden') && h.querySelectorAll('[data-conn]').length >= 3; }));
check('TECH counts exactly ONE projector (its own preview window does not count)', await tech.evaluate(() => [...document.querySelectorAll('#connHdr [data-conn="projector"]')].every((e) => e.textContent === '🖥 Projector connected')));
const onProj = () => proj.evaluate(() => document.querySelectorAll('.a.on').length);
const strikesProj = () => proj.evaluate(() => document.querySelectorAll('.strikes i.on').length);
const scoresProj = () => proj.evaluate(() => [...document.querySelectorAll('.team .s')].map((e) => e.textContent));
const histLen = () => tech.evaluate(() => document.querySelectorAll('.hist li').length);
const d1 = await count('ding');
await tech.keyboard.press('1'); await sleep(700); await tech.keyboard.press('2');
check('reveal two answers: projector shows 2 tiles', await waitFn(proj, () => document.querySelectorAll('.a.on').length === 2), await onProj());
check('PROJECTOR played a ding for each reveal', await waitFn(proj, (n) => window.__played.filter((x) => x[0] === 'ding').length === n, d1 + 2), await count('ding'));
check('EMCEE marks 2 answers ON BOARD', await waitFn(emcee, () => document.querySelectorAll('.ans.on').length === 2));
await sleep(500); await snap(tech, 't4-tech-board'); await snap(proj, 'p5-projector-board'); await snap(emcee, 'e4-emcee-board');
const bz0 = await count('buzzer');
await tech.keyboard.press('x');
check('strike: projector shows 1 strike', await waitFn(proj, () => document.querySelectorAll('.strikes i.on').length === 1));
check('PROJECTOR sounded the buzzer for the strike', await waitFn(proj, (n) => window.__played.filter((x) => x[0] === 'buzzer').length === n, bz0 + 1), await count('buzzer'));
await tech.keyboard.press('x');
check('second strike shows (2)', await waitFn(proj, () => document.querySelectorAll('.strikes i.on').length === 2));
await sleep(300);
const bzUndo = await count('buzzer');
await tech.keyboard.press('z');
check('UNDO (Z) takes back the second strike everywhere', await waitFn(proj, () => document.querySelectorAll('.strikes i.on').length === 1) && await waitFn(emcee, () => document.querySelectorAll('.strikes i.on').length === 1), await strikesProj());
await sleep(500);
check('undoing a strike does NOT sound the buzzer', (await count('buzzer')) === bzUndo, await count('buzzer'));
await tech.keyboard.down('Shift'); await tech.keyboard.press('z'); await tech.keyboard.up('Shift');
check('REDO (Shift+Z) puts it back', await waitFn(proj, () => document.querySelectorAll('.strikes i.on').length === 2));
await tech.click('[data-strike="remove"]');
check('"Remove a strike" button works', await waitFn(proj, () => document.querySelectorAll('.strikes i.on').length === 1));
await tech.keyboard.press('2');
check('clicking a revealed answer again hides it', await waitFn(proj, () => document.querySelectorAll('.a.on').length === 1));
await tech.keyboard.press('z');
check('undo brings the hidden answer back', await waitFn(proj, () => document.querySelectorAll('.a.on').length === 2));

const fan0 = await count('fanfare'), app0 = await count('applause');
await tech.keyboard.press('a');                                        // award to team A (a mistake we then fix)
await sleep(500); await snap(tech, 't5-tech-awarded-undo-hint');
check('award: round goes to Team A and the score shows on the projector', await waitFn(proj, () => Number((document.querySelector('.team .s') || {}).textContent) > 0), (await scoresProj()).join(','));
const scoreAfterAward = (await scoresProj())[0];
check('award note appears with an undo hint', await waitText(tech, /Wrong team\? Press Undo/), waitText.last);
check('PROJECTOR played the fanfare and the applause', await waitFn(proj, (a) => window.__played.filter((x) => x[0] === 'fanfare').length === a[0] + 1 && window.__played.filter((x) => x[0] === 'applause').length === a[1] + 1, [fan0, app0]), `${await count('fanfare')}/${await count('applause')}`);
check('projector shows who was awarded', await waitText(proj, /Round awarded to/), waitText.last);
await tech.keyboard.down('Control'); await tech.keyboard.press('z'); await tech.keyboard.up('Control');
check('Ctrl+Z takes the award back: score returns to 0 on the projector', await waitFn(proj, () => (document.querySelector('.team .s') || {}).textContent === '0'), (await scoresProj()).join(','));
await tech.keyboard.press('b');
check('...and it can now be awarded to the right team (B)', await waitFn(proj, () => Number(document.querySelectorAll('.team .s')[1].textContent) > 0 && document.querySelectorAll('.team .s')[0].textContent === '0'), (await scoresProj()).join(','));
const hist = await histLen();
check('recent actions are listed for the tech', hist >= 1, hist);
await tech.click('[data-adj="A:10"]');
check('score correction +10 for Team A shows on the projector', await waitFn(proj, () => document.querySelectorAll('.team .s')[0].textContent === '10'));
await tech.keyboard.press('z');
check('...and it can be undone too', await waitFn(proj, () => document.querySelectorAll('.team .s')[0].textContent === '0'));

/* steal banner after three strikes (next round) */
await tech.click('[data-next="1"]');
await tech.keyboard.press('x'); await tech.keyboard.press('x'); await tech.keyboard.press('x');
await sleep(400); await snap(tech, 't6-tech-steal'); await snap(proj, 'p6-projector-steal');
check('three strikes: tech board shows the STEAL instructions', await waitText(tech, /STEAL![\s\S]*gets one guess/), waitText.last);
check('three strikes: projector shows the STEAL banner', await waitText(proj, /STEAL —/), waitText.last);
await tech.keyboard.press('z');
check('undo removes the steal state', await waitFn(tech, () => !document.querySelector('.steal-banner')));
await tech.click('[data-prev="1"]');
check('Back button returns to round 1', await waitText(tech, /ROUND 1/), waitText.last);

/* ---------- sound: the tech triggers, the PROJECTOR laptop plays ---------- */
check('TECH laptop stays silent (the projector is the one on the hall speakers)', await tech.evaluate(() => window.PROJECTOR_PLAYS === true));
const dr0 = await count('drumroll');
await tech.click('[data-cue="drumroll"]');
check('TECH soundboard: the PROJECTOR plays the drum roll', await waitFn(proj, (n) => window.__played.filter((x) => x[0] === 'drumroll' && x[1] === true).length === n, dr0 + 1), await count('drumroll'));
await tech.click('[data-snd-on]');
check('TECH sound switch mutes the projector', await waitFn(proj, () => Sound.state().mute === true) && await waitText(proj, /muted from the tech laptop/), waitText.last);
await tech.click('[data-snd-on]');
check('...and turns it back on', await waitFn(proj, () => Sound.state().mute === false));
await proj.reload({ waitUntil: 'networkidle0' });
await installRecorder(); await proj.click('#snd'); await sleep(900);
check('a reloaded projector does not replay old soundboard cues', !(await played()).includes('drumroll'), await played());
check('the built-in sounds are the default set', await proj.evaluate(() => Sound.state().pack === 'builtin'));
await tech.select('[data-snd-pack]', 'classic');
check('TECH can switch to the "Classic game show" set and the projector follows', await waitFn(proj, () => Sound.state().pack === 'classic'), await proj.evaluate(() => Sound.state().pack));
check('...and it explains when no files have been added yet', await waitFn(tech, () => /No files in sounds\/classic\//.test(document.querySelector('[data-pack-note]').textContent)));
check('...sounds still play (missing files fall back to the built-in ones)', await proj.evaluate(() => Sound.play('ding') === true));
await tech.select('[data-snd-pack]', '');
check('TECH can switch back to the built-in sounds', await waitFn(proj, () => Sound.state().pack === 'builtin'));

/* ---------- projector override ---------- */
await tech.select('#projPanel [data-proj]', 'intermission');
await sleep(500); await snap(proj, 'p7-projector-intermission');
check('PROJECTOR override: intermission screen', await waitText(proj, /We will be right back/), waitText.last);
await tech.select('#projPanel [data-proj]', 'blank');
check('PROJECTOR override: blank screen', await waitFn(proj, () => document.getElementById('app').innerHTML.trim() === ''));
await tech.select('#projPanel [data-proj]', '');
check('PROJECTOR back to the game automatically', await waitFn(proj, () => document.querySelectorAll('.a').length === 5));

/* ---------- Sai Five: one question at a time; both reps write their top 5 (60 s); the tech ticks the answers each team got; points added live ---------- */
const sc = () => proj.evaluate(() => [...document.querySelectorAll('.team .s')].map((e) => Number(e.textContent)));
const sc0 = await sc();
await tech.evaluate(() => window.__console.setView('fast'));
await tech.waitForSelector('.sf-timerbar', { timeout: 8000 });
check('SAI FIVE tech: the clock and its controls are at the TOP of the page (start, seconds)', await tech.evaluate(() => { const bar = document.querySelector('.sf-timerbar'), card = document.querySelector('.sf-card'); return !!bar.querySelector('#timerNum') && !!bar.querySelector('[data-sf-timer="start"]') && bar.querySelector('[data-sf-secs]').value === '60' && bar.getBoundingClientRect().top < card.getBoundingClientRect().top && /Question 1 of 5/.test(bar.textContent); }));
check('SAI FIVE projector: question 1, a big 60-second clock, no answers', await waitFn(proj, () => /QUESTION 1 OF 5/i.test(document.querySelector('.cat').textContent) && !!document.getElementById('tm2') && document.querySelectorAll('.sfboard').length === 0 && document.querySelector('.sfqtext').textContent.length > 10), await text(proj));
await tech.evaluate(() => { const i = document.querySelector('[data-sf-secs]'); i.value = '10'; i.dispatchEvent(new Event('change', { bubbles: true })); });
await tc(tech, '[data-sf-timer="start"]');
check('SAI FIVE the projector\'s big clock counts down', await waitFn(proj, () => { const t = document.getElementById('tm2'); return !!t && Number(t.textContent) < 10; }, null, 6000), await text(proj));
const tuBefore = await count('timeup');
check('SAI FIVE when the clock reaches 0 the projector buzzes and the tech moves on to marking', await waitFn(proj, (n) => window.__played.filter((x) => x[0] === 'timeup').length > n, tuBefore, 16000) && await waitFn(tech, () => document.querySelectorAll('.sf-mrow').length === 5, null, 4000), await text(tech));
check('SAI FIVE projector: the board of this question, every answer hidden', await waitFn(proj, () => document.querySelectorAll('.sfa').length === 5 && document.querySelectorAll('.sfa.on').length === 0), await text(proj));
const dBefore = await count('ding');
await tc(tech, '[data-fq-tick="A:0"]');
check('SAI FIVE ticking Team A\'s answer shows it at once, with the team and 50 points, and a ding', await waitFn(proj, () => { const a = document.querySelector('.sfa.on'); return !!a && /Team A/.test(a.querySelector('.tags').textContent) && a.querySelector('.p').textContent === '50'; }) && await waitFn(proj, (n) => window.__played.filter((x) => x[0] === 'ding').length > n, dBefore), await text(proj));
check('SAI FIVE Team A\'s score went up by 50 on the scoreboard straight away', await waitFn(proj, (b) => document.querySelectorAll('.team .s')[0].textContent === String(b + 50), sc0[0]), JSON.stringify(await sc()));
await tc(tech, '[data-fq-tick="B:0"]'); await tc(tech, '[data-fq-tick="B:2"]');
check('SAI FIVE both teams can get the same answer: both score (A +50, B +80 so far)', await waitFn(proj, (b) => document.querySelectorAll('.team .s')[0].textContent === String(b[0] + 50) && document.querySelectorAll('.team .s')[1].textContent === String(b[1] + 80) && document.querySelectorAll('.sfa.on').length === 2 && document.querySelector('.sfa.on .tags').children.length === 2, sc0), JSON.stringify(await sc()));
await tech.evaluate(() => window.scrollTo(0, 0)); await sleep(200); await snap(proj, 'sf1-projector-mark'); await snap(tech, 'sf2-tech-mark');
check('SAI FIVE emcee sees which answers each team got', await waitText(emcee, /GIVEN/), waitText.last);
await tc(tech, '[data-fq-tick="B:2"]');
check('SAI FIVE ticking again removes it and takes the points back', await waitFn(proj, (b) => document.querySelectorAll('.team .s')[1].textContent === String(b[1] + 50) && document.querySelectorAll('.sfa.on').length === 1, sc0), JSON.stringify(await sc()));
await tc(tech, '[data-undo]');
check('SAI FIVE Undo puts it back (answer shown, points added)', await waitFn(proj, (b) => document.querySelectorAll('.team .s')[1].textContent === String(b[1] + 80) && document.querySelectorAll('.sfa.on').length === 2, sc0), JSON.stringify(await sc()));
await tc(tech, '[data-fq-showall]');
check('SAI FIVE "show the answers nobody got" reveals the rest', await waitFn(proj, () => document.querySelectorAll('.sfa.on').length === 5));
await tc(tech, '[data-fq-showall]');
await tc(tech, '[data-fq-next]');
check('SAI FIVE next question: the projector is back to the question and clock', await waitFn(proj, () => /QUESTION 2 OF 5/i.test(document.querySelector('.cat').textContent) && !!document.getElementById('tm2')), await text(proj));
for (let k = 1; k < 5; k++) {
  await tc(tech, '[data-fq-stop]'); await tc(tech, '[data-fq-tick="A:1"]'); await tc(tech, '[data-fq-tick="B:0"]');
  if (k < 4) await tc(tech, '[data-fq-next]');
}
await tc(tech, '[data-fast-award]');
check('SAI FIVE finish: per-question points and the final result on the projector', await waitFn(proj, () => document.querySelectorAll('.sfrr').length === 6 && /FINAL RESULT/.test(document.body.innerText)), await text(proj));
check('SAI FIVE the winner is decided by the total score across all rounds', await proj.evaluate(() => { const s = [...document.querySelectorAll('.team .s')].map((e) => Number(e.textContent)), w = document.querySelector('.sf-win h2').textContent; return s[0] === s[1] ? /tie/.test(w) : (s[0] > s[1] ? /Team A wins/ : /Team B wins/).test(w); }));
await snap(proj, 'sf3-projector-result');
await tc(tech, '[data-undo]');
check('SAI FIVE Undo of Finish removes the banner', await waitFn(proj, () => !/FINAL RESULT/.test(document.body.innerText)));
await tech.evaluate(() => window.__console.setView('rounds', 0));
await tech.evaluate(() => { window.__console.setView('fast'); });
await tc(tech, '[data-fast-reset]');
check('SAI FIVE Reset takes all the Sai Five points back off the scores', await waitFn(proj, (b) => document.querySelectorAll('.team .s')[0].textContent === String(b[0]) && document.querySelectorAll('.team .s')[1].textContent === String(b[1]), sc0), JSON.stringify(await sc()));
await tech.evaluate(() => window.__console.setView('rounds', 0));
await waitFn(proj, () => document.querySelectorAll('.a').length === 5);

/* ---------- connections: a second tech console is flagged, and a closed projector is noticed ---------- */
const svId = await tech.evaluate(() => window.__console.A.sv.id);
const tech2 = await ctxPage(1000, 700);
await tech2.goto(`${base}/?login=${app.auth.createLoginLink('boss').token}&__test=1`, { waitUntil: 'networkidle0' });
await tech2.waitForSelector('.a-tabs', { timeout: 10000 });
check('no warning while only one tech console is open', await tech.evaluate(() => (document.querySelector('#connHdr [data-conn="tech"]') || { classList: { contains: () => true } }).classList.contains('hidden')));
await tech2.evaluate(async (id) => { await window.__console.openSv(id); }, svId);
check('TECH is warned when a SECOND tech console opens the same game', await waitText(tech, /2 tech consoles open/), waitText.last);
await tech2.close();
check('...and the warning clears when it closes', await waitFn(tech, () => document.querySelector('#connHdr [data-conn="tech"]').classList.contains('hidden')));
await proj.close();
check('TECH sees the projector drop out when its page is closed', await waitText(tech, /Projector NOT connected/), waitText.last);

/* ---------- audience phone page still works alongside ---------- */
const aud = await ctxPage(390, 800);
await aud.goto(`${base}/play.html?code=${code}`, { waitUntil: 'networkidle0' });
check('AUDIENCE phone shows the thank-you page with live scores', await waitText(aud, /Thank you[\s\S]*LIVE SCORES/i), waitText.last);

const allErrors = [tech, proj, emcee, aud].flatMap((p, i) => p.errors.map((e) => ['tech', 'projector', 'emcee', 'audience'][i] + ': ' + e));
check('no JavaScript errors on any of the four screens', allErrors.length === 0, allErrors.join(' | '));

phonesWs.forEach((w) => w.close());
await browser.close(); await app.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
