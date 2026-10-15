const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
for (const dir of [DATA_DIR, UPLOADS_DIR, OUTBOX_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'voucher-pool.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    amount           REAL NOT NULL,
    invoice_type     TEXT NOT NULL,
    invoice_month    TEXT NOT NULL,
    uploader_name    TEXT,
    uploader_contact TEXT,
    remark           TEXT,
    file_path        TEXT NOT NULL,
    file_name        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'available',
    claimant_email   TEXT,
    claimed_at       TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_status ON invoices(status);
  CREATE INDEX IF NOT EXISTS idx_type   ON invoices(invoice_type);
  CREATE INDEX IF NOT EXISTS idx_month  ON invoices(invoice_month);
  CREATE INDEX IF NOT EXISTS idx_created ON invoices(created_at DESC);
`);

// 简易事务包装：异常时自动回滚（node:sqlite 无内置 transaction 助手）
function transaction(fn) {
  return (...args) => {
    if (db.isTransaction) throw new Error('不允许嵌套事务');
    // IMMEDIATE 在事务开始即取写锁，避免 DEFERRED 模式下锁升级失败
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // 回滚也失败时连接将停留在事务态，后续所有事务都会失败；显式记录便于排查级联故障
        console.error('[db] 事务回滚失败，连接可能处于悬挂事务状态:', rollbackErr);
      }
      throw err;
    }
  };
}

module.exports = { db, transaction, UPLOADS_DIR, OUTBOX_DIR };
