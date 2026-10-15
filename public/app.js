'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 兜底清单：启动后优先从 /api/meta 拉取服务端配置，失败时沿用
let TYPES = ['餐饮', '汽油', '通信', '其他'];
let MAX_CLAIM = 10;

/* ---------- 初始化下拉框 ---------- */
function fillSelect(sel, allLabel) {
  const el = $(sel);
  if (allLabel) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allLabel;
    el.appendChild(opt);
  }
  for (const t of TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    el.appendChild(opt);
  }
}

function fillSelects() {
  for (const sel of ['#shareType', '#needType', '#filterType']) $(sel).innerHTML = '';
  fillSelect('#shareType');
  fillSelect('#needType', '全都想要');
  fillSelect('#filterType', '全都想要');
}
fillSelects(); // 先渲染兜底清单，initMeta 成功后以服务端清单刷新

async function initMeta() {
  try {
    const meta = await api('/api/meta');
    if (Array.isArray(meta.invoice_types) && meta.invoice_types.length) {
      TYPES = meta.invoice_types;
      fillSelects();
    }
    if (Number.isInteger(meta.max_claim_count) && meta.max_claim_count > 0) {
      MAX_CLAIM = meta.max_claim_count;
    }
  } catch {
    // 拉取失败时沿用兜底清单
  }
}

/* ---------- 通用工具 ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function money(n) {
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 访问小暗号（服务端配置 ACCESS_TOKEN 后生效） ---------- */
let token = localStorage.getItem('vpToken') || '';
let tokenResolve = null;

function askToken() {
  return new Promise((resolve) => {
    tokenResolve = resolve;
    $('#tokenInput').value = token;
    $('#tokenModal').hidden = false;
    $('#tokenInput').focus();
  });
}

function settleToken(ok) {
  $('#tokenModal').hidden = true;
  if (tokenResolve) tokenResolve(ok);
  tokenResolve = null;
}

async function api(path, options = {}, retried = false) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new Error('网络小调皮，稍后再试试哦');
  }
  if (res.status === 401 && !retried) {
    const ok = await askToken();
    if (ok) return api(path, options, true);
    throw new Error('小暗号还没给呢');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `哎呀，请求失败啦（${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- 视图切换 ---------- */
const VIEW_LABELS = { home: '', share: '分享票据～', claim: '领取票据～' };
function showView(name) {
  for (const v of Object.keys(VIEW_LABELS)) $(`#view-${v}`).hidden = v !== name;
  $('#backHomeBtn').hidden = name === 'home';
  $('#stepLabel').textContent = VIEW_LABELS[name];
  window.scrollTo(0, 0);
  if (name === 'home') loadStats();
  if (name === 'claim' && !manualLoaded) loadManual();
}

/* ---------- 首页统计 ---------- */
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#homeStats').textContent = `池子里还有 ${s.available} 张票据在等你 · 已被抱走 ${s.claimed} 张啦`;
  } catch {
    $('#homeStats').textContent = '数字宝宝们没加载出来，刷新一下试试嘛';
  }
}

/* ---------- 分享表单 ---------- */
let pickedFile = null;
$('#fileInput').addEventListener('change', (e) => {
  pickedFile = e.target.files[0] || null;
  $('#fileText').textContent = pickedFile
    ? pickedFile.name
    : '点一下挑票据文件呀（jpg / png / webp / pdf，10MB 以内哦）';
  $('#filePicker').classList.toggle('has-file', Boolean(pickedFile));
});

$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pickedFile) return toast('票据文件还没挑哦', 'err');
  const btn = $('#shareSubmit');
  btn.disabled = true;
  btn.textContent = '飞奔提交中…';
  try {
    const fd = new FormData();
    fd.append('file', pickedFile);
    fd.append('amount', $('#shareAmount').value);
    fd.append('invoice_type', $('#shareType').value);
    fd.append('invoice_month', $('#shareMonth').value);
    fd.append('uploader_name', $('#shareName').value);
    fd.append('uploader_contact', $('#shareContact').value);
    fd.append('remark', $('#shareRemark').value);
    const inv = await api('/api/invoices', { method: 'POST', body: fd });
    toast(`分享成功～票据 #${inv.id} 已经跳进池子里咯`);
    e.target.reset();
    pickedFile = null;
    $('#fileText').textContent = '点一下挑票据文件呀（jpg / png / webp / pdf，10MB 以内哦）';
    $('#filePicker').classList.remove('has-file');
    loadStats();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '分享出去咯';
  }
});

/* ---------- 票据卡片渲染 ---------- */
function cardHtml(inv, { checkboxIdx = null, checked = false } = {}) {
  const control = checkboxIdx !== null
    ? `<label class="pick"><input type="checkbox" data-idx="${checkboxIdx}" ${checked ? 'checked' : ''} /></label>`
    : '';
  const action = inv.status === 'available'
    ? `<button type="button" class="primary-btn small" data-claim="${inv.id}">寄到我邮箱</button>`
    : `<span class="badge claimed">已被抱走</span>`;
  return `
  <div class="invoice-card card ${inv.status === 'available' ? '' : 'is-claimed'}">
    ${control}
    <div class="amount">${money(inv.amount)}</div>
    <div class="meta">
      <span class="badge type">${esc(inv.invoice_type)}</span>
      <span class="month">开票于 ${esc(inv.invoice_month)}</span>
    </div>
    ${inv.remark ? `<div class="remark">${esc(inv.remark)}</div>` : ''}
    <div class="foot">
      <span class="date">分享于 ${fmtDate(inv.created_at)}</span>
      ${action}
    </div>
  </div>`;
}

/* ---------- 智能推荐 ---------- */
let lastRecommend = null; // { amount, type }
let recItems = [];

async function runRecommend() {
  const amount = Number($('#needAmount').value);
  const type = $('#needType').value;
  if (!Number.isFinite(amount) || amount <= 0) return toast('想要的金额要填对哦，大于 0 才行', 'err');
  const btn = $('#matchBtn');
  btn.disabled = true;
  try {
    const qs = new URLSearchParams({ amount: String(amount) });
    if (type) qs.set('invoice_type', type);
    const data = await api(`/api/invoices/recommend?${qs}`);
    lastRecommend = { amount, type };
    recItems = data.items.map((it) => ({ ...it, checked: true }));
    renderRecommend(data);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderRecommend(data) {
  $('#recommendResult').hidden = false;
  const notice = $('#recommendNotice');
  if (recItems.length === 0) {
    notice.hidden = false;
    notice.textContent = '池子空空如也，暂时没找到合适的票据呀～';
  } else if (!data.sufficient) {
    notice.hidden = false;
    notice.textContent = `池子里的票据凑不够哦（现在共 ${money(data.total)}，离 ${money(data.target)} 还差一点），下面是可以抱走的全部票据啦`;
  } else {
    notice.hidden = true;
  }
  $('#recommendSummaryBar').hidden = recItems.length === 0;

  $('#recommendList').innerHTML = recItems
    .map((it, idx) => cardHtml(it, { checkboxIdx: idx, checked: it.checked }))
    .join('');
  $$('#recommendList input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      recItems[Number(cb.dataset.idx)].checked = cb.checked;
      updateRecommendSummary();
    });
  });
  updateRecommendSummary();
}

function updateRecommendSummary() {
  const checked = recItems.filter((i) => i.checked);
  if (checked.length > MAX_CLAIM) {
    $('#recommendSummary').textContent = `一次最多抱 ${MAX_CLAIM} 张哦，现在选了 ${checked.length} 张，先取消几张嘛`;
    $('#claimRecommendBtn').disabled = true;
    return;
  }
  const total = checked.reduce((s, i) => s + i.amount, 0);
  const target = lastRecommend ? lastRecommend.amount : 0;
  const diff = Math.round((total - target) * 100) / 100;
  let text = `想要 ${money(target)} · 已选合计 ${money(total)}`;
  if (checked.length) {
    text += diff >= 0 ? `（多出 ${money(diff)}）` : `（还差 ${money(-diff)}）`;
  }
  $('#recommendSummary').textContent = checked.length ? text : '先勾中一张小票据嘛';
  $('#claimRecommendBtn').disabled = checked.length === 0;
}

/* ---------- 手动筛选 ---------- */
let manualLoaded = false;

async function loadManual() {
  const qs = new URLSearchParams();
  const min = $('#filterMin').value;
  const max = $('#filterMax').value;
  if (min) qs.set('min_amount', min);
  if (max) qs.set('max_amount', max);
  if ($('#filterType').value) qs.set('invoice_type', $('#filterType').value);
  if ($('#filterFrom').value) qs.set('month_from', $('#filterFrom').value);
  if ($('#filterTo').value) qs.set('month_to', $('#filterTo').value);
  qs.set('status', $('#filterStatus').value || 'available');
  try {
    const data = await api(`/api/invoices?${qs}`);
    manualLoaded = true;
    $('#manualList').innerHTML = data.items.length
      ? data.items.map((it) => cardHtml(it)).join('')
        + (data.has_more ? `<p class="empty">一共有 ${data.total} 条呢，先给你看前 ${data.items.length} 条，缩小范围找找吧</p>` : '')
      : '<p class="empty">咦，一张符合条件的票据都没有呢</p>';
    $$('#manualList [data-claim]').forEach((b) =>
      b.addEventListener('click', () => openClaimModal([Number(b.dataset.claim)]))
    );
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------- 领取弹窗 ---------- */
let claimIds = [];

function openClaimModal(ids) {
  claimIds = ids;
  $('#claimModalTitle').textContent = ids.length > 1 ? `把 ${ids.length} 张票据寄到邮箱咯` : '把票据寄到邮箱咯';
  $('#claimEmail').value = '';
  $('#claimModal').hidden = false;
  $('#claimEmail').focus();
}

function closeClaimModal() {
  $('#claimModal').hidden = true;
}

function refreshCurrentPanel() {
  if (!$('#panelRecommend').hidden && lastRecommend) runRecommend();
  else loadManual();
  loadStats();
}

$('#claimConfirm').addEventListener('click', async () => {
  const email = $('#claimEmail').value.trim();
  if (!email) return toast('邮箱地址还空着呢', 'err');
  const btn = $('#claimConfirm');
  btn.disabled = true;
  btn.textContent = '打包飞奔中…';
  try {
    const r = await api('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: claimIds, email }),
    });
    closeClaimModal();
    toast(r.message);
    refreshCurrentPanel();
  } catch (err) {
    toast(err.message, 'err');
    if (err.message.includes('抱走')) {
      closeClaimModal();
      refreshCurrentPanel();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '寄给我！';
  }
});

/* ---------- 事件绑定 ---------- */
$('#goShareBtn').addEventListener('click', () => showView('share'));
$('#goNeedBtn').addEventListener('click', () => showView('claim'));
$('#backHomeBtn').addEventListener('click', () => showView('home'));

function switchTab(name) {
  const isRec = name === 'recommend';
  $('#tabRecommend').classList.toggle('active', isRec);
  $('#tabManual').classList.toggle('active', !isRec);
  $('#panelRecommend').hidden = !isRec;
  $('#panelManual').hidden = isRec;
  if (!isRec && !manualLoaded) loadManual();
}
$('#tabRecommend').addEventListener('click', () => switchTab('recommend'));
$('#tabManual').addEventListener('click', () => switchTab('manual'));

$('#matchBtn').addEventListener('click', runRecommend);

// 需求条件变化后使已有推荐结果失效，避免按旧条件误领取
function invalidateRecommend() {
  if (!lastRecommend) return;
  lastRecommend = null;
  recItems = [];
  $('#recommendResult').hidden = true;
}
$('#needAmount').addEventListener('input', invalidateRecommend);
$('#needType').addEventListener('change', invalidateRecommend);
$('#claimRecommendBtn').addEventListener('click', () => {
  const ids = recItems.filter((i) => i.checked).map((i) => i.id);
  if (ids.length) openClaimModal(ids);
});

$('#claimCancel').addEventListener('click', closeClaimModal);
$('#claimModal').addEventListener('click', (e) => {
  if (e.target === $('#claimModal')) closeClaimModal();
});
$('#claimEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#claimConfirm').click();
});

$('#tokenConfirm').addEventListener('click', () => {
  const v = $('#tokenInput').value.trim();
  if (!v) return toast('小暗号不能为空哦', 'err');
  token = v;
  localStorage.setItem('vpToken', token);
  settleToken(true);
});
$('#tokenCancel').addEventListener('click', () => settleToken(false));
$('#tokenInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#tokenConfirm').click();
});

$('#queryBtn').addEventListener('click', loadManual);
$('#resetBtn').addEventListener('click', () => {
  ['filterMin', 'filterMax', 'filterFrom', 'filterTo'].forEach((id) => { $('#' + id).value = ''; });
  $('#filterType').value = '';
  $('#filterStatus').value = 'available';
  loadManual();
});

/* ---------- 启动 ---------- */
initMeta();
showView('home');
