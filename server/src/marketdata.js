// Live Market Data Integration (BPD Stage 9, Sections 6/8/10/11.2).
// Modes:
//   sim   — built-in tick-by-tick simulator (free, default): random-walk LTP,
//           bid/ask, day high/low around seeded NSE-style base prices.
//   yahoo — free real quotes (no API key) polled from Yahoo Finance for .NS
//           symbols; falls back to DELAYED status on fetch errors.
// Feed health: LIVE | DELAYED | DOWN, logged to feed_health_log for the Feed
// Health Monitor Report; DOWN triggers the "Feed Disconnected" admin alert.
const config = require('./config');
const { all, run, setting } = require('./db');
const { emit } = require('./realtime');
const { notifyAdmin } = require('./util');
const opt = require('./options');

// Rotating outbound proxy for market-data requests (masks/rotates the origin IP
// when PROXY_URLS is configured; direct connection otherwise). Uses undici's
// ProxyAgent (built into Node) as the fetch dispatcher.
let _agents = null, _proxyIdx = 0;
function nextDispatcher() {
  if (!config.proxyUrls.length) return undefined;
  if (!_agents) {
    try { const { ProxyAgent } = require('undici'); _agents = config.proxyUrls.map((u) => new ProxyAgent(u)); }
    catch { _agents = []; }
  }
  if (!_agents.length) return undefined;
  return _agents[_proxyIdx++ % _agents.length];
}
// fetch wrapper that routes through the (rotating) proxy when configured.
function pfetch(url, opts = {}) {
  const d = nextDispatcher();
  return fetch(url, d ? { ...opts, dispatcher: d } : opts);
}

const quotes = new Map();  // symbol -> quote
const byYsym = new Map();  // feed (Yahoo) symbol -> quote
const candles = new Map(); // symbol -> [{ t, o, h, l, c, v }] of 1-minute base candles

// Live market indices (Groww/Zerodha-style strip). Yahoo tickers with ^ prefix.
const INDEX_DEFS = [
  { symbol: 'NIFTY 50', y: '^NSEI', base: 24100 },
  { symbol: 'NIFTY BANK', y: '^NSEBANK', base: 51800 },
  { symbol: 'SENSEX', y: '^BSESN', base: 79200 },
  { symbol: 'NIFTY IT', y: '^CNXIT', base: 37600 },
  { symbol: 'NIFTY FIN', y: 'NIFTY_FIN_SERVICE.NS', base: 23200 },
];
// --- Commodities (MCX-style contracts) ----------------------------------------
// There is no free official MCX price feed. These track the REAL international
// futures contract (COMEX/NYMEX, via the same free Yahoo endpoint) and convert to
// INR using the live USDINR rate and the Indian quotation unit. They are genuine
// market prices, but they exclude Indian import duty and local basis, so they are
// an INDICATIVE reference — NOT the official MCX settlement price. Every such
// quote carries `indicative: true` so the UI can label it.
const OZ = 31.1034768; // grams per troy ounce
const LB = 0.45359237; // kg per pound
const COMMODITY_FEED = {
  GOLD: { y: 'GC=F', unit: 10 / OZ, quote: '₹ / 10 g' },
  SILVER: { y: 'SI=F', unit: 1000 / OZ, quote: '₹ / 1 kg' },
  CRUDEOIL: { y: 'CL=F', unit: 1, quote: '₹ / barrel' },
  NATURALGAS: { y: 'NG=F', unit: 1, quote: '₹ / mmBtu' },
  COPPER: { y: 'HG=F', unit: 1 / LB, quote: '₹ / kg' },
};
let usdInr = 0; // live USDINR=X — 0 until the first successful fetch (never price on 0)

const indices = new Map(); // symbol -> { symbol, ltp, prev_close, change, change_pct }
let health = { status: 'LIVE', since: new Date().toISOString(), lastTickAt: null, mode: config.feedMode };
let adminPaused = false;   // admin toggle to demo the "Live market feed disconnects" exception
let timer = null;

const MINUTE = 60000;
const BACKFILL = 240;      // ~4h of 1-minute history so charts are populated on load
const MAX_CANDLES = 1440;  // one trading-day cap per instrument
function round2(n) { return Math.round(n * 100) / 100; }
function bucketStart(tsMs) { return Math.floor(tsMs / MINUTE) * MINUTE; }

// Build synthetic 1-minute OHLC history ending exactly at `endPrice`, so the
// candlestick chart has depth the moment the dashboard opens (sim mode). A
// mean-reverting random walk keeps it realistic without wild spikes.
function backfillCandles(symbol, endPrice) {
  const closes = new Array(BACKFILL);
  let p = endPrice;
  for (let i = BACKFILL - 1; i >= 0; i--) { // walk backwards from the end price
    closes[i] = p;
    const drift = (endPrice - p) * 0.02;     // gentle pull toward the end price
    p = p * (1 + gaussian() * 0.0016) - drift;
  }
  const nowBucket = bucketStart(Date.now());
  const arr = [];
  for (let i = 0; i < BACKFILL; i++) {
    const o = i === 0 ? closes[0] * (1 + gaussian() * 0.001) : closes[i - 1];
    const c = closes[i];
    const wick = Math.abs(gaussian()) * 0.0012 + 0.0004;
    arr.push({
      t: nowBucket - (BACKFILL - i) * MINUTE,
      o: round2(o), c: round2(c),
      h: round2(Math.max(o, c) * (1 + wick)),
      l: round2(Math.min(o, c) * (1 - wick)),
      v: Math.round(2000 + Math.random() * 9000),
    });
  }
  candles.set(symbol, arr);
}

// Fold a live tick into the current minute's candle (or open a new one).
function recordCandle(q, tickVol) {
  const arr = candles.get(q.symbol);
  if (!arr) return;
  const b = bucketStart(Date.now());
  const last = arr[arr.length - 1];
  if (last && last.t === b) {
    last.c = q.ltp;
    last.h = Math.max(last.h, q.ltp);
    last.l = Math.min(last.l, q.ltp);
    last.v += tickVol;
  } else {
    arr.push({ t: b, o: last ? last.c : q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, v: tickVol });
    if (arr.length > MAX_CANDLES) arr.shift();
  }
}

async function initQuotes() {
  // Option contracts (kind='option') are NOT live-feed instruments — they're
  // priced on demand from the underlying, so keep them out of the quote map and
  // the Yahoo fetch loop.
  quotes.clear();
  byYsym.clear();
  for (const inst of await all("SELECT * FROM instruments WHERE COALESCE(kind,'equity') <> 'option'")) {
    const cfg = inst.kind === 'commodity' ? COMMODITY_FEED[inst.symbol] : null;
    const prevClose = round2(inst.base_price * (1 + (Math.random() - 0.5) * 0.01));
    const q = {
      instrument_id: inst.id, symbol: inst.symbol, name: inst.name, exchange: inst.exchange,
      kind: inst.kind || 'equity', lot_size: inst.lot_size || 1,
      ltp: inst.base_price, bid: round2(inst.base_price * 0.9996), ask: round2(inst.base_price * 1.0004),
      open: inst.base_price, high: inst.base_price, low: inst.base_price,
      prev_close: prevClose, change_pct: round2(((inst.base_price - prevClose) / prevClose) * 100),
      volume: Math.round(50000 + Math.random() * 500000),
      spark: [inst.base_price], as_of: new Date().toISOString(),
      // feed routing: equities are <SYMBOL>.NS; commodities track an international
      // futures contract and are converted to INR (see COMMODITY_FEED).
      ysym: cfg ? cfg.y : `${inst.symbol}.NS`,
      conv: cfg ? cfg.unit : null,
      quote_unit: cfg ? cfg.quote : null,
      indicative: !!cfg,
    };
    quotes.set(inst.symbol, q);
    byYsym.set(q.ysym, q);
    backfillCandles(inst.symbol, inst.base_price);
  }
}

// Live USDINR, needed to price the commodity contracts in rupees.
async function refreshUsdInr() {
  const { result } = await fetchYahoo('USDINR=X');
  const p = result?.meta?.regularMarketPrice;
  if (p > 0) usdInr = Number(p);
}
const needsFx = () => [...quotes.values()].some((q) => q.conv);
// Convert a raw feed price into the rupee price we quote. Returns null when a
// commodity's FX rate isn't known yet, so we never publish a bogus ₹0.
function toInr(q, raw) {
  if (raw == null) return null;
  if (!q.conv) return round2(raw);
  if (!usdInr) return null;
  return round2(raw * usdInr * q.conv);
}

// Aggregate 1-minute base candles into the requested interval (minutes).
function getCandles(instrumentId, intervalMin = 1, limit = 150) {
  let symbol = null;
  for (const q of quotes.values()) if (q.instrument_id === instrumentId) { symbol = q.symbol; break; }
  const base = symbol ? candles.get(symbol) : null;
  if (!base || !base.length) return { instrument_id: instrumentId, symbol, interval_min: intervalMin, candles: [] };
  const span = intervalMin * MINUTE;
  const buckets = new Map();
  for (const k of base) {
    const bt = Math.floor(k.t / span) * span;
    const agg = buckets.get(bt);
    if (!agg) buckets.set(bt, { t: bt, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    else { agg.h = Math.max(agg.h, k.h); agg.l = Math.min(agg.l, k.l); agg.c = k.c; agg.v += k.v; }
  }
  const out = [...buckets.values()].sort((a, b) => a.t - b.t);
  return { instrument_id: instrumentId, symbol, interval_min: intervalMin, candles: out.slice(-limit) };
}

function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function setHealth(status, detail) {
  if (health.status === status) return;
  health = { ...health, status, since: new Date().toISOString() };
  run('INSERT INTO feed_health_log (status, detail) VALUES (?, ?)', status, detail || null).catch(() => {});
  emit('ALL', 'feedHealth', publicHealth());
  if (status === 'DOWN') {
    notifyAdmin('FEED_DISCONNECTED', 'Feed Disconnected',
      `Live market data feed is DOWN${detail ? ` — ${detail}` : ''}. Dashboard prices flagged as Delayed/Unavailable.`);
  }
}

let marketState = 'REGULAR'; // Yahoo marketState: PRE | REGULAR | POST | CLOSED
function publicHealth() {
  return {
    status: health.status, since: health.since, last_tick_at: health.lastTickAt,
    mode: activeMode, admin_paused: adminPaused,
    market_state: activeMode === 'yahoo' ? marketState : 'REGULAR',
  };
}

function simTick() {
  if (adminPaused) return;
  const now = new Date().toISOString();
  for (const q of quotes.values()) {
    let ltp = q.ltp * (1 + gaussian() * 0.0011);
    // clamp intraday move to ±8% of previous close
    ltp = Math.min(q.prev_close * 1.08, Math.max(q.prev_close * 0.92, ltp));
    q.ltp = round2(ltp);
    q.bid = round2(ltp * (1 - 0.0004));
    q.ask = round2(ltp * (1 + 0.0004));
    q.high = Math.max(q.high, q.ltp);
    q.low = Math.min(q.low, q.ltp);
    q.change_pct = round2(((q.ltp - q.prev_close) / q.prev_close) * 100);
    q.as_of = now;
    q.spark.push(q.ltp);
    if (q.spark.length > 90) q.spark.shift();
    const tickVol = Math.round(200 + Math.random() * 1800);
    q.volume += tickVol;
    recordCandle(q, tickVol);
  }
  simIndices();
  health.lastTickAt = now;
  setHealth('LIVE', 'Simulated feed ticking');
  emit('ALL', 'prices', snapshot());
}

// Parse Yahoo's real intraday OHLC arrays into our candle format. One request
// per symbol returns BOTH the live meta (LTP) and the full 1-minute history, so
// the chart shows genuine market data — not a synthetic backfill.
// Convert an OHLC series into rupees for commodity contracts (no-op for equities).
function convCandles(q, arr) {
  if (!q.conv) return arr;
  if (!usdInr) return [];
  const f = usdInr * q.conv;
  return arr.map((k) => ({ t: k.t, o: round2(k.o * f), h: round2(k.h * f), l: round2(k.l * f), c: round2(k.c * f), v: k.v }));
}

function parseYahooCandles(result) {
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const arr = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue; // skip gaps
    arr.push({ t: Math.floor(ts[i] / 60) * 60000, o: round2(o), h: round2(h), l: round2(l), c: round2(c), v: Math.round(v || 0) });
  }
  return arr;
}

async function fetchYahoo(ys, retry = 1) {
  try {
    const r = await pfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ys}?range=1d&interval=1m`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (r.status === 429 && retry > 0) { await new Promise((res) => setTimeout(res, 800)); return fetchYahoo(ys, retry - 1); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { ys, result: j?.chart?.result?.[0] };
  } catch (e) {
    if (retry > 0) { await new Promise((res) => setTimeout(res, 500)); return fetchYahoo(ys, retry - 1); }
    return { ys, result: null };
  }
}

// Run tasks with limited concurrency so we don't trip Yahoo's rate limiter.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

let yahooFailures = 0;
async function yahooTick() {
  if (adminPaused) return;
  try {
    if (needsFx()) await refreshUsdInr().catch(() => {});
    const symbols = [...quotes.values()].map((q) => q.ysym);
    const results = await mapLimit(symbols, 5, (ys) => fetchYahoo(ys));
    const now = new Date().toISOString();
    let ok = 0;
    for (const { ys, result } of results) {
      const meta = result?.meta;
      if (!meta?.regularMarketPrice) continue;
      const q = byYsym.get(ys);
      if (!q) continue;
      const ltp = toInr(q, meta.regularMarketPrice);
      if (ltp == null) continue; // commodity with no FX rate yet — skip, don't publish ₹0
      ok += 1;
      // marketState reflects the NSE session; commodity contracts follow their own.
      if (meta.marketState && !q.conv) marketState = meta.marketState;
      q.ltp = ltp;
      q.prev_close = toInr(q, meta.chartPreviousClose || meta.previousClose) ?? q.prev_close;
      q.high = toInr(q, meta.regularMarketDayHigh) ?? q.high;
      q.low = toInr(q, meta.regularMarketDayLow) ?? q.low;
      q.open = toInr(q, meta.regularMarketOpen) ?? q.open;
      q.bid = round2(q.ltp * 0.9996);
      q.ask = round2(q.ltp * 1.0004);
      q.change_pct = round2(((q.ltp - q.prev_close) / q.prev_close) * 100);
      q.volume = Math.round(meta.regularMarketVolume || q.volume);
      q.as_of = now;
      q.spark.push(q.ltp);
      if (q.spark.length > 90) q.spark.shift();
      // Replace the candle store with real Yahoo OHLC history.
      const real = convCandles(q, parseYahooCandles(result));
      if (real.length) {
        candles.set(q.symbol, real);
        // Real day-open from the session's first candle (meta.regularMarketOpen
        // is often absent — otherwise the seeded base price lingers).
        if (!meta.regularMarketOpen) q.open = real[0].o;
      }
    }
    if (ok === 0) throw new Error('no symbols returned data');
    health.lastTickAt = now;
    yahooFailures = 0;
    setHealth('LIVE', 'Yahoo Finance quotes updated');
    emit('ALL', 'prices', snapshot());
  } catch (e) {
    yahooFailures += 1;
    if (yahooFailures >= 3) setHealth('DELAYED', `Yahoo fetch failing: ${e.message}`);
    return false;
  }
  return true;
}

// --- Scalable live quotes: Yahoo "spark" returns MANY symbols per request (no
// API key), so we get real LTP + change for the whole universe cheaply. Detailed
// OHLC + candles for a symbol are fetched on demand when it's opened (below).
async function sparkBatch(syms) {
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms.join('%2C')}&range=1d&interval=1d`;
  const r = await pfetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`spark HTTP ${r.status}`);
  return r.json();
}

async function sparkTick() {
  if (adminPaused) return false;
  try {
    if (needsFx()) await refreshUsdInr().catch(() => {});
    const syms = [...quotes.values()].map((q) => q.ysym);
    const now = new Date().toISOString();
    let ok = 0;
    for (let i = 0; i < syms.length; i += 15) { // Yahoo spark caps ~20 symbols/request
      const batch = syms.slice(i, i + 15);
      let j;
      try { j = await sparkBatch(batch); } catch { continue; }
      for (const ys of batch) {
        const d = j?.[ys];
        if (!d) continue;
        const closes = (d.close || []).filter((x) => x != null);
        const rawLtp = closes.length ? closes[closes.length - 1] : d.previousClose;
        const rawPc = d.chartPreviousClose ?? d.previousClose;
        if (rawLtp == null || rawPc == null) continue;
        const q = byYsym.get(ys);
        if (!q) continue;
        const ltp = toInr(q, rawLtp), pc = toInr(q, rawPc);
        if (ltp == null || pc == null) continue; // no FX yet — never publish ₹0
        ok += 1;
        q.ltp = ltp;
        q.prev_close = pc;
        q.change_pct = round2(((ltp - pc) / pc) * 100);
        q.bid = round2(ltp * 0.9997);
        q.ask = round2(ltp * 1.0003);
        q.as_of = now;
      }
      await new Promise((res) => setTimeout(res, 120)); // gentle stagger
    }
    if (ok === 0) throw new Error('no spark data');
    health.lastTickAt = now;
    yahooFailures = 0;
    setHealth('LIVE', `Live NSE quotes — ${ok} stocks`);
    emit('ALL', 'prices', snapshot());
    return true;
  } catch (e) {
    yahooFailures += 1;
    if (yahooFailures >= 3) setHealth('DELAYED', `Yahoo spark failing: ${e.message}`);
    return false;
  }
}

// On-demand: fetch real OHLC + multi-day candle history for one instrument when
// the user opens it. Cached ~20s so re-opens are instant. No-op in sim mode.
const detailAt = new Map(); // symbol -> ms of last fetch
async function ensureDetail(instrumentId, force = false) {
  if (activeMode !== 'yahoo') return;
  let q = null;
  for (const x of quotes.values()) if (x.instrument_id === instrumentId) { q = x; break; }
  if (!q) return;
  const now = Date.now();
  if (!force && candles.get(q.symbol)?.length && now - (detailAt.get(q.symbol) || 0) < 20000) return;
  detailAt.set(q.symbol, now); // set early to avoid a fetch stampede
  try {
    if (q.conv && !usdInr) await refreshUsdInr().catch(() => {});
    const r = await pfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${q.ysym}?range=5d&interval=1m`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    const ltp = meta ? toInr(q, meta.regularMarketPrice) : null;
    if (ltp != null) {
      q.ltp = ltp;
      q.prev_close = toInr(q, meta.chartPreviousClose || meta.previousClose) ?? q.prev_close;
      q.open = toInr(q, meta.regularMarketOpen) ?? q.open;
      q.high = toInr(q, meta.regularMarketDayHigh) ?? q.high;
      q.low = toInr(q, meta.regularMarketDayLow) ?? q.low;
      q.volume = Math.round(meta.regularMarketVolume || q.volume);
      q.bid = round2(q.ltp * 0.9997);
      q.ask = round2(q.ltp * 1.0003);
      q.change_pct = round2(((q.ltp - q.prev_close) / q.prev_close) * 100);
      if (meta.marketState && !q.conv) marketState = meta.marketState;
    }
    const real = convCandles(q, parseYahooCandles(result));
    if (real.length) candles.set(q.symbol, real);
    emit('ALL', 'prices', snapshot()); // push the freshly-detailed quote
  } catch {
    detailAt.set(q.symbol, now - 15000); // let it retry sooner on failure
  }
}

// Staleness watchdog (BPD Section 8: flag stale prices, never show them silently)
async function watchdog() {
  if (adminPaused) return; // already DOWN
  const staleMs = (await setting('feed_stale_sec')) * 1000;
  if (health.lastTickAt && Date.now() - new Date(health.lastTickAt).getTime() > staleMs * 3) {
    setHealth('DOWN', 'No ticks received beyond threshold');
  } else if (health.lastTickAt && Date.now() - new Date(health.lastTickAt).getTime() > staleMs) {
    setHealth('DELAYED', 'Ticks stale beyond threshold');
  }
}

// --- Market indices -----------------------------------------------------------
function initIndices() {
  for (const d of INDEX_DEFS) {
    const pc = round2(d.base * (1 + (Math.random() - 0.5) * 0.004));
    indices.set(d.symbol, { symbol: d.symbol, ltp: d.base, prev_close: pc, change: round2(d.base - pc), change_pct: round2(((d.base - pc) / pc) * 100) });
  }
}
function simIndices() {
  for (const d of INDEX_DEFS) {
    const ix = indices.get(d.symbol);
    ix.ltp = round2(Math.min(ix.prev_close * 1.04, Math.max(ix.prev_close * 0.96, ix.ltp * (1 + gaussian() * 0.0006))));
    ix.change = round2(ix.ltp - ix.prev_close);
    ix.change_pct = round2((ix.change / ix.prev_close) * 100);
  }
}
async function fetchIndices() {
  await Promise.all(INDEX_DEFS.map(async (d) => {
    try {
      const r = await pfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(d.y)}?range=1d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) return;
      const pc = round2(m.chartPreviousClose || m.previousClose || d.base);
      indices.set(d.symbol, { symbol: d.symbol, ltp: round2(m.regularMarketPrice), prev_close: pc, change: round2(m.regularMarketPrice - pc), change_pct: round2(((m.regularMarketPrice - pc) / pc) * 100) });
    } catch { /* keep previous / seeded value */ }
  }));
}
function getIndices() { return [...indices.values()]; }

let activeMode = config.feedMode;
function startSim() {
  activeMode = 'sim';
  health.mode = 'sim';
  timer = setInterval(simTick, 1500);
  simTick();
  timer.unref?.();
}

async function start() {
  await initQuotes();
  await loadOptionCache();
  initIndices();
  run('INSERT INTO feed_health_log (status, detail) VALUES (?, ?)', 'LIVE', `Feed started in ${config.feedMode} mode`).catch(() => {});
  if (config.feedMode === 'yahoo') {
    // Real NSE data via Yahoo. If the first fetch fails (offline / rate-limited),
    // fall back to the simulator so the platform still runs.
    const ok = await sparkTick();
    if (ok) {
      timer = setInterval(sparkTick, 8000); // batched — scales to the whole universe; <10s keeps status LIVE
      timer.unref?.();
      fetchIndices();
      setInterval(fetchIndices, 15000).unref();
      const first = quotes.values().next().value;
      if (first) ensureDetail(first.instrument_id); // warm the default chart with real candles
      console.log(`[feed] Yahoo live feed active — ${quotes.size} NSE stocks (batched quotes + on-demand candles).`);
    } else {
      console.warn('[feed] Yahoo feed unreachable at startup — falling back to the simulator.');
      run('INSERT INTO feed_health_log (status, detail) VALUES (?, ?)', 'DELAYED', 'Yahoo unreachable — using simulator fallback').catch(() => {});
      startSim();
    }
  } else {
    startSim();
  }
  setInterval(watchdog, 3000).unref();
}

function activeFeedMode() { return activeMode; }

function snapshot() {
  return { quotes: [...quotes.values()], indices: getIndices(), health: publicHealth(), as_of: health.lastTickAt || new Date().toISOString() };
}

// Spot price of an underlying by symbol (a live stock quote or an index).
function spotOf(symbol) {
  const q = quotes.get(symbol);
  if (q) return q.ltp;
  const ix = indices.get(symbol);
  return ix ? ix.ltp : null;
}

// Live quote for a traded OPTION contract (an instruments row with kind='option').
// Priced from the live underlying spot via the shared model, so orders and
// portfolio P&L track the market just like equities. getQuote() stays SYNC, so
// option metadata is kept in memory (loaded at startup + registered on creation)
// — no DB read on the hot path.
const _optInst = new Map(); // instrument_id -> contract row (immutable metadata)
async function loadOptionCache() {
  for (const inst of await all("SELECT * FROM instruments WHERE kind = 'option'")) _optInst.set(inst.id, inst);
}
function registerOption(inst) { if (inst && inst.id != null) _optInst.set(inst.id, inst); }
function optionQuote(instrumentId) {
  const inst = _optInst.get(instrumentId);
  if (!inst) return null; // unknown/non-option instrument
  const spot = spotOf(inst.underlying);
  if (spot == null) return null;
  const ltp = opt.premium(spot, inst.strike, inst.opt_type === 'CE', inst.expiry);
  const ref = inst.base_price || ltp; // premium when the contract was first opened
  return {
    instrument_id: inst.id, symbol: inst.symbol, name: inst.name, exchange: inst.exchange || 'NFO',
    ltp, bid: round2(ltp * 0.995), ask: round2(ltp * 1.005),
    open: ref, high: Math.max(ref, ltp), low: Math.min(ref, ltp), prev_close: ref,
    change_pct: ref ? round2(((ltp - ref) / ref) * 100) : 0,
    volume: 0, spark: [ltp], as_of: new Date().toISOString(), kind: 'option',
    underlying: inst.underlying, opt_type: inst.opt_type, strike: inst.strike, expiry: inst.expiry, lot_size: inst.lot_size,
  };
}

function getQuote(instrumentId) {
  for (const q of quotes.values()) if (q.instrument_id === instrumentId) return q;
  return optionQuote(instrumentId); // not in the live feed — maybe an option contract
}

// Feed is usable for price-band validation only when LIVE (BPD Stage 10).
function feedIsLive() { return health.status === 'LIVE'; }

function setAdminPaused(paused, adminName) {
  adminPaused = paused;
  if (paused) setHealth('DOWN', `Feed manually disconnected by ${adminName || 'administrator'} (simulation)`);
  else { health.lastTickAt = new Date().toISOString(); setHealth('LIVE', 'Feed reconnected by administrator'); emit('ALL', 'prices', snapshot()); }
}

module.exports = { start, snapshot, getQuote, getCandles, getIndices, ensureDetail, feedIsLive, publicHealth, setAdminPaused, registerOption };
