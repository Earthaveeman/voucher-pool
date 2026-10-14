const fs = require('fs');
const path = require('path');
const dns = require('node:dns');
const net = require('node:net');
const nodemailer = require('nodemailer');
const { OUTBOX_DIR } = require('./db');

// SMTP 三要素齐全则真实发信，否则模拟发信
const SMTP_HOST = process.env.SMTP_HOST || '';
const isReal = Boolean(SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

// 模拟发信：不联网，在内存中生成完整 RFC822 消息（含附件）
const mockTransporter = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'unix',
});

const from = process.env.SMTP_FROM || process.env.SMTP_USER || '票据分享池 <no-reply@localhost>';

// nodemailer 使用 c-ares 直查 DNS 服务器，当本机存在拒绝服务的 DNS 服务器时会超时；
// 这里改为系统解析（getaddrinfo）预解析出 IP 直连，TLS 的 SNI 与证书校验仍用域名（servername）。
async function createRealTransporter() {
  let host = SMTP_HOST;
  let tls = {};
  if (!net.isIP(host)) {
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      const addr = addrs.find((a) => a.family === 4) || addrs[0];
      tls = { servername: host };
      host = addr.address;
    } catch {
      // 系统解析也失败时，保持域名交由 nodemailer 自行解析
    }
  }
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: String(process.env.SMTP_SECURE ?? 'true') !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls,
  });
}

function logMode() {
  console.log(
    isReal
      ? '[mailer] SMTP 已配置，使用真实发信'
      : '[mailer] SMTP 未配置，使用模拟发信（邮件写入 data/outbox/，配置 .env 后自动切换真实发信）'
  );
}

async function sendMail({ to, subject, html, attachments = [] }) {
  const mail = { from, to, subject, html, attachments };
  if (isReal) {
    // 每次发信前重建 transporter：跟随 DNS 变化重新解析，避免缓存过期 IP
    const transporter = await createRealTransporter();
    await transporter.sendMail(mail);
    return { mode: 'smtp' };
  }
  const info = await mockTransporter.sendMail(mail);
  const safeTo = String(to).replace(/[^a-zA-Z0-9@._-]/g, '_');
  const file = path.join(OUTBOX_DIR, `${Date.now()}_${safeTo}.eml`);
  fs.writeFileSync(file, info.message.toString());
  console.log(`[mailer] 模拟发信已写入: ${file}`);
  return { mode: 'mock', file };
}

module.exports = { sendMail, logMode, isReal };
