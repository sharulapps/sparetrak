// Records the in-app tutorial videos (phone size, with captions and tap markers)
// on the Firebase emulators with demo data — never a live project.
//
//   v2 (this repo):  npm run tutorials
//   v1 (sharulapps/sparetrack, old single-company app):
//     TUT_APP=../sparetrack/public TUT_OUT=../sparetrack/public/tutorials npm run tutorials:v1
//   One video only: TUT_ONLY=03-stock-in-out npm run tutorials
//
// v1 hard-codes its live Firebase config, so its Firebase SDK files are replaced by
// small shims that force a demo project and connect to the emulators.
// Output: <out>/<id>.mp4, <out>/<id>.jpg (poster), <out>/tutorials.json
import { chromium } from 'playwright';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import admin from 'firebase-admin';

// Options: --flavor/--app/--out/--only, or env TUT_FLAVOR/TUT_APP/TUT_OUT/TUT_ONLY (easier through npm run)
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : (process.env['TUT_' + k.toUpperCase()] || d); };
const FLAVOR = arg('flavor', 'v2');
const APP = resolve(arg('app', 'public'));
const OUT = resolve(arg('out', 'public/tutorials'));
const ONLY = arg('only', '');
const TMP = resolve('.tutorial-tmp');
const PORT = 5071;
const BASE = `http://localhost:${PORT}`;
const W = 390, H = 780;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ── Demo data ─────────────────────────────────────────────
const DEMO_PARTS = [
  ['SWITCH SOCKET 13AMP PLASTIC', 'MAINTE00002', 'FACILITIES', 'M1/SL', 11, 1, 5, 'FUTURE CONTROL SUPPLIES'],
  ['BEARING 6205 2RS', 'MAINTEHQ00012', 'BEARING', 'HQ/SL', 8, 4, 20, 'SKF MALAYSIA'],
  ['WATERJET - GLAND COLLAR 1/4"', 'MAINTW00068', 'W/JET', 'M1/SL', 3, 2, 6, 'WIN-WIN WATERJET'],
  ['OIL & FLUID - HYDRAULIC OIL AW 68', 'MAINTM00041', 'OIL & FLUID', 'M1/SL', 12, 4, 30, 'PETRONAS LUBRICANTS'],
  ['ELECTRICAL PARTS - BUSSMAN 100ET', 'MAINTE00020', 'ALL M/C', 'M1/SL', 6, 3, 10, 'DPSTAR THERMO ELECTRIC'],
  ['PNEUMATIC PARTS - PUSH IN FITTING EPU-8', 'MAINTP00030', 'PNEUMATIC', 'M1/SL', 0, 1, 5, 'FUTURE CONTROL SUPPLIES'],
  ['WATERJET - SEALING HEAD ASSEMBLY', 'MAINTW00015', 'W/JET', 'HQ/SL', 1, 2, 5, 'WIN-WIN WATERJET'],
  ['V-BELT A42', 'MAINTM00107', 'BELT', 'M1/RACK-2', 9, 4, 8, 'GATES MALAYSIA'],
  ['FUSE 10A', 'MAINTE00311', 'ELECTRICAL', 'M1/RACK-3', 14, 10, 40, 'DPSTAR THERMO ELECTRIC'],
  ['GEAR MOTOR 0.75KW', 'MAINTM00220', 'MOTOR', 'HQ/SL', 2, 1, 3, 'SEW EURODRIVE'],
];
const USERS = [['Sharul (Admin)', 'admin@abc.test', 'admin'], ['Aiman (Manager)', 'manager@abc.test', 'manager'], ['Hafiz (Technician)', 'tech@abc.test', 'technician']];

let DB = null;
const partsPath = () => FLAVOR === 'v2' ? 'tenants/abc/parts' : 'parts';
// Demo company "ABC Sdn Bhd" — no real company data in the videos
const COMPANY = 'ABC Sdn Bhd';
async function seed() {
  const PROJECT = FLAVOR === 'v2' ? 'demo-sparetrack' : 'demo-v1';
  const app = admin.initializeApp({ projectId: PROJECT });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  const db = DB = app.firestore(), now = Date.now();
  if (FLAVOR === 'v2') await db.doc('tenants/abc').set({ name: COMPANY, status: 'active', plan: 'business', maxUsers: 50, maxParts: 0,
    userCount: USERS.length, createdAt: now, settings: { ntfyTopic: 'st-abc-k7q2mx' } });
  for (const [name, email, role] of USERS) {
    const u = await app.auth().createUser({ email, password: 'demo1234' });
    if (FLAVOR === 'v2') {
      await db.doc(`tenants/abc/members/${u.uid}`).set({ name, email, role, status: 'active', createdAt: now });
      await db.doc(`userTenants/${u.uid}`).set({ tenantId: 'abc' });
    } else await db.doc('users/' + u.uid).set({ name, email, role, createdAt: now });
  }
  const w = db.bulkWriter();
  DEMO_PARTS.forEach(([name, code, cat, loc, qty, min, max, supplier], i) =>
    w.set(db.doc(`${partsPath()}/demo${i + 1}`), { name, code, cat, loc, qty, min, max, unit: 'pcs', supplier, createdAt: now }));
  const txns = FLAVOR === 'v2' ? 'tenants/abc/transactions' : 'transactions';
  w.set(db.doc(txns + '/t1'), { partId: 'demo2', partName: 'BEARING 6205 2RS', type: 'in', qty: 10, date: '2026-11-03', note: 'PO 4512', user: 'Aiman (Manager)', createdAt: now - 864e5 });
  await w.close();
}

// ── Pinned CDN files -> same versions from node_modules ───
const LOCAL = [
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/, () => 'node_modules/xlsx/dist/xlsx.full.min.js'],
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcodejs\/1\.0\.0\/qrcode\.min\.js$/, () => 'node_modules/qrcodejs/qrcode.min.js'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@emailjs\/browser@4\/dist\/email\.min\.js$/, () => 'node_modules/@emailjs/browser/dist/email.min.js'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/jsqr@1\.4\.0\/dist\/jsQR\.min\.js$/, () => 'node_modules/jsqr/dist/jsQR.js'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@5\.1\.1\/dist\/([\w.-]+)$/, m => 'node_modules/tesseract.js/dist/' + m[1]],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@5\.1\.1\/([\w.-]+)$/, m => 'node_modules/tesseract.js-core/' + m[1]],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/eng@1\.0\.0\/4\.0\.0_best_int\/([\w.-]+)$/, m => 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/' + m[1]],
];
const TYPES = { js: 'text/javascript', wasm: 'application/wasm', gz: 'application/gzip' };
const SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';
const sdkFile = name => readFileSync('node_modules/firebase/' + name, 'utf8');
// v1 shims: demo project + emulators, everything else from the real SDK
const V1_SHIMS = {
  'firebase-app.js': `export * from '${SDK}real/firebase-app.js';
import {initializeApp as _i} from '${SDK}real/firebase-app.js';
export function initializeApp(o,n){ return _i({...o,apiKey:'demo-key',projectId:'demo-v1',authDomain:'localhost',appId:'demo'},n); }`,
  'firebase-firestore.js': `export * from '${SDK}real/firebase-firestore.js';
import {initializeFirestore as _i,getFirestore as _g,connectFirestoreEmulator as _c} from '${SDK}real/firebase-firestore.js';
const done=new WeakSet(); const c=d=>{ if(!done.has(d)){ done.add(d); try{_c(d,'127.0.0.1',8080);}catch(e){} } return d; };
export function initializeFirestore(app){ return c(_i(app,{})); }
export function getFirestore(app){ return c(_g(app)); }`,
  'firebase-auth.js': `export * from '${SDK}real/firebase-auth.js';
import {getAuth as _g,connectAuthEmulator as _c} from '${SDK}real/firebase-auth.js';
const done=new WeakSet();
export function getAuth(app){ const a=_g(app); if(!done.has(a)){ done.add(a); try{_c(a,'http://127.0.0.1:9099',{disableWarnings:true});}catch(e){} } return a; }`,
};

// ── Caption bar, title card and tap marker (injected into every page) ──
const OVERLAY = () => {
  const css = `#tut-cap{position:fixed;left:10px;right:10px;bottom:14px;z-index:2147483646;background:rgba(10,22,40,.92);color:#fff;
    font:600 15px/1.35 Inter,system-ui,sans-serif;padding:12px 14px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);
    pointer-events:none;transition:opacity .25s;opacity:0;border-left:4px solid #C9A24E}
  #tut-cap small{display:block;font-weight:500;font-size:12px;opacity:.75;margin-top:3px}
  #tut-title{position:fixed;inset:0;z-index:2147483647;background:linear-gradient(160deg,#0A1628,#1B3A6B);color:#fff;display:flex;
    flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;font-family:Inter,system-ui,sans-serif;transition:opacity .4s;pointer-events:none}
  #tut-title b{font-size:13px;letter-spacing:2px;color:#C9A24E;text-transform:uppercase}
  #tut-title h1{font-size:28px;margin:12px 0 10px;line-height:1.2}
  #tut-title p{font-size:15px;opacity:.8;margin:0}
  .tut-tap{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;z-index:2147483645;pointer-events:none;
    border:3px solid #C9A24E;background:rgba(201,162,78,.28);animation:tutTap .7s ease-out forwards}
  @keyframes tutTap{0%{transform:scale(.4);opacity:1}100%{transform:scale(1.5);opacity:0}}`;
  const add = () => {
    if (document.getElementById('tut-cap')) return;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'tut-cap'; document.body.appendChild(c);
  };
  window.__tut = {
    cap(t, sub) {
      add(); const c = document.getElementById('tut-cap'); c.innerHTML = t + (sub ? '<small>' + sub + '</small>' : ''); c.style.opacity = t ? 1 : 0;
      // a sheet is open: keep its buttons visible, put the caption at the top
      const top = !!document.querySelector('.overlay.open');
      c.style.top = top ? '14px' : 'auto'; c.style.bottom = top ? 'auto' : '14px';
    },
    title(t, sub) {
      add(); let e = document.getElementById('tut-title');
      if (!t) { if (e) { e.style.opacity = 0; setTimeout(() => e.remove(), 450); } return; }
      if (!e) { e = document.createElement('div'); e.id = 'tut-title'; document.body.appendChild(e); }
      e.innerHTML = '<b>SpareTrack tutorial</b><h1>' + t + '</h1><p>' + (sub || '') + '</p>';
    },
    tap(x, y) { add(); const d = document.createElement('div'); d.className = 'tut-tap'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d); setTimeout(() => d.remove(), 800); },
  };
  document.addEventListener('DOMContentLoaded', () => {
    add();
    for (const [id, ph] of [['login-email', 'name@company.com'], ['nu-email', 'ahmad@company.com']]) { const e = document.getElementById(id); if (e) e.placeholder = ph; }
  });
};

// ── Fake camera videos ────────────────────────────────────
function cameraFixture(name, pngPath) {
  const out = join(TMP, name + '.mjpeg');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', pngPath, '-vf',
    'scale=w=min(560\\,iw):h=min(400\\,ih):force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=0x5C626C',
    '-frames:v', '3', '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'mjpeg', out]);
  return out;
}

// ── Browser helpers ───────────────────────────────────────
let browser = null, browserCam = null;
async function launch(camera) {
  if (browser && browserCam === camera) return browser;
  if (browser) await browser.close();
  browserCam = camera;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(camera ? ['--use-file-for-fake-video-capture=' + camera] : [])],
  });
  return browser;
}
async function newPage(id, camera) {
  const b = await launch(camera);
  const dir = join(TMP, id); mkdirSync(dir, { recursive: true });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block', permissions: ['camera'],
    recordVideo: { dir, size: { width: W, height: H } }, acceptDownloads: true });
  await ctx.addInitScript(OVERLAY);
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    const u = r.request().url();
    const sdk = u.match(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(real\/)?(firebase-[a-z]+\.js)$/);
    if (sdk) {
      const body = FLAVOR === 'v1' && !sdk[1] && V1_SHIMS[sdk[2]] ? V1_SHIMS[sdk[2]] : sdkFile(sdk[2]);
      return r.fulfill({ contentType: 'text/javascript', body });
    }
    if (/^https:\/\/ntfy\.sh\//.test(u)) return r.fulfill({ status: 200, body: '{}' });
    for (const [re, f] of LOCAL) { const m = u.match(re); if (m) { const file = f(m); return r.fulfill({ contentType: TYPES[file.split('.').pop()] || 'application/octet-stream', body: readFileSync(file) }); } }
    return r.abort();
  });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/i.test(e.message)) console.log('  [pageerror]', e.message); });
  if (process.env.TUT_DEBUG) p.on('console', m => console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)));
  return p;
}
const wait = (p, ms) => p.waitForTimeout(ms);
async function title(p, t, sub, ms = 2600) { await p.evaluate(([a, b]) => window.__tut.title(a, b), [t, sub]); await wait(p, ms); await p.evaluate(() => window.__tut.title('')); await wait(p, 450); }
async function cap(p, t, sub = '', ms = 2600) { await p.evaluate(([a, b]) => window.__tut.cap(a, b), [t, sub]); await wait(p, ms); }
async function tap(p, sel, ms = 900) {
  const el = typeof sel === 'string' ? p.locator(sel).first() : sel;
  await el.scrollIntoViewIfNeeded();
  await wait(p, 250);
  const b = await el.boundingBox();
  if (b) await p.evaluate(([x, y]) => window.__tut.tap(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
  await wait(p, 380);
  await el.click();
  await wait(p, ms);
}
// Show where to tap without tapping
async function point(p, sel, ms = 900) {
  const el = typeof sel === 'string' ? p.locator(sel).first() : sel;
  await el.scrollIntoViewIfNeeded(); await wait(p, 250);
  const b = await el.boundingBox();
  for (let i = 0; i < 2 && b; i++) { await p.evaluate(([x, y]) => window.__tut.tap(x, y), [b.x + b.width / 2, b.y + b.height / 2]); await wait(p, 700); }
  await wait(p, ms);
}
async function typeIn(p, sel, text, ms = 600) {
  await tap(p, sel, 200);
  await p.locator(sel).first().fill('');
  await p.locator(sel).first().pressSequentially(String(text), { delay: 85 });
  await wait(p, ms);
}
const navBtn = (p, text) => p.locator('.nav-btn', { hasText: new RegExp('^\\s*' + text, 'i') });
async function goTab(p, text) { await tap(p, navBtn(p, text), 900); }
async function login(p, email, { show = true, intro = null } = {}) {
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  const t0 = Date.now();
  if (intro) await p.evaluate(([a, b]) => window.__tut.title(a, b), intro);
  if (show) { await typeIn(p, '#login-email', email, 200); await typeIn(p, '#login-pass', 'demo1234', 300); await tap(p, '#login-btn', 200); }
  else { await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn'); }
  try { await p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex' && document.querySelectorAll('#parts-list .part-card').length > 0, null, { timeout: 30000 }); }
  catch (e) {
    console.log('  login state:', JSON.stringify(await p.evaluate(() => ({ app: document.getElementById('main-app').style.display, err: (document.getElementById('login-error') || {}).textContent,
      status: (document.getElementById('firebase-status') || {}).textContent, parts: typeof parts !== 'undefined' ? parts.length : null, cards: document.querySelectorAll('#parts-list .part-card').length }))));
    throw e;
  }
  if (intro) { await wait(p, Math.max(600, 3000 - (Date.now() - t0))); await p.evaluate(() => window.__tut.title('')); await wait(p, 500); return; }
  await wait(p, 1200);
}
async function logout(p) {
  await tap(p, '#btn-logout', 300);
  await p.waitForSelector('#login-email', { state: 'visible', timeout: 15000 });
  await wait(p, 600);
}
const partId = (p, code) => p.evaluate(c => parts.find(x => x.code === c).id, code);
const card = (p, code) => p.locator('#parts-list .part-card', { hasText: code });
async function search(p, q) { await typeIn(p, '#s-inv', q, 900); }

// ── The tutorials ─────────────────────────────────────────
const TUTORIALS = [
  { id: '01-getting-started', title: 'Getting started', sub: 'Sign in and find your way around', roles: 'Everyone',
    async run(p) {
      await p.goto(BASE + '/index.html'); await p.waitForSelector('#login-email', { state: 'visible' });
      await title(p, 'Getting started', 'Sign in and find your way around');
      await cap(p, 'Sign in with the email and password your admin gave you');
      await login(p, 'manager@abc.test');
      await cap(p, 'This is the Inventory — every spare part with its stock level');
      await cap(p, 'Badges show the status', 'LOW STOCK = 0 · NEAR FINISH = below min · OVER STOCK = above max', 3200);
      await cap(p, 'Use the menu to move between sections', 'Inventory · Txn · Scan QR · Alert · Reports · Stocktake…', 1200);
      for (const t of ['Txn', 'Alert', 'Reports', 'Stocktake']) await goTab(p, t);
      await goTab(p, 'Inventory');
      await cap(p, 'Tap Help any time to watch these tutorials again', '', 300);
      await point(p, '#nav-help', 900);
      await p.locator('.nav-btn').first().scrollIntoViewIfNeeded();
      await cap(p, 'When you finish, tap SIGN OUT (on shared phones especially)', '', 1200);
      await tap(p, '#btn-logout', 1200);
      await cap(p, '', '', 400);
    } },
  { id: '02-search', title: 'Search parts', sub: 'Find a part fast by code, name or status', roles: 'Everyone',
    async run(p) {
      await login(p, 'tech@abc.test', { show: false, intro: ['Search parts', 'Find a part fast by code, name or status'] });
      await cap(p, 'Type just the short code from the label', 'Spaces and leading zeros don\'t matter', 1500);
      await search(p, 'ehq 12');
      await cap(p, '"ehq 12" finds MAINTEHQ00012', '', 2400);
      await search(p, 'w68');
      await cap(p, '"w68" finds MAINTW00068 only', 'A number inside a part name is not mixed in', 2600);
      await search(p, 'bearing');
      await cap(p, 'Or search by name, category or location', '', 2400);
      await p.fill('#s-inv', ''); await p.evaluate(() => { currentPage = 1; renderParts(); });
      await cap(p, 'Filter by stock status', '', 1000);
      await tap(p, '#f-low', 1800);
      await cap(p, 'Low Stock = nothing left', '', 1600);
      await tap(p, '#f-near', 1800);
      await cap(p, 'Near Finish = below the minimum', '', 1600);
      await tap(p, '#f-all', 1500);
      await cap(p, 'Tip: the camera button in the search box reads a part label', 'See the "Scan part label" tutorial', 3000);
    } },
  { id: '03-stock-in-out', title: 'Stock IN, OUT and Return', sub: 'Record every movement so stock stays right', roles: 'Admin · Manager · Engineer',
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Stock IN, OUT and Return', 'Record every movement so stock stays right'] });
      await search(p, 'm107');
      await cap(p, 'Find the part, then tap IN when new stock arrives');
      await tap(p, card(p, 'MAINTM00107').locator('.act.in'), 800);
      await typeIn(p, '#t-qty', '5');
      await typeIn(p, '#t-note', 'PO 4521 from supplier');
      await cap(p, 'Check the quantity, then save', '', 1600);
      await tap(p, '#m-txn .sub-btn', 1800);
      await cap(p, 'Stock goes up straight away — every phone sees it', '', 2600);
      await cap(p, 'Tap OUT when you take parts for a job');
      await tap(p, card(p, 'MAINTM00107').locator('.act.out'), 800);
      await typeIn(p, '#t-qty', '2');
      await typeIn(p, '#t-note', 'Line 3 conveyor');
      await tap(p, '#m-txn .sub-btn', 1800);
      await cap(p, 'RTN = return unused parts to the store');
      await tap(p, card(p, 'MAINTM00107').locator('.act', { hasText: 'RTN' }), 800);
      await typeIn(p, '#t-qty', '1');
      await tap(p, '#m-txn .sub-btn', 1800);
      await cap(p, 'Every movement is saved in Txn (history)', '', 1200);
      await goTab(p, 'Txn');
      await cap(p, 'Who, when, how many and why', '', 3000);
    } },
  { id: '04-request-approval', title: 'Request OUT and approval', sub: 'Technicians request · managers approve', roles: 'Technician · Manager',
    async run(p) {
      await login(p, 'tech@abc.test', { show: false, intro: ['Request OUT and approval', 'Technicians request · managers approve'] });
      await cap(p, 'Technicians tap Request OUT', 'Stock only changes after a manager approves', 1600);
      await search(p, 'e 311');
      await tap(p, card(p, 'MAINTE00311').locator('.act.out'), 800);
      await typeIn(p, '#t-qty', '3');
      await typeIn(p, '#t-note', 'Panel PM-12 breakdown');
      await tap(p, '#m-txn .sub-btn', 1800);
      await cap(p, 'The request is sent — managers get a phone alert', '', 2600);
      await cap(p, '', '', 100);
      await logout(p);
      await cap(p, 'The manager signs in…', '', 800);
      await login(p, 'manager@abc.test');
      await cap(p, '…and opens Approval', '', 800);
      await goTab(p, 'Approval');
      await wait(p, 600);
      await cap(p, 'Check the request, then Approve or Reject', 'Reject asks for a reason', 2600);
      await tap(p, p.locator('button[onclick^="approveRequest"]').first(), 1800);
      await cap(p, 'Approved: stock goes down and the movement is recorded', '', 2400);
      await goTab(p, 'Inventory');
      await search(p, 'e 311');
      await cap(p, 'FUSE 10A: 14 → 11 pcs', '', 2600);
    } },
  { id: '05-scan-qr', title: 'Scan a QR label', sub: 'Point the camera at the part\'s QR code', roles: 'Everyone', camera: 'qr',
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Scan a QR label', 'Point the camera at the part\'s QR code'] });
      await cap(p, 'Tap Scan QR', '', 900);
      await tap(p, navBtn(p, 'Scan QR'), 600);
      await cap(p, 'Hold the QR inside the square', 'Use Torch in a dark store, the slider to zoom', 2400);
      await p.waitForFunction(() => /found/i.test(document.getElementById('scan-status').textContent), null, { timeout: 20000 });
      await cap(p, 'Part found — check the name and stock', '', 2600);
      await cap(p, 'Then choose IN, OUT or RTN', '', 1200);
      await tap(p, '#scan-result .act.out', 900);
      await cap(p, 'Enter the quantity and save', '', 900);
      await typeIn(p, '#t-qty', '2');
      await typeIn(p, '#t-note', 'Panel PM-12');
      await tap(p, '#m-txn .sub-btn', 1600);
      await cap(p, 'Done. Print QR labels from each part\'s QR button', '', 2800);
    } },
  { id: '06-scan-label', title: 'Scan a part label', sub: 'The camera reads the code printed on the label', roles: 'Everyone', camera: 'label',
    async run(p) {
      await login(p, 'tech@abc.test', { show: false, intro: ['Scan a part label', 'No QR? The camera reads the printed code'] });
      await cap(p, 'Tap the camera in the search box', '', 900);
      await tap(p, '.label-scan-btn', 900);
      await cap(p, 'Fit only the part code inside the box', 'Hold steady · avoid glare · zoom in if it\'s small', 2800);
      await tap(p, '#lbl-read-btn', 300);
      await cap(p, 'Reading… (the first time it loads the reader)', '', 300);
      await p.waitForFunction(() => !lblBusy && /read as|possible|Not sure|no matching|No code/i.test(document.getElementById('lbl-status').textContent), null, { timeout: 90000 });
      await wait(p, 400);
      await cap(p, 'Check "Label read as…" matches the label', 'If unsure, the app lets you pick the right part', 3000);
      await cap(p, 'Then Request OUT / OUT / IN as usual', 'Wrong read? Fix the code in the box and tap Search', 3200);
    } },
  { id: '07-add-edit-part', title: 'Add and edit parts', sub: 'Keep the part list clean and complete', roles: 'Admin · Manager · Engineer',
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Add and edit parts', 'Keep the part list clean and complete'] });
      await cap(p, 'Tap + Add Part', '', 900);
      await tap(p, '.add-btn', 900);
      await cap(p, 'Name and part code first', 'Use the same code as on the shelf label', 900);
      await typeIn(p, '#f-name', 'PROXIMITY SENSOR M18');
      await typeIn(p, '#f-code', 'MAINTE00415');
      await cap(p, 'Then category, stock, min / max and location', '', 600);
      await typeIn(p, '#f-cat', 'SENSOR');
      await typeIn(p, '#f-qty', '4');
      await typeIn(p, '#f-min', '2');
      await typeIn(p, '#f-max', '6');
      await typeIn(p, '#f-loc', 'M1/RACK-5');
      await cap(p, 'Min / Max drive the Near Finish and Over Stock alerts', 'Supplier, lead time and unit cost are optional', 2600);
      await tap(p, '#m-part .sub-btn', 1600);
      await search(p, 'e 415');
      await cap(p, 'To change a part, tap the pencil', '', 1000);
      await tap(p, card(p, 'MAINTE00415').locator('.act').last(), 900);
      await cap(p, 'Change what you need, then save', '', 600);
      await typeIn(p, '#f-loc', 'M1/RACK-6');
      await tap(p, '#m-part .sub-btn', 1500);
      await cap(p, 'Tap the 📷 box to add a photo of the part', '', 2400);
      await cap(p, 'Tap the QR button to show and print its QR label', '', 900);
      await tap(p, card(p, 'MAINTE00415').locator('.act').nth(-2), 1800);
      await cap(p, 'Stick it on the shelf — then anyone can scan it', '', 2800);
    } },
  { id: '08-stocktake', title: 'Stocktake', sub: 'Count the store and fix the system stock', roles: 'Admin · Manager · Engineer',
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Stocktake', 'Count the store and fix the system stock'] });
      await goTab(p, 'Stocktake');
      await cap(p, 'Start a new stocktake', '', 900);
      await tap(p, p.locator('button[onclick="startStocktake()"]'), 1200);
      await cap(p, 'Scan each QR, or search the part', '', 900);
      await typeIn(p, '#stk-search', 'e 2', 800);
      await tap(p, p.locator('#stk-parts-list > *').first(), 900);
      await cap(p, 'Enter what you actually counted', '', 900);
      await typeIn(p, '#sv-actual', '9', 600);
      await tap(p, p.locator('#m-stk-verify .sub-btn').first(), 1300);
      await cap(p, 'Differences are shown as variance', 'Pending = not counted yet', 2600);
      await p.fill('#stk-search', ''); await p.evaluate(() => renderStkList());
      await cap(p, 'When done, tap Finalize', 'Stock is adjusted and a report is downloaded', 2600);
      const fin = p.locator('#stk-active button', { hasText: /Finali[sz]e/i }).first();
      await tap(p, fin, 2000);
      await cap(p, 'History keeps every stocktake on this phone', '', 2800);
    } },
  { id: '09-reports', title: 'Reports and Excel', sub: 'Export reports and import a part list', roles: 'Admin · Manager · Engineer',
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Reports and Excel', 'Export reports and import a part list'] });
      await goTab(p, 'Reports');
      await cap(p, 'Totals at the top', '', 2200);
      await cap(p, 'Pick a date range for the report', '', 900);
      await tap(p, p.locator('[onclick="setQuickRange(\'month\')"]'), 1400);
      await cap(p, 'Export Excel: inventory, transactions and balance per part', '', 900);
      await tap(p, p.locator('.exp-btn').first(), 1500);
      await cap(p, 'CSV exports and a full JSON backup are below it', '', 2400);
      await p.locator('#rpt').evaluate(e => e.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      await wait(p, 900);
      await cap(p, 'Import Excel adds or updates parts in one go', 'Matched by part code · you choose which fields to update', 3200);
    } },
  { id: '10-alerts', title: 'Low stock alerts', sub: 'See what to reorder · get alerts on your phone', roles: 'Everyone',
    async run(p) {
      await login(p, 'admin@abc.test', { show: false, intro: ['Low stock alerts', 'See what to reorder · get alerts on your phone'] });
      await goTab(p, 'Alert');
      await cap(p, 'Every part that needs reordering', 'Out of stock first, then below minimum', 3000);
      if (FLAVOR === 'v2') {
        await p.locator('#ntfy-card').evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        await wait(p, 900);
        await cap(p, 'Get alerts on your phone with the free ntfy app', 'Scan this QR in ntfy, or subscribe to the topic', 3400);
        await cap(p, 'An alert is sent once when a part reaches Near Finish or Low Stock', 'Not again until stock goes back up', 3400);
      } else {
        await cap(p, 'Managers also get phone alerts (ntfy) for low stock and requests', '', 3200);
      }
    } },
  { id: '11-users', title: 'Manage users', sub: 'Add staff and set what they can do', roles: 'Admin · Manager',
    async run(p) {
      await login(p, 'admin@abc.test', { show: false, intro: ['Manage users', 'Add staff and set what they can do'] });
      await goTab(p, 'Users');
      await wait(p, 800);
      await cap(p, 'Everyone who can sign in, with their role', '', 2600);
      await cap(p, 'To add someone: name, email, a temporary password and the role', '', 900);
      await tap(p, p.locator('#users button.sub-btn').first(), 1000);
      await typeIn(p, '#nu-name', 'Zul (Technician)');
      await typeIn(p, '#nu-email', 'zul@abc.test');
      await typeIn(p, '#nu-pass', 'temp1234');
      await tap(p, '#nu-role', 600);
      await p.keyboard.press('Escape');
      await cap(p, 'Roles', 'Technician = request only · Engineer/Manager = stock + approve · Admin = everything', 3800);
      await cap(p, 'Staff leaving? Disable their account instead of sharing logins', '', 3000);
    } },
  { id: '12-check-duplicates', title: 'Check duplicates', sub: 'Find parts entered twice and junk entries', roles: 'Admin · Manager · Engineer',
    async setup() {
      const [name, code, cat, loc, qty, min, max, supplier] = DEMO_PARTS[7];
      await DB.doc(partsPath() + '/dup1').set({ name, code, cat, loc, qty: 9, min, max, unit: 'pcs', supplier });
      await DB.doc(partsPath() + '/junk1').set({ name: 'MAINTE00020', code: '', cat: '', loc: '', qty: 0, min: 0, unit: 'pcs' });
    },
    async run(p) {
      await login(p, 'manager@abc.test', { show: false, intro: ['Check duplicates', 'Find parts entered twice and junk entries'] });
      await cap(p, 'Tap Check Duplicates', '', 900);
      await tap(p, '.dup-btn', 1600);
      await cap(p, 'Entries where every detail is the same are listed together', 'Review, then delete the extra one', 3200);
      await cap(p, 'Junk entries (a part code saved as the name) are listed too', 'Untick anything you want to keep', 3200);
    } },
];

// ── Run ───────────────────────────────────────────────────
await seed();
// Refuse to start if something (e.g. an old run) still serves this port
if (await fetch(BASE + '/index.html').then(() => true, () => false)) { console.error(`Port ${PORT} is already in use — stop the old server first.`); process.exit(1); }
const server = spawn('npx', ['-y', 'serve', '-l', String(PORT), APP], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));

// Camera fixtures: QR of a demo part (made in the app itself) and a printed label
let qrCam = null, labelCam = null;
{
  const p = await newPage('_qr', null);
  await login(p, 'admin@abc.test', { show: false });
  const id = await partId(p, 'MAINTE00311');
  const png = await p.evaluate(id => new Promise(res => {
    const d = document.createElement('div'); document.body.appendChild(d);
    new QRCode(d, { text: 'ST:' + id, width: 300, height: 300, correctLevel: QRCode.CorrectLevel.M });
    setTimeout(() => { const c = d.querySelector('canvas'); const out = document.createElement('canvas'); out.width = 380; out.height = 380;
      const g = out.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 380, 380); g.drawImage(c, 40, 40); res(out.toDataURL('image/png')); }, 300);
  }), id);
  writeFileSync(join(TMP, 'qr.png'), Buffer.from(png.split(',')[1], 'base64'));
  await p.context().close();
  qrCam = cameraFixture('qr', join(TMP, 'qr.png'));
  const lbl = await (async () => {
    const p = await newPage('_label', null);
    await p.goto(BASE + '/index.html');
    const png = await p.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
      g.fillStyle = '#5C626C'; g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#F6F4EC'; g.beginPath(); g.roundRect(70, 165, 500, 150, 14); g.fill();
      g.fillStyle = '#5A5A5A'; g.font = 'bold 18px DejaVu Sans, Arial, sans-serif'; g.fillText('ABC  STORE', 90, 195);
      g.fillStyle = '#141418'; g.font = 'bold 84px DejaVu Sans, Arial, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText('E 20', 320, 245);
      return c.toDataURL('image/png');
    });
    await p.context().close();
    writeFileSync(join(TMP, 'label.png'), Buffer.from(png.split(',')[1], 'base64'));
    return cameraFixture('label', join(TMP, 'label.png'));
  })();
  labelCam = lbl;
}

const index = [];
for (const t of TUTORIALS) {
  if (ONLY && !ONLY.split(',').includes(t.id)) continue;
  console.log('Recording', t.id);
  const cam = t.camera === 'qr' ? qrCam : t.camera === 'label' ? labelCam : null;
  if (t.setup) await t.setup();
  const p = await newPage(t.id, cam);
  try { await t.run(p); await wait(p, 600); }
  catch (e) { console.log('  FAILED', t.id, e.message.split('\n')[0]); await p.screenshot({ path: join(TMP, t.id + '-fail.png') }); }
  const video = p.video();
  await p.context().close();
  const webm = await video.path();
  const mp4 = join(OUT, t.id + '.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.2', '-i', mp4, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', '5', join(OUT, t.id + '.jpg')]);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim());
  index.push({ id: t.id, title: t.title, sub: t.sub, roles: t.roles, duration: Math.round(dur) });
  console.log(`  -> ${t.id}.mp4 (${Math.round(dur)}s)`);
}
if (!ONLY) writeFileSync(join(OUT, 'tutorials.json'), JSON.stringify(index, null, 2) + '\n');
await browser?.close();
server.kill();
if (!process.env.TUT_KEEP) rmSync(TMP, { recursive: true, force: true });
console.log('Done:', OUT);
