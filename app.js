// ═══════════════════════════════════════════════════════════
// Physiclinic — PT Clinic Management
// Data lives in Firebase (project physiclinic-4a8d1):
//   patients/{id}      basic info, history, visits[], sessions[], payments[], hep
//   appointments/{id}  date, time, patientId, doctorId, type, price, status
//   expenses/{id}      date, amount, category, note
//   users/{uid}        name, email, role (doctor | receptionist | pending), disabled
//   config/options     assessment pick-lists
//   config/clinic      clinic profile, schedule, prices, doctors
// ═══════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { setupQuickSheet } from "./quick-sheet.js?v=5";

const fbApp = initializeApp({
  apiKey: "AIzaSyBV6--Y8VTOIm0XhU1h-6GSJmJiWwbBMd8",
  authDomain: "physiclinic-4a8d1.firebaseapp.com",
  projectId: "physiclinic-4a8d1",
  storageBucket: "physiclinic-4a8d1.firebasestorage.app",
  messagingSenderId: "581907813652",
  appId: "1:581907813652:web:c203369bb92e63d01b1e01"
});
const AUTH = getAuth(fbApp);
let DB;
try {
  // Offline cache: the app keeps working on a weak connection and syncs later.
  DB = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  console.warn('Offline cache unavailable', e);
  DB = initializeFirestore(fbApp, {});
}

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let me = null;              // { uid, email, name, role }
let patients = [];          // realtime list
let options = null;         // assessment options (cached)
let clinic = {};            // clinic settings (realtime)
let currentPage = 'dashboard';
let profileId = null;       // patient open in profile
let profileTab = 'overview';
let hepDirty = false;
let unsubs = [];            // listeners to stop on sign-out
let dashUnsub = null, schedUnsub = null;
let dashAppts = [];
let schedAppts = [];
let scheduleDate = '';
let patientFilter = 'all';
let patientLimit = 60;

const CLINIC_DEFAULTS = {
  clinicName: 'Physiclinic', doctorName: '', address: '', phone: '', logoUrl: '',
  workStart: '09:00', workEnd: '21:00', sessionDur: 45, sessionPrice: 0, initialPrice: 0,
  currency: 'EGP', followupDays: 10, scheduleDoctors: [],
  waTemplate: 'أهلاً {name} 👋\nبنفكرك بميعاد جلسة العلاج الطبيعي في {clinic} يوم {date} الساعة {time} مع {doctor}.\nياريت تأكد الحضور 🙏'
};

// ─────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Local date (not UTC) so late-night entries get the right day in Egypt.
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
function fmtDate(s, opts) {
  if (!s) return '';
  return parseDate(s).toLocaleDateString('en-GB', opts || { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
}
const toMins = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const toTime = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function money(n) { return `${Math.round(num(n)).toLocaleString('en-US')} ${esc(clinic.currency || 'EGP')}`; }
function isDoctor() { return me && me.role !== 'receptionist'; }
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// Build an element: el('div', {class:'x', onclick: fn}, 'text', childEl)
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
function btn(text, cls, onclick, extra = {}) { return el('button', { class: 'btn ' + cls, type: 'button', onclick, ...extra }, text); }

// WhatsApp link. Egyptian numbers like 010xxxxxxxx become 2010xxxxxxxx.
function waPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = '2' + d;
  else if (d.length === 10 && d.startsWith('1')) d = '20' + d;
  return d;
}
function waLink(phone, text) {
  const p = waPhone(phone);
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text || '')}` : '';
}
function openWa(phone, text) {
  const url = waLink(phone, text);
  if (!url) { showToast('No phone number for this patient', true); return; }
  window.open(url, '_blank', 'noopener');
}

// ─────────────────────────────────────────
// UI HELPERS: modals, toast, dialogs
// ─────────────────────────────────────────
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) closeModal(c.dataset.close);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('confirm-overlay').classList.contains('open')) { closeConfirm(); return; }
  const dyn = [...document.querySelectorAll('.modal-overlay.dynamic.open')].pop();
  if (dyn) { dyn.remove(); return; }
  const open = [...document.querySelectorAll('.modal-overlay.open')].pop();
  if (open) open.classList.remove('open');
});

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 4500 : 2800);
}
function errMsg(e) {
  const m = e?.code || e?.message || String(e);
  if (/permission/i.test(m)) return 'Permission denied — check the Firestore rules (see README).';
  return 'Error: ' + (e?.message || m);
}

// Generic dialog. buttons: [{text, cls, onClick, keepOpen}]
function dialog({ icon = '⚠️', title = '', message = '', buttons = [], wide = false }) {
  $('confirm-icon').textContent = icon;
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-box').classList.toggle('wide', wide);
  const wrap = $('confirm-buttons');
  wrap.innerHTML = '';
  wrap.className = buttons.length > 3 ? 'sheet-actions' : '';
  wrap.style.cssText = buttons.length > 3 ? '' : 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap';
  buttons.forEach(b => {
    const bt = btn(b.text, (b.cls || 'btn-ghost') + ' btn-sm' + (b.full ? ' full' : ''), async () => {
      if (!b.keepOpen) closeConfirm();
      if (b.onClick) {
        try { await b.onClick(); } catch (e) { console.error(e); showToast(errMsg(e), true); }
      }
    });
    wrap.appendChild(bt);
  });
  $('confirm-overlay').classList.add('open');
}
function closeConfirm() { $('confirm-overlay').classList.remove('open'); }
function confirmAction(title, message, onConfirm, okText = 'Delete') {
  dialog({ title, message, buttons: [{ text: 'Cancel' }, { text: okText, cls: 'btn-danger', onClick: onConfirm }] });
}

// Small form dialog built on the fly. fields: [{id,label,type,value,options,placeholder}]
function formDialog({ title, fields, saveText = 'Save', onSave }) {
  const overlay = el('div', { class: 'modal-overlay dynamic open' });
  const inputs = {};
  const body = el('div', { class: 'modal-body' });
  fields.forEach(f => {
    let inp;
    if (f.type === 'select') {
      inp = el('select', { class: 'form-control' }, ...f.options.map(o => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return el('option', { value: v, selected: String(v) === String(f.value ?? '') }, l);
      }));
    } else if (f.type === 'textarea') {
      inp = el('textarea', { class: 'form-control', rows: f.rows || 3, placeholder: f.placeholder || '' });
      inp.value = f.value ?? '';
    } else {
      inp = el('input', { class: 'form-control', type: f.type || 'text', placeholder: f.placeholder || '' });
      inp.value = f.value ?? '';
    }
    inputs[f.id] = inp;
    body.appendChild(el('div', { class: 'form-group' }, el('label', { class: 'form-label' }, f.label), inp));
  });
  const close = () => overlay.remove();
  const save = btn(saveText, 'btn-primary', async () => {
    const vals = {};
    for (const k in inputs) vals[k] = inputs[k].value.trim();
    save.disabled = true;
    try { const ok = await onSave(vals); if (ok !== false) close(); }
    catch (e) { console.error(e); showToast(errMsg(e), true); }
    finally { save.disabled = false; }
  });
  overlay.appendChild(el('div', { class: 'modal', style: 'max-width:440px' },
    el('div', { class: 'modal-header' }, el('div', { class: 'modal-title' }, title), el('button', { class: 'modal-close', onclick: close }, '✕')),
    body,
    el('div', { class: 'modal-footer' }, btn('Cancel', 'btn-ghost', close), save)
  ));
  document.body.appendChild(overlay);
  setTimeout(() => body.querySelector('input,select,textarea')?.focus(), 50);
}

function downloadBlob(filename, blob) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

// Online / offline banner
function updateOnline() { $('offline-banner').classList.toggle('hidden', navigator.onLine); }
addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);
updateOnline();

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
const cachedName = lsGet('clinicName');
if (cachedName) $('login-clinic-name').textContent = cachedName;

function loginError(msg) {
  const e = $('login-error');
  e.textContent = msg;
  e.style.display = msg ? 'block' : 'none';
}

async function loginSubmit() {
  const b = $('login-btn');
  const email = $('login-email').value.trim();
  const pass = $('login-pass').value;
  if (!email || !pass) { loginError('Enter your email and password'); return; }
  loginError('');
  b.textContent = 'Signing in...';
  b.disabled = true;
  try {
    await signInWithEmailAndPassword(AUTH, email, pass);
  } catch (e) {
    const c = e.code || '';
    loginError(c.includes('network') ? 'No internet connection' :
      c.includes('too-many') ? 'Too many attempts — try again in a few minutes' : 'Invalid email or password');
  } finally {
    b.textContent = 'Sign In →';
    b.disabled = false;
  }
}
$('login-btn').addEventListener('click', loginSubmit);
['login-email', 'login-pass'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') loginSubmit(); }));
$('forgot-btn').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  if (!email) { loginError('Type your email above first, then press "Forgot password?"'); return; }
  try {
    await sendPasswordResetEmail(AUTH, email);
    loginError('');
    showToast('Password reset email sent ✅');
  } catch (e) { loginError('Could not send reset email: ' + (e.code || e.message)); }
});

$('signout-btn').addEventListener('click', () => signOut(AUTH));

function stopListeners() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
  if (dashUnsub) { dashUnsub(); dashUnsub = null; }
  if (schedUnsub) { schedUnsub(); schedUnsub = null; }
}

function showLogin(msg = '') {
  stopListeners();
  me = null; patients = []; options = null; profileId = null; hepDirty = false; dashAppts = []; schedAppts = [];
  ['dash-body', 'finance-body', 'page-profile', 'users-card', 'manage-card', 'patient-grid', 'schedule-body'].forEach(id => { $(id).innerHTML = ''; });
  document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.modal-overlay.dynamic').forEach(m => m.remove());
  closeConfirm();
  $('app-screen').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('login-pass').value = '';
  loginError(msg);
}

let pendingLoginMsg = '';
onAuthStateChanged(AUTH, async (user) => {
  if (!user) { showLogin(pendingLoginMsg); pendingLoginMsg = ''; return; }
  try {
    const ref = doc(DB, 'users', user.uid);
    const snap = await getDoc(ref);
    let profile;
    if (snap.exists()) {
      profile = snap.data();
    } else {
      // First account ever becomes a doctor (admin). Anyone else waits for approval,
      // so a removed staff member can't sign back in with full access.
      let firstUser = false;
      try { firstUser = (await getDocs(query(collection(DB, 'users'), limit(1)))).empty; } catch {}
      profile = { name: user.email, email: user.email, role: firstUser ? 'doctor' : 'pending', createdAt: Date.now() };
      try { await setDoc(ref, profile); } catch (e) { console.warn(e); }
    }
    if (profile.disabled) { pendingLoginMsg = 'This account has been deactivated. Ask the clinic admin.'; await signOut(AUTH); return; }
    if (profile.role === 'pending') { pendingLoginMsg = 'Your account is waiting for approval by the clinic admin.'; await signOut(AUTH); return; }
    me = { uid: user.uid, email: user.email, ...profile };
    startApp();
  } catch (e) {
    console.error(e);
    pendingLoginMsg = navigator.onLine ? errMsg(e) : 'No internet connection';
    await signOut(AUTH);
  }
});

async function startApp() {
  $('login-screen').style.display = 'none';
  $('app-screen').style.display = 'block';
  $('user-name').textContent = me.name || me.email;
  $('user-role').textContent = isDoctor() ? '👨‍⚕️ Doctor' : '🗂️ Receptionist';
  document.body.classList.toggle('role-receptionist', !isDoctor());

  // Clinic settings (realtime)
  let clinicReady;
  const clinicLoaded = new Promise(r => clinicReady = r);
  unsubs.push(onSnapshot(doc(DB, 'config', 'clinic'), snap => {
    clinic = { ...CLINIC_DEFAULTS, ...(snap.exists() ? snap.data() : {}) };
    if (!Array.isArray(clinic.scheduleDoctors)) clinic.scheduleDoctors = [];
    $('sidebar-clinic-name').textContent = clinic.clinicName || 'Physiclinic';
    lsSet('clinicName', clinic.clinicName || 'Physiclinic');
    clinicReady();
    if (currentPage === 'schedule') renderScheduleGrid();
  }, err => { console.error(err); clinic = { ...CLINIC_DEFAULTS }; clinicReady(); }));

  // Patients (realtime)
  unsubs.push(onSnapshot(query(collection(DB, 'patients'), orderBy('createdAt', 'desc')), snap => {
    patients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    onPatientsChanged();
  }, err => { console.error(err); showToast(errMsg(err), true); }));

  await clinicLoaded;
  const start = parseHash();
  showPage(start.page, { id: start.id, replace: true });
}

function onPatientsChanged() {
  if (currentPage === 'patients') renderPatientList();
  else if (currentPage === 'dashboard') renderDashboard();
  else if (currentPage === 'profile' && profileId) {
    if (!(profileTab === 'hep' && hepDirty)) renderProfile();
  } else if (currentPage === 'finance') renderFinance();
}

// ─────────────────────────────────────────
// NAVIGATION (with phone back-button support)
// ─────────────────────────────────────────
const PAGES = ['dashboard', 'patients', 'profile', 'schedule', 'finance', 'manage', 'users', 'settings'];
const DOCTOR_PAGES = ['finance', 'manage', 'users', 'settings'];

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const [page, id] = h.split('/');
  if (page === 'patient' && id) return { page: 'profile', id };
  return { page: PAGES.includes(page) && page !== 'profile' ? page : 'dashboard' };
}

function showPage(name, opts = {}) {
  if (!me) return;
  const asked = name;
  if (DOCTOR_PAGES.includes(name) && !isDoctor()) name = 'dashboard';
  if (name === 'profile' && !opts.id && !profileId) name = 'patients';
  if (name !== asked) opts.replace = true;
  if (name !== 'profile') hepDirty = false;
  if (name === 'profile' && opts.id && opts.id !== profileId) { profileTab = opts.tab || 'overview'; hepDirty = false; }
  else if (opts.tab) profileTab = opts.tab;
  if (opts.id) profileId = opts.id;

  currentPage = name;
  PAGES.forEach(p => $('page-' + p).classList.toggle('hidden', p !== name));
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.page === name || (name === 'profile' && n.dataset.page === 'patients')));

  const hash = name === 'profile' ? `#patient/${profileId}` : `#${name}`;
  if (location.hash !== hash) {
    if (opts.replace || opts.fromPop) history.replaceState(null, '', hash);
    else if (!opts.fromPop) history.pushState(null, '', hash);
  }

  if (name !== 'schedule' && schedUnsub) { schedUnsub(); schedUnsub = null; }
  if (name !== 'dashboard' && dashUnsub) { dashUnsub(); dashUnsub = null; }

  ({
    dashboard: renderDashboard, patients: renderPatientList, profile: renderProfile,
    schedule: renderSchedule, finance: renderFinance, manage: renderManage,
    users: renderUsers, settings: renderSettings
  })[name]();
  closeSidebar();
  window.scrollTo(0, 0);
}
addEventListener('popstate', () => {
  if (!me) return;
  const t = parseHash();
  showPage(t.page, { id: t.id, fromPop: true });
});

$('sidebar-nav').addEventListener('click', e => {
  const b = e.target.closest('.nav-item');
  if (b) showPage(b.dataset.page);
});
function toggleSidebar() {
  const open = $('sidebar').classList.toggle('open');
  $('overlay-close').style.display = open ? 'block' : 'none';
}
function closeSidebar() {
  if (window.innerWidth <= 768) {
    $('sidebar').classList.remove('open');
    $('overlay-close').style.display = 'none';
  }
}
$('mobile-toggle').addEventListener('click', toggleSidebar);
$('overlay-close').addEventListener('click', toggleSidebar);

// ═══════════════════════════════════════════
// PATIENT CALCULATIONS
// ═══════════════════════════════════════════
const getPatient = id => patients.find(p => p.id === id);
const initialVisit = p => (p.visits || []).find(v => v.type === 'initial') || null;
const hasDischarge = p => (p.visits || []).some(v => v.type === 'discharge');
function patientStatus(p) { return p.status || (hasDischarge(p) ? 'discharged' : 'active'); }
function plannedSessions(p) {
  const ini = initialVisit(p);
  return Math.max(0, ...(ini?.regions || []).map(r => parseInt(r.sessionsPlanned) || 0));
}
const attendedCount = p => (p.sessions || []).length;
function lastActivity(p) {
  const dates = [...(p.sessions || []).map(s => s.date), ...(p.visits || []).map(v => v.date)].filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : (p.createdAt ? dateStr(new Date(p.createdAt)) : '');
}
// Sessions saved before payments existed (no "billed" flag) were treated as paid by the
// old version, so they count as collected and never create a balance.
function account(p) {
  const sessions = p.sessions || [];
  const payments = p.payments || [];
  const charges = sessions.filter(s => s.billed).reduce((t, s) => t + num(s.price), 0);
  const legacy = sessions.filter(s => !s.billed).reduce((t, s) => t + num(s.price), 0);
  const paid = payments.reduce((t, x) => t + num(x.amount), 0);
  return { charges, paid, legacy, balance: charges - paid };
}
function regionsOf(p) { return (initialVisit(p)?.regions || []).map(r => r.region); }
function diagnosesOf(p) {
  return [...new Set((p.visits || []).flatMap(v => (v.regions || []).flatMap(r => r.diagnoses || [])))];
}
function needsFollowup(p) {
  if (patientStatus(p) !== 'active') return false;
  const planned = plannedSessions(p);
  if (planned && attendedCount(p) >= planned) return false;
  const last = lastActivity(p);
  return last && daysBetween(last, todayStr()) >= (parseInt(clinic.followupDays) || 10);
}
function nextFileNo() {
  return Math.max(0, ...patients.map(p => parseInt(p.fileNo) || 0)) + 1;
}
function statusBadge(st) {
  return { active: '<span class="badge b-active">Active</span>', discharged: '<span class="badge b-discharged">Discharged</span>', onhold: '<span class="badge b-onhold">On hold</span>' }[st] || '';
}
function balanceBadge(bal) {
  if (bal > 0) return `<span class="badge b-debt">Due ${money(bal)}</span>`;
  if (bal < 0) return `<span class="badge b-credit">Credit ${money(-bal)}</span>`;
  return '';
}

// ═══════════════════════════════════════════
// PATIENT LIST
// ═══════════════════════════════════════════
const FILTERS = [
  ['all', 'All', () => true],
  ['active', 'Active', p => patientStatus(p) === 'active'],
  ['pending', 'Needs assessment', p => !initialVisit(p) && patientStatus(p) === 'active'],
  ['followup', 'Follow-up due', needsFollowup],
  ['balance', 'Has balance', p => account(p).balance > 0],
  ['discharged', 'Discharged', p => patientStatus(p) === 'discharged'],
];

function patientSearchText(p) {
  return [p.name, p.phone, p.fileNo ? '#' + p.fileNo : '', p.fileNo, ...regionsOf(p), ...diagnosesOf(p)].join(' ').toLowerCase();
}

function renderPatientList() {
  const q = ($('search-input').value || '').toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const fns = Object.fromEntries(FILTERS.map(f => [f[0], f[2]]));

  // filter chips with counts
  const chips = $('patient-filters');
  chips.innerHTML = '';
  FILTERS.forEach(([key, label, fn]) => {
    const c = patients.filter(fn).length;
    chips.appendChild(el('button', {
      class: 'chip' + (patientFilter === key ? ' active' : ''),
      onclick: () => { patientFilter = key; patientLimit = 60; renderPatientList(); }
    }, label, el('span', { class: 'count' }, c)));
  });

  const filtered = patients.filter(p => fns[patientFilter](p) && terms.every(t => patientSearchText(p).includes(t)));
  $('patient-count').textContent = `${patients.length} patient${patients.length !== 1 ? 's' : ''}` +
    (filtered.length !== patients.length ? ` · ${filtered.length} shown` : '');

  const grid = $('patient-grid');
  grid.innerHTML = '';
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="icon">👥</span>
      <h3>${q || patientFilter !== 'all' ? 'No matching patients' : 'No patients yet'}</h3>
      <p>${q || patientFilter !== 'all' ? 'Try a different search or filter' : 'Click New Patient to get started'}</p></div>`;
    $('patients-more').classList.add('hidden');
    return;
  }

  filtered.slice(0, patientLimit).forEach(p => grid.appendChild(patientCard(p)));
  $('patients-more').classList.toggle('hidden', filtered.length <= patientLimit);
}
$('patients-more').addEventListener('click', () => { patientLimit += 60; renderPatientList(); });
$('search-input').addEventListener('input', () => { patientLimit = 60; renderPatientList(); });

function patientCard(p) {
  const ini = initialVisit(p);
  const st = patientStatus(p);
  const planned = plannedSessions(p);
  const done = attendedCount(p);
  const acc = account(p);
  const regions = regionsOf(p).join(', ');
  const card = el('div', { class: 'patient-card' });
  card.innerHTML = `
    <div class="card-top">
      <div class="patient-name">${esc(p.name)}</div>
      ${p.fileNo ? `<span class="file-no">#${esc(p.fileNo)}</span>` : ''}
    </div>
    <div class="badges">
      ${statusBadge(st)}
      ${!ini ? '<span class="badge b-pending">⏳ Needs assessment</span>' : ''}
      ${needsFollowup(p) ? '<span class="badge b-pending">🔔 Follow-up due</span>' : ''}
      ${balanceBadge(acc.balance)}
    </div>
    <div class="patient-meta">
      <span>👤 ${esc(p.age)} y/o — ${esc(p.gender || '')}${p.job ? ' · ' + esc(p.job) : ''}</span>
      ${p.phone ? `<span>📞 ${esc(p.phone)}</span>` : ''}
      ${regions ? `<span>📍 ${esc(regions)}</span>` : ''}
      ${done || planned ? `<span>💪 ${done}${planned ? ' / ' + planned : ''} sessions</span>` : ''}
    </div>
    ${planned ? `<div class="progress" style="margin:-4px 0 10px"><div style="width:${Math.min(100, done / planned * 100)}%"></div></div>` : ''}
    <div class="patient-actions"></div>`;
  card.querySelector('.patient-name').addEventListener('click', () => showPage('profile', { id: p.id }));
  const actions = card.querySelector('.patient-actions');
  actions.appendChild(btn('📋 Open', 'btn-primary btn-sm', () => showPage('profile', { id: p.id })));
  actions.appendChild(btn('📅 Book', 'btn-ghost btn-sm', () => openNewAppt({ patientId: p.id })));
  if (isDoctor() && !ini) actions.appendChild(btn('✏️ Assess', 'btn-ghost btn-sm', () => openAssessment(p.id, 'initial')));
  if (p.phone) actions.appendChild(btn('💬', 'btn-ghost btn-sm', () => openWa(p.phone, ''), { title: 'WhatsApp' }));
  if (isDoctor()) actions.appendChild(btn('🗑️', 'btn-danger btn-sm', () => deletePatient(p), { title: 'Delete' }));
  return card;
}

function deletePatient(p) {
  confirmAction('Delete Patient',
    `Delete "${p.name}" with all assessments, sessions and payments?\nTheir appointments will be deleted too. This cannot be undone.`,
    async () => {
      const appts = await getDocs(query(collection(DB, 'appointments'), where('patientId', '==', p.id)));
      const batch = writeBatch(DB);
      appts.docs.forEach(d => batch.delete(d.ref));
      batch.delete(doc(DB, 'patients', p.id));
      await batch.commit();
      showToast('Patient deleted');
      if (currentPage === 'profile') showPage('patients', { replace: true });
    });
}

// ═══════════════════════════════════════════
// NEW / EDIT PATIENT
// ═══════════════════════════════════════════
let editPatientId = null;
const PT_FIELDS = { name: 'pt-name', phone: 'pt-phone', age: 'pt-age', gender: 'pt-gender', job: 'pt-job', fileNo: 'pt-fileno',
  address: 'pt-address', emergency: 'pt-emergency', referral: 'pt-referral', refDoctor: 'pt-refdoctor', status: 'pt-status' };
const HX_FIELDS = { chronic: 'pt-chronic', meds: 'pt-meds', surgeries: 'pt-surgeries', allergies: 'pt-allergies',
  imaging: 'pt-imaging', redFlags: 'pt-redflags', notes: 'pt-notes' };

function openPatientModal(pid = null) {
  editPatientId = pid;
  delete $('save-patient').dataset.dupOk;
  $('save-patient').textContent = 'Save Patient';
  const p = pid ? getPatient(pid) : null;
  $('patient-modal-title').textContent = p ? `Edit — ${p.name}` : 'New Patient';
  for (const [k, id] of Object.entries(PT_FIELDS)) $(id).value = p?.[k] ?? '';
  for (const [k, id] of Object.entries(HX_FIELDS)) $(id).value = p?.history?.[k] ?? '';
  if (!p) { $('pt-gender').value = 'Male'; $('pt-status').value = 'active'; $('pt-fileno').value = nextFileNo(); }
  else { $('pt-gender').value = p.gender || 'Male'; $('pt-status').value = patientStatus(p); }
  openModal('modal-patient');
  setTimeout(() => $('pt-name').focus(), 100);
}
$('btn-new-patient').addEventListener('click', () => openPatientModal());
$('dash-new-patient').addEventListener('click', () => openPatientModal());

$('save-patient').addEventListener('click', async () => {
  const data = {};
  for (const [k, id] of Object.entries(PT_FIELDS)) data[k] = $(id).value.trim();
  const history = {};
  for (const [k, id] of Object.entries(HX_FIELDS)) history[k] = $(id).value.trim();
  if (!data.name || !data.age) { showToast('Name and age are required', true); return; }
  if (data.phone) {
    const dup = patients.find(x => x.id !== editPatientId && x.phone && waPhone(x.phone) === waPhone(data.phone));
    if (dup && !$('save-patient').dataset.dupOk) {
      $('save-patient').dataset.dupOk = '1';
      $('save-patient').textContent = 'Save anyway';
      showToast(`Phone already used by "${dup.name}" — press again to save anyway`, true);
      return;
    }
  }
  const b = $('save-patient');
  b.disabled = true;
  try {
    if (editPatientId) {
      const prev = getPatient(editPatientId);
      const upd = { ...data, history, updatedAt: Date.now() };
      if (data.status === 'discharged' && patientStatus(prev) !== 'discharged') upd.dischargeDate = todayStr();
      await updateDoc(doc(DB, 'patients', editPatientId), upd);
      closeModal('modal-patient');
      showToast('Patient updated ✅');
    } else {
      const ref = await addDoc(collection(DB, 'patients'), {
        ...data, history, createdAt: Date.now(), createdBy: me.uid, visits: [], sessions: [], payments: []
      });
      closeModal('modal-patient');
      showToast('Patient added ✅');
      showPage('profile', { id: ref.id, tab: 'overview' });
      if (isDoctor()) setTimeout(() => openAssessment(ref.id, 'initial'), 300);
      else setTimeout(() => openNewAppt({ patientId: ref.id }), 300);
    }
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; delete b.dataset.dupOk; b.textContent = 'Save Patient'; }
});

// ═══════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════
function collectedBetween(from, to) {
  let total = 0;
  patients.forEach(p => {
    (p.payments || []).forEach(x => { if (x.date >= from && x.date <= to) total += num(x.amount); });
    (p.sessions || []).forEach(s => { if (!s.billed && s.date >= from && s.date <= to) total += num(s.price); });
  });
  return total;
}

function renderDashboard() {
  const today = todayStr();
  const h = new Date().getHours();
  const words = (me.name || me.email || '').replace(/@.*/, '').split(/\s+/).filter(Boolean);
  const first = words.find(w => !/^dr\.?$/i.test(w)) || '';
  const title = /^dr\.?$/i.test(words[0] || '') ? 'Dr. ' : '';
  $('dash-greeting').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${title}${first} 👋`;
  $('dash-date').textContent = fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (!dashUnsub) {
    dashUnsub = onSnapshot(query(collection(DB, 'appointments'), where('date', '==', today)), snap => {
      dashAppts = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      if (currentPage === 'dashboard') drawDashboard();
    }, err => { console.error(err); dashAppts = []; drawDashboard(); });
  }
  drawDashboard();
}

function drawDashboard() {
  const body = $('dash-body');
  const today = todayStr();
  const monthStart = today.slice(0, 8) + '01';
  const active = patients.filter(p => patientStatus(p) === 'active');
  const live = dashAppts.filter(a => a.status !== 'cancelled');
  const attended = dashAppts.filter(a => a.status === 'attended').length;
  const remaining = dashAppts.filter(a => a.status === 'scheduled' || a.status === 'confirmed' || !a.status).length;
  const newThisMonth = patients.filter(p => p.createdAt && dateStr(new Date(p.createdAt)) >= monthStart).length;
  const debtors = patients.map(p => ({ p, bal: account(p).balance })).filter(x => x.bal > 0).sort((a, b) => b.bal - a.bal);
  const outstanding = debtors.reduce((t, x) => t + x.bal, 0);

  const stat = (n, l, cls = '') => `<div class="stat-card ${cls}"><div class="stat-num">${n}</div><div class="stat-lbl">${l}</div></div>`;
  let html = '<div class="stats-grid">';
  html += stat(live.length, "Today's appointments", 'blue');
  html += stat(`${attended} <span style="font-size:14px;color:var(--muted)">/ ${remaining} left</span>`, 'Attended today', 'green');
  if (isDoctor()) {
    html += stat(money(collectedBetween(today, today)), 'Collected today', 'gold');
    html += stat(money(collectedBetween(monthStart, today)), 'Collected this month', 'gold');
    html += stat(money(outstanding), `Outstanding (${debtors.length} patients)`, 'red');
  }
  html += stat(active.length, 'Active patients');
  html += stat(newThisMonth, 'New patients this month');
  html += '</div>';
  body.innerHTML = html;

  const cols = el('div', { class: 'dash-cols' });

  // Today's schedule
  const todayCard = el('div', { class: 'card' });
  todayCard.appendChild(el('div', { class: 'card-title' }, "📅 Today's schedule",
    btn('Open schedule →', 'btn-ghost btn-sm', () => { scheduleDate = today; showPage('schedule'); })));
  if (!dashAppts.length) todayCard.appendChild(el('div', { class: 'empty-state', style: 'padding:24px' }, 'No appointments today'));
  dashAppts.forEach(a => {
    const p = getPatient(a.patientId);
    todayCard.appendChild(el('div', { class: 'list-row clickable', onclick: () => showApptActions(a) },
      el('div', { style: 'font-weight:700;min-width:70px;color:var(--primary-dark)' }, fmtTime(a.time)),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, p?.name || a.patientName || 'Unknown'),
        el('div', { class: 'sub' }, [a.doctorName, typeLabel(a.type), a.notes].filter(Boolean).join(' · '))),
      el('span', { html: statusPill(a.status) })));
  });
  cols.appendChild(todayCard);

  // Right column
  const right = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const due = patients.filter(needsFollowup).sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)));
  const fuCard = el('div', { class: 'card' });
  fuCard.appendChild(el('div', { class: 'card-title' }, `🔔 Follow-up due (${due.length})`,
    due.length ? btn('See all', 'btn-ghost btn-sm', () => { patientFilter = 'followup'; showPage('patients'); }) : null));
  fuCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin:-6px 0 10px' },
    `Active patients with no session for ${parseInt(clinic.followupDays) || 10}+ days`));
  if (!due.length) fuCard.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:10px' }, 'Everyone is on track ✅'));
  due.slice(0, 6).forEach(p => {
    const last = lastActivity(p);
    fuCard.appendChild(el('div', { class: 'list-row' },
      el('div', { class: 'grow clickable', style: 'cursor:pointer', onclick: () => showPage('profile', { id: p.id }) },
        el('div', { class: 'title' }, p.name),
        el('div', { class: 'sub' }, `Last visit ${fmtDate(last)} (${daysBetween(last, todayStr())} days) · ${attendedCount(p)}${plannedSessions(p) ? '/' + plannedSessions(p) : ''} sessions`)),
      p.phone ? btn('💬', 'btn-ghost btn-sm', () => openWa(p.phone, `أهلاً ${p.name} 👋\nحابين نطمن عليك ونحدد ميعاد الجلسة الجاية في ${clinic.clinicName}.`), { title: 'WhatsApp' }) : null,
      btn('📅', 'btn-ghost btn-sm', () => openNewAppt({ patientId: p.id }), { title: 'Book' })));
  });
  right.appendChild(fuCard);

  const pend = patients.filter(p => !initialVisit(p) && patientStatus(p) === 'active');
  if (pend.length) {
    const pc = el('div', { class: 'card' });
    pc.appendChild(el('div', { class: 'card-title' }, `⏳ Needs assessment (${pend.length})`));
    pend.slice(0, 5).forEach(p => pc.appendChild(el('div', { class: 'list-row clickable', onclick: () => showPage('profile', { id: p.id }) },
      el('div', { class: 'grow' }, el('div', { class: 'title' }, p.name), el('div', { class: 'sub' }, `Added ${p.createdAt ? fmtDate(dateStr(new Date(p.createdAt))) : ''}`)),
      isDoctor() ? btn('Assess', 'btn-primary btn-sm', e => { e.stopPropagation(); openAssessment(p.id, 'initial'); }) : null)));
    right.appendChild(pc);
  }

  if (isDoctor() && debtors.length) {
    const dc = el('div', { class: 'card' });
    dc.appendChild(el('div', { class: 'card-title' }, '💳 Highest balances', btn('Finance →', 'btn-ghost btn-sm', () => showPage('finance'))));
    debtors.slice(0, 5).forEach(({ p, bal }) => dc.appendChild(el('div', { class: 'list-row clickable', onclick: () => showPage('profile', { id: p.id, tab: 'billing' }) },
      el('div', { class: 'grow title' }, p.name), el('span', { class: 'badge b-debt', html: money(bal) }))));
    right.appendChild(dc);
  }
  cols.appendChild(right);
  body.appendChild(cols);
}
$('dash-new-appt').addEventListener('click', () => openNewAppt({ date: todayStr() }));

// ═══════════════════════════════════════════
// ASSESSMENT OPTIONS
// ═══════════════════════════════════════════
const DEFAULTS_VERSION = 2;
const REGION_KEYS = ['diagnoses', 'complaints', 'findings', 'treatment'];

// Reads the pick-lists. Defaults are merged in only once per DEFAULTS_VERSION,
// so an option or region the clinic removed stays removed.
async function readOptions() {
  const ref = doc(DB, 'config', 'options');
  const snap = await getDoc(ref);
  const defaults = getDefaultOptions();
  if (!snap.exists()) {
    const fresh = { ...defaults, defaultsVersion: DEFAULTS_VERSION };
    try { await setDoc(ref, fresh); } catch (e) { console.warn(e); }
    return (options = fresh);
  }
  const saved = snap.data();
  if ((saved.defaultsVersion || 0) < DEFAULTS_VERSION) {
    const merged = { ...saved, defaultsVersion: DEFAULTS_VERSION };
    merged.regions = [...(saved.regions || [])];
    defaults.regions.forEach(r => { if (!merged.regions.includes(r)) merged.regions.push(r); });
    REGION_KEYS.forEach(k => { merged[k] = { ...defaults[k], ...(saved[k] || {}) }; });
    merged.problems = saved.problems || defaults.problems;
    merged.measures = saved.measures || defaults.measures;
    merged.exercises = saved.exercises || defaults.exercises;
    try { await setDoc(ref, merged); } catch (e) { console.warn(e); }
    return (options = merged);
  }
  const o = { ...saved };
  REGION_KEYS.forEach(k => { o[k] = o[k] || {}; });
  ['regions', 'problems', 'measures', 'exercises'].forEach(k => { o[k] = o[k] || defaults[k] || []; });
  return (options = o);
}
async function writeOptions(opts) {
  await setDoc(doc(DB, 'config', 'options'), opts);
  options = opts;
}

// ═══════════════════════════════════════════
// ASSESSMENT MODAL (initial / follow-up / discharge)
// ═══════════════════════════════════════════
let A = null; // assessment being edited

const VISIT_LABEL = { initial: 'Initial Assessment', followup: 'Follow-up', discharge: 'Discharge Summary' };
const emptyRegion = name => ({ region: name, diagnoses: [], complaints: [], findings: [], problems: [], treatment: [], vas: null, measurements: '', sessionsPlanned: '', freq: '' });

async function openAssessment(pid, type, visitId = null) {
  if (!isDoctor()) { showToast('Only doctors can edit assessments', true); return; }
  const p = getPatient(pid);
  if (!p) return;
  let existing = null;
  if (type === 'initial') existing = initialVisit(p);
  else if (visitId) existing = (p.visits || []).find(v => v.id === visitId) || null;

  if (existing) {
    A = JSON.parse(JSON.stringify(existing));
    A.regions = (A.regions || []).map(r => ({ ...emptyRegion(r.region), ...r }));
  } else {
    A = { id: null, type, date: todayStr(), duration: '', onset: '', notes: '', goalsShort: '', goalsLong: '', progress: '', measures: [], regions: [] };
    if (type !== 'initial') {
      // Start from the latest visit: keep diagnoses, problems and treatment; clear today's findings.
      const prev = [...(p.visits || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '')).pop();
      A.regions = (prev?.regions || []).map(r => ({ ...emptyRegion(r.region), diagnoses: [...(r.diagnoses || [])], problems: [...(r.problems || [])], treatment: [...(r.treatment || [])] }));
      A.measures = (prev?.measures || []).map(m => ({ name: m.name, score: '' }));
    }
  }
  A.pid = pid;
  A.type = type;
  A.active = 0;

  $('assess-title').textContent = `${VISIT_LABEL[type]} — ${p.name}`;
  $('assess-body').innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading options...</span></div>';
  openModal('modal-assess');
  try {
    const opts = options || await readOptions();
    buildAssessmentForm(opts);
    if (!options) readOptions();
  } catch (e) {
    $('assess-body').innerHTML = `<div class="flag-box">${esc(errMsg(e))}</div>`;
  }
}

function bindInput(inp, obj, key) {
  inp.addEventListener('input', () => { obj[key] = inp.value; });
  inp.addEventListener('change', () => { obj[key] = inp.value; });
  return inp;
}
function makeSectionHeader(text) { return el('div', { class: 'section-header' }, text); }
function makeFormGroup(label, inp) { return el('div', { class: 'form-group' }, el('label', { class: 'form-label' }, label), inp); }
function makeInput(type, value = '', placeholder = '') { const i = el('input', { class: 'form-control', type, placeholder }); i.value = value ?? ''; return i; }
function makeSelect(opts, value) {
  return el('select', { class: 'form-control' }, ...opts.map(o => el('option', { value: o, selected: o === (value || '') }, o || 'Select...')));
}
function makeTextarea(value, placeholder = '', rows = 2) { const t = el('textarea', { class: 'form-control', rows, placeholder }); t.value = value || ''; return t; }

function buildAssessmentForm(opts) {
  const body = $('assess-body');
  body.innerHTML = '';
  const p = getPatient(A.pid);

  if (p?.history?.redFlags) body.appendChild(el('div', { class: 'flag-box', style: 'margin:0' }, '⚠️ ' + p.history.redFlags));

  const top = el('div', { class: 'form-row' });
  top.appendChild(makeFormGroup('Date', bindInput(makeInput('date', A.date), A, 'date')));
  if (A.type === 'initial') {
    top.appendChild(makeFormGroup('Onset', bindInput(makeSelect(['', 'Gradual', 'Sudden', 'Post-trauma', 'Post-surgical', 'Post-exercise', 'Unknown'], A.onset), A, 'onset')));
  } else {
    top.appendChild(makeFormGroup('Response to treatment', bindInput(makeSelect(['', 'Much better', 'Better', 'No change', 'Worse'], A.progress), A, 'progress')));
  }
  body.appendChild(top);
  if (A.type === 'initial') body.appendChild(makeFormGroup('Duration of complaint', bindInput(makeInput('text', A.duration, 'e.g. 3 months'), A, 'duration')));

  // Region tabs + panels
  const tabs = el('div', { class: 'region-tabs', id: 'region-tabs' });
  A.regions.forEach((r, i) => tabs.appendChild(el('button', { class: 'region-tab' + (i === A.active ? ' active' : ''), type: 'button', onclick: () => activateRegionTab(i) }, r.region)));
  tabs.appendChild(el('button', { class: 'region-tab-add', type: 'button', onclick: () => showRegionPicker(opts) }, '+ Add Region'));
  body.appendChild(tabs);
  const panels = el('div', { id: 'region-panels' });
  A.regions.forEach((r, i) => panels.appendChild(buildRegionPanel(r, i, opts)));
  if (!A.regions.length) panels.appendChild(el('p', { style: 'font-size:13px;color:var(--muted);padding:18px;text-align:center' }, 'Click "+ Add Region" to start'));
  body.appendChild(panels);

  // Outcome measures
  body.appendChild(makeSectionHeader('📏 Outcome Measures'));
  const omWrap = el('div');
  const dl = el('datalist', { id: 'om-list' }, ...(opts.measures || []).map(m => el('option', { value: m })));
  const drawOm = () => {
    omWrap.innerHTML = '';
    A.measures.forEach((m, i) => {
      omWrap.appendChild(el('div', { class: 'om-row' },
        bindInput(makeInput('text', m.name, 'Measure e.g. ODI %'), m, 'name'),
        bindInput(makeInput('text', m.score, 'Score'), m, 'score'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Remove', onclick: () => { A.measures.splice(i, 1); drawOm(); } }, '✕')));
      omWrap.lastChild.querySelector('input').setAttribute('list', 'om-list');
    });
    omWrap.appendChild(btn('+ Add measure', 'btn-ghost btn-sm', () => { A.measures.push({ name: '', score: '' }); drawOm(); }));
  };
  drawOm();
  body.appendChild(dl);
  body.appendChild(omWrap);

  if (A.type !== 'followup') {
    body.appendChild(makeSectionHeader('🎯 Goals'));
    const g = el('div', { class: 'form-row' });
    g.appendChild(makeFormGroup('Short-term goals', bindInput(makeTextarea(A.goalsShort, 'e.g. Reduce pain to 3/10 in 2 weeks'), A, 'goalsShort')));
    g.appendChild(makeFormGroup(A.type === 'discharge' ? 'Goals achieved / outcome' : 'Long-term goals', bindInput(makeTextarea(A.goalsLong, 'e.g. Return to work / sport'), A, 'goalsLong')));
    body.appendChild(g);
  }

  body.appendChild(makeSectionHeader(A.type === 'discharge' ? '📝 Discharge notes & home advice' : '📝 Notes'));
  body.appendChild(bindInput(makeTextarea(A.notes, 'Clinical notes...', 3), A, 'notes'));

  if (A.type === 'discharge') body.appendChild(el('div', { class: 'note-box' }, 'Saving will mark this patient as Discharged.'));
  if (A.regions.length) activateRegionTab(Math.min(A.active, A.regions.length - 1));
}

function activateRegionTab(idx) {
  A.active = idx;
  document.querySelectorAll('#region-tabs .region-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('#region-panels .region-panel').forEach((p, i) => p.classList.toggle('active', i === idx));
}

function buildRegionPanel(rd, idx, opts) {
  const panel = el('div', { class: 'region-panel' + (idx === A.active ? ' active' : '') });
  panel.appendChild(btn(`🗑️ Remove ${rd.region}`, 'btn-danger btn-sm', () => removeRegion(idx, opts), { style: 'margin-bottom:12px' }));
  const r = rd.region;
  [
    ['🩺 Diagnosis', 'diagnoses', opts.diagnoses?.[r] || []],
    ['💬 Chief Complaints', 'complaints', opts.complaints?.[r] || []],
    ['🔬 Assessment Findings', 'findings', opts.findings?.[r] || []],
    ['📌 Problem List', 'problems', opts.problems || []],
    ['💊 Treatment Plan', 'treatment', opts.treatment?.[r] || []],
  ].forEach(([title, key, all]) => {
    panel.appendChild(makeSectionHeader(title));
    panel.appendChild(buildPillSection(key, all, rd, key === 'problems' ? null : r));
  });

  panel.appendChild(makeSectionHeader('😣 Pain Level — VAS (0–10)'));
  panel.appendChild(buildVas(rd));

  panel.appendChild(makeSectionHeader('📐 Measurements (ROM / MMT / girth)'));
  panel.appendChild(bindInput(makeTextarea(rd.measurements, 'e.g. Knee flex 95° (N 135°), Quads 4/5, effusion +', 2), rd, 'measurements'));

  if (A.type !== 'discharge') {
    panel.appendChild(makeSectionHeader('📅 Session Plan'));
    const row = el('div', { class: 'form-row' });
    row.appendChild(makeFormGroup('Sessions planned', bindInput(makeInput('number', rd.sessionsPlanned, 'e.g. 12'), rd, 'sessionsPlanned')));
    row.appendChild(makeFormGroup('Frequency', bindInput(makeSelect(['', 'Daily', '3x/week', '2x/week', 'Weekly'], rd.freq), rd, 'freq')));
    panel.appendChild(row);
  }
  return panel;
}

function buildPillSection(key, allOpts, rd, region) {
  const wrap = el('div');
  const group = el('div', { class: 'pill-group' });
  rd[key] = rd[key] || [];
  // show saved selections even if the option was later removed from the list
  const list = [...allOpts, ...rd[key].filter(x => !allOpts.includes(x))];
  list.forEach(opt => group.appendChild(makePill(opt, rd, key)));
  wrap.appendChild(group);
  const inp = el('input', { type: 'text', placeholder: 'Add new option (saved to the list)...' });
  const add = async () => {
    const val = inp.value.trim();
    if (!val) { showToast('Type an option first', true); return; }
    if (!rd[key].includes(val)) { rd[key].push(val); group.appendChild(makePill(val, rd, key)); }
    inp.value = '';
    try {
      const fresh = await readOptions();
      if (region) {
        fresh[key][region] = fresh[key][region] || [];
        if (!fresh[key][region].includes(val)) fresh[key][region].push(val);
      } else if (!fresh.problems.includes(val)) fresh.problems.push(val);
      await writeOptions(fresh);
      showToast('Option added ✅');
    } catch (e) { showToast(errMsg(e), true); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  wrap.appendChild(el('div', { class: 'add-option-row' }, inp, el('button', { type: 'button', onclick: add }, '+ Add')));
  return wrap;
}

function makePill(opt, rd, key) {
  const b = el('button', { type: 'button', class: 'pill' + (rd[key].includes(opt) ? ' selected' : '') }, opt);
  b.addEventListener('click', () => {
    if (rd[key].includes(opt)) { rd[key] = rd[key].filter(x => x !== opt); b.classList.remove('selected'); }
    else { rd[key].push(opt); b.classList.add('selected'); }
  });
  return b;
}

function buildVas(rd) {
  const wrap = el('div', { class: 'vas-container' });
  for (let i = 0; i <= 10; i++) {
    const b = el('button', { type: 'button', class: 'vas-btn' + (rd.vas === i ? ' selected' : '') }, i);
    b.addEventListener('click', () => {
      rd.vas = rd.vas === i ? null : i;
      wrap.querySelectorAll('.vas-btn').forEach((x, j) => x.classList.toggle('selected', rd.vas === j));
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function showRegionPicker(opts) {
  const taken = A.regions.map(r => r.region);
  const available = (opts.regions || []).filter(r => !taken.includes(r));
  if (!available.length) { showToast('All regions already added', true); return; }
  const overlay = el('div', { class: 'modal-overlay dynamic open', style: 'z-index:300' });
  const box = el('div', { class: 'modal', style: 'max-width:460px;padding:22px' },
    el('div', { style: 'font-size:16px;font-weight:700;color:var(--primary-dark);margin-bottom:14px' }, 'Select Region'),
    el('div', { class: 'pill-group' }, ...available.map(r => el('button', { type: 'button', class: 'pill', onclick: () => {
      A.regions.push(emptyRegion(r));
      A.active = A.regions.length - 1;
      overlay.remove();
      buildAssessmentForm(opts);
    } }, r))),
    btn('Cancel', 'btn-ghost btn-sm', () => overlay.remove(), { style: 'margin-top:14px' }));
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function removeRegion(idx, opts) {
  confirmAction('Remove region', `Remove ${A.regions[idx].region} from this assessment?`, () => {
    A.regions.splice(idx, 1);
    A.active = Math.max(0, Math.min(A.active, A.regions.length - 1));
    buildAssessmentForm(opts);
  }, 'Remove');
}

$('save-assess').addEventListener('click', async () => {
  if (!A) return;
  const b = $('save-assess');
  const p = getPatient(A.pid);
  if (!p) return;
  const visit = {
    id: A.id || generateId(), type: A.type, date: A.date || todayStr(),
    duration: A.duration || '', onset: A.onset || '', progress: A.progress || '',
    notes: (A.notes || '').trim(), goalsShort: (A.goalsShort || '').trim(), goalsLong: (A.goalsLong || '').trim(),
    measures: (A.measures || []).filter(m => (m.name || '').trim()).map(m => ({ name: m.name.trim(), score: String(m.score || '').trim() })),
    regions: A.regions.map(r => ({ ...r, sessionsPlanned: r.sessionsPlanned || '', freq: r.freq || '', measurements: (r.measurements || '').trim() })),
    savedAt: Date.now(), savedBy: me.name || me.email
  };
  b.disabled = true;
  try {
    const visits = [...(p.visits || [])];
    const i = A.type === 'initial' ? visits.findIndex(v => v.type === 'initial') : visits.findIndex(v => v.id === visit.id);
    if (i >= 0) visits[i] = visit; else if (A.type === 'initial') visits.unshift(visit); else visits.push(visit);
    const upd = { visits, updatedAt: Date.now() };
    if (A.type === 'discharge') { upd.status = 'discharged'; upd.dischargeDate = visit.date; }
    await updateDoc(doc(DB, 'patients', A.pid), upd);
    closeModal('modal-assess');
    showToast(`${VISIT_LABEL[A.type]} saved ✅`);
    showPage('profile', { id: A.pid, tab: 'visits' });
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; }
});

// ═══════════════════════════════════════════
// SHORTCUT SHEET (quick-sheet.js) — one-page sheet with voice typing
// ═══════════════════════════════════════════
const QS = setupQuickSheet({
  el, btn, showToast, errMsg, getPatient, todayStr, generateId, fmtDate, regionsOf,
  saveVisit: async (pid, visit, patientUpdates) => {
    const p = getPatient(pid);
    const visits = [...(p?.visits || [])];
    visit.savedBy = me.name || me.email;
    const i = visits.findIndex(v => v.id === visit.id);
    if (i >= 0) visits[i] = visit; else if (visit.type === 'initial') visits.unshift(visit); else visits.push(visit);
    await updateDoc(doc(DB, 'patients', pid), { ...patientUpdates, visits, updatedAt: Date.now() });
  },
  afterSave: pid => showPage('profile', { id: pid, tab: 'visits' })
});
function openShortcut(pid, visitId) {
  if (!isDoctor()) { showToast('Only doctors can edit assessments', true); return; }
  QS.open(pid, visitId);
}

// ═══════════════════════════════════════════
// PATIENT PROFILE
// ═══════════════════════════════════════════
const PROFILE_TABS = [['overview', '📋 Overview'], ['visits', '🩺 Assessments'], ['billing', '💰 Sessions & Payments'], ['hep', '🏋️ Home Exercises'], ['appts', '📅 Appointments']];

function sortedVisits(p) {
  const order = { initial: 0, followup: 1, discharge: 2 };
  return [...(p.visits || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (order[a.type] - order[b.type]));
}

function renderProfile() {
  const page = $('page-profile');
  const p = getPatient(profileId);
  if (!p) {
    page.innerHTML = patients.length ? '<div class="empty-state"><span class="icon">🔍</span><h3>Patient not found</h3></div>'
      : '<div class="loading"><div class="spinner"></div></div>';
    return;
  }
  page.innerHTML = '';
  const st = patientStatus(p);
  const ini = initialVisit(p);
  const acc = account(p);

  page.appendChild(btn('← Patients', 'btn-ghost btn-sm', () => showPage('patients'), { style: 'margin-bottom:12px' }));

  const header = el('div', { class: 'profile-header' });
  header.appendChild(el('div', { html: `
    <div class="profile-name">${esc(p.name)} ${p.fileNo ? `<span style="font-size:13px;opacity:.7">#${esc(p.fileNo)}</span>` : ''}</div>
    <div style="opacity:0.8;font-size:13px">${esc(p.age)} y/o — ${esc(p.gender || '')}${p.job ? ' · ' + esc(p.job) : ''}${p.phone ? ' · 📞 ' + esc(p.phone) : ''}</div>
    <div class="profile-tags">
      <span class="profile-tag">${{ active: '🟢 Active', discharged: '🔵 Discharged', onhold: '⏸ On hold' }[st]}</span>
      ${regionsOf(p).map(r => `<span class="profile-tag gold">${esc(r)}</span>`).join('')}
      ${attendedCount(p) ? `<span class="profile-tag">💪 ${attendedCount(p)}${plannedSessions(p) ? '/' + plannedSessions(p) : ''} sessions</span>` : ''}
      ${acc.balance > 0 ? `<span class="profile-tag" style="background:var(--red);color:white">Due ${money(acc.balance)}</span>` : ''}
      ${acc.balance < 0 ? `<span class="profile-tag" style="background:#2980b9;color:white">Credit ${money(-acc.balance)}</span>` : ''}
    </div>` }));
  const actions = el('div', { style: 'display:flex;gap:7px;flex-wrap:wrap;align-items:flex-start' });
  actions.appendChild(btn('✏️ Edit info', 'btn-ghost btn-sm', () => openPatientModal(p.id), { style: 'background:white' }));
  actions.appendChild(btn('📅 Book', 'btn-accent btn-sm', () => openNewAppt({ patientId: p.id })));
  if (p.phone) actions.appendChild(btn('💬 WhatsApp', 'btn-green btn-sm', () => openWa(p.phone, '')));
  if (isDoctor()) {
    actions.appendChild(btn('⚡ Shortcut', 'btn-accent btn-sm', () => openShortcut(p.id)));
    if (ini) actions.appendChild(btn('+ Follow-up', 'btn-primary btn-sm', () => openAssessment(p.id, 'followup'), { style: 'background:white;color:var(--primary)' }));
    if (ini && st !== 'discharged') actions.appendChild(btn('🏁 Discharge', 'btn-ghost btn-sm', () => openAssessment(p.id, 'discharge'), { style: 'background:white' }));
    actions.appendChild(btn('📄 Report PDF', 'btn-pdf btn-sm', () => exportPDF(p.id)));
  }
  header.appendChild(actions);
  page.appendChild(header);

  if (p.history?.redFlags) page.appendChild(el('div', { class: 'flag-box' }, '⚠️ Red flags / precautions: ' + p.history.redFlags));
  if (p.history?.allergies) page.appendChild(el('div', { class: 'flag-box', style: 'background:#fff8e6;color:#b07a00;border-color:var(--accent)' }, '🤧 Allergies: ' + p.history.allergies));

  const tabs = el('div', { class: 'ptabs' });
  PROFILE_TABS.forEach(([k, l]) => tabs.appendChild(el('button', { class: 'ptab' + (profileTab === k ? ' active' : ''), onclick: () => {
    if (profileTab === 'hep' && hepDirty && k !== 'hep') { if (!confirm('You have unsaved exercise changes. Leave without saving?')) return; hepDirty = false; }
    profileTab = k; renderProfile();
  } }, l)));
  page.appendChild(tabs);

  const content = el('div');
  page.appendChild(content);
  ({ overview: profileOverview, visits: profileVisits, billing: profileBilling, hep: profileHep, appts: profileAppts })[profileTab](p, content);
}

function infoItem(k, v) { return v ? el('div', { class: 'info-item' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)) : null; }

function profileOverview(p, c) {
  const hx = p.history || {};
  const ini = initialVisit(p);
  const info = el('div', { class: 'card', style: 'margin-bottom:14px' }, el('div', { class: 'card-title' }, '👤 Patient information'));
  const grid = el('div', { class: 'info-grid' },
    infoItem('Phone', p.phone), infoItem('Address', p.address), infoItem('Emergency contact', p.emergency),
    infoItem('Referral', [p.referral, p.refDoctor].filter(Boolean).join(' — ')),
    infoItem('Registered', p.createdAt ? fmtDate(dateStr(new Date(p.createdAt))) : ''),
    infoItem('Discharged', p.dischargeDate ? fmtDate(p.dischargeDate) : ''));
  info.appendChild(grid);
  c.appendChild(info);

  const hist = el('div', { class: 'card', style: 'margin-bottom:14px' }, el('div', { class: 'card-title' }, '🩺 Medical history', btn('Edit', 'btn-ghost btn-sm', () => openPatientModal(p.id))));
  const hg = el('div', { class: 'info-grid' }, infoItem('Chronic diseases', hx.chronic), infoItem('Medications', hx.meds),
    infoItem('Surgeries', hx.surgeries), infoItem('Allergies', hx.allergies), infoItem('Investigations', hx.imaging), infoItem('Notes', hx.notes));
  if (!hg.children.length) hg.appendChild(el('div', { class: 'muted', style: 'font-size:13px' }, 'No history recorded yet.'));
  hist.appendChild(hg);
  c.appendChild(hist);

  // Progress
  const planned = plannedSessions(p), done = attendedCount(p);
  const prog = el('div', { class: 'card', style: 'margin-bottom:14px' }, el('div', { class: 'card-title' }, '📈 Treatment progress'));
  if (!ini) {
    prog.appendChild(el('div', { class: 'muted', style: 'font-size:13px' }, 'No initial assessment yet.'));
    if (isDoctor()) prog.appendChild(btn('Start assessment', 'btn-primary btn-sm', () => openAssessment(p.id, 'initial'), { style: 'margin-top:10px' }));
  } else {
    const dx = [...new Set((ini.regions || []).flatMap(r => r.diagnoses || []))];
    prog.appendChild(el('div', { class: 'info-grid', style: 'margin-bottom:12px' },
      infoItem('Diagnosis', dx.join(', ') || '—'),
      infoItem('Sessions', `${done}${planned ? ' of ' + planned : ''} attended`),
      infoItem('Last visit', fmtDate(lastActivity(p)))));
    if (planned) prog.appendChild(el('div', { class: 'progress', style: 'height:9px;margin-bottom:14px' }, el('div', { style: `width:${Math.min(100, done / planned * 100)}%` })));
    const chart = vasChart(p);
    if (chart) { prog.appendChild(el('div', { class: 'form-label', style: 'margin-bottom:6px' }, 'Pain (VAS) over time')); prog.appendChild(chart); }
    const om = measuresTable(p);
    if (om) { prog.appendChild(el('div', { class: 'form-label', style: 'margin:14px 0 6px' }, 'Outcome measures')); prog.appendChild(om); }
  }
  c.appendChild(prog);
}

const CHART_COLORS = ['#1f6f78', '#e8a020', '#d94f4f', '#2980b9', '#8e44ad', '#16a085'];
function vasChart(p) {
  const visits = sortedVisits(p);
  const regions = [...new Set(visits.flatMap(v => (v.regions || []).filter(r => r.vas != null).map(r => r.region)))];
  const points = visits.filter(v => (v.regions || []).some(r => r.vas != null));
  if (points.length < 1 || !regions.length) return null;
  const W = 600, H = 170, L = 30, R = 30, T = 14, B = 28;
  const x = i => points.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (points.length - 1);
  const y = v => T + (10 - v) * (H - T - B) / 10;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="VAS chart" style="display:block">`;
  [0, 5, 10].forEach(v => svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#cddfe1" stroke-dasharray="3 3"/><text x="${L - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="#56717a">${v}</text>`);
  points.forEach((v, i) => svg += `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#56717a">${esc(fmtDate(v.date, { day: 'numeric', month: 'short' }))}</text>`);
  regions.forEach((rg, ri) => {
    const col = CHART_COLORS[ri % CHART_COLORS.length];
    const pts = points.map((v, i) => { const r = (v.regions || []).find(z => z.region === rg && z.vas != null); return r ? [x(i), y(r.vas), r.vas] : null; }).filter(Boolean);
    if (pts.length > 1) svg += `<polyline fill="none" stroke="${col}" stroke-width="2.5" points="${pts.map(q => q[0] + ',' + q[1]).join(' ')}"/>`;
    pts.forEach(q => svg += `<circle cx="${q[0]}" cy="${q[1]}" r="4" fill="${col}"/><text x="${q[0]}" y="${q[1] - 8}" font-size="10" text-anchor="middle" fill="${col}" font-weight="700">${q[2]}</text>`);
  });
  svg += '</svg>';
  const box = el('div', { class: 'chart-box', html: svg });
  box.appendChild(el('div', { class: 'chart-legend' }, ...regions.map((r, i) => el('span', { style: `--c:${CHART_COLORS[i % CHART_COLORS.length]}` }, r))));
  return box;
}

function measuresTable(p) {
  const visits = sortedVisits(p).filter(v => (v.measures || []).length);
  const names = [...new Set(visits.flatMap(v => v.measures.map(m => m.name)))];
  if (!names.length) return null;
  const t = el('table', { class: 'data-table' });
  t.innerHTML = `<thead><tr><th>Measure</th>${visits.map(v => `<th>${esc(fmtDate(v.date, { day: 'numeric', month: 'short' }))}</th>`).join('')}</tr></thead>
    <tbody>${names.map(n => `<tr><td>${esc(n)}</td>${visits.map(v => `<td>${esc(v.measures.find(m => m.name === n)?.score || '—')}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return el('div', { class: 'table-wrap' }, t);
}

function profileVisits(p, c) {
  const visits = sortedVisits(p).reverse(); // newest first
  if (!visits.length) {
    const empty = el('div', { class: 'card', style: 'text-align:center;padding:40px;color:var(--muted)', html: '<div style="font-size:40px;margin-bottom:10px">📋</div><p style="font-weight:600">No assessment yet</p>' });
    if (isDoctor()) empty.appendChild(el('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px' },
      btn('Start Initial Assessment', 'btn-primary', () => openAssessment(p.id, 'initial')),
      btn('⚡ Shortcut sheet', 'btn-accent', () => openShortcut(p.id))));
    c.appendChild(empty);
    return;
  }
  if (isDoctor()) {
    const bar = el('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap' },
      btn('⚡ Shortcut', 'btn-accent btn-sm', () => openShortcut(p.id)),
      btn('+ Follow-up', 'btn-primary btn-sm', () => openAssessment(p.id, 'followup')),
      btn('📄 PDF', 'btn-pdf btn-sm', () => exportPDF(p.id)),
      btn('📊 CSV', 'btn-green btn-sm', () => exportCSV(p.id)));
    c.appendChild(bar);
  }
  visits.forEach(v => c.appendChild(visitCard(p, v)));
}

function visitCard(p, v) {
  const isInit = v.type === 'initial';
  const card = el('div', { class: 'visit-card' + (isInit ? '' : ' followup'), style: v.type === 'discharge' ? 'border-top-color:#2980b9' : '' });
  if (isDoctor()) {
    if (!isInit) card.appendChild(el('button', { class: 'visit-delete-btn', title: 'Delete', onclick: () => confirmAction(`Delete ${VISIT_LABEL[v.type]}`, 'Delete this visit? Cannot be undone.', async () => {
      const fresh = getPatient(p.id);
      await updateDoc(doc(DB, 'patients', p.id), { visits: (fresh.visits || []).filter(x => x.id !== v.id) });
      showToast('Deleted');
    }) }, '🗑️'));
    card.appendChild(el('button', { class: 'visit-edit-btn', onclick: () => v.quick ? openShortcut(p.id, v.id) : openAssessment(p.id, v.type, v.id) }, '✏️ Edit'));
  }
  const head = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding-right:90px' });
  head.appendChild(el('span', { class: 'visit-type-badge ' + (isInit ? 'initial' : 'followup'), style: v.type === 'discharge' ? 'background:#ebf5fb;color:#2980b9' : '' },
    { initial: '📋 Initial Assessment', followup: '🔄 Follow-up', discharge: '🏁 Discharge' }[v.type] || v.type));
  head.appendChild(el('span', { style: 'font-size:12px;font-weight:600;color:var(--muted)' }, '📅 ' + fmtDate(v.date)));
  if (v.duration || v.onset) head.appendChild(el('span', { style: 'font-size:12px;color:var(--muted)' }, `⏱ ${[v.duration, v.onset].filter(Boolean).join(' — ')}`));
  if (v.progress) head.appendChild(el('span', { class: 'badge ' + (/better/i.test(v.progress) ? 'b-active' : /worse/i.test(v.progress) ? 'b-debt' : 'b-onhold') }, v.progress));
  if (v.savedBy) head.appendChild(el('span', { style: 'font-size:11px;color:var(--muted)' }, 'by ' + v.savedBy));
  card.appendChild(head);
  if (v.quick) card.appendChild(QS.extras(v));

  (v.regions || []).forEach(r => {
    const rc = el('div', { class: 'region-card' });
    const title = el('div', { class: 'region-card-title' }, '📍 ' + r.region);
    if (r.sessionsPlanned) title.appendChild(el('span', { style: 'font-size:11px;color:var(--muted);font-weight:400;margin-left:8px' }, `💪 ${r.sessionsPlanned} sessions${r.freq ? ' · ' + r.freq : ''}`));
    rc.appendChild(title);
    const tags = (t, arr, cls = '') => {
      if (!arr?.length) return;
      rc.appendChild(el('div', { class: 'data-section' }, el('div', { class: 'data-section-title' }, t),
        el('div', { class: 'data-tags' }, ...arr.map(x => el('span', { class: 'data-tag ' + cls }, x)))));
    };
    tags('🩺 Diagnosis', r.diagnoses, 'diagnosis');
    tags('💬 Complaints', r.complaints);
    if (r.vas != null) {
      const col = r.vas <= 3 ? '#27ae60' : r.vas <= 6 ? '#e8a020' : '#d94f4f';
      rc.appendChild(el('div', { class: 'data-section', html: `<div class="data-section-title">😣 VAS</div>
        <div style="display:inline-flex;align-items:center;gap:8px;background:white;padding:6px 14px;border-radius:22px">
          <span style="font-size:22px;font-weight:700;color:${col}">${r.vas}</span><span style="color:var(--muted);font-size:12px">/10</span>
          <div style="height:5px;width:90px;background:#ddd;border-radius:5px;overflow:hidden"><div style="height:100%;width:${r.vas * 10}%;background:${col}"></div></div>
        </div>` }));
    }
    tags('🔬 Findings', r.findings);
    if (r.measurements) rc.appendChild(el('div', { class: 'data-section' }, el('div', { class: 'data-section-title' }, '📐 Measurements'), el('div', { style: 'font-size:13px;white-space:pre-wrap' }, r.measurements)));
    tags('📌 Problem List', r.problems, 'problem');
    tags('💊 Treatment', r.treatment);
    card.appendChild(rc);
  });

  if ((v.measures || []).length) card.appendChild(el('div', { class: 'data-section' }, el('div', { class: 'data-section-title' }, '📏 Outcome measures'),
    el('div', { class: 'data-tags' }, ...v.measures.map(m => el('span', { class: 'data-tag' }, `${m.name}: ${m.score || '—'}`)))));
  if (v.goalsShort || v.goalsLong) card.appendChild(el('div', { class: 'data-section' }, el('div', { class: 'data-section-title' }, '🎯 Goals'),
    el('div', { style: 'font-size:13px;white-space:pre-wrap' }, [v.goalsShort && 'Short-term: ' + v.goalsShort, v.goalsLong && (v.type === 'discharge' ? 'Outcome: ' : 'Long-term: ') + v.goalsLong].filter(Boolean).join('\n'))));
  if (v.notes) card.appendChild(el('div', { style: 'font-size:13px;background:var(--bg);padding:10px;border-radius:var(--radius-sm);margin-top:8px;white-space:pre-wrap' }, v.notes));
  return card;
}

// ═══════════════════════════════════════════
// SESSIONS & PAYMENTS (inside the patient file)
// ═══════════════════════════════════════════
const typeLabel = t => ({ initial: 'Initial Assessment', followup: 'Follow-up', session: 'Session' }[t] || 'Session');

function profileBilling(p, c) {
  const acc = account(p);
  const sessions = [...(p.sessions || [])].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  const payments = [...(p.payments || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  c.appendChild(el('div', { class: 'stats-grid', html: `
    <div class="stat-card"><div class="stat-num">${sessions.length}</div><div class="stat-lbl">Sessions attended</div></div>
    <div class="stat-card blue"><div class="stat-num">${money(acc.charges + acc.legacy)}</div><div class="stat-lbl">Total charges</div></div>
    <div class="stat-card green"><div class="stat-num">${money(acc.paid + acc.legacy)}</div><div class="stat-lbl">Total paid</div></div>
    <div class="stat-card ${acc.balance > 0 ? 'red' : 'green'}"><div class="stat-num">${money(Math.abs(acc.balance))}</div><div class="stat-lbl">${acc.balance > 0 ? 'Balance due' : acc.balance < 0 ? 'Credit (prepaid)' : 'Balance'}</div></div>` }));

  c.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px' },
    btn('💵 Record payment', 'btn-primary', () => openPaymentModal(p.id)),
    btn('+ Add session', 'btn-ghost', () => addSessionManually(p.id)),
    btn('🧾 Statement PDF', 'btn-ghost', () => statementPDF(p))));

  // Sessions table
  const sc = el('div', { class: 'card', style: 'margin-bottom:14px' }, el('div', { class: 'card-title' }, '💪 Sessions'));
  if (!sessions.length) sc.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:12px' }, 'No sessions yet. Mark an appointment as Attended, or add a session here.'));
  else {
    const t = el('table', { class: 'data-table' });
    t.innerHTML = '<thead><tr><th>#</th><th>Date</th><th>Time</th><th>Type</th><th>Doctor</th><th class="num">Price</th><th></th></tr></thead>';
    const tb = el('tbody');
    sessions.forEach((s, i) => {
      const tr = el('tr', { html: `<td>${sessions.length - i}</td><td>${esc(fmtDate(s.date))}</td><td>${esc(fmtTime(s.time))}</td><td>${esc(typeLabel(s.type))}</td>
        <td>${esc(s.doctorName || '—')}</td><td class="num">${money(s.price)}${s.billed ? '' : ' <span class="muted" title="Recorded before payments tracking — counted as paid">✓</span>'}</td>` });
      const td = el('td', { style: 'text-align:right' });
      if (isDoctor()) td.appendChild(el('button', { class: 'icon-btn', style: 'width:30px;height:28px', title: 'Remove session', onclick: () => removeSession(p.id, s) }, '✕'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    sc.appendChild(el('div', { class: 'table-wrap' }, t));
  }
  c.appendChild(sc);

  // Payments table
  const pc = el('div', { class: 'card' }, el('div', { class: 'card-title' }, '💵 Payments'));
  if (!payments.length) pc.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:12px' }, 'No payments recorded yet.'));
  else {
    const t = el('table', { class: 'data-table' });
    t.innerHTML = '<thead><tr><th>Date</th><th class="num">Amount</th><th>Method</th><th>Note</th><th>By</th><th></th></tr></thead>';
    const tb = el('tbody');
    payments.forEach(x => {
      const tr = el('tr', { html: `<td>${esc(fmtDate(x.date))}</td><td class="num"><strong>${money(x.amount)}</strong></td><td>${esc(x.method || '')}</td><td>${esc(x.note || '')}</td><td class="muted">${esc(x.by || '')}</td>` });
      const td = el('td', { style: 'text-align:right;white-space:nowrap' });
      td.appendChild(el('button', { class: 'btn btn-ghost btn-sm', title: 'Receipt PDF', onclick: () => receiptPDF(p, x) }, '🧾'));
      if (isDoctor()) td.appendChild(el('button', { class: 'icon-btn', style: 'width:30px;height:28px;margin-left:4px', title: 'Delete payment', onclick: () => removePayment(p.id, x) }, '✕'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    pc.appendChild(el('div', { class: 'table-wrap' }, t));
  }
  c.appendChild(pc);
}

let payPid = null, payAfter = null;
function openPaymentModal(pid, prefill = {}, after = null) {
  const p = getPatient(pid);
  if (!p) return;
  payPid = pid;
  payAfter = after;
  const bal = account(p).balance;
  $('payment-modal-title').textContent = `Record Payment — ${p.name}`;
  $('payment-balance-note').innerHTML = bal > 0 ? `Current balance due: <strong>${money(bal)}</strong>` :
    bal < 0 ? `Patient has a credit of <strong>${money(-bal)}</strong>` : 'No balance due.';
  $('pay-amount').value = prefill.amount ?? (bal > 0 ? bal : '');
  $('pay-date').value = prefill.date || todayStr();
  $('pay-method').value = prefill.method || 'Cash';
  $('pay-note').value = prefill.note || '';
  openModal('modal-payment');
  setTimeout(() => $('pay-amount').focus(), 100);
}
$('save-payment').addEventListener('click', async () => {
  const amount = num($('pay-amount').value);
  if (amount <= 0) { showToast('Enter an amount', true); return; }
  const pay = { id: generateId(), date: $('pay-date').value || todayStr(), amount, method: $('pay-method').value,
    note: $('pay-note').value.trim(), by: me.name || me.email, at: Date.now() };
  const b = $('save-payment');
  b.disabled = true;
  try {
    await updateDoc(doc(DB, 'patients', payPid), { payments: arrayUnion(pay), updatedAt: Date.now() });
    closeModal('modal-payment');
    showToast(`Payment of ${Math.round(amount)} saved ✅`);
    const p = getPatient(payPid);
    if (payAfter) payAfter();
    else if (p) dialog({ icon: '🧾', title: 'Payment saved', message: 'Download a receipt for the patient?', buttons: [{ text: 'No' }, { text: '🧾 Receipt PDF', cls: 'btn-primary', onClick: () => receiptPDF({ ...p }, pay) }] });
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; }
});

function removePayment(pid, pay) {
  confirmAction('Delete payment', `Delete payment of ${Math.round(num(pay.amount))} on ${fmtDate(pay.date)}?`, async () => {
    const snap = await getDoc(doc(DB, 'patients', pid));
    const list = (snap.data().payments || []).filter(x => x.id !== pay.id);
    await updateDoc(doc(DB, 'patients', pid), { payments: list, updatedAt: Date.now() });
    showToast('Payment deleted');
  });
}

function removeSession(pid, s) {
  confirmAction('Remove session', `Remove the session on ${fmtDate(s.date)}?${s.apptId ? '\nIts appointment will go back to "Scheduled".' : ''}`, async () => {
    const snap = await getDoc(doc(DB, 'patients', pid));
    const key = x => x.id ? x.id === s.id : (x.apptId ? x.apptId === s.apptId : (x.date === s.date && x.time === s.time));
    const list = (snap.data().sessions || []).filter(x => !key(x));
    await updateDoc(doc(DB, 'patients', pid), { sessions: list, updatedAt: Date.now() });
    if (s.apptId) { try { await updateDoc(doc(DB, 'appointments', s.apptId), { status: 'scheduled' }); } catch {} }
    showToast('Session removed');
  }, 'Remove');
}

function sessionPrice(type) {
  return type === 'initial' ? (num(clinic.initialPrice) || num(clinic.sessionPrice)) : num(clinic.sessionPrice);
}

function addSessionManually(pid) {
  const docs = clinic.scheduleDoctors || [];
  formDialog({
    title: 'Add session',
    fields: [
      { id: 'date', label: 'Date', type: 'date', value: todayStr() },
      { id: 'time', label: 'Time', type: 'time', value: '' },
      { id: 'type', label: 'Type', type: 'select', value: 'session', options: [['session', 'Session'], ['followup', 'Follow-up'], ['initial', 'Initial Assessment']] },
      { id: 'doctorId', label: 'Doctor', type: 'select', value: docs[0]?.id || '', options: [['', '—'], ...docs.map(d => [d.id, d.name])] },
      { id: 'price', label: 'Price', type: 'number', value: sessionPrice('session') },
      { id: 'paid', label: 'Paid now?', type: 'select', value: 'yes', options: [['yes', 'Yes — record a cash payment'], ['no', 'No — add to balance']] },
    ],
    onSave: async v => {
      if (!v.date) { showToast('Pick a date', true); return false; }
      const dr = docs.find(d => d.id === v.doctorId);
      const s = { id: generateId(), date: v.date, time: v.time, type: v.type, price: num(v.price), billed: true, doctorId: v.doctorId, doctorName: dr?.name || '', at: Date.now() };
      const upd = { sessions: arrayUnion(s), updatedAt: Date.now() };
      await updateDoc(doc(DB, 'patients', pid), upd);
      if (v.paid === 'yes' && s.price > 0) {
        await updateDoc(doc(DB, 'patients', pid), { payments: arrayUnion({ id: generateId(), date: v.date, amount: s.price, method: 'Cash', note: `${typeLabel(v.type)} ${v.date}`, by: me.name || me.email, at: Date.now() }) });
      }
      showToast('Session added ✅');
    }
  });
}

// ═══════════════════════════════════════════
// HOME EXERCISE PROGRAM
// ═══════════════════════════════════════════
let hepDraft = null;
function profileHep(p, c) {
  if (!hepDirty || !hepDraft || hepDraft.pid !== p.id) {
    hepDraft = { pid: p.id, items: JSON.parse(JSON.stringify(p.hep?.items || [])), advice: p.hep?.advice || '' };
    hepDirty = false;
  }
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-title' }, '🏋️ Home exercise program',
    p.hep?.updatedAt ? el('span', { class: 'muted', style: 'font-size:12px;font-weight:400' }, 'Last updated ' + fmtDate(dateStr(new Date(p.hep.updatedAt)))) : null));
  const dl = el('datalist', { id: 'ex-list' }, ...((options?.exercises) || getDefaultOptions().exercises).map(x => el('option', { value: x })));
  card.appendChild(dl);
  if (!options) readOptions().then(o => { dl.innerHTML = ''; (o.exercises || []).forEach(x => dl.appendChild(el('option', { value: x }))); }).catch(() => {});

  const head = el('div', { class: 'hep-row', style: 'font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase' },
    el('span', {}, 'Exercise'), el('span', {}, 'Sets'), el('span', {}, 'Reps'), el('span', {}, 'Hold (s)'), el('span', {}, 'Notes / times per day'), el('span'));
  const rows = el('div');
  const mark = () => { hepDirty = true; save.disabled = false; };
  const draw = () => {
    rows.innerHTML = '';
    if (!hepDraft.items.length) rows.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:10px 0' }, 'No exercises yet — add the first one below.'));
    hepDraft.items.forEach((it, i) => {
      const f = (key, ph, cls = '') => {
        const inp = el('input', { class: 'form-control ' + cls, placeholder: ph });
        inp.value = it[key] || '';
        inp.addEventListener('input', () => { it[key] = inp.value; mark(); });
        return inp;
      };
      const name = f('name', 'e.g. Straight leg raise');
      name.setAttribute('list', 'ex-list');
      rows.appendChild(el('div', { class: 'hep-row' }, name, f('sets', '3'), f('reps', '10'), f('hold', '5'), f('notes', '2x/day', 'hep-notes'),
        el('button', { class: 'icon-btn', title: 'Remove', onclick: () => { hepDraft.items.splice(i, 1); mark(); draw(); } }, '✕')));
    });
  };
  draw();
  if (window.innerWidth > 768) card.appendChild(head);
  card.appendChild(rows);
  card.appendChild(btn('+ Add exercise', 'btn-ghost btn-sm', () => { hepDraft.items.push({ name: '', sets: '3', reps: '10', hold: '', notes: '' }); mark(); draw(); rows.querySelector('.hep-row:last-child input')?.focus(); }, { style: 'margin:6px 0 14px' }));
  const adv = makeTextarea(hepDraft.advice, 'General advice: ice 15 min after exercise, avoid prolonged sitting...', 3);
  adv.addEventListener('input', () => { hepDraft.advice = adv.value; mark(); });
  card.appendChild(makeFormGroup('Advice', adv));

  const save = btn('💾 Save program', 'btn-primary', async () => {
    const items = hepDraft.items.filter(x => (x.name || '').trim()).map(x => ({ name: x.name.trim(), sets: x.sets || '', reps: x.reps || '', hold: x.hold || '', notes: x.notes || '' }));
    save.disabled = true;
    try {
      await updateDoc(doc(DB, 'patients', p.id), { hep: { items, advice: hepDraft.advice.trim(), updatedAt: Date.now(), by: me.name || me.email } });
      hepDirty = false;
      showToast('Exercise program saved ✅');
    } catch (e) { save.disabled = false; showToast(errMsg(e), true); }
  });
  save.disabled = !hepDirty;
  const share = () => {
    const items = hepDraft.items.filter(x => (x.name || '').trim());
    if (!items.length) { showToast('Add exercises first', true); return null; }
    return items;
  };
  card.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px' }, save,
    btn('📄 PDF', 'btn-pdf', () => { const it = share(); if (it) hepPDF(p, it, hepDraft.advice); }),
    p.phone ? btn('💬 Send on WhatsApp', 'btn-green', () => {
      const it = share(); if (!it) return;
      const lines = it.map((x, i) => `${i + 1}. ${x.name}${x.sets || x.reps ? ` — ${x.sets || '?'} × ${x.reps || '?'}` : ''}${x.hold ? `، ثبات ${x.hold} ث` : ''}${x.notes ? ` (${x.notes})` : ''}`);
      openWa(p.phone, `أهلاً ${p.name} 👋\nده برنامج التمارين المنزلية بتاعك من ${clinic.clinicName}:\n\n${lines.join('\n')}${hepDraft.advice ? `\n\n📝 ${hepDraft.advice}` : ''}\n\nلو حسيت بأي ألم زيادة كلمنا 🙏`);
    }) : null));
  c.appendChild(card);
}

// ═══════════════════════════════════════════
// APPOINTMENTS TAB
// ═══════════════════════════════════════════
async function profileAppts(p, c) {
  c.appendChild(el('div', { style: 'margin-bottom:12px' }, btn('📅 Book appointment', 'btn-primary', () => openNewAppt({ patientId: p.id }))));
  const box = el('div', { class: 'card', html: '<div class="loading"><div class="spinner"></div></div>' });
  c.appendChild(box);
  try {
    const snap = await getDocs(query(collection(DB, 'appointments'), where('patientId', '==', p.id)));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const today = todayStr();
    const upcoming = list.filter(a => a.date >= today && a.status !== 'cancelled' && a.status !== 'attended').reverse();
    const past = list.filter(a => !upcoming.includes(a));
    box.innerHTML = '';
    const section = (title, arr) => {
      box.appendChild(el('div', { class: 'card-title', style: 'margin-top:6px' }, title));
      if (!arr.length) box.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:6px 0 12px' }, 'None'));
      arr.forEach(a => box.appendChild(el('div', { class: 'list-row clickable', onclick: () => showApptActions(a) },
        el('div', { style: 'min-width:110px;font-weight:700;color:var(--primary-dark)' }, fmtDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })),
        el('div', { class: 'grow' }, el('div', { class: 'title' }, fmtTime(a.time) + ' · ' + typeLabel(a.type)), el('div', { class: 'sub' }, [a.doctorName, a.notes].filter(Boolean).join(' · '))),
        el('span', { html: statusPill(a.status) }))));
    };
    section(`Upcoming (${upcoming.length})`, upcoming);
    section(`History (${past.length})`, past);
    const noshow = list.filter(a => a.status === 'noshow').length, cancelled = list.filter(a => a.status === 'cancelled').length;
    if (noshow || cancelled) box.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, `No-shows: ${noshow} · Cancelled: ${cancelled}`));
  } catch (e) { box.innerHTML = `<div class="flag-box">${esc(errMsg(e))}</div>`; }
}

// ═══════════════════════════════════════════
// PDF HELPERS
// ═══════════════════════════════════════════
function pdfHeader(title) {
  const s = clinic;
  return `<div style="display:flex;align-items:flex-start;justify-content:space-between;border-bottom:3px solid #0f2846;padding-bottom:14px;margin-bottom:16px;gap:12px">
    <div style="display:flex;align-items:center;gap:12px">
      ${s.logoUrl ? `<img src="${esc(s.logoUrl)}" crossorigin="anonymous" style="height:55px;object-fit:contain">` : ''}
      <div>
        <div style="font-size:18px;font-weight:700;color:#0f2846">${esc(s.clinicName || 'Physiclinic')}</div>
        ${s.doctorName ? `<div style="font-size:12px;font-weight:600;color:#1f6f78">${esc(s.doctorName)}</div>` : ''}
        ${s.address ? `<div style="font-size:11px;color:#56717a">${esc(s.address)}</div>` : ''}
        ${s.phone ? `<div style="font-size:11px;color:#56717a">📞 ${esc(s.phone)}</div>` : ''}
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;font-weight:700;color:#0f2846">${esc(title)}</div>
      <div style="font-size:11px;color:#56717a;margin-top:3px">Date: ${esc(fmtDate(todayStr()))}</div>
    </div>
  </div>`;
}
function pdfPatientBox(p) {
  return `<div style="background:#f0f7f4;border-radius:8px;padding:10px 14px;margin-bottom:14px">
    <div style="font-size:15px;font-weight:700;color:#0f2846">${esc(p.name)} ${p.fileNo ? `<span style="font-size:11px;color:#56717a">· File #${esc(p.fileNo)}</span>` : ''}</div>
    <div style="font-size:12px;color:#56717a;margin-top:2px">${esc(p.age)} y/o ${esc(p.gender || '')} ${p.job ? '· ' + esc(p.job) : ''} ${p.phone ? '· 📞 ' + esc(p.phone) : ''}</div>
  </div>`;
}
function pdfFooter() {
  const s = clinic;
  return `<div style="margin-top:20px;padding-top:10px;border-top:1px solid #d0e4de;font-size:10px;color:#56717a;text-align:center">${esc([s.clinicName || 'Physiclinic', s.address, s.phone].filter(Boolean).join(' · '))}</div>`;
}
const TH = 'background:#0f2846;color:white;padding:7px 9px;text-align:left;font-size:11px';
const TD = i => `padding:6px 9px;border-bottom:1px solid #cddfe1;font-size:11px;background:${i % 2 ? '#f4f8f6' : 'white'}`;

async function renderPdf(innerHtml, filename) {
  if (!window.html2canvas || !window.jspdf) { showToast('PDF tools did not load — check the internet connection', true); return; }
  showToast('Generating PDF...');
  const div = el('div', { style: 'position:fixed;left:-9999px;top:0;background:white;width:794px;z-index:-1;font-family:Arial,sans-serif;' });
  div.innerHTML = `<div style="font-family:Arial,sans-serif;padding:24px;color:#162820">${innerHtml}${pdfFooter()}</div>`;
  document.body.appendChild(div);
  try {
    const canvas = await html2canvas(div, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pW = pdf.internal.pageSize.getWidth() - 20;
    const pH = pdf.internal.pageSize.getHeight() - 20;
    const iH = (canvas.height * pW) / canvas.width;
    let srcY = 0, page = 0;
    while (srcY < iH - 0.5) {
      if (page > 0) pdf.addPage();
      const sliceH = Math.min(pH, iH - srcY);
      const sc = document.createElement('canvas');
      sc.width = canvas.width;
      sc.height = Math.max(1, Math.round((sliceH / iH) * canvas.height));
      sc.getContext('2d').drawImage(canvas, 0, Math.round((srcY / iH) * canvas.height), canvas.width, sc.height, 0, 0, canvas.width, sc.height);
      pdf.addImage(sc.toDataURL('image/jpeg', 0.92), 'JPEG', 10, 10, pW, sliceH);
      srcY += sliceH;
      page++;
    }
    pdf.save(filename.replace(/[\\/:*?"<>|\s]+/g, '_'));
    showToast('PDF downloaded ✅');
  } catch (e) {
    console.error(e);
    showToast('PDF error: ' + e.message, true);
  } finally { div.remove(); }
}

function exportPDF(pid) {
  const p = getPatient(pid);
  if (!p) return;
  const hx = p.history || {};
  const pill = (x, bg, bc, tc) => `<span style="background:${bg};border:1px solid ${bc};padding:3px 9px;border-radius:12px;font-size:11px;color:${tc};display:inline-block;margin:2px">${esc(x)}</span>`;
  const sec = (t, arr, type = '') => arr?.length ? `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;color:#1f6f78;text-transform:uppercase;margin-bottom:4px">${t}</div><div>${arr.map(x => type === 'dx' ? pill(x, '#eafaf1', '#27ae60', '#1a6b40') : type === 'prob' ? pill(x, '#fdeaea', '#d94f4f', '#d94f4f') : pill(x, '#eef2f0', '#cddfe1', '#162820')).join('')}</div></div>` : '';
  const txt = (t, v) => v ? `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;color:#1f6f78;text-transform:uppercase;margin-bottom:3px">${t}</div><div style="font-size:11px;white-space:pre-wrap">${esc(v)}</div></div>` : '';

  let html = pdfHeader('PT Assessment Report') + pdfPatientBox(p);
  const hxRows = [['Chronic diseases', hx.chronic], ['Medications', hx.meds], ['Surgeries', hx.surgeries], ['Allergies', hx.allergies], ['Investigations', hx.imaging], ['Red flags / precautions', hx.redFlags]].filter(r => r[1]);
  if (hxRows.length) html += `<div style="margin-bottom:14px;font-size:11px"><div style="font-size:10px;font-weight:700;color:#1f6f78;text-transform:uppercase;margin-bottom:4px">Medical history</div>${hxRows.map(r => `<div><strong>${r[0]}:</strong> ${esc(r[1])}</div>`).join('')}</div>`;
  if (p.referral || p.refDoctor) html += `<div style="font-size:11px;margin-bottom:12px"><strong>Referral:</strong> ${esc([p.referral, p.refDoctor].filter(Boolean).join(' — '))}</div>`;

  sortedVisits(p).forEach(v => {
    const color = v.type === 'initial' ? '#1f6f78' : v.type === 'discharge' ? '#2980b9' : '#e8a020';
    html += `<div style="margin-bottom:18px;border-left:3px solid ${color};padding-left:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <span style="background:#f0f7f4;color:${color};padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">${VISIT_LABEL[v.type] || v.type}</span>
        <span style="font-size:12px;font-weight:600;color:#56717a">📅 ${esc(fmtDate(v.date))}</span>
        ${v.duration || v.onset ? `<span style="font-size:11px;color:#56717a">⏱ ${esc([v.duration, v.onset].filter(Boolean).join(' — '))}</span>` : ''}
        ${v.progress ? `<span style="font-size:11px;color:#56717a">Response: ${esc(v.progress)}</span>` : ''}
      </div>`;
    (v.regions || []).forEach(r => {
      html += `<div style="background:#f8faf9;border-radius:7px;padding:12px;margin-bottom:8px">
        <div style="font-weight:700;color:#0f2846;font-size:12px;margin-bottom:8px">📍 ${esc(r.region)}${r.sessionsPlanned ? ` <span style="font-size:10px;color:#56717a;font-weight:400">— ${esc(r.sessionsPlanned)} sessions${r.freq ? ' · ' + esc(r.freq) : ''}</span>` : ''}</div>
        ${sec('Diagnosis', r.diagnoses, 'dx')}${sec('Chief Complaints', r.complaints)}
        ${r.vas != null ? `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;color:#1f6f78;text-transform:uppercase;margin-bottom:3px">VAS</div><span style="font-size:18px;font-weight:700;color:${r.vas <= 3 ? '#27ae60' : r.vas <= 6 ? '#e8a020' : '#d94f4f'}">${r.vas}/10</span></div>` : ''}
        ${sec('Assessment Findings', r.findings)}${txt('Measurements', r.measurements)}${sec('Problem List', r.problems, 'prob')}${sec('Treatment Plan', r.treatment)}
      </div>`;
    });
    if ((v.measures || []).length) html += txt('Outcome measures', v.measures.map(m => `${m.name}: ${m.score || '—'}`).join('   ·   '));
    html += txt('Short-term goals', v.goalsShort) + txt(v.type === 'discharge' ? 'Outcome' : 'Long-term goals', v.goalsLong) + txt('Notes', v.notes);
    html += '</div>';
  });
  if (attendedCount(p)) html += `<div style="font-size:11px;color:#56717a">Sessions attended: <strong>${attendedCount(p)}</strong>${plannedSessions(p) ? ' of ' + plannedSessions(p) + ' planned' : ''}</div>`;
  renderPdf(html, `PT_${p.name}_${todayStr()}.pdf`);
}

function statementPDF(p) {
  const acc = account(p);
  const sessions = [...(p.sessions || [])].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const payments = [...(p.payments || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let html = pdfHeader('Account Statement') + pdfPatientBox(p);
  html += `<div style="font-size:12px;font-weight:700;color:#0f2846;margin-bottom:6px">Sessions</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px"><thead><tr><th style="${TH};width:30px">#</th><th style="${TH}">Date</th><th style="${TH}">Time</th><th style="${TH}">Type</th><th style="${TH};text-align:right">Price</th></tr></thead><tbody>
  ${sessions.map((s, i) => `<tr><td style="${TD(i)}">${i + 1}</td><td style="${TD(i)}">${esc(fmtDate(s.date))}</td><td style="${TD(i)}">${esc(fmtTime(s.time))}</td><td style="${TD(i)}">${esc(typeLabel(s.type))}</td><td style="${TD(i)};text-align:right">${money(s.price)}</td></tr>`).join('') || `<tr><td colspan="5" style="${TD(0)}">No sessions</td></tr>`}
  </tbody></table>`;
  if (payments.length) html += `<div style="font-size:12px;font-weight:700;color:#0f2846;margin-bottom:6px">Payments</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px"><thead><tr><th style="${TH}">Date</th><th style="${TH}">Method</th><th style="${TH}">Note</th><th style="${TH};text-align:right">Amount</th></tr></thead><tbody>
  ${payments.map((x, i) => `<tr><td style="${TD(i)}">${esc(fmtDate(x.date))}</td><td style="${TD(i)}">${esc(x.method || '')}</td><td style="${TD(i)}">${esc(x.note || '')}</td><td style="${TD(i)};text-align:right">${money(x.amount)}</td></tr>`).join('')}
  </tbody></table>`;
  const row = (l, v, strong) => `<tr><td style="padding:6px 10px;font-size:12px;${strong ? 'font-weight:700;background:#e0f2ea;color:#0f2846' : ''}">${l}</td><td style="padding:6px 10px;font-size:12px;text-align:right;${strong ? 'font-weight:700;background:#e0f2ea;color:#0f2846' : ''}">${v}</td></tr>`;
  html += `<table style="width:300px;margin-left:auto;border-collapse:collapse">
    ${row('Sessions', sessions.length)}${row('Total charges', money(acc.charges + acc.legacy))}${row('Total paid', money(acc.paid + acc.legacy))}
    ${row(acc.balance >= 0 ? 'Balance due' : 'Credit', money(Math.abs(acc.balance)), true)}</table>`;
  renderPdf(html, `Statement_${p.name}_${todayStr()}.pdf`);
}

function receiptPDF(p, pay) {
  const acc = account(getPatient(p.id) || p);
  const html = pdfHeader('Payment Receipt') + pdfPatientBox(p) + `
    <table style="width:100%;border-collapse:collapse;margin:10px 0 18px">
      <tr><td style="${TD(0)};width:160px"><strong>Receipt no.</strong></td><td style="${TD(0)}">${esc(pay.id.slice(-8).toUpperCase())}</td></tr>
      <tr><td style="${TD(1)}"><strong>Date</strong></td><td style="${TD(1)}">${esc(fmtDate(pay.date))}</td></tr>
      <tr><td style="${TD(0)}"><strong>Amount received</strong></td><td style="${TD(0)};font-size:16px;font-weight:700;color:#0f2846">${money(pay.amount)}</td></tr>
      <tr><td style="${TD(1)}"><strong>Method</strong></td><td style="${TD(1)}">${esc(pay.method || '')}</td></tr>
      ${pay.note ? `<tr><td style="${TD(0)}"><strong>For</strong></td><td style="${TD(0)}">${esc(pay.note)}</td></tr>` : ''}
      <tr><td style="${TD(1)}"><strong>${acc.balance >= 0 ? 'Remaining balance' : 'Credit remaining'}</strong></td><td style="${TD(1)}">${money(Math.abs(acc.balance))}</td></tr>
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:40px;font-size:11px;color:#56717a">
      <div>Received by: ${esc(pay.by || '')}</div><div>Signature: ____________________</div>
    </div>`;
  renderPdf(html, `Receipt_${p.name}_${pay.date}.pdf`);
}

function hepPDF(p, items, advice) {
  let html = pdfHeader('Home Exercise Program') + pdfPatientBox(p);
  html += `<table style="width:100%;border-collapse:collapse;margin-bottom:16px"><thead><tr>
    <th style="${TH};width:30px">#</th><th style="${TH}">Exercise</th><th style="${TH}">Sets</th><th style="${TH}">Reps</th><th style="${TH}">Hold</th><th style="${TH}">Notes</th></tr></thead><tbody>
    ${items.map((x, i) => `<tr><td style="${TD(i)}">${i + 1}</td><td style="${TD(i)};font-weight:700">${esc(x.name)}</td><td style="${TD(i)}">${esc(x.sets)}</td><td style="${TD(i)}">${esc(x.reps)}</td><td style="${TD(i)}">${x.hold ? esc(x.hold) + ' s' : ''}</td><td style="${TD(i)}">${esc(x.notes)}</td></tr>`).join('')}
  </tbody></table>`;
  if (advice) html += `<div style="background:#f0f7f4;border-left:3px solid #1f6f78;padding:10px 14px;font-size:12px;white-space:pre-wrap"><strong>Advice:</strong>\n${esc(advice)}</div>`;
  html += `<div style="margin-top:14px;font-size:11px;color:#d94f4f">Stop any exercise that causes sharp or increasing pain and contact the clinic.</div>`;
  renderPdf(html, `Exercises_${p.name}_${todayStr()}.pdf`);
}

// ═══════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════
function csvEsc(v) {
  if (v == null || v === '') return '';
  const s = String(v).replace(/\r\n|\r|\n/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvDownload(filename, rows) {
  const csv = rows.map(r => r.map(csvEsc).join(',')).join('\r\n');
  downloadBlob(filename, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
}
function exportCSV(pid) {
  const p = getPatient(pid);
  if (!p) return;
  const rows = [['Patient', 'File No', 'Age', 'Gender', 'Job', 'Phone', 'Visit Type', 'Date', 'Duration', 'Onset', 'Region', 'Diagnosis', 'Complaints', 'VAS', 'Findings', 'Measurements', 'Problems', 'Treatment', 'Sessions', 'Frequency', 'Outcome measures', 'Notes']];
  sortedVisits(p).forEach((v, vi) => (v.regions || []).forEach((r, ri) => {
    const first = vi === 0 && ri === 0;
    rows.push([first ? p.name : '', first ? p.fileNo : '', first ? p.age : '', first ? p.gender : '', first ? p.job : '', first ? p.phone : '',
      ri === 0 ? VISIT_LABEL[v.type] : '', ri === 0 ? v.date : '', ri === 0 ? v.duration : '', ri === 0 ? v.onset : '',
      r.region, (r.diagnoses || []).join(' | '), (r.complaints || []).join(' | '), r.vas != null ? r.vas + '/10' : '',
      (r.findings || []).join(' | '), r.measurements || '', (r.problems || []).join(' | '), (r.treatment || []).join(' | '),
      r.sessionsPlanned || '', r.freq || '', ri === 0 ? (v.measures || []).map(m => `${m.name}: ${m.score}`).join(' | ') : '', ri === 0 ? v.notes : '']);
  }));
  csvDownload(`PT_${p.name.replace(/\s+/g, '_')}_${todayStr()}.csv`, rows);
  showToast('CSV downloaded ✅');
}
$('btn-export-all').addEventListener('click', () => {
  if (!patients.length) { showToast('No patients to export', true); return; }
  const rows = [['File No', 'Name', 'Age', 'Gender', 'Job', 'Phone', 'Status', 'Referral', 'Registered', 'Regions', 'Diagnoses', 'First VAS', 'Last VAS', 'Sessions', 'Planned', 'Last visit', 'Total paid', 'Balance']];
  patients.forEach(p => {
    const vis = sortedVisits(p);
    const vasOf = v => (v?.regions || []).map(r => r.vas).filter(x => x != null).join('/');
    const acc = account(p);
    rows.push([p.fileNo, p.name, p.age, p.gender, p.job, p.phone, patientStatus(p), p.referral, p.createdAt ? dateStr(new Date(p.createdAt)) : '',
      regionsOf(p).join(' | '), diagnosesOf(p).join(' | '), vasOf(vis[0]), vis.length > 1 ? vasOf(vis[vis.length - 1]) : '',
      attendedCount(p), plannedSessions(p) || '', lastActivity(p), Math.round(acc.paid + acc.legacy), Math.round(acc.balance)]);
  });
  csvDownload(`Physiclinic_Patients_${todayStr()}.csv`, rows);
  showToast(`Exported ${patients.length} patients ✅`);
});

// ═══════════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════════
const STATUS_LABEL = { scheduled: 'Scheduled', confirmed: 'Confirmed', attended: 'Attended', cancelled: 'Cancelled', noshow: 'No-show' };
function statusPill(st) { st = st || 'scheduled'; return `<span class="status-pill sp-${st}">${STATUS_LABEL[st] || st}</span>`; }

function renderSchedule() {
  if (!scheduleDate) scheduleDate = todayStr();
  $('schedule-date-picker').value = scheduleDate;
  const isToday = scheduleDate === todayStr();
  $('schedule-date-label').textContent = fmtDate(scheduleDate, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + (isToday ? ' — Today' : '');

  // doctor filter
  const sel = $('schedule-doctor-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">👥 All Doctors</option>';
  (clinic.scheduleDoctors || []).forEach(d => sel.appendChild(el('option', { value: d.id, selected: d.id === cur }, '👨‍⚕️ ' + d.name)));

  if (schedUnsub) schedUnsub();
  $('schedule-body').innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading...</span></div>';
  const forDate = scheduleDate;
  schedUnsub = onSnapshot(query(collection(DB, 'appointments'), where('date', '==', forDate)), snap => {
    if (forDate !== scheduleDate) return;
    schedAppts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderScheduleGrid();
  }, err => { $('schedule-body').innerHTML = `<div class="flag-box">${esc(errMsg(err))}</div>`; });
}

function renderScheduleGrid() {
  const body = $('schedule-body');
  if (currentPage !== 'schedule') return;
  const filter = $('schedule-doctor-filter').value || 'all';
  const start = toMins(clinic.workStart || '09:00');
  const end = toMins(clinic.workEnd || '21:00');
  const dur = parseInt(clinic.sessionDur) || 45;
  const slots = [];
  for (let m = start; m < end; m += dur) slots.push(m);
  if (!slots.length) slots.push(start);

  let doctors = [...(clinic.scheduleDoctors || [])];
  // appointments whose doctor was removed still need a home
  const known = new Set(doctors.map(d => d.id));
  if (schedAppts.some(a => !known.has(a.doctorId))) doctors.push({ id: '__none', name: 'Other / unassigned' });
  if (filter !== 'all') doctors = doctors.filter(d => d.id === filter);

  body.innerHTML = '';
  if (!doctors.length) {
    body.innerHTML = `<div class="empty-state"><span class="icon">👨‍⚕️</span><h3>No doctors in the schedule</h3>
      <p>${isDoctor() ? 'Go to <strong>Clinic Settings</strong> and add doctors first.' : 'Ask the clinic admin to add doctors in Clinic Settings.'}</p></div>`;
    return;
  }

  const slotIndex = t => {
    const m = toMins(t);
    return Math.max(0, Math.min(slots.length - 1, Math.floor((m - start) / dur)));
  };

  const wrap = el('div', { class: 'time-grid-wrap' });
  const grid = el('div', { class: 'time-grid' });
  grid.style.gridTemplateColumns = `66px repeat(${doctors.length}, minmax(150px, 1fr))`;
  grid.appendChild(el('div', { class: 'tg-corner' }, 'Time'));
  doctors.forEach(d => {
    const count = schedAppts.filter(a => (d.id === '__none' ? !known.has(a.doctorId) : a.doctorId === d.id) && a.status !== 'cancelled').length;
    grid.appendChild(el('div', { class: 'tg-doc-header' }, d.name, el('div', { style: 'font-size:11px;opacity:.7;font-weight:500' }, `${count} appt${count !== 1 ? 's' : ''}`)));
  });

  const nowMins = scheduleDate === todayStr() ? new Date().getHours() * 60 + new Date().getMinutes() : -1;
  slots.forEach((m, si) => {
    const isNow = nowMins >= m && nowMins < m + dur;
    grid.appendChild(el('div', { class: 'tg-time-label', style: isNow ? 'background:var(--accent);color:var(--primary-dark)' : '' }, fmtTime(toTime(m))));
    doctors.forEach(d => {
      const cell = el('div', { class: 'tg-cell' });
      const appts = schedAppts
        .filter(a => (d.id === '__none' ? !known.has(a.doctorId) : a.doctorId === d.id) && slotIndex(a.time) === si)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      if (appts.length) cell.classList.add('has-appt');
      appts.forEach(a => {
        const p = getPatient(a.patientId);
        const off = a.time !== toTime(m);
        cell.appendChild(el('div', { class: `tg-appt-card status-${a.status || 'scheduled'}${off ? ' offslot' : ''}`, onclick: () => showApptActions(a), title: STATUS_LABEL[a.status || 'scheduled'] },
          el('div', { class: 'tac-name' }, p?.name || a.patientName || 'Unknown'),
          el('div', { class: 'tac-type' }, (off ? fmtTime(a.time) + ' · ' : '') + ({ initial: '🔵 Initial', session: '🕐 Session', followup: '🔁 F/U' }[a.type] || '🕐 Session')),
          a.notes ? el('div', { class: 'tac-note' }, a.notes) : null));
      });
      if (d.id !== '__none') {
        cell.appendChild(el('button', { class: 'tg-add-btn', style: appts.length ? 'min-height:22px;font-size:14px' : '', title: `Add appointment at ${fmtTime(toTime(m))} for ${d.name}`,
          onclick: () => openNewAppt({ time: toTime(m), doctorId: d.id }) }, '+'));
      }
      grid.appendChild(cell);
    });
  });
  wrap.appendChild(grid);
  body.appendChild(wrap);

  // Summary
  const by = st => schedAppts.filter(a => (a.status || 'scheduled') === st).length;
  const attendedRevenue = schedAppts.filter(a => a.status === 'attended').reduce((t, a) => t + num(a.price), 0);
  const card = (n, l, c) => `<div class="card" style="flex:1;min-width:90px;text-align:center;padding:12px"><div style="font-size:20px;font-weight:700;color:${c}">${n}</div><div style="font-size:11px;color:var(--muted)">${l}</div></div>`;
  body.appendChild(el('div', { style: 'margin-top:14px;display:flex;gap:10px;flex-wrap:wrap', html:
    card(schedAppts.filter(a => a.status !== 'cancelled').length, 'Booked', 'var(--primary-dark)') +
    card(by('scheduled') + by('confirmed'), 'Waiting', '#2980b9') +
    card(by('attended'), 'Attended', 'var(--green)') +
    card(by('noshow'), 'No-show', '#7f8c8d') +
    card(by('cancelled'), 'Cancelled', 'var(--red)') +
    (isDoctor() ? card(money(attendedRevenue), 'Attended value', 'var(--accent)') : '') }));
}

$('schedule-date-picker').addEventListener('change', e => { if (e.target.value) { scheduleDate = e.target.value; renderSchedule(); } });
$('sched-prev').addEventListener('click', () => { scheduleDate = addDays(scheduleDate, -1); renderSchedule(); });
$('sched-next').addEventListener('click', () => { scheduleDate = addDays(scheduleDate, 1); renderSchedule(); });
$('sched-today').addEventListener('click', () => { scheduleDate = todayStr(); renderSchedule(); });
$('schedule-doctor-filter').addEventListener('change', renderScheduleGrid);
$('btn-new-appt').addEventListener('click', () => openNewAppt());

// Appointment action sheet
function reminderText(a) {
  const p = getPatient(a.patientId);
  const d = parseDate(a.date);
  const t = (clinic.waTemplate || CLINIC_DEFAULTS.waTemplate);
  const [h, m] = (a.time || '0:0').split(':').map(Number);
  const time = new Date(2000, 0, 1, h, m).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
  return t.replaceAll('{name}', p?.name || a.patientName || '')
    .replaceAll('{date}', d.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }))
    .replaceAll('{time}', time)
    .replaceAll('{doctor}', a.doctorName || '')
    .replaceAll('{clinic}', clinic.clinicName || '');
}

function showApptActions(a) {
  const p = getPatient(a.patientId);
  const name = p?.name || a.patientName || 'Unknown';
  const st = a.status || 'scheduled';
  const bal = p ? account(p).balance : 0;
  const buttons = [];
  if (st !== 'attended') {
    buttons.push({ text: '✓ Attended + pay', cls: 'btn-primary', onClick: () => updateApptStatus(a, 'attended', true) });
    buttons.push({ text: '✓ Attended', cls: 'btn-green', onClick: () => updateApptStatus(a, 'attended') });
  } else {
    buttons.push({ text: '↩ Undo attendance', onClick: () => updateApptStatus(a, 'scheduled') });
    if (p) buttons.push({ text: '💵 Payment', cls: 'btn-primary', onClick: () => openPaymentModal(p.id) });
  }
  if (st === 'scheduled') buttons.push({ text: '👍 Confirmed', onClick: () => updateApptStatus(a, 'confirmed') });
  if (st !== 'noshow' && st !== 'attended') buttons.push({ text: '🚫 No-show', onClick: () => updateApptStatus(a, 'noshow') });
  if (st !== 'cancelled' && st !== 'attended') buttons.push({ text: '✕ Cancel appt', cls: 'btn-danger', onClick: () => updateApptStatus(a, 'cancelled') });
  if ((st === 'cancelled' || st === 'noshow')) buttons.push({ text: '↺ Re-schedule', onClick: () => updateApptStatus(a, 'scheduled') });
  if (p?.phone) buttons.push({ text: '💬 Reminder', onClick: () => openWa(p.phone, reminderText(a)) });
  if (p) buttons.push({ text: '📋 Patient file', onClick: () => showPage('profile', { id: p.id }) });
  buttons.push({ text: '✏️ Edit', onClick: () => openEditAppt(a) });
  buttons.push({ text: '🗑️ Delete', cls: 'btn-danger', onClick: () => deleteAppt(a) });
  buttons.push({ text: 'Close', full: true });
  dialog({
    icon: '📅', wide: true, title: `${name} — ${fmtTime(a.time)}`,
    message: `${fmtDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${a.doctorName || ''} · ${typeLabel(a.type)}\nStatus: ${STATUS_LABEL[st]}${a.notes ? '\n📝 ' + a.notes : ''}${bal > 0 ? `\n💳 Balance due: ${Math.round(bal)} ${clinic.currency || ''}` : ''}${p?.history?.redFlags ? '\n⚠️ ' + p.history.redFlags : ''}`,
    buttons
  });
}

async function updateApptStatus(a, status, thenPay = false) {
  const prev = a.status || 'scheduled';
  await updateDoc(doc(DB, 'appointments', a.id), { status, statusAt: Date.now(), statusBy: me.name || me.email });
  a.status = status;
  const pref = doc(DB, 'patients', a.patientId);
  if (status === 'attended' && prev !== 'attended') {
    const snap = await getDoc(pref);
    if (snap.exists()) {
      const sessions = snap.data().sessions || [];
      if (!sessions.some(s => s.apptId === a.id)) {
        await updateDoc(pref, { sessions: arrayUnion({
          id: generateId(), apptId: a.id, date: a.date, time: a.time, type: a.type || 'session',
          price: num(a.price) || sessionPrice(a.type), billed: true, doctorId: a.doctorId || '', doctorName: a.doctorName || '', at: Date.now()
        }), updatedAt: Date.now() });
      }
    }
  } else if (prev === 'attended' && status !== 'attended') {
    const snap = await getDoc(pref);
    if (snap.exists()) {
      const sessions = (snap.data().sessions || []).filter(s => s.apptId !== a.id);
      await updateDoc(pref, { sessions, updatedAt: Date.now() });
    }
  }
  showToast(`${STATUS_LABEL[status]} ✅`);
  if (thenPay) {
    const price = num(a.price) || sessionPrice(a.type);
    await new Promise(r => setTimeout(r, 250));
    openPaymentModal(a.patientId, { amount: price, date: todayStr(), note: `${typeLabel(a.type)} ${a.date}` });
  }
}

function deleteAppt(a) {
  confirmAction('Delete appointment', 'Delete this appointment?' + (a.status === 'attended' ? '\nIts session record will also be removed.' : ''), async () => {
    if (a.status === 'attended') await updateApptStatus(a, 'scheduled');
    await deleteDoc(doc(DB, 'appointments', a.id));
    showToast('Appointment deleted');
  });
}

// ── Appointment modal ──
let editAppt = null;
let conflictOk = false;

function fillDoctorSelect(selected) {
  const docs = clinic.scheduleDoctors || [];
  const dsel = $('appt-doctor-select');
  dsel.innerHTML = '';
  if (!docs.length) dsel.appendChild(el('option', { value: '' }, 'No doctors — add in Settings'));
  docs.forEach(d => dsel.appendChild(el('option', { value: d.id, selected: d.id === selected }, d.name)));
}

function openNewAppt(pre = {}) {
  editAppt = null;
  conflictOk = false;
  $('appt-modal-title').textContent = 'New Appointment';
  $('appt-date').value = pre.date || (currentPage === 'schedule' ? scheduleDate : '') || todayStr();
  $('appt-time').value = pre.time || '';
  $('appt-type').value = 'session';
  $('appt-notes').value = '';
  $('appt-repeat').value = '0';
  $('appt-repeat-count').value = '6';
  $('appt-repeat-wrap').classList.remove('hidden');
  $('appt-conflict').classList.add('hidden');
  $('save-appt').textContent = '💾 Save';
  fillDoctorSelect(pre.doctorId || ($('schedule-doctor-filter').value !== 'all' ? $('schedule-doctor-filter').value : ''));
  clearPatientPick();
  if (pre.patientId) {
    const p = getPatient(pre.patientId);
    if (p) {
      selectPatient(p);
      // suggest the right type
      if (!initialVisit(p) && !(p.sessions || []).length) $('appt-type').value = 'initial';
    }
  }
  $('appt-price').value = sessionPrice($('appt-type').value) || '';
  openModal('modal-appt');
  setTimeout(() => (pre.patientId ? $('appt-time') : $('appt-patient-search')).focus(), 100);
}

function openEditAppt(a) {
  editAppt = a;
  conflictOk = false;
  $('appt-modal-title').textContent = 'Edit Appointment';
  $('appt-date').value = a.date || '';
  $('appt-time').value = a.time || '';
  $('appt-price').value = a.price || '';
  $('appt-notes').value = a.notes || '';
  $('appt-type').value = a.type || 'session';
  $('appt-repeat-wrap').classList.add('hidden');
  $('appt-conflict').classList.add('hidden');
  $('save-appt').textContent = '💾 Save';
  fillDoctorSelect(a.doctorId);
  clearPatientPick();
  const p = getPatient(a.patientId);
  if (p) selectPatient(p);
  else { $('appt-patient-search').value = a.patientName || ''; $('appt-patient-id').value = a.patientId || ''; }
  openModal('modal-appt');
}

$('appt-type').addEventListener('change', () => {
  const was = num($('appt-price').value);
  if (!was || was === sessionPrice('session') || was === sessionPrice('initial')) $('appt-price').value = sessionPrice($('appt-type').value) || '';
});
['appt-date', 'appt-time', 'appt-doctor-select'].forEach(id => $(id).addEventListener('change', () => {
  conflictOk = false; $('appt-conflict').classList.add('hidden'); $('save-appt').textContent = '💾 Save';
}));

function clearPatientPick() {
  $('appt-patient-search').value = '';
  $('appt-patient-id').value = '';
  $('appt-patient-selected').classList.add('hidden');
  $('appt-patient-dropdown').classList.add('hidden');
}
function selectPatient(p) {
  $('appt-patient-search').value = p.name;
  $('appt-patient-id').value = p.id;
  const s = $('appt-patient-selected');
  const bal = account(p).balance;
  s.textContent = '✓ ' + p.name + (p.phone ? '  ·  ' + p.phone : '') + (bal > 0 ? `  ·  Balance due ${Math.round(bal)}` : '');
  s.classList.remove('hidden');
  $('appt-patient-dropdown').classList.add('hidden');
}
let searchTimer = null;
function renderPatientDropdown(q) {
  const dd = $('appt-patient-dropdown');
  if (!q) { dd.classList.add('hidden'); return; }
  const ql = q.toLowerCase();
  const matches = patients.filter(p => (p.name || '').toLowerCase().includes(ql) || (p.phone && p.phone.includes(q)) || String(p.fileNo || '') === q.replace('#', '')).slice(0, 10);
  dd.innerHTML = '';
  if (!matches.length) {
    dd.appendChild(el('div', { style: 'padding:10px 14px;color:var(--muted);font-size:13px' }, 'No patients found — ',
      el('a', { href: '#', onclick: e => { e.preventDefault(); closeModal('modal-appt'); openPatientModal(); $('pt-name').value = q; } }, 'add new patient')));
  }
  matches.forEach(p => {
    const item = el('div', { style: 'padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)' },
      el('span', { style: 'font-weight:600' }, p.name),
      el('span', { style: 'color:var(--muted);font-size:11px' }, [p.fileNo ? ' #' + p.fileNo : '', p.age ? ` ${p.age} y/o` : '', p.phone ? ' · ' + p.phone : ''].join('')));
    item.addEventListener('pointerdown', e => { e.preventDefault(); selectPatient(p); });
    item.addEventListener('mouseenter', () => item.style.background = '#f0f7f4');
    item.addEventListener('mouseleave', () => item.style.background = '');
    dd.appendChild(item);
  });
  dd.classList.remove('hidden');
}
$('appt-patient-search').addEventListener('input', function () {
  $('appt-patient-id').value = '';
  $('appt-patient-selected').classList.add('hidden');
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderPatientDropdown(this.value.trim()), 120);
});
$('appt-patient-search').addEventListener('blur', () => setTimeout(() => $('appt-patient-dropdown').classList.add('hidden'), 200));
$('appt-patient-search').addEventListener('focus', function () { if (this.value.trim() && !$('appt-patient-id').value) renderPatientDropdown(this.value.trim()); });

// Dates for a repeating series, starting with the chosen date.
function seriesDates(start, pattern, count) {
  const days = { mwf: [6, 1, 3], 'sun-tue-thu': [0, 2, 4], daily: [0, 1, 2, 3, 4, 6] }[pattern];
  const out = [start];
  let d = start, guard = 0;
  while (out.length < count && guard++ < 400) {
    d = pattern === 'weekly' ? addDays(d, 7) : addDays(d, 1);
    if (pattern === 'weekly' || days.includes(parseDate(d).getDay())) out.push(d);
  }
  return out;
}

$('save-appt').addEventListener('click', async () => {
  const date = $('appt-date').value;
  const time = $('appt-time').value;
  const patientId = $('appt-patient-id').value;
  const doctorId = $('appt-doctor-select').value;
  const type = $('appt-type').value;
  const notes = $('appt-notes').value.trim();
  const price = num($('appt-price').value) || sessionPrice(type);
  if (!date || !time) { showToast('Please fill date and time', true); return; }
  if (!patientId) { showToast('Please select a patient from the list', true); return; }
  if (!doctorId) { showToast('Please choose a doctor (add doctors in Clinic Settings)', true); return; }
  const p = getPatient(patientId);
  const dr = (clinic.scheduleDoctors || []).find(x => x.id === doctorId);
  const pattern = !editAppt ? $('appt-repeat').value : '0';
  const count = Math.min(30, Math.max(1, parseInt($('appt-repeat-count').value) || 1));
  const dates = pattern !== '0' ? seriesDates(date, pattern, count) : [date];
  const b = $('save-appt');
  b.disabled = true;
  try {
    // Conflict check (same doctor & time, or same patient same day)
    if (!conflictOk) {
      const issues = [];
      for (const d of dates) {
        const snap = await getDocs(query(collection(DB, 'appointments'), where('date', '==', d)));
        snap.docs.map(x => ({ id: x.id, ...x.data() }))
          .filter(x => x.id !== editAppt?.id && x.status !== 'cancelled')
          .forEach(x => {
            if (x.doctorId === doctorId && x.time === time) issues.push(`${fmtDate(d)} ${fmtTime(time)}: ${dr?.name || 'Doctor'} already has ${x.patientName || 'a patient'}`);
            else if (x.patientId === patientId) issues.push(`${fmtDate(d)}: ${p?.name} is already booked at ${fmtTime(x.time)}`);
          });
      }
      if (issues.length) {
        const box = $('appt-conflict');
        box.textContent = '⚠️ ' + issues.slice(0, 5).join('\n⚠️ ') + (issues.length > 5 ? `\n…and ${issues.length - 5} more` : '');
        box.style.whiteSpace = 'pre-line';
        box.classList.remove('hidden');
        conflictOk = true;
        b.textContent = 'Save anyway';
        return;
      }
    }
    const base = { time, patientId, patientName: p?.name || '', doctorId, doctorName: dr?.name || '', type, notes, price };
    if (editAppt) {
      await updateDoc(doc(DB, 'appointments', editAppt.id), { ...base, date, updatedAt: Date.now() });
      // keep a linked session in sync
      if (editAppt.status === 'attended' && p) {
        const sessions = (p.sessions || []).map(s => s.apptId === editAppt.id ? { ...s, date, time, type, price, doctorId, doctorName: dr?.name || '' } : s);
        await updateDoc(doc(DB, 'patients', p.id), { sessions });
      }
      showToast('Appointment updated ✅');
    } else {
      const batch = writeBatch(DB);
      const seriesId = dates.length > 1 ? generateId() : null;
      dates.forEach(d => batch.set(doc(collection(DB, 'appointments')), { ...base, date: d, status: 'scheduled', createdAt: Date.now(), createdBy: me.name || me.email, ...(seriesId ? { seriesId } : {}) }));
      await batch.commit();
      showToast(dates.length > 1 ? `${dates.length} appointments booked ✅` : 'Appointment saved ✅');
    }
    closeModal('modal-appt');
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; }
});

// ═══════════════════════════════════════════
// FINANCE
// ═══════════════════════════════════════════
function finRange() {
  const t = todayStr();
  const v = $('fin-range').value;
  if (v === 'today') return [t, t];
  if (v === 'week') return [addDays(t, -6), t];
  if (v === 'month') return [t.slice(0, 8) + '01', t];
  if (v === 'lastmonth') { const d = parseDate(t.slice(0, 8) + '01'); d.setDate(0); const e = dateStr(d); return [e.slice(0, 8) + '01', e]; }
  if (v === 'year') return [t.slice(0, 4) + '-01-01', t];
  return [$('fin-from').value || t.slice(0, 8) + '01', $('fin-to').value || t];
}
$('fin-range').addEventListener('change', () => {
  const custom = $('fin-range').value === 'custom';
  $('fin-from').classList.toggle('hidden', !custom);
  $('fin-to').classList.toggle('hidden', !custom);
  if (custom && !$('fin-from').value) { const [f, t] = [todayStr().slice(0, 8) + '01', todayStr()]; $('fin-from').value = f; $('fin-to').value = t; }
  renderFinance();
});
['fin-from', 'fin-to'].forEach(id => $(id).addEventListener('change', renderFinance));

let finExpenses = [], finExpErr = '', finToken = 0;
function finData(from, to) {
  const payments = [], sessions = [];
  patients.forEach(p => {
    (p.payments || []).forEach(x => { if (x.date >= from && x.date <= to) payments.push({ ...x, patient: p.name, pid: p.id }); });
    (p.sessions || []).forEach(s => {
      if (s.date >= from && s.date <= to) {
        sessions.push({ ...s, patient: p.name, pid: p.id });
        if (!s.billed) payments.push({ date: s.date, amount: num(s.price), method: 'Legacy (session)', note: typeLabel(s.type), patient: p.name, pid: p.id, legacy: true });
      }
    });
  });
  payments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { payments, sessions };
}

async function renderFinance() {
  if (!isDoctor()) return;
  const [from, to] = finRange();
  const token = ++finToken;
  try {
    const snap = await getDocs(query(collection(DB, 'expenses'), where('date', '>=', from), where('date', '<=', to)));
    finExpenses = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    finExpErr = '';
  } catch (e) { finExpenses = []; finExpErr = errMsg(e); }
  if (token !== finToken || currentPage !== 'finance') return;
  drawFinance(from, to);
}

function drawFinance(from, to) {
  const body = $('finance-body');
  const { payments, sessions } = finData(from, to);
  const collected = payments.reduce((t, x) => t + num(x.amount), 0);
  const billed = sessions.reduce((t, s) => t + num(s.price), 0);
  const expenses = finExpenses.reduce((t, x) => t + num(x.amount), 0);
  const debtors = patients.map(p => ({ p, bal: account(p).balance })).filter(x => x.bal > 0).sort((a, b) => b.bal - a.bal);
  const outstanding = debtors.reduce((t, x) => t + x.bal, 0);
  const newPatients = patients.filter(p => p.createdAt && (d => d >= from && d <= to)(dateStr(new Date(p.createdAt)))).length;

  body.innerHTML = `<div class="muted" style="font-size:13px;margin:-10px 0 14px">${esc(fmtDate(from))} → ${esc(fmtDate(to))}</div>
  <div class="stats-grid">
    <div class="stat-card green"><div class="stat-num">${money(collected)}</div><div class="stat-lbl">Collected</div></div>
    <div class="stat-card blue"><div class="stat-num">${money(billed)}</div><div class="stat-lbl">Session value (${sessions.length} sessions)</div></div>
    <div class="stat-card red"><div class="stat-num">${money(expenses)}</div><div class="stat-lbl">Expenses</div></div>
    <div class="stat-card gold"><div class="stat-num" style="color:${collected - expenses < 0 ? 'var(--red)' : 'var(--primary-dark)'}">${money(collected - expenses)}</div><div class="stat-lbl">Net (collected − expenses)</div></div>
    <div class="stat-card red"><div class="stat-num">${money(outstanding)}</div><div class="stat-lbl">Outstanding now (${debtors.length} patients)</div></div>
    <div class="stat-card"><div class="stat-num">${newPatients}</div><div class="stat-lbl">New patients</div></div>
  </div>`;

  // Daily chart
  const days = daysBetween(from, to) + 1;
  if (days > 1 && days <= 62) body.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, el('div', { class: 'card-title' }, '📊 Collected per day'), dailyChart(from, days, payments)));

  const cols = el('div', { class: 'dash-cols', style: 'margin-bottom:16px' });
  // by method
  const byMethod = {};
  payments.forEach(x => byMethod[x.method || 'Other'] = (byMethod[x.method || 'Other'] || 0) + num(x.amount));
  cols.appendChild(breakdownCard('💳 By payment method', byMethod, collected));
  // by doctor
  const byDoc = {};
  sessions.forEach(s => {
    const k = s.doctorName || 'Not recorded';
    byDoc[k] = byDoc[k] || { n: 0, v: 0 };
    byDoc[k].n++; byDoc[k].v += num(s.price);
  });
  const dc = el('div', { class: 'card' }, el('div', { class: 'card-title' }, '👨‍⚕️ Sessions by doctor'));
  const dt = el('table', { class: 'data-table' });
  dt.innerHTML = `<thead><tr><th>Doctor</th><th class="num">Sessions</th><th class="num">Value</th></tr></thead><tbody>${Object.entries(byDoc).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${money(v.v)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No sessions</td></tr>'}</tbody>`;
  dc.appendChild(el('div', { class: 'table-wrap' }, dt));
  cols.appendChild(dc);
  body.appendChild(cols);

  const cols2 = el('div', { class: 'dash-cols', style: 'margin-bottom:16px' });
  // expenses
  const ec = el('div', { class: 'card' }, el('div', { class: 'card-title' }, `🧾 Expenses (${finExpenses.length})`, btn('+ Expense', 'btn-ghost btn-sm', openExpenseModal)));
  if (finExpErr) ec.appendChild(el('div', { class: 'flag-box' }, finExpErr));
  else if (!finExpenses.length) ec.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:12px' }, 'No expenses in this period'));
  else {
    const t = el('table', { class: 'data-table' });
    t.innerHTML = '<thead><tr><th>Date</th><th>Category</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead>';
    const tb = el('tbody');
    finExpenses.forEach(x => {
      const tr = el('tr', { html: `<td>${esc(fmtDate(x.date))}</td><td>${esc(x.category)}</td><td>${esc(x.note || '')}</td><td class="num">${money(x.amount)}</td>` });
      tr.appendChild(el('td', {}, el('button', { class: 'icon-btn', style: 'width:28px;height:26px', title: 'Delete', onclick: () => confirmAction('Delete expense', `Delete ${x.category} — ${Math.round(num(x.amount))}?`, async () => {
        await deleteDoc(doc(DB, 'expenses', x.id)); showToast('Expense deleted'); renderFinance();
      }) }, '✕')));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    ec.appendChild(el('div', { class: 'table-wrap' }, t));
  }
  cols2.appendChild(ec);
  // outstanding
  const oc = el('div', { class: 'card' }, el('div', { class: 'card-title' }, `💳 Patients with balance (${debtors.length})`));
  if (!debtors.length) oc.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:12px' }, 'No outstanding balances ✅'));
  debtors.slice(0, 15).forEach(({ p, bal }) => oc.appendChild(el('div', { class: 'list-row clickable', onclick: () => showPage('profile', { id: p.id, tab: 'billing' }) },
    el('div', { class: 'grow' }, el('div', { class: 'title' }, p.name), el('div', { class: 'sub' }, p.phone || '')),
    el('span', { class: 'badge b-debt', html: money(bal) }))));
  cols2.appendChild(oc);
  body.appendChild(cols2);

  // payments list
  const pc = el('div', { class: 'card' }, el('div', { class: 'card-title' }, `💵 Payments received (${payments.length})`));
  if (!payments.length) pc.appendChild(el('div', { class: 'muted', style: 'font-size:13px;text-align:center;padding:12px' }, 'No payments in this period'));
  else {
    const t = el('table', { class: 'data-table' });
    t.innerHTML = `<thead><tr><th>Date</th><th>Patient</th><th>Method</th><th>Note</th><th class="num">Amount</th></tr></thead>
      <tbody>${payments.slice(0, 300).map(x => `<tr data-pid="${esc(x.pid)}" style="cursor:pointer"><td>${esc(fmtDate(x.date))}</td><td>${esc(x.patient)}</td><td>${esc(x.method || '')}</td><td>${esc(x.note || '')}</td><td class="num">${money(x.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="num">${money(collected)}</td></tr></tfoot>`;
    t.addEventListener('click', e => { const tr = e.target.closest('tr[data-pid]'); if (tr) showPage('profile', { id: tr.dataset.pid, tab: 'billing' }); });
    pc.appendChild(el('div', { class: 'table-wrap' }, t));
  }
  body.appendChild(pc);
}

function breakdownCard(title, obj, total) {
  const c = el('div', { class: 'card' }, el('div', { class: 'card-title' }, title));
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!entries.length) c.appendChild(el('div', { class: 'muted', style: 'font-size:13px' }, 'Nothing yet'));
  entries.forEach(([k, v]) => c.appendChild(el('div', { style: 'margin-bottom:10px' },
    el('div', { style: 'display:flex;justify-content:space-between;font-size:13px' }, el('span', {}, k), el('strong', { html: money(v) })),
    el('div', { class: 'progress' }, el('div', { style: `width:${total ? v / total * 100 : 0}%;background:var(--primary)` })))));
  return c;
}

function dailyChart(from, days, payments) {
  const vals = Array.from({ length: days }, (_, i) => { const d = addDays(from, i); return [d, payments.filter(x => x.date === d).reduce((t, x) => t + num(x.amount), 0)]; });
  const max = Math.max(1, ...vals.map(v => v[1]));
  const W = 700, H = 170, L = 8, B = 22, T = 14;
  const bw = (W - L * 2) / days;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="Collected per day">`;
  vals.forEach(([d, v], i) => {
    const h = v / max * (H - T - B);
    const x = L + i * bw;
    svg += `<rect x="${x + bw * 0.15}" y="${H - B - h}" width="${bw * 0.7}" height="${Math.max(h, v ? 2 : 0)}" rx="3" fill="${d === todayStr() ? '#e8a020' : '#1f6f78'}"><title>${esc(fmtDate(d))}: ${Math.round(v)}</title></rect>`;
    if (days <= 14 || i % Math.ceil(days / 10) === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#56717a">${parseDate(d).getDate()}</text>`;
  });
  svg += `<text x="${W - L}" y="${T - 2}" font-size="10" text-anchor="end" fill="#56717a">max ${Math.round(max).toLocaleString()}</text></svg>`;
  return el('div', { class: 'chart-box', html: svg });
}

function openExpenseModal() {
  $('exp-amount').value = '';
  $('exp-date').value = todayStr();
  $('exp-category').value = 'Rent';
  $('exp-note').value = '';
  openModal('modal-expense');
  setTimeout(() => $('exp-amount').focus(), 100);
}
$('fin-add-expense').addEventListener('click', openExpenseModal);
$('save-expense').addEventListener('click', async () => {
  const amount = num($('exp-amount').value);
  if (amount <= 0) { showToast('Enter an amount', true); return; }
  try {
    await addDoc(collection(DB, 'expenses'), { amount, date: $('exp-date').value || todayStr(), category: $('exp-category').value, note: $('exp-note').value.trim(), createdBy: me.name || me.email, createdAt: Date.now() });
    closeModal('modal-expense');
    showToast('Expense saved ✅');
    if (currentPage === 'finance') renderFinance();
  } catch (e) { showToast(errMsg(e), true); }
});
$('fin-export').addEventListener('click', () => {
  const [from, to] = finRange();
  const { payments, sessions } = finData(from, to);
  const rows = [['Type', 'Date', 'Patient / Category', 'Method', 'Note', 'Amount']];
  payments.forEach(x => rows.push(['Payment', x.date, x.patient, x.method, x.note, Math.round(num(x.amount))]));
  finExpenses.forEach(x => rows.push(['Expense', x.date, x.category, '', x.note, -Math.round(num(x.amount))]));
  rows.push([]);
  rows.push(['Sessions', sessions.length]);
  csvDownload(`Finance_${from}_to_${to}.csv`, rows);
});

// ═══════════════════════════════════════════
// ASSESSMENT OPTIONS (manage page)
// ═══════════════════════════════════════════
let manageTab = 'regions', manageSelRegion = '';
const FLAT_TABS = ['regions', 'problems', 'measures', 'exercises'];

async function renderManage() {
  const card = $('manage-card');
  card.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  let opts;
  try { opts = await readOptions(); } catch (e) { card.innerHTML = `<div class="flag-box">${esc(errMsg(e))}</div>`; return; }
  card.innerHTML = '';
  const LABELS = { regions: 'Regions', diagnoses: 'Diagnoses', complaints: 'Complaints', findings: 'Findings', treatment: 'Treatment', problems: 'Problem List', measures: 'Outcome Measures', exercises: 'Exercise Library' };
  card.appendChild(el('div', { class: 'manage-tabs' }, ...Object.keys(LABELS).map(t =>
    el('button', { class: 'manage-tab' + (manageTab === t ? ' active' : ''), onclick: () => { manageTab = t; renderManage(); } }, LABELS[t]))));

  const flat = FLAT_TABS.includes(manageTab);
  if (!flat) {
    if (!opts.regions.includes(manageSelRegion)) manageSelRegion = opts.regions[0] || '';
    const sel = el('select', { class: 'form-control', style: 'width:auto' }, ...opts.regions.map(r => el('option', { value: r, selected: r === manageSelRegion }, r)));
    sel.addEventListener('change', () => { manageSelRegion = sel.value; renderManage(); });
    card.appendChild(el('div', { style: 'margin-bottom:12px' }, el('label', { class: 'form-label', style: 'display:block;margin-bottom:5px' }, 'Region'), sel));
  }
  const tab = manageTab, region = manageSelRegion;
  const getList = o => flat ? (o[tab] = o[tab] || []) : ((o[tab] = o[tab] || {})[region] = o[tab][region] || []);
  const items = [...getList(opts)];

  const filterInp = el('input', { class: 'form-control', placeholder: `Filter ${items.length} items...`, style: 'margin-bottom:10px' });
  const list = el('div');
  const draw = () => {
    const q = filterInp.value.toLowerCase();
    list.innerHTML = '';
    items.filter(i => i.toLowerCase().includes(q)).forEach(item => {
      const rm = el('button', { class: 'option-remove-btn' }, '✕ Remove');
      rm.addEventListener('click', async () => {
        rm.disabled = true; rm.textContent = 'Removing...';
        try {
          const fresh = await readOptions();
          const arr = getList(fresh);
          arr.splice(0, arr.length, ...arr.filter(x => x !== item));
          await writeOptions(fresh);
          showToast(item + ' removed ✅');
          renderManage();
        } catch (e) { showToast(errMsg(e), true); rm.disabled = false; rm.textContent = '✕ Remove'; }
      });
      list.appendChild(el('div', { class: 'option-item' }, el('span', {}, item), rm));
    });
  };
  filterInp.addEventListener('input', draw);
  if (items.length > 12) card.appendChild(filterInp);
  draw();
  card.appendChild(list);

  const addInp = el('input', { type: 'text', placeholder: tab === 'regions' ? 'New region name...' : 'Add new option...' });
  const add = async () => {
    const val = addInp.value.trim();
    if (!val) return;
    try {
      const fresh = await readOptions();
      const arr = getList(fresh);
      if (!arr.includes(val)) arr.push(val);
      if (tab === 'regions') REGION_KEYS.forEach(k => { fresh[k] = fresh[k] || {}; fresh[k][val] = fresh[k][val] || []; });
      await writeOptions(fresh);
      showToast('Added ✅');
      renderManage();
    } catch (e) { showToast(errMsg(e), true); }
  };
  addInp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  card.appendChild(el('div', { class: 'add-option-row', style: 'margin-top:12px' }, addInp, el('button', { onclick: add }, '+ Add')));
}

// ═══════════════════════════════════════════
// STAFF ACCOUNTS
// ═══════════════════════════════════════════
async function renderUsers() {
  const card = $('users-card');
  card.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  let users;
  try { users = (await getDocs(collection(DB, 'users'))).docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { card.innerHTML = `<div class="flag-box">${esc(errMsg(e))}</div>`; return; }
  const rank = u => u.role === 'pending' ? 0 : u.disabled ? 2 : 1;
  users.sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || ''));
  card.innerHTML = '';
  card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap' },
    el('div', { style: 'font-weight:700;color:var(--primary-dark)' }, `${users.filter(u => !u.disabled && u.role !== 'pending').length} active account(s)`),
    btn('+ Add Staff', 'btn-primary btn-sm', () => {
      ['user-name-input', 'user-email-input', 'user-pass-input'].forEach(id => $(id).value = '');
      $('user-role-input').value = 'receptionist';
      openModal('modal-add-user');
    })));
  card.appendChild(el('div', { class: 'note-box', style: 'margin-bottom:14px' },
    'Doctors see everything. Receptionists see the dashboard, patients, schedule and payments — not finance reports, settings or assessment editing. Removed staff can no longer sign in.'));

  users.forEach(u => {
    const isMe = u.id === me.uid;
    const row = el('div', { class: 'list-row', style: u.disabled ? 'opacity:.55' : '' });
    row.appendChild(el('div', { style: 'width:38px;height:38px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0' }, (u.name || u.email || '?').charAt(0).toUpperCase()));
    row.appendChild(el('div', { class: 'grow' },
      el('div', { class: 'title' }, (u.name || u.email) + (isMe ? ' (you)' : '')),
      el('div', { class: 'sub' }, u.email || '', ' · ',
        el('span', { style: 'font-weight:600', html: u.role === 'pending' ? '⏳ Waiting for approval' : u.disabled ? '⛔ Removed' : u.role === 'receptionist' ? '🗂️ Receptionist' : '👨‍⚕️ Doctor' }))));
    const set = async (data, msg) => { try { await updateDoc(doc(DB, 'users', u.id), data); showToast(msg); renderUsers(); } catch (e) { showToast(errMsg(e), true); } };
    if (!isMe) {
      if (u.role === 'pending') {
        row.appendChild(btn('Approve: Doctor', 'btn-primary btn-sm', () => set({ role: 'doctor', disabled: false }, 'Approved ✅')));
        row.appendChild(btn('Receptionist', 'btn-ghost btn-sm', () => set({ role: 'receptionist', disabled: false }, 'Approved ✅')));
        row.appendChild(btn('Reject', 'btn-danger btn-sm', () => set({ disabled: true, role: 'receptionist' }, 'Rejected')));
      } else if (u.disabled) {
        row.appendChild(btn('Restore', 'btn-ghost btn-sm', () => set({ disabled: false }, 'Access restored ✅')));
      } else {
        const roleSel = el('select', { class: 'form-control', style: 'width:auto;padding:5px 8px;font-size:12px' },
          el('option', { value: 'doctor', selected: u.role !== 'receptionist' }, 'Doctor'), el('option', { value: 'receptionist', selected: u.role === 'receptionist' }, 'Receptionist'));
        roleSel.addEventListener('change', () => set({ role: roleSel.value }, 'Role updated ✅'));
        row.appendChild(roleSel);
        row.appendChild(btn('🔑', 'btn-ghost btn-sm', async () => {
          try { await sendPasswordResetEmail(AUTH, u.email); showToast('Password reset email sent ✅'); } catch (e) { showToast(errMsg(e), true); }
        }, { title: 'Send password reset email' }));
        row.appendChild(btn('Remove', 'btn-danger btn-sm', () => confirmAction('Remove staff', `Remove "${u.name || u.email}"? They will not be able to sign in.`, () => set({ disabled: true }, 'Removed'), 'Remove')));
      }
    }
    card.appendChild(row);
  });
}

$('save-add-user').addEventListener('click', async () => {
  const email = $('user-email-input').value.trim();
  const pass = $('user-pass-input').value;
  const name = $('user-name-input').value.trim();
  const role = $('user-role-input').value;
  if (!email || !pass) { showToast('Email and password required', true); return; }
  if (pass.length < 6) { showToast('Password must be at least 6 characters', true); return; }
  const b = $('save-add-user');
  b.disabled = true;
  try {
    // REST sign-up so the admin stays signed in
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${fbApp.options.apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass, returnSecureToken: false }) });
    const data = await res.json();
    if (data.error) {
      showToast(data.error.message === 'EMAIL_EXISTS' ? 'This email already has an account. If they were removed, use "Restore".' : data.error.message, true);
      return;
    }
    await setDoc(doc(DB, 'users', data.localId), { name: name || email, email, role, createdAt: Date.now() });
    closeModal('modal-add-user');
    showToast('Staff account created ✅');
    renderUsers();
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; }
});

// ═══════════════════════════════════════════
// CLINIC SETTINGS
// ═══════════════════════════════════════════
const SET_FIELDS = { clinicName: 'set-clinic-name', doctorName: 'set-doctor-name', address: 'set-address', phone: 'set-phone', logoUrl: 'set-logo-url',
  workStart: 'set-work-start', workEnd: 'set-work-end', sessionDur: 'set-session-dur', sessionPrice: 'set-session-price', initialPrice: 'set-initial-price',
  currency: 'set-currency', followupDays: 'set-followup-days', waTemplate: 'set-wa-template' };

function renderSettings() {
  for (const [k, id] of Object.entries(SET_FIELDS)) $(id).value = clinic[k] ?? '';
  if (![...$('set-session-dur').options].some(o => o.value === String(clinic.sessionDur))) $('set-session-dur').value = '45';
  if (!num(clinic.initialPrice)) $('set-initial-price').value = '';
  updateLogoPreview(clinic.logoUrl);
  renderDoctorsList();
}

function renderDoctorsList() {
  const list = $('doctors-list');
  const docs = clinic.scheduleDoctors || [];
  list.innerHTML = '';
  if (!docs.length) { list.appendChild(el('p', { style: 'color:var(--muted);font-size:13px' }, 'No doctors added yet.')); return; }
  docs.forEach((d, i) => list.appendChild(el('div', { class: 'option-item' },
    el('span', { style: 'flex:0;font-size:18px' }, '👨‍⚕️'),
    el('span', { style: 'font-weight:600' }, d.name),
    i > 0 ? el('button', { class: 'btn btn-ghost btn-sm', title: 'Move up', onclick: () => moveDoctor(i, -1) }, '↑') : null,
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => formDialog({
      title: 'Rename doctor', fields: [{ id: 'name', label: 'Name', value: d.name }],
      onSave: async v => { if (!v.name) return false; await saveDoctors(docs.map(x => x.id === d.id ? { ...x, name: v.name } : x)); showToast('Renamed ✅'); }
    }) }, '✏️'),
    el('button', { class: 'option-remove-btn', onclick: () => confirmAction('Remove doctor', `Remove ${d.name} from the schedule?\nTheir existing appointments stay, under "Other / unassigned".`, async () => {
      await saveDoctors(docs.filter(x => x.id !== d.id)); showToast('Doctor removed');
    }, 'Remove') }, '✕ Remove'))));
}
async function saveDoctors(list) {
  await setDoc(doc(DB, 'config', 'clinic'), { scheduleDoctors: list }, { merge: true });
  clinic.scheduleDoctors = list;
  renderDoctorsList();
}
function moveDoctor(i, dir) {
  const list = [...clinic.scheduleDoctors];
  [list[i], list[i + dir]] = [list[i + dir], list[i]];
  saveDoctors(list).catch(e => showToast(errMsg(e), true));
}
$('btn-add-doctor').addEventListener('click', async () => {
  const name = $('new-doctor-name').value.trim();
  if (!name) { showToast('Enter doctor name', true); return; }
  try {
    await saveDoctors([...(clinic.scheduleDoctors || []), { id: generateId(), name }]);
    $('new-doctor-name').value = '';
    showToast('Doctor added ✅');
  } catch (e) { showToast(errMsg(e), true); }
});
$('new-doctor-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-add-doctor').click(); });

function updateLogoPreview(url) {
  if (url) { $('logo-img').src = url; $('logo-preview').style.display = 'block'; }
  else $('logo-preview').style.display = 'none';
}
$('set-logo-url').addEventListener('input', e => updateLogoPreview(e.target.value.trim()));

$('btn-save-settings').addEventListener('click', async () => {
  const v = {};
  for (const [k, id] of Object.entries(SET_FIELDS)) v[k] = $(id).value.trim();
  if (toMins(v.workEnd) <= toMins(v.workStart)) { showToast('Work end time must be after start time', true); return; }
  v.sessionDur = parseInt(v.sessionDur) || 45;
  v.sessionPrice = num(v.sessionPrice);
  v.initialPrice = num(v.initialPrice);
  v.followupDays = parseInt(v.followupDays) || 10;
  v.currency = v.currency || 'EGP';
  v.waTemplate = $('set-wa-template').value.trim() || CLINIC_DEFAULTS.waTemplate;
  const b = $('btn-save-settings');
  b.disabled = true;
  try {
    await setDoc(doc(DB, 'config', 'clinic'), v, { merge: true });
    showToast('Settings saved ✅');
  } catch (e) { showToast(errMsg(e), true); }
  finally { b.disabled = false; }
});

$('btn-backup').addEventListener('click', async () => {
  const b = $('btn-backup');
  b.disabled = true;
  b.textContent = 'Preparing...';
  try {
    const out = { exportedAt: new Date().toISOString(), exportedBy: me.email };
    for (const name of ['patients', 'appointments', 'expenses', 'users', 'config']) {
      try { out[name] = (await getDocs(collection(DB, name))).docs.map(d => ({ id: d.id, ...d.data() })); }
      catch (e) { out[name] = { error: e.code || e.message }; }
    }
    downloadBlob(`Physiclinic_Backup_${todayStr()}.json`, new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    showToast('Backup downloaded ✅');
  } finally { b.disabled = false; b.textContent = '⬇️ Download Backup (JSON)'; }
});

// ═══════════════════════════════════════════
// DEFAULT OPTIONS
// ═══════════════════════════════════════════
function getDefaultOptions() {
  const S = arr => [...arr];

  const shoulderDx  = ['Rotator Cuff Tear','Rotator Cuff Tendinopathy','Shoulder Impingement','Frozen Shoulder (Adhesive Capsulitis)','Shoulder Dislocation / Instability','AC Joint Sprain','Biceps Tendinopathy','SLAP Tear','Shoulder Bursitis','Post-Surgical Shoulder'];
  const elbowDx     = ['Tennis Elbow (Lateral Epicondylitis)',"Golfer's Elbow (Medial Epicondylitis)",'Elbow Bursitis','Radial Tunnel Syndrome','Cubital Tunnel Syndrome','Elbow Fracture (Post-Surgical)','Elbow Stiffness'];
  const wristDx     = ['Carpal Tunnel Syndrome',"De Quervain's Tenosynovitis",'Trigger Finger','Wrist Sprain','TFCC Tear','Wrist Fracture (Post-Surgical)','Wrist Tendinopathy','Finger Stiffness'];
  const hipDx       = ['Hip Osteoarthritis','Hip Impingement (FAI)','Trochanteric Bursitis','Hip Labral Tear','Hip Flexor Strain','Piriformis Syndrome','Hip Fracture (Post-Surgical)','Gluteal Tendinopathy'];
  const kneeDx      = ['Knee Osteoarthritis','Patellofemoral Pain Syndrome','ACL Tear / Post-Surgical','Meniscal Tear','PCL Injury','MCL / LCL Sprain','Patellar Tendinopathy','IT Band Syndrome','Total Knee Replacement (Post-Surgical)'];
  const ankleDx     = ['Lateral Ankle Sprain','Achilles Tendinopathy','Plantar Fasciitis','Ankle OA','Peroneal Tendinopathy','Ankle Fracture (Post-Surgical)','Metatarsalgia','Hallux Valgus'];

  const shoulderCmp = ['Shoulder pain','Limited ROM','Night pain','Weakness','Clicking / crepitus','Pain on overhead activities','Pain on reaching behind back'];
  const elbowCmp    = ['Lateral elbow pain','Medial elbow pain','Pain on gripping','Pain on wrist extension','Stiffness','Swelling'];
  const wristCmp    = ['Wrist pain','Hand numbness','Thumb pain','Trigger finger locking','Grip weakness','Morning stiffness','Swelling'];
  const hipCmp      = ['Hip pain','Groin pain','Lateral hip pain','Pain on walking','Limited ROM','Pain on stairs','Night pain'];
  const kneeCmp     = ['Knee pain','Swelling','Crepitus','Limited flexion','Pain on stairs','Pain on squatting','Morning stiffness','Locking / giving way'];
  const ankleCmp    = ['Heel pain','Ankle pain','Morning heel pain','Swelling','Pain on walking','Limited dorsiflexion','Weakness','Instability'];

  const shoulderFnd = ['Neer Test +','Hawkins-Kennedy +','Empty Can +','Drop Arm +','Speed Test +','Apprehension Test +','Limited Abduction','Limited Flexion','Limited IR','Limited ER','Rotator cuff weakness','Scapular dyskinesia'];
  const elbowFnd    = ['Pain on resisted wrist extension','Pain on resisted wrist flexion','Limited Pronation','Limited Supination','Cozen Test +',"Mill's Test +",'Tinel at elbow'];
  const wristFnd    = ['Phalen Test +','Tinel Test +','Limited wrist flexion','Limited wrist extension','Grip weakness','Finkelstein Test +'];
  const hipFnd      = ['FABER +','FADIR +','Thomas Test +','Trendelenburg +','Limited IR','Limited ER','Limited Flexion','Gluteal weakness'];
  const kneeFnd     = ['Lachman Test +','Anterior Drawer +','McMurray +','Valgus Stress +','Varus Stress +','Patellar Grind +','Limited Flexion','Quad weakness','VMO atrophy','Joint effusion','Crepitus'];
  const ankleFnd    = ['Anterior Drawer +','Talar Tilt +','Thompson Test +','Limited Dorsiflexion','Calf weakness','Tight Achilles','Plantar tenderness'];

  const shoulderTx  = ['TENS','Ultrasound','Hot Pack','Joint Mobilization','Codman Exercises','Rotator Cuff Strengthening','Scapular Stabilization','Stretching','Manual Therapy','Kinesio Taping','Pulley Exercises','Home Exercise Program'];
  const elbowTx     = ['TENS','Ultrasound','Friction Massage','Stretching','Eccentric Strengthening','Bracing','Ice','Kinesio Taping'];
  const wristTx     = ['TENS','Ultrasound','Splinting','Strengthening','Stretching','Mobilization','Nerve Gliding','Tendon Gliding'];
  const hipTx       = ['TENS','Hot Pack','Hip Strengthening','Stretching','Manual Therapy','Gait Training','Mobilization','Core Stabilization','Home Exercise Program'];
  const kneeTx      = ['TENS','Ultrasound','Hot Pack','Quad Strengthening','VMO Exercises','Hamstring Stretching','Patellar Taping','Mobilization','Kinesio Taping','Balance Training','Gait Training','Home Exercise Program'];
  const ankleTx     = ['TENS','Ultrasound','Ice','Calf Strengthening','Stretching','Balance Training','Taping','Orthotics Advice','Manual Therapy','Proprioception Training'];

  return {
    regions: [
      'Cervical Spine','Thoracic Spine','Lumbar Spine',
      'Shoulder R','Shoulder L',
      'Elbow R','Elbow L',
      'Wrist & Hand R','Wrist & Hand L',
      'Hip R','Hip L',
      'Knee R','Knee L',
      'Ankle & Foot R','Ankle & Foot L',
      'TMJ R','TMJ L',
      'Sacroiliac Joint R','Sacroiliac Joint L'
    ],
    diagnoses: {
      'Cervical Spine':    ['Cervical Disc Herniation','Cervical Spondylosis','Cervical Radiculopathy','Cervical Myelopathy','Neck Strain / Whiplash','Cervicogenic Headache','Cervical Facet Syndrome','Torticollis','Cervical Stenosis','Thoracic Outlet Syndrome'],
      'Thoracic Spine':   ['Thoracic Disc Herniation','Thoracic Spondylosis',"Scheuermann's Disease",'Costochondritis','Thoracic Facet Syndrome'],
      'Lumbar Spine':     ['Lumbar Disc Herniation','Lumbar Spondylosis','Lumbar Radiculopathy (Sciatica)','Spinal Stenosis','Spondylolisthesis','Spondylolysis','Lumbar Strain','Piriformis Syndrome','SI Joint Dysfunction','Facet Syndrome','Post-Surgical Lumbar'],
      'Shoulder R': S(shoulderDx), 'Shoulder L': S(shoulderDx),
      'Elbow R':    S(elbowDx),    'Elbow L':    S(elbowDx),
      'Wrist & Hand R': S(wristDx), 'Wrist & Hand L': S(wristDx),
      'Hip R':      S(hipDx),      'Hip L':      S(hipDx),
      'Knee R':     S(kneeDx),     'Knee L':     S(kneeDx),
      'Ankle & Foot R': S(ankleDx), 'Ankle & Foot L': S(ankleDx),
      'TMJ R': ['TMJ Dysfunction','TMJ Disc Displacement','Bruxism-Related TMJ','Myofascial TMJ Pain'], 'TMJ L': ['TMJ Dysfunction','TMJ Disc Displacement','Bruxism-Related TMJ','Myofascial TMJ Pain'],
      'Sacroiliac Joint R': ['SI Joint Dysfunction','Sacroiliitis','Ankylosing Spondylitis','Pelvic Girdle Pain','Post-Partum SI Pain'], 'Sacroiliac Joint L': ['SI Joint Dysfunction','Sacroiliitis','Ankylosing Spondylitis','Pelvic Girdle Pain','Post-Partum SI Pain'],
    },
    complaints: {
      'Cervical Spine':    ['Neck pain','Morning stiffness','Cervicogenic headache','Radiating arm pain','Finger numbness / tingling','Dizziness','Interscapular pain','Limited ROM','Pain on rotation','Pain on extension'],
      'Thoracic Spine':   ['Mid-back pain','Thoracic stiffness','Pain on breathing','Postural kyphosis','Pain with prolonged sitting'],
      'Lumbar Spine':     ['Low back pain','Radiating leg pain (Sciatica)','Morning stiffness','Leg weakness','Foot numbness / tingling','Pain on standing','Pain on prolonged sitting','Pain on bending forward','Pain on extension','Night pain'],
      'Shoulder R': S(shoulderCmp), 'Shoulder L': S(shoulderCmp),
      'Elbow R':    S(elbowCmp),    'Elbow L':    S(elbowCmp),
      'Wrist & Hand R': S(wristCmp), 'Wrist & Hand L': S(wristCmp),
      'Hip R':      S(hipCmp),      'Hip L':      S(hipCmp),
      'Knee R':     S(kneeCmp),     'Knee L':     S(kneeCmp),
      'Ankle & Foot R': S(ankleCmp), 'Ankle & Foot L': S(ankleCmp),
      'TMJ R': ['Jaw pain','Clicking on opening','Limited mouth opening','Difficulty chewing','Facial headache'], 'TMJ L': ['Jaw pain','Clicking on opening','Limited mouth opening','Difficulty chewing','Facial headache'],
      'Sacroiliac Joint R': ['Sacral pain','Pain radiating to buttock','Pain on prolonged standing','Pain on transitional movements','Pelvic asymmetry'], 'Sacroiliac Joint L': ['Sacral pain','Pain radiating to buttock','Pain on prolonged standing','Pain on transitional movements','Pelvic asymmetry'],
    },
    findings: {
      'Cervical Spine':    ['Limited Flexion','Limited Extension','Limited Rotation R','Limited Rotation L','Limited Lat. Flexion R','Limited Lat. Flexion L','Spurling Test +','Distraction Test +','Muscle weakness','Forward Head Posture','Upper Crossed Syndrome','Trigger points'],
      'Thoracic Spine':   ['Kyphosis','Limited thoracic rotation','Weak thoracic extensors','Hypomobility T-spine','Rib restriction'],
      'Lumbar Spine':     ['SLR +','Slump Test +','Limited Flexion','Limited Extension','Limited Lat. Flexion','Quad weakness','Hamstring tightness','Tight Hip Flexors','Pelvic Tilt','Reduced Lumbar Lordosis','Muscle spasm','Neurological deficits'],
      'Shoulder R': S(shoulderFnd), 'Shoulder L': S(shoulderFnd),
      'Elbow R':    S(elbowFnd),    'Elbow L':    S(elbowFnd),
      'Wrist & Hand R': S(wristFnd), 'Wrist & Hand L': S(wristFnd),
      'Hip R':      S(hipFnd),      'Hip L':      S(hipFnd),
      'Knee R':     S(kneeFnd),     'Knee L':     S(kneeFnd),
      'Ankle & Foot R': S(ankleFnd), 'Ankle & Foot L': S(ankleFnd),
      'TMJ R': ['Limited mouth opening','Jaw deviation','TMJ Clicking','Joint tenderness','Masticatory muscle tightness'], 'TMJ L': ['Limited mouth opening','Jaw deviation','TMJ Clicking','Joint tenderness','Masticatory muscle tightness'],
      'Sacroiliac Joint R': ['FABER +','Gaenslen Test +','Compression Test +','Distraction Test +','SI joint tenderness','Pelvic asymmetry'], 'Sacroiliac Joint L': ['FABER +','Gaenslen Test +','Compression Test +','Distraction Test +','SI joint tenderness','Pelvic asymmetry'],
    },
    treatment: {
      'Cervical Spine':    ['TENS','Ultrasound','Hot Pack','Cervical Traction','Manual Therapy','Mobilization','Strengthening','Stretching','Postural Correction','Dry Needling','Kinesio Taping','DNF Strengthening','Home Exercise Program'],
      'Thoracic Spine':   ['Hot Pack','Thoracic Mobilization','Manual Therapy','Strengthening','Stretching','Postural Correction','TENS','Breathing Exercises'],
      'Lumbar Spine':     ['TENS','Ultrasound','Hot Pack','Lumbar Traction','Manual Therapy','McKenzie Exercises','Core Stabilization','Stretching','Mobilization','Dry Needling','SWD','Kinesio Taping','Neural Mobilization','Home Exercise Program'],
      'Shoulder R': S(shoulderTx),  'Shoulder L': S(shoulderTx),
      'Elbow R':    S(elbowTx),     'Elbow L':    S(elbowTx),
      'Wrist & Hand R': S(wristTx), 'Wrist & Hand L': S(wristTx),
      'Hip R':      S(hipTx),       'Hip L':      S(hipTx),
      'Knee R':     S(kneeTx),      'Knee L':     S(kneeTx),
      'Ankle & Foot R': S(ankleTx), 'Ankle & Foot L': S(ankleTx),
      'TMJ R': ['TENS','Ultrasound','Manual Therapy','TMJ Mobilization','Jaw Stretching','Postural Correction','Patient Education'], 'TMJ L': ['TENS','Ultrasound','Manual Therapy','TMJ Mobilization','Jaw Stretching','Postural Correction','Patient Education'],
      'Sacroiliac Joint R': ['TENS','Manual Therapy','SI Belt','Stabilization Exercises','Stretching','Hot Pack','Pelvic Floor Exercises'], 'Sacroiliac Joint L': ['TENS','Manual Therapy','SI Belt','Stabilization Exercises','Stretching','Hot Pack','Pelvic Floor Exercises'],
    },
    problems: ['Pain','Stiffness','Limited ROM','Muscle weakness','Balance deficit','Gait impairment','Swelling / Oedema','Numbness / Tingling','Functional limitation','Postural dysfunction','Nerve Entrapment','Muscle Imbalance','Reduced proprioception','Decreased endurance'],
    measures: ['VAS (0-10)','NPRS (0-10)','ODI (%)','NDI (%)','DASH','QuickDASH','SPADI (%)','LEFS (/80)','KOOS','WOMAC','Lysholm','AOFAS','FAAM','PSFS','Berg Balance (/56)','TUG (sec)','6MWT (m)','Grip strength (kg)','Roland-Morris (/24)','Pain-free ROM'],
    exercises: ['Chin tucks','Neck isometrics','Upper trapezius stretch','Levator scapulae stretch','Scapular retraction','Wall angels','Pendulum (Codman)','Wand flexion','Wand external rotation','Sleeper stretch','Cross-body stretch','Theraband external rotation','Theraband internal rotation','Theraband rows','Wall push-ups','Wrist flexor stretch','Wrist extensor stretch','Eccentric wrist extension','Tendon gliding','Nerve gliding (median)','Grip squeeze ball','Cat-camel','Pelvic tilt','Knee to chest','Bridging','Bird dog','Dead bug','Prone press-up (McKenzie)','Side plank','Plank','Clamshells','Side-lying hip abduction','Hip flexor stretch','Piriformis stretch','Hamstring stretch','Quad sets','Straight leg raise','Heel slides','Short arc quads','Terminal knee extension','Mini squats','Wall sit','Step-ups','Lunges','Calf raises','Calf stretch (gastrocnemius)','Soleus stretch','Ankle pumps','Ankle alphabet','Towel scrunches','Single-leg balance','Plantar fascia stretch','Seated marching','Diaphragmatic breathing'],
  };
}
