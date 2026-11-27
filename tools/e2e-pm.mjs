// PM Schedule: dates from part lifespan, predictable parts only, stock check, "Done" fills the
// OUT form, and the "Export for VELOXA" file imported by VELOXA's own import code (run here
// with a fake Firestore): first import adds tasks, importing it again updates them.
// Run: npm run e2e:pm      (VELOXA part needs ../veloxa-pm checked out next to this repo)
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import XLSX from 'xlsx';
import admin from 'firebase-admin';

mkdirSync('screenshots', { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });
const server = spawn('npx', ['-y', 'serve', '-l', '5063', 'public'], { stdio: 'ignore', detached: true });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5063';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// History: fuse 80FE on Line 1 every ~60 days (steady), bearing 100ET on Line 2 at random gaps
admin.initializeApp({ projectId: 'demo-sparetrack' });
const db = admin.firestore();
const pdocs = (await db.collection('tenants/mnsb/parts').get()).docs;
const P = code => pdocs.find(d => d.data().code === code);
const fuse = P('MAINTE00311'), bussman = P('MAINTE00020'), fitting = P('MAINTP00030');
await fitting.ref.update({ qty: 0 });
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const hist = [
  [fuse, 'Line 1', [245, 185, 124, 64, 4]],        // gaps 60,61,60,60 -> PM at 85% = 51 d after the last
  [fitting, 'Press 2', [205, 145, 86, 40]],         // gaps 60,59,46: steady enough; last 40 ago -> PM 85%*55=47 -> in 7 d
  [bussman, 'Line 2', [300, 290, 150, 140, 20]],    // gaps 10,140,10,120 -> not predictable
];
let n = 0;
for (const [p, m, agos] of hist) for (const a of agos)
  await db.doc(`tenants/mnsb/transactions/h${n++}`).set({ partId: p.id, partName: p.data().name, type: 'out', qty: 1, date: day(a), machine: m, user: 'Ali', createdAt: Date.now() - a * 864e5 });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
let file = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    if (/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/.test(r.request().url())) return r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/xlsx/dist/xlsx.full.min.js') });
    return r.abort();
  });
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + r.request().url().split('/').pop(), 'utf8') }));
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/.test(e.message)) console.log('  [pageerror]', e.message); });
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', 'manager@mnsb.test'); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && parts.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(800);

  check('PM in the menu, before Help', await p.evaluate(() => { const b = [...document.querySelectorAll('.nav-btn')]; return b.indexOf(document.getElementById('nav-pm')) >= 0 && b.indexOf(document.getElementById('nav-pm')) < b.indexOf(document.getElementById('nav-help')); }));
  await p.click('#nav-pm');
  await p.waitForFunction(() => document.querySelectorAll('#pm-list .pm-item').length > 0, null, { timeout: 15000 });
  // Default view: next 7 days (+ overdue)
  const first = await p.evaluate(() => ({ sel: document.getElementById('pm-horizon').value, codes: pmRows.map(r => r.code) }));
  check('Opens on "next 7 days": only the job due within a week', first.sel === '7' && first.codes.join() === 'MAINTP00030', JSON.stringify(first));
  await p.selectOption('#pm-horizon', '14');
  check('Next 14 days: still nothing else, tells when the next PM is', await p.evaluate(() => pmRows.length) === 1);
  await p.selectOption('#pm-horizon', '30');
  await p.evaluate(() => { document.getElementById('pm-q').value = 'zzz'; renderPm(); });
  check('Empty period explains how to see later jobs', /choose a longer period/.test(await p.textContent('#pm-list')) || /Nothing due/.test(await p.textContent('#pm-list')));
  await p.evaluate(() => { document.getElementById('pm-q').value = ''; renderPm(); });
  await p.selectOption('#pm-horizon', '90');
  check('Choice remembered on this device', await p.evaluate(() => pmDays()) === 90);
  const rows = await p.evaluate(() => pmRows.map(r => ({ code: r.code, m: r.machine, d: r.daysTo, avg: r.avg, short: r.short })));
  const f = rows.find(r => r.code === 'MAINTE00311'), fit = rows.find(r => r.code === 'MAINTP00030');
  check('Steady part scheduled at 85% of its life (fuse: ~60 d life, last 4 d ago -> in 47 d)', f && f.avg === 60 && f.d === 47, JSON.stringify(f));
  check('Fitting due within the week, stock 0 -> "order now"', fit && fit.d <= 7 && fit.short === true, JSON.stringify(fit));
  check('Random-life part not scheduled', !rows.some(r => r.code === 'MAINTE00020') && /not predictable/i.test(await p.textContent('#pm-list')));
  check('Sections: next 7 days ... after 30 days', /Next 7 days/.test(await p.textContent('#pm-list')) && /After 30 days/.test(await p.textContent('#pm-list')));
  await p.screenshot({ path: 'screenshots/70-pm-schedule.png' });
  await p.selectOption('#pm-pct', '100');
  check('PM % is adjustable (100% = Next change: in 56 d)', await p.evaluate(() => pmRows.find(r => r.code === 'MAINTE00311').daysTo) === 56);
  await p.selectOption('#pm-pct', '85');

  // Export for VELOXA
  const dl = p.waitForEvent('download');
  await p.click('#m-pm >> text=Export for VELOXA');
  const d = await dl;
  file = '.e2e-pm-veloxa.xlsx';
  await d.saveAs(file);
  const wb = XLSX.read(readFileSync(file)), aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  check('VELOXA file has the columns VELOXA reads', aoa[0].join('|') === 'Task|Start Date|End Date|Category|Notes|Priority|Assignee|SpareTrack Ref', aoa[0].join('|'));
  const fuseRow = aoa.find(r => /BUSSMAN 80FE/.test(r[0]));
  const due = new Date(Date.now() + 47 * 864e5);
  const dmy = String(due.getUTCDate()).padStart(2, '0') + '/' + String(due.getUTCMonth() + 1).padStart(2, '0') + '/' + due.getUTCFullYear();
  check('Task name, date (DD/MM/YYYY) and ref', fuseRow && /^PM: change .* — Line 1$/.test(fuseRow[0]) && fuseRow[1] === dmy && /^ST-PM\|/.test(fuseRow[7]), JSON.stringify(fuseRow));

  // Done -> OUT form with part and machine filled in
  await p.waitForSelector('#pm-list .pm-done');
  await p.evaluate(() => pmDone(pmRows.findIndex(r => r.code === 'MAINTE00311')));
  await p.waitForTimeout(300);
  check('"Done" opens the OUT form with machine and note filled', await p.evaluate(() => document.getElementById('m-txn').classList.contains('open') && document.getElementById('t-machine').value === 'Line 1' && document.getElementById('t-note').value === 'PM replacement' && document.getElementById('t-type').value === 'out'));
  await ctx.close();
} catch (e) { console.error('E2E error:', e); results.push(false); }
await browser.close();
try { process.kill(-server.pid); } catch (e) { server.kill(); }

// ── VELOXA import (its own code, fake Firestore) ──
const VX = '../veloxa-pm/public/app.html';
if (file && existsSync(VX)) {
  const html = readFileSync(VX, 'utf8');
  const start = html.indexOf('let importParsedTasks = [];');
  const code = html.slice(start, html.indexOf('</script>', start));
  const store = [];
  const col = {
    add: async d => { store.push({ id: 't' + store.length, ...d }); return {}; },
    where: (f, op, v) => ({ limit: () => ({ get: async () => { const hit = store.filter(t => t[f] === v); return { empty: !hit.length, docs: hit.map(t => ({ ref: { update: async u => Object.assign(t, u) } })) }; } }) }),
  };
  const el = () => ({ style: {}, value: '', textContent: '', innerHTML: '', disabled: false, addEventListener() {}, appendChild() {} });
  const els = {};
  let toastMsg = '';
  const ctx = vm.createContext({
    XLSX, console, users: [], CP: { members: {} }, CPid: 'p1', CU: { uid: 'u1' },
    taskCol: () => col, showToast: m => { toastMsg = m; },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
    document: { getElementById: id => els[id] || (els[id] = el()), createElement: el },
    FileReader: class { readAsArrayBuffer(f) { this.onload({ target: { result: f.buf } }); } },
  });
  vm.runInContext(code + '\n;globalThis.__vx={processImportFile,confirmImportTasks,get rows(){return importParsedTasks}};', ctx);
  const vx = ctx.__vx;
  ctx.renderImportPreview = () => {};
  const buf = readFileSync(file);
  vx.processImportFile({ name: 'pm.xlsx', buf });
  const parsed = vx.rows.length;
  await vx.confirmImportTasks();
  const first = store.length, t0 = store.find(t => /BUSSMAN 80FE/.test(t.title));
  check('VELOXA import adds one task per PM job with start/due dates and the ref', parsed >= 2 && first === parsed && t0 && t0.startDate === t0.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t0.startDate) && t0.extRef && t0.source === 'sparetrack_pm', `${parsed} rows, ${first} tasks`);
  // Same file again (e.g. after changing the PM %): updates, no duplicates
  t0.startDate = t0.dueDate = '2000-01-01';
  vx.processImportFile({ name: 'pm.xlsx', buf });
  await vx.confirmImportTasks();
  check('Importing the same file again updates instead of duplicating', store.length === first && t0.startDate !== '2000-01-01' && /updated/.test(toastMsg), `${store.length} tasks · "${toastMsg}"`);
} else console.log('SKIP  VELOXA import check (../veloxa-pm not found)');

execSync('rm -f .e2e-pm-veloxa.xlsx');
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
