/* Family Finance — app (works offline, syncs to your Google Sheet) */
'use strict';

const APP_VERSION = '1.3.1';
const IS_GAS = !!(window.google && google.script && google.script.run);
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));
const COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2'];

/* ───────────── Storage ───────────── */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('fm_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fm_' + k, JSON.stringify(v)); } catch (e) { toast('Could not save on this device (storage full or blocked)'); } },
  del(k) { try { localStorage.removeItem('fm_' + k); } catch (e) {} }
};
const emptyDb = () => ({ settings: {}, users: [], accounts: [], categories: [], budgets: [], txs: {}, audit: [], seq: 0, lastSync: 0 });
let cfg = LS.get('cfg', {});            // api, deviceId, deviceKey
let db = LS.get('db', emptyDb());
let queue = LS.get('queue', []);        // [{rec}]
let rejected = LS.get('rejected', []);  // [{rec, error}]
let me = LS.get('me', null);            // {userId}
const saveAll = () => { LS.set('db', db); LS.set('queue', queue); LS.set('rejected', rejected); };

const qs = new URLSearchParams(location.search);
if (qs.get('api') && !cfg.api) { cfg.api = qs.get('api'); LS.set('cfg', cfg); }

/* ───────────── UI state ───────────── */
const ui = {
  view: 'home', loginUser: null, newPerson: false,
  hist: { month: thisMonth(), who: '', type: '', acc: '', cat: '', q: '' },
  budMonth: thisMonth(),
  rep: { mode: 'month', month: thisMonth(), year: thisMonth().slice(0, 4) },
  sub: null // sub-page under More
};
let net = { syncing: false, online: navigator.onLine, lastError: '' };

/* ───────────── Dates & money ───────────── */
function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function thisMonth() { return today().slice(0, 7); }
function addMonth(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + pad(m); }
function daysIn(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function monthName(ym, short) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, short ? { month: 'short' } : { month: 'long', year: 'numeric' }); }
function dayLabel(ds) {
  if (ds === today()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (ds === y.getFullYear() + '-' + pad(y.getMonth() + 1) + '-' + pad(y.getDate())) return 'Yesterday';
  const [Y, M, D] = ds.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'; if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString();
}
const SYM = { USD: 'US$', LRD: 'L$', SEK: 'kr', EUR: '€', GBP: '£', GHS: 'GH₵', NGN: '₦' };
function fmt(n, cur, opts) {
  n = Number(n) || 0;
  const dec = opts && opts.round ? 0 : (Math.abs(n) >= 100000 ? 0 : 2);
  const s = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const sym = SYM[cur] || cur;
  return (n < 0 ? '−' : '') + (cur === 'SEK' ? s + ' ' + sym : sym + ' ' + s);
}
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[, ]/g, '')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
/* Amount field accepts simple sums: 1200+350-50 */
function calc(str) {
  const parts = String(str == null ? '' : str).replace(/[, ]/g, '').replace(/−/g, '-').match(/[+-]?[^+-]+/g) || [];
  return r2(parts.reduce((t, p) => t + (parseFloat(p) || 0), 0));
}
const isExpr = v => /\d[+\-−]\d/.test(String(v || ''));

/* ───────────── Data helpers ───────────── */
const base = () => db.settings.BaseCurrency || 'USD';
const currencies = () => String(db.settings.Currencies || 'USD').split(',').map(s => s.trim()).filter(Boolean);
const rateOf = cur => cur === base() ? 1 : num(db.settings['Rate_' + cur]);
const user = id => db.users.find(u => u.UserID === id) || { Name: '?', Color: '#888', UserID: id };
const acc = id => db.accounts.find(a => a.AccountID === id);
const cat = name => db.categories.find(c => c.Name === name);
const isTrue = v => v === true || String(v).toUpperCase() === 'TRUE';
const activeAccounts = () => db.accounts.filter(a => !(a.Active === false || String(a.Active).toUpperCase() === 'FALSE'));
const activeCats = type => db.categories.filter(c => c.Type === type && !(c.Active === false || String(c.Active).toUpperCase() === 'FALSE'));
const allTx = () => Object.values(db.txs).filter(t => !isTrue(t.Deleted));
const pendingIds = () => new Set(queue.map(q => q.rec.tx ? q.rec.tx.TxID : q.rec.txId).filter(Boolean));
function whoDot(id, lg) { const u = user(id); return `<span class="who${lg ? ' lg' : ''}" style="background:${esc(u.Color || '#888')}" title="${esc(u.Name)}">${esc((u.Name || '?')[0].toUpperCase())}</span>`; }

const ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>'
};
function walletLabel(a) { return a.Name.toUpperCase().includes(a.Currency) ? a.Name : a.Name + ' (' + a.Currency + ')'; }
const HUES = [28, 205, 145, 340, 265, 48, 180, 5, 225, 95, 300, 160, 15, 245, 120, 320];
function hueOf(name) {
  const i = db.categories.findIndex(c => c.Name === name);
  if (i >= 0) return HUES[i % HUES.length];
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h;
}
function tint(name) { return `style="--h:${hueOf(name)}"`; }
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

/* ───────────── Appearance (each person picks a colour) ───────────── */
const THEMES = [['Emerald', '#059669'], ['Ocean', '#2563eb'], ['Violet', '#7c3aed'], ['Rose', '#e11d48'], ['Sunset', '#ea580c'], ['Lagoon', '#0891b2'], ['Gold', '#b7791f'], ['Graphite', '#334155']];
const themeKey = () => 'theme_' + (me ? me.userId : 'device');
function getTheme() { return LS.get(themeKey(), null) || LS.get('theme_last', { color: THEMES[0][1], mode: 'auto' }); }
function setTheme(t) { LS.set(themeKey(), t); LS.set('theme_last', t); applyTheme(); }
function luminance(hex) { const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
const darkMQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
function applyTheme() {
  const t = getTheme(), root = document.documentElement;
  const color = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : THEMES[0][1];
  const dark = t.mode === 'dark' || (t.mode !== 'light' && darkMQ.matches);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.style.setProperty('--a', color);
  root.style.setProperty('--a-on', luminance(color) > .45 ? '#101223' : '#ffffff');
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#0c0d14' : '#ffffff';
}
if (darkMQ.addEventListener) darkMQ.addEventListener('change', applyTheme);

const catColor = name => `hsl(${hueOf(name)} 68% var(--seg-l))`;
/* Ring chart: segs = [{v, color}] */
function ring(segs, center, size) {
  const R = 52, C = 2 * Math.PI * R, total = segs.reduce((t, x) => t + x.v, 0);
  let off = 0; const gap = segs.length > 1 ? 2.2 : 0;
  const parts = total ? segs.filter(x => x.v > 0).map(x => {
    const len = Math.max(0, x.v / total * C - gap);
    const el = `<circle class="seg" cx="60" cy="60" r="${R}" fill="none" stroke-width="13" stroke-linecap="butt" style="stroke:${x.color}" stroke-dasharray="0 ${C}" stroke-dashoffset="${-off}" data-d="${len} ${C - len}"/>`;
    off += x.v / total * C; return el;
  }).join('') : '';
  return `<div class="ring"${size ? ` style="width:${size}px;height:${size}px"` : ''}><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="${R}" fill="none" stroke-width="13"/>${parts}</svg><div class="c"><div>${center}</div></div></div>`;
}
function animateRings() {
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('circle.seg[data-d]').forEach(c => c.setAttribute('stroke-dasharray', c.dataset.d))));
}
function catSegments(byCat, max) {
  const names = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const top = names.slice(0, max || 5).map(n => ({ n, v: byCat[n], color: catColor(n) }));
  const rest = names.slice(max || 5).reduce((t, n) => t + byCat[n], 0);
  if (rest > 0) top.push({ n: 'Other', v: rest, color: 'var(--ink-3)' });
  return top;
}
let countedUp = false;
function countUp() {
  const el = document.querySelector('.month .big[data-v]'); if (!el || countedUp) return; countedUp = true;
  if (matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const v = +el.dataset.v, cur = el.dataset.c, t0 = performance.now();
  const step = now => { const p = Math.min(1, (now - t0) / 800), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(v * e, cur); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function balances() {
  const b = {};
  db.accounts.forEach(a => { b[a.AccountID] = num(a.OpeningBalance); });
  allTx().forEach(t => {
    if (t.Type === 'EXPENSE') b[t.AccountID] = (b[t.AccountID] || 0) - num(t.Amount);
    else if (t.Type === 'INCOME') b[t.AccountID] = (b[t.AccountID] || 0) + num(t.Amount);
    else if (t.Type === 'TRANSFER') { b[t.AccountID] = (b[t.AccountID] || 0) - num(t.Amount); b[t.ToAccountID] = (b[t.ToAccountID] || 0) + num(t.ToAmount); }
  });
  return b;
}

function budgetFor(catName, ym) {
  const o = db.budgets.find(x => x.Month === ym && x.Category === catName);
  if (o && o.Amount !== '' && o.Amount != null) return { amount: num(o.Amount), custom: true };
  const c = cat(catName); return { amount: c ? num(c.MonthlyBudget) : 0, custom: false };
}

function inRange(t, from, to) { return t.Date >= from && t.Date <= to; }
function monthRange(ym) { return [ym + '-01', ym + '-' + pad(daysIn(ym))]; }

function summarize(from, to) {
  const s = { exp: 0, inc: 0, byCat: {}, byIncCat: {}, byUser: {}, byCur: {}, byCurInc: {}, list: [], days: {} };
  allTx().forEach(t => {
    if (!inRange(t, from, to) || t.Type === 'TRANSFER') return;
    const b = num(t.AmountBase);
    if (t.Type === 'EXPENSE') {
      s.exp += b; s.byCat[t.Category] = (s.byCat[t.Category] || 0) + b;
      s.byCur[t.Currency] = (s.byCur[t.Currency] || 0) + num(t.Amount);
      s.days[t.Date] = (s.days[t.Date] || 0) + b; s.list.push(t);
    } else {
      s.inc += b; s.byIncCat[t.Category] = (s.byIncCat[t.Category] || 0) + b;
      s.byCurInc[t.Currency] = (s.byCurInc[t.Currency] || 0) + num(t.Amount);
    }
    const u = s.byUser[t.EnteredBy] || (s.byUser[t.EnteredBy] = { exp: 0, inc: 0, n: 0 });
    u[t.Type === 'EXPENSE' ? 'exp' : 'inc'] += b; u.n++;
  });
  return s;
}

/* ───────────── Server calls ───────────── */
function call(body) {
  if (IS_GAS) {
    return new Promise((res, rej) => google.script.run.withSuccessHandler(s => { try { res(JSON.parse(s)); } catch (e) { rej(e); } })
      .withFailureHandler(e => rej(new Error((e && e.message) || 'Network error'))).api(JSON.stringify(body)));
  }
  if (!cfg.api) return Promise.reject(new Error('No server address'));
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 45000);
  return fetch(cfg.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow' })
    .then(r => r.text()).then(t => parseServer(t)).finally(() => clearTimeout(tm));
}
/* Explain clearly when the server answers with a web page instead of data */
function parseServer(text) {
  try { return JSON.parse(text); } catch (e) {}
  const t = String(text).toLowerCase();
  let msg;
  if (t.includes('script function not found') || t.includes('dopost')) msg = 'The web app was deployed before the code was added. In Apps Script: Deploy ▸ Manage deployments ▸ ✏ Edit ▸ Version: New version ▸ Deploy.';
  else if (t.includes('accounts.google') || t.includes('sign in') || t.includes('signin') || t.includes('servicelogin')) msg = 'Google asked for a sign-in. In Apps Script: Deploy ▸ Manage deployments ▸ ✏ Edit, set "Who has access" to Anyone, then Deploy.';
  else if (t.includes('page not found') || t.includes('404')) msg = 'That server address was not found. Copy the Web app URL again (Deploy ▸ Manage deployments) — it ends in /exec.';
  else msg = 'The server address is not your Apps Script web app. It must look like https://script.google.com/macros/s/…/exec';
  const err = new Error(msg); err.code = 'NOT_JSON'; throw err;
}
function checkApiUrl(u) {
  u = String(u || '').trim();
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) return ''; // local testing
  if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec\/?$/.test(u.split('?')[0])) {
    if (/\/dev\/?$/.test(u)) return 'This is the test (/dev) link. Use the Web app URL that ends in /exec.';
    if (/script\.google\.com\/.*\/edit/.test(u)) return 'This is the editor link. Use the Web app URL from Deploy ▸ Manage deployments (it ends in /exec).';
    if (/github\.io/.test(u)) return 'This is the GitHub address of the app. Here you need the Apps Script Web app URL (it ends in /exec).';
    return 'The server address must look like https://script.google.com/macros/s/…/exec';
  }
  return '';
}
const authBody = () => ({ deviceId: cfg.deviceId, deviceKey: cfg.deviceKey, userId: me && me.userId });

/* ───────────── Local apply (optimistic) ───────────── */
function applyLocal(rec) {
  if (rec.kind === 'tx') {
    const t = rec.tx, a = acc(t.AccountID), ex = db.txs[t.TxID];
    const cur = a ? a.Currency : t.Currency;
    const rate = cur === base() ? 1 : (num(t.Rate) || rateOf(cur));
    const o = Object.assign({}, ex || {}, t, {
      Currency: cur, Rate: rate, AmountBase: r2(num(t.Amount) / (rate || 1)), UpdatedBy: rec.userId,
      EnteredBy: ex ? ex.EnteredBy : rec.userId, EnteredAt: ex ? ex.EnteredAt : t.UpdatedAt, Deleted: false
    });
    if (t.Type === 'TRANSFER') { const to = acc(t.ToAccountID); o.ToCurrency = to ? to.Currency : ''; o.Category = 'Transfer'; if (to && to.Currency === cur) o.ToAmount = t.Amount; }
    else { o.ToAccountID = ''; o.ToAmount = ''; o.ToCurrency = ''; }
    db.txs[t.TxID] = o;
  } else if (rec.kind === 'txDelete') {
    delete db.txs[rec.txId];
  } else if (rec.kind === 'txRestore') {
    if (rec.snapshot) db.txs[rec.txId] = Object.assign({}, rec.snapshot, { Deleted: false });
  } else if (rec.kind === 'account') {
    const i = db.accounts.findIndex(a => a.AccountID === rec.account.AccountID);
    if (i >= 0) db.accounts[i] = Object.assign({}, db.accounts[i], rec.account, { Currency: db.accounts[i].Currency }); else db.accounts.push(Object.assign({ Active: true }, rec.account));
  } else if (rec.kind === 'category') {
    const i = db.categories.findIndex(c => c.Name === rec.category.Name);
    if (i >= 0) db.categories[i] = Object.assign({}, db.categories[i], rec.category, { Type: db.categories[i].Type }); else db.categories.push(Object.assign({ Active: true }, rec.category));
  } else if (rec.kind === 'budget') {
    const i = db.budgets.findIndex(x => x.Month === rec.month && x.Category === rec.category);
    const o = { Month: rec.month, Category: rec.category, Amount: rec.amount == null ? '' : rec.amount, SetBy: rec.userId };
    if (i >= 0) db.budgets[i] = o; else db.budgets.push(o);
  } else if (rec.kind === 'rate') {
    db.settings['Rate_' + rec.currency] = String(rec.rate);
    if (!currencies().includes(rec.currency)) db.settings.Currencies = currencies().concat(rec.currency).join(',');
  }
}

function enqueue(rec) {
  rec.rid = uid(); rec.userId = me.userId;
  applyLocal(rec); queue.push({ rec, at: new Date().toISOString() }); saveAll();
  scheduleSync(1500);
}

/* ───────────── Sync ───────────── */
let syncTimer = null;
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }

async function sync(manual) {
  if (net.syncing || !cfg.deviceId) return;
  net.syncing = true; paintBadge();
  let full = false;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 100);
      const r = await call(Object.assign({ action: 'push', records: batch.map(q => q.rec) }, authBody()));
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.error });
      const done = new Set(r.accepted.concat(r.duplicates));
      const rej = {}; r.rejected.forEach(x => { rej[x.rid] = x; });
      batch.forEach(q => { if (rej[q.rec.rid]) { rejected.push({ rec: q.rec, at: q.at, error: rej[q.rec.rid] }); full = true; } });
      queue = queue.filter(q => !done.has(q.rec.rid) && !rej[q.rec.rid]);
      saveAll();
      if (r.rejected.length) toast(r.rejected.length + ' change(s) could not be saved — see Sync');
    }
    await pull(full || !db.seq);
    net.online = true; net.lastError = ''; db.lastSync = Date.now(); saveAll();
    if (manual) toast('Synced ✓');
  } catch (e) {
    net.online = false; net.lastError = e.message || String(e);
    if (e.code === 'BAD_DEVICE' || e.code === 'DEVICE_BLOCKED') { net.lastError = e.message; toast(e.message); }
    else if (manual) toast('Could not sync: ' + net.lastError);
  } finally {
    net.syncing = false; paintBadge(); softRender();
  }
}

async function pull(full) {
  const since = full ? 0 : db.seq;
  const r = await call(Object.assign({ action: 'pull', since, auditSince: since }, authBody()));
  if (!r.ok) throw Object.assign(new Error(r.message), { code: r.error });
  db.settings = r.settings; db.users = r.users; db.accounts = r.accounts; db.categories = r.categories; db.budgets = r.budgets;
  if (full) { db.txs = {}; db.audit = []; }
  r.transactions.forEach(t => { if (isTrue(t.Deleted)) delete db.txs[t.TxID]; else db.txs[t.TxID] = t; });
  const seen = new Set(db.audit.map(a => a.Seq));
  db.audit = db.audit.concat(r.audit.filter(a => !seen.has(a.Seq))).sort((a, b) => a.Seq - b.Seq).slice(-1500);
  db.seq = r.seq;
  queue.forEach(q => applyLocal(q.rec)); // re-apply anything still waiting
  if (me && !db.users.some(u => u.UserID === me.userId && u.Active !== false)) { me = null; LS.del('me'); }
}

/* ───────────── PIN ───────────── */
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pinHash(salt, pin) { let h = String(pin); for (let i = 0; i < 100; i++) h = await sha256hex(salt + ':' + h); return h; }

/* ───────────── Toast / modal ───────────── */
let toastTm;
function toast(msg, opt) {
  opt = opt || {}; const t = $('#toast');
  t.innerHTML = (opt.icon ? `<span class="ti">${esc(opt.icon)}</span>` : '') + `<span class="grow">${esc(msg)}</span>` + (opt.undo ? '<button data-act="toastUndo">Undo</button>' : '');
  toast._undo = opt.undo || null; t.classList.remove('hidden'); clearTimeout(toastTm);
  toastTm = setTimeout(() => { t.classList.add('hidden'); toast._undo = null; }, opt.undo ? 5000 : 2600);
}
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`; m.classList.remove('hidden'); const f = m.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 60); }
function closeModal() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; }
function confirmBox(title, text, okLabel, danger) {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="btns"><button class="btn ghost" data-act="cfNo">Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-act="cfYes">${esc(okLabel || 'OK')}</button></div>`);
    confirmBox._res = v => { closeModal(); res(v); };
  });
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') { if (confirmBox._res) { const r = confirmBox._res; confirmBox._res = null; r(false); } else closeModal(); } });

/* ───────────── Render root ───────────── */
function render() {
  const app = $('#app');
  if (!cfg.deviceId) { app.innerHTML = connectView(); return; }
  if (!me) { app.innerHTML = loginView(); return; }
  const first = (user(me.userId).Name || '').split(' ')[0];
  const title = ui.view === 'home' ? first : viewTitle();
  const kicker = ui.view === 'home' ? greeting() : (db.settings.HouseholdName || 'Family Finance');
  app.innerHTML = `
    <header class="top"><div class="top-row">
      <button class="me-chip" data-act="switchUser" title="Lock or switch person">${whoDot(me.userId, true)}</button>
      <div class="grow"><div class="hh ellipsis">${esc(kicker)}</div><h1 class="ellipsis">${esc(title)}</h1></div>
      <button class="badge" id="badge" data-act="goSync"></button>
      <button class="icon-btn ${ui.view === 'more' ? 'on' : ''}" data-act="nav" data-v="more" aria-label="More">${ICON.more}</button>
    </div></header>
    <main id="main" class="${render._last !== ui.view + ui.sub ? 'enter' : ''}">${mainView()}</main>
    <button class="fab" data-act="add" aria-label="Add entry">+</button>
    <nav class="bottom">${[['home', 'home', 'Home'], ['history', 'list', 'History'], null, ['budget', 'target', 'Budget'], ['reports', 'chart', 'Insights']]
      .map(x => x ? `<button class="${ui.view === x[0] ? 'on' : ''}" data-act="nav" data-v="${x[0]}">${ICON[x[1]]}${x[2]}</button>` : '<span></span>').join('')}</nav>`;
  render._last = ui.view + ui.sub;
  animateRings(); if (ui.view === 'home') countUp();
  paintBadge();
}
function viewTitle() {
  return { home: 'Overview', history: 'History', budget: 'Budget', reports: 'Insights', more: ui.sub ? subTitle(ui.sub) : 'More' }[ui.view];
}
function mainView() {
  switch (ui.view) {
    case 'history': return historyView();
    case 'budget': return budgetView();
    case 'reports': return reportsView();
    case 'more': return ui.sub ? subView(ui.sub) : moreView();
    default: return homeView();
  }
}
// Re-render after sync without disturbing someone typing
function softRender() {
  if (!$('#modal').classList.contains('hidden')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) { paintBadge(); return; }
  const y = window.scrollY; render(); window.scrollTo(0, y);
}
function paintBadge() {
  const b = $('#badge'); if (!b) return;
  b.className = 'badge'; b.title = '';
  if (net.syncing) { b.textContent = 'Syncing…'; b.classList.add('busy'); }
  else if (rejected.length) { b.textContent = '⚠ ' + rejected.length + ' failed'; b.classList.add('warn'); }
  else if (queue.length) { b.textContent = '↑ ' + queue.length + ' to sync'; if (!net.online) b.classList.add('off'); }
  else if (!net.online) { b.textContent = '● Offline'; b.classList.add('off'); }
  else { b.textContent = '✓'; b.title = 'All changes synced'; b.classList.add('dot'); }
}

/* ───────────── Connect & login ───────────── */
function connectView() {
  return `<div class="auth"><div class="logo">$</div><h1>Family Finance</h1><p class="lead">Connect this phone or laptop to your household.</p>
  <form data-form="connect" class="card">
    ${IS_GAS ? '' : `<label class="f"><span>Server address (your Apps Script web app URL)</span><input class="in" name="api" value="${esc(cfg.api || '')}" placeholder="https://script.google.com/macros/s/…/exec" required></label>`}
    <label class="f"><span>Household code</span><input class="in" name="code" placeholder="ABCD-1234" autocapitalize="characters" autocomplete="off" required></label>
    <label class="f"><span>Name for this device</span><input class="in" name="dev" placeholder="e.g. Ephraim's phone" required></label>
    <div class="err" id="cErr"></div>
    <button class="btn block" style="margin-top:12px">Connect</button>
    <p class="tiny muted" style="margin-top:12px">The household code is in the Google Sheet: menu <b>Family Finance ▸ Show household code</b>.</p>
  </form></div>`;
}

function loginView() {
  const users = db.users.filter(u => u.Active !== false);
  const max = num(db.settings.MaxUsers) || 6;
  if (ui.newPerson || !users.length) {
    const used = users.map(u => u.Color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[0];
    return `<div class="auth"><div class="logo">$</div><h1>${users.length ? 'Join the household' : 'Welcome!'}</h1>
    <p class="lead">${users.length ? 'Create your profile so your entries show your name.' : 'You are the first person. Create your profile.'}</p>
    <form data-form="newPerson" class="card">
      <label class="f"><span>Your name</span><input class="in" name="name" required maxlength="40" autofocus></label>
      <label class="f"><span>Choose a PIN (4–8 digits)</span><input class="in pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>
      <label class="f"><span>Type the PIN again</span><input class="in pin" name="pin2" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>
      <label class="f"><span>Your colour</span><div class="colors">${COLORS.map(c => `<button type="button" class="${c === color ? 'on' : ''}" style="background:${c}" data-act="pickColor" data-c="${c}"></button>`).join('')}</div><input type="hidden" name="color" value="${color}"></label>
      <div class="err" id="nErr"></div>
      <button class="btn block" style="margin-top:12px">Create profile</button>
      ${users.length ? '<button type="button" class="btn ghost block" style="margin-top:8px" data-act="cancelNew">Back</button>' : ''}
      <p class="tiny muted">Needs internet for this step.</p>
    </form></div>`;
  }
  if (ui.loginUser) {
    const u = user(ui.loginUser);
    return `<div class="auth"><div class="center"><span class="who" style="width:56px;height:56px;font-size:24px;background:${esc(u.Color)}">${esc(u.Name[0].toUpperCase())}</span></div>
    <h1 style="margin-top:10px">Hi ${esc(u.Name)}</h1><p class="lead">Enter your PIN</p>
    <form data-form="login" class="card"><input class="in pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus required>
    <div class="err" id="lErr"></div><button class="btn block" style="margin-top:12px">Unlock</button>
    <button type="button" class="btn ghost block" style="margin-top:8px" data-act="loginBack">Not ${esc(u.Name)}?</button></form></div>`;
  }
  return `<div class="auth"><div class="logo">$</div><h1>${esc(db.settings.HouseholdName || 'Family Finance')}</h1><p class="lead">Who is using the app?</p>
  <div class="people">${users.map(u => `<button class="person" data-act="pickUser" data-id="${esc(u.UserID)}"><span class="who" style="background:${esc(u.Color)}">${esc(u.Name[0].toUpperCase())}</span><br>${esc(u.Name)}</button>`).join('')}
  ${users.length < max ? `<button class="person" data-act="newPerson"><span class="who" style="background:var(--ink-3)">+</span><br>I'm new</button>` : ''}</div>
  <p class="center tiny muted" style="margin-top:20px">${net.syncing ? 'Syncing…' : `<button class="link" data-act="syncNow">Refresh list</button>`}</p></div>`;
}

/* ───────────── Home ───────────── */
function homeView() {
  const B = base(), bal = balances(), ym = thisMonth(), [from, to] = monthRange(ym);
  const s = summarize(from, to);
  const accs = activeAccounts();
  let totalBase = 0; accs.forEach(a => { const r = rateOf(a.Currency); if (r) totalBase += (bal[a.AccountID] || 0) / r; });
  const day = Number(today().slice(8)), dim = daysIn(ym);
  const budgetTotal = activeCats('EXPENSE').reduce((t, c) => t + budgetFor(c.Name, ym).amount, 0);
  const proj = day ? s.exp / day * dim : 0;
  const recent = allTx().sort((a, b) => (b.Date + b.EnteredAt).localeCompare(a.Date + a.EnteredAt)).slice(0, 8);
  const rates = currencies().filter(c => c !== B).map(c => `1 ${B} = ${num(db.settings['Rate_' + c]).toLocaleString()} ${c}`).join(', ');
  const bud = activeCats('EXPENSE').map(c => ({ c, b: budgetFor(c.Name, ym).amount, sp: s.byCat[c.Name] || 0 })).filter(x => x.b > 0).sort((a, b) => b.sp / b.b - a.sp / a.b).slice(0, 4);
  const people = db.users.filter(u => u.Active !== false);
  const flow = {}; allTx().forEach(t => { if (!inRange(t, from, to)) return;
    const f1 = flow[t.AccountID] || (flow[t.AccountID] = { i: 0, o: 0 });
    if (t.Type === 'INCOME') f1.i += num(t.Amount); else f1.o += num(t.Amount);
    if (t.Type === 'TRANSFER') { const f2 = flow[t.ToAccountID] || (flow[t.ToAccountID] = { i: 0, o: 0 }); f2.i += num(t.ToAmount); } });
  const QI = { exp: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>', inc: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    trf: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-4-4M20 16H6l4 4"/></svg>', bud: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>' };
  return `
  <section class="month">
    <div class="hero"><div class="copy">
      <div class="label">Spent in ${esc(monthName(ym).split(' ')[0])}</div>
      <div class="big" data-v="${s.exp}" data-c="${esc(B)}">${fmt(s.exp, B)}</div>
      ${budgetTotal ? `<div class="of">${s.exp > budgetTotal ? `<span class="red">${fmt(s.exp - budgetTotal, B)} over budget</span>` : `${fmt(budgetTotal - s.exp, B)} left to spend`}</div>` :
        `<div class="of"><button class="link" data-act="nav" data-v="budget">Set a monthly budget</button></div>`}
    </div>${ring(catSegments(s.byCat), budgetTotal ? `<b>${Math.round(s.exp / budgetTotal * 100)}%</b><span>of budget</span>` : `<b>${Object.keys(s.byCat).length}</b><span>categories</span>`)}</div>
    ${Object.keys(s.byCat).length ? `<div class="legend-list">${catSegments(s.byCat, 4).map(x => `<span><i style="background:${x.color}"></i>${esc(x.n)}</span>`).join('')}</div>` : ''}
    ${budgetTotal ? `<div class="meter" title="Projected: ${fmt(proj, B)}"><s style="width:${Math.min(100, proj / budgetTotal * 100)}%"></s><i class="${s.exp > budgetTotal ? 'over' : ''}" style="width:${Math.min(100, s.exp / budgetTotal * 100)}%"></i></div>
      <div class="tiny muted">At this pace you'll spend about <b class="num" style="color:var(--ink-2)">${fmt(proj, B, { round: true })}</b> by the end of the month, out of ${fmt(budgetTotal, B, { round: true })}</div>` : ''}
    <div class="stats">
      <div><div class="l">Income</div><div class="v green">${fmt(s.inc, B, { round: true })}</div></div>
      <div><div class="l">Left over</div><div class="v ${s.inc - s.exp < 0 ? 'red' : ''}">${fmt(s.inc - s.exp, B, { round: true })}</div></div>
      <div><div class="l">Per day</div><div class="v">${fmt(day ? s.exp / day : 0, B, { round: true })}</div></div>
    </div>
  </section>

  <div class="quick">
    <button class="q-exp" data-act="quick" data-t="EXPENSE"><span class="qi">${QI.exp}</span>Expense</button>
    <button class="q-inc" data-act="quick" data-t="INCOME"><span class="qi">${QI.inc}</span>Income</button>
    <button data-act="quick" data-t="TRANSFER"><span class="qi">${QI.trf}</span>Exchange</button>
    <button data-act="quick" data-t="BUDGET"><span class="qi">${QI.bud}</span>Budget</button>
  </div>
  <section class="card" style="padding-bottom:4px"><h2>Wallets <button class="link" data-act="sub" data-s="rates">Rates</button></h2>
  <div class="wallets">${accs.map(a => { const v = bal[a.AccountID] || 0;
    return `<button class="wallet cur-${esc(a.Currency)}" data-act="histAcc" data-id="${esc(a.AccountID)}"><div class="w-top"><span class="n ellipsis">${esc(a.Name)}</span><span class="code">${esc(a.Currency)}</span></div><div class="b ${v < 0 ? 'neg' : ''}">${fmt(v, a.Currency)}</div>${flow[a.AccountID] ? `<div class="flow"><span class="in">↓ ${fmt(flow[a.AccountID].i, a.Currency, { round: true })}</span><span>↑ ${fmt(flow[a.AccountID].o, a.Currency, { round: true })}</span></div>` : '<div class="flow">No activity this month</div>'}</button>`; }).join('')}
    <button class="wallet add" data-act="sub" data-s="wallets"><span>+</span> Add</button></div>
  <div class="worth"><span class="l">All wallets together</span><span class="v num">≈ ${fmt(totalBase, B)}</span></div>

  </section>

  ${bud.length ? `<section class="card"><h2>Budgets to watch <button class="link" data-act="nav" data-v="budget">All budgets</button></h2>${bud.map(x => budgetRow(x.c, x.sp, x.b, ym)).join('')}</section>` : ''}

  ${people.length > 1 ? `<section class="card"><h2>Who spent this month</h2>${people.map(u => {
    const x = s.byUser[u.UserID] || { exp: 0, inc: 0, n: 0 };
    return `<div class="brow" data-act="histWho" data-id="${esc(u.UserID)}"><div class="row">${whoDot(u.UserID, true)}<div class="grow"><b>${esc(u.Name)}</b><div class="tiny muted">${x.n} entr${x.n === 1 ? 'y' : 'ies'}</div></div><b class="num">${fmt(x.exp, B)}</b></div>
      <div class="bar"><i style="width:${s.exp ? x.exp / s.exp * 100 : 0}%;background:${esc(u.Color)}"></i></div></div>`;
  }).join('')}</section>` : ''}

  <section class="card"><h2>Latest entries <button class="link" data-act="nav" data-v="history">See all</button></h2>
    ${recent.length ? `<div class="list">${recent.map(txItem).join('')}</div>` : `<div class="empty"><span class="e">🧾</span>Nothing recorded yet.<br>Tap <b>+</b> to add your first expense.</div>`}</section>
  <p class="tiny muted center">${esc(rates)} <button class="link tiny" data-act="sub" data-s="rates">Update rate</button></p>`;
}

function txItem(t) {
  const pend = pendingIds().has(t.TxID);
  const a = acc(t.AccountID), c = cat(t.Category);
  let icon = c ? c.Icon : '•', title = t.Category, amt, cls, tn = t.Category;
  if (t.Type === 'TRANSFER') {
    const to = acc(t.ToAccountID); icon = '⇄'; tn = 'transfer'; title = (a ? a.Name : '?') + ' → ' + (to ? to.Name : '?');
    amt = fmt(t.Amount, t.Currency) + (t.ToCurrency && t.ToCurrency !== t.Currency ? `<div class="tiny muted">${fmt(t.ToAmount, t.ToCurrency)}</div>` : ''); cls = 'trf';
  } else { amt = (t.Type === 'EXPENSE' ? '−' : '+') + fmt(t.Amount, t.Currency); cls = t.Type === 'EXPENSE' ? 'exp' : 'inc'; }
  const edited = t.UpdatedBy && t.UpdatedBy !== t.EnteredBy;
  const sub = [t.Note, t.Type !== 'TRANSFER' && a ? a.Name : ''].filter(Boolean).join(', ');
  return `<button class="item" data-act="tx" data-id="${esc(t.TxID)}"><span class="ico tint" ${tint(tn)}>${esc(icon)}</span>
    <div class="grow"><div class="t ellipsis">${esc(title)}</div><div class="s">${whoDot(t.EnteredBy)}<span class="ellipsis">${esc(user(t.EnteredBy).Name)}${edited ? ', edited by ' + esc(user(t.UpdatedBy).Name) : ''}${sub ? ' — ' + esc(sub) : ''}</span></div></div>
    <div class="right"><div class="amt ${cls}">${amt}</div>${pend ? '<div class="pending">waiting to sync</div>' : ''}</div></button>`;
}

/* ───────────── History ───────────── */
function historyView() {
  const f = ui.hist, [from, to] = f.month === 'all' ? ['0000', '9999'] : monthRange(f.month);
  const q = f.q.toLowerCase();
  const rows = allTx().filter(t => inRange(t, from, to) && (!f.who || t.EnteredBy === f.who) && (!f.type || t.Type === f.type) &&
    (!f.acc || t.AccountID === f.acc || t.ToAccountID === f.acc) && (!f.cat || t.Category === f.cat) &&
    (!q || (t.Note + ' ' + t.Category + ' ' + t.Amount + ' ' + user(t.EnteredBy).Name).toLowerCase().includes(q)))
    .sort((a, b) => (b.Date + b.EnteredAt).localeCompare(a.Date + a.EnteredAt));
  const B = base(); let exp = 0, inc = 0; rows.forEach(t => { if (t.Type === 'EXPENSE') exp += num(t.AmountBase); if (t.Type === 'INCOME') inc += num(t.AmountBase); });
  const groups = {}; rows.forEach(t => (groups[t.Date] = groups[t.Date] || []).push(t));
  const chip = (k, v, l) => `<button class="chip ${f[k] === v ? 'on' : ''}" data-act="hf" data-k="${k}" data-v="${esc(v)}">${l}</button>`;
  return `
  ${f.month === 'all' ? `<div class="monthnav"><span></span><span class="ml">All time</span><button data-act="hm" data-n="0" title="Back to this month">📅</button></div>` :
    `<div class="monthnav"><button data-act="hm" data-n="-1">‹</button><span class="ml">${esc(monthName(f.month))}</span><button data-act="hm" data-n="1">›</button></div>`}
  <input class="in search" placeholder="🔍 Search notes, categories, amounts…" data-input="hq" value="${esc(f.q)}">
  <div class="chips">${chip('who', '', 'Everyone')}${db.users.filter(u => u.Active !== false).map(u => chip('who', u.UserID, esc(u.Name))).join('')}
    <span style="width:8px"></span>${chip('type', '', 'All types')}${chip('type', 'EXPENSE', 'Expenses')}${chip('type', 'INCOME', 'Income')}${chip('type', 'TRANSFER', 'Transfers')}</div>
  <div class="chips" style="margin-top:6px">${chip('acc', '', 'All wallets')}${db.accounts.map(a => chip('acc', a.AccountID, esc(a.Name))).join('')}</div>
  ${f.cat ? `<div class="chips" style="margin-top:6px"><button class="chip on" data-act="hf" data-k="cat" data-v="">${esc(f.cat)} ✕</button></div>` : ''}
  <div class="hist-sum"><div><div class="l">Spent</div><div class="v num">${fmt(exp, B)}</div></div><div><div class="l">Income</div><div class="v num green">${fmt(inc, B)}</div></div></div>
  <div class="row between tiny muted" style="padding:8px 4px 0"><span>${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</span>${f.month === 'all' ? '' : '<button class="link tiny" data-act="hAll">Show all time</button>'}</div>
  ${rows.length ? Object.keys(groups).map(d => {
    const dayExp = groups[d].filter(t => t.Type === 'EXPENSE').reduce((s, t) => s + num(t.AmountBase), 0);
    return `<div class="day"><span>${esc(dayLabel(d))}</span><span>${dayExp ? '−' + fmt(dayExp, B) : ''}</span></div><div class="card" style="padding:8px 14px"><div class="list">${groups[d].map(txItem).join('')}</div></div>`;
  }).join('') : `<div class="empty"><span class="e">🔎</span>No entries match.</div>`}`;
}

/* ───────────── Budget ───────────── */
function budgetRow(c, spent, budget, ym) {
  const isCur = ym === thisMonth(), day = Number(today().slice(8)), dim = daysIn(ym);
  const pct = budget ? spent / budget * 100 : 0;
  const proj = isCur && day ? spent / day * dim : spent;
  const cls = pct > 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const B = base();
  let note = '';
  if (budget) {
    if (spent > budget) note = `<span class="red">${fmt(spent - budget, B)} over</span>`;
    else if (isCur && proj > budget * 1.02) note = `<span class="amber">heading for ${fmt(proj, B, { round: true })}</span>`;
    else note = `<span class="muted">${fmt(budget - spent, B)} left</span>`;
  }
  return `<div class="brow" data-act="editBudget" data-c="${esc(c.Name)}"><div class="row between"><span class="ellipsis row" style="gap:8px"><span class="mini tint" ${tint(c.Name)}>${esc(c.Icon)}</span>${esc(c.Name)}${budgetFor(c.Name, ym).custom ? ' <span class="tiny muted">(this month)</span>' : ''}</span>
    <span class="small num"><b>${fmt(spent, B)}</b>${budget ? ` <span class="muted">/ ${fmt(budget, B, { round: true })}</span>` : ''}</span></div>
    ${budget ? `<div class="bar">${isCur && proj > spent ? `<span class="proj" style="width:${Math.min(100, proj / budget * 100)}%"></span>` : ''}<i class="${cls}" style="width:${Math.min(100, pct)}%;position:relative"></i></div><div class="tiny" style="margin-top:3px">${note}</div>` : ''}</div>`;
}

function budgetCard(c, spent, budget, ym) {
  const B = base(), pct = spent / budget * 100, isCur = ym === thisMonth(), day = Number(today().slice(8)), proj = isCur && day ? spent / day * daysIn(ym) : spent;
  const color = pct > 100 ? 'var(--red)' : pct >= 80 || proj > budget * 1.02 ? 'var(--amber)' : catColor(c.Name);
  const st = spent > budget ? `<span class="red">${fmt(spent - budget, B, { round: true })} over</span>` : isCur && proj > budget * 1.02 ? `<span class="amber">Heading over</span>` : `<span class="green">${fmt(budget - spent, B, { round: true })} left</span>`;
  return `<button class="bcard ${spent > budget ? 'over' : ''}" data-act="editBudget" data-c="${esc(c.Name)}">
    <div class="top-line"><span class="mini tint" ${tint(c.Name)}>${esc(c.Icon)}</span>${ring([{ v: Math.min(spent, budget), color }, { v: Math.max(0, budget - spent), color: 'transparent' }], `<b>${Math.round(pct)}%</b>`, 50)}</div>
    <div class="nm">${esc(c.Name)}</div><div class="am"><b>${fmt(spent, B, { round: true })}</b> of ${fmt(budget, B, { round: true })}</div><div class="st">${st}</div></button>`;
}
function budgetView() {
  const ym = ui.budMonth, B = base(), [from, to] = monthRange(ym), s = summarize(from, to);
  const cats = activeCats('EXPENSE');
  const withB = cats.map(c => ({ c, b: budgetFor(c.Name, ym).amount, sp: s.byCat[c.Name] || 0 }));
  const planned = withB.filter(x => x.b > 0), unplanned = withB.filter(x => !x.b).sort((a, b) => b.sp - a.sp);
  const totB = planned.reduce((t, x) => t + x.b, 0), totSpentPlanned = planned.reduce((t, x) => t + x.sp, 0);
  const unplannedSpent = unplanned.reduce((t, x) => t + x.sp, 0);
  const isCur = ym === thisMonth(), day = Number(today().slice(8)), dim = daysIn(ym);
  const proj = isCur ? s.exp / day * dim : s.exp;
  const daysLeft = isCur ? dim - day + 1 : 0;
  const prevIncome = summarize(...monthRange(addMonth(ym, -1))).inc;
  return `
  <div class="monthnav"><button data-act="bm" data-n="-1">‹</button><span class="ml">${esc(monthName(ym))}</span><button data-act="bm" data-n="1">›</button></div>
  <section class="month"><div class="label">Monthly plan</div>
    ${totB ? `<div class="row between"><div><div class="big">${fmt(Math.max(0, totB - totSpentPlanned), B)}</div><div class="of">left of ${fmt(totB, B)} budgeted</div></div>
      </div>${isCur ? `<div class="tiny muted" style="margin-top:6px">${daysLeft} days left, so about <b style="color:var(--ink-2)">${fmt(Math.max(0, totB - totSpentPlanned) / Math.max(1, daysLeft), B, { round: true })} a day</b> keeps you on budget</div>` : ''}
      <div class="meter"><i class="${totSpentPlanned > totB ? 'over' : ''}" style="width:${Math.min(100, totSpentPlanned / totB * 100)}%"></i></div>
      <div class="stats"><div><div class="l">Spent in total</div><div class="v">${fmt(s.exp, B, { round: true })}</div></div>
      <div><div class="l">${isCur ? 'Month-end pace' : 'Income'}</div><div class="v">${fmt(isCur ? proj : s.inc, B, { round: true })}</div></div>
      <div><div class="l">Outside budget</div><div class="v">${fmt(unplannedSpent, B, { round: true })}</div></div></div>` :
      `<p style="margin:6px 0 12px;color:var(--ink-2)">Give each category a monthly limit in ${esc(B)}. Spending in any currency is converted at the rate of the day it was recorded.</p>
      ${prevIncome ? `<p class="small muted">Last month's income was ${fmt(prevIncome, B)}.</p>` : ''}
      <button class="btn" data-act="planWizard">Plan my budget</button>`}
  </section>
  ${planned.length ? `<section class="card"><h2>Budgeted <button class="link" data-act="planWizard">Edit all</button></h2><div class="bgrid">${planned.sort((a, b) => b.sp / b.b - a.sp / a.b).map(x => budgetCard(x.c, x.sp, x.b, ym)).join('')}</div></section>` : ''}
  <section class="card"><h2>${planned.length ? 'No budget set' : 'Categories'}</h2>${unplanned.map(x => budgetRow(x.c, x.sp, 0, ym)).join('') || '<div class="muted small">Every category has a budget.</div>'}
  <p class="tiny muted" style="margin-top:10px">Tap a category to set its budget. The striped part of a bar shows where you will end the month at the current pace.</p></section>`;
}

/* ───────────── Insights / reports ───────────── */
function periodRange() {
  const r = ui.rep;
  const t = today();
  if (r.mode === 'year') {
    const py = String(r.year - 1), partial = r.year === t.slice(0, 4);
    // For the current year compare with the same dates last year
    return { from: r.year + '-01-01', to: r.year + '-12-31', pfrom: py + '-01-01', pto: partial ? py + t.slice(4) : py + '-12-31', label: r.year, plabel: partial ? 'the same time in ' + py : py };
  }
  const prev = addMonth(r.month, -1), [from, to] = monthRange(r.month), [pfrom, pfull] = monthRange(prev);
  if (r.month === thisMonth()) {
    // Month not finished: compare with the same days of last month
    const d = Math.min(Number(t.slice(8)), daysIn(prev));
    return { from, to, pfrom, pto: prev + '-' + pad(d), label: monthName(r.month), plabel: '1–' + d + ' ' + monthName(prev, true) };
  }
  return { from, to, pfrom, pto: pfull, label: monthName(r.month), plabel: monthName(prev, true) };
}

function reportsView() {
  const r = ui.rep, B = base(), P = periodRange();
  const s = summarize(P.from, P.to), p = summarize(P.pfrom, P.pto);
  const cats = Object.keys(s.byCat).sort((a, b) => s.byCat[b] - s.byCat[a]);
  const maxCat = cats.length ? s.byCat[cats[0]] : 0;
  // trend
  let months = [];
  if (r.mode === 'year') for (let m = 1; m <= 12; m++) months.push(r.year + '-' + pad(m));
  else for (let i = 5; i >= 0; i--) months.push(addMonth(r.month, -i));
  const tr = months.map(m => { const x = summarize(...monthRange(m)); return { m, exp: x.exp, inc: x.inc }; });
  const tmax = Math.max(1, ...tr.map(x => Math.max(x.exp, x.inc)));
  const done = tr.filter(x => x.m < thisMonth() && x.exp > 0); // finished months only
  const avgExp = done.length ? done.reduce((t, x) => t + x.exp, 0) / done.length : 0;
  const users = db.users.filter(u => u.Active !== false);
  const top = s.list.slice().sort((a, b) => num(b.AmountBase) - num(a.AmountBase)).slice(0, 5);
  const days = r.mode === 'year' ? (r.year === today().slice(0, 4) ? dayOfYear() : 365) : (r.month === thisMonth() ? Number(today().slice(8)) : daysIn(r.month));
  const savings = s.inc > 0 ? (s.inc - s.exp) / s.inc * 100 : null;

  return `
  <div class="seg" style="margin-bottom:10px"><button class="${r.mode === 'month' ? 'on' : ''}" data-act="rmode" data-v="month">Month</button><button class="${r.mode === 'year' ? 'on' : ''}" data-act="rmode" data-v="year">Year</button></div>
  <div class="monthnav"><button data-act="rp" data-n="-1">‹</button><span class="ml">${esc(P.label)}</span><button data-act="rp" data-n="1">›</button></div>

  <section class="card"><div class="kpis">
    ${kpiBox('Spent', fmt(s.exp, B), change(s.exp, p.exp, true), 'red')}
    ${kpiBox('Income', fmt(s.inc, B), change(s.inc, p.inc, false), 'green')}
    ${kpiBox('Left over', fmt(s.inc - s.exp, B), savings == null ? '' : `saved ${Math.round(savings)}% of income`, s.inc - s.exp < 0 ? 'red' : '')}
    ${kpiBox('Average per day', fmt(days ? s.exp / days : 0, B), `${s.list.length} expenses`, '')}
  </div><div class="tiny muted" style="margin-top:8px">▲▼ compared with ${esc(P.plabel)}. All amounts in ${esc(B)}.</div></section>

  <section class="card"><h2>What we notice</h2>${insights(s, p, P, tr, avgExp).map(x => `<div class="insight t-${x[0]}"><span class="e">${x[1]}</span><div class="small">${x[2]}</div></div>`).join('') || '<div class="muted small">Add a few entries to see insights.</div>'}</section>

  <section class="card"><h2>Where the money went</h2>
    ${cats.length ? `<div class="donut-wrap">${ring(catSegments(s.byCat), `<b style="font-size:18px">${fmt(s.exp, B, { round: true })}</b><span>spent</span>`, 150)}
      <div class="legend-list" style="flex-direction:column;margin:0">${catSegments(s.byCat).map(x => `<span><i style="background:${x.color}"></i>${esc(x.n)} <b class="num" style="margin-left:auto;padding-left:8px">${Math.round(x.v / s.exp * 100)}%</b></span>`).join('')}</div></div>` : ''}
    ${cats.length ? cats.map(cn => {
      const v = s.byCat[cn], pv = p.byCat[cn] || 0, c = cat(cn) || { Icon: '•' };
      const bgt = r.mode === 'month' ? budgetFor(cn, r.month).amount : 0;
      return `<div class="brow" data-act="catDrill" data-c="${esc(cn)}"><div class="row between"><span class="ellipsis row" style="gap:8px"><span class="mini tint" ${tint(cn)}>${esc(c.Icon)}</span>${esc(cn)}</span><span class="small num"><b>${fmt(v, B)}</b> <span class="muted">${Math.round(v / s.exp * 100)}%</span></span></div>
      <div class="bar"><i class="${bgt && v > bgt ? 'over' : ''}" style="width:${v / maxCat * 100}%;background:${catColor(cn)}"></i></div>
      <div class="tiny muted" style="margin-top:3px">${change(v, pv, true)}${bgt ? ' · budget ' + fmt(bgt, B, { round: true }) : ''}</div></div>`;
    }).join('') : '<div class="empty"><span class="e">📭</span>No spending in this period.</div>'}
  </section>

  <section class="card"><h2>${r.mode === 'year' ? 'Month by month' : 'Last 6 months'}</h2>
    <div class="trend">${tr.map(x => `<div class="m ${x.m === (r.mode === 'month' ? r.month : '') ? 'sel' : ''}" title="${esc(monthName(x.m))}: spent ${fmt(x.exp, B)}, income ${fmt(x.inc, B)}">
      <div class="bars"><i class="in" style="height:${x.inc / tmax * 100}%"></i><i style="height:${x.exp / tmax * 100}%"></i></div><span class="lab">${esc(monthName(x.m, true))}</span></div>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--green)"></i>Income</span><span><i style="background:var(--red)"></i>Spent</span>${avgExp ? `<span>Avg spent ${fmt(avgExp, B, { round: true })}/month</span>` : ''}</div>
  </section>

  <section class="card"><h2>Who recorded what</h2>${users.map(u => {
    const x = s.byUser[u.UserID] || { exp: 0, inc: 0, n: 0 };
    return `<div class="brow" data-act="histWho" data-id="${esc(u.UserID)}"><div class="row">${whoDot(u.UserID, true)}<div class="grow"><b>${esc(u.Name)}</b><div class="tiny muted">${x.n} entries</div></div>
      <div class="right small num"><div class="red">−${fmt(x.exp, B)}</div><div class="green">+${fmt(x.inc, B)}</div></div></div>
      <div class="bar"><i style="width:${s.exp ? x.exp / s.exp * 100 : 0}%;background:${esc(u.Color)}"></i></div></div>`;
  }).join('')}</section>

  <section class="card"><h2>By currency (actual amounts)</h2>${currencies().map(c => `<div class="row between" style="padding:5px 0"><b>${esc(c)}</b><span class="small num"><span class="red">−${fmt(s.byCur[c] || 0, c)}</span> · <span class="green">+${fmt(s.byCurInc[c] || 0, c)}</span></span></div>`).join('')}
    <div class="tiny muted">${esc(currencies().map(c => { const t = s.byCur[c] ? allTx().filter(x => x.Type === 'EXPENSE' && x.Currency === c && inRange(x, P.from, P.to)).reduce((a, x) => a + num(x.AmountBase), 0) : 0; return s.exp ? c + ' ' + Math.round(t / s.exp * 100) + '%' : ''; }).filter(Boolean).join(' · '))}${s.exp ? ' of spending' : ''}</div></section>

  ${Object.keys(s.byIncCat).length ? `<section class="card"><h2>Income sources</h2>${Object.keys(s.byIncCat).sort((a, b) => s.byIncCat[b] - s.byIncCat[a]).map(cn => `<div class="brow"><div class="row between"><span>${esc((cat(cn) || {}).Icon || '•')} ${esc(cn)}</span><b class="small num green">${fmt(s.byIncCat[cn], B)}</b></div><div class="bar"><i class="inc" style="width:${s.byIncCat[cn] / s.inc * 100}%"></i></div></div>`).join('')}</section>` : ''}

  ${top.length ? `<section class="card"><h2>Biggest expenses</h2><div class="list">${top.map(txItem).join('')}</div></section>` : ''}

  <section class="card"><h2>Export</h2><p class="small muted" style="margin-top:0">Download this period as a spreadsheet file (CSV). Everything is also in your Google Sheet.</p>
    <div class="btns" style="margin-top:6px"><button class="btn ghost" data-act="csv">⬇ Download CSV</button><button class="btn ghost" data-act="csvCopy">📋 Copy</button></div></section>`;
}
function dayOfYear() { const n = new Date(), s = new Date(n.getFullYear(), 0, 0); return Math.floor((n - s) / 86400000); }
function kpiBox(l, v, sub, cls) { return `<div class="kpi"><div class="l">${l}</div><div class="v num ${cls}">${v}</div><div class="tiny muted">${sub}</div></div>`; }
function change(cur, prev, isExp) {
  if (!prev && !cur) return '';
  if (!prev) return 'new this period';
  const d = (cur - prev) / prev * 100;
  if (Math.abs(d) < 1) return 'same as before';
  const up = d > 0, good = isExp ? !up : up;
  return `<span class="${good ? 'green' : 'red'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(d))}%</span> vs before`;
}

function insights(s, p, P, tr, avgExp) {
  const B = base(), out = [], r = ui.rep;
  if (!s.exp && !s.inc) return out;
  const cats = Object.keys(s.byCat).sort((a, b) => s.byCat[b] - s.byCat[a]);
  if (cats[0]) out.push(['info', '🥇', `<b>${esc(cats[0])}</b> took the biggest share: ${fmt(s.byCat[cats[0]], B)} (${Math.round(s.byCat[cats[0]] / s.exp * 100)}% of spending).`]);
  if (cats.length >= 3) { const t3 = cats.slice(0, 3).reduce((t, c) => t + s.byCat[c], 0); out.push(['info', '🎯', `Your top 3 categories make up ${Math.round(t3 / s.exp * 100)}% of all spending — that's where cuts make the most difference.`]); }
  // biggest movers vs previous period
  const movers = Object.keys(Object.assign({}, s.byCat, p.byCat)).map(c => ({ c, d: (s.byCat[c] || 0) - (p.byCat[c] || 0), prev: p.byCat[c] || 0 }))
    .filter(x => Math.abs(x.d) >= Math.max(5, s.exp * 0.05)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 2);
  movers.forEach(x => {
    if (x.d > 0) out.push(['warn', '📈', `<b>${esc(x.c)}</b> went up by ${fmt(x.d, B)}${x.prev ? ` (+${Math.round(x.d / x.prev * 100)}%)` : ''} compared with ${esc(P.plabel)}.`]);
    else out.push(['good', '📉', `<b>${esc(x.c)}</b> came down by ${fmt(-x.d, B)} compared with ${esc(P.plabel)}. Nice.`]);
  });
  if (r.mode === 'month') {
    const isCur = r.month === thisMonth(), day = Number(today().slice(8)), dim = daysIn(r.month);
    const over = activeCats('EXPENSE').filter(c => { const b = budgetFor(c.Name, r.month).amount; return b && (s.byCat[c.Name] || 0) > b; });
    if (over.length) out.push(['bad', '🚨', `Over budget in ${over.map(c => '<b>' + esc(c.Name) + '</b>').join(', ')}.`]);
    if (isCur && day >= 3) {
      const risk = activeCats('EXPENSE').filter(c => { const b = budgetFor(c.Name, r.month).amount, sp = s.byCat[c.Name] || 0; return b && sp <= b && sp / day * dim > b * 1.05; });
      if (risk.length) out.push(['warn', '⏳', `At this pace you'll pass the budget for ${risk.map(c => '<b>' + esc(c.Name) + '</b>').join(', ')} before the month ends.`]);
      const proj = s.exp / day * dim;
      if (avgExp && Math.abs(proj - avgExp) / avgExp > 0.1) out.push([proj > avgExp ? 'warn' : 'good', proj > avgExp ? '⚠️' : '👍', `This month is on track for ${fmt(proj, B, { round: true })}, ${proj > avgExp ? 'above' : 'below'} your usual ${fmt(avgExp, B, { round: true })}.`]);
    }
  }
  if (s.inc > 0) {
    const sr = (s.inc - s.exp) / s.inc * 100;
    out.push(sr >= 0 ? ['good', '💚', `You kept ${Math.round(sr)}% of your income (${fmt(s.inc - s.exp, B)}).`] : ['bad', '🔴', `You spent ${fmt(s.exp - s.inc, B)} more than you earned in this period.`]);
  }
  // weekday pattern
  const wd = [0, 0, 0, 0, 0, 0, 0]; Object.keys(s.days).forEach(d => { const [Y, M, D] = d.split('-').map(Number); wd[new Date(Y, M - 1, D).getDay()] += s.days[d]; });
  const maxWd = wd.indexOf(Math.max(...wd));
  if (s.list.length >= 8 && wd[maxWd] > s.exp * 0.25) out.push(['info', '📅', `Most spending happens on <b>${new Date(2024, 0, 7 + maxWd).toLocaleDateString(undefined, { weekday: 'long' })}s</b> (${Math.round(wd[maxWd] / s.exp * 100)}%).`]);
  const small = s.list.filter(t => num(t.AmountBase) < Math.max(3, s.exp * 0.01));
  if (small.length >= 10) { const st = small.reduce((t, x) => t + num(x.AmountBase), 0); out.push(['warn', '🪙', `${small.length} small purchases added up to ${fmt(st, B)}.`]); }
  const users = Object.keys(s.byUser).filter(k => s.byUser[k].exp > 0);
  if (users.length >= 2) out.push(['info', '🤝', users.map(u => `${esc(user(u).Name)} recorded ${Math.round(s.byUser[u].exp / s.exp * 100)}%`).join(', ') + ' of spending.']);
  return out;
}

/* ───────────── More & sub pages ───────────── */
function moreView() {
  const it = (s, i, t, d) => `<button class="item" data-act="sub" data-s="${s}"><span class="ico">${i}</span><div class="grow"><div class="t">${t}</div><div class="s">${d}</div></div><span class="muted">›</span></button>`;
  return `<section class="card menu"><div class="list">
    ${it('appearance', '🎨', 'Appearance', 'Choose your colour, light or dark')}
    ${it('activity', '🕑', 'Activity', 'Who added, edited or deleted what')}
    ${it('wallets', '👛', 'Wallets', 'Cash, bank, mobile money — in any currency')}
    ${it('categories', '🏷️', 'Categories', 'Add, hide, change icons')}
    ${it('rates', '💱', 'Currencies & rates', currencies().join(' · '))}
    ${it('household', '🏡', 'Household', 'Name and people')}
    ${it('pin', '🔑', 'My PIN', 'Change your PIN')}
    ${it('sync', '🔄', 'Sync', queue.length ? queue.length + ' waiting' : 'Up to date' + (db.lastSync ? ' · ' + ago(new Date(db.lastSync).toISOString()) : ''))}
  </div></section>
  <section class="card"><button class="btn ghost block" data-act="switchUser">🔒 Lock / switch person</button>
  <p class="tiny muted center" style="margin:10px 0 0">Family Finance ${APP_VERSION} · ${IS_GAS ? 'Google web app' : 'installed app'}</p></section>`;
}
function subTitle(s) { return { appearance: 'Appearance', activity: 'Activity', wallets: 'Wallets', categories: 'Categories', rates: 'Currencies & rates', household: 'Household', pin: 'My PIN', sync: 'Sync' }[s] || ''; }
function subView(s) {
  const back = `<button class="link" data-act="sub" data-s="" style="margin-bottom:10px">‹ More</button>`;
  const B = base();
  if (s === 'appearance') {
    const t = getTheme(), known = THEMES.some(x => x[1].toLowerCase() === String(t.color).toLowerCase());
    return back + `<section class="card" style="border-top:0;padding-top:4px"><h2>Your colour</h2>
      <div class="swatches">${THEMES.map(([n, c]) => `<button class="swatch ${c.toLowerCase() === String(t.color).toLowerCase() ? 'on' : ''}" data-act="theme" data-c="${c}"><i style="background:${c}"></i>${n}</button>`).join('')}</div>
      <label class="custom-color"><input type="color" value="${esc(t.color)}" data-input="themeColor"><div class="grow"><b>${known ? 'Pick any colour' : 'Your own colour'}</b><div class="tiny muted">Tap the circle to choose a custom colour</div></div></label>
      <p class="tiny muted" style="margin-top:12px">Only changes how the app looks for ${esc(user(me.userId).Name)} on this device. Your entries are not affected.</p></section>
    <section class="card"><h2>Light or dark</h2><div class="seg">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="${(t.mode || 'auto') === v ? 'on' : ''}" data-act="themeMode" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="preview"><div class="row between"><div><div class="tiny muted">Preview</div><div style="font-size:26px;font-weight:800;letter-spacing:-.03em">US$ 1,250.00</div></div>${ring([{ v: 5, color: 'var(--a)' }, { v: 3, color: 'var(--a-mid)' }], '<b style="font-size:15px">62%</b>', 76)}</div>
      <div class="btns" style="margin-top:12px"><button class="btn" data-act="add">Add entry</button></div></div></section>`;
  }
  if (s === 'activity') {
    const pend = queue.slice().reverse().map(q => `<div class="insight"><span class="e">⟳</span><div class="small grow">${esc(describeRec(q.rec))}<div class="tiny pending">waiting to sync · ${esc(ago(q.at))}</div></div></div>`).join('');
    const list = db.audit.slice().reverse().slice(0, 300);
    const icon = { ADD: '➕', EDIT: '✏️', DELETE: '🗑️', RESTORE: '↺', RATE: '💱', BUDGET: '🎯', JOINED: '👋', PIN: '🔑' };
    return back + `<section class="card"><h2>Recent activity</h2>${pend}${list.map(a => `<div class="insight"><span class="e">${icon[a.Action] || '⚙️'}</span><div class="small grow">${whoDot(a.UserID)} <b>${esc(a.UserName)}</b> ${esc(a.Details)}<div class="tiny muted">${esc(ago(a.Time))}${a.TxID && db.txs[a.TxID] ? ` · <button class="link tiny" data-act="tx" data-id="${esc(a.TxID)}">open</button>` : ''}</div></div></div>`).join('') || '<div class="muted small">No activity yet.</div>'}</section>`;
  }
  if (s === 'wallets') {
    const bal = balances();
    return back + `<section class="card"><h2>Wallets</h2><div class="list">${db.accounts.map(a => { const hidden = a.Active === false || String(a.Active).toUpperCase() === 'FALSE';
      return `<button class="item" data-act="editWallet" data-id="${esc(a.AccountID)}"><span class="ico">👛</span><div class="grow"><div class="t">${esc(a.Name)}${hidden ? ' <span class="tiny muted">(hidden)</span>' : ''}</div><div class="s">${esc(a.Currency)} · opening ${fmt(a.OpeningBalance, a.Currency)}</div></div><b class="num">${fmt(bal[a.AccountID] || 0, a.Currency)}</b></button>`; }).join('')}</div>
      <button class="btn block" style="margin-top:12px" data-act="editWallet" data-id="">+ New wallet</button>
      <p class="tiny muted">Tip: set each wallet's opening balance to what it holds today, then record everything from here on.</p></section>`;
  }
  if (s === 'categories') {
    const block = type => db.categories.filter(c => c.Type === type).map(c => { const hidden = c.Active === false || String(c.Active).toUpperCase() === 'FALSE';
      return `<button class="item" data-act="editCat" data-c="${esc(c.Name)}"><span class="ico">${esc(c.Icon)}</span><div class="grow"><div class="t">${esc(c.Name)}${hidden ? ' <span class="tiny muted">(hidden)</span>' : ''}</div>${type === 'EXPENSE' && num(c.MonthlyBudget) ? `<div class="s">Budget ${fmt(c.MonthlyBudget, B)} / month</div>` : ''}</div><span class="muted">›</span></button>`; }).join('');
    return back + `<section class="card"><h2>Expense categories</h2><div class="list">${block('EXPENSE')}</div><button class="btn ghost block" style="margin-top:10px" data-act="editCat" data-c="" data-t="EXPENSE">+ Expense category</button></section>
      <section class="card"><h2>Income categories</h2><div class="list">${block('INCOME')}</div><button class="btn ghost block" style="margin-top:10px" data-act="editCat" data-c="" data-t="INCOME">+ Income category</button></section>`;
  }
  if (s === 'rates') {
    return back + `<section class="card"><h2>Exchange rates</h2><p class="small muted" style="margin-top:0">Main currency: <b>${esc(B)}</b>. Budgets and reports use it. Each entry keeps the rate of the day it was recorded, so changing the rate never changes old totals.</p>
      ${currencies().filter(c => c !== B).map(c => `<form data-form="rate" class="row" style="margin-top:10px"><span class="bold" style="width:90px">1 ${esc(B)} =</span><input class="in grow" name="rate" inputmode="decimal" value="${esc(db.settings['Rate_' + c])}"><span class="bold" style="width:44px">${esc(c)}</span><input type="hidden" name="cur" value="${esc(c)}"><button class="btn">Save</button></form>`).join('')}
    </section><section class="card"><h2>Add a currency</h2><form data-form="rate" class="row"><input class="in" name="cur" placeholder="SEK" maxlength="5" style="width:90px;text-transform:uppercase" required><input class="in grow" name="rate" inputmode="decimal" placeholder="per 1 ${esc(B)}" required><button class="btn">Add</button></form>
      <p class="tiny muted">Example: if 1 ${esc(B)} buys 9.50 SEK, type SEK and 9.50. Then create a wallet in that currency.</p></section>`;
  }
  if (s === 'household') {
    return back + `<section class="card"><h2>Household name</h2><form data-form="hhName" class="row"><input class="in grow" name="name" value="${esc(db.settings.HouseholdName || '')}" required><button class="btn">Save</button></form></section>
      <section class="card"><h2>People</h2>${db.users.filter(u => u.Active !== false).map(u => `<div class="row" style="padding:6px 0">${whoDot(u.UserID, true)}<b class="grow">${esc(u.Name)}</b>${u.UserID === me.userId ? '<span class="tiny muted">you</span>' : ''}</div>`).join('')}
      <p class="tiny muted">To add someone, open the app on their phone, connect it with the household code and tap <b>I'm new</b>. Everyone sees the same wallets and entries; each entry shows who recorded and edited it.</p></section>`;
  }
  if (s === 'pin') {
    return back + `<section class="card"><form data-form="pin"><label class="f"><span>Current PIN</span><input class="in pin" name="old" type="password" inputmode="numeric" required></label>
      <label class="f"><span>New PIN (4–8 digits)</span><input class="in pin" name="n1" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>
      <label class="f"><span>New PIN again</span><input class="in pin" name="n2" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>
      <div class="err" id="pErr"></div><button class="btn block" style="margin-top:10px">Change PIN</button><p class="tiny muted">Needs internet.</p></form></section>`;
  }
  if (s === 'sync') {
    return back + `<section class="card"><h2>Status</h2><div class="kv"><span class="k">Connection</span><span>${net.online ? '🟢 Online' : '⚪ Offline'}</span>
      <span class="k">Last synced</span><span>${db.lastSync ? esc(ago(new Date(db.lastSync).toISOString())) : 'never'}</span>
      <span class="k">Waiting</span><span>${queue.length}</span><span class="k">Entries on device</span><span>${allTx().length}</span>
      ${net.lastError ? `<span class="k">Last error</span><span class="red small">${esc(net.lastError)}</span>` : ''}</div>
      <button class="btn block" data-act="syncNow">🔄 Sync now</button><p class="tiny muted">The app syncs by itself every minute and right after you save something. You can keep recording with no internet.</p></section>
      ${rejected.length ? `<section class="card"><h2>Not saved (${rejected.length})</h2>${rejected.map((x, i) => `<div class="insight"><span class="e">⚠️</span><div class="small grow">${esc(describeRec(x.rec))}<div class="red tiny">${esc(x.error.message)}</div>
        <div class="row" style="margin-top:6px"><button class="link" data-act="rejRetry" data-i="${i}">Try again</button><button class="link red" data-act="rejDrop" data-i="${i}">Discard</button></div></div></div>`).join('')}</section>` : ''}
      <section class="card"><h2>This device</h2><div class="kv"><span class="k">Device ID</span><span class="small">${esc(cfg.deviceId)}</span>${IS_GAS ? '' : `<span class="k">Server</span><span class="tiny ellipsis">${esc(cfg.api)}</span>`}</div>
      <button class="btn danger block" data-act="disconnect">Disconnect this device</button></section>`;
  }
  return back;
}
function describeRec(r) {
  if (r.kind === 'tx') { const a = acc(r.tx.AccountID); return (r.tx.Type === 'TRANSFER' ? 'Transfer ' : r.tx.Type === 'EXPENSE' ? 'Expense ' : 'Income ') + fmt(r.tx.Amount, a ? a.Currency : '') + ' · ' + (r.tx.Category || '') + ' · ' + r.tx.Date; }
  if (r.kind === 'txDelete') return 'Delete entry';
  if (r.kind === 'txRestore') return 'Restore entry';
  if (r.kind === 'account') return 'Wallet ' + r.account.Name;
  if (r.kind === 'category') return 'Category ' + r.category.Name;
  if (r.kind === 'budget') return 'Budget ' + r.category + ' ' + r.month;
  if (r.kind === 'rate') return 'Rate ' + r.currency + ' ' + r.rate;
  return r.kind;
}

/* ───────────── Entry form ───────────── */
let form = null; // working copy
function openEntry(tx, type) {
  const accs = activeAccounts();
  if (!accs.length) { toast('Create a wallet first'); return; }
  const lastAcc = LS.get('lastAcc', '');
  form = tx ? Object.assign({}, tx) : {
    TxID: uid(), Type: type || 'EXPENSE', Date: today(), AccountID: accs.some(a => a.AccountID === lastAcc) ? lastAcc : accs[0].AccountID,
    Amount: '', Category: '', Note: '', ToAccountID: '', ToAmount: ''
  };
  form._isNew = !tx;
  paintEntry();
}
function paintEntry(focusAmount) {
  const f = form, a = acc(f.AccountID), cur = a ? a.Currency : base(), B = base();
  const accs = db.accounts.filter(x => x.Active !== false && String(x.Active).toUpperCase() !== 'FALSE' || x.AccountID === f.AccountID || x.AccountID === f.ToAccountID);
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), freq = {};
  allTx().forEach(t => { if (t.Type === f.Type && t.Date >= since) freq[t.Category] = (freq[t.Category] || 0) + 1; });
  const cats = f.Type === 'TRANSFER' ? [] : activeCats(f.Type).map((c, i) => ({ c, i })).sort((x, y) => (freq[y.c.Name] || 0) - (freq[x.c.Name] || 0) || x.i - y.i).map(x => x.c)
    .concat(f.Category && !activeCats(f.Type).some(c => c.Name === f.Category) && cat(f.Category) ? [cat(f.Category)] : []);
  const to = acc(f.ToAccountID), cross = f.Type === 'TRANSFER' && to && to.Currency !== cur;
  const approx = cur !== B && calc(f.Amount) ? `≈ ${fmt(calc(f.Amount) / (rateOf(cur) || 1), B)} at ${num(db.settings['Rate_' + cur]).toLocaleString()} ${cur}/${B}` : '';
  openModal(`<form data-form="entry">
    <div class="row between"><h3>${f._isNew ? 'New entry' : 'Edit entry'}</h3>${f._isNew ? '' : `<span class="tiny muted">by ${esc(user(f.EnteredBy).Name)}</span>`}</div>
    <div class="seg" style="margin:10px 0">${[['EXPENSE', 'Expense', 'exp'], ['INCOME', 'Income', 'inc'], ['TRANSFER', 'Transfer', 'trf']].map(([v, l, c]) => `<button type="button" class="${f.Type === v ? 'on ' + c : ''}" data-act="fType" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="amount-wrap ${TOUCH ? 'compact' : ''}"><span class="cur">${esc(SYM[cur] || cur)}</span><input name="Amount" inputmode="${TOUCH ? 'none' : 'decimal'}" placeholder="0" value="${esc(f.Amount)}" data-input="fAmt" autocomplete="off" ${focusAmount !== false && !TOUCH ? 'autofocus' : ''}></div>
    <div class="calc-hint" id="calcHint">${isExpr(f.Amount) ? '= ' + esc(fmt(calc(f.Amount), cur)) : ''}</div>
    <div class="tiny muted" id="approx" style="min-height:1.2em;text-align:center">${esc(approx)}</div>
    ${TOUCH ? `<div class="keypad">${['7', '8', '9', '⌫', '4', '5', '6', '−', '1', '2', '3', '+', '.', '0', '00', '='].map(k => `<button type="button" class="${'⌫−+='.includes(k) ? 'op' : ''}" data-act="kp" data-k="${k}">${k}</button>`).join('')}</div>` : ''}
    <label class="f"><span>${f.Type === 'TRANSFER' ? 'From wallet' : f.Type === 'INCOME' ? 'Into wallet' : 'Paid from'}</span>
      <div class="chips">${accs.map(x => `<button type="button" class="chip ${x.AccountID === f.AccountID ? 'on' : ''}" data-act="fAcc" data-id="${esc(x.AccountID)}">${esc(walletLabel(x))}</button>`).join('')}</div></label>
    ${f.Type === 'TRANSFER' ? `<label class="f"><span>To wallet</span><div class="chips">${accs.filter(x => x.AccountID !== f.AccountID).map(x => `<button type="button" class="chip ${x.AccountID === f.ToAccountID ? 'on' : ''}" data-act="fTo" data-id="${esc(x.AccountID)}">${esc(walletLabel(x))}</button>`).join('')}</div></label>
      ${cross ? `<label class="f"><span>Amount received in ${esc(to.Currency)} (currency exchange)</span><input class="in" name="ToAmount" inputmode="decimal" value="${esc(f.ToAmount)}" data-input="fTo"></label>` : ''}` :
      `<label class="f"><span>Category${Object.keys(freq).length ? ' <span class="muted" style="font-weight:500">· most used first</span>' : ''}</span><div class="catgrid">${cats.map(c => `<button type="button" class="cat ${c.Name === f.Category ? 'on' : ''}" data-act="fCat" data-c="${esc(c.Name)}"><span class="ci tint" ${tint(c.Name)}>${esc(c.Icon)}</span>${esc(c.Name)}</button>`).join('')}</div></label>`}
    <div class="row" style="gap:8px"><label class="f" style="flex:1"><span>Date</span><input class="in" type="date" name="Date" value="${esc(f.Date)}" max="${today()}" data-input="fDate" required></label></div>
    <label class="f"><span>Note (optional)</span><input class="in" name="Note" value="${esc(f.Note)}" maxlength="300" placeholder="e.g. rice and oil at Red Light" data-input="fNote"></label>
    <div class="err" id="fErr"></div>
    <div class="btns">${f._isNew ? '<button type="button" class="btn ghost" data-act="close">Cancel</button>' : '<button type="button" class="btn danger" data-act="fDel">Delete</button>'}<button class="btn">${f._isNew ? 'Save' : 'Save changes'}</button></div>
  </form>`);
}
function saveEntry() {
  const f = form, err = m => { $('#fErr').textContent = m; };
  const amount = calc(f.Amount);
  if (!(amount > 0)) return err('Enter an amount');
  const a = acc(f.AccountID); if (!a) return err('Choose a wallet');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.Date)) return err('Choose a date');
  const tx = { TxID: f.TxID, Date: f.Date, Type: f.Type, AccountID: f.AccountID, Amount: amount, Note: (f.Note || '').trim(),
    Rate: a.Currency === base() ? 1 : (f._isNew || f.AccountID !== (db.txs[f.TxID] || {}).AccountID ? rateOf(a.Currency) : num(f.Rate) || rateOf(a.Currency)),
    UpdatedAt: new Date().toISOString() };
  if (!(tx.Rate > 0)) return err('No exchange rate for ' + a.Currency + ' — set it under More ▸ Currencies & rates');
  if (f.Type === 'TRANSFER') {
    const to = acc(f.ToAccountID); if (!to) return err('Choose the wallet the money went to');
    tx.ToAccountID = to.AccountID; tx.ToAmount = to.Currency === a.Currency ? amount : r2(num(f.ToAmount));
    if (!(tx.ToAmount > 0)) return err('Enter the amount received');
    tx.Category = 'Transfer';
  } else {
    if (!f.Category || !cat(f.Category)) return err('Pick a category');
    tx.Category = f.Category;
  }
  LS.set('lastAcc', f.AccountID);
  enqueue({ kind: 'tx', tx });
  closeModal(); buzz(); toast(f._isNew ? 'Saved' : 'Changes saved', { icon: '✓' }); form = null; render();
}
function amountChanged() {
  const v = form.Amount, a = acc(form.AccountID), B = base(), el = $('#approx'), h = $('#calcHint');
  if (el && a) el.textContent = a.Currency !== B && calc(v) ? `≈ ${fmt(calc(v) / (rateOf(a.Currency) || 1), B)} at ${num(db.settings['Rate_' + a.Currency]).toLocaleString()} ${a.Currency}/${B}` : '';
  if (h) h.textContent = isExpr(v) ? '= ' + fmt(calc(v), a ? a.Currency : B) : '';
  if (form.Type === 'TRANSFER') { suggestTo(); const ti = document.querySelector('[data-input=fTo]'); if (ti) ti.value = form.ToAmount; }
}
const TOUCH = window.matchMedia ? matchMedia('(pointer: coarse)').matches : false;
function suggestTo() {
  const f = form, a = acc(f.AccountID), t = acc(f.ToAccountID);
  if (!a || !t || a.Currency === t.Currency) return;
  const ra = rateOf(a.Currency), rt = rateOf(t.Currency);
  if (ra && rt && calc(f.Amount)) f.ToAmount = r2(calc(f.Amount) / ra * rt);
}

function txDetail(id) {
  const t = db.txs[id]; if (!t) return;
  const a = acc(t.AccountID), to = acc(t.ToAccountID), c = cat(t.Category), B = base();
  const hist = db.audit.filter(x => x.TxID === id).slice().reverse();
  openModal(`<div class="detail-head"><span class="mini tint lg" ${tint(t.Type === 'TRANSFER' ? 'transfer' : t.Category)}>${esc(t.Type === 'TRANSFER' ? '⇄' : c ? c.Icon : '•')}</span>
    <div class="detail-amt ${t.Type === 'INCOME' ? 'green' : t.Type === 'TRANSFER' ? 'blue' : ''}">${t.Type === 'EXPENSE' ? '−' : t.Type === 'INCOME' ? '+' : ''}${fmt(t.Amount, t.Currency)}</div>
    <div class="sub">${esc(t.Type === 'TRANSFER' ? 'Transfer' : t.Category)}, ${esc(dayLabel(t.Date))}${t.Currency !== B ? ` (≈ ${fmt(t.AmountBase, B)})` : ''}</div></div>
    <div class="kv"><span class="k">${t.Type === 'TRANSFER' ? 'From' : 'Wallet'}</span><span>${esc(a ? a.Name : '?')}</span>
    ${t.Type === 'TRANSFER' ? `<span class="k">To</span><span>${esc(to ? to.Name : '?')}${t.ToCurrency !== t.Currency ? ' · received ' + fmt(t.ToAmount, t.ToCurrency) : ''}</span>` : ''}
    ${t.Note ? `<span class="k">Note</span><span>${esc(t.Note)}</span>` : ''}
    ${t.Currency !== B ? `<span class="k">Rate used</span><span>1 ${esc(B)} = ${esc(t.Rate)} ${esc(t.Currency)}</span>` : ''}
    <span class="k">Recorded by</span><span>${whoDot(t.EnteredBy)} ${esc(user(t.EnteredBy).Name)} · ${esc(ago(t.EnteredAt))}</span>
    ${t.UpdatedBy && t.UpdatedAt !== t.EnteredAt ? `<span class="k">Last change</span><span>${whoDot(t.UpdatedBy)} ${esc(user(t.UpdatedBy).Name)} · ${esc(ago(t.UpdatedAt))}</span>` : ''}</div>
    ${hist.length ? `<div class="small bold" style="margin:14px 0 4px">Changes</div>${hist.map(x => `<div class="tiny" style="padding:4px 0;border-top:1px solid var(--line)">${whoDot(x.UserID)} <b>${esc(x.UserName)}</b> ${esc(x.Action.toLowerCase())} · ${esc(ago(x.Time))}<div class="muted">${esc(x.Details)}</div></div>`).join('')}` : ''}
    ${pendingIds().has(id) ? '<div class="note">⟳ This change is waiting to sync.</div>' : ''}
    <div class="btns"><button class="btn danger" data-act="txDel" data-id="${esc(id)}">Delete</button><button class="btn ghost" data-act="txCopy" data-id="${esc(id)}">Repeat</button><button class="btn" data-act="txEdit" data-id="${esc(id)}">Edit</button></div>`);
}

/* ───────────── Small editors ───────────── */
function editWallet(id) {
  const a = id ? acc(id) : null;
  openModal(`<form data-form="wallet"><h3>${a ? 'Edit wallet' : 'New wallet'}</h3><input type="hidden" name="id" value="${esc(id)}">
    <label class="f"><span>Name</span><input class="in" name="name" value="${esc(a ? a.Name : '')}" placeholder="e.g. Ecobank, Orange Money, Swedbank" required maxlength="40" autofocus></label>
    <label class="f"><span>Currency</span>${a ? `<input class="in" value="${esc(a.Currency)}" disabled>` : `<select class="in" name="cur">${currencies().map(c => `<option>${esc(c)}</option>`).join('')}</select>`}</label>
    <label class="f"><span>Opening balance (what it held when you started)</span><input class="in" name="open" inputmode="decimal" value="${esc(a ? a.OpeningBalance : 0)}"></label>
    ${a ? `<label class="f row"><input type="checkbox" name="hide" ${a.Active === false || String(a.Active).toUpperCase() === 'FALSE' ? 'checked' : ''}> <span style="margin:0">Hide this wallet (history is kept)</span></label>` : ''}
    <div class="btns"><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn">Save</button></div></form>`);
}
const ICONS = ['🛒', '🍽️', '🏠', '💡', '📱', '🚕', '🎓', '🩺', '⛪', '👪', '👕', '🧴', '🧺', '🎬', '🏦', '📦', '🍼', '✈️', '🎁', '💼', '📈', '💰', '🐶', '🔧', '💊', '🎉', '⚽', '📚', '🚗', '💇'];
function editCat(name, type) {
  const c = name ? cat(name) : null, t = c ? c.Type : type, B = base();
  openModal(`<form data-form="cat"><h3>${c ? esc(c.Name) : 'New ' + (t === 'INCOME' ? 'income' : 'expense') + ' category'}</h3>
    <input type="hidden" name="type" value="${esc(t)}"><input type="hidden" name="orig" value="${esc(name)}">
    ${c ? '' : `<label class="f"><span>Name</span><input class="in" name="name" required maxlength="40" autofocus></label>`}
    <label class="f"><span>Icon</span><div class="chips wrap">${ICONS.map(i => `<button type="button" class="chip ${(c ? c.Icon : ICONS[0]) === i ? 'on' : ''}" data-act="pickIcon" data-i="${i}">${i}</button>`).join('')}</div><input type="hidden" name="icon" value="${esc(c ? c.Icon : ICONS[0])}"></label>
    ${t === 'EXPENSE' ? `<label class="f"><span>Usual monthly budget (${esc(B)}, 0 = none)</span><input class="in" name="budget" inputmode="decimal" value="${esc(c ? c.MonthlyBudget : 0)}"></label>` : ''}
    ${c ? `<label class="f row"><input type="checkbox" name="hide" ${c.Active === false || String(c.Active).toUpperCase() === 'FALSE' ? 'checked' : ''}> <span style="margin:0">Hide this category</span></label>` : ''}
    <div class="btns"><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn">Save</button></div></form>`);
}
function editBudget(name) {
  const c = cat(name), ym = ui.view === 'budget' ? ui.budMonth : thisMonth(), B = base(), cur = budgetFor(name, ym);
  const spent = summarize(...monthRange(ym)).byCat[name] || 0;
  const hist = [1, 2, 3].map(i => summarize(...monthRange(addMonth(ym, -i))).byCat[name] || 0);
  const avg = hist.reduce((a, b) => a + b, 0) / 3;
  openModal(`<form data-form="budget"><h3>${esc(c.Icon)} ${esc(name)}</h3><p class="small muted" style="margin:4px 0">Spent in ${esc(monthName(ym))}: <b>${fmt(spent, B)}</b>${avg ? ` · 3-month average ${fmt(avg, B)}` : ''}</p>
    <input type="hidden" name="cat" value="${esc(name)}"><input type="hidden" name="ym" value="${esc(ym)}">
    <label class="f"><span>Usual monthly budget (${esc(B)})</span><input class="in" name="usual" inputmode="decimal" value="${esc(num(c.MonthlyBudget) || '')}" placeholder="${avg ? Math.ceil(avg) : '0'}" autofocus></label>
    <label class="f"><span>Different amount only for ${esc(monthName(ym))} (optional)</span><input class="in" name="month" inputmode="decimal" value="${cur.custom ? esc(cur.amount) : ''}" placeholder="leave empty to use usual"></label>
    <div class="btns"><button type="button" class="btn ghost" data-act="catDrill" data-c="${esc(name)}">See entries</button><button class="btn">Save</button></div></form>`);
}
function planWizard() {
  const ym = ui.budMonth, B = base();
  const rows = activeCats('EXPENSE').map(c => { const h = [1, 2, 3].map(i => summarize(...monthRange(addMonth(ym, -i))).byCat[c.Name] || 0); return { c, avg: h.reduce((a, b) => a + b, 0) / 3 }; });
  openModal(`<form data-form="plan"><h3>Plan the monthly budget</h3><p class="small muted" style="margin:4px 0 8px">Amounts in ${esc(B)} per month. Grey numbers are your 3-month average.</p>
    ${rows.map(x => `<div class="row" style="padding:5px 0;border-top:1px solid var(--line)"><span class="grow small ellipsis">${esc(x.c.Icon)} ${esc(x.c.Name)}${x.avg ? ` <span class="tiny muted">avg ${fmt(x.avg, B, { round: true })}</span>` : ''}</span>
      <input class="in" style="width:110px;padding:8px" inputmode="decimal" name="b_${esc(x.c.Name)}" value="${num(x.c.MonthlyBudget) || ''}" placeholder="${x.avg ? Math.ceil(x.avg) : '—'}"></div>`).join('')}
    <div class="row between small" style="margin-top:10px"><b>Total</b><b id="planTotal" class="num"></b></div>
    <div class="btns"><button type="button" class="btn ghost" data-act="planAvg">Use averages</button><button class="btn">Save budget</button></div></form>`);
  planTotal();
}
function planTotal() { const el = $('#planTotal'); if (!el) return; let t = 0; document.querySelectorAll('[data-form="plan"] input[name^="b_"]').forEach(i => { t += num(i.value); }); el.textContent = fmt(t, base()); }

function deleteTx(id) {
  const snap = Object.assign({}, db.txs[id]); if (!snap.TxID) return;
  enqueue({ kind: 'txDelete', txId: id, at: new Date().toISOString() }); buzz(); render();
  toast('Entry deleted', { icon: '🗑', undo: () => {
    const qi = queue.findIndex(q => q.rec.kind === 'txDelete' && q.rec.txId === id);
    if (qi >= 0) { queue.splice(qi, 1); db.txs[id] = snap; saveAll(); }   // not synced yet: just put it back
    else enqueue({ kind: 'txRestore', txId: id, snapshot: snap });          // already synced: restore on the server
    render(); toast('Entry restored', { icon: '↺' });
  } });
}

/* ───────────── CSV ───────────── */
function csvText() {
  const P = periodRange(), B = base();
  const rows = allTx().filter(t => inRange(t, P.from, P.to)).sort((a, b) => a.Date.localeCompare(b.Date));
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Date', 'Type', 'Category', 'Wallet', 'Amount', 'Currency', 'To wallet', 'Amount received', 'Received currency', 'Rate', 'Amount ' + B, 'Note', 'Recorded by', 'Last changed by'];
  return [head].concat(rows.map(t => [t.Date, t.Type, t.Category, (acc(t.AccountID) || {}).Name, t.Amount, t.Currency, t.ToAccountID ? (acc(t.ToAccountID) || {}).Name : '', t.ToAmount, t.ToCurrency, t.Rate, t.AmountBase, t.Note, user(t.EnteredBy).Name, user(t.UpdatedBy).Name]))
    .map(r => r.map(q).join(',')).join('\n');
}

/* ───────────── Events ───────────── */
const actions = {
  nav: el => { ui.view = el.dataset.v; ui.sub = null; render(); window.scrollTo(0, 0); },
  sub: el => { ui.view = 'more'; ui.sub = el.dataset.s || null; render(); window.scrollTo(0, 0); },
  goSync: () => { ui.view = 'more'; ui.sub = 'sync'; render(); sync(true); },
  syncNow: () => sync(true),
  add: () => openEntry(null, 'EXPENSE'),
  close: () => { closeModal(); form = null; },
  cfYes: () => confirmBox._res && (confirmBox._res(true), confirmBox._res = null),
  cfNo: () => confirmBox._res && (confirmBox._res(false), confirmBox._res = null),
  tx: el => txDetail(el.dataset.id),
  txEdit: el => { closeModal(); openEntry(db.txs[el.dataset.id]); },
  txCopy: el => { const t = db.txs[el.dataset.id]; closeModal(); openEntry(null, t.Type); Object.assign(form, { AccountID: t.AccountID, Amount: t.Amount, Category: t.Category, Note: t.Note, ToAccountID: t.ToAccountID, ToAmount: t.ToAmount }); paintEntry(); },
  txDel: el => { closeModal(); deleteTx(el.dataset.id); },
  fDel: () => { const id = form.TxID; closeModal(); form = null; deleteTx(id); },
  fType: el => { form.Type = el.dataset.v; form.Category = ''; if (form.Type === 'TRANSFER' && !form.ToAccountID) { const o = activeAccounts().find(a => a.AccountID !== form.AccountID); form.ToAccountID = o ? o.AccountID : ''; suggestTo(); } paintEntry(false); },
  fAcc: el => { form.AccountID = el.dataset.id; if (form.ToAccountID === form.AccountID) form.ToAccountID = ''; suggestTo(); paintEntry(false); },
  fTo: el => { form.ToAccountID = el.dataset.id; suggestTo(); paintEntry(false); },
  fCat: el => { form.Category = el.dataset.c; document.querySelectorAll('.cat').forEach(b => b.classList.toggle('on', b === el)); },
  hm: el => { const n = +el.dataset.n; ui.hist.month = n === 0 || ui.hist.month === 'all' ? thisMonth() : addMonth(ui.hist.month, n); render(); },
  hAll: () => { ui.hist.month = 'all'; render(); },
  hf: el => { ui.hist[el.dataset.k] = el.dataset.v; render(); },
  histAcc: el => { ui.view = 'history'; ui.hist = { month: thisMonth(), who: '', type: '', acc: el.dataset.id, cat: '', q: '' }; render(); },
  histWho: el => { ui.view = 'history'; ui.hist = { month: ui.rep.mode === 'month' ? ui.rep.month : 'all', who: el.dataset.id, type: '', acc: '', cat: '', q: '' }; render(); window.scrollTo(0, 0); },
  catDrill: el => { closeModal(); const m = ui.view === 'reports' ? (ui.rep.mode === 'month' ? ui.rep.month : 'all') : ui.view === 'budget' ? ui.budMonth : thisMonth(); ui.view = 'history'; ui.hist = { month: m, who: '', type: '', acc: '', cat: el.dataset.c, q: '' }; render(); window.scrollTo(0, 0); },
  bm: el => { ui.budMonth = addMonth(ui.budMonth, +el.dataset.n); render(); },
  rmode: el => { ui.rep.mode = el.dataset.v; render(); },
  rp: el => { const n = +el.dataset.n; if (ui.rep.mode === 'year') ui.rep.year = String(+ui.rep.year + n); else ui.rep.month = addMonth(ui.rep.month, n); render(); },
  editBudget: el => editBudget(el.dataset.c),
  kp: el => {
    const k = el.dataset.k; let v = String(form.Amount || '');
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === '=') v = isExpr(v) ? String(calc(v)) : v;
    else if (k === '+' || k === '−') { v = v.replace(/[+−\-]$/, ''); if (v) v += k; }
    else if (k === '.') { const last = v.split(/[+−\-]/).pop(); if (!last.includes('.')) v += last ? '.' : '0.'; }
    else { const last = v.split(/[+−\-]/).pop(); if (/\.\d\d$/.test(last)) return; v = (last === '0' && k !== '.' ? v.slice(0, -1) : v) + k; }
    form.Amount = v; const i = document.querySelector('[data-input=fAmt]'); if (i) i.value = v; amountChanged();
  },
  toastUndo: () => { const f = toast._undo; toast._undo = null; $('#toast').classList.add('hidden'); if (f) f(); },
  quick: el => { const t = el.dataset.t; if (t === 'BUDGET') { ui.view = 'budget'; render(); return; } openEntry(null, t); if (t === 'TRANSFER') actions.fType({ dataset: { v: 'TRANSFER' } }); },
  theme: el => { setTheme(Object.assign({}, getTheme(), { color: el.dataset.c })); render(); },
  themeMode: el => { setTheme(Object.assign({}, getTheme(), { mode: el.dataset.v })); render(); },
  planWizard: () => planWizard(),
  planAvg: () => { document.querySelectorAll('[data-form="plan"] input[name^="b_"]').forEach(i => { if (i.placeholder && i.placeholder !== '—') i.value = i.placeholder; }); planTotal(); },
  editWallet: el => editWallet(el.dataset.id),
  editCat: el => editCat(el.dataset.c, el.dataset.t),
  pickIcon: el => { el.closest('form').querySelector('[name=icon]').value = el.dataset.i; el.parentNode.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === el)); },
  pickColor: el => { el.closest('form').querySelector('[name=color]').value = el.dataset.c; el.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  pickUser: el => { ui.loginUser = el.dataset.id; render(); },
  loginBack: () => { ui.loginUser = null; render(); },
  newPerson: () => { ui.newPerson = true; render(); },
  cancelNew: () => { ui.newPerson = false; render(); },
  switchUser: () => { me = null; LS.del('me'); ui.loginUser = null; ui.view = 'home'; ui.sub = null; render(); },
  csv: () => {
    const blob = new Blob(['﻿' + csvText()], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'family-money-' + periodRange().label.replace(/\s+/g, '-') + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (IS_GAS) toast('If nothing downloaded, use Copy and paste into a spreadsheet');
  },
  csvCopy: () => { const t = csvText(); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied — paste into Excel or Google Sheets'), () => { openModal(`<h3>Copy this</h3><textarea class="in" rows="12" readonly>${esc(t)}</textarea>`); }); },
  rejRetry: el => { const x = rejected.splice(+el.dataset.i, 1)[0]; x.rec.rid = uid(); if (x.rec.tx) x.rec.tx.UpdatedAt = new Date().toISOString(); queue.push({ rec: x.rec, at: x.at }); saveAll(); sync(true); render(); },
  rejDrop: async el => { if (await confirmBox('Discard this change?', 'It was not saved to the household and will be removed from this device.', 'Discard', true)) { rejected.splice(+el.dataset.i, 1); saveAll(); db.seq = 0; sync(true); render(); } },
  disconnect: async () => {
    if (queue.length && !(await confirmBox('Changes not synced!', queue.length + ' change(s) are still waiting. If you disconnect now they will be lost.', 'Disconnect anyway', true))) return;
    if (!queue.length && !(await confirmBox('Disconnect this device?', 'Your data stays safe in the Google Sheet. You can connect again with the household code.', 'Disconnect', true))) return;
    ['cfg', 'db', 'queue', 'rejected', 'me', 'lastAcc'].forEach(LS.del); cfg = {}; db = emptyDb(); queue = []; rejected = []; me = null; render();
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = actions[el.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(el);
});
document.addEventListener('input', e => {
  const k = e.target.dataset.input; if (!k) return;
  const v = e.target.value;
  if (k === 'themeColor') { setTheme(Object.assign({}, getTheme(), { color: v })); clearTimeout(actions._tc); actions._tc = setTimeout(render, 400); return; }
  if (k === 'hq') { ui.hist.q = v; clearTimeout(actions._hq); actions._hq = setTimeout(() => { const pos = e.target.selectionStart; render(); const i = document.querySelector('[data-input=hq]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }, 250); return; }
  if (!form) { if (e.target.closest('[data-form=plan]')) planTotal(); return; }
  if (k === 'fAmt') { form.Amount = v; amountChanged(); }
  if (k === 'fTo') form.ToAmount = v;
  if (k === 'fDate') form.Date = v;
  if (k === 'fNote') form.Note = v;
});

document.addEventListener('submit', async e => {
  const f = e.target, kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f).entries());
  const btn = f.querySelector('button:not([type=button])');
  const busy = on => { if (btn) btn.disabled = on; };

  if (kind === 'connect') {
    busy(true); $('#cErr').textContent = '';
    if (!IS_GAS) {
      const bad = checkApiUrl(v.api);
      if (bad) { $('#cErr').textContent = bad; busy(false); return; }
      cfg.api = v.api.trim().split('?')[0];
    }
    try {
      const r = await call({ action: 'registerDevice', householdCode: v.code, deviceName: v.dev });
      if (!r.ok) throw new Error(r.message);
      cfg.deviceId = r.deviceId; cfg.deviceKey = r.deviceKey; LS.set('cfg', cfg);
      db = emptyDb(); await pull(true); net.online = true; db.lastSync = Date.now(); saveAll(); render();
    } catch (x) { $('#cErr').textContent = x.message || 'Could not connect. Check the address and internet.'; busy(false); }
  }
  if (kind === 'newPerson') {
    const err = $('#nErr'); err.textContent = '';
    if (!/^\d{4,8}$/.test(v.pin)) { err.textContent = 'PIN must be 4 to 8 digits'; return; }
    if (v.pin !== v.pin2) { err.textContent = 'The two PINs are different'; return; }
    busy(true);
    try {
      const r = await call(Object.assign({ action: 'addUser', name: v.name, pin: v.pin, color: v.color }, authBody()));
      if (!r.ok) throw new Error(r.message);
      await pull(false); saveAll();
      me = { userId: r.userId }; LS.set('me', me); ui.newPerson = false; LS.set(themeKey(), getTheme()); applyTheme(); render(); toast('Welcome, ' + v.name + '!');
    } catch (x) { err.textContent = x.message || 'No internet — this step needs a connection'; busy(false); }
  }
  if (kind === 'login') {
    const u = user(ui.loginUser); busy(true);
    const ok = u.PinSalt && (await pinHash(u.PinSalt, v.pin)) === u.PinHash;
    if (!ok) { $('#lErr').textContent = 'Wrong PIN'; f.pin.value = ''; f.pin.focus(); busy(false); return; }
    me = { userId: u.UserID }; LS.set('me', me); ui.loginUser = null; ui.view = 'home'; countedUp = false; applyTheme(); render(); sync();
  }
  if (kind === 'entry') saveEntry();
  if (kind === 'wallet') {
    const name = v.name.trim(); if (!name) return;
    const ex = v.id ? acc(v.id) : null;
    enqueue({ kind: 'account', account: { AccountID: v.id || 'ACC-' + uid().slice(0, 8).toUpperCase(), Name: name, Currency: ex ? ex.Currency : v.cur, OpeningBalance: r2(num(v.open)), Active: !v.hide } });
    closeModal(); render(); toast('Wallet saved');
  }
  if (kind === 'cat') {
    const name = (v.orig || v.name || '').trim();
    if (!name) return;
    if (!v.orig && cat(name)) { toast('That category already exists'); return; }
    enqueue({ kind: 'category', category: { Name: name, Type: v.type, Icon: v.icon, MonthlyBudget: v.type === 'EXPENSE' ? r2(num(v.budget)) : 0, Active: !v.hide } });
    closeModal(); render(); toast('Category saved');
  }
  if (kind === 'budget') {
    const c = cat(v.cat);
    if (num(v.usual) !== num(c.MonthlyBudget)) enqueue({ kind: 'category', category: { Name: c.Name, Type: c.Type, Icon: c.Icon, MonthlyBudget: r2(num(v.usual)), Active: true } });
    const cur = budgetFor(v.cat, v.ym);
    const monthVal = v.month.trim() === '' ? null : r2(num(v.month));
    if ((monthVal === null && cur.custom) || (monthVal !== null && (!cur.custom || monthVal !== cur.amount))) enqueue({ kind: 'budget', month: v.ym, category: v.cat, amount: monthVal });
    closeModal(); render(); toast('Budget saved');
  }
  if (kind === 'plan') {
    activeCats('EXPENSE').forEach(c => { const nv = r2(num(v['b_' + c.Name])); if (nv !== num(c.MonthlyBudget)) enqueue({ kind: 'category', category: { Name: c.Name, Type: c.Type, Icon: c.Icon, MonthlyBudget: nv, Active: true } }); });
    closeModal(); render(); toast('Budget saved');
  }
  if (kind === 'rate') {
    const code = String(v.cur).toUpperCase().replace(/[^A-Z]/g, ''); const rate = num(v.rate);
    if (!code || code === base() || !(rate > 0)) { toast('Enter a currency code and a rate above 0'); return; }
    enqueue({ kind: 'rate', currency: code, rate }); render(); toast('1 ' + base() + ' = ' + rate + ' ' + code);
  }
  if (kind === 'hhName') {
    busy(true);
    try { const r = await call(Object.assign({ action: 'setHouseholdName', name: v.name }, authBody())); if (!r.ok) throw new Error(r.message); db.settings.HouseholdName = v.name; saveAll(); render(); toast('Saved'); }
    catch (x) { toast(x.message || 'Needs internet'); busy(false); }
  }
  if (kind === 'pin') {
    const err = $('#pErr');
    if (v.n1 !== v.n2) { err.textContent = 'The new PINs are different'; return; }
    busy(true);
    try { const r = await call(Object.assign({ action: 'setPin', oldPin: v.old, newPin: v.n1 }, authBody())); if (!r.ok) throw new Error(r.message); await pull(false); saveAll(); f.reset(); toast('PIN changed'); }
    catch (x) { err.textContent = x.message || 'Needs internet'; }
    busy(false);
  }
});

/* ───────────── Start ───────────── */
window.addEventListener('online', () => { net.online = true; sync(); });
window.addEventListener('offline', () => { net.online = false; paintBadge(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => sync(), 60000);
if (!IS_GAS && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
applyTheme();
render();
if (cfg.deviceId) sync();
