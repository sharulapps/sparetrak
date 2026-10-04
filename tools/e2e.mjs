// End-to-end walkthrough of the multi-tenant prototype against the emulators.
// Run:  npx firebase emulators:exec --only firestore,auth --project demo-sparetrack "node tools/e2e.mjs"
// Saves screenshots to screenshots/ and prints a PASS/FAIL line per check.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });
execSync('node seed.mjs', { stdio: 'inherit' });

const server = spawn('npx', ['-y', 'serve', '-l', '5050', 'public'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5050';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const results = [];
const ntfyPosts = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function newPage(w = 1366, h = 860) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  // Block other CDNs; serve the Firebase SDK from node_modules (same version the app pins).
  // Playwright checks the most recently added route first, so the SDK route goes last.
  await p.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  await p.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(firebase-[a-z]+\.js)$/, (route) => {
    const file = route.request().url().split('/').pop();
    route.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/firebase/' + file, 'utf8') });
  });
  // QR library from node_modules; capture ntfy.sh posts instead of sending them
  await p.route('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', r =>
    r.fulfill({ contentType: 'text/javascript', body: readFileSync('node_modules/qrcodejs/qrcode.min.js', 'utf8') }));
  await p.route(/^https:\/\/ntfy\.sh\//, r => { const u = new URL(r.request().url()); ntfyPosts.push({ url: u.origin + u.pathname, title: u.searchParams.get('title') || '', priority: u.searchParams.get('priority') || '' }); r.fulfill({ status: 200, body: '{}' }); });
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  p.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ERR_FAILED') && !m.text().includes('Service Worker')) console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)); });
  return p;
}
async function appLogin(p, email) {
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', email);
  await p.fill('#login-pass', 'demo1234');
  await p.click('#login-btn');
}
async function waitApp(p) {
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex'
    && document.querySelectorAll('#parts-list .part-card').length > 0, null, { timeout: 15000 });
  await p.waitForTimeout(800);
}
const partNames = p => p.$$eval('#parts-list .pname', els => els.map(e => e.textContent.trim()));
const shot = (p, name, opts = {}) => p.screenshot({ path: `${OUT}/${name}.png`, ...opts });

try {
  // 1. Login screen
  let p = await newPage();
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.waitForTimeout(1200);
  await shot(p, '01-login');

  // 2. MNSB admin sees only MNSB
  await appLogin(p, 'admin@mnsb.test'); await waitApp(p);
  let names = await partNames(p);
  check('MNSB admin sees MNSB parts', names.some(n => n.includes('WATERJET')));
  check('MNSB admin does NOT see Contoh parts', !names.some(n => n.includes('CNC') || n.includes('COOLANT')));
  check('Header shows tenant name', (await p.textContent('#tenant-name')).includes('Menang Nusantara'));
  await shot(p, '02-mnsb-inventory');

  // 2b. Notifications card (admin): topic, QR, send test, generate new topic
  await p.evaluate(() => [...document.querySelectorAll('.nav-btn')].find(b => b.textContent.includes('Alert')).click());
  await p.waitForSelector('#ntfy-card code', { timeout: 10000 });
  const oldTopic = (await p.textContent('#ntfy-topic-text')).trim();
  check('Notifications card shows the company topic', /^st-mnsb-/.test(oldTopic), oldTopic);
  check('QR code rendered for the topic', !!(await p.$('#ntfy-qr canvas, #ntfy-qr img')));
  await p.evaluate(() => document.getElementById('ntfy-card').scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(500);
  await shot(p, '15-notifications-card-admin');
  await p.click('text=Send test notification');
  await p.waitForTimeout(800);
  check('Send test posts to this company\'s topic', ntfyPosts.some(x => x.url.endsWith('/' + oldTopic) && /test/i.test(x.title)), ntfyPosts.map(x => x.url).join(', '));
  await p.click('text=Generate new topic');
  await p.waitForFunction(t => document.getElementById('ntfy-topic-text').textContent.trim() !== t, oldTopic, { timeout: 10000 });
  const newTopic = (await p.textContent('#ntfy-topic-text')).trim();
  const saved = await p.evaluate(async () => {
    const { getDoc, rootDoc, db } = window._fs;
    return (await getDoc(rootDoc(db, 'tenants', TID))).data().settings.ntfyTopic;
  });
  check('New topic saved to Firestore', saved === newTopic && newTopic !== oldTopic, `${oldTopic} → ${newTopic}`);
  ntfyPosts.length = 0;
  await p.evaluate(() => { localStorage.removeItem(tenantKey('sp_ntfy_alert_date')); sendLowStockNtfy(reorderParts()); });
  await p.waitForTimeout(800);
  check('Low-stock alert goes to the new topic with title + high priority', ntfyPosts.some(x => x.url.endsWith('/' + newTopic) && /LOW STOCK ALERT - Menang Nusantara/.test(x.title) && x.priority === 'high'), JSON.stringify(ntfyPosts));
  await p.click('text=Change topic');
  await p.fill('#ntfy-edit-input', 'bad topic!');
  await p.click('#ntfy-edit >> text=Save');
  await p.waitForTimeout(600);
  check('Invalid topic name rejected', (await p.textContent('#ntfy-topic-text')).trim() === newTopic);
  await p.click('#ntfy-edit >> text=Cancel');
  await p.evaluate(() => tab('inv', document.querySelector('.nav-btn')));

  // 3. Direct read of another tenant from the browser console is refused by rules
  const hack = await p.evaluate(async () => {
    const { rootDoc, getDoc, db } = window._fs;
    const fsm = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    try { await fsm.getDocs(fsm.collection(db, 'tenants', 'contoh', 'parts')); return 'READ OK (BAD)'; }
    catch (e) { return e.code; }
  });
  check('Browser-console read of other tenant is denied', hack === 'permission-denied', hack);

  // 4. Tenant admin adds a user to own company
  await p.evaluate(() => tab('users', document.getElementById('nav-users')));
  await p.waitForSelector('#users-section-list div', { timeout: 10000 });
  await p.evaluate(() => { document.getElementById('m-users').classList.add('open'); loadUsers(); });
  await p.fill('#nu-name', 'Zul (Technician)');
  await p.fill('#nu-email', 'zul@mnsb.test');
  await p.fill('#nu-pass', 'demo1234');
  await p.selectOption('#nu-role', 'technician');
  await p.waitForTimeout(400);
  await shot(p, '03-mnsb-add-user-modal');
  await p.evaluate(() => createUser());
  await p.waitForFunction(() => (window.allUsers || allUsers).some(u => u.email === 'zul@mnsb.test'), null, { timeout: 10000 });
  await p.evaluate(() => closeM('m-users'));
  await p.waitForTimeout(800);
  check('Admin still signed in after creating a user', await p.evaluate(() => window._auth.auth.currentUser.email) === 'admin@mnsb.test');
  await shot(p, '04-mnsb-users-after-add');

  // 5. Disable a user
  const techUid = await p.evaluate(() => allUsers.find(u => u.email === 'tech@mnsb.test').uid);
  await p.evaluate(uid => toggleUserStatus(uid), techUid);
  await p.waitForTimeout(1000);
  await shot(p, '05-mnsb-user-disabled');

  // 6. Adding an email that already exists (Contoh's admin) is refused
  await p.evaluate(() => { document.getElementById('m-users').classList.add('open'); });
  await p.fill('#nu-name', 'Someone'); await p.fill('#nu-email', 'admin@contoh.test'); await p.fill('#nu-pass', 'demo1234');
  await p.evaluate(() => createUser());
  await p.waitForTimeout(1500);
  const toastTxt = await p.textContent('.toast');
  check('Cannot add an email that belongs to another company', /already registered/.test(toastTxt), toastTxt.trim());
  await p.close();

  // 7. New user signs in and lands in MNSB
  p = await newPage();
  await appLogin(p, 'zul@mnsb.test'); await waitApp(p);
  check('New user lands in MNSB', (await p.textContent('#tenant-name')).includes('Menang Nusantara'));
  await p.evaluate(() => [...document.querySelectorAll('.nav-btn')].find(b => b.textContent.includes('Alert')).click());
  await p.waitForSelector('#ntfy-card code', { timeout: 10000 });
  await p.evaluate(() => document.getElementById('ntfy-card').scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(500);
  check('Technician sees the topic but no admin buttons', !(await p.$('text=Generate new topic')) && !(await p.$('text=Send test notification')));
  await shot(p, '16-notifications-card-technician');
  await p.close();

  // 8. Disabled user is blocked
  p = await newPage();
  await appLogin(p, 'tech@mnsb.test');
  await p.waitForSelector('#login-error', { state: 'visible', timeout: 15000 });
  await p.waitForTimeout(500);
  check('Disabled user is blocked at login', /disabled/i.test(await p.textContent('#login-error')));
  await shot(p, '06-disabled-user-blocked');
  await p.close();

  // 9. Contoh admin sees only Contoh
  p = await newPage();
  await appLogin(p, 'admin@contoh.test'); await waitApp(p);
  names = await partNames(p);
  check('Contoh admin sees Contoh parts', names.some(n => n.includes('CNC')));
  check('Contoh admin does NOT see MNSB parts', !names.some(n => n.includes('WATERJET') || n.includes('BUSSMAN')));
  await shot(p, '07-contoh-inventory');
  await p.evaluate(() => tab('users', document.getElementById('nav-users')));
  await p.waitForTimeout(1500);
  const contohUsers = await p.evaluate(() => allUsers.map(u => u.email));
  check('Contoh user list has no MNSB users', !contohUsers.some(e => e.includes('mnsb')), contohUsers.join(', '));
  await shot(p, '08-contoh-users');
  await p.close();

  // 10. Platform owner console
  p = await newPage();
  await p.goto(BASE + '/platform.html');
  await p.waitForSelector('#l-email', { state: 'visible' });
  await p.fill('#l-email', 'owner@sparetrack.test'); await p.fill('#l-pass', 'demo1234');
  await p.click('#l-btn');
  await p.waitForSelector('#rows .tname', { timeout: 15000 });
  await p.waitForTimeout(600);
  await shot(p, '09-platform-tenants');
  await p.click('text=+ New Company');
  await p.fill('#c-name', 'Delta Plastics Sdn Bhd');
  await p.fill('#c-aname', 'Farah (Admin)'); await p.fill('#c-aemail', 'admin@delta.test'); await p.fill('#c-apass', 'demo1234');
  await p.waitForTimeout(300);
  await shot(p, '10-platform-new-company');
  await p.click('#c-btn');
  await p.waitForFunction(() => [...document.querySelectorAll('#rows .tname')].some(e => e.textContent.includes('Delta')), null, { timeout: 15000 });
  await p.click('tr:has-text("Contoh Precision") >> text=Suspend');
  await p.waitForFunction(() => document.querySelector('#rows').textContent.includes('suspended'), null, { timeout: 10000 });
  await p.waitForTimeout(600);
  await shot(p, '11-platform-after-create-and-suspend');
  check('Platform owner created a company', true);
  await p.close();

  // 11. New company admin signs in to an empty, separate tenant
  p = await newPage();
  await appLogin(p, 'admin@delta.test');
  await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex', null, { timeout: 15000 });
  await p.waitForTimeout(1500);
  check('New company starts empty', (await p.$$('#parts-list .part-card')).length === 0);
  check('New company header', (await p.textContent('#tenant-name')).includes('Delta'));
  await shot(p, '12-delta-empty-tenant');
  await p.close();

  // 12. Suspended company is locked out
  p = await newPage();
  await appLogin(p, 'admin@contoh.test');
  await p.waitForSelector('#login-error', { state: 'visible', timeout: 15000 });
  await p.waitForTimeout(500);
  check('Suspended company is blocked', /suspended/i.test(await p.textContent('#login-error')));
  await shot(p, '13-suspended-company-blocked');
  await p.close();

  // 13. Phone view
  p = await newPage(390, 844);
  await appLogin(p, 'manager@mnsb.test'); await waitApp(p);
  await shot(p, '14-phone-mnsb-manager');
  await p.close();
} catch (e) {
  console.error('E2E error:', e);
  try { for (const ctx of browser.contexts()) for (const pg of ctx.pages()) { await pg.screenshot({ path: OUT + '/zz-failure.png' }); console.log('  state:', await pg.evaluate(() => ({ login: document.getElementById('login-screen').style.display, app: document.getElementById('main-app').style.display, err: document.getElementById('login-error')?.textContent, tid: typeof TID !== 'undefined' ? TID : null, parts: (typeof parts !== 'undefined') ? parts.length : null }))); } } catch (_) {}
  results.push(['run completed', false]);
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
