const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, transaction, UPLOADS_DIR } = require('./db');
const { sendMail } = require('./mailer');

const router = express.Router();

const INVOICE_TYPES = ['餐饮服务费', '车用汽油', '通信服务费', '其他'];
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
    const err = new Error('发票文件仅支持 jpg/png/webp/pdf 格式');
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
    <tr>
      <td>${i + 1}</td>
      <td>${money(r.amount)}</td>
      <td>${esc(r.invoice_type)}</td>
      <td>${esc(r.invoice_month)}</td>
      <td>${esc(r.remark || '—')}</td>
      <td>${esc(r.uploader_name || '—')}</td>
      <td>${esc(r.uploader_contact || '—')}</td>
    </tr>`).join('');
  return `
    <div style="font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; max-width: 640px;">
      <h3>您领取的 ${rows.length} 张发票文件</h3>
      <p>附件共 ${rows.length} 个文件，票据明细如下：</p>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-size: 14px;">
        <tr style="background:#f5f5f5;">
          <th>序号</th><th>金额</th><th>类型</th><th>开票年月</th><th>备注</th><th>分享人</th><th>联系方式</th>
        </tr>
        ${trs}
        <tr style="font-weight:bold;">
          <td>合计</td><td>${money(total)}</td><td colspan="5"></td>
        </tr>
      </table>
      <p style="color:#888;font-size:12px;">本邮件由票据分享池系统自动发送</p>
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
    if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, '请填写正确的发票金额');
    if (!INVOICE_TYPES.includes(invoice_type)) throw new HttpError(400, '请选择发票类型');
    if (!MONTH_RE.test(String(invoice_month || ''))) throw new HttpError(400, '开票年月格式应为 YYYY-MM（如 2026-05）');
    if (!req.file) throw new HttpError(400, '请上传发票文件（jpg/png/webp/pdf，不超过 10MB）');

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
      req.file.originalname,
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

// ---------- 2. 检索 ----------
router.get('/invoices', (req, res, next) => {
  try {
    const q = req.query;
    const where = [];
    const params = [];

    const status = q.status === 'claimed' ? 'claimed' : q.status === 'all' ? null : 'available';
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (q.min_amount != null && q.min_amount !== '') {
      const v = Number(q.min_amount);
      if (Number.isFinite(v)) {
        where.push('amount >= ?');
        params.push(v);
      }
    }
    if (q.max_amount != null && q.max_amount !== '') {
      const v = Number(q.max_amount);
      if (Number.isFinite(v)) {
        where.push('amount <= ?');
        params.push(v);
      }
    }
    if (q.invoice_type) {
      if (!INVOICE_TYPES.includes(q.invoice_type)) throw new HttpError(400, '发票类型不合法');
      where.push('invoice_type = ?');
      params.push(q.invoice_type);
    }
    if (q.month_from) {
      if (!MONTH_RE.test(q.month_from)) throw new HttpError(400, '起始年月格式应为 YYYY-MM');
      where.push('invoice_month >= ?');
      params.push(q.month_from);
    }
    if (q.month_to) {
      if (!MONTH_RE.test(q.month_to)) throw new HttpError(400, '结束年月格式应为 YYYY-MM');
      where.push('invoice_month <= ?');
      params.push(q.month_to);
    }

    const sql = `SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    const items = db.prepare(sql).all(...params).map(toPublic);
    res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

// ---------- 3. 智能推荐 ----------
router.get('/invoices/recommend', (req, res, next) => {
  try {
    const target = Number(req.query.amount);
    if (!Number.isFinite(target) || target <= 0) throw new HttpError(400, '请填写正确的需求金额');
    const type = req.query.invoice_type;
    if (type && !INVOICE_TYPES.includes(type)) throw new HttpError(400, '发票类型不合法');

    const pool = type
      ? db.prepare(`SELECT * FROM invoices WHERE status='available' AND invoice_type = ?`).all(type)
      : db.prepare(`SELECT * FROM invoices WHERE status='available'`).all();

    // 开票年月 ASC，同年月金额 ASC：优先日期较早
    const sorted = pool.sort(byDateAsc);
    // 金额 ASC，金额相同取日期较早：用于"收尾取超额最小"
    const byAmount = [...pool].sort((a, b) => a.amount - b.amount || byDateAsc(a, b));

    const selectedIds = new Set();
    const selected = [];
    let sum = 0;
    while (sum < target && selectedIds.size < sorted.length) {
      const gap = target - sum;
      const oldest = sorted.find((i) => !selectedIds.has(i.id));
      let pick;
      if (oldest.amount <= gap) {
        // 纳入后不超额：严格按较早日期优先
        pick = oldest;
      } else {
        // 收尾：取"金额≥缺口"的最小者（金额相同取日期较早）
        pick = byAmount.find((i) => !selectedIds.has(i.id) && i.amount >= gap) || oldest;
      }
      selectedIds.add(pick.id);
      selected.push(pick);
      sum = Math.round((sum + pick.amount) * 100) / 100;
    }

    selected.sort(byDateAsc);
    res.json({ items: selected.map(toPublic), total: sum, target, sufficient: sum >= target });
  } catch (err) {
    next(err);
  }
});

// ---------- 4. 领取（单张/批量，邮件投递） ----------
router.post('/claims', async (req, res, next) => {
  try {
    const { ids, email } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      throw new HttpError(400, '请选择要领取的票据');
    }
    if (!EMAIL_RE.test(String(email ?? ''))) throw new HttpError(400, '请填写正确的邮箱地址');

    const uniqueIds = [...new Set(ids)];
    const now = new Date().toISOString();

    // 单事务 all-or-nothing：任一票据已被领取则整批回滚
    const claimOne = db.prepare(
      `UPDATE invoices SET status='claimed', claimant_email=?, claimed_at=? WHERE id=? AND status='available'`
    );
    const claimTx = transaction((idList) => {
      for (const id of idList) {
        if (claimOne.run(email, now, id).changes === 0) {
          throw new HttpError(409, '所选票据中含已被领取的票据，请刷新后重试');
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
        subject: `【票据分享池】您领取的 ${rows.length} 张发票文件`,
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
      throw new HttpError(500, '邮件发送失败，请稍后重试');
    }

    res.json({ count: rows.length, message: `已将 ${rows.length} 张发票文件发送至 ${email}，请注意查收` });
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
