# 票据分享池（voucher-pool）

轻量化的票据共享流转小工具：把闲置票据分享到公共票据池，需要的人通过**智能推荐**或**手动筛选**选取票据，票据文件直接**投递到邮箱**。无需注册、无需登录，轻轻松松～

```
我有票据分享 ──▶ 上传票据文件+登记信息 ──▶ 进入公共票据池
                                              │
我需要票据 ──▶ 智能匹配 / 手动筛选 ──▶ 填写邮箱 ──▶ 票据文件发送到邮箱（票据锁定）
```

## 功能特性

### 分享上传
- 一屏表单：票据文件（必填）、金额、类型、开票年月、分享人信息（选填）、悄悄话备注
- 附件支持 jpg / png / webp / pdf，最大 10MB
- 票据类型固定四类：餐饮 / 汽油 / 通信 / 其他
- 开票年月格式 `YYYY-MM`（如 `2026-05`），前端原生月份选择器

### 智能推荐
输入想要的金额（可选类型过滤），系统自动匹配总额**略大于需求**的票据组合：

- **累计阶段**：严格按开票年月较早优先，且纳入后不超额
- **收尾阶段**：在能补足缺口的所有候选中选金额最小的一张（金额相同取日期较早）

示例：需求 ¥5000，池内有 2025-08/¥4800、2025-09/¥300、2026-05/¥5200
→ 推荐 ¥4800 + ¥300 = ¥5100（较早且更贴近），而非单张 ¥5200。

推荐结果支持逐张勾选微调后再领取；票据池总额不足时返回全部可用票据并明确提示。

### 手动筛选
按金额范围、类型、开票年月区间、状态组合筛选票据池。

### 领取投递
- 单张或批量领取统一走 `POST /api/claims`，填写收件邮箱即可
- 一次领取合并为**一封邮件**：全部票据附件 + 明细表（金额/类型/年月/备注/分享人）+ 合计金额
- 领取成功后票据立即锁定为「已被抱走」终态，**不可归还**、不可重复领取

### 状态机与并发安全

```
available ──单事务原子锁定──▶ 发送邮件 ──成功──▶ claimed（终态）
                │
                └──发送失败──▶ 自动回滚为 available（可再次领取）
```

- **all-or-nothing**：批量领取在单个数据库事务内逐条 CAS（`WHERE id=? AND status='available'`），任一票据被他人抢领则整批回滚，不产生部分领取
- **先锁定后发信**：并发抢领同一票据时只有一人成功（实测 20 并发恰好 1 成功、19 次 409）
- **发信失败回滚**：邮件发送异常时票据状态自动恢复可用，票据不会因故障被永久锁死

### 隐私与脱敏
列表与推荐接口只返回票据摘要，**不暴露**分享人联系方式、领取人邮箱、附件路径；票据附件仅通过邮件通道交付给领取人。

## 技术栈

| 层面 | 选型 | 说明 |
|------|------|------|
| 运行环境 | Node.js ≥ 22（推荐 24+） | 使用内置 `node:sqlite` 与 `process.loadEnvFile()` |
| 后端 | Express 5 | 轻量 HTTP 服务 |
| 数据库 | SQLite（`node:sqlite`，零原生依赖） | 单文件持久化，WAL 模式，同步事务 |
| 文件上传 | multer 2 | 磁盘存储 + 大小/类型白名单 |
| 邮件 | nodemailer 10 | SMTP 真实发信 / 未配置时模拟发信自动切换 |
| 前端 | 原生 HTML / CSS / JS | 单页三视图，零框架零构建 |

运行时依赖仅 3 个（express、multer、nodemailer），无任何构建步骤。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2.（可选）配置真实发信：复制模板并填入 SMTP 信息
cp .env.example .env

# 3. 启动
npm start
```

打开 http://localhost:3000 即可使用。

不配置 `.env` 时系统自动使用**模拟发信**：领取操作照常完成，完整邮件（含附件）以 `.eml` 文件写入 `data/outbox/`，可直接用邮件客户端（Outlook / Thunderbird / Foxmail）打开查看，方便本地开发调试。

## 邮件发信配置（.env）

| 变量 | 必填 | 说明 |
|------|------|------|
| `SMTP_HOST` | 是* | SMTP 服务器地址，如 `smtp.126.com`、`smtp.qq.com` |
| `SMTP_PORT` | 是* | 端口，SSL 通常 `465`，STARTTLS 为 `587` |
| `SMTP_SECURE` | 否 | `true`=SSL（默认），`false`=STARTTLS |
| `SMTP_USER` | 是* | SMTP 登录账号（完整邮箱地址） |
| `SMTP_PASS` | 是* | **授权密码**（网易/QQ 邮箱为授权码，非登录密码） |
| `SMTP_FROM` | 否 | 发件人显示，如 `票据分享池 <you@126.com>`，默认使用 SMTP_USER |
| `PORT` | 否 | 服务端口，默认 3000 |

\* 五项 `SMTP_*` 三要素（HOST/USER/PASS）齐全即自动切换真实发信，留空则模拟发信。

**126 邮箱配置示例**（需先在邮箱设置中开启 IMAP/SMTP 服务并获取授权密码）：

```env
SMTP_HOST=smtp.126.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=yourname@126.com
SMTP_PASS=你的授权密码
SMTP_FROM=票据分享池 <yourname@126.com>
PORT=3000
```

修改 `.env` 后重启服务生效。

## API 文档

所有接口挂在 `/api` 前缀，错误响应统一为 `{ "message": "中文错误说明" }`。

### 1. 分享上传 — `POST /api/invoices`

`multipart/form-data`：

| 字段 | 必填 | 说明 |
|------|------|------|
| `file` | 是 | 票据文件，jpg/png/webp/pdf，≤10MB |
| `amount` | 是 | 票据金额，>0 |
| `invoice_type` | 是 | 四类之一：餐饮 / 汽油 / 通信 / 其他 |
| `invoice_month` | 是 | 开票年月 `YYYY-MM` |
| `uploader_name` | 否 | 分享人姓名 |
| `uploader_contact` | 否 | 联系方式 |
| `remark` | 否 | 备注 |

成功 `201`，返回票据摘要（脱敏字段）。

### 2. 检索 — `GET /api/invoices`

Query 参数：`min_amount`、`max_amount`、`invoice_type`、`month_from`、`month_to`、`status`（`available` 默认 / `claimed` / `all`）。

返回 `{ items, total }`，按上传时间倒序，字段脱敏。

### 3. 智能推荐 — `GET /api/invoices/recommend`

Query 参数：`amount`（想要的金额，必填 >0）、`invoice_type`（可选，缺省为全部类型）。

返回 `{ items, total, target, sufficient }`；`sufficient=false` 表示票据池可用总额不足。

### 4. 领取 — `POST /api/claims`

```json
{ "ids": [1, 2, 3], "email": "someone@example.com" }
```

- 单张领取即 `ids` 只含一个元素，批量与单张同一端点
- 成功 `200`：`{ "count": 3, "message": "3 张票据已经飞向 … 啦，记得查收哦" }`
- `409`：所选票据中含已被抱走的票据（整批已回滚，可刷新重试）
- `500`：邮件发送失败（票据状态已回滚为可用）

### 5. 统计 — `GET /api/stats`

返回 `{ available, claimed }`。

## 项目结构

```
voucher-pool/
├── server.js          # 入口：加载 .env、静态托管、路由挂载、统一错误处理
├── db.js              # node:sqlite 初始化：WAL、建表、索引、事务包装、类型名迁移
├── mailer.js          # 发信：真实 SMTP / 模拟 .eml 双模式；含本机 DNS 预解析兼容
├── routes.js          # 5 个 API 端点 + 推荐算法 + 批量领取事务
├── package.json
├── .env.example       # SMTP 配置模板
├── .gitignore         # 忽略 node_modules/、data/、.env
├── data/              # 运行时自动创建（勿手动修改）
│   ├── voucher-pool.db    # SQLite 数据库
│   ├── uploads/           # 票据附件（uuid 重命名存储）
│   └── outbox/            # 模拟发信的 .eml 输出
└── public/            # 前端单页
    ├── index.html     # 三视图：首页（双大按钮）/ 分享页 / 领取页（双子标签）
    ├── style.css      # 响应式样式
    └── app.js         # 视图切换、筛选、推荐渲染、领取弹窗
```

## 数据模型

```sql
CREATE TABLE invoices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  amount           REAL NOT NULL,               -- 票据金额
  invoice_type     TEXT NOT NULL,               -- 四类白名单
  invoice_month    TEXT NOT NULL,               -- 开票年月 YYYY-MM
  uploader_name    TEXT,                        -- 分享人姓名（选填）
  uploader_contact TEXT,                        -- 分享人联系方式（选填）
  remark           TEXT,
  file_path        TEXT NOT NULL,               -- 附件存储文件名（uuid.ext）
  file_name        TEXT NOT NULL,               -- 附件原始文件名（邮件中还原）
  status           TEXT NOT NULL DEFAULT 'available',  -- available | claimed
  claimant_email   TEXT,                        -- 领取人邮箱
  claimed_at       TEXT,                        -- 领取时间
  created_at       TEXT NOT NULL
);
```

## 常见问题

**Q：邮件发不出去，提示 DNS lookup timed out？**

部分企业网络 / VPN 客户端会在网卡上写入异常的 DNS 服务器导致 nodemailer 的域名解析失败。本项目已在 `mailer.js` 内置兼容：发信前用系统解析预解析出 IP 直连，TLS 证书校验仍按域名进行。若仍失败，请检查网络对 SMTP 端口（465/587）的出站限制。

**Q：126/QQ 邮箱报认证失败（535）？**

`SMTP_PASS` 必须是邮箱后台生成的**授权码/授权密码**，不是邮箱登录密码；且 `SMTP_USER` 需为完整邮箱地址。

**Q：数据存在哪里？如何备份/重置？**

全部数据在 `data/` 目录（数据库 + 附件）。停止服务后复制该目录即完成备份；删除该目录并重启即重置为空票据池。

**Q：已领取的票据可以退回吗？**

不可以。状态机为 `available → claimed` 单向终态，避免票据被反复占用产生纠纷；领取前请确认需求并在推荐结果中微调勾选。

**Q：附件有哪些限制？**

单文件 ≤10MB，仅支持 jpg / png / webp / pdf；上传时校验失败会返回中文错误提示，且不会在服务器留下孤儿文件。
