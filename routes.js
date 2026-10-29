const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, transaction, UPLOADS_DIR } = require('./db');
const { sendMail } = require('./mailer');
const { findBestMatch } = require('./matcher');

const router = express.Router();

const INVOICE_TYPES = ['餐饮', '汽油', '通信', '其他'];
const MAX_CLAIM_COUNT = 10;
const MAX_MATCH_AMOUNT = 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FILE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = FILE_TYPES.get(file.mimetype) || '.bin';
    cb(null, crypto.randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (FILE_TYPES.has(file.mimetype)) return cb(null, true);
    const err = new Error('票据文件只认 jpg/png/webp/pdf 这几种格式哦');
    err.status = 400;
    cb(err);
  },
});

// 列表/推荐对外脱敏：不含分享人联系方式、领取人邮箱、附件路径
function toPublic(inv) {
  if (!inv) return null;
  return {
    id: inv.id,
    amount: inv.amount,
    invoice_type: inv.invoice_type,
    invoice_month: inv.invoice_month,
    remark: inv.remark,
    status: inv.status,
    created_at: inv.created_at,
  };
}

function cleanOptional(v, max = 100) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

// multer/busboy 可能把 UTF-8 文件名按 latin1 误解码（如中文变乱码）；
// 检测到典型高位字符时按 UTF-8 重解码，并清洗控制字符、限制长度
function fixOriginalName(name) {
  let s = String(name ?? '');
  if (/[\u0080-\u00FF]/.test(s)) {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD')) s = fixed;
  }
  return s.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200) || 'invoice';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function money(n) {
  return `¥${Number(n).toFixed(2)}`;
}

function buildClaimEmailHtml(rows, total) {
  const trs = rows.map((r, i) => `
    <tr style="background:${i % 2 ? '#fff7ee' : '#ffffff'};">
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf; color:#a292b8;">${i + 1}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf; font-weight:700; color:#f0457e;">${money(r.amount)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf;">${esc(r.invoice_type)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf;">${esc(r.invoice_month)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf;">${esc(r.remark || '—')}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf;">${esc(r.uploader_name || '—')}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #f3e2cf;">${esc(r.uploader_contact || '—')}</td>
    </tr>`).join('');
  return `
  <div style="background:#fff7ee; padding:32px 16px; font-family:-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; color:#4a3f55;">
    <div style="max-width:640px; margin:0 auto; background:#ffffff; border-radius:18px; overflow:hidden; box-shadow:0 4px 16px rgba(74,63,85,0.08);">

      <div style="background:#ff6b9d; background:linear-gradient(120deg, #ff6b9d, #9775fa); padding:32px 32px 28px; text-align:center;">
        <div style="font-size:44px; line-height:1;">💌</div>
        <h1 style="margin:14px 0 6px; font-size:24px; color:#ffffff; letter-spacing:1px;">您抱走的 ${rows.length} 张票据到啦～</h1>
        <p style="margin:0; font-size:14px; color:#ffe3ee;">票据分享池 · 小信鸽加急派送</p>
      </div>

      <div style="padding:28px 32px;">
        <p style="margin:0 0 18px; font-size:15px; line-height:1.8;">
          嗨～${rows.length} 个票据文件已经整整齐齐地躺在附件里啦，明细清单请过目：
        </p>

        <table cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; font-size:14px; border:1px solid #f3e2cf; border-radius:12px; overflow:hidden;">
          <tr style="background:#12b8a6;">
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">序号</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">金额</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">类型</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">开票年月</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">备注</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">分享人</th>
            <th style="padding:10px 12px; color:#ffffff; font-weight:600; text-align:left;">联系方式</th>
          </tr>
          ${trs}
        </table>

        <div style="margin-top:18px; padding:14px 18px; background:#fff3bf; border-radius:12px; font-size:15px;">
          🧾 合计金额：<b style="color:#f0457e; font-size:18px;">${money(total)}</b>
        </div>

        <p style="margin:20px 0 0; font-size:13px; line-height:1.8; color:#a292b8;">
          小约定：如果这些票据后来用不上，欢迎再分享回池子里，让它们继续帮助下一位小伙伴呀～
        </p>
      </div>

      <div style="padding:16px 32px 24px; border-top:1px dashed #f3e2cf; text-align:center; font-size:12px; color:#a292b8;">
        这封邮件是票据分享池派出的小信使 🕊️ 祝您报销顺利，天天开心～
      </div>

    </div>
  </div>`;
}

const byDateAsc = (a, b) =>
  a.invoice_month === b.invoice_month
    ? a.amount - b.amount
    : a.invoice_month < b.invoice_month ? -1 : 1;

// ---------- 1. 分享上传 ----------
router.post('/invoices', upload.single('file'), (req, res, next) => {
  try {
    const { amount, invoice_type, invoice_month } = req.body;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, '票据金额要填对哦，大于 0 才行');
    if (!INVOICE_TYPES.includes(invoice_type)) throw new HttpError(400, '票据类型还没选呢');
    if (!MONTH_RE.test(String(invoice_month || ''))) throw new HttpError(400, '开票年月要写成 YYYY-MM 哦（比如 2026-05）');
    if (!req.file) throw new HttpError(400, '票据文件还没传哦（jpg/png/webp/pdf，10MB 以内）');

    const info = db.prepare(`
      INSERT INTO invoices (amount, invoice_type, invoice_month, uploader_name, uploader_contact, remark, file_path, file_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)
    `).run(
      amt,
      invoice_type,
      invoice_month,
      cleanOptional(req.body.uploader_name),
      cleanOptional(req.body.uploader_contact),
      cleanOptional(req.body.remark, 200),
      req.file.filename,
      fixOriginalName(req.file.originalname),
      new Date().toISOString()
    );

    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(toPublic(inv));
  } catch (err) {
    // 校验失败时清理已落盘的附件，避免孤儿文件
    if (req.file) fs.unlink(req.file.path, () => {});
    next(err);
  }
});

// ---------- 元信息：类型清单等由服务端统一下发，避免前后端双份维护 ----------
router.get('/meta', (_req, res) => {
  res.json({ invoice_types: INVOICE_TYPES, max_claim_count: MAX_CLAIM_COUNT, max_match_amount: MAX_MATCH_AMOUNT });
});

// ---------- 2. 检索 ----------
router.get('/invoices', (req, res, next) => {
  try {
    const q = req.query;
    const where = [];
    const params = [];

    // 状态：单选下拉，不传/传空即查询全部
    const status = q.status === 'available' || q.status === 'claimed' ? q.status : null;
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (q.min_amount != null && q.min_amount !== '') {
      const v = Number(q.min_amount);
      if (!Number.isFinite(v)) throw new HttpError(400, '最小金额好像不太对哦');
      where.push('amount >= ?');
      params.push(v);
    }
    if (q.max_amount != null && q.max_amount !== '') {
      const v = Number(q.max_amount);
      if (!Number.isFinite(v)) throw new HttpError(400, '最大金额好像不太对哦');
      where.push('amount <= ?');
      params.push(v);
    }
    if (q.invoice_type != null) {
      // 支持多选：同名参数重复出现时（express 默认解析）按 IN 查询
      const types = (Array.isArray(q.invoice_type) ? q.invoice_type : [q.invoice_type]).filter(Boolean);
      for (const t of types) {
        if (!INVOICE_TYPES.includes(t)) throw new HttpError(400, '这个票据类型小系统不认识呀');
      }
      if (types.length) {
        where.push(`invoice_type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (q.invoice_month) {
      // 精确匹配某个月，如 2026-05
      if (!MONTH_RE.test(q.invoice_month)) throw new HttpError(400, '开票年月要写成 YYYY-MM 哦');
      where.push('invoice_month = ?');
      params.push(q.invoice_month);
    }
    if (q.month_from) {
      if (!MONTH_RE.test(q.month_from)) throw new HttpError(400, '起始年月要写成 YYYY-MM 哦');
      where.push('invoice_month >= ?');
      params.push(q.month_from);
    }
    if (q.month_to) {
      if (!MONTH_RE.test(q.month_to)) throw new HttpError(400, '结束年月要写成 YYYY-MM 哦');
      where.push('invoice_month <= ?');
      params.push(q.month_to);
    }

    // 分页：默认第 1 页、每页 100 条，单页上限 200
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.page_size) || 100));
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM invoices ${whereSql}`).get(...params).c;
    // 固定排序：未认领在前、已被认领在后；组内按开票年月升序（同年月按入库先后）
    const items = db
      .prepare(`SELECT * FROM invoices ${whereSql} ORDER BY status = 'claimed' ASC, invoice_month ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map(toPublic);
    res.json({ items, total, page, page_size: pageSize, has_more: page * pageSize < total });
  } catch (err) {
    next(err);
  }
});

// ---------- 3. 智能推荐 ----------
// 开票年月 → 序数（YYYY*12+月序）：数值越小代表开票越早
const monthOrd = (m) => Number(m.slice(0, 4)) * 12 + (Number(m.slice(5, 7)) - 1);

// 组装匹配说明（差额/张数/策略），文案供前端直接展示
function buildMatchExplain(match, target) {
  if (!match || match.count === 0) {
    return { exact: false, gap: -target, count: 0, strategy: '池子里暂时没有能匹配的票据呀，先去别处逛逛？' };
  }
  const gap = match.gapCents / 100;
  let strategy;
  if (match.exact) {
    strategy = '一分不差，刚好凑齐啦～';
  } else if (match.gapCents > 0) {
    strategy = `没有刚好凑齐的组合，这组只多出 ${money(gap)}，已经是差额最小的一组啦`;
  } else {
    strategy = `池子凑不够，这 ${match.count} 张离目标最近，还差 ${money(-gap)}，有新票进来再来试试嘛`;
  }
  return { exact: match.exact, gap, count: match.count, strategy };
}

router.get('/invoices/recommend', (req, res, next) => {
  try {
    const target = Number(req.query.amount);
    if (!Number.isFinite(target) || target <= 0) throw new HttpError(400, '想要的金额要填对哦，大于 0 才行');
    if (target > MAX_MATCH_AMOUNT) throw new HttpError(400, `智能匹配的金额最大允许为${MAX_MATCH_AMOUNT}`);
    // 支持多选：invoice_type 参数可重复出现，一个都不传即不限类型
    const types = (Array.isArray(req.query.invoice_type) ? req.query.invoice_type : [req.query.invoice_type]).filter(Boolean);
    for (const t of types) {
      if (!INVOICE_TYPES.includes(t)) throw new HttpError(400, '这个票据类型小系统不认识呀');
    }

    const pool = types.length
      ? db.prepare(`SELECT * FROM invoices WHERE status='available' AND invoice_type IN (${types.map(() => '?').join(',')})`).all(...types)
      : db.prepare(`SELECT * FROM invoices WHERE status='available'`).all();

    // 金额统一换算为"分"（整数）参与匹配，规避二进制浮点误差（如 0.1 + 0.2 !== 0.3）
    const targetCents = Math.round(target * 100);
    const candidates = pool
      .map((inv) => ({ id: inv.id, cents: Math.round(inv.amount * 100), monthOrd: monthOrd(inv.invoice_month) }))
      .filter((c) => c.cents > 0);

    // 全新加权组合优化算法：差额最小 → 凑够优先 → 张数最少 → 年月较早
    const match = findBestMatch(candidates, targetCents, { maxCount: MAX_CLAIM_COUNT });

    const byId = new Map(pool.map((inv) => [inv.id, inv]));
    const pickedRows = match ? match.picked.map((id) => byId.get(id)).filter(Boolean) : [];
    pickedRows.sort(byDateAsc);

    const sumCents = pickedRows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    const total = sumCents / 100;
    const sufficient = sumCents >= targetCents;

    res.json({
      items: pickedRows.map(toPublic),
      total,
      target,
      sufficient,
      matchExplain: buildMatchExplain(match, target),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- 4. 领取（单张/批量，邮件投递） ----------
router.post('/claims', async (req, res, next) => {
  try {
    const { ids, email } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      throw new HttpError(400, '先挑一挑要领取的票据嘛');
    }
    if (ids.length > MAX_CLAIM_COUNT) {
      throw new HttpError(400, `一次最多抱 ${MAX_CLAIM_COUNT} 张哦，分几批来嘛`);
    }
    if (!EMAIL_RE.test(String(email ?? ''))) throw new HttpError(400, '邮箱地址好像写错了哦');

    const uniqueIds = [...new Set(ids)];
    const now = new Date().toISOString();

    // 单事务 all-or-nothing：任一票据已被抱走则整批回滚
    const claimOne = db.prepare(
      `UPDATE invoices SET status='claimed', claimant_email=?, claimed_at=? WHERE id=? AND status='available'`
    );
    const claimTx = transaction((idList) => {
      for (const id of idList) {
        if (claimOne.run(email, now, id).changes === 0) {
          throw new HttpError(409, '哎呀，有的票据已经被抱走啦，刷新一下再试试吧');
        }
      }
    });
    claimTx(uniqueIds);

    const rows = uniqueIds.map((id) => db.prepare('SELECT * FROM invoices WHERE id=?').get(id));
    const total = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
    const html = buildClaimEmailHtml(rows, total);
    const attachments = rows.map((r) => ({ filename: r.file_name, path: path.join(UPLOADS_DIR, r.file_path) }));

    try {
      await sendMail({
        to: email,
        subject: `【票据分享池】您抱走的 ${rows.length} 张票据来啦～`,
        html,
        attachments,
      });
    } catch {
      // 发信失败：批量回滚，票据重回可用
      const rollback = db.prepare(
        `UPDATE invoices SET status='available', claimant_email=NULL, claimed_at=NULL
         WHERE id IN (${uniqueIds.map(() => '?').join(',')}) AND status='claimed'`
      );
      rollback.run(...uniqueIds);
      throw new HttpError(500, '邮件飞不过去，稍后再试试哦');
    }

    res.json({ count: rows.length, message: `${rows.length} 张票据已经飞向 ${email} 啦，记得查收哦` });
  } catch (err) {
    next(err);
  }
});

// ---------- 5. 统计 ----------
router.get('/stats', (_req, res) => {
  const available = db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status='available'`).get().c;
  const claimed = db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status='claimed'`).get().c;
  res.json({ available, claimed });
});

module.exports = router;
