// Finvora Trading Platform — API server entry point.
// Implements BPD v2.1 Phase 1: all 14 stages, Administrator Console,
// Notification Centre, Payment Gateway Integration, Live Market Data
// Integration, Reporting (incl. Audit, Settlement, Feed Health).
const express = require('express');
require('express-async-errors'); // route handlers' async errors reach the error middleware
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db'); // async Postgres layer — db.init() runs the schema + seeds

const market = require('./marketdata');
const gateway = require('./gateway');

const authRoutes = require('./routes/auth.routes');
const kycBankRoutes = require('./routes/kyc-bank.routes');
const depositRoutes = require('./routes/deposits.routes');
const orderRoutes = require('./routes/orders.routes');
const portfolioRoutes = require('./routes/portfolio.routes');
const withdrawalRoutes = require('./routes/withdrawals.routes');
const adminRoutes = require('./routes/admin.routes');
const reportRoutes = require('./routes/reports.routes');
const marketRoutes = require('./routes/market.routes');

const app = express();
app.disable('x-powered-by');

// Raw body capture — required for webhook HMAC signature verification.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Dev CORS (Vite dev server on :5173). In production the API serves the PWA itself.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Signature, X-Razorpay-Signature');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhook endpoints (public — signature-verified, not JWT-authenticated).
// Only the endpoint matching the active gateway mode is mounted, so the mock
// self-signed webhook cannot be invoked in a real-gateway deployment.
if (config.gatewayMode === 'mock') {
  app.post('/api/gateway/webhook', depositRoutes.webhookHandler('mock'));
} else if (config.gatewayMode === 'razorpay') {
  app.post('/api/gateway/webhook/razorpay', depositRoutes.webhookHandler('razorpay'));
}

app.use('/api/auth', authRoutes.router);
app.use('/api', kycBankRoutes.router);
app.use('/api', depositRoutes.router);
app.use('/api', orderRoutes.router);
app.use('/api', portfolioRoutes.router);
app.use('/api', withdrawalRoutes.router);
app.use('/api', marketRoutes.router);
app.use('/api', require('./routes/markets.routes').router);
app.use('/api/admin', adminRoutes.router);
app.use('/api/admin', reportRoutes.router);

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Finvora API', version: '2.1.0', feed: market.publicHealth() }));

// Public UI config — lets the client hide developer/demo scaffolding (on-screen
// OTP hints, demo-login box) in a production deployment. DEMO_HINTS=false forces
// them off even while still using the free demo SMS mode.
app.get('/api/app-config', (req, res) => {
  const demoHints = process.env.DEMO_HINTS != null ? process.env.DEMO_HINTS === 'true' : config.smsMode === 'demo';
  res.json({
    brand: process.env.BRAND_NAME || 'Finvora',
    demo_hints: demoHints,
    sms_demo: config.smsMode === 'demo',
    gateway_mock: config.gatewayMode === 'mock',
  });
});

// Serve the built PWA (single-server production deploy).
const dist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

async function main() {
  await db.init();          // create schema + seed admin/instruments (Postgres / Supabase or local PGlite)
  await market.start();     // load instruments into memory + start the live feed
  gateway.startWatchdog();
  app.listen(config.port, () => {
    console.log(`\nFinvora API running   → http://localhost:${config.port}`);
    console.log(`DB: ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'local PGlite (data/pgdata)'}`);
    console.log(`Feed mode: ${config.feedMode} | Gateway mode: ${config.gatewayMode} | SMS mode: ${config.smsMode}`);
    console.log('Admin login → mobile: 9999999999  password: Admin@123\n');
  });
}
main().catch((e) => { console.error('[startup] failed:', e); process.exit(1); });
