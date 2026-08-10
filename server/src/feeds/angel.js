// Angel One SmartAPI feed client — REAL live market data (free).
//
// Replaces the three things the free Yahoo feed could not do:
//   1. NSE/BSE equities in real time (Yahoo's free NSE tier is ~15 minutes delayed)
//   2. REAL option chains — actual premiums, open interest and IV, instead of the
//      Black-Scholes-lite formula in options.js
//   3. REAL MCX commodity prices, instead of COMEX futures converted at USDINR
//
// Auth: SmartAPI issues a JWT that expires DAILY, so we log in automatically with
// a TOTP computed from the secret in .env (RFC 6238, implemented here so the
// server needs no extra npm dependency) and re-login on any 401.
const crypto = require('crypto');
const config = require('../config');

const BASE = 'https://apiconnect.angelone.in';
const SCRIP_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

// --- TOTP (RFC 6238) ----------------------------------------------------------
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totp(secret, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = (((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff)) % 1000000;
  return String(code).padStart(6, '0');
}

// --- session ------------------------------------------------------------------
let session = null;      // { jwt, feedToken, at }
let loggingIn = null;    // in-flight login promise (so concurrent callers share one)

const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': '127.0.0.1',
  'X-MACAddress': '00:00:00:00:00:00',
  'X-PrivateKey': config.angel.apiKey,
  ...extra,
});

function configured() {
  const a = config.angel;
  return !!(a.apiKey && a.clientCode && a.pin && a.totpSecret);
}

async function login() {
  if (loggingIn) return loggingIn;
  loggingIn = (async () => {
    const body = {
      clientcode: config.angel.clientCode,
      password: config.angel.pin,          // 4-digit MPIN (SmartAPI calls it "password")
      totp: totp(config.angel.totpSecret),
    };
    const r = await fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!j || j.status !== true || !j.data?.jwtToken) {
      throw new Error(`SmartAPI login failed: ${j?.message || j?.errorcode || `HTTP ${r.status}`}`);
    }
    session = { jwt: j.data.jwtToken, feedToken: j.data.feedToken, at: Date.now() };
    console.log('[angel] logged in — session valid for the trading day');
    return session;
  })().finally(() => { loggingIn = null; });
  return loggingIn;
}

async function ensureSession() {
  if (session && Date.now() - session.at < 8 * 3600 * 1000) return session;
  return login();
}

// Authenticated POST that transparently re-logs in once on an expired session.
async function post(path, body, retry = true) {
  const s = await ensureSession();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: headers({ Authorization: `Bearer ${s.jwt}` }),
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  const expired = r.status === 401 || (j && j.errorcode && /AG8001|AG8002|token/i.test(String(j.errorcode)));
  if (expired && retry) {
    session = null;
    return post(path, body, false);
  }
  if (!j || j.status !== true) throw new Error(`SmartAPI ${path}: ${j?.message || `HTTP ${r.status}`}`);
  return j.data;
}

// --- instrument master --------------------------------------------------------
// ~150k instruments (~20 MB). Fetched once a day and immediately reduced to just
// what this platform trades, so the big array can be garbage-collected — the box
// is memory-constrained.
const eqTokens = new Map();   // 'RELIANCE'   -> { token, lotsize, exch: 'NSE' }
const mcxTokens = new Map();  // 'GOLD'       -> { token, symbol, lotsize, expiry, exch: 'MCX' }
const optByUnderlying = new Map(); // 'NIFTY' -> [ { token, symbol, strike, expiry, type, lotsize } ]
let scripAt = 0;

// SmartAPI expiries look like '05OCT2026'. They must be compared as DATES —
// string order would put 05OCT before 19AUG.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function expiryMs(e) {
  const m = String(e || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return Infinity;
  return Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1]));
}

async function loadScripMaster(force = false) {
  if (!force && scripAt && Date.now() - scripAt < 12 * 3600 * 1000) return;
  const r = await fetch(SCRIP_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`scrip master HTTP ${r.status}`);
  const all = await r.json();

  eqTokens.clear(); mcxTokens.clear(); optByUnderlying.clear();
  for (const x of all) {
    const seg = x.exch_seg;
    if (seg === 'NSE' && typeof x.symbol === 'string' && x.symbol.endsWith('-EQ')) {
      eqTokens.set(x.symbol.slice(0, -3), { token: String(x.token), lotsize: Number(x.lotsize) || 1, exch: 'NSE' });
    } else if (seg === 'MCX' && x.name && x.instrumenttype === 'FUTCOM' && x.expiry) {
      // FUTCOM = the tradable futures contract (COMDTY is just the index, and
      // OPTFUT are options). Keep the nearest expiry that hasn't passed — that's
      // the front-month contract whose price traders actually see.
      const ms = expiryMs(x.expiry);
      if (ms < Date.now() - 86400000) continue;
      const prev = mcxTokens.get(x.name);
      if (!prev || ms < expiryMs(prev.expiry)) {
        mcxTokens.set(x.name, { token: String(x.token), symbol: x.symbol, lotsize: Number(x.lotsize) || 1, expiry: x.expiry, exch: 'MCX' });
      }
    } else if (seg === 'NFO' && x.name && (x.symbol || '').match(/(CE|PE)$/)) {
      const arr = optByUnderlying.get(x.name) || [];
      arr.push({
        token: String(x.token), symbol: x.symbol,
        strike: Number(x.strike) / 100, // SmartAPI quotes strike in paise
        expiry: x.expiry, type: x.symbol.slice(-2), lotsize: Number(x.lotsize) || 1,
      });
      optByUnderlying.set(x.name, arr);
    }
  }
  scripAt = Date.now();
  console.log(`[angel] instruments loaded — ${eqTokens.size} NSE equities, ${mcxTokens.size} MCX, ${optByUnderlying.size} option underlyings`);
}

const equityToken = (symbol) => eqTokens.get(String(symbol).toUpperCase()) || null;
const commodityToken = (name) => mcxTokens.get(String(name).toUpperCase()) || null;

// Option contracts for an underlying, optionally filtered to one expiry.
function optionsFor(underlying, expiry) {
  const arr = optByUnderlying.get(String(underlying).toUpperCase()) || [];
  return expiry ? arr.filter((o) => o.expiry === expiry) : arr;
}
// Expiries available for an underlying, soonest first (SmartAPI format: 28AUG2026).
function expiriesFor(underlying) {
  const seen = new Set();
  const cutoff = Date.now() - 86400000; // drop anything already expired
  for (const o of optionsFor(underlying)) if (o.expiry && expiryMs(o.expiry) >= cutoff) seen.add(o.expiry);
  return [...seen].sort((a, b) => expiryMs(a) - expiryMs(b));
}

// --- quotes -------------------------------------------------------------------
// mode: LTP | OHLC | FULL.  exchangeTokens = { NSE: ['2885'], MCX: ['114'], NFO: [...] }
// SmartAPI caps a request at 50 tokens, so batch.
async function quote(exchangeTokens, mode = 'FULL') {
  const out = [];
  const entries = Object.entries(exchangeTokens).filter(([, t]) => t && t.length);
  // flatten to (exchange, token) pairs then re-group into <=50 batches
  const flat = [];
  for (const [ex, toks] of entries) for (const t of toks) flat.push([ex, String(t)]);
  for (let i = 0; i < flat.length; i += 50) {
    const grouped = {};
    for (const [ex, t] of flat.slice(i, i + 50)) (grouped[ex] = grouped[ex] || []).push(t);
    try {
      const d = await post('/rest/secure/angelbroking/market/v1/quote/', { mode, exchangeTokens: grouped });
      if (d?.fetched) out.push(...d.fetched);
    } catch (e) {
      console.error('[angel] quote batch failed:', e.message);
    }
    if (i + 50 < flat.length) await new Promise((r) => setTimeout(r, 1100)); // ~1 req/sec limit
  }
  return out;
}

// Historical candles. interval e.g. ONE_MINUTE | FIVE_MINUTE | FIFTEEN_MINUTE | ONE_HOUR
// from/to are 'YYYY-MM-DD HH:mm' in IST.
async function candles(exchange, token, interval, from, to) {
  const d = await post('/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange, symboltoken: String(token), interval, fromdate: from, todate: to,
  });
  // [[timestamp, o, h, l, c, v], ...]
  return (d || []).map((k) => ({
    t: new Date(k[0]).getTime(), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) || 0,
  }));
}

module.exports = {
  configured, login, ensureSession, loadScripMaster,
  equityToken, commodityToken, optionsFor, expiriesFor,
  quote, candles, totp,
  _counts: () => ({ equities: eqTokens.size, mcx: mcxTokens.size, underlyings: optByUnderlying.size }),
};
