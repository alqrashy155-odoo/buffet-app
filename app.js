/* =====================================================================
   تطبيق البوفية — إدارة الإيرادات والمصروفات وحركة النقدية
   واجهة مستوحاة من أودو — البيانات على Supabase (أو وضع تجريبي محلي)
   ===================================================================== */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
const CUR = CFG.CURRENCY || 'ر.س';
const APP = CFG.APP_NAME || 'البوفية';

// أنواع الحركات وأثرها على الصندوق
const TYPES = {
  sale:       { label: 'بيع',            sign:  1, cat: 'income',  color: 'green'  },
  expense:    { label: 'صرف',            sign: -1, cat: 'expense', color: 'red'    },
  withdrawal: { label: 'سحب من النقدية', sign: -1, cat: null,      color: 'orange' },
  adj_plus:   { label: 'تسوية +',        sign:  1, cat: null,      color: 'blue'   },
  adj_minus:  { label: 'تسوية −',        sign: -1, cat: null,      color: 'purple' },
  opening:    { label: 'رصيد افتتاحي',   sign:  1, cat: null,      color: 'gray'   },
  receipt:    { label: 'قبض من حساب',    sign:  1, cat: 'account', color: 'teal'   },
};
const TYPE_KEYS = Object.keys(TYPES);
// أنواع البنود الاختيارية لكل حركة
const OPTK = { withdrawal: ['account'], adj_plus: ['expense', 'income', 'account'], adj_minus: ['expense', 'income', 'account'] };
const KIND_LABEL = { income: 'إيراد', expense: 'مصروف', account: 'حساب' };
const KIND_ORDER = { income: 0, expense: 1, account: 2 };
const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const CLOSING_TAG = 'فرق جرد';

/* ------------------------------ أدوات ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n, cls = true) => `<span class="num ${cls ? (n < 0 ? 'neg' : n > 0 ? 'pos' : '') : ''}">${fmt(n)}</span>`;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const monthStart = s => s.slice(0, 8) + '01';
const monthEnd = s => { const d = new Date(s.slice(0, 7) + '-01T00:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return ymd(d); };
const addMonths = (s, n) => { const d = new Date(s.slice(0, 7) + '-01T00:00:00'); d.setMonth(d.getMonth() + n); return ymd(d); };
const monthLabel = s => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
const dt = s => s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
const initials = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const pick = p => ({ full_name: p.full_name, role: p.role, can_add: !!p.can_add, can_edit: !!p.can_edit, can_delete: !!p.can_delete, can_manage_cats: !!p.can_manage_cats });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 2600);
}
function confirmBox(title, body, okLabel = 'تأكيد', danger = false) {
  return new Promise(res => {
    $('#modalCard').innerHTML = `<div class="m-h">${esc(title)}</div><div class="m-b">${body}</div>
      <div class="m-f"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="mOk">${esc(okLabel)}</button>
      <button class="btn btn-secondary" id="mNo">إلغاء</button></div>`;
    $('#modal').classList.remove('hidden');
    const close = v => { $('#modal').classList.add('hidden'); res(v); };
    $('#mOk').onclick = () => close(true);
    $('#mNo').onclick = () => close(false);
  });
}
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/Invalid login/i.test(m)) return 'البريد أو كلمة المرور غير صحيحة';
  if (/row-level security|permission|PGRST116|NO_PERMISSION/i.test(m)) return 'ليس لديك صلاحية لهذه العملية';
  if (/foreign key|violates/i.test(m)) return 'لا يمكن الحذف: البند مستخدم في حركات — يمكنك إيقافه بدلاً من ذلك';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'تعذر الاتصال بالخادم — تحقق من الإنترنت';
  return m;
}

/* ============================ طبقة البيانات ============================ */
function supaDB() {
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  async function all(table, order) {
    let out = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select('*').order(order, { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      out = out.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  }
  const one = async q => { const { data, error } = await q; if (error) throw error; if (!data || (Array.isArray(data) && !data.length)) throw new Error('NO_PERMISSION'); return Array.isArray(data) ? data[0] : data; };
  return {
    async session() { const { data } = await sb.auth.getSession(); return data.session?.user || null; },
    async signIn(email, password) { const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error; return data.user; },
    async signOut() { await sb.auth.signOut(); },
    async changePassword(pw) { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; },
    profiles: () => all('profiles', 'created_at'),
    categories: () => all('categories', 'sort'),
    transactions: () => all('transactions', 'tx_date'),
    saveTx(t) {
      const row = { tx_date: t.tx_date, tx_type: t.tx_type, category_id: t.category_id || null, amount: t.amount, note: t.note || '' };
      return one(t.id ? sb.from('transactions').update(row).eq('id', t.id).select() : sb.from('transactions').insert(row).select());
    },
    deleteTx: id => one(sb.from('transactions').delete().eq('id', id).select()),
    saveCategory(c) {
      const row = { name: c.name, kind: c.kind, active: c.active, sort: c.sort };
      return one(c.id ? sb.from('categories').update(row).eq('id', c.id).select() : sb.from('categories').insert(row).select());
    },
    deleteCategory: id => one(sb.from('categories').delete().eq('id', id).select()),
    updateProfile: p => one(sb.from('profiles').update(pick(p)).eq('id', p.id).select()),
    subscribe(cb) {
      sb.channel('buffet-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, cb)
        .subscribe();
    },
  };
}

function demoDB() {
  const KEY = 'buffet_demo_v1';
  const ME = { id: 'demo-admin', email: 'demo@buffet.local' };
  let st;
  try { st = JSON.parse(localStorage.getItem(KEY)); } catch { st = null; }
  if (!st) st = seedDemo(ME.id);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  save();
  const nextId = k => (st.seq[k] = (st.seq[k] || 0) + 1);
  const clone = o => JSON.parse(JSON.stringify(o));
  return {
    async session() { return sessionStorage.getItem('demo_in') ? ME : null; },
    async signIn() { sessionStorage.setItem('demo_in', '1'); return ME; },
    async signOut() { sessionStorage.removeItem('demo_in'); },
    async changePassword() {},
    async profiles() { return clone(st.profiles); },
    async categories() { return clone(st.categories).sort((a, b) => a.sort - b.sort || a.id - b.id); },
    async transactions() { return clone(st.transactions).sort((a, b) => a.tx_date.localeCompare(b.tx_date) || a.id - b.id); },
    async saveTx(t) {
      const now = new Date().toISOString();
      if (t.id) { const r = st.transactions.find(x => x.id === t.id); Object.assign(r, { tx_date: t.tx_date, tx_type: t.tx_type, category_id: t.category_id || null, amount: t.amount, note: t.note || '', updated_at: now }); save(); return clone(r); }
      const r = { id: nextId('tx'), tx_date: t.tx_date, tx_type: t.tx_type, category_id: t.category_id || null, amount: t.amount, note: t.note || '', created_by: ME.id, created_at: now, updated_at: now };
      st.transactions.push(r); save(); return clone(r);
    },
    async deleteTx(id) { st.transactions = st.transactions.filter(x => x.id !== id); save(); },
    async saveCategory(c) {
      if (c.id) { const r = st.categories.find(x => x.id === c.id); Object.assign(r, { name: c.name, kind: c.kind, active: c.active, sort: c.sort }); save(); return clone(r); }
      const r = { id: nextId('cat'), name: c.name, kind: c.kind, active: c.active, sort: c.sort, created_at: new Date().toISOString() };
      st.categories.push(r); save(); return clone(r);
    },
    async deleteCategory(id) {
      if (st.transactions.some(t => t.category_id === id)) throw new Error('violates foreign key');
      st.categories = st.categories.filter(x => x.id !== id); save();
    },
    async updateProfile(p) { const r = st.profiles.find(x => x.id === p.id); Object.assign(r, pick(p)); save(); return clone(r); },
    subscribe() {},
  };
}

function seedDemo(uid) {
  const cats = [['مبيعات البوفية','income',1],['خبز','expense',10],['مياه','expense',20],['معلبات','expense',30],['أجبان','expense',40],['خضروات وفواكه','expense',50],['مشروبات','expense',60],['أخرى','expense',90]]
    .map(([name, kind, sort], i) => ({ id: i + 1, name, kind, sort, active: true, created_at: new Date().toISOString() }));
  const tx = []; let id = 0;
  const add = (tx_date, tx_type, category_id, amount, note, by = uid) => tx.push({ id: ++id, tx_date, tx_type, category_id, amount, note, created_by: by, created_at: tx_date + 'T10:00:00Z', updated_at: tx_date + 'T10:00:00Z' });
  const start = addDays(today(), -24);
  add(start, 'opening', null, 1500, 'رصيد الصندوق عند بدء استخدام التطبيق');
  let seed = 7; const rnd = (a, b) => { seed = (seed * 9301 + 49297) % 233280; return Math.round(a + (seed / 233280) * (b - a)); };
  for (let i = 0; i <= 24; i++) {
    const d = addDays(start, i);
    const by = i % 3 === 0 ? 'demo-brother' : uid;
    add(d, 'sale', 1, rnd(650, 1400), 'مبيعات اليوم', by);
    add(d, 'expense', 2, rnd(40, 90), 'خبز الصباح', by);
    if (i % 2 === 0) add(d, 'expense', 3, rnd(30, 80), 'كراتين مياه', by);
    if (i % 3 === 1) add(d, 'expense', 6, rnd(80, 220), 'خضار وفواكه', by);
    if (i % 4 === 2) add(d, 'expense', 5, rnd(90, 260), 'أجبان', by);
    if (i % 5 === 0) add(d, 'expense', 7, rnd(120, 340), 'مشروبات غازية وعصائر', by);
    if (i % 6 === 3) add(d, 'expense', 4, rnd(70, 180), 'معلبات', by);
    if (i % 7 === 6) add(d, 'withdrawal', null, rnd(1500, 3000), 'إيداع في البنك', by);
  }
  add(addDays(start, 10), 'adj_minus', null, 12.5, CLOSING_TAG + ' (عينة)');
  return {
    seq: { tx: id, cat: cats.length },
    profiles: [{ id: uid, full_name: 'محمد (تجريبي)', role: 'admin', can_add: true, can_edit: true, can_delete: true, can_manage_cats: true, created_at: new Date().toISOString() },
               { id: 'demo-brother', full_name: 'الأخ (تجريبي)', role: 'member', can_add: true, can_edit: true, can_delete: true, can_manage_cats: false, created_at: new Date().toISOString() }],
    categories: cats, transactions: tx,
  };
}

const DB = DEMO ? demoDB() : supaDB();

/* ============================== الحالة ============================== */
const S = {
  user: null, me: null, profiles: [], cats: [], txs: [],
  list: { q: '', type: '', cat: '', user: '', from: '', to: '', view: 'list', page: 0 },
  dashMonth: monthStart(today()),
  rep: { from: monthStart(today()), to: today() },
  dirty: false, charts: [],
};
const PAGE = 80;

async function loadAll() {
  const [p, c, t] = await Promise.all([DB.profiles(), DB.categories(), DB.transactions()]);
  S.profiles = p;
  S.cats = c;
  S.txs = t.map(x => ({ ...x, amount: Number(x.amount), category_id: x.category_id == null ? null : Number(x.category_id) }));
  S.me = S.profiles.find(x => x.id === S.user.id) || { id: S.user.id, full_name: S.user.email, role: 'member' };
  $('#fab') && $('#fab').classList.toggle('hidden', !can('add'));
}
const PERMS = { add: 'can_add', edit: 'can_edit', delete: 'can_delete', cats: 'can_manage_cats' };
const PERM_LABELS = { add: 'إضافة', edit: 'تعديل', delete: 'حذف', cats: 'إدارة البنود' };
const isAdmin = () => S.me?.role === 'admin';
const can = p => isAdmin() || !!S.me?.[PERMS[p]];
const canEdit = () => can('edit');
const catById = id => S.cats.find(c => c.id === id);
const catName = id => catById(id)?.name || '';
const userName = id => S.profiles.find(p => p.id === id)?.full_name || '—';
const signed = t => TYPES[t.tx_type].sign * t.amount;
const balanceBefore = d => round2(S.txs.filter(t => t.tx_date < d).reduce((s, t) => s + signed(t), 0));
const balanceUntil = d => round2(S.txs.filter(t => t.tx_date <= d).reduce((s, t) => s + signed(t), 0));
const inRange = (from, to) => S.txs.filter(t => (!from || t.tx_date >= from) && (!to || t.tx_date <= to));
const sumType = (arr, type) => round2(arr.filter(t => t.tx_type === type).reduce((s, t) => s + t.amount, 0));
const typeBadge = k => `<span class="badge b-${TYPES[k].color}">${TYPES[k].label}</span>`;

/* ============================== الهيكل ============================== */
function setCP(html) { $('#cp').innerHTML = html; }
function setMain(html) { destroyCharts(); $('#main').innerHTML = html; }
function destroyCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }
function crumb(parts) {
  return `<div class="breadcrumb">${parts.map((p, i) => (p.href && i < parts.length - 1 ? `<a href="${p.href}">${esc(p.t)}</a>` : `<span>${esc(p.t)}</span>`)
    + (i < parts.length - 1 ? '<span class="sep">/</span>' : '')).join('')}</div>`;
}
function setActiveNav(key) {
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === key));
  $('#navMenu').classList.remove('open');
}

/* ============================== الموجّه ============================== */
const routes = [
  [/^#\/dashboard$/, viewDashboard, 'dashboard'],
  [/^#\/transactions$/, viewTransactions, 'transactions'],
  [/^#\/new(?:\?type=(\w+))?$/, m => viewForm(null, m[1]), 'transactions'],
  [/^#\/tx\/(\d+)$/, m => viewForm(Number(m[1])), 'transactions'],
  [/^#\/closing$/, viewClosing, 'closing'],
  [/^#\/reports\/(\w+)$/, m => viewReports(m[1]), 'reports'],
  [/^#\/categories$/, viewCategories, 'settings'],
  [/^#\/users$/, viewUsers, 'settings'],
];
async function router() {
  if (!S.user) return;
  const h = location.hash || '#/dashboard';
  for (const [re, fn, nav] of routes) {
    const m = h.match(re);
    if (m) { setActiveNav(nav); S.dirty = false; window.scrollTo(0, 0); return fn(m); }
  }
  location.hash = '#/dashboard';
}
window.addEventListener('hashchange', () => {
  if (S.dirty && !confirm('توجد تعديلات غير محفوظة. هل تريد المغادرة؟')) { history.back(); return; }
  router();
});

/* ============================ لوحة المتابعة ============================ */
function viewDashboard() {
  const m0 = S.dashMonth, m1 = monthEnd(m0), td = today();
  const monthTx = inRange(m0, m1), todayTx = inRange(td, td);
  const sales = sumType(monthTx, 'sale'), exp = sumType(monthTx, 'expense'), wd = sumType(monthTx, 'withdrawal');
  const bal = balanceUntil('9999-12-31');
  const isCurrent = m0 === monthStart(td);

  setCP(`<div class="cp-left">${crumb([{ t: 'لوحة المتابعة' }])}</div>
    <div class="cp-right"><div class="pager">
      <button id="mPrev" title="الشهر السابق">›</button>
      <b style="color:var(--text);min-width:110px;text-align:center">${monthLabel(m0)}</b>
      <button id="mNext" title="الشهر التالي">‹</button>
      ${isCurrent ? '' : '<button class="btn btn-link btn-sm" id="mNow">الشهر الحالي</button>'}
    </div></div>`);

  const recent = [...S.txs].sort((a, b) => b.tx_date.localeCompare(a.tx_date) || b.id - a.id).slice(0, 8);
  const byCat = {};
  monthTx.filter(t => t.tx_type === 'expense').forEach(t => { const n = catName(t.category_id) || 'بدون بند'; byCat[n] = (byCat[n] || 0) + t.amount; });

  setMain(`
    ${!can('add') ? '' : `<div class="quick">
      <a class="q-sale" href="#/new?type=sale">＋ تسجيل بيع</a>
      <a class="q-expense" href="#/new?type=expense">− تسجيل صرف</a>
      <a class="q-withdrawal" href="#/new?type=withdrawal">⇠ سحب من النقدية</a>
      <a class="q-adj" href="#/closing">± إقفال / تسوية</a>
    </div>`}
    <div class="kpis">
      <div class="kpi main-kpi"><div class="k-l">رصيد الصندوق الآن</div><div class="k-v">${money(bal, false)} <small class="muted">${CUR}</small></div><div class="k-s">جميع الحركات حتى اليوم</div></div>
      <div class="kpi k-green"><div class="k-l">مبيعات اليوم</div><div class="k-v">${money(sumType(todayTx, 'sale'), false)}</div><div class="k-s">مصروف اليوم: ${fmt(sumType(todayTx, 'expense'))}</div></div>
      <div class="kpi k-blue"><div class="k-l">مبيعات ${MONTHS[Number(m0.slice(5, 7)) - 1]}</div><div class="k-v">${money(sales, false)}</div><div class="k-s">${monthTx.filter(t => t.tx_type === 'sale').length} حركة</div></div>
      <div class="kpi k-red"><div class="k-l">مصروفات الشهر</div><div class="k-v">${money(exp, false)}</div><div class="k-s">صافي الشهر: <b class="${sales - exp < 0 ? 'neg' : 'pos'}">${fmt(sales - exp)}</b></div></div>
      <div class="kpi k-orange"><div class="k-l">مسحوبات الشهر</div><div class="k-v">${money(wd, false)}</div><div class="k-s">من النقدية</div></div>
    </div>
    <div class="grid g-3">
      <div class="card"><div class="card-h">الحركة النقدية اليومية — ${monthLabel(m0)}<a class="btn btn-link btn-sm" href="#/reports/daily">التفاصيل</a></div><div class="card-b"><div class="chart-box"><canvas id="cFlow"></canvas></div></div></div>
      <div class="card"><div class="card-h">المصروفات حسب البند<a class="btn btn-link btn-sm" href="#/reports/bycat">التفاصيل</a></div><div class="card-b"><div class="chart-box">${Object.keys(byCat).length ? '<canvas id="cCat"></canvas>' : '<div class="empty">لا توجد مصروفات هذا الشهر</div>'}</div></div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h">آخر الحركات<a class="btn btn-link btn-sm" href="#/transactions">عرض الكل</a></div>
      ${txTable(recent, false)}
    </div>`);

  $('#mPrev').onclick = () => { S.dashMonth = addMonths(m0, -1); viewDashboard(); };
  $('#mNext').onclick = () => { S.dashMonth = addMonths(m0, 1); viewDashboard(); };
  $('#mNow') && ($('#mNow').onclick = () => { S.dashMonth = monthStart(td); viewDashboard(); });
  bindRowClicks();

  if (!window.Chart) return;
  Chart.defaults.font.family = '"IBM Plex Sans Arabic", Tahoma, sans-serif';
  const days = [], inA = [], outA = [], balA = [];
  let run = balanceBefore(m0);
  for (let d = m0; d <= m1; d = addDays(d, 1)) {
    const dTx = monthTx.filter(t => t.tx_date === d);
    const i = round2(dTx.filter(t => TYPES[t.tx_type].sign > 0).reduce((s, t) => s + t.amount, 0));
    const o = round2(dTx.filter(t => TYPES[t.tx_type].sign < 0).reduce((s, t) => s + t.amount, 0));
    run = round2(run + i - o);
    days.push(Number(d.slice(8))); inA.push(i); outA.push(o);
    balA.push(d <= td ? run : null);
  }
  S.charts.push(new Chart($('#cFlow'), {
    data: { labels: days, datasets: [
      { type: 'bar', label: 'داخل', data: inA, backgroundColor: '#5fb37f', borderRadius: 3, order: 2 },
      { type: 'bar', label: 'خارج', data: outA, backgroundColor: '#e28a7f', borderRadius: 3, order: 3 },
      { type: 'line', label: 'رصيد الصندوق', data: balA, borderColor: '#714B67', backgroundColor: '#714B67', tension: .3, pointRadius: 2, yAxisID: 'y1', order: 1 },
    ] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', rtl: true }, tooltip: { rtl: true, callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } } },
      scales: { x: { reverse: true, grid: { display: false } }, y: { beginAtZero: true, position: 'right' }, y1: { position: 'left', grid: { display: false } } } },
  }));
  if ($('#cCat')) {
    const labels = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    S.charts.push(new Chart($('#cCat'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: labels.map(l => round2(byCat[l])), backgroundColor: ['#714B67','#017E84','#d9822b','#1d6fb8','#c0392b','#7b4ea3','#5fb37f','#9aa0a6','#e0b84f','#3f8f8a'] }] },
      options: { maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'bottom', rtl: true }, tooltip: { rtl: true, callbacks: { label: c => `${c.label}: ${fmt(c.raw)}` } } } },
    }));
  }
}

/* ============================== الحركات ============================== */
function txTable(rows, withFoot = true) {
  if (!rows.length) return '<div class="empty">لا توجد حركات</div>';
  const tin = round2(rows.filter(t => TYPES[t.tx_type].sign > 0).reduce((s, t) => s + t.amount, 0));
  const tout = round2(rows.filter(t => TYPES[t.tx_type].sign < 0).reduce((s, t) => s + t.amount, 0));
  return `<div class="table-wrap"><table class="list"><thead><tr>
    <th>التاريخ</th><th>النوع</th><th>البند</th><th>البيان</th><th class="hide-m">بواسطة</th><th class="num">داخل</th><th class="num">خارج</th></tr></thead><tbody>
    ${rows.map(t => `<tr class="click" data-id="${t.id}">
      <td class="num" style="text-align:right">${t.tx_date}</td><td>${typeBadge(t.tx_type)}</td>
      <td>${esc(catName(t.category_id)) || '<span class="muted">—</span>'}</td>
      <td>${esc(t.note)}</td><td class="hide-m">${esc(userName(t.created_by))}</td>
      <td class="num pos">${TYPES[t.tx_type].sign > 0 ? fmt(t.amount) : ''}</td>
      <td class="num neg">${TYPES[t.tx_type].sign < 0 ? fmt(t.amount) : ''}</td></tr>`).join('')}
    </tbody>${withFoot ? `<tfoot><tr><td colspan="4">الإجمالي — الصافي: <span class="num ${tin - tout < 0 ? 'neg' : 'pos'}">${fmt(tin - tout)}</span></td><td class="hide-m"></td>
      <td class="num">${fmt(tin)}</td><td class="num">${fmt(tout)}</td></tr></tfoot>` : ''}</table></div>`;
}
function bindRowClicks(root = document) {
  $$('tr.click[data-id], .k-card[data-id]', root).forEach(r => r.onclick = () => location.hash = '#/tx/' + r.dataset.id);
}
function filteredTx() {
  const f = S.list, q = f.q.trim().toLowerCase();
  return S.txs.filter(t =>
    (!f.type || t.tx_type === f.type) &&
    (!f.cat || String(t.category_id) === f.cat) &&
    (!f.user || t.created_by === f.user) &&
    (!f.from || t.tx_date >= f.from) && (!f.to || t.tx_date <= f.to) &&
    (!q || [t.note, catName(t.category_id), userName(t.created_by), TYPES[t.tx_type].label, String(t.amount)].join(' ').toLowerCase().includes(q))
  ).sort((a, b) => b.tx_date.localeCompare(a.tx_date) || b.id - a.id);
}
function viewTransactions() {
  const f = S.list;
  setCP(`<div class="cp-left">${crumb([{ t: 'الحركات' }])}${can('add') ? '<a class="btn btn-primary" href="#/new">جديد</a>' : ''}
      <button class="btn btn-secondary" id="xlsTx" title="تصدير Excel">⬇ Excel</button></div>
    <div class="search"><span class="ico">🔍</span><input id="q" placeholder="بحث في البيان، البند، المستخدم..." value="${esc(f.q)}" /></div>
    <div class="cp-right"><div class="pager" id="pager"></div>
      <div class="view-switch"><button data-v="list" class="${f.view === 'list' ? 'on' : ''}" title="قائمة">☰</button><button data-v="kanban" class="${f.view === 'kanban' ? 'on' : ''}" title="بطاقات">▦</button></div></div>`);
  setMain(`<div class="filters">
      <span class="chip ${!f.type ? 'on' : ''}" data-t="">الكل</span>
      ${TYPE_KEYS.map(k => `<span class="chip ${f.type === k ? 'on' : ''}" data-t="${k}">${TYPES[k].label}</span>`).join('')}
      <label>البند <select id="fCat"><option value="">الكل</option>${S.cats.map(c => `<option value="${c.id}" ${f.cat === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>المستخدم <select id="fUser"><option value="">الكل</option>${S.profiles.map(p => `<option value="${p.id}" ${f.user === p.id ? 'selected' : ''}>${esc(p.full_name)}</option>`).join('')}</select></label>
      <label>من <input type="date" id="fFrom" value="${f.from}" /></label>
      <label>إلى <input type="date" id="fTo" value="${f.to}" /></label>
      <button class="btn btn-link btn-sm" id="fClear">مسح الفلاتر</button>
    </div><div id="txBody"></div>`);

  const draw = () => {
    const rows = filteredTx(), total = rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (f.page >= pages) f.page = pages - 1;
    const slice = rows.slice(f.page * PAGE, f.page * PAGE + PAGE);
    $('#pager').innerHTML = total ? `<span>${f.page * PAGE + 1}-${Math.min(total, (f.page + 1) * PAGE)} / ${total}</span>
      <button id="pPrev" ${f.page === 0 ? 'disabled' : ''}>›</button><button id="pNext" ${f.page >= pages - 1 ? 'disabled' : ''}>‹</button>` : '';
    $('#pPrev') && ($('#pPrev').onclick = () => { f.page--; draw(); });
    $('#pNext') && ($('#pNext').onclick = () => { f.page++; draw(); });
    const body = $('#txBody');
    if (f.view === 'kanban') {
      body.innerHTML = slice.length ? `<div class="kanban">${slice.map(t => `<div class="k-card bd-${TYPES[t.tx_type].color}" data-id="${t.id}">
        <div class="k-top">${typeBadge(t.tx_type)}<span class="k-amt ${TYPES[t.tx_type].sign < 0 ? 'neg' : 'pos'} num">${TYPES[t.tx_type].sign < 0 ? '−' : '+'}${fmt(t.amount)}</span></div>
        <div style="font-weight:600;margin-top:6px">${esc(catName(t.category_id)) || '&nbsp;'}</div>
        <div class="k-note">${esc(t.note) || '&nbsp;'}</div>
        <div class="k-foot"><span>${t.tx_date}</span><span class="avatar" title="${esc(userName(t.created_by))}">${esc(initials(userName(t.created_by)))}</span></div></div>`).join('')}</div>` : '<div class="empty">لا توجد حركات مطابقة</div>';
      // إجمالي أسفل البطاقات
      const tin = round2(rows.filter(t => TYPES[t.tx_type].sign > 0).reduce((s, t) => s + t.amount, 0));
      const tout = round2(rows.filter(t => TYPES[t.tx_type].sign < 0).reduce((s, t) => s + t.amount, 0));
      if (rows.length) body.insertAdjacentHTML('beforeend', `<div class="card" style="margin-top:12px"><div class="card-b" style="display:flex;gap:24px;flex-wrap:wrap">
        <span>داخل: <b class="pos num">${fmt(tin)}</b></span><span>خارج: <b class="neg num">${fmt(tout)}</b></span><span>الصافي: <b class="num">${fmt(tin - tout)}</b></span></div></div>`);
    } else {
      body.innerHTML = txTable(slice) + (pages > 1 ? `<p class="muted" style="font-size:12px">الإجمالي أعلاه للصفحة الحالية. لإجمالي الفترة كاملة استخدم التقارير.</p>` : '');
    }
    bindRowClicks(body);
  };
  draw();

  $('#q').oninput = debounce(e => { f.q = e.target.value; f.page = 0; draw(); }, 200);
  $$('.chip[data-t]').forEach(c => c.onclick = () => { f.type = c.dataset.t; f.page = 0; viewTransactions(); });
  $('#fCat').onchange = e => { f.cat = e.target.value; f.page = 0; draw(); };
  $('#fUser').onchange = e => { f.user = e.target.value; f.page = 0; draw(); };
  $('#fFrom').onchange = e => { f.from = e.target.value; f.page = 0; draw(); };
  $('#fTo').onchange = e => { f.to = e.target.value; f.page = 0; draw(); };
  $('#fClear').onclick = () => { Object.assign(f, { q: '', type: '', cat: '', user: '', from: '', to: '', page: 0 }); viewTransactions(); };
  $$('.view-switch button').forEach(b => b.onclick = () => { f.view = b.dataset.v; viewTransactions(); });
  $('#xlsTx').onclick = () => {
    const rows = filteredTx();
    exportXLSX('الحركات', [{
      title: 'سجل الحركات',
      head: ['التاريخ', 'النوع', 'البند', 'البيان', 'بواسطة', 'داخل', 'خارج'],
      rows: rows.map(t => [t.tx_date, TYPES[t.tx_type].label, catName(t.category_id), t.note, userName(t.created_by),
        TYPES[t.tx_type].sign > 0 ? t.amount : '', TYPES[t.tx_type].sign < 0 ? t.amount : '']),
    }]);
  };
}

/* ============================== النموذج ============================== */
function viewForm(id, presetType) {
  const existing = id ? S.txs.find(t => t.id === id) : null;
  if (id && !existing) { setCP(crumb([{ t: 'الحركات', href: '#/transactions' }, { t: 'غير موجودة' }])); setMain('<div class="empty">الحركة غير موجودة أو حُذفت</div>'); return; }
  if (!existing && !can('add')) { setCP(crumb([{ t: 'الحركات', href: '#/transactions' }, { t: 'جديد' }])); setMain('<div class="empty">ليس لديك صلاحية إضافة حركات — راجع المدير</div>'); return; }
  const editable = !existing || canEdit(existing);
  const rec = existing ? { ...existing } : { tx_date: today(), tx_type: TYPES[presetType] ? presetType : 'sale', category_id: null, amount: '', note: '' };
  const title = existing ? `${TYPES[rec.tx_type].label} #${rec.id}` : 'جديد';

  setCP(`<div class="cp-left">${crumb([{ t: 'الحركات', href: '#/transactions' }, { t: title }])}
      ${editable ? `<button class="btn btn-primary" id="fSave">حفظ</button>
      ${existing ? '' : '<button class="btn btn-secondary" id="fSaveNew">حفظ وجديد</button>'}
      <button class="btn btn-secondary" id="fDiscard">تجاهل</button>` : ''}
      ${existing && can('add') ? '<a class="btn btn-secondary" href="#/new">جديد</a>' : ''}
      ${existing && can('delete') ? '<button class="btn btn-danger" id="fDel">حذف</button>' : ''}</div>`);

  const catOptions = kind => {
    const list = S.cats.filter(c => c.kind === kind && (c.active || c.id === rec.category_id));
    return list.map(c => `<option value="${c.id}" ${c.id === rec.category_id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (موقوف)'}</option>`).join('');
  };

  const draw = () => {
    const T = TYPES[rec.tx_type];
    if (T.cat && !S.cats.some(c => c.id === rec.category_id && c.kind === T.cat)) {
      const first = S.cats.find(c => c.kind === T.cat && c.active); rec.category_id = first ? first.id : null;
    }
    if (!T.cat && !OPTK[rec.tx_type]) rec.category_id = null;
    if (OPTK[rec.tx_type] && rec.category_id && !OPTK[rec.tx_type].includes(catById(rec.category_id)?.kind)) rec.category_id = null;
    setMain(`<div class="form-sheet">
      ${!editable ? '<div class="readonly-note">للعرض فقط — ليس لديك صلاحية التعديل. راجع المدير.</div>' : ''}
      <div class="statusbar">${TYPE_KEYS.map(k => `<button type="button" data-type="${k}" class="t-${TYPES[k].color} ${rec.tx_type === k ? 'on' : ''}" ${editable ? '' : 'disabled'}>${TYPES[k].label}</button>`).join('')}</div>
      <div class="sheet-body">
        <div class="sheet-title">${typeBadge(rec.tx_type)} <span>${T.sign > 0 ? 'يُضاف إلى الصندوق' : 'يُخصم من الصندوق'}</span></div>
        <div class="fields">
          <label class="field"><span>المبلغ (${CUR})</span><input id="fAmt" class="amount-input num" inputmode="decimal" autocomplete="off" value="${rec.amount === '' ? '' : rec.amount}" placeholder="0.00" ${editable ? '' : 'disabled'} /></label>
          <label class="field"><span>التاريخ</span><input type="date" id="fDate" value="${rec.tx_date}" ${editable ? '' : 'disabled'} /></label>
          ${OPTK[rec.tx_type] ? `<label class="field"><span>${rec.tx_type === 'withdrawal' ? 'الحساب (اختياري)' : 'البند (اختياري)'}</span><select id="fCatSel" ${editable ? '' : 'disabled'}><option value="">${rec.tx_type === 'withdrawal' ? '— بدون حساب (مسحوبات عامة) —' : '— بدون بند (تسوية الصندوق) —'}</option>${OPTK[rec.tx_type].map(k => catOptions(k)).join('')}</select></label>` : T.cat ? `<label class="field"><span>${T.cat === 'account' ? 'الحساب' : 'البند'}</span><select id="fCatSel" ${editable ? '' : 'disabled'}>${catOptions(T.cat) || '<option value="">— أضف بنداً من الإعدادات —</option>'}</select></label>` : '<div class="field"><span>البند</span><span class="muted">لا يلزم لهذا النوع</span></div>'}
          ${existing ? `<div class="field"><span>بواسطة</span><span>${esc(userName(rec.created_by))}</span></div>` : ''}
          <label class="field full"><span>البيان</span><textarea id="fNote" placeholder="${rec.tx_type === 'withdrawal' ? 'مثال: إيداع في البنك / سحب شخصي' : rec.tx_type.startsWith('adj') ? 'سبب التسوية' : 'وصف مختصر'}" ${editable ? '' : 'disabled'}>${esc(rec.note)}</textarea></label>
        </div>
      </div>
      ${existing ? `<div class="meta"><span>أُنشئت: ${dt(rec.created_at)}</span><span>آخر تعديل: ${dt(rec.updated_at)}</span><span>رصيد الصندوق بعد يوم ${rec.tx_date}: <b class="num">${fmt(balanceUntil(rec.tx_date))}</b></span></div>` : ''}
    </div>`);
    $$('.statusbar button').forEach(b => b.onclick = () => { collect(); rec.tx_type = b.dataset.type; S.dirty = true; draw(); });
    $$('#main input, #main select, #main textarea').forEach(el => el.addEventListener('input', () => S.dirty = true));
    const amt = $('#fAmt'); if (editable && !existing) amt.focus();
    amt && amt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(!existing); } });
  };
  const collect = () => {
    if (!editable) return;
    rec.amount = $('#fAmt').value.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،\s]/g, '').replace('٫', '.');
    rec.tx_date = $('#fDate').value;
    rec.note = $('#fNote').value.trim();
    if ($('#fCatSel')) rec.category_id = $('#fCatSel').value ? Number($('#fCatSel').value) : null;
  };
  const save = async andNew => {
    collect();
    const amount = round2(rec.amount);
    if (!(amount > 0)) { toast('أدخل مبلغاً صحيحاً أكبر من صفر', 'err'); $('#fAmt').focus(); return; }
    if (!rec.tx_date) { toast('أدخل التاريخ', 'err'); return; }
    if (TYPES[rec.tx_type].cat && !rec.category_id) { toast('اختر البند', 'err'); return; }
    try {
      $$('#cp button').forEach(b => b.disabled = true);
      const saved = await DB.saveTx({ ...rec, amount });
      await refresh(false);
      S.dirty = false;
      toast('تم الحفظ ✓', 'ok');
      if (andNew) { const keep = rec.tx_type; location.hash = '#/new?type=' + keep; if (location.hash === '#/new?type=' + keep) viewForm(null, keep); }
      else location.hash = '#/tx/' + saved.id;
    } catch (e) { toast(errMsg(e), 'err'); $$('#cp button').forEach(b => b.disabled = false); }
  };
  draw();
  $('#fSave') && ($('#fSave').onclick = () => save(false));
  $('#fSaveNew') && ($('#fSaveNew').onclick = () => save(true));
  $('#fDiscard') && ($('#fDiscard').onclick = () => { S.dirty = false; existing ? viewForm(id) : (location.hash = '#/transactions'); });
  $('#fDel') && ($('#fDel').onclick = async () => {
    if (!await confirmBox('حذف الحركة', `سيتم حذف ${TYPES[existing.tx_type].label} بمبلغ <b class="num">${fmt(existing.amount)}</b> بتاريخ ${existing.tx_date}. لا يمكن التراجع.`, 'حذف', true)) return;
    try { await DB.deleteTx(existing.id); await refresh(false); S.dirty = false; toast('تم الحذف'); location.hash = '#/transactions'; }
    catch (e) { toast(errMsg(e), 'err'); }
  });
}

/* ============================ الإقفال اليومي ============================ */
const DENOMS = [500, 200, 100, 50, 20, 10, 5, 1];
function viewClosing() {
  let date = today();
  setCP(`<div class="cp-left">${crumb([{ t: 'الإقفال اليومي' }])}</div>`);
  const past = S.txs.filter(t => t.tx_type.startsWith('adj') && t.note.startsWith(CLOSING_TAG)).sort((a, b) => b.tx_date.localeCompare(a.tx_date) || b.id - a.id).slice(0, 15);
  setMain(`${can('add') ? '' : '<div class="readonly-note" style="margin-bottom:12px">ليس لديك صلاحية الإضافة، لذلك لا يمكنك تسجيل الإقفال.</div>'}<div class="help">عُدّ النقدية الموجودة فعلاً في الصندوق، وسيقارنها التطبيق بالرصيد الدفتري. إذا وُجد فرق يُسجَّل تلقائياً كحركة <b>تسوية +</b> أو <b>تسوية −</b> حتى يتطابق الرصيد.</div>
    <div class="grid g-2">
      <div class="card"><div class="card-h">جرد النقدية <label style="display:flex;gap:6px;align-items:center;font-weight:400">التاريخ <input type="date" id="cDate" value="${date}" /></label></div>
        <div class="card-b">
          <div class="denoms">${DENOMS.map(d => `<label class="denom"><b>${d}</b>×<input type="number" min="0" step="1" inputmode="numeric" data-d="${d}" placeholder="0" /></label>`).join('')}</div>
          <label style="margin-top:10px;display:flex;align-items:center;gap:8px">فكّة / معدن / أخرى <input type="text" inputmode="decimal" id="cCoins" placeholder="0.00" style="width:140px" /></label>
          <p class="muted" style="margin:10px 0 4px">أو أدخل المبلغ الإجمالي مباشرة:</p>
          <input type="text" inputmode="decimal" id="cTotal" class="amount-input num" placeholder="0.00" style="width:100%;font-size:20px" />
        </div></div>
      <div class="card"><div class="card-h">المطابقة</div><div class="card-b">
          <div class="close-sum">
            <div class="row"><span>الرصيد الدفتري حتى نهاية اليوم</span><b class="num" id="cBook"></b></div>
            <div class="row"><span>النقدية الفعلية (الجرد)</span><b class="num" id="cCount">0.00</b></div>
            <div class="row diff"><span>الفرق</span><b class="num" id="cDiff">—</b></div>
          </div>
          <label style="margin-top:12px">ملاحظة<textarea id="cNote" placeholder="اختياري"></textarea></label>
          <button class="btn btn-primary btn-block" id="cPost" style="margin-top:12px" disabled>تسجيل الإقفال</button>
        </div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h">آخر تسويات الجرد</div>${txTable(past, false)}</div>`);
  bindRowClicks();
  const num = v => Number(String(v || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،\s]/g, '').replace('٫', '.')) || 0;
  let counted = null;
  const calc = (fromTotal) => {
    const book = balanceUntil(date);
    $('#cBook').textContent = fmt(book);
    if (!fromTotal) {
      const anyD = $$('[data-d]').some(i => i.value !== '') || $('#cCoins').value !== '';
      counted = anyD ? round2($$('[data-d]').reduce((s, i) => s + num(i.value) * Number(i.dataset.d), 0) + num($('#cCoins').value)) : (counted ?? null);
      if (anyD) $('#cTotal').value = fmt(counted);
    } else counted = $('#cTotal').value === '' ? null : round2(num($('#cTotal').value));
    $('#cCount').textContent = counted == null ? '—' : fmt(counted);
    const diff = counted == null ? null : round2(counted - book);
    const el = $('#cDiff');
    el.textContent = diff == null ? '—' : (diff > 0 ? '+' : '') + fmt(diff);
    el.className = 'num ' + (diff > 0 ? 'pos' : diff < 0 ? 'neg' : '');
    $('#cPost').disabled = counted == null || !can('add');
    $('#cPost').textContent = diff === 0 ? 'الصندوق مطابق ✓ (لا توجد تسوية)' : 'تسجيل الإقفال والتسوية';
    return { book, diff };
  };
  calc();
  $('#cDate').onchange = e => { date = e.target.value || today(); calc(); };
  $$('[data-d], #cCoins').forEach(i => i.oninput = () => calc(false));
  $('#cTotal').oninput = () => { $$('[data-d]').forEach(i => i.value = ''); $('#cCoins').value = ''; calc(true); };
  $('#cPost').onclick = async () => {
    const { book, diff } = calc($('#cTotal').value !== '' && !$$('[data-d]').some(i => i.value));
    if (diff === 0) { toast('الصندوق مطابق — لا حاجة لتسوية', 'ok'); return; }
    const type = diff > 0 ? 'adj_plus' : 'adj_minus';
    if (!await confirmBox('تأكيد الإقفال', `سيتم تسجيل <b>${TYPES[type].label}</b> بمبلغ <b class="num">${fmt(Math.abs(diff))}</b> بتاريخ ${date}.`)) return;
    const extra = $('#cNote').value.trim();
    try {
      await DB.saveTx({ tx_date: date, tx_type: type, category_id: null, amount: Math.abs(diff),
        note: `${CLOSING_TAG} — الدفتري ${fmt(book)} / الفعلي ${fmt(counted)}${extra ? ' — ' + extra : ''}` });
      await refresh(false); toast('تم تسجيل الإقفال ✓', 'ok'); viewClosing();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
}

/* ============================== التقارير ============================== */
const REPORTS = {
  statement: 'كشف حركة الصندوق',
  summary: 'ملخص الإيرادات والمصروفات',
  bycat: 'حسب البند (شهري)',
  daily: 'الملخص اليومي',
  item: 'حركة البند',
  ledger: 'دفتر الأستاذ',
  trial: 'ميزان المراجعة',
};
/* ---------- دفتر الأستاذ (قيد مزدوج: الصندوق مقابل حساب البند) ---------- */
const CASH = 'cash';
const VIRT = { v_open: 'رصيد افتتاحي / رأس المال', v_adj: 'فروقات وتسويات الصندوق', v_wd: 'مسحوبات ومقبوضات عامة' };
function counterAcc(t) {
  if (t.category_id) return 'c' + t.category_id;
  return t.tx_type === 'opening' ? 'v_open' : (t.tx_type === 'withdrawal' || t.tx_type === 'receipt') ? 'v_wd' : 'v_adj';
}
function entries(t) { const ca = counterAcc(t); return TYPES[t.tx_type].sign > 0 ? { dr: CASH, cr: ca } : { dr: ca, cr: CASH }; }
function accName(a) { if (a === CASH) return 'الصندوق (النقدية)'; if (VIRT[a]) return VIRT[a]; return catName(Number(String(a).slice(1))) || '—'; }
function accKind(a) { if (a === CASH) return 'نقدية'; if (VIRT[a]) return 'نظامي'; return KIND_LABEL[catById(Number(a.slice(1)))?.kind] || ''; }
function allAccounts() { const s = new Set([CASH]); S.cats.forEach(c => s.add('c' + c.id)); S.txs.forEach(t => s.add(counterAcc(t))); return [...s]; }
function ledgerHeader() {
  const accs = allAccounts(), k = a => catById(Number(a.slice(1)))?.kind;
  const grp = (label, f) => { const xs = accs.filter(f); return xs.length ? `<optgroup label="${label}">${xs.map(a => `<option value="${a}" ${a === S.rep.acc ? 'selected' : ''}>${esc(accName(a))}</option>`).join('')}</optgroup>` : ''; };
  return `<div class="filters no-print"><label>الحساب <select id="rAcc" style="min-width:230px;font-weight:600;color:var(--text)">
    ${grp('النقدية', a => a === CASH)}${grp('الحسابات', a => a[0] === 'c' && k(a) === 'account')}${grp('الإيرادات', a => a[0] === 'c' && k(a) === 'income')}${grp('المصروفات', a => a[0] === 'c' && k(a) === 'expense')}${grp('حسابات نظامية', a => !!VIRT[a])}
  </select></label><span class="muted" style="font-size:12px">الرصيد الموجب = مدين، والسالب = دائن</span></div>`;
}
function reportData(key, from, to) {
  const rows = inRange(from, to);
  const open = balanceBefore(from);
  if (key === 'statement') {
    let run = open;
    const body = [{ c: ['', '', '', 'رصيد أول المدة', '', '', '', open], cls: 'opening' }];
    rows.forEach(t => {
      run = round2(run + signed(t));
      body.push({ c: [t.tx_date, TYPES[t.tx_type].label, catName(t.category_id), t.note, userName(t.created_by),
        TYPES[t.tx_type].sign > 0 ? t.amount : '', TYPES[t.tx_type].sign < 0 ? t.amount : '', run], id: t.id });
    });
    const tin = round2(rows.filter(t => TYPES[t.tx_type].sign > 0).reduce((s, t) => s + t.amount, 0));
    const tout = round2(rows.filter(t => TYPES[t.tx_type].sign < 0).reduce((s, t) => s + t.amount, 0));
    return { title: REPORTS.statement, head: ['التاريخ', 'النوع', 'البند', 'البيان', 'بواسطة', 'داخل', 'خارج', 'الرصيد'], numCols: [5, 6, 7],
      rows: body, foot: ['', '', '', 'رصيد آخر المدة', '', tin, tout, round2(open + tin - tout)] };
  }
  if (key === 'summary') {
    const byCat = kind => S.cats.filter(c => c.kind === kind).map(c => [c.name, round2(rows.filter(t => t.category_id === c.id && t.tx_type === (kind === 'income' ? 'sale' : 'expense')).reduce((s, t) => s + t.amount, 0))]).filter(r => r[1]);
    const inc = byCat('income'), exp = byCat('expense');
    const ti = sumType(rows, 'sale'), te = sumType(rows, 'expense'), tw = sumType(rows, 'withdrawal'), tr = sumType(rows, 'receipt');
    const ap = sumType(rows, 'adj_plus'), am = sumType(rows, 'adj_minus'), op = sumType(rows, 'opening');
    const body = [
      { c: ['الإيرادات', ''], cls: 'section' }, ...inc.map(r => ({ c: r })), { c: ['إجمالي الإيرادات', ti], cls: 'total' },
      { c: ['المصروفات', ''], cls: 'section' }, ...exp.map(r => ({ c: r })), { c: ['إجمالي المصروفات', te], cls: 'total' },
      { c: ['صافي التشغيل (الإيرادات − المصروفات)', round2(ti - te)], cls: 'grand' },
      { c: ['حركة الصندوق', ''], cls: 'section' },
      { c: ['رصيد أول المدة', open] },
      ...(op ? [{ c: ['+ أرصدة افتتاحية', op] }] : []),
      { c: ['+ المبيعات', ti] }, { c: ['− المصروفات', -te] }, { c: ['− المسحوبات من النقدية', -tw] },
      ...(tr ? [{ c: ['+ المقبوضات من الحسابات', tr] }] : []),
      { c: ['± صافي التسويات', round2(ap - am)] },
      { c: ['رصيد آخر المدة', round2(open + op + ti - te - tw + tr + ap - am)], cls: 'grand' },
    ];
    return { title: REPORTS.summary, head: ['البيان', `المبلغ (${CUR})`], numCols: [1], rows: body };
  }
  if (key === 'bycat') {
    const months = []; for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) months.push(m);
    const cell = (c, m) => round2((c.kind === 'expense' ? -1 : 1) * rows.filter(t => t.category_id === c.id && t.tx_date.slice(0, 7) === m.slice(0, 7)).reduce((s, t) => s + signed(t), 0));
    const build = kind => {
      const cats = S.cats.filter(c => c.kind === kind);
      const lines = cats.map(c => { const v = months.map(m => cell(c, m)); return { name: c.name, v, tot: round2(v.reduce((a, b) => a + b, 0)) }; }).filter(l => l.tot);
      const grand = round2(lines.reduce((s, l) => s + l.tot, 0));
      return { lines, grand, colTot: months.map((_, i) => round2(lines.reduce((s, l) => s + l.v[i], 0))) };
    };
    const I = build('income'), E = build('expense');
    const pct = (v, g) => g ? round2(v / g * 100) + '%' : '';
    const body = [
      { c: ['الإيرادات', ...months.map(() => ''), '', ''], cls: 'section' },
      ...I.lines.map(l => ({ c: [l.name, ...l.v, l.tot, pct(l.tot, I.grand)] })),
      { c: ['إجمالي الإيرادات', ...I.colTot, I.grand, I.grand ? '100%' : ''], cls: 'total' },
      { c: ['المصروفات', ...months.map(() => ''), '', ''], cls: 'section' },
      ...E.lines.map(l => ({ c: [l.name, ...l.v, l.tot, pct(l.tot, E.grand)] })),
      { c: ['إجمالي المصروفات', ...E.colTot, E.grand, E.grand ? '100%' : ''], cls: 'total' },
      { c: ['الصافي', ...months.map((_, i) => round2(I.colTot[i] - E.colTot[i])), round2(I.grand - E.grand), ''], cls: 'grand' },
    ];
    return { title: REPORTS.bycat, head: ['البند', ...months.map(monthLabel), 'الإجمالي', 'النسبة'], numCols: [...months.map((_, i) => i + 1), months.length + 1], rows: body };
  }
  if (key === 'ledger') {
    const accs = allAccounts();
    const acc = accs.includes(S.rep.acc) ? S.rep.acc : CASH; S.rep.acc = acc;
    const touch = t => { const e = entries(t); return e.dr === acc || e.cr === acc; };
    const eff = t => { const e = entries(t); return (e.dr === acc ? t.amount : 0) - (e.cr === acc ? t.amount : 0); };
    const open = round2(S.txs.filter(t => t.tx_date < from && touch(t)).reduce((s, t) => s + eff(t), 0));
    let run = open, td = 0, tc = 0;
    const body = [{ c: ['', 'رصيد أول المدة', '', '', '', '', open], cls: 'opening' }];
    rows.filter(touch).forEach(t => {
      const e = entries(t), dr = e.dr === acc ? t.amount : '', cr = e.cr === acc ? t.amount : '';
      run = round2(run + eff(t)); if (dr) td = round2(td + dr); if (cr) tc = round2(tc + cr);
      body.push({ c: [t.tx_date, TYPES[t.tx_type].label + (t.note ? ' — ' + t.note : ''), accName(e.dr === acc ? e.cr : e.dr), userName(t.created_by), dr, cr, run], id: t.id });
    });
    return { title: `${REPORTS.ledger}: ${accName(acc)}`, head: ['التاريخ', 'البيان', 'الحساب المقابل', 'بواسطة', 'مدين', 'دائن', 'الرصيد'], numCols: [4, 5, 6], rows: body,
      foot: ['', 'رصيد آخر المدة', '', '', td, tc, run] };
  }
  if (key === 'trial') {
    const accs = allAccounts(), bal = {};
    accs.forEach(a => bal[a] = { o: 0, d: 0, c: 0 });
    S.txs.forEach(t => {
      if (t.tx_date > to) return;
      const e = entries(t);
      if (t.tx_date < from) { bal[e.dr].o += t.amount; bal[e.cr].o -= t.amount; }
      else { bal[e.dr].d += t.amount; bal[e.cr].c += t.amount; }
    });
    const ord = a => a === CASH ? -1 : VIRT[a] ? 9 : (KIND_ORDER[catById(Number(a.slice(1)))?.kind] ?? 8) + 1;
    const list = accs.filter(a => round2(bal[a].o) || round2(bal[a].d) || round2(bal[a].c)).sort((x, y) => ord(x) - ord(y) || accName(x).localeCompare(accName(y), 'ar'));
    const T = [0, 0, 0, 0, 0];
    const body = list.map(a => {
      const o = round2(bal[a].o), d = round2(bal[a].d), c = round2(bal[a].c), cl = round2(o + d - c);
      const v = [o, d, c, cl > 0 ? cl : '', cl < 0 ? -cl : ''];
      v.forEach((x, i) => T[i] = round2(T[i] + (Number(x) || 0)));
      return { c: [accName(a), accKind(a), ...v], acc: a };
    });
    return { title: REPORTS.trial, head: ['الحساب', 'النوع', 'رصيد أول المدة', 'حركة مدين', 'حركة دائن', 'رصيد مدين', 'رصيد دائن'], numCols: [2, 3, 4, 5, 6], rows: body,
      foot: ['الإجمالي', T[3] === T[4] ? '✓ متوازن' : '✗ غير متوازن', ...T] };
  }
  if (key === 'item') {
    const cat = catById(Number(S.rep.cat)) || S.cats.find(c => c.kind === 'expense') || S.cats[0];
    if (!cat) return { title: REPORTS.item, head: ['—'], numCols: [], rows: [] };
    S.rep.cat = String(cat.id);
    const isExp = cat.kind === 'expense';
    const of = t => t.category_id === cat.id;
    const open = round2(S.txs.filter(t => of(t) && t.tx_date < from).reduce((s, t) => s + signed(t), 0));
    const lines = rows.filter(of);
    let run = open, tin = 0, tout = 0;
    const body = [{ c: ['', '', 'رصيد البند قبل الفترة', '', '', '', open], cls: 'opening' }];
    lines.forEach(t => {
      const v = signed(t); run = round2(run + v);
      if (v > 0) tin = round2(tin + v); else tout = round2(tout - v);
      body.push({ c: [t.tx_date, TYPES[t.tx_type].label, t.note, userName(t.created_by), v > 0 ? t.amount : '', v < 0 ? t.amount : '', run], id: t.id });
    });
    const net = isExp ? round2(tout - tin) : round2(tin - tout);
    const days = Math.max(1, Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 864e5) + 1);
    const kindTotal = cat.kind === 'account' ? 0 : sumType(rows, isExp ? 'expense' : 'sale');
    const pFrom = addDays(from, -days), pTo = addDays(from, -1);
    const pl = inRange(pFrom, pTo).filter(of).reduce((s, t) => s + signed(t), 0);
    const prev = round2(isExp ? -pl : pl);
    return { title: `${REPORTS.item}: ${cat.name}`, head: ['التاريخ', 'النوع', 'البيان', 'بواسطة', 'داخل (+)', 'خارج (−)', 'الرصيد'], numCols: [4, 5, 6], rows: body,
      foot: [`الإجمالي (${lines.length} حركة)`, '', 'رصيد البند آخر الفترة', '', tin, tout, run],
      stats: { cat, total: net, tin, tout, count: lines.length, avg: lines.length ? round2(net / lines.length) : 0, perDay: round2(net / days), share: kindTotal ? round2(net / kindTotal * 100) : 0, prev, days } };
  }
  if (key === 'daily') {
    const days = [...new Set(rows.map(t => t.tx_date))].sort();
    let run = open; const tot = [0, 0, 0, 0, 0];
    const body = [{ c: ['رصيد أول المدة', '', '', '', '', '', open], cls: 'opening' }];
    days.forEach(d => {
      const r = rows.filter(t => t.tx_date === d);
      const s = sumType(r, 'sale') + sumType(r, 'opening'), e = sumType(r, 'expense'), w = round2(sumType(r, 'withdrawal') - sumType(r, 'receipt'));
      const a = round2(sumType(r, 'adj_plus') - sumType(r, 'adj_minus')), net = round2(s - e - w + a);
      run = round2(run + net);
      [s, e, w, a, net].forEach((v, i) => tot[i] = round2(tot[i] + v));
      body.push({ c: [d, s, e, w, a, net, run] });
    });
    return { title: REPORTS.daily, head: ['اليوم', 'مبيعات (+افتتاحي)', 'مصروفات', 'مسحوبات − مقبوضات', 'تسويات ±', 'صافي اليوم', 'رصيد الصندوق'], numCols: [1, 2, 3, 4, 5, 6],
      rows: body, foot: ['الإجمالي', ...tot, run] };
  }
}
function renderReport(R) {
  const cell = (v, i) => R.numCols.includes(i) ? `<td class="num">${v === '' || v == null ? '' : (typeof v === 'number' ? `<span class="${v < 0 ? 'neg' : ''}">${fmt(v)}</span>` : esc(v))}</td>` : `<td>${esc(v)}</td>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>${R.head.map((h, i) => `<th class="${R.numCols.includes(i) ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${R.rows.length ? R.rows.map(r => `<tr class="${r.cls || ''} ${r.id || r.acc ? 'click' : ''}" ${r.id ? `data-id="${r.id}"` : ''} ${r.acc ? `data-acc="${r.acc}" title="عرض دفتر الأستاذ"` : ''}>${r.c.map(cell).join('')}</tr>`).join('') : `<tr><td colspan="${R.head.length}" class="empty">لا توجد بيانات</td></tr>`}</tbody>
    ${R.foot ? `<tfoot><tr>${R.foot.map(cell).join('')}</tr></tfoot>` : ''}</table></div>`;
}
function itemHeader(R) {
  const st = R.stats;
  const opts = ['expense', 'income', 'account'].map(kind => `<optgroup label="${{ expense: 'المصروفات', income: 'الإيرادات', account: 'الحسابات' }[kind]}">${S.cats.filter(c => c.kind === kind).map(c => `<option value="${c.id}" ${String(c.id) === S.rep.cat ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (موقوف)'}</option>`).join('')}</optgroup>`).join('');
  const sel = `<div class="filters no-print"><label>البند <select id="rCat" style="min-width:200px;font-weight:600;color:var(--text)">${opts}</select></label></div>`;
  if (!st) return sel;
  const diff = round2(st.total - st.prev), pct = st.prev ? round2(diff / st.prev * 100) : null, up = diff > 0;
  const isExp = st.cat.kind === 'expense';
  return `${sel}<div class="kpis">
    <div class="kpi main-kpi"><div class="k-l">صافي ${isExp ? 'مصروف' : 'إيراد'} ${esc(st.cat.name)}</div><div class="k-v">${money(st.total, false)} <small class="muted">${CUR}</small></div><div class="k-s">${st.count} حركة — داخل ${fmt(st.tin)} / خارج ${fmt(st.tout)}</div></div>
    <div class="kpi k-blue"><div class="k-l">متوسط الحركة</div><div class="k-v">${money(st.avg, false)}</div><div class="k-s">لكل عملية ${isExp ? 'شراء' : 'بيع'}</div></div>
    <div class="kpi k-orange"><div class="k-l">المتوسط اليومي</div><div class="k-v">${money(st.perDay, false)}</div><div class="k-s">على ${st.days} يوم</div></div>
    <div class="kpi k-green"><div class="k-l">النسبة من ${isExp ? 'المصروفات' : 'الإيرادات'}</div><div class="k-v">${st.share}%</div><div class="k-s">في نفس الفترة</div></div>
    <div class="kpi ${up === isExp ? 'k-red' : 'k-green'}"><div class="k-l">مقارنة بالفترة السابقة</div><div class="k-v"><span class="num ${diff === 0 ? '' : (up === isExp ? 'neg' : 'pos')}">${diff > 0 ? '+' : ''}${fmt(diff)}</span></div><div class="k-s">${pct == null ? 'لا توجد بيانات سابقة' : (pct > 0 ? '+' : '') + pct + '%'} — السابقة: ${fmt(st.prev)}</div></div>
  </div>
  <div class="card no-print" style="margin-bottom:16px"><div class="card-h">${esc(st.cat.name)} — آخر 6 أشهر</div><div class="card-b"><div class="chart-box" style="height:220px"><canvas id="cItem"></canvas></div></div></div>`;
}
function drawItemChart(R, to) {
  if (!window.Chart || !$('#cItem') || !R.stats) return;
  const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(to, -i));
  const k = R.stats.cat.kind === 'expense' ? -1 : 1;
  const vals = months.map(m => round2(k * S.txs.filter(t => t.category_id === R.stats.cat.id && t.tx_date.slice(0, 7) === m.slice(0, 7)).reduce((s, t) => s + signed(t), 0)));
  S.charts.push(new Chart($('#cItem'), {
    type: 'bar',
    data: { labels: months.map(monthLabel), datasets: [{ label: R.stats.cat.name, data: vals, backgroundColor: R.stats.cat.kind === 'expense' ? '#e28a7f' : '#5fb37f', borderRadius: 4 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { label: c => fmt(c.raw) } } }, scales: { x: { reverse: true, grid: { display: false } }, y: { beginAtZero: true, position: 'right' } } },
  }));
}
function viewReports(key) {
  if (!REPORTS[key]) key = 'statement';
  const r = S.rep, td = today();
  const presets = [
    ['اليوم', td, td], ['أمس', addDays(td, -1), addDays(td, -1)],
    ['هذا الشهر', monthStart(td), td], ['الشهر الماضي', addMonths(td, -1), monthEnd(addMonths(td, -1))],
    ['آخر 3 أشهر', addMonths(td, -2), td], ['هذه السنة', td.slice(0, 4) + '-01-01', td],
  ];
  setCP(`<div class="cp-left">${crumb([{ t: 'التقارير', href: '#/reports/statement' }, { t: REPORTS[key] }])}
      <button class="btn btn-secondary" id="rXls">⬇ Excel</button><button class="btn btn-secondary" id="rPrint">🖨 طباعة / PDF</button></div>
    <div class="cp-right"><label>من <input type="date" id="rFrom" value="${r.from}" /></label><label>إلى <input type="date" id="rTo" value="${r.to}" /></label></div>`);
  const R = reportData(key, r.from, r.to);
  setMain(`<div class="tabs">${Object.entries(REPORTS).map(([k, t]) => `<a href="#/reports/${k}" class="${k === key ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="filters">${presets.map(([t, a, b]) => `<span class="chip ${r.from === a && r.to === b ? 'on' : ''}" data-a="${a}" data-b="${b}">${t}</span>`).join('')}</div>
    <div class="report-head"><h2>${esc(APP)} — ${esc(R.title)}</h2><div>الفترة من ${r.from} إلى ${r.to} — العملة: ${CUR}</div><div style="font-size:11px">طُبع في ${dt(new Date().toISOString())} بواسطة ${esc(S.me.full_name)}</div></div>
    ${key === 'item' ? itemHeader(R) : ''}${key === 'ledger' ? ledgerHeader() : ''}${key === 'trial' ? '<div class="help no-print">ميزان المراجعة حتى نهاية الفترة. اضغط على أي حساب لفتح دفتر الأستاذ الخاص به.</div>' : ''}
    ${renderReport(R)}`);
  if (key === 'item') drawItemChart(R, r.to);
  bindRowClicks();
  const go = () => viewReports(key);
  $('#rFrom').onchange = e => { r.from = e.target.value || r.from; if (r.from > r.to) r.to = r.from; go(); };
  $('#rTo').onchange = e => { r.to = e.target.value || r.to; if (r.to < r.from) r.from = r.to; go(); };
  $$('.chip[data-a]').forEach(c => c.onclick = () => { r.from = c.dataset.a; r.to = c.dataset.b; go(); });
  $('#rCat') && ($('#rCat').onchange = e => { r.cat = e.target.value; go(); });
  $('#rAcc') && ($('#rAcc').onchange = e => { r.acc = e.target.value; go(); });
  $$('tr[data-acc]').forEach(tr => tr.onclick = () => { r.acc = tr.dataset.acc; location.hash = '#/reports/ledger'; });
  $('#rPrint').onclick = () => window.print();
  $('#rXls').onclick = () => exportXLSX(R.title, [{ title: `${R.title} — من ${r.from} إلى ${r.to}`, head: R.head, rows: [...R.rows.map(x => x.c), ...(R.foot ? [R.foot] : [])] }]);
}
function exportXLSX(name, sheets) {
  if (!window.XLSX) { toast('مكتبة Excel لم تُحمّل — تحقق من الإنترنت', 'err'); return; }
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  sheets.forEach((s, i) => {
    const aoa = [[APP + ' — ' + s.title], [], s.head, ...s.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = s.head.map((h, j) => ({ wch: Math.max(12, ...s.rows.map(r => String(r[j] ?? '').length).slice(0, 500), h.length) + 2 }));
    ws['!cols'].forEach(c => c.wch = Math.min(c.wch, 45));
    // تنسيق الأرقام
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 3; R <= range.e.r; R++) for (let C = 0; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.t === 'n') cell.z = '#,##0.00';
    }
    XLSX.utils.book_append_sheet(wb, ws, (s.sheet || name).slice(0, 31) || 'Sheet' + (i + 1));
  });
  XLSX.writeFile(wb, `${name} ${today()}.xlsx`);
}

/* ============================== البنود ============================== */
function viewCategories() {
  const admin = can('cats');
  setCP(`<div class="cp-left">${crumb([{ t: 'الإعدادات' }, { t: 'البنود' }])}${admin ? '<button class="btn btn-primary" id="catNew">جديد</button>' : ''}</div>`);
  const used = id => S.txs.filter(t => t.category_id === id).length;
  const kindLabel = KIND_LABEL;
  const rows = [...S.cats].sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.sort - b.sort || a.id - b.id);
  setMain(`${admin ? '<div class="help">عدّل الاسم مباشرة في الجدول وسيُحفظ تلقائياً. البند المستخدم في حركات لا يُحذف، ويمكنك إيقافه فيختفي من قوائم الإدخال وتبقى حركاته السابقة.</div>' : '<div class="help">ليس لديك صلاحية إدارة البنود — راجع المدير.</div>'}
    <div class="table-wrap"><table class="list"><thead><tr><th style="width:70px">الترتيب</th><th>اسم البند</th><th style="width:130px">النوع</th><th class="num" style="width:100px">عدد الحركات</th><th style="width:80px">نشط</th><th style="width:60px"></th></tr></thead>
    <tbody>${rows.map(c => `<tr data-cid="${c.id}">
      <td><input class="inline num" type="number" data-f="sort" value="${c.sort}" ${admin ? '' : 'disabled'} style="width:60px" /></td>
      <td><input class="inline" data-f="name" value="${esc(c.name)}" ${admin ? '' : 'disabled'} /></td>
      <td><select class="inline" data-f="kind" ${admin && !used(c.id) ? '' : 'disabled'}>${Object.entries(kindLabel).map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="num">${used(c.id)}</td>
      <td><label class="toggle"><input type="checkbox" data-f="active" ${c.active ? 'checked' : ''} ${admin ? '' : 'disabled'} /><span></span></label></td>
      <td>${admin && !used(c.id) ? '<button class="btn btn-link btn-sm" data-del title="حذف">🗑</button>' : ''}</td></tr>`).join('')}</tbody></table></div>`);
  if (!admin) return;
  $$('tr[data-cid]').forEach(tr => {
    const id = Number(tr.dataset.cid);
    const saveRow = async () => {
      const c = { ...catById(id) };
      c.name = $('[data-f=name]', tr).value.trim(); c.kind = $('[data-f=kind]', tr).value;
      c.sort = Number($('[data-f=sort]', tr).value) || 0; c.active = $('[data-f=active]', tr).checked;
      if (!c.name) { toast('اسم البند مطلوب', 'err'); return; }
      try { await DB.saveCategory(c); await refresh(false); toast('تم حفظ البند ✓', 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
    };
    $$('[data-f]', tr).forEach(el => el.addEventListener('change', saveRow));
    const del = $('[data-del]', tr);
    del && (del.onclick = async () => {
      if (!await confirmBox('حذف البند', `حذف «${esc(catById(id).name)}»؟`, 'حذف', true)) return;
      try { await DB.deleteCategory(id); await refresh(false); viewCategories(); toast('تم الحذف'); } catch (e) { toast(errMsg(e), 'err'); }
    });
  });
  $('#catNew').onclick = async () => {
    $('#modalCard').innerHTML = `<div class="m-h">بند جديد</div><div class="m-b">
      <label>الاسم<input id="nName" style="width:100%;margin-top:4px" /></label>
      <label style="margin-top:10px">النوع<select id="nKind" style="width:100%;margin-top:4px"><option value="expense">مصروف</option><option value="income">إيراد</option><option value="account">حساب (بنك، جاري شريك، سلف...)</option></select></label><p class="muted" style="font-size:12px;margin:8px 0 0">«حساب» يُستخدم مع حركتي «سحب من النقدية» و«قبض من حساب» ويظهر في دفتر الأستاذ.</p></div>
      <div class="m-f"><button class="btn btn-primary" id="nOk">إنشاء</button><button class="btn btn-secondary" id="nNo">إلغاء</button></div>`;
    $('#modal').classList.remove('hidden'); $('#nName').focus();
    $('#nNo').onclick = () => $('#modal').classList.add('hidden');
    $('#nOk').onclick = async () => {
      const name = $('#nName').value.trim(); if (!name) { $('#nName').focus(); return; }
      const kind = $('#nKind').value;
      const sort = Math.max(0, ...S.cats.filter(c => c.kind === kind).map(c => c.sort)) + 10;
      try { await DB.saveCategory({ name, kind, sort, active: true }); $('#modal').classList.add('hidden'); await refresh(false); viewCategories(); toast('تمت إضافة البند ✓', 'ok'); }
      catch (e) { toast(errMsg(e), 'err'); }
    };
  };
}

/* ============================== المستخدمون والصلاحيات ============================== */
function viewUsers() {
  const admin = isAdmin();
  setCP(`<div class="cp-left">${crumb([{ t: 'الإعدادات' }, { t: 'المستخدمون والصلاحيات' }])}</div>`);
  const count = id => S.txs.filter(t => t.created_by === id).length;
  const myPerms = isAdmin() ? 'كل الصلاحيات (مدير)' : Object.keys(PERMS).filter(can).map(k => PERM_LABELS[k]).join('، ') || 'اطلاع فقط';
  const tog = (p, k, dis) => `<label class="toggle" title="${PERM_LABELS[k]}"><input type="checkbox" data-perm="${PERMS[k]}" ${p.role === 'admin' || p[PERMS[k]] ? 'checked' : ''} ${dis ? 'disabled' : ''} /><span></span></label>`;
  setMain(`<div class="grid g-2">
    <div class="card"><div class="card-h">حسابي</div><div class="card-b">
      <label>الاسم الظاهر<input id="myName" value="${esc(S.me.full_name)}" style="width:100%;margin-top:4px" /></label>
      <button class="btn btn-primary" id="myNameSave" style="margin-top:8px">حفظ الاسم</button>
      <hr style="border:0;border-top:1px solid var(--border-l);margin:16px 0" />
      <label>كلمة مرور جديدة<input type="password" id="myPw" autocomplete="new-password" style="width:100%;margin-top:4px" placeholder="6 أحرف على الأقل" /></label>
      <button class="btn btn-secondary" id="myPwSave" style="margin-top:8px">تغيير كلمة المرور</button>
      <p class="muted" style="font-size:12px;margin-top:12px">صلاحياتك: <b>${esc(myPerms)}</b></p>
    </div></div>
    <div class="card"><div class="card-h">كيف تعمل الصلاحيات</div><div class="card-b" style="font-size:13px">
      <p><span class="badge b-purple">مدير</span> يملك كل الصلاحيات، ويدير المستخدمين.</p>
      <p><span class="badge b-gray">مستخدم</span> تحدد له ما يستطيع: <b>إضافة</b> حركات، <b>تعديل</b> أي حركة، <b>حذف</b> أي حركة، <b>إدارة البنود</b>. إذا أُوقفت كلها يصبح «اطلاع فقط» على الحركات والتقارير.</p>
      <p class="muted">الصلاحيات مطبّقة في قاعدة البيانات نفسها وليست في الواجهة فقط.</p>
      <p class="muted">لإضافة مستخدم: Supabase ← Authentication ← Users ← Add user، ثم يظهر هنا تلقائياً بصلاحية «اطلاع فقط» — فعّل له ما تريد واضغط حفظ.</p>
    </div></div></div>
    <div class="table-wrap" style="margin-top:16px"><table class="list"><thead><tr><th>المستخدم</th><th style="width:130px">الدور</th>
      ${Object.keys(PERMS).map(k => `<th style="width:90px;text-align:center">${PERM_LABELS[k]}</th>`).join('')}
      <th class="num hide-m">الحركات</th>${admin ? '<th></th>' : ''}</tr></thead>
    <tbody>${S.profiles.map(p => { const self = p.id === S.me.id, dis = !admin || self || p.role === 'admin'; return `<tr data-pid="${p.id}">
      <td><span style="display:flex;gap:8px;align-items:center"><span class="avatar">${esc(initials(p.full_name))}</span>
        ${admin ? `<input class="inline" data-f="full_name" value="${esc(p.full_name)}" />` : esc(p.full_name)}${self ? ' <small class="muted">(أنت)</small>' : ''}</span></td>
      <td>${admin && !self ? `<select class="inline" data-f="role"><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>مدير</option><option value="member" ${p.role !== 'admin' ? 'selected' : ''}>مستخدم</option></select>`
        : `<span class="badge ${p.role === 'admin' ? 'b-purple' : 'b-gray'}">${p.role === 'admin' ? 'مدير' : 'مستخدم'}</span>`}</td>
      ${Object.keys(PERMS).map(k => `<td style="text-align:center">${tog(p, k, dis)}</td>`).join('')}
      <td class="num hide-m">${count(p.id)}</td>
      ${admin ? '<td><button class="btn btn-primary btn-sm" data-save>حفظ</button></td>' : ''}</tr>`; }).join('')}</tbody></table></div>`);

  $('#myNameSave').onclick = async () => {
    const n = $('#myName').value.trim(); if (!n) return;
    try { await DB.updateProfile({ ...S.me, full_name: n }); await refresh(false); paintUser(); toast('تم الحفظ ✓', 'ok'); viewUsers(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  $('#myPwSave').onclick = async () => {
    const pw = $('#myPw').value; if (pw.length < 6) { toast('كلمة المرور قصيرة (6 أحرف على الأقل)', 'err'); return; }
    try { await DB.changePassword(pw); $('#myPw').value = ''; toast('تم تغيير كلمة المرور ✓', 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
  };
  if (!admin) return;
  $$('tr[data-pid]').forEach(tr => {
    const roleSel = $('[data-f=role]', tr);
    // عند اختيار "مدير" تُفعَّل كل الصلاحيات تلقائياً وتُقفل
    roleSel && (roleSel.onchange = () => $$('[data-perm]', tr).forEach(c => { if (roleSel.value === 'admin') c.checked = true; c.disabled = roleSel.value === 'admin'; }));
    $('[data-save]', tr).onclick = async () => {
      const p = { ...S.profiles.find(x => x.id === tr.dataset.pid) };
      p.full_name = $('[data-f=full_name]', tr).value.trim() || p.full_name;
      if (roleSel) p.role = roleSel.value;
      if (p.id !== S.me.id) $$('[data-perm]', tr).forEach(c => p[c.dataset.perm] = p.role === 'admin' ? true : c.checked);
      try { await DB.updateProfile(p); await refresh(false); paintUser(); toast('تم حفظ الصلاحيات ✓', 'ok'); viewUsers(); } catch (e) { toast(errMsg(e), 'err'); }
    };
  });
}

/* ============================ التشغيل والدخول ============================ */
async function refresh(rerender = true) {
  await loadAll();
  if (rerender) router();
}
function paintUser() {
  $('#userName').textContent = S.me.full_name;
  $('#userAvatar').textContent = initials(S.me.full_name);
  $('#umName').textContent = S.me.full_name;
  $('#umRole').textContent = (S.me.role === 'admin' ? 'مدير' : 'مستخدم') + (S.user.email ? ' — ' + S.user.email : '');
}
async function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#main').innerHTML = '<div class="loading">جارٍ تحميل البيانات...</div>';
  try { await loadAll(); } catch (e) { $('#main').innerHTML = `<div class="empty">تعذر تحميل البيانات: ${esc(errMsg(e))}</div>`; return; }
  paintUser();
  DB.subscribe(debounce(async () => {
    await loadAll(); paintUser();
    const h = location.hash;
    if (!/^#\/(new|tx\/)/.test(h) || !S.dirty) { if (!/^#\/(new|tx\/)/.test(h)) router(); }
    toast('تم تحديث البيانات من مستخدم آخر');
  }, 600));
  router();
}
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  if (DEMO) $('#loginErr').innerHTML = '<span style="color:var(--muted)">وضع تجريبي: اضغط تسجيل الدخول بأي بيانات</span>';
}

function boot() {
  document.title = `${APP} — إدارة النقدية`;
  $('#brandName').textContent = APP; $('#loginTitle').textContent = APP;
  if (DEMO) { $('#demoBanner').classList.remove('hidden'); const f = $('#loginForm'); f.email.value = 'demo@buffet.local'; f.password.value = 'demo123'; }
  $('#burger').onclick = () => $('#navMenu').classList.toggle('open');
  $('.nav-dd>button').onclick = e => e.currentTarget.parentElement.classList.toggle('open');
  $('#userBtn').onclick = e => { e.stopPropagation(); $('#userMenu').classList.toggle('open'); };
  document.addEventListener('click', e => {
    if (!e.target.closest('.nav-user')) $('#userMenu').classList.remove('open');
    if (!e.target.closest('.nav-dd')) $$('.nav-dd').forEach(d => d.classList.remove('open'));
  });
  $('#userMenu').addEventListener('click', e => { if (e.target.closest('a')) $('#userMenu').classList.remove('open'); });
  $('#logoutBtn').onclick = async () => { await DB.signOut(); S.user = null; location.hash = ''; showLogin(); };
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true; $('#loginErr').textContent = '';
    try { S.user = await DB.signIn(f.email.value.trim(), f.password.value); await enterApp(); }
    catch (err) { $('#loginErr').textContent = errMsg(err); }
    finally { btn.disabled = false; }
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
  DB.session().then(u => { if (u) { S.user = u; enterApp(); } else showLogin(); }).catch(showLogin);
}
boot();
})();
