'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const TYPES = ['餐饮服务费', '车用汽油', '通信服务费', '其他'];

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
fillSelect('#shareType');
fillSelect('#needType', '全部类型');
fillSelect('#filterType', '全部类型');

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

/* ---------- 访问令牌（服务端配置 ACCESS_TOKEN 后生效） ---------- */
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
    throw new Error('网络异常，请稍后重试');
  }
  if (res.status === 401 && !retried) {
    const ok = await askToken();
    if (ok) return api(path, options, true);
    throw new Error('缺少访问令牌');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
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
const VIEW_LABELS = { home: '', share: '分享发票', claim: '领取发票' };
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
    $('#homeStats').textContent = `当前可用票据 ${s.available} 张 · 已领取 ${s.claimed} 张`;
  } catch {
    $('#homeStats').textContent = '统计加载失败，请刷新重试';
  }
}

/* ---------- 分享表单 ---------- */
let pickedFile = null;
$('#fileInput').addEventListener('change', (e) => {
  pickedFile = e.target.files[0] || null;
  $('#fileText').textContent = pickedFile
    ? pickedFile.name
    : '点击选择发票文件（jpg / png / webp / pdf，不超过 10MB）';
  $('#filePicker').classList.toggle('has-file', Boolean(pickedFile));
});

$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pickedFile) return toast('请选择发票文件', 'err');
  const btn = $('#shareSubmit');
  btn.disabled = true;
  btn.textContent = '提交中…';
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
    toast(`分享成功，发票 #${inv.id} 已进入票据池`);
    e.target.reset();
    pickedFile = null;
    $('#fileText').textContent = '点击选择发票文件（jpg / png / webp / pdf，不超过 10MB）';
    $('#filePicker').classList.remove('has-file');
    loadStats();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交分享';
  }
});

/* ---------- 票据卡片渲染 ---------- */
function cardHtml(inv, { checkboxIdx = null, checked = false } = {}) {
  const control = checkboxIdx !== null
    ? `<label class="pick"><input type="checkbox" data-idx="${checkboxIdx}" ${checked ? 'checked' : ''} /></label>`
    : '';
  const action = inv.status === 'available'
    ? `<button type="button" class="primary-btn small" data-claim="${inv.id}">领取到邮箱</button>`
    : `<span class="badge claimed">已领取</span>`;
  return `
  <div class="invoice-card card ${inv.status === 'available' ? '' : 'is-claimed'}">
    ${control}
    <div class="amount">${money(inv.amount)}</div>
    <div class="meta">
      <span class="badge type">${esc(inv.invoice_type)}</span>
      <span class="month">开票 ${esc(inv.invoice_month)}</span>
    </div>
    ${inv.remark ? `<div class="remark">${esc(inv.remark)}</div>` : ''}
    <div class="foot">
      <span class="date">上传于 ${fmtDate(inv.created_at)}</span>
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
  if (!Number.isFinite(amount) || amount <= 0) return toast('请填写正确的需求金额', 'err');
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
    notice.textContent = '票据池暂无符合条件的可用票据';
  } else if (!data.sufficient) {
    notice.hidden = false;
    notice.textContent = `票据池可用总额不足（合计 ${money(data.total)}，低于需求 ${money(data.target)}），以下为全部可用票据`;
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
  const total = checked.reduce((s, i) => s + i.amount, 0);
  const target = lastRecommend ? lastRecommend.amount : 0;
  const diff = Math.round((total - target) * 100) / 100;
  let text = `需求 ${money(target)} · 已选合计 ${money(total)}`;
  if (checked.length) {
    text += diff >= 0 ? `（超出 ${money(diff)}）` : `（低于需求 ${money(-diff)}）`;
  }
  $('#recommendSummary').textContent = checked.length ? text : '请至少勾选一张票据';
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
      : '<p class="empty">暂无符合条件的票据</p>';
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
  $('#claimModalTitle').textContent = ids.length > 1 ? `领取 ${ids.length} 张发票到邮箱` : '领取发票到邮箱';
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
  if (!email) return toast('请填写邮箱地址', 'err');
  const btn = $('#claimConfirm');
  btn.disabled = true;
  btn.textContent = '发送中…';
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
    if (err.message.includes('已被领取')) {
      closeClaimModal();
      refreshCurrentPanel();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '确认领取';
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
  if (!v) return toast('请输入访问令牌', 'err');
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
showView('home');
