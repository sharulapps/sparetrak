// Security-rules tests for the multi-tenant layout.
// Run: npm test   (starts the Firestore emulator, runs these, stops it)
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection,
  writeBatch, increment,
} from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-sparetrack-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

// Two tenants, each with its own admin / manager / technician.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'platformAdmins/owner'), { name: 'Platform Owner' });
    for (const t of ['mnsb', 'acme']) {
      await setDoc(doc(db, `tenants/${t}`), { name: t.toUpperCase(), status: 'active', plan: 'pro', maxUsers: 20 });
      await setDoc(doc(db, `tenants/${t}/members/${t}-admin`), { role: 'admin', status: 'active', name: `${t} admin` });
      await setDoc(doc(db, `tenants/${t}/members/${t}-mgr`), { role: 'manager', status: 'active', name: `${t} manager` });
      await setDoc(doc(db, `tenants/${t}/members/${t}-tech`), { role: 'technician', status: 'active', name: `${t} tech` });
      await setDoc(doc(db, `tenants/${t}/parts/p1`), { name: `${t} bearing`, qty: 5, min: 2, max: 10 });
      for (const r of ['admin', 'mgr', 'tech']) await setDoc(doc(db, `userTenants/${t}-${r}`), { tenantId: t });
    }
  });
});

const as = uid => env.authenticatedContext(uid).firestore();

// Add a member the way the app does: member doc + userTenants + userCount+1 in one batch
function addMember(db, tid, uid, role = 'technician', { bump = true, mapping = true } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, `tenants/${tid}/members/${uid}`), { role, status: 'active', name: uid });
  if (mapping) b.set(doc(db, `userTenants/${uid}`), { tenantId: tid });
  if (bump) b.update(doc(db, `tenants/${tid}`), { userCount: increment(1) });
  return b.commit();
}
// Self sign-up batch, as index.html's startTrial() writes it
function trialSignup(db, uid, tid, overrides = {}) {
  const b = writeBatch(db);
  b.set(doc(db, `tenants/${tid}`), { name: 'Trial Co', status: 'active', plan: 'trial', maxUsers: 3, maxParts: 10,
    userCount: 1, createdAt: 1, createdBy: uid, settings: { ntfyTopic: 'st-x-abc123' }, ...overrides });
  b.set(doc(db, `tenants/${tid}/members/${uid}`), { role: 'admin', status: 'active', name: 'Owner', email: uid + '@x.test' });
  b.set(doc(db, `userTenants/${uid}`), { tenantId: tid });
  return b.commit();
}

// ── Isolation ───────────────────────────────────
test('member reads own tenant parts', async () => {
  await assertSucceeds(getDocs(collection(as('mnsb-tech'), 'tenants/mnsb/parts')));
});
test('member CANNOT read another tenant parts', async () => {
  await assertFails(getDocs(collection(as('mnsb-admin'), 'tenants/acme/parts')));
  await assertFails(getDoc(doc(as('mnsb-admin'), 'tenants/acme/parts/p1')));
});
test('member CANNOT write another tenant parts', async () => {
  await assertFails(setDoc(doc(as('mnsb-admin'), 'tenants/acme/parts/x'), { name: 'hack', qty: 1 }));
  await assertFails(updateDoc(doc(as('mnsb-admin'), 'tenants/acme/parts/p1'), { qty: 0 }));
});
test('member CANNOT list another tenant users', async () => {
  await assertFails(getDocs(collection(as('mnsb-admin'), 'tenants/acme/members')));
});
test('signed-out user reads nothing', async () => {
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'tenants/mnsb/parts')));
});
test('old single-tenant root collections are closed', async () => {
  await assertFails(getDocs(collection(as('mnsb-admin'), 'parts')));
});

// ── Roles inside a tenant ───────────────────────
test('technician cannot add parts or change stock', async () => {
  await assertFails(addDoc(collection(as('mnsb-tech'), 'tenants/mnsb/parts'), { name: 'x', qty: 1 }));
  await assertFails(updateDoc(doc(as('mnsb-tech'), 'tenants/mnsb/parts/p1'), { qty: 99 }));
});
test('technician can submit an OUT request for approval', async () => {
  await assertSucceeds(addDoc(collection(as('mnsb-tech'), 'tenants/mnsb/approvals'),
    { partId: 'p1', qty: 1, status: 'pending', requestedByUid: 'mnsb-tech' }));
});
test('technician cannot submit a request in someone else\'s name', async () => {
  await assertFails(addDoc(collection(as('mnsb-tech'), 'tenants/mnsb/approvals'),
    { partId: 'p1', qty: 1, status: 'pending', requestedByUid: 'mnsb-admin' }));
});
test('technician cannot approve', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'tenants/mnsb/approvals/a1'),
    { status: 'pending', requestedByUid: 'mnsb-tech' }));
  await assertFails(updateDoc(doc(as('mnsb-tech'), 'tenants/mnsb/approvals/a1'), { status: 'approved' }));
  await assertSucceeds(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/approvals/a1'), { status: 'approved' }));
});
test('only tenant admin can edit or delete transactions (audit trail)', async () => {
  const ref = await addDoc(collection(as('mnsb-mgr'), 'tenants/mnsb/transactions'), { type: 'in', qty: 1 });
  await assertFails(deleteDoc(doc(as('mnsb-mgr'), ref.path)));
  await assertSucceeds(deleteDoc(doc(as('mnsb-admin'), ref.path)));
});

// ── Tenant admin manages own users ──────────────
test('tenant admin adds a user to own tenant', async () => {
  await assertSucceeds(addMember(as('mnsb-admin'), 'mnsb', 'new-user'));
});
test('adding a member without bumping userCount is refused', async () => {
  await assertFails(addMember(as('mnsb-admin'), 'mnsb', 'sneaky', 'technician', { bump: false }));
});
test('tenant admin CANNOT add a user to another tenant', async () => {
  const db = as('mnsb-admin');
  await assertFails(setDoc(doc(db, 'userTenants/new-user'), { tenantId: 'acme' }));
  await assertFails(addMember(db, 'acme', 'new-user'));
});
test('tenant admin CANNOT take over a user that already belongs to another tenant', async () => {
  await assertFails(setDoc(doc(as('mnsb-admin'), 'userTenants/acme-tech'), { tenantId: 'mnsb' }));
});
test('manager cannot create or promote to admin', async () => {
  await assertFails(addMember(as('mnsb-mgr'), 'mnsb', 'u2', 'admin'));
  await assertFails(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/members/mnsb-tech'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/members/mnsb-tech'), { role: 'engineer' }));
});
test('nobody can change their own role', async () => {
  await assertFails(updateDoc(doc(as('mnsb-tech'), 'tenants/mnsb/members/mnsb-tech'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb/members/mnsb-admin'), { role: 'technician' }));
});
test('technician cannot manage users', async () => {
  await assertFails(addMember(as('mnsb-tech'), 'mnsb', 'u3'));
});

// ── Disable / suspend ───────────────────────────
test('disabled user is locked out immediately', async () => {
  await assertSucceeds(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb/members/mnsb-tech'), { status: 'disabled' }));
  await assertFails(getDocs(collection(as('mnsb-tech'), 'tenants/mnsb/parts')));
});
test('disabled user can read only their own member record', async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'tenants/mnsb/members/mnsb-tech'), { status: 'disabled' }));
  await assertSucceeds(getDoc(doc(as('mnsb-tech'), 'tenants/mnsb/members/mnsb-tech')));
  await assertFails(getDoc(doc(as('mnsb-tech'), 'tenants/mnsb/members/mnsb-admin')));
  await assertFails(getDoc(doc(as('mnsb-tech'), 'tenants/acme/members/acme-tech')));
});
test('suspended tenant is locked out; tenant admin cannot un-suspend', async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'tenants/acme'), { status: 'suspended' }));
  await assertFails(getDocs(collection(as('acme-admin'), 'tenants/acme/parts')));
  await assertFails(updateDoc(doc(as('acme-admin'), 'tenants/acme'), { status: 'active' }));
});
test('tenant admin can change the ntfy topic; manager and technician cannot', async () => {
  await assertSucceeds(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb'), { 'settings.ntfyTopic': 'st-mnsb-new123' }));
  await assertFails(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb'), { 'settings.ntfyTopic': 'hijack' }));
  await assertFails(updateDoc(doc(as('mnsb-tech'), 'tenants/mnsb'), { 'settings.ntfyTopic': 'hijack' }));
  await assertFails(updateDoc(doc(as('mnsb-admin'), 'tenants/acme'), { 'settings.ntfyTopic': 'hijack' }));
});
test('tenant admin can rename company but not change plan', async () => {
  await assertSucceeds(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb'), { name: 'MNSB Sdn Bhd' }));
  await assertFails(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb'), { plan: 'enterprise' }));
});

// ── Platform owner ──────────────────────────────
test('platform owner creates tenants; tenant admins cannot', async () => {
  await assertSucceeds(setDoc(doc(as('owner'), 'tenants/newco'), { name: 'NewCo', status: 'active', plan: 'starter', maxUsers: 5 }));
  await assertFails(setDoc(doc(as('mnsb-admin'), 'tenants/evil'), { name: 'Evil', status: 'active' }));
});
test('nobody can make themselves platform owner', async () => {
  await assertFails(setDoc(doc(as('mnsb-admin'), 'platformAdmins/mnsb-admin'), { name: 'me' }));
});

// ── Free trial: self sign-up and plan limits ─────
test('anyone signed in can start one free trial and becomes its admin', async () => {
  await assertSucceeds(trialSignup(as('newbie'), 'newbie', 'newco-1a2b'));
  await assertSucceeds(getDocs(collection(as('newbie'), 'tenants/newco-1a2b/parts')));
  await assertFails(getDocs(collection(as('newbie'), 'tenants/mnsb/parts')));
});
test('trial sign-up must use the fixed trial limits', async () => {
  await assertFails(trialSignup(as('greedy'), 'greedy', 'big-co', { maxParts: 100000 }));
  await assertFails(trialSignup(as('greedy'), 'greedy', 'big-co', { maxUsers: 50 }));
  await assertFails(trialSignup(as('greedy'), 'greedy', 'big-co', { plan: 'business' }));
  await assertFails(trialSignup(as('greedy'), 'greedy', 'big-co', { createdBy: 'someone-else' }));
});
test('one free trial per account; existing members cannot start another', async () => {
  await assertSucceeds(trialSignup(as('newbie'), 'newbie', 'first-co'));
  await assertFails(trialSignup(as('newbie'), 'newbie', 'second-co'));
  await assertFails(trialSignup(as('mnsb-tech'), 'mnsb-tech', 'tech-co'));
});
test('sign-up cannot take over an existing company', async () => {
  await assertFails(trialSignup(as('attacker'), 'attacker', 'mnsb'));
  await assertFails(setDoc(doc(as('attacker'), 'tenants/mnsb/members/attacker'), { role: 'admin', status: 'active' }));
  await assertFails(setDoc(doc(as('attacker'), 'userTenants/attacker'), { tenantId: 'mnsb' }));
});
test('signed-out visitors cannot sign up', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db, 'tenants/anon-co'), { name: 'x', status: 'active', plan: 'trial', maxUsers: 3, maxParts: 10, userCount: 1, createdBy: 'x' }));
});
test('trial: 3 users max', async () => {
  await assertSucceeds(trialSignup(as('owner1'), 'owner1', 'trial-co'));
  const db = as('owner1');
  await assertSucceeds(addMember(db, 'trial-co', 'tu2'));
  await assertSucceeds(addMember(db, 'trial-co', 'tu3'));
  await assertFails(addMember(db, 'trial-co', 'tu4'));
});
test('trial admin cannot raise their own limits or reset the counter', async () => {
  await assertSucceeds(trialSignup(as('owner1'), 'owner1', 'trial-co'));
  const db = as('owner1');
  await assertFails(updateDoc(doc(db, 'tenants/trial-co'), { maxParts: 999 }));
  await assertFails(updateDoc(doc(db, 'tenants/trial-co'), { maxUsers: 99 }));
  await assertFails(updateDoc(doc(db, 'tenants/trial-co'), { userCount: 0 }));
  await assertFails(updateDoc(doc(db, 'tenants/trial-co'), { plan: 'pro' }));
  await assertSucceeds(updateDoc(doc(db, 'tenants/trial-co'), { name: 'Renamed Co' }));
});
test('trial: parts only in slot-1..slot-10, so an 11th part cannot exist', async () => {
  await assertSucceeds(trialSignup(as('owner1'), 'owner1', 'trial-co'));
  const db = as('owner1');
  for (let i = 1; i <= 10; i++) await assertSucceeds(setDoc(doc(db, `tenants/trial-co/parts/slot-${i}`), { name: 'p' + i, qty: 1 }));
  await assertFails(setDoc(doc(db, 'tenants/trial-co/parts/slot-11'), { name: 'p11', qty: 1 }));
  await assertFails(addDoc(collection(db, 'tenants/trial-co/parts'), { name: 'random id', qty: 1 }));
  await assertFails(setDoc(doc(db, 'tenants/trial-co/parts/slot-0'), { name: 'p0', qty: 1 }));
  // editing an existing slot is still fine; deleting frees it for reuse
  await assertSucceeds(updateDoc(doc(db, 'tenants/trial-co/parts/slot-3'), { qty: 5 }));
  await assertSucceeds(deleteDoc(doc(db, 'tenants/trial-co/parts/slot-3')));
  await assertSucceeds(setDoc(doc(db, 'tenants/trial-co/parts/slot-3'), { name: 'reused', qty: 1 }));
});
test('companies without a part limit keep normal ids', async () => {
  await assertSucceeds(addDoc(collection(as('mnsb-admin'), 'tenants/mnsb/parts'), { name: 'any id', qty: 1 }));
});
test('platform owner upgrades a trial by lifting the limits', async () => {
  await assertSucceeds(trialSignup(as('owner1'), 'owner1', 'trial-co'));
  await assertSucceeds(updateDoc(doc(as('owner'), 'tenants/trial-co'), { plan: 'pro', maxUsers: 20, maxParts: 0 }));
  await assertSucceeds(addDoc(collection(as('owner1'), 'tenants/trial-co/parts'), { name: 'unlimited now', qty: 1 }));
});
