/* Builds docs/Game-Show-Guide.pdf from docs/guide/guide.html with Chrome.
     node scripts/make-guide.mjs            (PREVIEW=/folder also saves a PNG of every page; CHROME_BIN if Chrome is elsewhere)
   Also checks that no page overflows its A4 sheet. */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = path.join(root, 'docs', 'guide', 'guide.html');
const out = path.join(root, 'docs', 'Game-Show-Guide.pdf');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.emulateMediaType('print');

// every page must fit its sheet: nothing may be clipped by overflow:hidden
const report = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p, i) => {
  const foot = p.querySelector('.foot').getBoundingClientRect(), box = p.getBoundingClientRect();
  let lowest = 0;
  for (const el of p.querySelectorAll('*')) { if (el.closest('.foot')) continue; const r = el.getBoundingClientRect(); if (r.height > 0) lowest = Math.max(lowest, r.bottom - box.top); }
  return { page: i + 1, contentBottomMm: +(lowest / 3.7795).toFixed(1), footerTopMm: +((foot.top - box.top) / 3.7795).toFixed(1), clipped: p.scrollHeight > p.clientHeight + 1 };
}));
let bad = 0;
for (const r of report) { const ok = r.contentBottomMm <= r.footerTopMm - 1 && !r.clipped; if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FIX '} page ${r.page}: content ends at ${r.contentBottomMm} mm, footer starts at ${r.footerTopMm} mm${r.clipped ? '  (CLIPPED)' : ''}`); }

if (process.env.PREVIEW) {
  fs.mkdirSync(process.env.PREVIEW, { recursive: true });
  const els = await page.$$('.page');
  for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: path.join(process.env.PREVIEW, `page-${i + 1}.png`) });
}
await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
const buf = fs.readFileSync(out);
const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`\nWrote ${out} (${Math.round(buf.length / 1024)} KB, ${pages} pages)`);
process.exit(bad ? 1 : 0);
