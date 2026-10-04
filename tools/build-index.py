"""Build the multi-tenant prototype index.html from the current single-tenant app.

Usage: python3 tools/build-index.py <path-to-sparetrack/public/index.html>
Writes public/index.html. Every change is an exact-match replacement that must
apply exactly once, so the build fails loudly if the source app has drifted.
"""
import sys, re, pathlib

src = pathlib.Path(sys.argv[1]).read_text()
s = src

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f'expected {count} match(es), found {n}: {old[:80]!r}')
    s = s.replace(old, new)

# ── 1. Firebase config lives in public/firebase-config.js ──────
# (shared with platform.html; also defines USE_EMULATOR / ACTIVE_FIREBASE_CONFIG)
a = s.index("// ═══════════════════════════════════════════\n// FIREBASE CONFIG - isi selepas setup Firebase")
b = s.index("let parts=[], transactions=[], filter='all', editId=null;")
s = s[:a] + "// Firebase settings: see firebase-config.js (loaded just before this script)\n\n" + s[b:]
rep("<script>\n// Firebase settings: see firebase-config.js",
    '<script src="firebase-config.js"></script>\n<script>\n// Firebase settings: see firebase-config.js')
rep("Not configured. Add your Firebase config in the HTML file (search for <code>FIREBASE_CONFIG</code>).",
    "Not configured. Fill in <code>firebase-config.js</code> with your Firebase project settings.")

# ── 2. Firebase init + tenant context ───────────────────────────
a = s.index("let db=null, useCloud=false;")
b = s.index("async function loadFromCloud(){")
s = s[:a] + r"""let db=null, useCloud=false;
let currentUser=null;

// ── TENANT CONTEXT ───────────────────────────
// All tenant data lives under tenants/{TID}/. The app keeps calling
// collection(db,'parts') / doc(db,'parts',id) through window._fs, and those two
// helpers prefix tenants/{TID}/ automatically, so no query can reach another
// tenant by accident. Firestore rules enforce the same boundary server-side.
let TID=null, TENANT=null;
const TENANT_COLS={parts:'parts',transactions:'transactions',approvals:'approvals',users:'members'};
// Per-tenant localStorage keys, so two companies on one device never share a cache
function tenantKey(k){return k+'_'+(TID||'none');}
function ntfyTopic(){return (TENANT&&TENANT.settings&&TENANT.settings.ntfyTopic)||'';}
function tenantName(){return (TENANT&&TENANT.name)||'SpareTrack';}

async function initFirebase(){
  if(!FIREBASE_CONFIG) return;
  if(!USE_EMULATOR&&!FIREBASE_CONFIG_READY){
    showLogin(); showLoginError('Firebase is not set up yet. Fill in firebase-config.js with your Firebase project settings.');
    return;
  }
  try{
    const SDK='https://www.gstatic.com/firebasejs/10.7.1/';
    const {initializeApp,deleteApp}=await import(SDK+'firebase-app.js');
    const fsm=await import(SDK+'firebase-firestore.js');
    const am=await import(SDK+'firebase-auth.js');
    const app=initializeApp(ACTIVE_FIREBASE_CONFIG);
    if(USE_EMULATOR){
      db=fsm.getFirestore(app);
      fsm.connectFirestoreEmulator(db,'127.0.0.1',8080);
    }else{
      // Enable offline persistence using new API
      try{ db=fsm.initializeFirestore(app,{localCache:fsm.persistentLocalCache({tabManager:fsm.persistentMultipleTabManager()})}); }
      catch(e){ db=fsm.getFirestore(app); }
    }
    const auth=am.getAuth(app);
    if(USE_EMULATOR) am.connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
    const tPath=name=>{ if(!TID) throw new Error('No company selected'); return ['tenants',TID,TENANT_COLS[name]||name]; };
    window._fs={
      // tenant-scoped
      collection:(d,name,...rest)=>fsm.collection(d,...tPath(name),...rest),
      doc:(d,name,...rest)=>fsm.doc(d,...tPath(name),...rest),
      // unscoped, only for userTenants/ and tenants/{TID} itself
      rootDoc:fsm.doc,
      getDocs:fsm.getDocs,getDoc:fsm.getDoc,addDoc:fsm.addDoc,setDoc:fsm.setDoc,updateDoc:fsm.updateDoc,deleteDoc:fsm.deleteDoc,
      onSnapshot:fsm.onSnapshot,query:fsm.query,orderBy:fsm.orderBy,writeBatch:fsm.writeBatch,
      terminate:fsm.terminate,clearIndexedDbPersistence:fsm.clearIndexedDbPersistence,db
    };
    window._auth={auth,signInWithEmailAndPassword:am.signInWithEmailAndPassword,signOut:am.signOut,
      createUserWithEmailAndPassword:am.createUserWithEmailAndPassword,onAuthStateChanged:am.onAuthStateChanged,
      getAuth:am.getAuth,connectAuthEmulator:am.connectAuthEmulator,initializeApp,deleteApp};
    useCloud=true;
    // Listen to auth state
    am.onAuthStateChanged(auth, async user=>{
      if(!user){ currentUser=null; TID=null; TENANT=null; showLogin(); return; }
      try{
        await loadTenantContext(user);
      }catch(e){
        currentUser=null; TID=null; TENANT=null;
        try{ await am.signOut(auth); }catch(_){}
        showLogin(); showLoginError(e.message);
        return;
      }
      showApp();
      applyTenantBranding();
      // Device-local stocktake history is keyed per company; load it now that TID is known
      if(typeof loadStkHistory==='function'){ loadStkHistory(); if(typeof renderStkHistory==='function') renderStkHistory(); }
      document.getElementById('firebase-status').innerHTML='<span style="color:var(--green-text)">✓ Firebase connected. Data sync active for '+tenantName()+'.</span>';
      document.getElementById('sync-bar').classList.add('show');
      document.getElementById('sync-msg').textContent='Cloud sync active - '+currentUser.name+' ('+currentUser.role+') · '+tenantName();
      await loadFromCloud();
      listenCloud();
    });
  }catch(e){
    console.error('Firebase error:',e);
    document.getElementById('firebase-status').innerHTML='<span style="color:var(--red-text)">✗ Firebase error: '+e.message+'</span>';
    loadLocal();
  }
}

// Resolve which company the signed-in user belongs to. Throws a user-facing
// message when the account is not linked, disabled, or the company is suspended.
async function loadTenantContext(user){
  const {getDoc,rootDoc,db}=window._fs;
  let map;
  try{ map=await getDoc(rootDoc(db,'userTenants',user.uid)); }catch(e){ map=null; }
  if(!map||!map.exists()) throw new Error('This account is not linked to any company. Contact your administrator.');
  const tid=map.data().tenantId;
  let t,m;
  try{ m=await getDoc(rootDoc(db,'tenants',tid,'members',user.uid)); }
  catch(e){ throw new Error('Access denied. Contact your administrator.'); }
  if(!m.exists()) throw new Error('This account is not linked to any company. Contact your administrator.');
  if(m.data().status!=='active') throw new Error('Your account has been disabled. Contact your administrator.');
  try{ t=await getDoc(rootDoc(db,'tenants',tid)); }
  catch(e){ throw new Error('Your company\'s SpareTrack access is suspended. Contact SpareTrack support.'); }
  TID=tid;
  TENANT={id:tid,...t.data()};
  currentUser={uid:user.uid,email:user.email,...m.data()};
}

function applyTenantBranding(){
  const el=document.getElementById('tenant-name');
  if(el) el.textContent=tenantName();
  document.title=tenantName()+' · SpareTrack';
  const sub=document.getElementById('users-sub');
  if(sub) sub.textContent='Add and manage user accounts for '+tenantName();
}

function showLoginError(msg){
  const errEl=document.getElementById('login-error');
  const btn=document.getElementById('login-btn');
  if(errEl){errEl.textContent=msg;errEl.style.display='block';}
  if(btn){btn.textContent='Sign In';btn.disabled=false;}
}

""" + s[b:]

if s.count("let currentUser=null;") != 1:
    sys.exit('currentUser declaration count changed: %d' % s.count("let currentUser=null;"))

# ── 3. Per-tenant localStorage keys ─────────────────────────────
for k in ['sp_parts', 'sp_txn', 'sp_stk', 'sp_ntfy_alert_date']:
    n = s.count(f"'{k}'")
    if n == 0: sys.exit('missing localStorage key ' + k)
    s = s.replace(f"'{k}'", f"tenantKey('{k}')")

# Stocktake history lives only on the device. Adopt the pre-migration key
# ('sp_stk') the first time a company signs in, so existing history is kept.
rep("try{stocktakeHistory=JSON.parse(localStorage.getItem(tenantKey('sp_stk'))||'[]');}catch(e){stocktakeHistory=[];}",
    "try{let raw=localStorage.getItem(tenantKey('sp_stk'));if(raw===null&&TID){raw=localStorage.getItem('sp_stk');if(raw!==null)localStorage.setItem(tenantKey('sp_stk'),raw);}stocktakeHistory=JSON.parse(raw||'[]');}catch(e){stocktakeHistory=[];}")

# ── 4. ntfy topic per tenant ────────────────────────────────────
rep("fetch('https://ntfy.sh/mnsb_sparepart',{", "if(ntfyTopic()) fetch('https://ntfy.sh/'+ntfyTopic(),{", count=2)

# ── 5. Company name in emails ───────────────────────────────────
rep("company:  'MNSB',", "company:  tenantName(),", count=2)
rep('placeholder="name@mnsb.com"', 'placeholder="name@company.com"')
rep('placeholder="ahmad@mnsb.com"', 'placeholder="ahmad@company.com"')

# ── 6. Tenant name in the header ────────────────────────────────
rep('<div class="logo-name">SpareTrack</div>',
    '<div class="logo-name">SpareTrack</div>\n      <div class="logo-tenant" id="tenant-name"></div>')
rep(".sval.indigo { color: #4338CA }",
    ".sval.indigo { color: #4338CA }\n.logo-tenant { font-size:11px; font-weight:700; color:var(--gold,#C9A24E); text-transform:uppercase; letter-spacing:.4px; margin-top:2px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }")
rep('<div style="font-size:13px;color:var(--text2);margin-bottom:16px">Add and manage SpareTrack user accounts</div>',
    '<div style="font-size:13px;color:var(--text2);margin-bottom:16px" id="users-sub">Add and manage SpareTrack user accounts</div>')

# ── 7. Logout clears this tenant's cache from the device ────────
rep("""  if(window._auth){
    try{await window._auth.signOut(window._auth.auth);}catch(e){}
  }
  currentUser=null;
  showLogin();""",
"""  if(window._auth){
    try{await window._auth.signOut(window._auth.auth);}catch(e){}
  }
  // Remove this company's cached data from the device before the next user signs in
  try{ ['sp_parts','sp_txn','sp_stk','sp_ntfy_alert_date'].forEach(k=>localStorage.removeItem(tenantKey(k))); }catch(e){}
  try{ const f=window._fs; await f.terminate(f.db); await f.clearIndexedDbPersistence(f.db); }catch(e){}
  location.reload();""")

# ── 8. Create user inside the admin's own tenant ────────────────
a = s.index("async function createUser(){")
b = s.index("async function loadUsers(){")
s = s[:a] + r"""async function createUser(){
  if(!can('users')){toast('Permission denied!');return;}
  const name  = document.getElementById('nu-name').value.trim();
  const email = document.getElementById('nu-email').value.trim();
  const pass  = document.getElementById('nu-pass').value;
  const role  = document.getElementById('nu-role').value;
  if(!name||!email||!pass){toast('Please fill in all fields!');return;}
  if(pass.length<6){toast('Password must be at least 6 characters');return;}
  if(role==='admin'&&currentUser.role!=='admin'){toast('Only an admin can create another admin');return;}
  const A=window._auth; let sec=null;
  try{
    // A secondary Firebase app creates the account, so the admin stays signed in
    sec=A.initializeApp(ACTIVE_FIREBASE_CONFIG,'sec_'+Date.now());
    const secAuth=A.getAuth(sec);
    if(USE_EMULATOR) A.connectAuthEmulator(secAuth,'http://127.0.0.1:9099',{disableWarnings:true});
    const cred=await A.createUserWithEmailAndPassword(secAuth,email,pass);
    const uid=cred.user.uid;
    try{ await A.signOut(secAuth); }catch(e){}
    // Link the account to THIS company only (rules reject any other tenantId)
    const {writeBatch,rootDoc,doc,db}=window._fs;
    const batch=writeBatch(db);
    batch.set(rootDoc(db,'userTenants',uid),{tenantId:TID});
    batch.set(doc(db,'users',uid),{name,email,role,status:'active',createdAt:Date.now(),createdBy:currentUser.uid});
    await batch.commit();
    try{ sendWelcomeEmail(name, email, pass); }catch(e){}
    toast('User '+name+' added to '+tenantName()+' ✓');
    ['nu-name','nu-email','nu-pass'].forEach(id=>document.getElementById(id).value='');
    loadUsers();
  }catch(e){
    let msg=e.message||'Failed to create user';
    if(e.code==='auth/email-already-in-use'||msg.includes('EMAIL_EXISTS')) msg='This email is already registered (it may belong to another company)';
    if(e.code==='permission-denied') msg='Permission denied by security rules';
    toast('Error: '+msg);
  }finally{
    if(sec){ try{ await A.deleteApp(sec); }catch(e){} }
  }
}

async function toggleUserStatus(uid){
  if(!can('users'))return;
  const user=allUsers.find(u=>u.uid===uid);
  if(!user||uid===currentUser.uid)return;
  const next=user.status==='disabled'?'active':'disabled';
  if(next==='disabled'&&!confirm('Disable '+(user.name||user.email)+'? They will be signed out of '+tenantName()+' immediately.'))return;
  try{
    const {doc,updateDoc,db}=window._fs;
    await updateDoc(doc(db,'users',uid),{status:next});
    user.status=next; renderUserList();
    toast(next==='disabled'?'User disabled':'User enabled ✓');
  }catch(e){toast('Failed to update user: '+(e.code||e.message));}
}

""" + s[b:]

# ── 9. User list: status badge, enable/disable, no self-edit ────
rep("""        <div style="font-size:12px;color:var(--text2);margin-top:2px">${u.email||'-'}</div>
      </div>""",
"""        <div style="font-size:12px;color:var(--text2);margin-top:2px">${u.email||'-'}</div>
        ${u.status==='disabled'?'<div style="font-size:10.5px;font-weight:700;color:var(--red-text);margin-top:3px;text-transform:uppercase;letter-spacing:.3px">Disabled</div>':''}
      </div>""")
rep("""        <select onchange="updateUserRole('${u.uid}',this.value)" style="font-size:11px;padding:3px 6px;border:0.5px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--text2);cursor:pointer">
          ${['technician','engineer','manager','finance','purchasing','production','admin'].map(r=>`<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
        </select>""",
"""        ${u.uid===currentUser.uid?'<span style="font-size:11px;color:var(--text3)">You</span>':(currentUser.role!=='admin'&&u.role==='admin')?'':`<div style="display:flex;gap:6px;align-items:center">
        <select onchange="updateUserRole('${u.uid}',this.value)" style="font-size:11px;padding:3px 6px;border:0.5px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--text2);cursor:pointer">
          ${['technician','engineer','manager','finance','purchasing','production','admin'].filter(r=>r!=='admin'||currentUser.role==='admin').map(r=>`<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
        </select>
        <button class="act" onclick="toggleUserStatus('${u.uid}')" style="padding:3px 8px;font-size:10.5px;${u.status==='disabled'?'color:var(--green-text)':'color:var(--red-text)'}">${u.status==='disabled'?'Enable':'Disable'}</button>
        </div>`}""")
rep("await setDoc(doc(db,'users',uid),{...user,role:newRole});",
    "const {uid:_u,...rest}=user; await setDoc(doc(db,'users',uid),{...rest,role:newRole});")

# Low-stock and approval alerts use ntfySend (query-string title/priority/tags)
rep("""  if(ntfyTopic()) fetch('https://ntfy.sh/'+ntfyTopic(),{
    method:'POST',mode:'no-cors',
    headers:{'Title':'LOW STOCK ALERT - SpareTrack','Priority':'high','Tags':'warning,red_circle','Content-Type':'text/plain'},
    body:msg
  }).catch(()=>{});""",
"""  ntfySend({title:'LOW STOCK ALERT - '+tenantName(),priority:'high',tags:'warning,red_circle'},msg);""")
rep("""      if(ntfyTopic()) fetch('https://ntfy.sh/'+ntfyTopic(),{
        method:'POST', mode:'no-cors',
        headers:{'Title':'Request '+typeLabel+' Sparepart','Priority':'high','Tags':ntfyTags,'Content-Type':'text/plain'},
        body:'[REQUEST '+typeLabel+'] '+p.name+'\\nQuantity: '+qty+' '+p.unit+'\\nRequested by: '+user+(currentUser&&currentUser.role?' ('+currentUser.role+')':'')+'\\nNote: '+(note||'-')+'\\nDate: '+date+'\\n\\n→ Please approve/reject in SpareTrack'
      }).catch(()=>{});""",
"""      ntfySend({title:'Request '+typeLabel+' Sparepart',priority:'high',tags:ntfyTags},
        '[REQUEST '+typeLabel+'] '+p.name+'\\nQuantity: '+qty+' '+p.unit+'\\nRequested by: '+user+(currentUser&&currentUser.role?' ('+currentUser.role+')':'')+'\\nNote: '+(note||'-')+'\\nDate: '+date+'\\n\\n→ Please approve/reject in SpareTrack');""")

# ── 10. Notifications (ntfy) card in the Alert tab ────────────────────
# Every member sees the company's topic (copy / QR) so they can subscribe;
# only the tenant admin can send a test or change the topic (rules allow
# admins to update tenants/{TID}.settings).
# In the Alert tab, which every role can open (technicians have no Reports tab)
rep('  <div id="alert-list"></div>',
    '  <div id="alert-list"></div>\n'
    '  <div class="sec-label" style="margin-top:22px">Get these alerts on your phone (ntfy)</div>\n'
    '  <div class="ntfy-card" id="ntfy-card"></div>')

NTFY_CSS = """.ntfy-card { background:var(--bg2); border:1.5px solid var(--border); border-radius:var(--radius-lg); padding:16px; display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap }
.ntfy-qr { background:#fff; border:1px solid var(--border2); border-radius:12px; padding:8px; flex-shrink:0; line-height:0 }
.ntfy-qr img, .ntfy-qr canvas { width:132px!important; height:132px!important }
.ntfy-body { flex:1; min-width:220px }
.ntfy-topic { display:flex; gap:6px; align-items:center; margin:6px 0 10px; flex-wrap:wrap }
.ntfy-topic code { font-family:'SF Mono','Fira Code','Courier New',monospace; font-size:13px; font-weight:700; color:var(--navy); background:#fff; border:1px solid var(--border2); border-radius:8px; padding:7px 10px; word-break:break-all }
.ntfy-steps { font-size:12px; color:var(--text2); line-height:1.7; margin:0 0 12px 18px }
.ntfy-actions { display:flex; gap:8px; flex-wrap:wrap }
.ntfy-edit { display:none; gap:6px; margin-top:10px; flex-wrap:wrap }
.ntfy-edit input { flex:1; min-width:0; box-sizing:border-box; padding:8px 10px; border:1.5px solid var(--border2); border-radius:8px; font-family:'SF Mono','Fira Code',monospace; font-size:13px }
"""
rep(".logo-tenant { ", NTFY_CSS + ".logo-tenant { ")

NTFY_JS = r"""// ── NOTIFICATIONS (ntfy) ─────────────────────
// Everyone in the company sees the topic so they can subscribe; only the
// tenant admin can send a test or change it.
function ntfyUrl(t){return 'https://ntfy.sh/'+encodeURIComponent(t);}
// Title / priority / tags go in the query string: fetch() in no-cors mode
// silently drops custom headers such as "Title", so ntfy never saw them.
function ntfySend(o,body){
  const topic=ntfyTopic(); if(!topic) return Promise.resolve();
  const q=new URLSearchParams();
  if(o.title) q.set('title',o.title);
  if(o.priority) q.set('priority',o.priority);
  if(o.tags) q.set('tags',o.tags);
  return fetch(ntfyUrl(topic)+'?'+q.toString(),{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body}).catch(()=>{});
}
function randomNtfyTopic(){
  const a=new Uint8Array(6); crypto.getRandomValues(a);
  return 'st-'+(TID||'co')+'-'+[...a].map(b=>'abcdefghijkmnpqrstuvwxyz23456789'[b%32]).join('');
}
function renderNtfyCard(){
  const el=document.getElementById('ntfy-card'); if(!el) return;
  const topic=ntfyTopic(), isAdmin=!!(currentUser&&currentUser.role==='admin');
  if(!topic){
    el.innerHTML=`<div class="ntfy-body"><b style="color:var(--navy)">Notifications are off for ${dupEsc(tenantName())}.</b>
      <div style="font-size:12px;color:var(--text2);margin-top:4px">${isAdmin?'Create a topic to send low-stock and approval alerts to phones.':'Ask your admin to turn on notifications.'}</div>
      ${isAdmin?'<div class="ntfy-actions" style="margin-top:12px"><button class="act" onclick="regenNtfyTopic()">Create topic</button></div>':''}</div>`;
    return;
  }
  el.innerHTML=`<div class="ntfy-qr" id="ntfy-qr" title="Scan to subscribe"></div>
    <div class="ntfy-body">
      <div style="font-size:12px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Topic for ${dupEsc(tenantName())}</div>
      <div class="ntfy-topic"><code id="ntfy-topic-text">${dupEsc(topic)}</code><button class="act" onclick="copyNtfyTopic()">Copy</button></div>
      <ol class="ntfy-steps">
        <li>Install the <b>ntfy</b> app (Play Store / App Store)</li>
        <li>Scan the QR code, or tap <b>+</b> → <b>Subscribe to topic</b> and enter the topic above</li>
        <li>You will get low-stock and approval alerts on your phone</li>
      </ol>
      ${isAdmin?`<div class="ntfy-actions">
        <button class="act" onclick="sendNtfyTest()">Send test notification</button>
        <button class="act" onclick="toggleNtfyEdit(true)">Change topic</button>
        <button class="act" onclick="regenNtfyTopic()" style="color:var(--red-text)">Generate new topic</button>
      </div>
      <div class="ntfy-edit" id="ntfy-edit">
        <input id="ntfy-edit-input" value="${dupEsc(topic)}" maxlength="64" spellcheck="false">
        <button class="act" onclick="saveNtfyTopic(document.getElementById('ntfy-edit-input').value.trim())">Save</button>
        <button class="act" onclick="toggleNtfyEdit(false)">Cancel</button>
      </div>`:''}
    </div>`;
  const qr=document.getElementById('ntfy-qr');
  if(typeof QRCode!=='undefined'){
    new QRCode(qr,{text:ntfyUrl(topic),width:132,height:132,colorDark:'#0A1628',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }else{ qr.style.display='none'; }
}
function toggleNtfyEdit(on){const e=document.getElementById('ntfy-edit');if(e)e.style.display=on?'flex':'none';}
async function copyNtfyTopic(){
  try{ await navigator.clipboard.writeText(ntfyTopic()); toast('Topic copied ✓'); }
  catch(e){ toast('Copy failed — select the topic and copy it manually'); }
}
async function sendNtfyTest(){
  const topic=ntfyTopic(); if(!topic) return;
  await ntfySend({title:'SpareTrack test - '+tenantName(),tags:'white_check_mark'},
    'Test notification from '+(currentUser.name||currentUser.email)+'. If you can read this, alerts are working.');
  toast('Test sent — check your phone');
}
async function saveNtfyTopic(topic){
  if(!currentUser||currentUser.role!=='admin'){toast('Only an admin can change the topic');return;}
  if(!/^[A-Za-z0-9_-]{6,64}$/.test(topic)){toast('Topic: 6-64 letters, numbers, - or _');return;}
  if(topic===ntfyTopic()){toggleNtfyEdit(false);return;}
  try{
    const {updateDoc,rootDoc,db}=window._fs;
    await updateDoc(rootDoc(db,'tenants',TID),{'settings.ntfyTopic':topic});
    TENANT.settings={...(TENANT.settings||{}),ntfyTopic:topic};
    renderNtfyCard();
    toast('Topic updated ✓ — everyone must subscribe to the new topic');
  }catch(e){ toast('Failed to update topic: '+(e.code||e.message)); }
}
function regenNtfyTopic(){
  if(ntfyTopic()&&!confirm('Generate a new topic?\n\nPhones subscribed to the current topic will stop receiving alerts until they subscribe to the new one.'))return;
  saveNtfyTopic(randomNtfyTopic());
}

function applyTenantBranding(){"""
rep("function applyTenantBranding(){", NTFY_JS)
rep("  if(sub) sub.textContent='Add and manage user accounts for '+tenantName();",
    "  if(sub) sub.textContent='Add and manage user accounts for '+tenantName();\n  renderNtfyCard();")

pathlib.Path('public/index.html').write_text(s)
print('public/index.html written:', len(s), 'chars')
