/* Walks through every screen of the app in a real browser and saves screenshots (for design review).
     node test/e2e/shots.mjs <output-folder>      (CHROME_BIN if Chrome is not in the usual place)
   Uses practice mode for the console flow (no sign-in needed) and a throwaway server for the phone/projector pages. */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/index.js';

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const OUT = path.resolve(process.argv[2] || 'shots');
fs.mkdirSync(OUT, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const app = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1', webRoot: root,
  smtpUser: 'game@example.org', smtpPass: 'x', smtpFrom: 'game@example.org', mailTransport: () => ({ sendMail: async () => {}, verify: async () => true }) });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function newPage(w = 1440, h = 900) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined).catch(() => {}));
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return p;
}
const shot = (p, name, full = false) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full }).then(() => console.log('  shot', name));
const click = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.click(sel); await sleep(250); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log(`  !! ${name}: ${e.message.split('\n')[0]}`); errors.push(`${name}: ${e.message.split('\n')[0]}`); } };

/* ---------- console flow in practice mode ---------- */
const p = await newPage();
await step('login', async () => { await p.goto(base + '/?__test=1', { waitUntil: 'networkidle0' }); await shot(p, '01-login'); });
await step('practice', async () => { await click(p, '[data-a="practice"]'); await sleep(500); await shot(p, '02-dashboard-empty'); });
await step('seed + survey', async () => {
  await p.evaluate(async () => {
    const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console;
    await Cloud.seedQuestions(window.SEED_QUESTIONS);
    await loadAll();
    const pick = (kind, n) => A.bank.filter((q) => (q.kind || 'round') === kind).slice(0, n);
    const qs = [...pick('round', 4), ...pick('fast', 5)].map((q) => ({ bankId: q.id, en: q.en, kind: q.kind || 'round', category: q.category || '', title: q.title || '', multiplier: q.multiplier || 1, source: q.source || 'discourse', optional: !!q.optional, cue: q.cue || '', answers: q.answers || [] }));
    const id = await Cloud.createSurvey({ name: 'Sadhana Camp 2026 — Survey Says!', status: 'draft', questions: orderQs(qs), code: '' });
    await loadAll();
    A.stage = 'dash'; A.tab = 'surveys'; paint();
  });
  await sleep(400);
  await shot(p, '03-dashboard-surveys');
  await p.evaluate(() => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; A.tab = 'bank'; paint(); });
  await sleep(300); await shot(p, '04-question-bank');
  await p.evaluate(() => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; A.tab = 'team'; paint(); });
  await sleep(300); await shot(p, '05-team');
  await p.evaluate(() => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; A.tab = 'surveys'; paint(); });
});
await step('survey page', async () => {
  await p.evaluate(async () => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; await openSv(A.surveys[0].id); });
  await sleep(300); await shot(p, '06-survey-detail');
});
await step('new survey form', async () => {
  await p.evaluate(() => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; A.form = { name: '', sel: A.bank.slice(0, 6).map((q) => q.id), q: '', tag: '' }; A.stage = 'sform'; paint(); });
  await sleep(300); await shot(p, '07-survey-form');
  await p.evaluate(async () => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; await openSv(A.surveys[0].id); });
});
await step('launch + lobby', async () => { await click(p, '[data-a="launch"]'); await sleep(600); await shot(p, '08-lobby'); });
await step('collect', async () => {
  await click(p, '[data-a="open0"]'); await sleep(900);
  await p.evaluate(async () => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; await simFill(A.q, 70); });
  await sleep(2600); await shot(p, '09-collecting');
  for (let i = 0; i < 9; i++) {
    await p.evaluate(async () => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; await simFill(A.q, 60 + Math.floor(Math.random() * 40)); });
    if (i < 8) { await click(p, '[data-a="next"]'); await sleep(500); }
  }
});
await step('tabulate', async () => {
  await click(p, '[data-a="next"]'); await p.waitForSelector('.r0-table', { timeout: 15000 }); await sleep(800);
  await shot(p, '10-tabulate'); await shot(p, '10b-tabulate-full', true);
  await p.evaluate(() => { const { A, paint, loadAll, openSv, items, simFill, orderQs, setView } = window.__console; A.tabQ = 4; paint(); }); await sleep(300); await shot(p, '11-tabulate-fast');
});
await step('gate', async () => {
  await click(p, '[data-a="apply"]'); await sleep(600); await shot(p, '12-gate');
});
await step('game board', async () => {
  await click(p, '[data-a="begin"]'); await sleep(900); await shot(p, '13-game-round1');
  for (const k of ['1', '3', 'x']) { await p.keyboard.press(k); await sleep(150); }
  await sleep(300); await shot(p, '14-game-reveals');
  await click(p, '#linksBtn'); await sleep(300); await shot(p, '15-links-panel');
  await p.keyboard.press('Escape'); await sleep(200);
  await click(p, '#guideBtn'); await sleep(300); await shot(p, '16-host-guide');
  await p.keyboard.press('Escape'); await sleep(200);
  await click(p, '#editBtn'); await sleep(400); await shot(p, '17-editor');
  await p.keyboard.press('Escape'); await sleep(200);
  await p.evaluate(() => window.__console.setView('fast')); await sleep(400); await shot(p, '18-sai-five');
  await p.evaluate(() => window.__console.setView('rounds', 2)); await sleep(300);
  await p.keyboard.press('p'); await sleep(600); await shot(p, '19-presentation');
  await p.keyboard.press('p'); await sleep(300);
});
await p.close();

/* ---------- phone, projector, emcee (server mode) ---------- */
app.store.users.upsert('ravi@example.org', 'host');
const sid = app.store.surveys.create({ name: 'Sadhana Camp 2026 — Survey Says!', status: 'ready', code: 'SAI42', questions: [] });
app.store.live.set('SAI42', { surveyId: sid, phase: 'idle', q: -1, total: 9, hostNow: Date.now() });
const phone = await newPage(390, 844);
await step('phone', async () => {
  await phone.goto(base + '/play.html', { waitUntil: 'networkidle0' }); await shot(phone, '20-phone-join');
  await phone.goto(base + '/play.html?code=SAI42', { waitUntil: 'networkidle0' }); await sleep(500); await shot(phone, '21-phone-waiting');
  app.store.live.update('SAI42', { phase: 'open', q: 0, question: { en: 'Name something you can do to make a newcomer feel loved and welcome at a Sai gathering.' }, closesAt: Date.now() + 45000, seconds: 45, hostNow: Date.now() });
  await sleep(700); await shot(phone, '22-phone-question');
  await phone.type('#ans', 'Greet them with a warm smile'); await phone.click('#send'); await sleep(600); await shot(phone, '23-phone-sent');
  app.store.live.update('SAI42', { phase: 'closed', hostNow: Date.now() });
  await sleep(500); await shot(phone, '24-phone-closed');
  app.store.live.update('SAI42', { phase: 'done', hostNow: Date.now() });
  app.store.display.set('SAI42', { teams: { A: { name: 'Lotus', score: 140 }, B: { name: 'Tulsi', score: 95 } }, view: 'rounds', round: { n: 1, question: 'Name something kind' } });
  await sleep(700); await shot(phone, '25-phone-done');
});
await phone.close();
const tv = await newPage(1920, 1080);
await step('projector', async () => {
  const ans = (t, p, on) => (on ? { on: true, t, p } : { on: false });
  app.store.display.set('SAI42', { teams: { A: { name: 'Lotus', score: 140 }, B: { name: 'Tulsi', score: 95 } }, view: 'rounds', title: 'Sadhana Camp 2026', timerSeconds: 0, timerRunning: false, timerEndsAt: 0,
    round: { n: 2, of: 4, category: 'Daiva Preeti • Love for God', question: 'Name something a person can do to express love for God beyond prayer and devotional singing.', mult: 1,
      answers: [ans('Serve others selflessly', 29, true), ans('Help someone in need', 24, true), ans('', 0, false), ans('', 0, false), ans('', 0, false)], strikes: 1, control: 'A', steal: false, awarded: null } });
  await tv.goto(base + '/display.html?code=SAI42', { waitUntil: 'networkidle0' }); await sleep(900); await shot(tv, '30-projector-round');
  app.store.display.set('SAI42', { teams: { A: { name: 'Lotus', score: 260 }, B: { name: 'Tulsi', score: 215 } }, view: 'done', title: 'Sadhana Camp 2026', timerSeconds: 0, timerRunning: false, timerEndsAt: 0 });
  await sleep(900); await shot(tv, '31-projector-final');
});
await tv.close();
const em = await newPage(430, 900);
await step('emcee', async () => {
  await em.goto(base + '/emcee.html', { waitUntil: 'networkidle0' }); await sleep(400); await shot(em, '40-emcee-login');
  await em.goto(base + '/emcee.html?login=' + app.auth.createLoginLink('ravi@example.org').token, { waitUntil: 'networkidle0' }); await sleep(900); await shot(em, '41-emcee-list');
});
await em.close();

await browser.close();
await app.close();
console.log(errors.length ? `\nJS errors / failed steps:\n - ${errors.join('\n - ')}` : '\nNo JS errors.');
console.log('Screenshots in', OUT);
process.exit(0);
