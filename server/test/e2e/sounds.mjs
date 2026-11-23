/* Renders every built-in sound offline in Chrome and checks it is audible, not clipped, and the right length.
   Optionally writes WAV files so a person can listen:   SOUNDS_OUT=/some/folder node test/e2e/sounds.mjs */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = process.env.SOUNDS_OUT;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
// name -> [seconds to render, min seconds of audible sound, max seconds of audible sound]
const SPEC = { ding: [3, 0.6, 2.4], buzzer: [2, 0.6, 1.4], timeup: [2, 0.8, 1.6], tick: [0.4, 0.02, 0.2], fanfare: [3, 1.0, 2.6], applause: [5, 2.0, 4.8],
  drumroll: [5, 3.0, 4.9], sting: [2, 0.4, 1.6], steal: [1.5, 0.5, 1.4], fastmoney: [3.5, 1.5, 3.2], intro: [7, 3.0, 6.5], thinking: [5, 3.0, 4.9] };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ path: path.join(root, 'sound.js') });
let fails = 0;
const wav = (samples, sr) => { const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40); samples.forEach((s, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2)); return b; };
for (const [name, [secs, minLen, maxLen]] of Object.entries(SPEC)) {
  const samples = await page.evaluate((n, s) => window.Sound._render(n, s), name, secs);
  const sr = 44100;
  let peak = 0, sum = 0, last = 0, clipped = 0;
  samples.forEach((v, i) => { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; if (a > 0.01) last = i; if (a >= 0.999) clipped++; });
  const rms = Math.sqrt(sum / samples.length), audible = last / sr;
  const ok = peak > 0.12 && peak < 0.995 && clipped < 5 && rms > 0.004 && audible >= minLen && audible <= maxLen;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} peak ${peak.toFixed(2)}  rms ${rms.toFixed(3)}  audible ${audible.toFixed(2)}s  clipped ${clipped}${ok ? '' : `  (expected ${minLen}-${maxLen}s, peak 0.12-0.99)`}`);
  if (OUT) fs.writeFileSync(path.join(OUT, name + '.wav'), wav(samples, sr));
}
/* your own files: a real WAV on a real server is found, decoded and used in place of the built-in sound */
import os from 'node:os';
import { createApp } from '../../src/index.js';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-'));
fs.mkdirSync(path.join(tmp, 'sounds'));
fs.copyFileSync(path.join(root, 'sound.js'), path.join(tmp, 'sound.js'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<html><body>x</body></html>');
const sr0 = 22050, n0 = Math.floor(sr0 * 0.3), tone0 = new Float32Array(n0).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / sr0));
fs.writeFileSync(path.join(tmp, 'sounds', 'buzzer.wav'), wav(Array.from(tone0), sr0));
fs.writeFileSync(path.join(tmp, 'sounds', 'my-song.mp3'), 'not a built-in name');
fs.mkdirSync(path.join(tmp, 'sounds', 'classic'));
fs.writeFileSync(path.join(tmp, 'sounds', 'classic', 'ding.wav'), wav(Array.from(tone0).map((v) => v * 0.8), sr0));
const app = await createApp({ dataDir: ':memory:', port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1', webRoot: tmp });
const base = `http://127.0.0.1:${await app.listen()}`;
const p2 = await browser.newPage();
await p2.goto(base + '/index.html');
await p2.addScriptTag({ url: base + '/sound.js' });
const loaded = await p2.evaluate(async () => { Sound.unlock(); const f = await Sound.loadFiles('sounds/'); return { f, played: Sound.play('buzzer'), state: Sound.state().files }; });
const own = JSON.stringify(loaded.f) === '["buzzer"]' && loaded.played === true;
if (!own) fails++;
console.log(`${own ? 'PASS' : 'FAIL'}  your own buzzer.wav is found, decoded and used  ${JSON.stringify(loaded)}`);
const pk = await p2.evaluate(async () => {
  const before = Sound.state().pack, avail = Sound.state().packs;
  await Sound.setPack('classic');
  const s1 = Sound.state(), ding = Sound.play('ding'), fallback = Sound.play('applause');   // 'applause' is not in the set: built-in is used
  await Sound.setPack('builtin');
  return { before, avail, pack: s1.pack, packFiles: s1.packFiles, ding, fallback, after: Sound.state().pack };
});
const packOk = pk.before === 'builtin' && pk.avail.includes('classic') && pk.pack === 'classic' && JSON.stringify(pk.packFiles) === '["ding"]' && pk.ding === true && pk.fallback === true && pk.after === 'builtin';
if (!packOk) fails++;
console.log(`${packOk ? 'PASS' : 'FAIL'}  sound set: built-in by default, "classic" loads its files, missing sounds fall back, can switch back  ${JSON.stringify(pk)}`);
// choosing a set BEFORE the sound is switched on (projector reload) is applied once it is
const p3 = await browser.newPage();
await p3.goto(base + '/index.html'); await p3.addScriptTag({ url: base + '/sound.js' });
const early = await p3.evaluate(async () => { Sound.setPack('classic'); const first = Sound.state().pack; Sound.unlock(); await Sound.loadFiles('sounds/'); return { first, later: Sound.state().pack, packFiles: Sound.state().packFiles }; });
const earlyOk = early.first === 'builtin' && early.later === 'classic' && JSON.stringify(early.packFiles) === '["ding"]';
if (!earlyOk) fails++;
console.log(`${earlyOk ? 'PASS' : 'FAIL'}  a set chosen before the sound is on is applied as soon as it is  ${JSON.stringify(early)}`);
await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
if (OUT) console.log('WAV files in', OUT);
process.exit(fails ? 1 : 0);
