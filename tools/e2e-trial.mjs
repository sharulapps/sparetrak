// Free-trial walkthrough on the emulators: self sign-up, 10-part / 3-user limits
// (checked in the UI and against the rules directly), Excel import skipping,
// and the owner upgrading the company.
// Run: npm run e2e:trial
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });
const server = spawn('npx', ['-y', 'serve', '-l', '5053', 'public'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5053';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function newPage(w = 1366, h = 860) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  await p.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + r.request().url().split('/').pop(), 'utf8') }));
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/.test(e.message)) console.log('  [pageerror]', e.message); });
  return p;
}
const inApp = p => p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex', null, { timeout: 20000 });
const lastToast = p => p.textContent('.toast');
async function addPart(p, name) {
  await p.evaluate(n => { openAdd(); document.getElementById('f-name').value = n; document.getElementById('f-qty').value = '3'; return savePart(); }, name);
}
async function signup(p, company, name, email, pass = 'demo1234') {
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.click('text=Start a free trial');
  await p.fill('#su-company', company); await p.fill('#su-name', name);
  await p.fill('#su-email', email); await p.fill('#su-pass', pass);
}

try {
  // 1. Self sign-up
  let p = await newPage();
  await signup(p, 'Delta Plastics Sdn Bhd', 'Farah', 'farah@delta.test');
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/30-trial-signup.png` });
  await p.click('#signup-btn');
  await inApp(p);
  await p.waitForTimeout(1200);
  check('Sign-up lands in the new company', (await p.textContent('#tenant-name')).includes('Delta Plastics'));
  const tid = await p.evaluate(() => TID);
  check('Company is a free trial with 3 users / 10 parts', await p.evaluate(() => TENANT.plan === 'trial' && TENANT.maxUsers === 3 && TENANT.maxParts === 10 && currentUser.role === 'admin'), tid);
  check('Plan banner shows usage', /Free trial[\s\S]*Parts\s*0\s*\/\s*10[\s\S]*Users\s*1\s*\/\s*3/.test(await p.textContent('#plan-banner')));

  // 2. Ten parts fit, in slot-1..slot-10
  for (let i = 1; i <= 10; i++) await addPart(p, `TRIAL PART ${i}`);
  await p.waitForFunction(() => parts.length === 10, null, { timeout: 15000 });
  const ids = await p.evaluate(() => parts.map(x => x.id).sort());
  check('10 parts saved as slot-1..slot-10', ids.length === 10 && ids.every(id => /^slot-([1-9]|10)$/.test(id)), ids.join(','));
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/31-trial-10-parts.png` });

  // 3. The 11th is refused — in the UI, and by the rules if the UI is bypassed
  await p.evaluate(() => openAdd());
  await p.waitForTimeout(300);
  check('Add Part shows the plan limit message', /up to 10 parts/.test(await lastToast(p)) && !(await p.evaluate(() => document.getElementById('m-part').classList.contains('open'))));
  await p.screenshot({ path: `${OUT}/32-trial-part-limit.png` });
  const bypass = await p.evaluate(async () => {
    const fsm = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    const out = {};
    try { await fsm.addDoc(fsm.collection(window._fs.db, 'tenants', TID, 'parts'), { name: 'hack' }); out.randomId = 'WRITTEN'; } catch (e) { out.randomId = e.code; }
    try { await fsm.setDoc(fsm.doc(window._fs.db, 'tenants', TID, 'parts', 'slot-11'), { name: 'hack' }); out.slot11 = 'WRITTEN'; } catch (e) { out.slot11 = e.code; }
    try { await fsm.updateDoc(fsm.doc(window._fs.db, 'tenants', TID), { maxParts: 999 }); out.raise = 'WRITTEN'; } catch (e) { out.raise = e.code; }
    return out;
  });
  check('Rules block an 11th part and raising the limit from the console', bypass.randomId === 'permission-denied' && bypass.slot11 === 'permission-denied' && bypass.raise === 'permission-denied', JSON.stringify(bypass));

  // 4. Deleting a part frees its slot
  await p.evaluate(async () => { const { deleteDoc, doc, db } = window._fs; await deleteDoc(doc(db, 'parts', 'slot-3')); });
  await p.waitForFunction(() => parts.length === 9, null, { timeout: 10000 });
  await addPart(p, 'TRIAL PART REUSED');
  await p.waitForFunction(() => parts.some(x => x.id === 'slot-3' && x.name === 'TRIAL PART REUSED'), null, { timeout: 10000 });
  check('Deleted slot is reused', true);

  // 5. Excel import past the limit skips the extra rows
  await p.evaluate(async () => { const { deleteDoc, doc, db } = window._fs; await deleteDoc(doc(db, 'parts', 'slot-7')); });
  await p.waitForFunction(() => parts.length === 9, null, { timeout: 10000 });
  await p.evaluate(() => { excelImportData = [1, 2, 3].map(i => ({ name: 'IMPORTED ' + i, code: 'IMP-' + i, qty: 1, min: 0, unit: 'pcs' })); return confirmExcelImport(); });
  await p.waitForTimeout(1200);
  const importToast = await lastToast(p);
  check('Excel import adds what fits and reports the rest', /1 added/.test(importToast) && /2 skipped/.test(importToast), importToast.trim());

  // 6. Three users max
  await p.evaluate(() => tab('users', document.getElementById('nav-users')));
  for (const [n, e] of [['Ali', 'ali@delta.test'], ['Siti', 'siti@delta.test']]) {
    await p.evaluate(([n, e]) => { document.getElementById('nu-name').value = n; document.getElementById('nu-email').value = e; document.getElementById('nu-pass').value = 'demo1234'; return createUser(); }, [n, e]);
    await p.waitForTimeout(800);
  }
  check('Two more users added (3 / 3)', await p.evaluate(() => Number(TENANT.userCount)) === 3 && /Users\s*3\s*\/\s*3/.test(await p.textContent('#plan-banner')));
  await p.evaluate(() => { document.getElementById('nu-name').value = 'Fourth'; document.getElementById('nu-email').value = 'fourth@delta.test'; document.getElementById('nu-pass').value = 'demo1234'; return createUser(); });
  await p.waitForTimeout(500);
  check('4th user refused with plan message', /up to 3 users/.test(await lastToast(p)));
  const userBypass = await p.evaluate(async () => {
    const fsm = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    const db = window._fs.db, b = fsm.writeBatch(db);
    b.set(fsm.doc(db, 'tenants', TID, 'members', 'ghost-uid'), { name: 'Ghost', role: 'technician', status: 'active' });
    b.update(fsm.doc(db, 'tenants', TID), { userCount: fsm.increment(1) });
    try { await b.commit(); return 'WRITTEN'; } catch (e) { return e.code; }
  });
  check('Rules block a 4th member even from the console', userBypass === 'permission-denied', userBypass);
  await p.evaluate(() => tab('inv', document.querySelector('.nav-btn')));
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/33-trial-limits-reached.png` });
  await p.context().close();

  // 7. Signing up again with the same account just signs in (no second company)
  p = await newPage();
  await signup(p, 'Another Co', 'Farah', 'farah@delta.test');
  await p.click('#signup-btn');
  await inApp(p);
  await p.waitForTimeout(800);
  check('Same account cannot start a second trial', await p.evaluate(t => TID === t, tid));
  await p.context().close();

  // 8. Existing MNSB admin using the sign-up form stays in MNSB
  p = await newPage();
  await signup(p, 'Sneaky Co', 'X', 'admin@mnsb.test');
  await p.click('#signup-btn');
  await inApp(p);
  await p.waitForTimeout(800);
  check('Existing member is not given a new company', (await p.textContent('#tenant-name')).includes('Menang Nusantara'));
  await p.context().close();

  // 9. Wrong password for an existing email
  p = await newPage();
  await signup(p, 'Whatever', 'X', 'farah@delta.test', 'wrongpass');
  await p.click('#signup-btn');
  await p.waitForSelector('#signup-error', { state: 'visible', timeout: 10000 });
  check('Existing email + wrong password → "Sign in instead"', /already registered/.test(await p.textContent('#signup-error')));
  await p.context().close();

  // 10. Owner sees the trial and upgrades it
  p = await newPage();
  await p.goto(BASE + '/platform.html');
  await p.waitForSelector('#l-email', { state: 'visible' });
  await p.fill('#l-email', 'owner@sparetrack.test'); await p.fill('#l-pass', 'demo1234'); await p.click('#l-btn');
  await p.waitForSelector('#rows .tname', { timeout: 15000 });
  await p.waitForTimeout(600);
  check('Owner console lists the self sign-up trial', /Delta Plastics[\s\S]*Free trial[\s\S]*self sign-up/.test(await p.textContent('#rows')));
  await p.screenshot({ path: `${OUT}/34-platform-trial.png` });
  await p.click('tr:has-text("Delta Plastics") >> text=Upgrade');
  await p.waitForFunction(() => !document.querySelector('#rows').textContent.includes('Free trial'), null, { timeout: 10000 });
  await p.context().close();

  p = await newPage();
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', 'farah@delta.test'); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
  await inApp(p);
  await p.waitForFunction(() => parts.length === 10, null, { timeout: 15000 });
  await addPart(p, 'PART 11 AFTER UPGRADE');
  await p.waitForFunction(() => parts.length === 11, null, { timeout: 10000 });
  check('After upgrade an 11th part is allowed (normal id)', await p.evaluate(() => !/^slot-/.test(parts.find(x => x.name === 'PART 11 AFTER UPGRADE').id)));
  check('Plan banner hidden after upgrade', await p.evaluate(() => document.getElementById('plan-banner').style.display === 'none'));
  await p.context().close();

  // 11. Phone view of sign-up
  p = await newPage(390, 844);
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.click('text=Start a free trial');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/35-trial-signup-phone.png` });
  await p.context().close();
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
