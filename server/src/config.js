// Finvora server configuration. Values come from server/.env (optional) with
// safe free-mode defaults: demo OTP, mock payment gateway, simulated market feed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// Secrets: if not provided via env, auto-generate strong random values and
// persist them under the data dir so sessions/webhook signatures survive
// restarts. This closes the "publicly-known default secret" hole (a forged
// admin JWT / forged webhook) without forcing manual setup for the free path.
function persistedSecret(fileName, envValue) {
  if (envValue) return envValue;
  const dir = process.env.DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch { /* fall through to regenerate */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.warn(`[config] ${fileName.replace('.secret', '').toUpperCase()} not set — generated a random secret at data/${fileName}. Set it in .env for multi-instance deployments.`);
  return secret;
}

const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: persistedSecret('jwt.secret', process.env.JWT_SECRET),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),

  // Stage 2 — OTP: 'demo' shows the OTP in the API response/logs (free), 'twilio' sends real SMS.
  smsMode: process.env.SMS_MODE || 'demo',
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },

  // Stage 7/8 — Payment gateway: 'mock' (built-in, free) or 'razorpay' (test keys, free).
  gatewayMode: process.env.GATEWAY_MODE || 'mock',
  gatewayWebhookSecret: persistedSecret('gateway.secret', process.env.GATEWAY_WEBHOOK_SECRET),
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  // Stage 9 — Market feed: 'sim' (built-in live simulator, free) or 'yahoo' (free real quotes, no key).
  feedMode: process.env.FEED_MODE || 'sim',

  // Outbound proxy(ies) for market-data requests. Set PROXY_URLS to a comma-
  // separated list (http://user:pass@host:port, or socks5://…) and the server
  // rotates through them per request so the origin IP is masked/rotated. Plug in
  // a rotating-proxy provider's endpoints here. Empty = direct connection.
  proxyUrls: (process.env.PROXY_URLS || process.env.PROXY_URL || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  uploadsDir() { return path.join(this.dataDir, 'uploads'); },
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir(), { recursive: true });

module.exports = config;
