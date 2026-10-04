// Rehearse the MNSB migration against the emulators: old-layout data in project
// "demo-old" is copied into a NEW project "demo-sparetrack" (the app's project).
// Run: npx firebase emulators:exec --only firestore,auth --project demo-sparetrack "node tools/test-migrate.mjs"
import { spawnSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import admin from 'firebase-admin';
import { chromium } from 'playwright';

const PROJECT = 'demo-sparetrack';   // new project (the app uses this one)
const OLD = 'demo-old';               // old live project
const AUTH = 'http://127.0.0.1:9099';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const run = (project, ...a) => {
  const r = spawnSync('node', ['migrate.mjs', ...a, '--project', project], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

admin.initializeApp({ projectId: PROJECT });
const oldApp = admin.initializeApp({ projectId: OLD }, 'old');
const db = oldApp.firestore();          // old data is seeded here
const newDb = admin.firestore();        // migrated data is checked here

// ── 1. Old single-tenant data, shaped like the live MNSB app ──────────────
for (const pr of [PROJECT, OLD]) {
  await fetch(`${AUTH}/emulator/v1/projects/${pr}/accounts`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${pr}/databases/(default)/documents`, { method: 'DELETE' });
}
// Login accounts exist only in the OLD project to begin with
async function authUser(email) {
  return (await oldApp.auth().createUser({ email, password: 'demo1234' })).uid;
}
const uAdmin = await authUser('admin@mnsb.test');
const uTech = await authUser('tech@mnsb.test');
const uStore = await authUser('store@mnsb.test');     // profile with a role the new rules don't know
const uOrphan = await authUser('orphan@mnsb.test');   // login with no users/ profile

let w = db.bulkWriter();
w.set(db.doc(`users/${uAdmin}`), { name: 'Sharul', email: 'admin@mnsb.test', role: 'admin', createdAt: Date.now() });
w.set(db.doc(`users/${uTech}`), { name: 'Hafiz', email: 'tech@mnsb.test', role: 'technician', createdAt: Date.now() });
w.set(db.doc(`users/${uStore}`), { name: 'Store', email: 'store@mnsb.test', role: 'storekeeper', createdAt: Date.now() });
const N_PARTS = 1500, N_TXN = 4000, N_APV = 60;
let qtySum = 0;
for (let i = 0; i < N_PARTS; i++) {
  const qty = i % 17;
  qtySum += qty;
  w.set(db.doc(`parts/p${i}`), { name: `PART ${i} - BEARING ${6200 + (i % 50)}`, code: `MAINT${String(i).padStart(5, '0')}`, cat: 'ALL M/C', loc: i % 2 ? 'M1/SL' : 'HQ/SL', qty, min: 2, max: 10, unit: 'pcs', ...(i === 0 ? { img: 'data:image/jpeg;base64,' + 'A'.repeat(20000) } : {}) });
}
for (let i = 0; i < N_TXN; i++) w.set(db.doc(`transactions/t${i}`), { partId: `p${i % N_PARTS}`, partName: `PART ${i % N_PARTS}`, type: i % 3 ? 'out' : 'in', qty: 1, date: '2026-09-01', user: 'Hafiz', createdAt: Date.now() - i * 1000 });
for (let i = 0; i < N_APV; i++) w.set(db.doc(`approvals/a${i}`), { partId: `p${i}`, qty: 1, status: i % 2 ? 'approved' : 'pending', requestedByUid: uTech, createdAt: Date.now() });
w.set(db.doc('transactions/t-ts'), { partId: 'p1', type: 'in', qty: 2, createdAt: Date.now(), when: admin.firestore.Timestamp.fromMillis(1759000000000) });
await w.close();
console.log(`Seeded old layout: ${N_PARTS} parts, ${N_TXN + 1} transactions, ${N_APV} approvals, 3 profiles + 1 orphan login`);

// ── 2. Export ─────────────────────────────────────────────────────────────
rmSync('backup', { recursive: true, force: true }); mkdirSync('backup');
let r = run(OLD, 'export');
const file = 'backup/' + readdirSync('backup').find(f => f.endsWith('.json'));
console.log(r.out.trim().split('\n').map(l => '    ' + l).join('\n'));
check('export wrote a backup file', r.code === 0 && file.endsWith('.json'));
const backup = JSON.parse(readFileSync(file, 'utf8'));
check('backup holds every old doc', backup.collections.parts.length === N_PARTS && backup.collections.transactions.length === N_TXN + 1);

// ── 3. Dry run writes nothing ────────────────────────────────────────────
r = run(PROJECT, 'import', file);
check('import into another project is refused without --to', r.code !== 0 && /--to demo-sparetrack/.test(r.out));
r = run(PROJECT, 'import', file, '--dry-run', '--to', PROJECT);
check('dry run writes nothing', (await newDb.collection('tenants').count().get()).data().count === 0);

// ── 4. Import in several runs (simulating the daily write cap) ───────────
let runs = 0;
do { r = run(PROJECT, 'import', file, '--max-writes', '2500', '--to', PROJECT); runs++; console.log('    run ' + runs + ': ' + r.out.trim().split('\n').pop()); }
while (r.code === 0 && !/complete/.test(r.out) && runs < 6);
check('import resumed across runs and completed', /complete/.test(r.out) && runs === 3, `${runs} runs`);
r = run(PROJECT, 'import', file, '--to', PROJECT);
check('re-running a finished import is a no-op', /Already complete/.test(r.out));

// ── 4b. Verify must fail until the login accounts are copied ─────────────
r = run(PROJECT, 'verify', file);
check('verify flags members with no login in the new project', r.code !== 0 && /no login account/.test(r.out));
// Simulates `firebase auth:export` (old) + `firebase auth:import` (new): same uid, email, password
for (const u of (await oldApp.auth().listUsers()).users)
  await admin.auth().createUser({ uid: u.uid, email: u.email, password: 'demo1234' });

// ── 5. Verify ─────────────────────────────────────────────────────────────
r = run(PROJECT, 'verify', file);
console.log(r.out.trim().split('\n').map(l => '    ' + l).join('\n'));
check('verify passes', r.code === 0);

// ── 6. Spot checks ───────────────────────────────────────────────────────
const m = id => newDb.doc(`tenants/mnsb/members/${id}`).get().then(s => s.data());
check('admin keeps admin role', (await m(uAdmin)).role === 'admin');
const store = await m(uStore);
check('unknown role becomes technician (old role kept)', store.role === 'technician' && store.previousRole === 'storekeeper');
check('login without profile is added', (await m(uOrphan))?.role === 'technician');
const ts = (await newDb.doc('tenants/mnsb/transactions/t-ts').get()).data().when;
check('Timestamp fields survive', ts instanceof admin.firestore.Timestamp && ts.toMillis() === 1759000000000);
check('part image copied', ((await newDb.doc('tenants/mnsb/parts/p0').get()).data().img || '').length > 20000);
check('old project untouched', (await db.collection('parts').count().get()).data().count === N_PARTS && (await db.collection('tenants').count().get()).data().count === 0);
check('ntfy topic kept', (await newDb.doc('tenants/mnsb').get()).data().settings.ntfyTopic === 'mnsb_sparepart');

// ── 7. New app on migrated data ──────────────────────────────────────────
const server = spawn('npx', ['-y', 'serve', '-l', '5051', 'public'], { stdio: 'ignore' });
await new Promise(res => setTimeout(res, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function login(email, w = 1366, h = 860) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, rt => rt.abort());
  await p.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, rt =>
    rt.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + rt.request().url().split('/').pop(), 'utf8') }));
  await p.goto('http://localhost:5051/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && document.querySelectorAll('#parts-list .part-card').length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(1000);
  return p;
}
try {
  let p = await login('admin@mnsb.test');
  const counts = await p.evaluate(() => ({ parts: parts.length, txns: transactions.length, tenant: document.getElementById('tenant-name').textContent }));
  check('admin sees all migrated parts and transactions', counts.parts === N_PARTS && counts.txns === N_TXN + 1, JSON.stringify(counts));
  await p.screenshot({ path: 'screenshots/20-migrated-mnsb-inventory.png' });
  const oldRead = await p.evaluate(async () => {
    const fsm = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    try { await fsm.getDocs(fsm.collection(window._fs.db, 'parts')); return 'READ OK'; } catch (e) { return e.code; }
  });
  check('old root collections are closed to the app', oldRead === 'permission-denied', oldRead);
  await p.evaluate(() => tab('users', document.getElementById('nav-users')));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'screenshots/21-migrated-users.png' });
  await p.context().close();
  p = await login('orphan@mnsb.test', 390, 844);
  check('user who had no profile can sign in', true);
  await p.context().close();
} catch (e) { console.error(e); results.push(false); }
await browser.close(); server.kill();

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
