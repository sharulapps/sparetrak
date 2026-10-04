// Move MNSB's existing single-tenant data into the tenant layout (tenants/mnsb/...).
// Works on the Firebase Spark (free) plan: uses the Admin SDK with a service-account
// key, reads each old document once, and caps writes per run to stay under the
// 20,000 writes/day quota. Old collections are NEVER modified or deleted.
//
//   node migrate.mjs export                 read old data  -> backup/mnsb-<time>.json
//   node migrate.mjs import <backup.json>   write tenants/mnsb/... (resumable)
//   node migrate.mjs verify [backup.json]   compare counts and stock totals
//
// Old and new can be the SAME Firebase project, or a NEW one:
//   export with the OLD project's key, then import/verify with the NEW project's key
//   plus --to <new-project-id> (a safety check so data never lands in the wrong project),
//   and pass the backup file to verify. Copy the login accounts first with
//   `firebase auth:export` / `firebase auth:import` (see MIGRATION.md) so uids match.
//
// Options:
//   --key <file>          service-account JSON (or set GOOGLE_APPLICATION_CREDENTIALS)
//   --tenant mnsb         tenant id
//   --name "..."          company name shown in the app header
//   --ntfy mnsb_sparepart keep the current ntfy topic so phones stay subscribed
//   --max-writes 15000    stop after this many writes; run again tomorrow to resume
//   --dry-run             import: print what would be written, write nothing
//   --to <project-id>     required when importing into a different project than the export
//
// Emulator testing: set FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST and
// pass --project demo-sparetrack instead of --key.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import admin from 'firebase-admin';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes('--' + name);

const TENANT = opt('tenant', 'mnsb');
const NAME = opt('name', 'Menang Nusantara Sdn Bhd');
const NTFY = opt('ntfy', 'mnsb_sparepart');
const MAX_WRITES = parseInt(opt('max-writes', '15000'), 10);
const OLD = ['parts', 'transactions', 'approvals', 'users'];          // single-tenant root collections
const COPY = ['parts', 'transactions', 'approvals'];                   // copied 1:1 (same doc ids)
const ROLES = ['admin', 'manager', 'engineer', 'technician', 'finance', 'purchasing', 'production'];
const BATCH = 400;

// ── connect ──────────────────────────────────────
const keyFile = opt('key', process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (process.env.FIRESTORE_EMULATOR_HOST) {
  admin.initializeApp({ projectId: opt('project', 'demo-sparetrack') });
} else {
  if (!keyFile || !existsSync(keyFile)) die('Service-account key not found. Pass --key serviceAccount.json');
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
}
const db = admin.firestore();
const projectId = admin.app().options.projectId;

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function log(msg) { console.log(msg); }

// Firestore Timestamps survive the JSON round trip as {__ts: millis}
const enc = v => v instanceof admin.firestore.Timestamp ? { __ts: v.toMillis() }
  : Array.isArray(v) ? v.map(enc)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]))
  : v;
const dec = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '__ts' in v
  ? admin.firestore.Timestamp.fromMillis(v.__ts)
  : Array.isArray(v) ? v.map(dec)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))
  : v;

// ── export ───────────────────────────────────────
async function exportOld() {
  log(`Project: ${projectId}`);
  const roots = (await db.listCollections()).map(c => c.id);
  const unknown = roots.filter(c => !OLD.includes(c) && !['tenants', 'userTenants', 'platformAdmins'].includes(c));
  if (unknown.length) log(`! Other root collections found (NOT migrated, left as is): ${unknown.join(', ')}`);
  if (roots.includes('tenants')) log(`! tenants/ already exists — import will overwrite docs with the same ids, nothing else.`);

  const out = { project: projectId, exportedAt: new Date().toISOString(), collections: {} };
  let reads = 0;
  for (const c of OLD) {
    const snap = await db.collection(c).get();
    reads += snap.size;
    out.collections[c] = snap.docs.map(d => ({ id: d.id, data: enc(d.data()) }));
    log(`  ${c.padEnd(13)} ${String(snap.size).padStart(6)} docs`);
  }
  // Auth accounts with no users/{uid} profile would be locked out after the switch
  const authUsers = [];
  let page;
  do {
    const r = await admin.auth().listUsers(1000, page);
    authUsers.push(...r.users.map(u => ({ uid: u.uid, email: u.email || '', disabled: u.disabled })));
    page = r.pageToken;
  } while (page);
  out.authUsers = authUsers;
  const profiled = new Set(out.collections.users.map(u => u.id));
  const noProfile = authUsers.filter(u => !profiled.has(u.uid));
  if (noProfile.length) log(`! ${noProfile.length} login(s) have no users/ profile; they will be added as technician: ${noProfile.map(u => u.email).join(', ')}`);

  mkdirSync('backup', { recursive: true });
  const file = `backup/${TENANT}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(out));
  const writes = planWrites(out).length;
  log(`\n✓ Exported ${reads} docs (${reads} reads) → ${file}`);
  log(`  Import will need ${writes} writes${writes > MAX_WRITES ? ` → ${Math.ceil(writes / MAX_WRITES)} runs at --max-writes ${MAX_WRITES} (one per day on Spark)` : ' (fits in one run)'}.`);
  log('  Keep this file: it is your backup (Spark has no automatic backups).');
}

// Every write the import performs, in a fixed order so a run can resume by index.
function planWrites(data) {
  const ops = [];
  const now = Date.now();
  const users = new Map(data.collections.users.map(u => [u.id, dec(u.data)]));
  for (const a of data.authUsers || []) if (!users.has(a.uid)) users.set(a.uid, { email: a.email, name: a.email, role: 'technician', addedBy: 'migration' });
  // No part limit (maxParts 0); userCount starts at the number of migrated members
  ops.push({ path: `tenants/${TENANT}`, data: { name: NAME, status: 'active', plan: 'internal', maxUsers: 1000, maxParts: 0, userCount: users.size, createdAt: now, migratedFrom: 'single-tenant', settings: { ntfyTopic: NTFY } } });
  for (const [uid, u] of users) {
    const role = ROLES.includes(u.role) ? u.role : 'technician';
    const authDisabled = (data.authUsers || []).some(a => a.uid === uid && a.disabled);
    ops.push({ path: `tenants/${TENANT}/members/${uid}`, data: { ...u, role, status: authDisabled ? 'disabled' : 'active', ...(role !== u.role ? { previousRole: u.role || null } : {}) } });
    ops.push({ path: `userTenants/${uid}`, data: { tenantId: TENANT } });
  }
  for (const c of COPY) for (const d of data.collections[c]) ops.push({ path: `tenants/${TENANT}/${c}/${d.id}`, data: dec(d.data) });
  return ops;
}

// ── import ───────────────────────────────────────
async function importNew(file) {
  if (!file || !existsSync(file)) die('Usage: node migrate.mjs import backup/<file>.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.project !== projectId) {
    if (opt('to') !== projectId) die(`This backup is from project "${data.project}" and you are connected to "${projectId}".\n  If you really mean to copy it into "${projectId}", add:  --to ${projectId}`);
    log(`Copying data exported from "${data.project}" into "${projectId}".`);
  }
  const ops = planWrites(data);
  const progFile = file + '.progress.json';
  const done = existsSync(progFile) ? JSON.parse(readFileSync(progFile, 'utf8')).done : 0;
  if (done >= ops.length) { log(`✓ Already complete (${done}/${ops.length}). Run: node migrate.mjs verify`); return; }

  const end = Math.min(ops.length, done + MAX_WRITES);
  const badRoles = ops.filter(o => o.data.previousRole !== undefined);
  log(`Project: ${projectId}   tenant: ${TENANT}   writes ${done}..${end} of ${ops.length}`);
  if (badRoles.length) log(`! ${badRoles.length} user(s) had an unknown role and become technician: ${badRoles.map(o => o.data.email || o.path).join(', ')}`);
  if (flag('dry-run')) {
    const byCol = {};
    for (const o of ops.slice(done, end)) { const k = o.path.split('/').slice(0, -1).join('/'); byCol[k] = (byCol[k] || 0) + 1; }
    for (const [k, n] of Object.entries(byCol)) log(`  ${k.padEnd(32)} ${n}`);
    log('Dry run: nothing written.');
    return;
  }
  for (let i = done; i < end; i += BATCH) {
    const batch = db.batch();
    for (const o of ops.slice(i, Math.min(end, i + BATCH))) batch.set(db.doc(o.path), o.data);
    await batch.commit();
    const upto = Math.min(end, i + BATCH);
    writeFileSync(progFile, JSON.stringify({ done: upto, total: ops.length, at: new Date().toISOString() }));
    process.stdout.write(`\r  written ${upto}/${ops.length}`);
  }
  log('');
  if (end < ops.length) log(`⏸  Stopped at the --max-writes limit (${MAX_WRITES}). Run the same command again tomorrow to continue.`);
  else log(`✓ Import complete. Now run: node migrate.mjs verify`);
}

// ── verify ───────────────────────────────────────
// Same project: compares the old root collections with tenants/<id>/.
// New project: pass the backup file; compares tenants/<id>/ with what was exported.
async function verify(file) {
  const { AggregateField } = admin.firestore;
  let ok = true;
  const row = (label, a, b) => { const same = a === b; ok = ok && same; log(`  ${same ? '✓' : '✗'} ${label.padEnd(28)} old ${String(a).padStart(7)}   new ${String(b).padStart(7)}`); };
  const data = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (file) log(`Comparing ${projectId}/tenants/${TENANT} with backup from ${data.project} (${data.exportedAt})`);
  for (const c of COPY) {
    const b = (await db.collection(`tenants/${TENANT}/${c}`).count().get()).data().count;
    const a = data ? data.collections[c].length : (await db.collection(c).count().get()).data().count;
    row(c, a, b);
  }
  const qb = (await db.collection(`tenants/${TENANT}/parts`).aggregate({ s: AggregateField.sum('qty') }).get()).data().s;
  const qa = data ? data.collections.parts.reduce((t, p) => t + (Number(p.data.qty) || 0), 0)
                  : (await db.collection('parts').aggregate({ s: AggregateField.sum('qty') }).get()).data().s;
  row('total stock qty (all parts)', qa, qb);
  const [ma, ta] = await Promise.all([
    db.collection(`tenants/${TENANT}/members`).get(),
    db.collection('userTenants').where('tenantId', '==', TENANT).count().get(),
  ]);
  log(`  • members ${ma.size}, userTenants ${ta.data().count}`);
  if (ma.size !== ta.data().count) { ok = false; log('  ✗ members and userTenants differ'); }
  // Every member needs a login account with the SAME uid in this project
  const uids = ma.docs.map(d => d.id), missing = [];
  for (let i = 0; i < uids.length; i += 100) {
    const r = await admin.auth().getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
    missing.push(...r.notFound.map(x => x.uid));
  }
  if (missing.length) {
    ok = false;
    const email = uid => ma.docs.find(d => d.id === uid)?.data().email || uid;
    log(`  ✗ ${missing.length} member(s) have no login account in ${projectId}: ${missing.map(email).join(', ')}`);
    log('    Run firebase auth:export / auth:import first (MIGRATION.md), then verify again.');
  } else log(`  ✓ all ${uids.length} members have a login account`);
  const t = await db.doc(`tenants/${TENANT}`).get();
  if (!t.exists) { ok = false; log(`  ✗ tenants/${TENANT} missing`); }
  else log(`  • tenants/${TENANT}: "${t.data().name}", status ${t.data().status}, ntfy ${t.data().settings?.ntfyTopic}`);
  log(ok ? '\n✓ Verified. Safe to switch users over to the new version.' : '\n✗ Mismatch. Do NOT switch over yet.');
  process.exitCode = ok ? 0 : 1;
}

if (cmd === 'export') await exportOld();
else if (cmd === 'import') await importNew(args[1]);
else if (cmd === 'verify') await verify(args[1] && !args[1].startsWith('--') ? args[1] : null);
else die('Usage: node migrate.mjs export | import <backup.json> [--to <project>] | verify [backup.json]   [--key serviceAccount.json]');
