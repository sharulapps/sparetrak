// Old single-company app (sharulapps/sparetrack, checked out at ../sparetrack): an admin disables
// a user who left — the user is signed out at once and cannot sign in until enabled again.
// The old app hard-codes its live Firebase config, so its SDK files are swapped for shims that
// use a demo project on the emulators (same as tools/record-tutorials.mjs).
// Run: npm run e2e:v1-users
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const APP = process.env.TUT_APP || '../sparetrack/public';
const SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';
const SHIMS = {
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
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const fb = admin.initializeApp({ projectId: 'demo-v1' });
await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-v1/accounts', { method: 'DELETE' });
await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-v1/databases/(default)/documents', { method: 'DELETE' });
const db = fb.firestore();
const uid = {};
for (const [name, email, role] of [['Admin', 'admin@abc.test', 'admin'], ['Riezhan', 'tech@abc.test', 'technician']]) {
  uid[role] = (await fb.auth().createUser({ email, password: 'demo1234' })).uid;
  await db.doc('users/' + uid[role]).set({ name, email, role });
}
await db.doc('parts/p1').set({ name: 'BEARING 6205', code: 'MAINTEHQ00012', qty: 5, min: 1, unit: 'pcs' });

const server = spawn('npx', ['-y', 'serve', '-l', '5141', APP], { stdio: 'ignore', detached: true });
await new Promise(r => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function page() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    const m = r.request().url().match(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/(real\/)?(firebase-[a-z]+\.js)$/);
    if (m) return r.fulfill({ contentType: 'text/javascript', body: !m[1] && SHIMS[m[2]] ? SHIMS[m[2]] : readFileSync('node_modules/firebase/' + m[2], 'utf8') });
    return r.abort();
  });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { if (!/emailjs/i.test(e.message)) console.log('  [pageerror]', e.message); });
  return p;
}
async function login(p, email) {
  await p.goto('http://localhost:5141/index.html');
  await p.waitForSelector('#login-email', { state: 'visible' });
  await p.fill('#login-email', email); await p.fill('#login-pass', 'demo1234'); await p.click('#login-btn');
}
const inApp = p => p.waitForFunction(() => document.getElementById('main-app').style.display === 'flex', null, { timeout: 20000 });
const loginError = p => p.waitForFunction(() => /disabled/i.test(document.getElementById('login-error').textContent) && document.getElementById('login-screen').style.display !== 'none', null, { timeout: 20000 });

try {
  const tech = await page();
  await login(tech, 'tech@abc.test'); await inApp(tech);
  check('Technician signs in', true);

  const adm = await page();
  await login(adm, 'admin@abc.test'); await inApp(adm);
  await adm.evaluate(() => [...document.querySelectorAll('.nav-btn')].find(b => /users/i.test(b.textContent)).click());
  await adm.waitForFunction(() => /Riezhan/.test(document.getElementById('users-section-list')?.textContent || ''), null, { timeout: 15000 });
  check('Users page has one title (no duplicate heading)', await adm.evaluate(() => [...document.querySelectorAll('#users *')].filter(e => e.children.length === 0 && e.textContent.trim() === 'User Management').length === 1));
  check('Admin sees Disable for others, not for themselves', await adm.evaluate(() => { const t = document.getElementById('users-section-list').innerHTML; return (t.match(/>Disable</g) || []).length === 1; }));
  await adm.evaluate(id => toggleUserStatus(id), uid.technician);
  await adm.waitForFunction(() => /Disabled — cannot sign in/.test(document.getElementById('users-section-list').textContent), null, { timeout: 10000 });
  check('User marked Disabled in the list', true);
  check('Status saved on the user', (await db.doc('users/' + uid.technician).get()).data().status === 'disabled');

  await loginError(tech);
  check('Signed-in technician is signed out at once, with a message', true, (await tech.textContent('#login-error')).trim());
  await login(tech, 'tech@abc.test');
  await loginError(tech);
  check('Disabled user cannot sign in again', await tech.evaluate(() => document.getElementById('main-app').style.display !== 'flex'));

  await adm.evaluate(id => toggleUserStatus(id), uid.technician);
  await adm.waitForTimeout(800);
  check('Enable again', (await db.doc('users/' + uid.technician).get()).data().status === 'active');
  await login(tech, 'tech@abc.test'); await inApp(tech);
  check('Enabled user signs in again', true);
  const role = (await db.doc('users/' + uid.technician).get()).data();
  check('Role and name kept', role.role === 'technician' && role.name === 'Riezhan');
} catch (e) { console.error('E2E error:', e); results.push(false); }
await browser.close();
try { process.kill(-server.pid); } catch (e) {}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
