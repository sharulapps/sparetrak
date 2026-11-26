// Part Lifespan: machine on OUT / RETURN / Request OUT, days between OUTs per part + machine,
// returns subtracted, history older than the 90-day window loaded for the report.
// Run: npm run e2e:life
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import admin from 'firebase-admin';

mkdirSync('screenshots', { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });
const server = spawn('npx', ['-y', 'serve', '-l', '5059', 'public'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5059';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// History written by an old import: OUTs months ago (outside the 90-day window)
admin.initializeApp({ projectId: 'demo-sparetrack' });
const db = admin.firestore();
const parts = await db.collection('tenants/mnsb/parts').get();
const bearing = parts.docs.find(d => d.data().code === 'MAINTE00311');
await bearing.ref.update({ cost: 12.5 });
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const old = [[300, 'Line 1'], [230, 'Line 1'], [160, 'Line 1'], [280, 'Line 3'], [200, 'Line 3']];
for (const [i, [ago, m]] of old.entries())
  await db.doc(`tenants/mnsb/transactions/old${i}`).set({ partId: bearing.id, partName: bearing.data().name, type: 'out', qty: 1, date: day(ago), machine: m, user: 'Ali', createdAt: Date.now() - ago * 864e5 });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    if (/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/.test(r.request().url()))
      return r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/xlsx/dist/xlsx.full.min.js') });
    return r.abort();
  });
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + r.request().url().split('/').pop(), 'utf8') }));
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/.test(e.message)) console.log('  [pageerror]', e.message); });
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && parts.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(800);
  return p;
}
async function move(p, type, qty, date, machine) {
  await p.evaluate(([id, type]) => openTxn(id, type), [bearing.id, type]);
  await p.fill('#t-qty', String(qty)); await p.fill('#t-date', date);
  if (machine != null) await p.fill('#t-machine', machine);
  await p.evaluate(() => saveTxn());
  await p.waitForTimeout(700);
}

try {
  let p = await open('manager@mnsb.test');
  await p.evaluate(id => openTxn(id, 'in'), bearing.id);
  check('Machine field hidden for IN', await p.isHidden('#t-machine-wrap'));
  await p.evaluate(() => closeM('m-txn'));
  await p.evaluate(id => openTxn(id, 'out'), bearing.id);
  check('Machine field shown for OUT', await p.isVisible('#t-machine-wrap'));
  await p.evaluate(() => closeM('m-txn'));

  // Line 1: every ~70 days (300, 230, 160 days ago) and now 90 days ago, then today
  await move(p, 'out', 1, day(90), 'Line 1');
  await move(p, 'out', 2, day(20), ' line  1 ');          // same machine, typed differently
  await move(p, 'return', 1, day(19), 'Line 1');           // 1 of the 2 back: still an OUT
  await move(p, 'out', 1, day(5), 'Line 3');
  await move(p, 'out', 1, day(4), 'Line 3');
  await move(p, 'return', 1, day(4), 'Line 3');            // the last Line 3 OUT fully returned
  const saved = await p.evaluate(() => transactions.filter(t => t.type !== 'in').slice(-6).map(t => t.machine));
  check('Machine saved on OUT and RETURN', saved.join('|') === 'Line 1|line 1|Line 1|Line 3|Line 3|Line 3', saved.join('|'));
  await p.evaluate(id => openTxn(id, 'out'), bearing.id);
  const opts = await p.$$eval('#machine-list option', os => os.map(o => o.value));
  check('Machines used before are suggested, one per machine', opts.includes('Line 1') && opts.includes('Line 3') && opts.length === 2, opts.join(', '));
  await p.evaluate(() => closeM('m-txn'));

  // Technician request carries the machine through approval
  const t = await open('tech@mnsb.test');
  await t.evaluate(id => openTxn(id, 'out'), bearing.id);
  await t.fill('#t-qty', '1'); await t.fill('#t-machine', 'Waterjet');
  await t.evaluate(() => saveTxn());
  await t.waitForTimeout(800);
  await t.context().close();
  await p.waitForFunction(() => approvalRequests.some(r => r.status === 'pending' && r.machine === 'Waterjet'), null, { timeout: 10000 });
  await p.evaluate(() => approveRequest(approvalRequests.find(r => r.status === 'pending' && r.machine === 'Waterjet').id));
  await p.waitForFunction(() => transactions.some(t => t.approvalId && t.machine === 'Waterjet'), null, { timeout: 10000 });
  check('Request OUT -> approved transaction keeps the machine', true);
  await p.evaluate(() => tab('txn', document.querySelectorAll('.nav-btn')[1]));
  check('Txn list shows the machine', /Waterjet/.test(await p.textContent('#txn-list')));

  // Report
  await p.evaluate(() => tab('rpt', [...document.querySelectorAll('.nav-btn')].find(b => /report/i.test(b.textContent))));
  await p.click('#life-open');
  await p.waitForFunction(() => document.querySelectorAll('#life-list .life-card').length > 0, null, { timeout: 15000 });
  check('Older history loaded for the report', await p.evaluate(() => transactions.some(t => t.id === 'old0')));
  const rows = await p.evaluate(() => lifeRows.map(r => ({ m: r.machine, outs: r.outs, avg: r.avg, gaps: r.events.map(e => e.gap), st: r.status, perYear: r.perYear })));
  const l1 = rows.find(r => /line 1/i.test(r.m)), l3 = rows.find(r => /line 3/i.test(r.m));
  check('Line 1: 5 OUTs, ~70 days apart', l1 && l1.outs === 5 && JSON.stringify(l1.gaps) === '[null,70,70,70,70]' && l1.avg === 70, JSON.stringify(l1));
  check('Use per year: Line 1 4 pcs over 280 days = 5.2 / year; Line 3 2 over 275 = 2.7', l1 && l1.perYear === 5.2 && l3 && l3.perYear === 2.7, `${l1 && l1.perYear} / ${l3 && l3.perYear}`);
  check('Use per year shown on the card', /Uses ~5\.2 pcs\/year/.test(await p.textContent('#life-list')));
  check('Line 3: returned OUT not counted (280, 200, 5 days ago)', l3 && l3.outs === 3 && JSON.stringify(l3.gaps) === '[null,80,195]', JSON.stringify(l3));
  check('Waterjet (one OUT) needs more data', (await p.evaluate(() => document.getElementById('life-filter').value = 'all') && true) && await p.evaluate(() => { renderLife(); return lifeRows.some(r => r.machine === 'Waterjet' && r.avg == null); }));
  await p.evaluate(() => { document.getElementById('life-filter').value = 'data'; renderLife(); });
  await p.click('#life-list .life-card >> nth=0');
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'screenshots/60-part-lifespan.png' });
  await p.selectOption('#life-group', 'part');
  const one = await p.evaluate(() => lifeRows.map(r => r.perYear));
  check('"Part only" groups all machines together, use per year for all (8 pcs over 300 days = 9.7)', one.length === 1 && one[0] === 9.7, JSON.stringify(one));
  await p.selectOption('#life-group', 'machine');
  await p.fill('#life-q', 'line 3');
  check('Search filters by machine', await p.evaluate(() => lifeRows.length === 1 && /line 3/i.test(lifeRows[0].machine)));
  const dl = p.waitForEvent('download');
  await p.click('#m-life >> text=Export Excel');
  check('Export Excel downloads the report', /Part_Lifespan/.test((await dl).suggestedFilename()));
  // Budget: yearly use x unit cost
  await p.evaluate(() => closeM('m-life'));
  await p.click('#bud-open');
  await p.waitForSelector('#bud-body .bud-tile', { timeout: 15000 });
  const b = await p.evaluate(() => budRows.find(r => r.code === 'MAINTE00311'));
  check('Budget: 9.7/year + 10% -> plan 11 x RM 12.50 = RM 137.50', b && b.qty === 11 && b.yearCost === 137.5 && b.method === 'Rate from history', JSON.stringify(b && { qty: b.qty, cost: b.yearCost, m: b.method }));
  check('Budget: to buy = plan - stock on hand', b && b.buy === Math.max(0, 11 - b.stock) && b.buyCost === b.buy * 12.5, b && `stock ${b.stock}, buy ${b.buy}`);
  await p.selectOption('#bud-extra', '0');
  check('Contingency changes the plan (0% -> 10 pcs)', await p.evaluate(() => budRows.find(r => r.code === 'MAINTE00311').qty) === 10);
  check('Yearly budget tile shows the total', /Yearly budget[\s\S]*RM 125\.00/.test(await p.textContent('#bud-body')), (await p.textContent('#bud-body .bud-tile')).trim());
  await p.screenshot({ path: 'screenshots/61-budget.png' });
  const dl2 = p.waitForEvent('download');
  await p.click('#m-bud >> text=Export Excel');
  check('Budget Excel downloads', /SpareTrack_Budget_/.test((await dl2).suggestedFilename()));
} catch (e) {
  console.error('E2E error:', e);
  results.push(false);
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
