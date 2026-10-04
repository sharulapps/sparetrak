// Seed the local Firebase emulators with demo data for the multi-tenant prototype.
// Run while `npm run emulators` is up:  npm run seed
// Touches the emulators only (project demo-sparetrack); never the live project.
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, collection, addDoc } from 'firebase/firestore';

const PROJECT = 'demo-sparetrack';
const AUTH = 'http://127.0.0.1:9099';
const PASSWORD = 'demo1234';

async function authUser(email) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const j = await r.json();
  if (j.error) throw new Error(email + ': ' + j.error.message);
  return j.localId;
}

const TENANTS = [
  {
    id: 'mnsb', name: 'Menang Nusantara Sdn Bhd', plan: 'business', maxUsers: 50,
    users: [
      ['Sharul (Admin)', 'admin@mnsb.test', 'admin'],
      ['Aiman (Manager)', 'manager@mnsb.test', 'manager'],
      ['Hafiz (Technician)', 'tech@mnsb.test', 'technician'],
    ],
    parts: [
      ['WATERJET - ACTUATOR 10177855', 'MAINTW00056', 'W/JET', 'M1/SL', 0, 2, 5, 'SHENYANG WIN-WIN WATERJET CO., LTD'],
      ['WATERJET - SEALING HEAD ASSEMBLY 20481005', 'MAINTW00015', 'W/JET', 'HQ/SL', 1, 2, 5, 'SHENYANG WIN-WIN WATERJET CO., LTD'],
      ['ELECTRICAL PARTS - BUSSMAN 100ET', 'MAINTE00020', 'ALL M/C', 'M1/SL', 3, 3, 10, 'DPSTAR THERMO ELECTRIC SDN BHD'],
      ['ELECTRICAL PARTS - BUSSMAN 80FE FUSE', 'MAINTE00311', 'ALL M/C', 'M1/SL', 12, 2, 5, 'DPSTAR THERMO ELECTRIC SDN BHD'],
      ['PNEUMATIC PARTS - PUSH IN FITTING EPU-8', 'MAINTP00030', 'PNEUMATIC', 'M1/SL', 6, 1, 5, 'FUTURE CONTROL SUPPLIES SDN BHD'],
    ],
  },
  {
    id: 'contoh', name: 'Contoh Precision Sdn Bhd', plan: 'starter', maxUsers: 5,
    users: [
      ['Lim (Admin)', 'admin@contoh.test', 'admin'],
      ['Ravi (Engineer)', 'engineer@contoh.test', 'engineer'],
    ],
    parts: [
      ['CNC SPINDLE BELT HTD 8M', 'CP-BLT-008', 'CNC', 'STORE A', 4, 2, 6, 'GATES MALAYSIA'],
      ['COOLANT PUMP 0.25KW', 'CP-PMP-025', 'CNC', 'STORE A', 0, 1, 3, 'GRUNDFOS'],
      ['LINEAR GUIDE BLOCK HGH20', 'CP-LGB-020', 'CNC', 'STORE B', 9, 4, 8, 'HIWIN'],
    ],
  },
];

const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: '127.0.0.1', port: 8080 } });
await env.clearFirestore();
await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const ownerUid = await authUser('owner@sparetrack.test');
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'platformAdmins', ownerUid), { name: 'Platform Owner', email: 'owner@sparetrack.test' });
  const now = Date.now();
  for (const t of TENANTS) {
    await setDoc(doc(db, 'tenants', t.id), {
      name: t.name, status: 'active', plan: t.plan, maxUsers: t.maxUsers, createdAt: now, createdBy: ownerUid,
      settings: { ntfyTopic: 'st-' + t.id + '-' + Math.random().toString(36).slice(2, 8) },
    });
    for (const [name, email, role] of t.users) {
      const uid = await authUser(email);
      await setDoc(doc(db, 'tenants', t.id, 'members', uid), { name, email, role, status: 'active', createdAt: now, createdBy: ownerUid });
      await setDoc(doc(db, 'userTenants', uid), { tenantId: t.id });
    }
    for (const [name, code, cat, loc, qty, min, max, supplier] of t.parts) {
      await addDoc(collection(db, 'tenants', t.id, 'parts'), { name, code, cat, loc, qty, min, max, supplier, unit: 'pcs' });
    }
  }
});
await env.cleanup();

console.log('Seeded. Password for every account: ' + PASSWORD);
console.log('  owner@sparetrack.test   → /platform.html');
for (const t of TENANTS) for (const [, email, role] of t.users) console.log(`  ${email.padEnd(24)} ${t.name} (${role})`);
