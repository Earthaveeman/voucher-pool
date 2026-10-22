const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // .env 格式异常时忽略，使用默认配置
    }
  } else {
    console.warn('[env] 当前 Node 版本不支持 process.loadEnvFile（需 ≥20.12），.env 未加载');
  }
}

const routes = require('./routes');
const { db } = require('./db');
const { logMode } = require('./mailer');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// 老浏览器/工具仍按惯例请求 /favicon.ico，兜底指向站点图标
app.get('/favicon.ico', (_req, res) => res.redirect('/favicon.png'));

// ---------- 限流：单实例内存滑动窗口，按 IP 计数 ----------
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) { // 防内存无界增长：顺带清理过期记录
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
    }
    const key = req.ip || 'unknown';
    const rec = hits.get(key);
    if (!rec || now - rec.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.start + windowMs - now) / 1000)));
      return res.status(429).json({ message: '点太快啦，喘口气再试哦' });
    }
    next();
  };
}

const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const claimLimiter = createRateLimiter({ windowMs: 60_000, max: 6 });

// 限流先于鉴权执行，约束令牌爆破与批量领取脚本
app.use('/api', apiLimiter);
app.use('/api/claims', claimLimiter);

// ---------- 鉴权：配置 ACCESS_TOKEN 后，/api 需携带 Authorization: Bearer <token> ----------
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

function tokenOk(received) {
  // 等长摘要后做常量时间比较，避免时序侧信道
  const a = crypto.createHash('sha256').update(String(received)).digest();
  const b = crypto.createHash('sha256').update(ACCESS_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

app.use('/api', (req, res, next) => {
  if (!ACCESS_TOKEN) return next(); // 未配置令牌时不鉴权（仅供本地测试）
  const auth = req.get('authorization') || '';
  const received = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (received && tokenOk(received)) return next();
  return res.status(401).json({ message: '小暗号不对哦，进不来呀' });
});

app.use('/api', routes);

app.use('/api', (_req, res) => {
  res.status(404).json({ message: '这里没有这个接口呀' });
});

// 兜底 404：浏览器页面请求重定向回首页，其余请求返回 JSON
app.use((req, res) => {
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
    return res.redirect('/');
  }
  res.status(404).json({ message: '这个东西找不到呀' });
});

// 统一错误处理
app.use((err, _req, res, _next) => {
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '票据文件太大啦，10MB 以内才行哦' : err.message || '文件上传失败啦';
    return res.status(400).json({ message: msg });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求体格式不太对哦' });
  }
  if (err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  console.error(err);
  res.status(500).json({ message: '服务器闹小脾气了，稍后再试试哦' });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`票据分享池开门营业啦: http://localhost:${PORT}`);
  logMode();
  console.log(
    ACCESS_TOKEN
      ? '[auth] ACCESS_TOKEN 已配置，API 已开启鉴权'
      : '[auth] 警告：未配置 ACCESS_TOKEN，API 无鉴权（仅供本地测试，外网部署务必配置）'
  );
});

// 优雅停机：等待存量请求结束后关闭数据库连接再退出
function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，正在停机…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // 连接已关闭或存在未释放语句时忽略
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref(); // 兜底：5 秒后强制退出
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
