// Modules: Stock Valuation, PDF reports, Suppliers, Audit Trail.
// Run: npm run e2e:modules
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import admin from 'firebase-admin';
import XLSX from 'xlsx';

mkdirSync('screenshots', { recursive: true });
execSync('node seed.mjs', { stdio: 'ignore' });
const server = spawn('npx', ['-y', 'serve', '-l', '5151', 'public'], { stdio: 'ignore', detached: true });
await new Promise(r => setTimeout(r, 2500));
const BASE = 'http://localhost:5151';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

admin.initializeApp({ projectId: 'demo-sparetrack' });
const db = admin.firestore();
const pdocs = (await db.collection('tenants/mnsb/parts').get()).docs;
const P = code => pdocs.find(d => d.data().code === code);
const costs = { MAINTE00311: 10, MAINTE00020: 50, MAINTP00030: 4, MAINTW00015: 1000, MAINTW00056: 500 };
for (const [c, cost] of Object.entries(costs)) await P(c).ref.update({ cost });
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const tx = [['MAINTE00311', 'out', 1, 100], ['MAINTE00020', 'out', 1, 400], ['MAINTW00015', 'out', 1, 10], ['MAINTE00311', 'in', 4, 5]];
for (const [i, [c, type, qty, ago]] of tx.entries())
  await db.doc(`tenants/mnsb/transactions/m${i}`).set({ partId: P(c).id, partName: P(c).data().name, type, qty, date: day(ago), user: 'Ali', createdAt: Date.now() - ago * 864e5 });

const LOCAL = [
  [/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/, () => 'node_modules/xlsx/dist/xlsx.full.min.js'],
  [/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js$/, () => 'node_modules/jspdf/dist/jspdf.umd.min.js'],
  [/jspdf-autotable\/3\.8\.2\/jspdf\.plugin\.autotable\.min\.js$/, () => 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js'],
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function open(email, w = 1366, h = 860) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
    const u = r.request().url();
    for (const [re, f] of LOCAL) if (re.test(u) && existsSync(f())) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(f()) });
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
  await p.waitForTimeout(1200);
  return p;
}

try {
  const p = await open('manager@mnsb.test');
  // ── 1. Stock Valuation ──
  const kpi = await p.textContent('#kpi-value');
  check('KPI card shows stock value (12×10 + 3×50 + 6×4 + 1×1000 = RM 1,294)', kpi.trim() === 'RM 1,294', kpi);
  const trend = (await p.textContent('#kpi-value-s')).replace(/\s+/g, ' ').trim();
  // 30 days ago: fuse had 4 fewer (IN 5 d ago: −RM40), sealing head 1 more (OUT 10 d ago: +RM1000) → RM 2,254 → −42.6%
  check('…with the change vs 30 days ago (RM 2,254 then → ↓ 42.6%)', /↓ 42\.6% vs 30 days ago/.test(trend), trend);
  await p.click('#kpi-value');
  await p.waitForSelector('#val-body .bud-tile', { timeout: 15000 });
  const t = await p.textContent('#val-body');
  check('Valuation total', /Stock value\s*RM 1,294\.00/.test(t));
  check('Dead stock (no OUT for 12 months): 100ET (last OUT 400 d ago) + EPU-8 (never) = RM 174', /Dead stock\s*RM 174\.00/.test(t) && /2 part\(s\)/.test(t));
  check('Above max: fuse 7 × RM10 + EPU-8 1 × RM4 = RM 74', /Over max\s*RM 74\.00/.test(t));
  await p.selectOption('#val-dead', '730');
  check('Dead-stock period adjustable (24 months: only EPU-8, RM 24)', /Dead stock\s*RM 24\.00/.test(await p.textContent('#val-body')));
  await p.selectOption('#val-group', 'supplier');
  check('Breakdown by supplier', /By supplier[\s\S]*SHENYANG WIN-WIN/.test(await p.textContent('#val-body')));
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'screenshots/80-valuation.png' });
  const dl = p.waitForEvent('download');
  await p.click('#m-val >> text=Export Excel');
  check('Valuation Excel downloads', /Stock_Valuation/.test((await dl).suggestedFilename()));
  await p.evaluate(() => closeM('m-val'));
  check('Reports has a Stock Valuation button', await p.evaluate(() => !!document.getElementById('val-open')));

  // ── 2. PDF reports ──
  await p.evaluate(() => openPdf());
  await p.fill('#pdf-company', 'ABC Sdn Bhd');
  const pdfText = async kind => {
    const d = p.waitForEvent('download', { timeout: 30000 });
    await p.evaluate(k => pdfReport(k), kind);
    const f = '.e2e-' + kind + '.pdf'; await (await d).saveAs(f);
    const txt = execSync('pdftotext -layout ' + f + ' -').toString(); if (process.env.KEEP_PDF) execSync('cp ' + f + ' ' + process.env.KEEP_PDF); execSync('rm -f ' + f);
    return txt;
  };
  let txt = await pdfText('inventory');
  check('PDF inventory: header, every part, status, page numbers', /ABC Sdn Bhd/.test(txt) && /Inventory List/.test(txt) && /SEALING HEAD/.test(txt) && /LOW STOCK|Low Stock/.test(txt) && /Page 1 of 1/.test(txt));
  txt = await pdfText('reorder');
  check('PDF reorder list: low + near parts, order qty, signature lines', /Reorder List/.test(txt) && /ACTUATOR/.test(txt) && /SEALING HEAD/.test(txt) && /Prepared by/.test(txt) && /Approved by/.test(txt) && !/BUSSMAN 80FE/.test(txt));
  txt = await pdfText('valuation');
  check('PDF valuation: total RM 1,294.00, dead stock section', /Stock Valuation/.test(txt) && /RM 1,294\.00/.test(txt) && /Dead stock/.test(txt));
  txt = await pdfText('pm');
  check('PDF PM schedule (empty period handled)', /PM Schedule/.test(txt) && /(No PM jobs|PM date)/.test(txt));
  txt = await pdfText('budget');
  check('PDF budget', /Spare Part Budget/.test(txt) && /Yearly budget/i.test(txt));
  check('Company name remembered on this device', await p.evaluate(() => pdfCompany()) === 'ABC Sdn Bhd');
  await p.evaluate(() => closeM('m-pdf'));

  // ── 3. Suppliers ──
  await p.evaluate(() => document.getElementById('nav-sup').click());
  await p.waitForSelector('#m-sup.open #sup-q');
  check('Suppliers menu opens, empty list offers to add from parts', /Add 3 from parts/.test(await p.textContent('#sup-body')));
  await p.click('#m-sup >> text=Add 3 from parts');
  await p.waitForFunction(() => document.querySelectorAll('#sup-body .sup-card').length === 3, null, { timeout: 15000 });
  check('3 suppliers created from the names on parts', (await db.collection('tenants/mnsb/suppliers').get()).size === 3);
  const card = (await p.textContent('#sup-body')).replace(/\s+/g, ' ');
  check('DPSTAR card: 2 parts, stock value RM 270.00', /DPSTAR THERMO ELECTRIC SDN BHD.*?Parts 2\s*Stock value RM 270\.00/.test(card), card.slice(0, 300));
  check('SHENYANG card: 2 parts to reorder', /SHENYANG WIN-WIN WATERJET CO\., LTD.*?Parts 2\s*Stock value RM 1,000\.00\s*To reorder 2/.test(card));
  await p.fill('#sup-q', 'future');
  check('Search filters the list', await p.evaluate(() => document.querySelectorAll('#sup-body .sup-card').length) === 1);
  await p.fill('#sup-q', '');
  await p.click('#m-sup .sup-card:has-text("DPSTAR")');
  await p.click('#m-sup >> text=✎ Edit');
  await p.fill('#sf-name', 'DPSTAR Thermo Electric (M) Sdn Bhd');
  await p.fill('#sf-phone', '012-345 6789');
  await p.fill('#sf-email', 'sales@dpstar.test');
  await p.fill('#sf-leadTime', '2 weeks');
  await p.click('#m-sup >> text=Save supplier');
  await p.waitForSelector('#m-sup a[href^="https://wa.me/"]', { timeout: 15000 });
  check('Detail has Call / WhatsApp (60…) / Email links', await p.evaluate(() => !!document.querySelector('#m-sup a[href="tel:0123456789"]') && !!document.querySelector('#m-sup a[href="https://wa.me/60123456789"]') && !!document.querySelector('#m-sup a[href="mailto:sales@dpstar.test"]')));
  await p.waitForTimeout(800);
  const renamed = (await db.collection('tenants/mnsb/parts').get()).docs.filter(d => d.data().supplier === 'DPSTAR Thermo Electric (M) Sdn Bhd');
  check('Renaming the supplier renames it on its 2 parts (synced, stamped)', renamed.length === 2 && renamed.every(d => d.data().updatedAt));
  check('Parts list in detail still shows both parts', /Parts from this supplier \(2\)/.test(await p.textContent('#sup-body')));
  await p.screenshot({ path: 'screenshots/82-supplier.png' });
  check('Part form suggests supplier names', await p.evaluate(() => { fillSupplierList(); return document.getElementById('f-supplier').getAttribute('list') === 'supplier-dl' && document.querySelectorAll('#supplier-dl option').length === 3; }));
  await p.click('#m-sup >> text=‹ All suppliers');
  const dl2 = p.waitForEvent('download');
  await p.click('#m-sup >> text=Export Excel');
  check('Suppliers Excel downloads', /SpareTrack_Suppliers/.test((await dl2).suggestedFilename()));
  await p.click('#m-sup .sup-card:has-text("FUTURE")');
  await p.click('#m-sup >> text=Delete supplier');
  await p.waitForFunction(() => document.querySelectorAll('#sup-body .sup-card').length === 2, null, { timeout: 15000 });
  check('Delete supplier keeps the part supplier name', (await db.collection('tenants/mnsb/suppliers').get()).size === 2 && (await P('MAINTP00030').ref.get()).data().supplier === 'FUTURE CONTROL SUPPLIES SDN BHD');
  // Excel template → fill in → import
  const dlt = p.waitForEvent('download');
  await p.click('#m-sup >> text=Excel template');
  const tf = '.e2e-sup-template.xlsx'; await (await dlt).saveAs(tf);
  const twb = XLSX.read(readFileSync(tf), { cellNF: true });
  const trows = XLSX.utils.sheet_to_json(twb.Sheets.Suppliers, { header: 1, blankrows: false, defval: '' }).filter(r => r.some(c => c !== ''));
  check('Template: Suppliers / Parts by supplier / Instructions sheets, prefilled with current + part supplier names',
    twb.SheetNames.join() === 'Suppliers,Parts by supplier,Instructions' && trows[0][0] === 'Supplier name *' && trows.length === 4 && twb.Sheets.Suppliers.C3.z === '@'
    && trows.some(r => r[0] === 'FUTURE CONTROL SUPPLIES SDN BHD') && trows.some(r => r[0] === 'DPSTAR Thermo Electric (M) Sdn Bhd' && r[2] === '012-345 6789'), JSON.stringify(trows));
  for (const r of trows.slice(1)) {
    if (/SHENYANG/.test(r[0])) { r[2] = '+86 24 1234 5678'; r[5] = '30 days'; }
    if (/FUTURE/.test(r[0])) r[1] = 'Mr Tan';
    if (/DPSTAR/.test(r[0])) r[3] = '';   // empty cell keeps the current email
  }
  trows.push(['new hydraulic co.', 'Siti', 198887777]);   // Excel dropped the leading 0
  twb.Sheets.Suppliers = XLSX.utils.aoa_to_sheet(trows);
  XLSX.writeFile(twb, tf);
  await p.setInputFiles('#sup-file', tf);
  await p.waitForFunction(() => document.querySelectorAll('#sup-body .sup-card').length === 4, null, { timeout: 15000 });
  execSync('rm -f ' + tf);
  const sups = Object.fromEntries((await db.collection('tenants/mnsb/suppliers').get()).docs.map(d => [d.data().name, d.data()]));
  check('Import: updates filled cells, keeps empty ones, adds new names, no duplicates',
    Object.keys(sups).length === 4 && sups['SHENYANG WIN-WIN WATERJET CO., LTD'].phone === '+86 24 1234 5678' && sups['SHENYANG WIN-WIN WATERJET CO., LTD'].terms === '30 days'
    && sups['FUTURE CONTROL SUPPLIES SDN BHD'].contact === 'Mr Tan' && sups['DPSTAR Thermo Electric (M) Sdn Bhd'].email === 'sales@dpstar.test' && sups['new hydraulic co.'].phone === '0198887777', JSON.stringify(Object.keys(sups)));
  await p.setInputFiles('#sup-file', { name: 'again.xlsx', mimeType: 'application/octet-stream', buffer: XLSX.write(twb, { type: 'buffer', bookType: 'xlsx' }) });
  await p.waitForTimeout(1200);
  check('Importing the same file again changes nothing', (await db.collection('tenants/mnsb/suppliers').get()).size === 4);
  await p.evaluate(() => closeM('m-sup'));
  const tech = await open('tech@mnsb.test');
  await tech.evaluate(() => openSuppliers());
  await tech.waitForSelector('#m-sup .sup-card');
  check('Technician can view suppliers but has no Add / Edit / Delete', await tech.evaluate(() => !/\+ Add supplier/.test(document.getElementById('sup-body').textContent) && (document.querySelector('#m-sup .sup-card').click(), !/Delete supplier|✎ Edit/.test(document.getElementById('sup-body').textContent))));

  // ── 4. Audit trail + last updated ──
  check('Audit Trail menu hidden for technician', await tech.evaluate(() => getComputedStyle(document.getElementById('nav-aud')).display === 'none'));
  const fuse = P('MAINTE00311');
  await p.evaluate(id => openTxn(id, 'out'), fuse.id);
  await p.fill('#t-qty', '2'); if (await p.$('#t-machine')) await p.fill('#t-machine', 'PRESS 7');
  await p.evaluate(() => saveTxn());
  await p.waitForTimeout(1200);
  await p.evaluate(id => openEdit(id), fuse.id);
  await p.fill('#f-min', '4');
  await p.evaluate(() => savePart());
  await p.waitForTimeout(1500);
  const logs = (await db.collection('tenants/mnsb/auditLog').get()).docs.map(d => d.data());
  const out = logs.find(l => l.action === 'Stock OUT');
  check('Stock OUT logged: who, part, qty, machine, server time', out && out.user === 'Aiman (Manager)' && out.role === 'manager' && /80FE FUSE/.test(out.target) && /^2 pcs · Machine: PRESS 7$/.test(out.details) && out.code === 'MAINTE00311' && /PRESS 7/.test(out.details) && out.ts && out.uid, JSON.stringify(out || {}).slice(0, 200));
  const ed = logs.find(l => l.action === 'Part edited' && (l.changes || []).some(c => c.f === 'min'));
  check('Part edit logged with old → new (Min 2 → 4)', ed && ed.changes.some(c => c.f === 'min' && c.from === '2' && c.to === '4'), JSON.stringify(ed && ed.changes));
  check('Stock OUT alone does not add a "Part edited" stock entry', !logs.some(l => l.action === 'Part edited' && (l.changes || []).some(c => c.f === 'qty')));
  check('Supplier add / rename / delete logged', logs.filter(l => l.action === 'Supplier added').length === 5 && logs.some(l => l.action === 'Supplier edited' && l.changes.some(c => c.f === 'name')) && logs.some(l => l.action === 'Supplier deleted'));
  const fd = (await fuse.ref.get()).data();
  check('Part keeps "last updated by" (Aiman, now)', fd.lastBy === 'Aiman (Manager)' && Date.now() - fd.lastAt < 60000);
  await p.evaluate(id => openEdit(id), fuse.id);
  check('Edit Part shows "Last updated … by Aiman"', /Last updated .* by Aiman \(Manager\)/.test(await p.textContent('#f-lastupd')));
  await p.click('#f-lastupd >> text=View history');
  await p.waitForSelector('#m-aud.open table', { timeout: 15000 });
  const at = (await p.textContent('#aud-body')).replace(/\s+/g, ' ');
  check('View history opens the audit trail for that part', /Stock OUT/.test(at) && /Part edited/.test(at) && !/Supplier added/.test(at), at.slice(0, 200));
  await p.fill('#aud-q', ''); await p.selectOption('#aud-type', 'supplier');
  check('Filter by type (Suppliers)', await p.evaluate(() => [...document.querySelectorAll('#aud-body tr')].slice(1).every(r => /Supplier/.test(r.textContent))) && await p.evaluate(() => document.querySelectorAll('#aud-body tr').length > 3));
  await p.selectOption('#aud-type', '');
  await p.screenshot({ path: 'screenshots/84-audit-trail.png' });
  const dl3 = p.waitForEvent('download');
  await p.click('#m-aud >> text=Export Excel');
  check('Audit trail Excel downloads', /Audit_Trail/.test((await dl3).suggestedFilename()));
  check('Technician cannot read the audit trail', await tech.evaluate(async () => { try { const F = window._fs; await F.getDocs(F.collection(F.db, 'auditLog')); return false; } catch (e) { return /permission/i.test(e.code || e.message); } }));
  check('Audit entries cannot be deleted', await p.evaluate(async () => { const F = window._fs; const s = await F.getDocs(F.collection(F.db, 'auditLog')); try { await F.deleteDoc(s.docs[0].ref); return false; } catch (e) { return true; } }));
} catch (e) { console.error('E2E error:', e); results.push(false); }
await browser.close();
try { process.kill(-server.pid); } catch (e) {}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
