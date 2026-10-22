'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 兜底清单：启动后优先从 /api/meta 拉取服务端配置，失败时沿用
let TYPES = ['餐饮', '汽油', '通信', '其他'];
let MAX_CLAIM = 10;
let MAX_MATCH = 1000; // 智能匹配金额上限

/* ---------- 初始化下拉框 ---------- */
function fillSelect(sel, allLabel) {
  const el = $(sel);
  el.innerHTML = ''; // 每次重建，避免重复调用时选项叠加
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

/* ---------- 多选下拉框（票据类型） ---------- */
function msValues(el) {
  return [...el.querySelectorAll('.ms-menu input:checked')].map((i) => i.value);
}

function msUpdateLabel(el) {
  const vals = msValues(el);
  el.querySelector('.ms-label').textContent = vals.length ? vals.join('、') : (el.dataset.placeholder || '');
  el.classList.toggle('has-value', vals.length > 0);
}

function msClear(el) {
  el.querySelectorAll('.ms-menu input').forEach((i) => { i.checked = false; });
  msUpdateLabel(el);
}

function closeMsMenus() {
  $$('.multi-select').forEach((ms) => {
    ms.classList.remove('open');
    ms.querySelector('.ms-menu').hidden = true;
    ms.querySelector('.ms-toggle').setAttribute('aria-expanded', 'false');
  });
}

// 构建/刷新一个多选下拉框；TYPES 更新后重复调用即可刷新选项，已勾选项保持
function buildMultiSelect(el, placeholder) {
  if (!el) return;
  el.dataset.placeholder = placeholder;
  if (!el.dataset.msReady) {
    el.dataset.msReady = '1';
    el.classList.add('multi-select');
    el.innerHTML = `
      <button type="button" class="ms-toggle" aria-haspopup="listbox" aria-expanded="false">
        <span class="ms-label"></span>
        <span class="ms-arrow" aria-hidden="true">▾</span>
      </button>
      <div class="ms-menu" hidden></div>`;
    const toggle = el.querySelector('.ms-toggle');
    const menu = el.querySelector('.ms-menu');
    toggle.addEventListener('click', () => {
      const willOpen = menu.hidden;
      closeMsMenus();
      menu.hidden = !willOpen;
      el.classList.toggle('open', willOpen);
      toggle.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (e) => {
      if (!el.contains(e.target)) {
        menu.hidden = true;
        el.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
  const menu = el.querySelector('.ms-menu');
  menu.innerHTML = TYPES.map((t) =>
    `<label class="ms-option"><input type="checkbox" value="${esc(t)}" /><span>${esc(t)}</span></label>`
  ).join('');
  menu.querySelectorAll('input').forEach((cb) =>
    cb.addEventListener('change', () => {
      msUpdateLabel(el);
      el.dispatchEvent(new Event('change'));
    })
  );
  msUpdateLabel(el);
}

function fillSelects() {
  fillSelect('#shareType');
  buildMultiSelect($('#filterType'), '全部'); // 未选时显示灰色“全部”占位
  buildMultiSelect($('#needType'), '全部');
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
    if (Number.isFinite(meta.max_match_amount) && meta.max_match_amount > 0) {
      MAX_MATCH = meta.max_match_amount;
      updateNeedAmountNote();
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

/* ---------- 分享成功：全屏庆祝 ---------- */
const SHARE_SUCCESS_MESSAGES = [
  '分享成功啦，你超棒的～',
  '叮咚～票据已安全抵达池子～',
  '哇哦，又一张票据来报到咯～',
  '干得漂亮，票据池子更热闹啦～',
  '票据投递完毕，奖励自己一朵小花～',
  '发射成功～票据已就位～',
  '好耶～分享小能手就是你～',
  '票据咕噜一下滚进池子里啦～',
  '完美～这份分享闪闪发光～',
  '票据说：谢谢款待，我住下啦～',
  '撒花～你的分享已签收～',
  '棒棒哒，池子因你更满了一点～',
  '噗通～票据跳水姿势满分～',
  '小可爱，你的分享甜到我了～',
  '票据扑腾着游进池子咯～',
  '今日份好运已充值成功～',
  '这张票据有点可爱，像你一样～',
  '收藏成功，池子里又多一颗糖～',
  '票据排排坐，你的这张最抢眼～',
  '呜呼～分享达成，快乐翻倍～',
  '票据挥挥小手说：我来啦～',
  '暖呼呼的票据，已经安顿好啦～',
  '给池子投喂成功，它很开心～',
  '你一点分享，我一池欢喜～',
  '票据已上线，坐等有缘人抱走～',
  '咔嚓～分享瞬间已被定格～',
  '这张票据将在池子里发光发热～',
  '分享小火箭，嗖的一下就到位～',
  '池子咕嘟咕嘟，欢迎新伙伴～',
  '圆满～这张票据找到新家啦～'
];

// 文案池：邮件发送成功，俏皮可爱风，每次随机挑一条
const CLAIM_SUCCESS_MESSAGES = [
  '寄出去咯，记得查收～',
  '小信鸽扑棱着翅膀出发啦～',
  '票据坐上邮件快车咯～',
  '嗖～包裹正飞向你的邮箱～',
  '投递成功，收件箱里见～',
  '邮件小火箭发射成功～',
  '包裹已发出，请可爱地等待～',
  '票据打包完毕，飞奔而去咯～',
  '叮咚～好运正在派送途中～',
  '寄件成功，这波稳了～'
];

const CONFETTI_COLORS = ['#ff6b9d', '#12b8a6', '#ffd43b', '#9775fa', '#ff8787', '#74c0fc'];
let celebrateTimer = null;

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function showCelebrate({ emoji = '🎉', text, sub = '' }) {
  const el = $('#shareCelebrate');
  el.querySelector('.celebrate-emoji').textContent = emoji;
  el.querySelector('.celebrate-text').textContent = text;
  const subEl = el.querySelector('.celebrate-sub');
  subEl.textContent = sub;
  subEl.hidden = !sub;

  // 生成五彩纸屑
  const box = el.querySelector('.celebrate-confetti');
  box.innerHTML = '';
  for (let i = 0; i < 48; i++) {
    const p = document.createElement('i');
    const size = 6 + Math.random() * 8;
    p.style.cssText = `
      left: ${Math.random() * 100}%;
      width: ${size}px;
      height: ${size * (Math.random() > 0.5 ? 1 : 0.5)}px;
      background: ${CONFETTI_COLORS[i % CONFETTI_COLORS.length]};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-duration: ${1.6 + Math.random() * 1.4}s;
      animation-delay: ${Math.random() * 0.6}s;
      transform: rotate(${Math.random() * 360}deg);
    `;
    box.appendChild(p);
  }

  el.hidden = false;
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => { el.hidden = true; el.classList.remove('is-leaving'); }, 300);
  }, 3800);
}

function showShareCelebrate() {
  showCelebrate({ emoji: '🎉', text: pickRandom(SHARE_SUCCESS_MESSAGES) });
}

// 表单校验失败：抖动提示 + 聚焦
function flagInvalid(el) {
  el.classList.remove('input-error');
  void el.offsetWidth; // 重新触发抖动动画
  el.classList.add('input-error');
  el.focus();
  el.addEventListener('input', () => el.classList.remove('input-error'), { once: true });
}

// 骨架屏
function renderSkeletons(container, count = 6) {
  container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton-card" aria-hidden="true"></div>').join('');
}

/* ---------- 视图切换 ---------- */
const VIEW_LABELS = { home: '', share: '分享票据～', claim: '领取票据～' };
function showView(name) {
  for (const v of Object.keys(VIEW_LABELS)) $(`#view-${v}`).hidden = v !== name;
  $('#backHomeBtn').hidden = name === 'home';
  const label = $('#stepLabel');
  label.textContent = VIEW_LABELS[name];
  // 重新触发步骤标签的弹出动画
  label.style.animation = 'none';
  void label.offsetWidth;
  label.style.animation = '';
  window.scrollTo(0, 0);
  if (name === 'home') loadStats();
  if (name === 'claim' && !manualLoaded) loadManual();
}

/* ---------- 首页统计 ---------- */
// 文案池：俏皮可爱风，每次加载随机挑一条展示
const STATS_TEMPLATES = [
  '池子里还有 {n} 张票据，累计帮助小伙伴解围 {m} 次啦',
  '{n} 张票据池里蹲蹲，累计已送出 {m} 次小帮助',
  '池子里咕噜着 {n} 张票据，已助力小伙伴 {m} 次啦',
  '{n} 张票据在池子里等你捞，好运已派送 {m} 次啦',
  '池子现存 {n} 张票据小可爱，帮忙值已攒到 {m} 次啦',
  '池子里晃悠着 {n} 张票据，累计送温暖 {m} 次啦',
];
const STATS_POLL_INTERVAL = 60 * 1000; // 每隔 1 分钟查一次
let statsRendered = false; // 首次渲染用 innerHTML，之后只翻动变化的数字

function statsHtml(n, m) {
  const num = (key, val, cls) =>
    `<span class="stat-num ${cls}"><span class="flip" data-key="${key}">${val}</span></span>`;
  const tpl = STATS_TEMPLATES[Math.floor(Math.random() * STATS_TEMPLATES.length)];
  return tpl
    .replace('{n}', num('n', n, 'stat-n'))
    .replace('{m}', num('m', m, 'stat-m'));
}

// 翻牌特效：数字有变化时先翻出再翻入
function flipNum(key, val) {
  const el = $(`#homeStats .flip[data-key="${key}"]`);
  if (!el) return;
  const text = String(val);
  if (el.textContent === text) return;
  el.classList.add('flip-out');
  setTimeout(() => {
    el.textContent = text;
    el.classList.remove('flip-out');
    el.classList.add('flip-in');
    setTimeout(() => el.classList.remove('flip-in'), 320);
  }, 160);
}

async function loadStats(silent = false) {
  try {
    const s = await api('/api/stats');
    if (!statsRendered) {
      $('#homeStats').innerHTML = statsHtml(s.available, s.claimed);
      statsRendered = true;
    } else {
      flipNum('n', s.available);
      flipNum('m', s.claimed);
    }
  } catch {
    if (!silent) $('#homeStats').textContent = '数字宝宝们没加载出来，刷新一下试试嘛';
  }
}

// 首页可见时每 1 分钟轮询一次，有变化就翻牌
setInterval(() => {
  if (statsRendered && !$('#view-home').hidden) loadStats(true);
}, STATS_POLL_INTERVAL);

/* ---------- 分享表单 ---------- */
let pickedFile = null;
const FILE_PLACEHOLDER = '点一下挑票据文件呀，拖进来也行（jpg / png / webp / pdf，10MB 以内哦）';
const MIN_MONTH = '2026-01'; // 开票年月不能早于 2026 年

// 开票年月：默认当年当月，且不早于 2026-01
function resetShareMonth() {
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const cur = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  const el = $('#shareMonth');
  el.min = MIN_MONTH;
  el.value = cur < MIN_MONTH ? MIN_MONTH : cur;
}
resetShareMonth();

function setPickedFile(file) {
  pickedFile = file || null;
  $('#fileText').textContent = pickedFile ? pickedFile.name : FILE_PLACEHOLDER;
  $('#filePicker').classList.toggle('has-file', Boolean(pickedFile));
}

$('#fileInput').addEventListener('change', (e) => setPickedFile(e.target.files[0]));

// 拖拽上传
const picker = $('#filePicker');
['dragenter', 'dragover'].forEach((ev) =>
  picker.addEventListener(ev, (e) => { e.preventDefault(); picker.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach((ev) =>
  picker.addEventListener(ev, (e) => { e.preventDefault(); picker.classList.remove('drag-over'); })
);
picker.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setPickedFile(file);
});

/* ---------- 悄悄话备注：15 字上限 ---------- */
const REMARK_MAX = 15;
const remarkEl = $('#shareRemark');
const remarkTip = $('#remarkTip');
const remarkCount = $('#remarkCount');
let remarkTipTimer = null;

function updateRemarkCount() {
  remarkCount.textContent = `${remarkEl.value.length}/${REMARK_MAX}`;
  remarkCount.classList.toggle('is-full', remarkEl.value.length >= REMARK_MAX);
}
function clipRemark() {
  if (remarkEl.value.length <= REMARK_MAX) return;
  // 超出部分直接拦下，不让他继续说悄悄话
  remarkEl.value = remarkEl.value.slice(0, REMARK_MAX);
  updateRemarkCount();
  remarkTip.hidden = false;
  remarkTip.classList.remove('shake');
  void remarkTip.offsetWidth; // 重新触发抖动动画
  remarkTip.classList.add('shake');
  clearTimeout(remarkTipTimer);
  remarkTipTimer = setTimeout(() => { remarkTip.hidden = true; }, 2600);
}
remarkEl.addEventListener('input', (e) => {
  updateRemarkCount();
  if (!e.isComposing) clipRemark();
});
remarkEl.addEventListener('compositionend', () => {
  updateRemarkCount();
  clipRemark();
});

$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pickedFile) {
    picker.classList.remove('drag-over');
    picker.style.animation = 'none';
    void picker.offsetWidth;
    picker.style.animation = 'shake 0.35s';
    return toast('票据文件还没挑哦', 'err');
  }
  if (!Number($('#shareAmount').value) || Number($('#shareAmount').value) <= 0) {
    flagInvalid($('#shareAmount'));
    return toast('票据金额要填对哦，大于 0 才行', 'err');
  }
  const btn = $('#shareSubmit');
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.textContent = '飞奔提交中';
  try {
    const fd = new FormData();
    fd.append('file', pickedFile);
    fd.append('amount', $('#shareAmount').value);
    fd.append('invoice_type', $('#shareType').value);
    fd.append('invoice_month', $('#shareMonth').value);
    fd.append('uploader_name', $('#shareName').value);
    fd.append('remark', $('#shareRemark').value);
    const inv = await api('/api/invoices', { method: 'POST', body: fd });
    showShareCelebrate();
    e.target.reset();
    updateRemarkCount();
    remarkTip.hidden = true;
    setPickedFile(null);
    resetShareMonth();
    loadStats();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.textContent = '分享出去咯';
  }
});

/* ---------- 票据卡片渲染 ---------- */
function cardHtml(inv, { checkboxIdx = null, checked = false, delayIdx = 0 } = {}) {
  const control = checkboxIdx !== null
    ? `<label class="pick" aria-label="选中这张票据"><input type="checkbox" data-idx="${checkboxIdx}" ${checked ? 'checked' : ''} /></label>`
    : '';
  const action = inv.status === 'available'
    ? `<button type="button" class="primary-btn small" data-claim="${inv.id}">寄到我邮箱</button>`
    : `<span class="badge claimed">已被抱走</span>`;
  return `
  <div class="invoice-card card ${inv.status === 'available' ? '' : 'is-claimed'}" style="animation-delay: ${Math.min(delayIdx, 8) * 55}ms">
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
  const types = msValues($('#needType'));
  if (!Number.isFinite(amount) || amount <= 0) {
    flagInvalid($('#needAmount'));
    return toast('想要的金额要填对哦，大于 0 才行', 'err');
  }
  if (amount > MAX_MATCH) {
    flagInvalid($('#needAmount'));
    return toast(`智能匹配的金额最大允许为${MAX_MATCH}`, 'err');
  }
  const btn = $('#matchBtn');
  btn.disabled = true;
  btn.classList.add('is-loading');
  $('#recommendResult').hidden = false;
  $('#recommendNotice').hidden = true;
  $('#recommendSummaryBar').hidden = true;
  renderSkeletons($('#recommendList'), 3);
  try {
    const qs = new URLSearchParams({ amount: String(amount) });
    for (const t of types) qs.append('invoice_type', t);
    const data = await api(`/api/invoices/recommend?${qs}`);
    lastRecommend = { amount, types };
    recItems = data.items.map((it) => ({ ...it, checked: true }));
    renderRecommend(data);
  } catch (err) {
    $('#recommendList').innerHTML = '';
    $('#recommendResult').hidden = true;
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
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
    .map((it, idx) => cardHtml(it, { checkboxIdx: idx, checked: it.checked, delayIdx: idx }))
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
  // 票据类型多选：选中的类型以重复参数传给后端；一个都不选即查询全部
  for (const t of msValues($('#filterType'))) qs.append('invoice_type', t);
  // 开票年月：精确匹配，不选即不限制
  if ($('#filterMonth').value) qs.set('invoice_month', $('#filterMonth').value);
  // 状态：不选即查询全部
  if ($('#filterStatus').value) qs.set('status', $('#filterStatus').value);
  renderSkeletons($('#manualList'));
  try {
    const data = await api(`/api/invoices?${qs}`);
    manualLoaded = true;
    $('#manualList').innerHTML = data.items.length
      ? data.items.map((it, idx) => cardHtml(it, { delayIdx: idx })).join('')
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
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    flagInvalid($('#claimEmail'));
    return toast('邮箱地址好像不对哦，再看看嘛', 'err');
  }
  const btn = $('#claimConfirm');
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.textContent = '打包飞奔中';
  try {
    const r = await api('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: claimIds, email }),
    });
    closeClaimModal();
    const count = r.count || claimIds.length;
    showCelebrate({
      emoji: '💌',
      text: pickRandom(CLAIM_SUCCESS_MESSAGES),
      sub: `${count} 张票据正在扑向 ${email}，记得查收哦～`
    });
    refreshCurrentPanel();
  } catch (err) {
    toast(err.message, 'err');
    if (err.message.includes('抱走')) {
      closeClaimModal();
      refreshCurrentPanel();
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.textContent = '寄给我';
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
  $('#tabRecommend').setAttribute('aria-selected', String(isRec));
  $('#tabManual').setAttribute('aria-selected', String(!isRec));
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
// 金额标签小注：平时是「（最多 1000）」，超过上限时原地切换为警告文案
function updateNeedAmountNote() {
  const amount = Number($('#needAmount').value);
  const over = Number.isFinite(amount) && amount > MAX_MATCH;
  const note = $('#needAmountCap');
  note.classList.toggle('is-warn', over);
  note.textContent = over ? `智能匹配的金额最大允许为${MAX_MATCH}` : `（最多 ${MAX_MATCH}）`;
}
$('#needAmount').addEventListener('input', () => {
  invalidateRecommend();
  updateNeedAmountNote();
});
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

// Esc 关闭打开的弹窗
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#claimModal').hidden) closeClaimModal();
  closeMsMenus();
});

$('#queryBtn').addEventListener('click', loadManual);
// 筛选输入框内按回车直接查询
['filterMin', 'filterMax', 'filterMonth'].forEach((id) => {
  $('#' + id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#queryBtn').click();
  });
});
$('#resetBtn').addEventListener('click', () => {
  ['filterMin', 'filterMax', 'filterMonth'].forEach((id) => { $('#' + id).value = ''; });
  msClear($('#filterType'));
  $('#filterStatus').value = '';
  loadManual();
});

/* ---------- 首页袋鼠吉祥物 ---------- */
// 情绪状态机：持久状态走 data-state（idle/eager/curious/sad/angry），由 setState 单入口切换；
// 一次性动作（点击弹跳 is-boing、眨眼 is-blinking、抖耳 is-twitch、小袋鼠探头 is-peek）
// 用叠加 class，不改状态归属，避免多个 animation 属性互相覆盖
(function initMascot() {
  const mascot = $('#mascot');
  if (!mascot) return;

  const STATE = { IDLE: 'idle', EAGER: 'eager', CURIOUS: 'curious', SAD: 'sad', ANGRY: 'angry' };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canHover = window.matchMedia('(hover: hover)').matches;
  mascot.dataset.state = STATE.IDLE;

  /* --- 气泡文案分组 --- */
  const GREETINGS = [
    '嘿！我是池子小管家～',
    '袋鼠式点赞，棒！',
    '票据跳进口袋咯～',
    '蹦蹦跳跳去分享！',
    '今天也要帮小伙伴呀～',
  ];
  const COMPLAINTS = [
    '别戳啦！袋子要破咯～',
    '再戳真的要生气啦！',
    '停停停！尾巴都被戳歪了！',
  ];
  const bubble = $('#mascotBubble');
  let bubbleTimer = 0;
  function showBubble(text, grumpy) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.toggle('is-grumpy', !!grumpy);
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 1600);
  }

  /* --- 状态机单入口：离开 sad/angry 时统一清理其自动恢复定时器 --- */
  let sadTimer = 0;
  let angryTimer = 0;
  let cooldownUntil = 0; // 生气冷却截止时间，期间忽略失落/生气彩蛋
  function setState(next) {
    const cur = mascot.dataset.state;
    if (cur === STATE.SAD && next !== STATE.SAD) clearTimeout(sadTimer);
    if (cur === STATE.ANGRY && next !== STATE.ANGRY) clearTimeout(angryTimer);
    mascot.dataset.state = next;
    if (!rafId) rafId = requestAnimationFrame(followFrame); // 状态切换立即刷新瞳孔缩放/头部权重
  }

  /* --- 瞳孔 + 头部协同跟随 ---
     瞳孔即时响应（先看），头部以阻尼插值延迟跟随（后转头），鼠标静止 2s 后头部缓慢回中 */
  const pupils = [...mascot.querySelectorAll('.pupil')];
  const head = mascot.querySelector('.head');
  const MAX_SHIFT = 4.2;     // 瞳孔最大偏移（SVG 单位）
  const HEAD_MAX_ROT = 7;    // 头部最大侧转（度）
  const HEAD_MAX_X = 2;      // 头部水平位移上限（px）
  const HEAD_MAX_Y = 1.6;    // 头部垂直位移上限（px）
  const HEAD_EASE = 0.055;   // 头部阻尼系数：越小越滞后，无超调
  const HEAD_IDLE_MS = 2000; // 鼠标静止多久后头部回中
  const headRig = { rot: 0, x: 0, y: 0, tRot: 0, tX: 0, tY: 0 };
  let rafId = 0;
  let cursorX = 0;
  let cursorY = 0;
  let lastMoveAt = 0;
  let geomStale = true;
  let headCx = 0;
  let headCy = 0;
  let eyeCenters = [];
  // 情绪动作优先：失落/生气/弹跳期间头部跟随权重降低；减少动态模式下头部不跟随
  function headWeight() {
    if (reducedMotion.matches) return 0;
    const s = mascot.dataset.state;
    if (s === STATE.SAD || s === STATE.ANGRY || mascot.classList.contains('is-boing')) return 0.3;
    return 1;
  }
  function refreshGeom() {
    if (!geomStale) return;
    const r = head.getBoundingClientRect();
    headCx = r.left + r.width / 2;
    headCy = r.top + r.height / 2;
    eyeCenters = pupils.map((p) => {
      const e = p.closest('.eye').getBoundingClientRect();
      return { x: e.left + e.width / 2, y: e.top + e.height / 2 };
    });
    geomStale = false;
  }
  function followFrame() {
    rafId = 0;
    refreshGeom();
    const now = Date.now();
    const idle = now - lastMoveAt > HEAD_IDLE_MS;
    const w = headWeight();
    // 瞳孔：即时跟随，期待态同步放大（含高光）；鼠标尚未移动过时保持居中
    const scale = mascot.dataset.state === STATE.EAGER ? 1.22 : 1;
    if (lastMoveAt) {
      pupils.forEach((p, i) => {
        const c = eyeCenters[i];
        const dx = cursorX - c.x;
        const dy = cursorY - c.y;
        const dist = Math.hypot(dx, dy) || 1;
        const k = Math.min(dist / 30, 1) * MAX_SHIFT; // 近处小动、远处封顶
        p.style.transform = `translate(${(dx / dist) * k}px, ${(dy / dist) * k}px) scale(${scale})`;
      });
    } else {
      // 未追踪过鼠标时也同步期待态的瞳孔缩放（如键盘聚焦触发）
      pupils.forEach((p) => { p.style.transform = scale === 1 ? '' : `scale(${scale})`; });
    }
    // 头部：目标角度按鼠标方向与距离衰减，静止回中；阻尼趋近形成自然惯性
    const dx = cursorX - headCx;
    const dy = cursorY - headCy;
    const dist = Math.hypot(dx, dy) || 1;
    const reach = idle ? 0 : Math.min(dist / 140, 1) * w; // 距离越远转动越趋饱和
    headRig.tRot = (dx / dist) * HEAD_MAX_ROT * reach;
    headRig.tX = (dx / dist) * HEAD_MAX_X * reach;
    headRig.tY = (dy / dist) * HEAD_MAX_Y * reach;
    headRig.rot += (headRig.tRot - headRig.rot) * HEAD_EASE;
    headRig.x += (headRig.tX - headRig.x) * HEAD_EASE;
    headRig.y += (headRig.tY - headRig.y) * HEAD_EASE;
    head.style.setProperty('--head-rot', `${headRig.rot.toFixed(2)}deg`);
    head.style.setProperty('--head-x', `${headRig.x.toFixed(2)}px`);
    head.style.setProperty('--head-y', `${headRig.y.toFixed(2)}px`);
    // 未静止或未归位时继续下一帧，否则停表省电
    const settled =
      Math.abs(headRig.tRot - headRig.rot) < 0.02 &&
      Math.abs(headRig.tX - headRig.x) < 0.02 &&
      Math.abs(headRig.tY - headRig.y) < 0.02;
    if (!idle || !settled) rafId = requestAnimationFrame(followFrame);
  }
  document.addEventListener('mousemove', (e) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    lastMoveAt = Date.now();
    if (!rafId) rafId = requestAnimationFrame(followFrame);
  }, { passive: true });
  // 滚动/缩放后几何缓存失效，下一帧重取
  window.addEventListener('scroll', () => { geomStale = true; }, { passive: true });
  window.addEventListener('resize', () => { geomStale = true; });

  /* --- 悬停/键盘聚焦大按钮 → 期待 / 好奇（优先级高于失落） --- */
  function bindHoverState(btn, state) {
    if (!btn) return;
    const enter = () => { if (mascot.dataset.state !== STATE.ANGRY) setState(state); };
    const leave = () => { if (mascot.dataset.state === state) setState(STATE.IDLE); };
    btn.addEventListener('mouseenter', enter);
    btn.addEventListener('mouseleave', leave);
    btn.addEventListener('focus', enter);
    btn.addEventListener('blur', leave);
  }
  bindHoverState($('#goShareBtn'), STATE.EAGER);
  bindHoverState($('#goNeedBtn'), STATE.CURIOUS);

  /* --- 彩蛋 1：鼠标离开窗口 → 失落 2.5 秒后自动恢复（触屏设备跳过） --- */
  if (canHover) {
    document.addEventListener('mouseout', (e) => {
      if (e.relatedTarget) return; // 仍在页面内
      if (Date.now() < cooldownUntil) return;
      const s = mascot.dataset.state;
      if (s !== STATE.IDLE && s !== STATE.EAGER && s !== STATE.CURIOUS) return;
      setState(STATE.SAD);
      sadTimer = setTimeout(() => {
        if (mascot.dataset.state === STATE.SAD) setState(STATE.IDLE);
      }, 2500);
    });
  }

  /* --- 点击：弹跳 + 问候；1.5 秒内连点 ≥4 次 → 生气 2 秒（随后冷却 8 秒） --- */
  let clickTimes = [];
  let boingTimer = 0;
  function enterAngry() {
    setState(STATE.ANGRY);
    showBubble(COMPLAINTS[Math.floor(Math.random() * COMPLAINTS.length)], true);
    angryTimer = setTimeout(() => {
      if (mascot.dataset.state === STATE.ANGRY) setState(STATE.IDLE);
      cooldownUntil = Date.now() + 8000;
    }, 2000);
  }
  mascot.addEventListener('click', () => {
    const now = Date.now();
    if (mascot.dataset.state === STATE.ANGRY) {
      showBubble(COMPLAINTS[Math.floor(Math.random() * COMPLAINTS.length)], true);
      return;
    }
    clickTimes = clickTimes.filter((t) => now - t < 1500); // 滑动窗口计数
    clickTimes.push(now);
    if (clickTimes.length >= 4 && now >= cooldownUntil) {
      clickTimes = [];
      enterAngry();
      return;
    }
    mascot.classList.remove('is-boing');
    void mascot.getBoundingClientRect(); // 强制回流，连续点击可重启动画
    mascot.classList.add('is-boing');
    clearTimeout(boingTimer);
    boingTimer = setTimeout(() => mascot.classList.remove('is-boing'), 620);
    showBubble(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  });

  /* --- 待机随机微动作：眨眼 / 抖耳 / 小袋鼠探头（触屏与减少动态模式下不调度） --- */
  let idleTimer = 0;
  let blinkTimer = 0;
  let peekTimer = 0;
  function playIdleMicro() {
    if (reducedMotion.matches || !canHover) return;
    if (mascot.dataset.state !== STATE.IDLE || mascot.classList.contains('is-boing')) return;
    const roll = Math.random();
    if (roll < 0.5) {
      // 眨眼（概率最高）
      mascot.classList.add('is-blinking');
      clearTimeout(blinkTimer);
      blinkTimer = setTimeout(() => mascot.classList.remove('is-blinking'), 200);
    } else if (roll < 0.8) {
      // 随机抖一只耳朵
      const ear = mascot.querySelector(Math.random() < 0.5 ? '.ear-l' : '.ear-r');
      ear.classList.add('is-twitch');
      ear.addEventListener('animationend', () => ear.classList.remove('is-twitch'), { once: true });
    } else {
      // 小袋鼠探头张望
      const joey = mascot.querySelector('.joey');
      if (joey) {
        joey.classList.add('is-peek');
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => joey.classList.remove('is-peek'), 900);
      }
    }
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      playIdleMicro();
      scheduleIdle();
    }, 3000 + Math.random() * 3000);
  }
  if (canHover && !reducedMotion.matches) scheduleIdle();

  /* --- 页面失焦时集中清理定时器，回来后复位并重新调度 --- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      [idleTimer, blinkTimer, peekTimer, boingTimer, bubbleTimer, sadTimer, angryTimer].forEach(clearTimeout);
      mascot.classList.remove('is-blinking', 'is-boing');
      const joey = mascot.querySelector('.joey');
      const ear = mascot.querySelector('.ear.is-twitch');
      if (joey) joey.classList.remove('is-peek');
      if (ear) ear.classList.remove('is-twitch');
    } else {
      if (mascot.dataset.state !== STATE.ANGRY) setState(STATE.IDLE);
      if (canHover && !reducedMotion.matches) scheduleIdle();
    }
  });
})();

/* ---------- 启动 ---------- */
initMeta();
showView('home');
