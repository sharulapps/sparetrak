// Scan Part Label: the camera reads the code printed on a label ("E 20") and the
// app opens that part. Uses Chromium's fake camera fed with tests/fixtures/*.mjpeg
// (made by tools/make-label-fixtures.py) and the real Tesseract.js OCR from node_modules.
// Also checks the QR scanner still works as before.
// Run: npm run e2e:label
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('screenshots', { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });
const server = spawn('npx', ['-y', 'serve', '-l', '5057', 'public'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5057';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// Pinned CDN files the app asks for -> the same versions from node_modules
const LOCAL = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@5\.1\.1\/dist\/([\w.-]+)$/, 'node_modules/tesseract.js/dist/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@5\.1\.1\/([\w.-]+)$/, 'node_modules/tesseract.js-core/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/eng@1\.0\.0\/4\.0\.0_best_int\/([\w.-]+)$/, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/jsqr@1\.4\.0\/dist\/([\w.-]+)$/, 'node_modules/jsqr/dist/'],
];
const TYPES = { js: 'text/javascript', wasm: 'application/wasm', gz: 'application/gzip' };

async function session(fixture, email = 'tech@mnsb.test') {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      ...(fixture ? ['--use-file-for-fake-video-capture=' + resolve('tests/fixtures/' + fixture + '.mjpeg')] : [])],
  });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block', permissions: ['camera'] });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    const u = r.request().url();
    for (const [re, dir] of LOCAL) { const m = u.match(re); if (m) { const f = existsSync(dir + m[1]) ? dir + m[1] : dir + m[1].replace('.min', ''); return r.fulfill({ contentType: TYPES[m[1].split('.').pop()] || 'application/octet-stream', body: readFileSync(f) }); } }
    return r.abort();
  });
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + r.request().url().split('/').pop(), 'utf8') }));
  const p = await ctx.newPage();
  p.on('pageerror', e => { if (!/emailjs/.test(e.message)) console.log('  [pageerror]', e.message); });
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && parts.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(800);
  return { browser, p };
}
async function readWithCamera(p) {
  await p.click('.label-scan-btn');
  await p.waitForFunction(() => { const v = document.getElementById('lbl-video'); return v.videoWidth > 0; }, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  await p.click('#lbl-read-btn');
  await p.waitForFunction(() => !lblBusy && /found|possible|no matching|No code|Could not/i.test(document.getElementById('lbl-status').textContent), null, { timeout: 90000 });
  return { status: (await p.textContent('#lbl-status')).trim(), text: await p.inputValue('#lbl-text') };
}

try {
  // 1. Label "E 20" -> MAINTE00020 opens straight away
  let { browser, p } = await session('label-e20');
  check('Camera button sits in the inventory search box', await p.isVisible('.label-scan-btn'));
  await p.screenshot({ path: 'screenshots/49-label-scan-button.png', clip: { x: 0, y: 0, width: 420, height: 420 } });
  let r = await readWithCamera(p);
  const found = (await p.textContent('#lbl-results')) || '';
  check('Label "E 20" read by the camera opens MAINTE00020', /Part found/.test(r.status) && /BUSSMAN 100ET/.test(found) && /MAINTE00020/.test(found), `read "${r.text}" · ${r.status}`);
  check('Technician gets Request OUT (approval flow kept)', /Request OUT/.test(found) && !/>IN</.test(found));
  await p.screenshot({ path: 'screenshots/50-label-scan-found.png' });
  await p.click('#lbl-found >> text=Request OUT');
  await p.waitForTimeout(300);
  check('Request OUT opens the normal transaction form for that part', await p.evaluate(() => document.getElementById('m-txn').classList.contains('open') && document.getElementById('t-pname').value.includes('BUSSMAN 100ET')));
  check('Closing hands the camera back (stream stopped)', await p.evaluate(() => lblStream === null && !document.getElementById('m-label').classList.contains('open')));
  await browser.close();

  // 2. Full code on the label
  ({ browser, p } = await session('label-maintw00015', 'admin@mnsb.test'));
  r = await readWithCamera(p);
  const found2 = (await p.textContent('#lbl-results')) || '';
  check('Label "MAINTW00015" opens the sealing head', /SEALING HEAD/.test(found2), `read "${r.text}"`);
  check('Admin gets IN / OUT / RTN', />IN</.test(await p.innerHTML('#lbl-found')) && /OUT/.test(found2) && /RTN/.test(found2));
  await p.click('#lbl-found >> text=Show in list');
  await p.waitForTimeout(300);
  check('"Show in list" filters the inventory to that part', await p.inputValue('#s-inv') === 'MAINTW00015' && (await p.$$('#parts-list .part-card')).length === 1);
  await browser.close();

  // 3. A code that doesn't exist: message, nothing opened; typing still works
  ({ browser, p } = await session('label-x99'));
  r = await readWithCamera(p);
  check('Unknown code "X 99" says no matching part', /no matching part/i.test(r.status) && !(await p.$('#lbl-found')), `read "${r.text}" · ${r.status}`);
  await p.fill('#lbl-text', 'e 311');
  await p.click('#m-label .lbl-row button');
  await p.waitForTimeout(300);
  const typed = (await p.textContent('#lbl-results')) + ' · ' + (await p.textContent('#lbl-status'));
  check('Typing "e 311" in the box opens MAINTE00311', /BUSSMAN 80FE/.test(typed), typed.slice(0, 160));
  await p.evaluate(() => closeLabelScan());

  // 4. Reading rules without the camera: OCR mix-ups in the number, several matches
  const cands = await p.evaluate(() => [labelCandidates('E 2O'), labelCandidates('MAINTW OOO15'), labelCandidates('ehq-l2')]);
  check('O/I/L mix-ups in the number are fixed', cands[0].includes('E20') && cands[1].includes('MAINTW00015') && cands[2].includes('EHQ12'), JSON.stringify(cands));
  await p.evaluate(() => { openLabelScan(); handleLabelText('MAINT'); });
  await p.waitForTimeout(300);
  check('Several matches -> a list to pick from', (await p.$$('#lbl-results .lbl-item')).length >= 2 && !(await p.$('#lbl-found')));
  await p.evaluate(() => closeLabelScan());

  // 5. QR scanner unchanged
  const pid = await p.evaluate(() => parts.find(x => x.code === 'MAINTE00020').id);
  await p.evaluate(() => openScanner());
  await p.waitForTimeout(800);
  await p.evaluate(id => handleScan('ST:' + id), pid);
  await p.waitForTimeout(500);
  check('QR scanner still finds ST:<id> and shows its buttons', /BUSSMAN 100ET/.test(await p.textContent('#scan-part-name')) && /OUT/.test(await p.textContent('#scan-result')));
  await p.evaluate(() => closeScanner());
  await browser.close();
} catch (e) {
  console.error('E2E error:', e);
  results.push(false);
} finally {
  server.kill();
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
