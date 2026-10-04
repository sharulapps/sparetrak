// Security-rules tests for the multi-tenant layout.
// Run: npm test   (starts the Firestore emulator, runs these, stops it)
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection,
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
  const db = as('mnsb-admin');
  await assertSucceeds(setDoc(doc(db, 'userTenants/new-user'), { tenantId: 'mnsb' }));
  await assertSucceeds(setDoc(doc(db, 'tenants/mnsb/members/new-user'), { role: 'technician', status: 'active', name: 'New' }));
});
test('tenant admin CANNOT add a user to another tenant', async () => {
  const db = as('mnsb-admin');
  await assertFails(setDoc(doc(db, 'userTenants/new-user'), { tenantId: 'acme' }));
  await assertFails(setDoc(doc(db, 'tenants/acme/members/new-user'), { role: 'technician', status: 'active' }));
});
test('tenant admin CANNOT take over a user that already belongs to another tenant', async () => {
  await assertFails(setDoc(doc(as('mnsb-admin'), 'userTenants/acme-tech'), { tenantId: 'mnsb' }));
});
test('manager cannot create or promote to admin', async () => {
  await assertFails(setDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/members/u2'), { role: 'admin', status: 'active' }));
  await assertFails(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/members/mnsb-tech'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(as('mnsb-mgr'), 'tenants/mnsb/members/mnsb-tech'), { role: 'engineer' }));
});
test('nobody can change their own role', async () => {
  await assertFails(updateDoc(doc(as('mnsb-tech'), 'tenants/mnsb/members/mnsb-tech'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('mnsb-admin'), 'tenants/mnsb/members/mnsb-admin'), { role: 'technician' }));
});
test('technician cannot manage users', async () => {
  await assertFails(setDoc(doc(as('mnsb-tech'), 'tenants/mnsb/members/u3'), { role: 'technician', status: 'active' }));
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
