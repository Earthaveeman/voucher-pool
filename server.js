const fs = require('fs');
const path = require('path');
const express = require('express');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // .env 格式异常时忽略，使用默认配置
  }
}

const routes = require('./routes');
const { logMode } = require('./mailer');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

app.use('/api', (_req, res) => {
  res.status(404).json({ message: '接口不存在' });
});

// 统一错误处理
app.use((err, _req, res, _next) => {
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '发票文件不能超过 10MB' : err.message || '文件上传失败';
    return res.status(400).json({ message: msg });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求体格式错误' });
  }
  if (err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  console.error(err);
  res.status(500).json({ message: '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`票据分享池已启动: http://localhost:${PORT}`);
  logMode();
});
