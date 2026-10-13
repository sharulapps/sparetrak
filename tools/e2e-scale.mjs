// Scaling checks on the emulators: device cache + delta sync, atomic stock
// movements, deletions reaching other devices, QR by document id (incl. stocktake),
// low-stock alert sent once, batched Excel import.
// Run: npm run e2e:scale
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import admin from 'firebase-admin';

mkdirSync('screenshots', { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });
const server = spawn('npx', ['-y', 'serve', '-l', '5055', 'public'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5055';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const results = [];
const ntfy = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + r.request().url().split('/').pop(), 'utf8') }));
  await ctx.route(/^https:\/\/ntfy\.sh\//, r => { const u = new URL(r.request().url()); ntfy.push({ title: u.searchParams.get('title') || '', body: r.request().postData() || '' }); r.fulfill({ status: 200, body: '{}' }); });
  return ctx;
}
async function open(ctx, email) {
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/.test(e.message)) console.log('  [pageerror]', e.message); });
  await p.goto(BASE + '/index.html');
  if (email) {
    await p.waitForSelector('#login-email', { state: 'visible' });
    await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  }
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && typeof sync !== 'undefined'
    && sync.unsubs.length === 4 && parts.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(1500);
  return p;
}
const stats = p => p.evaluate(() => ({ ...sync.stats, full: sync.stats.full.join(',') }));
const qtyOf = (p, id) => p.evaluate(id => (parts.find(x => x.id === id) || {}).qty, id);
async function move(p, id, type, qty) {
  await p.evaluate(([id, type, qty]) => { openTxn(id, type); document.getElementById('t-qty').value = String(qty); return saveTxn(); }, [id, type, qty]);
}
const serverQty = (p, id) => p.evaluate(async id => { const F = window._fs; const fsm = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'); return (await fsm.getDocFromServer(F.doc(F.db, 'parts', id))).data().qty; }, id);

try {
  // 1. First open reads from the server; reopening reads from the device cache
  const ctxA = await newContext();
  let a = await open(ctxA, 'admin@mnsb.test');
  let s = await stats(a);
  check('First open: full read from the server', s.full === 'parts,approvals,transactions' && s.serverDocs >= 5, JSON.stringify(s));
  await a.evaluate(() => syncSaveNow());
  await a.reload();
  a = await open(ctxA, null);
  s = await stats(a);
  check('Reopen: data comes from the device cache, 0 full reads', s.full === '' && s.cacheDocs >= 5 && s.serverDocs === 0, JSON.stringify(s));
  check('Reopen: delta listener returned nothing new', s.deltaDocs === 0, 'deltaDocs=' + s.deltaDocs);

  // 2. A second device sees changes through the delta listener
  const ctxB = await newContext();
  const b = await open(ctxB, 'manager@mnsb.test');
  const pid = await a.evaluate(() => parts.find(x => x.code === 'MAINTE00311').id);   // qty 12
  await move(a, pid, 'out', 2);
  await b.waitForFunction(id => parts.find(x => x.id === id).qty === 10, pid, { timeout: 10000 });
  check('OUT on device A shows on device B (delta)', true);
  const bTx = await b.evaluate(id => transactions.filter(t => t.partId === id).length, pid);
  check('…with its transaction record', bTx === 1);

  // 3. Concurrent OUT on two devices: increment() counts both
  await Promise.all([move(a, pid, 'out', 3), move(b, pid, 'out', 4)]);
  await a.waitForTimeout(1500);
  const q3 = [await qtyOf(a, pid), await qtyOf(b, pid), await serverQty(a, pid)];
  check('Two OUTs at the same moment: both counted (10-3-4=3)', q3.every(x => x === 3), JSON.stringify(q3));
  // Stale device tries to take more than the server has: refused by rules, nothing written
  const before = await a.evaluate(() => transactions.length);
  await b.evaluate(id => { parts.find(x => x.id === id).qty = 99; }, pid);      // pretend B's copy is stale
  await move(b, pid, 'out', 5);
  await b.waitForTimeout(1500);
  const toastB = await b.textContent('.toast');
  check('Stale OUT below zero is refused (no negative stock)', await serverQty(a, pid) === 3 && /Not enough stock/.test(toastB), toastB.trim());
  check('…and leaves no transaction behind', await a.evaluate(() => transactions.length) === before);
  check('…and device B is corrected back to the server value', await qtyOf(b, pid) === 3);

  // 4. Part edits keep the image (update instead of full rewrite)
  await a.evaluate(async id => { const { updateDoc, doc, db } = window._fs; await updateDoc(doc(db, 'parts', id), { img: 'data:image/jpeg;base64,AAAA' }); }, pid);
  await a.evaluate(id => { openEdit(id); document.getElementById('f-loc').value = 'M1/RACK-9'; return savePart(); }, pid);
  await b.waitForFunction(id => parts.find(x => x.id === id).loc === 'M1/RACK-9', pid, { timeout: 10000 });
  check('Editing a part keeps its image', await b.evaluate(id => !!parts.find(x => x.id === id).img, pid));

  // 5. Low-stock alert: once per step down, reset when stock recovers
  await a.evaluate(async () => { openAdd(); const v = (id, x) => document.getElementById(id).value = x; v('f-name', 'ALERT TEST BEARING'); v('f-code', 'ALRT-1'); v('f-qty', '5'); v('f-min', '3'); await savePart(); });
  await a.waitForFunction(() => parts.some(x => x.code === 'ALRT-1' && !x._local), null, { timeout: 10000 });
  const aid = await a.evaluate(() => parts.find(x => x.code === 'ALRT-1').id);
  const alerts = () => ntfy.filter(x => /LOW STOCK ALERT/.test(x.title) && x.body.includes('ALERT TEST BEARING')).length;
  const steps = [['out', 2, 0], ['out', 1, 1], ['out', 1, 1], ['out', 1, 2], ['in', 5, 2], ['out', 3, 3]];   // 3,2(near),1,0(low),5(ok),2(near)
  const seen = [];
  for (const [t, n] of steps) { await move(a, aid, t, n); await a.waitForTimeout(400); seen.push(alerts()); }
  check('ntfy sent only when stock gets worse, once, and again after it recovers', JSON.stringify(seen) === JSON.stringify(steps.map(x => x[2])), 'alerts after each step: ' + JSON.stringify(seen));
  check('Alert state stored on the part', await a.evaluate(id => parts.find(x => x.id === id).stockAlert, aid) === 'near');
  check('Opening the app sends no alert', await (async () => { const n = ntfy.length; const c = await open(ctxA, null); await c.waitForTimeout(3500); const ok = ntfy.length === n; await c.close(); return ok; })());

  // 6. Deleting on A removes the part on B
  await a.evaluate(id => { editId = id; return deletePart(); }, aid);
  await b.waitForFunction(id => !parts.some(x => x.id === id), aid, { timeout: 10000 });
  check('Deleted part disappears on the other device (deletions record)', true);

  // 7. QR by document id
  const fresh = await a.evaluate(async () => { const { addDoc, collection, db } = window._fs; return (await addDoc(collection(db, 'parts'), { name: 'QR ONLY PART', code: 'QR-1', qty: 4, min: 1, unit: 'pcs' })).id; });
  await b.waitForFunction(id => parts.some(x => x.id === id), fresh, { timeout: 10000 });
  await b.evaluate(id => { delete sync.docs.parts[id]; syncPublish('parts'); }, fresh);   // as if B hadn't received it yet
  const found = await b.evaluate(async id => { const p = await findScannedPart('ST:' + id); return p && p.name; }, fresh);
  check('QR ST:<id> not in the local list → one doc read by id', found === 'QR ONLY PART' && await b.evaluate(id => parts.some(x => x.id === id), fresh));
  const stk = await b.evaluate(id => { startStocktake(); let opened = null; const o = window.openVerify; window.openVerify = x => { opened = x; }; handleStkScan('ST:' + id); window.openVerify = o; stkSession = null; return opened; }, pid);
  check('Stocktake scanner accepts ST:<id> labels', stk === pid, String(stk));

  // 8. Batched Excel import: 1,203 rows (3 duplicates), one existing part updated
  ntfy.length = 0;
  const imp = await a.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 1200; i++) rows.push({ id: 'xl' + i, name: 'IMPORTED PART ' + i, code: 'IMP-' + String(i).padStart(4, '0'), cat: 'BULK', loc: 'IMPORT', unit: 'pcs', qty: 3, min: 1, max: null, supplier: '', leadtime: '', cost: null });
    rows.push({ ...rows[0], id: 'dup1', qty: 7 }, { ...rows[1], id: 'dup2' }, { ...rows[2], id: 'dup3' });
    rows.push({ id: 'upd', name: 'PNEUMATIC PARTS - PUSH IN FITTING EPU-8', code: 'MAINTP00030', cat: '', loc: '', unit: 'pcs', qty: 0, min: 1, max: 5, supplier: '', leadtime: '', cost: null });
    document.getElementById('upd-qty').checked = true;
    const commits = []; const W = window._fs.writeBatch;
    window._fs.writeBatch = d => { const b = W(d); const c = b.commit; b.commit = () => { commits.push(b.size()); return c(); }; return b; };
    const reads = sync.stats.serverDocs;
    excelImportData = rows;
    await confirmExcelImport();
    window._fs.writeBatch = W;
    return { commits, extraReads: sync.stats.serverDocs - reads, toast: document.querySelector('.toast').textContent };
  });
  check('Import writes in batches of ≤400', imp.commits.length === 4 && imp.commits.every(n => n <= 400), JSON.stringify(imp.commits));
  check('Import matches against loaded parts (no extra reads) and de-duplicates rows', imp.extraReads === 0 && /1200 added, 1 updated/.test(imp.toast), imp.toast.trim());
  await b.waitForFunction(() => parts.filter(x => x.cat === 'BULK').length === 1200, null, { timeout: 20000 });
  check('Imported parts reach the other device', true);
  check('Import: duplicate row in the file — last one wins', await a.evaluate(() => parts.find(x => x.code === 'IMP-0000').qty) === 7);
  await a.waitForTimeout(500);
  check('Import: part that dropped to 0 triggers one alert', ntfy.filter(x => x.body.includes('EPU-8')).length === 1, String(ntfy.length));

  // 9. Reopen after all that: still no full read, and only the newest change is re-read
  await a.waitForTimeout(1500);
  await a.evaluate(() => syncSaveNow());
  await a.reload();
  a = await open(ctxA, null);
  s = await stats(a);
  check('Reopen after 1,200-part import: 0 server reads', s.full === '' && s.serverDocs === 0 && s.deltaDocs === 0 && s.cacheDocs > 1200, JSON.stringify(s));

  // 10. Reports: older transactions are loaded only when needed
  // An old transaction (outside the 90-day window) written by the migration script
  admin.initializeApp({ projectId: 'demo-sparetrack' });
  await admin.firestore().doc('tenants/mnsb/transactions/old-1').set({ partId: pid, partName: 'OLD', type: 'in', qty: 4, date: '2026-03-01', user: 'Migrated', createdAt: Date.now() - 200 * 864e5 });
  await a.evaluate(() => { tab('rpt', [...document.querySelectorAll('.nav-btn')].find(b => /report/i.test(b.textContent)) || document.querySelector('.nav-btn')); });
  check('Stats say which period the IN/OUT totals cover', /IN \/ OUT since/.test(await a.textContent('#stat-grid')));
  await a.screenshot({ path: 'screenshots/40-report-window.png' });
  const hist = await a.evaluate(async () => { await loadFullHistory(); await new Promise(r => setTimeout(r, 300)); return { from: txnWindowFrom(), toast: document.querySelector('.toast').textContent }; });
  check('"Load full history" loads older transactions and remembers it', hist.from === 0 && /Loaded 1 older/.test(hist.toast) && await a.evaluate(() => transactions.some(t => t.id === 'old-1')) && !/IN \/ OUT since/.test(await a.textContent('#stat-grid')), JSON.stringify(hist));

  // 11. Signing out clears the device cache
  await a.evaluate(() => { window.confirm = () => true; return doLogout(); }).catch(() => {});
  await a.waitForSelector('#login-email', { state: 'visible', timeout: 15000 });
  const left = await a.evaluate(() => new Promise(r => { const q = indexedDB.open('sparetrack-cache'); q.onupgradeneeded = () => { r(0); }; q.onsuccess = () => { const d = q.result; if (!d.objectStoreNames.contains('kv')) { d.close(); return r(0); } const c = d.transaction('kv').objectStore('kv').count(); c.onsuccess = () => { d.close(); r(c.result); }; }; }));
  check('Sign out clears the cached company data', left === 0, 'entries left: ' + left);
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
