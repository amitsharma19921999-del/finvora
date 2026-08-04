// Postgres data layer. Runs on Supabase (or any Postgres) in production via
// DATABASE_URL, and on an embedded PGlite (real Postgres in WASM, file-persisted)
// locally when DATABASE_URL is not set — same async SQL both ways.
//
// All query helpers are async. `tx()` runs its body inside a real transaction and,
// via AsyncLocalStorage, transparently routes every run/get/all inside it onto the
// transaction's connection — so money operations are atomic and can take row locks
// (SELECT ... FOR UPDATE) to prevent concurrent double-spends.
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

const als = new AsyncLocalStorage();
let backend = null; // { query, connect, execScript, end }

// --- SQL dialect shim: our statements are written SQLite-style ----------------
// Rewrites the SQLite idioms we use into Postgres, then `?` placeholders -> `$1,…`.
//   datetime('now')                 -> now()
//   datetime('now','+10 minutes')   -> (now() + interval '10 minutes')
//   datetime('now', ?)  (param mod) -> (now() + (?)::interval)   e.g. '-10 minutes'
//   date(X)                         -> (X)::date   (covers date('now'), date(col), date(?))
//   IFNULL(...)                     -> COALESCE(...)
function convert(sql) {
  let s = String(sql);
  s = s.replace(/datetime\('now'\s*,\s*'([^']+)'\)/gi, (_, mod) => `(now() + interval '${mod.replace(/^\+/, '')}')`);
  s = s.replace(/datetime\('now'\s*,\s*\?\)/gi, '(now() + (?)::interval)');
  s = s.replace(/datetime\('now'\)/gi, 'now()');
  s = s.replace(/\bdate\(([^)]+)\)/gi, '($1)::date');
  s = s.replace(/\bIFNULL\(/gi, 'COALESCE(');
  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);
  return s;
}
// Auto-add RETURNING id so run().lastInsertRowid works — except on the two tables
// whose primary key isn't `id` (wallets → user_id, settings → key).
function needsReturning(sql) {
  return /^\s*insert\s+into/i.test(sql) && !/returning/i.test(sql) && !/^\s*insert\s+into\s+(wallets|settings)\b/i.test(sql);
}

async function rawQuery(text, params) {
  const store = als.getStore();
  const exec = store || backend;
  const res = await exec.query(text, params || []);
  // Normalise timestamps to ISO strings so the app sees strings (as it did on
  // SQLite), not Date objects.
  if (res.rows) for (const row of res.rows) for (const k in row) if (row[k] instanceof Date) row[k] = row[k].toISOString();
  return res;
}

async function run(sql, ...params) {
  let s = convert(sql);
  if (needsReturning(sql)) s += ' RETURNING id';
  const r = await rawQuery(s, params);
  return { rows: r.rows || [], changes: r.rowCount, lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined };
}
async function get(sql, ...params) { return (await rawQuery(convert(sql), params)).rows[0]; }
async function all(sql, ...params) { return (await rawQuery(convert(sql), params)).rows; }

async function tx(fn) {
  const client = await backend.connect();
  try {
    await client.query('BEGIN');
    const r = await als.run(client, () => fn());
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    if (client.release) client.release();
  }
}

// --- Schema (Postgres) --------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  mobile TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'investor',
  status TEXT NOT NULL DEFAULT 'OTP Pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otps (
  id SERIAL PRIMARY KEY,
  mobile TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Admin-gated password resets. An investor's "forgot password" raises a request
-- here; only after an administrator approves it (which sends a one-time code) may
-- the investor set a new password, inside approved_until.
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'Pending',
  note TEXT,
  reject_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER,
  approved_until TIMESTAMPTZ,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS kyc (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL,
  dob TEXT NOT NULL,
  address TEXT NOT NULL,
  pan TEXT NOT NULL,
  aadhaar TEXT NOT NULL,
  photo_file TEXT,
  id_doc_file TEXT,
  status TEXT NOT NULL DEFAULT 'Submitted',
  reject_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  holder_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  proof_file TEXT,
  status TEXT NOT NULL DEFAULT 'Submitted',
  reject_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  utr TEXT,
  proof_file TEXT,
  gateway_order_id TEXT,
  gateway_txn_id TEXT,
  gateway_amount DOUBLE PRECISION,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_note TEXT,
  status TEXT NOT NULL,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  verified_by INTEGER
);
CREATE TABLE IF NOT EXISTS instruments (
  id SERIAL PRIMARY KEY,
  symbol TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'NSE',
  base_price DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL DEFAULT 'equity',
  underlying TEXT,
  opt_type TEXT,
  strike DOUBLE PRECISION,
  expiry TEXT,
  lot_size INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  ltp_at_order DOUBLE PRECISION,
  feed_status_at_order TEXT NOT NULL DEFAULT 'LIVE',
  status TEXT NOT NULL DEFAULT 'Pending',
  reject_reason TEXT,
  exec_price DOUBLE PRECISION,
  exec_qty INTEGER,
  exec_time TIMESTAMPTZ,
  realized_pnl DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS holdings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  qty INTEGER NOT NULL,
  avg_price DOUBLE PRECISION NOT NULL,
  UNIQUE(user_id, instrument_id)
);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  ref_table TEXT,
  ref_id INTEGER,
  amount DOUBLE PRECISION NOT NULL,
  balance_after DOUBLE PRECISION NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'Withdrawal Pending',
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processed_by INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  audience TEXT NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  ref_table TEXT,
  ref_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gateway_events (
  id SERIAL PRIMARY KEY,
  txn_id TEXT UNIQUE NOT NULL,
  order_id TEXT,
  payload TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_gateway_payments (
  id SERIAL PRIMARY KEY,
  txn_id TEXT UNIQUE NOT NULL,
  order_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL DEFAULT 'UPI',
  status TEXT NOT NULL,
  webhook_sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feed_health_log (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  price_band_pct: '5',
  webhook_timeout_min: '10',
  feed_stale_sec: '10',
  min_deposit: '100',
  min_withdrawal: '100',
};
const PAYMENT_DEFAULTS = {
  pay_account_name: '', pay_account_holder: '', pay_account_number: '', pay_ifsc: '',
  pay_bank: '', pay_branch: '', pay_upi: '', pay_qr_file: '',
  pay_note: 'After paying, upload the payment screenshot with the UTR / reference number.',
};

async function setting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : Number(DEFAULT_SETTINGS[key] || 0);
}
async function settingStr(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : (PAYMENT_DEFAULTS[key] ?? '');
}
async function setSetting(key, value) {
  await run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

// MCX-segment commodity contracts. Symbols must match COMMODITY_FEED in
// marketdata.js, which supplies the live (international-futures derived) price.
// [symbol, display name, placeholder base price, lot size]
const SEED_COMMODITIES = [
  ['GOLD', 'Gold (₹ / 10 g)', 71500, 1],
  ['SILVER', 'Silver (₹ / 1 kg)', 89000, 1],
  ['CRUDEOIL', 'Crude Oil (₹ / barrel)', 6200, 1],
  ['NATURALGAS', 'Natural Gas (₹ / mmBtu)', 250, 1],
  ['COPPER', 'Copper (₹ / kg)', 830, 1],
];

const SEED_INSTRUMENTS = [
  ['RELIANCE', 'Reliance Industries', 1315.0], ['TCS', 'Tata Consultancy Services', 4123.0],
  ['HDFCBANK', 'HDFC Bank', 1651.2], ['INFY', 'Infosys', 1548.6],
  ['ICICIBANK', 'ICICI Bank', 1204.4], ['SBIN', 'State Bank of India', 831.7],
  ['TATAMOTORS', 'Tata Motors', 991.3], ['ITC', 'ITC Limited', 466.2],
  ['LT', 'Larsen & Toubro', 3612.8], ['BHARTIARTL', 'Bharti Airtel', 1452.9],
  ['WIPRO', 'Wipro', 521.4], ['ADANIENT', 'Adani Enterprises', 3198.5],
  ['HINDUNILVR', 'Hindustan Unilever', 2450.0], ['KOTAKBANK', 'Kotak Mahindra Bank', 1795.0],
  ['AXISBANK', 'Axis Bank', 1180.0], ['BAJFINANCE', 'Bajaj Finance', 7200.0],
  ['MARUTI', 'Maruti Suzuki India', 12500.0], ['ASIANPAINT', 'Asian Paints', 2900.0],
  ['HCLTECH', 'HCL Technologies', 1780.0], ['SUNPHARMA', 'Sun Pharmaceutical', 1750.0],
  ['TITAN', 'Titan Company', 3600.0], ['ULTRACEMCO', 'UltraTech Cement', 11500.0],
  ['NESTLEIND', 'Nestle India', 2500.0], ['POWERGRID', 'Power Grid Corporation', 330.0],
  ['NTPC', 'NTPC', 360.0], ['ONGC', 'Oil & Natural Gas Corp', 270.0],
  ['TATASTEEL', 'Tata Steel', 155.0], ['JSWSTEEL', 'JSW Steel', 1000.0],
  ['COALINDIA', 'Coal India', 480.0], ['TECHM', 'Tech Mahindra', 1650.0],
  ['BAJAJFINSV', 'Bajaj Finserv', 1720.0], ['DRREDDY', "Dr Reddy's Laboratories", 1280.0],
  ['CIPLA', 'Cipla', 1520.0], ['TATACONSUM', 'Tata Consumer Products', 1080.0],
  ['GRASIM', 'Grasim Industries', 2680.0], ['HDFCLIFE', 'HDFC Life Insurance', 720.0],
  ['ADANIPORTS', 'Adani Ports & SEZ', 1350.0], ['ADANIGREEN', 'Adani Green Energy', 1050.0],
  ['ADANIPOWER', 'Adani Power', 590.0], ['ATGL', 'Adani Total Gas', 700.0],
  ['AMBUJACEM', 'Ambuja Cements', 560.0], ['APOLLOHOSP', 'Apollo Hospitals', 6800.0],
  ['BAJAJ-AUTO', 'Bajaj Auto', 9500.0], ['BANKBARODA', 'Bank of Baroda', 235.0],
  ['BEL', 'Bharat Electronics', 300.0], ['BPCL', 'Bharat Petroleum', 320.0],
  ['BRITANNIA', 'Britannia Industries', 5400.0], ['CANBK', 'Canara Bank', 100.0],
  ['CHOLAFIN', 'Cholamandalam Invest', 1500.0], ['DABUR', 'Dabur India', 520.0],
  ['DIVISLAB', "Divi's Laboratories", 6000.0], ['DLF', 'DLF', 780.0],
  ['EICHERMOT', 'Eicher Motors', 4900.0], ['GAIL', 'GAIL India', 200.0],
  ['GODREJCP', 'Godrej Consumer', 1200.0], ['HAVELLS', 'Havells India', 1650.0],
  ['HDFCAMC', 'HDFC AMC', 4300.0], ['HEROMOTOCO', 'Hero MotoCorp', 4500.0],
  ['HINDALCO', 'Hindalco Industries', 650.0], ['HINDPETRO', 'Hindustan Petroleum', 380.0],
  ['ICICIGI', 'ICICI Lombard', 1900.0], ['ICICIPRULI', 'ICICI Prudential Life', 650.0],
  ['INDIGO', 'InterGlobe Aviation', 4600.0], ['INDUSINDBK', 'IndusInd Bank', 1000.0],
  ['IOC', 'Indian Oil Corp', 140.0], ['IRCTC', 'IRCTC', 780.0],
  ['JINDALSTEL', 'Jindal Steel & Power', 950.0], ['JIOFIN', 'Jio Financial Services', 320.0],
  ['LICI', 'Life Insurance Corp', 900.0], ['LTIM', 'LTIMindtree', 5800.0],
  ['MOTHERSON', 'Samvardhana Motherson', 155.0], ['MPHASIS', 'Mphasis', 2800.0],
  ['MRF', 'MRF', 130000.0], ['MUTHOOTFIN', 'Muthoot Finance', 2000.0],
  ['NAUKRI', 'Info Edge India', 8000.0], ['NMDC', 'NMDC', 65.0],
  ['PAGEIND', 'Page Industries', 42000.0], ['PIDILITIND', 'Pidilite Industries', 3000.0],
  ['PNB', 'Punjab National Bank', 100.0], ['RECLTD', 'REC', 480.0],
  ['SAIL', 'Steel Authority of India', 120.0], ['SBICARD', 'SBI Cards & Payment', 720.0],
  ['SBILIFE', 'SBI Life Insurance', 1550.0], ['SHREECEM', 'Shree Cement', 27000.0],
  ['SIEMENS', 'Siemens', 6800.0], ['SRF', 'SRF', 2400.0],
  ['TATAPOWER', 'Tata Power', 380.0], ['TORNTPHARM', 'Torrent Pharma', 3300.0],
  ['TRENT', 'Trent', 6500.0], ['TVSMOTOR', 'TVS Motor', 2500.0],
  ['UPL', 'UPL', 620.0], ['VBL', 'Varun Beverages', 550.0],
  ['VEDL', 'Vedanta', 440.0], ['ZYDUSLIFE', 'Zydus Lifesciences', 950.0],
  ['ABB', 'ABB India', 6800.0], ['ACC', 'ACC', 2000.0],
  ['AUBANK', 'AU Small Finance Bank', 620.0], ['BANDHANBNK', 'Bandhan Bank', 180.0],
  ['BERGEPAINT', 'Berger Paints', 500.0], ['BIOCON', 'Biocon', 350.0],
  ['BOSCHLTD', 'Bosch', 34000.0], ['COLPAL', 'Colgate-Palmolive', 2700.0],
  ['CONCOR', 'Container Corp', 780.0], ['COFORGE', 'Coforge', 8000.0],
  ['CUMMINSIND', 'Cummins India', 3300.0], ['ESCORTS', 'Escorts Kubota', 3500.0],
  ['GODREJPROP', 'Godrej Properties', 2500.0], ['HAL', 'Hindustan Aeronautics', 4300.0],
  ['IDFCFIRSTB', 'IDFC First Bank', 65.0], ['INDHOTEL', 'Indian Hotels', 700.0],
  ['IGL', 'Indraprastha Gas', 200.0], ['LUPIN', 'Lupin', 2000.0],
  ['MARICO', 'Marico', 650.0], ['MAXHEALTH', 'Max Healthcare', 1000.0],
  ['NHPC', 'NHPC', 85.0], ['OBEROIRLTY', 'Oberoi Realty', 1900.0],
  ['OFSS', 'Oracle Fin Services', 11000.0], ['PERSISTENT', 'Persistent Systems', 5800.0],
  ['PETRONET', 'Petronet LNG', 320.0], ['PFC', 'Power Finance Corp', 450.0],
  ['POLYCAB', 'Polycab India', 6500.0], ['TATACOMM', 'Tata Communications', 1700.0],
  ['TATAELXSI', 'Tata Elxsi', 6500.0], ['YESBANK', 'Yes Bank', 20.0],
  ['ZOMATO', 'Eternal (Zomato)', 260.0], ['PAYTM', 'One97 (Paytm)', 900.0],
  ['NYKAA', 'FSN E-Commerce (Nykaa)', 180.0], ['DELHIVERY', 'Delhivery', 380.0],
  ['DMART', 'Avenue Supermarts', 4000.0], ['IDEA', 'Vodafone Idea', 8.0],
  ['INDUSTOWER', 'Indus Towers', 350.0], ['SUZLON', 'Suzlon Energy', 60.0],
  ['IREDA', 'IREDA', 180.0], ['BSE', 'BSE', 2600.0],
  ['HUDCO', 'HUDCO', 220.0], ['NATIONALUM', 'National Aluminium', 180.0],
];

// Create the backend, schema, and seed data. MUST be awaited before serving.
async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase / most managed PG need SSL
      max: 8,
    });
    backend = {
      query: (t, p) => pool.query(t, p),
      connect: () => pool.connect(),
      execScript: (sql) => pool.query(sql),
      end: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = path.join(config.dataDir, 'pgdata');
    const pg = new PGlite(dir);
    await pg.waitReady;
    backend = {
      query: (t, p) => pg.query(t, p),
      connect: async () => ({ query: (t, p) => pg.query(t, p), release() {} }),
      execScript: (sql) => pg.exec(sql),
      end: () => pg.close(),
    };
  }

  await backend.execScript(SCHEMA);

  // seed default settings + payment placeholders (idempotent)
  for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...PAYMENT_DEFAULTS })) {
    await run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', k, v);
  }

  // seed admin user + wallet
  const admin = await get("SELECT id FROM users WHERE role = 'admin'");
  if (!admin) {
    const r = await run("INSERT INTO users (mobile, email, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'Active')",
      '9999999999', 'admin@finvora.local', scryptHash('Admin@123'));
    await run('INSERT INTO wallets (user_id, balance) VALUES (?, ?)', r.lastInsertRowid, 0);
  }

  // seed instruments
  for (const [symbol, name, price] of SEED_INSTRUMENTS) {
    await run('INSERT INTO instruments (symbol, name, base_price) VALUES (?, ?, ?) ON CONFLICT(symbol) DO NOTHING', symbol, name, price);
  }
  // seed commodity contracts (MCX segment). base_price is only a placeholder for
  // the very first tick — the live price comes from marketdata.js COMMODITY_FEED.
  for (const [symbol, name, price, lot] of SEED_COMMODITIES) {
    await run(
      "INSERT INTO instruments (symbol, name, base_price, exchange, kind, lot_size) VALUES (?, ?, ?, 'MCX', 'commodity', ?) ON CONFLICT(symbol) DO NOTHING",
      symbol, name, price, lot,
    );
  }
}

module.exports = { init, run, get, all, tx, setting, settingStr, setSetting, scryptHash };
