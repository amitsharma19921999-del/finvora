// Markets / Discover data — Groww/Zerodha-style: live indices, top movers,
// IPO calendar, and an options (F&O) chain derived from the live underlying.
// Stocks & indices are REAL live data; IPO and option-premium figures are
// representative (no free live source) and flagged as such in the response.
const express = require('express');
const { all, get, run } = require('../db');
const { requireAuth } = require('../auth');
const market = require('../marketdata');
const opt = require('../options');

const router = express.Router();
const round2 = (n) => Math.round(n * 100) / 100;

// Live index strip.
router.get('/markets/indices', requireAuth, (req, res) => {
  res.json({ indices: market.getIndices(), as_of: market.publicHealth().last_tick_at });
});

// Market Pulse — a confidence read computed from real market breadth (how many
// of the ~136 live stocks are up), with an advisory blurb. Advisory only.
router.get('/markets/pulse', requireAuth, (req, res) => {
  const qs = market.snapshot().quotes;
  const up = qs.filter((q) => q.change_pct >= 0).length;
  const breadth = qs.length ? up / qs.length : 0.5;
  const confidence = Math.max(18, Math.min(92, Math.round(38 + breadth * 58)));
  const idx = market.getIndices()[0];
  const idxDir = idx ? (idx.change_pct >= 0 ? 'firm' : 'under pressure') : 'mixed';
  const laggards = [...qs].sort((a, b) => a.change_pct - b.change_pct).slice(0, 2).map((q) => q.symbol);
  const leaders = [...qs].sort((a, b) => b.change_pct - a.change_pct).slice(0, 2).map((q) => q.symbol);
  let advisory;
  if (breadth >= 0.6) advisory = `Breadth is strong — ${up}/${qs.length} names higher and large-caps ${idxDir}. ${leaders.join(' & ')} lead; keep ~15% in reserve for dips.`;
  else if (breadth >= 0.45) advisory = `A mixed tape — ${up}/${qs.length} names up, large-caps ${idxDir}. ${laggards.join(' & ')} lag; consider trimming strength and staying selective.`;
  else advisory = `Risk-off — only ${up}/${qs.length} names higher and large-caps ${idxDir}. ${laggards.join(' & ')} weak; favour reserves and avoid chasing.`;
  res.json({ confidence, breadth: Math.round(breadth * 100), advisory, up, total: qs.length, note: 'Advisory only — orders route to the manual desk for review.' });
});

// Top gainers / losers / most-active — computed from the live quote snapshot.
router.get('/markets/movers', requireAuth, (req, res) => {
  const qs = market.snapshot().quotes.map((q) => ({
    instrument_id: q.instrument_id, symbol: q.symbol, name: q.name, ltp: q.ltp,
    change_pct: q.change_pct, change: round2(q.ltp - q.prev_close), volume: q.volume,
  }));
  const byChg = [...qs].sort((a, b) => b.change_pct - a.change_pct);
  res.json({
    gainers: byChg.slice(0, 6),
    losers: byChg.slice(-6).reverse(),
    active: [...qs].sort((a, b) => b.volume - a.volume).slice(0, 6),
    as_of: market.publicHealth().last_tick_at,
  });
});

// --- IPO calendar (representative) -------------------------------------------
// Deterministic list so the UI is stable; dates are relative to "today".
function iso(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
const IPOS = [
  { name: 'Aurelia Technologies', symbol: 'AURELIA', status: 'Open', price_band: [415, 438], lot: 34, issue_size: '₹1,240 Cr', open: iso(-1), close: iso(2), listing: iso(6), subscribed: 3.8, gmp: 62, category: 'Mainboard' },
  { name: 'Nimbus Logistics', symbol: 'NIMBUS', status: 'Open', price_band: [128, 135], lot: 108, issue_size: '₹560 Cr', open: iso(0), close: iso(3), listing: iso(7), subscribed: 1.4, gmp: 11, category: 'Mainboard' },
  { name: 'Vertex Green Energy', symbol: 'VERTEXGRN', status: 'Upcoming', price_band: [72, 76], lot: 195, issue_size: '₹310 Cr', open: iso(4), close: iso(7), listing: iso(11), subscribed: 0, gmp: 8, category: 'SME' },
  { name: 'Sapphire Foods Retail', symbol: 'SAPPHRET', status: 'Upcoming', price_band: [560, 590], lot: 25, issue_size: '₹2,100 Cr', open: iso(6), close: iso(9), listing: iso(13), subscribed: 0, gmp: 95, category: 'Mainboard' },
  { name: 'Orbit Fintech', symbol: 'ORBITFIN', status: 'Listed', price_band: [310, 330], lot: 45, issue_size: '₹880 Cr', open: iso(-9), close: iso(-6), listing: iso(-2), subscribed: 12.6, gmp: 0, listed_at: 402, category: 'Mainboard' },
  { name: 'Meridian Pharma', symbol: 'MERIDPHA', status: 'Listed', price_band: [188, 198], lot: 75, issue_size: '₹640 Cr', open: iso(-12), close: iso(-9), listing: iso(-5), subscribed: 6.1, gmp: 0, listed_at: 176, category: 'Mainboard' },
];

router.get('/markets/ipos', requireAuth, (req, res) => {
  const withDerived = IPOS.map((i) => ({
    ...i,
    gain_pct: i.status === 'Listed' && i.listed_at ? round2(((i.listed_at - i.price_band[1]) / i.price_band[1]) * 100) : null,
    min_investment: i.price_band[1] * i.lot,
  }));
  res.json({ ipos: withDerived, note: 'IPO calendar is representative sample data (no free live IPO feed).' });
});

// --- Options (F&O) chain, derived from the live underlying -------------------
// Premiums come from the shared model so the chain and a traded contract price
// identically. Accepts ?expiry= so the chain re-prices for the chosen expiry.
function underlyingSpotKind(symbol) {
  const idx = market.getIndices().find((i) => i.symbol === symbol);
  if (idx) return { spot: idx.ltp, kind: 'index' };
  const stock = market.snapshot().quotes.find((q) => q.symbol === symbol);
  if (stock) return { spot: stock.ltp, kind: 'stock' };
  return null;
}

router.get('/markets/options', requireAuth, async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY 50');
  const us = underlyingSpotKind(symbol);
  if (!us) return res.status(404).json({ error: 'Unknown underlying.' });
  const spot = us.spot;
  const step = opt.strikeStep(spot);
  const atm = opt.atmStrike(spot, step);
  // Real exchange expiries when SmartAPI is live; computed ones otherwise.
  const realExp = market.realExpiries(symbol);
  const expiries = realExp.length ? realExp.slice(0, 6) : opt.upcomingExpiries();
  const expiry = expiries.includes(req.query.expiry) ? req.query.expiry : expiries[0];
  const lot_size = opt.lotSizeFor(symbol, us.kind, spot);

  // Pull the genuine chain (premium + OI + IV). No-op unless the feed is Angel One.
  const live = await market.refreshOptionChain(symbol, expiry).catch(() => false);

  const rows = [];
  let realCount = 0;
  for (let n = -6; n <= 6; n++) {
    const strike = atm + n * step;
    const ce = market.liveOption(symbol, expiry, strike, 'CE');
    const pe = market.liveOption(symbol, expiry, strike, 'PE');
    if (ce || pe) realCount += 1;
    const side = (v, isCall) => (v
      ? { ltp: v.ltp, oi: v.oi, iv: v.iv, change_pct: v.prevClose ? round2(((v.ltp - v.prevClose) / v.prevClose) * 100) : 0, real: true }
      : { ltp: opt.premium(spot, strike, isCall, expiry), oi: opt.openInterest(spot, strike), change_pct: 0, real: false });
    rows.push({ strike, call: side(ce, true), put: side(pe, false), atm: strike === atm });
  }
  res.json({
    symbol, spot, atm, step, lot_size, expiry, expiries, rows,
    real: live && realCount > 0,
    note: live && realCount > 0
      ? 'Live NSE option chain (real premiums, open interest and IV).'
      : 'Option premiums are model-derived from the live spot (representative, not a live options feed).',
  });
});

// Ensure a tradable instruments row exists for one option contract, then return
// its live quote. The client calls this when the customer taps a strike, then
// places the trade via the normal /orders endpoint with the returned id — so the
// entire order/execution/holding/portfolio pipeline works unchanged for options.
async function ensureOptionInstrument({ underlying, expiry, strike, opt_type }) {
  const us = underlyingSpotKind(underlying);
  if (!us) return null;
  const sym = opt.contractSymbol(underlying, expiry, strike, opt_type);
  let inst = await get('SELECT * FROM instruments WHERE symbol = ?', sym);
  if (!inst) {
    const prem = opt.premium(us.spot, strike, opt_type === 'CE', expiry);
    const lot = opt.lotSizeFor(underlying, us.kind, us.spot);
    const name = `${underlying} ${strike} ${opt_type} · ${opt.expiryLabel(expiry)}`;
    await run(`INSERT INTO instruments (symbol, name, exchange, base_price, kind, underlying, opt_type, strike, expiry, lot_size)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      sym, name, 'NFO', prem, 'option', underlying, opt_type, Number(strike), expiry, lot);
    inst = await get('SELECT * FROM instruments WHERE symbol = ?', sym);
  }
  market.registerOption(inst); // so getQuote() can price it synchronously
  return inst;
}

router.post('/markets/options/select', requireAuth, async (req, res) => {
  const { underlying, expiry, strike, opt_type } = req.body || {};
  if (!underlying || !expiry || !(Number(strike) > 0) || !['CE', 'PE'].includes(opt_type)) {
    return res.status(400).json({ error: 'Invalid option selection.' });
  }
  const inst = await ensureOptionInstrument({ underlying, expiry, strike: Number(strike), opt_type });
  if (!inst) return res.status(404).json({ error: 'Unknown underlying for options.' });
  const q = market.getQuote(inst.id);
  res.json({
    instrument_id: inst.id, symbol: inst.symbol, name: inst.name, lot_size: inst.lot_size,
    underlying: inst.underlying, opt_type: inst.opt_type, strike: inst.strike, expiry: inst.expiry,
    ltp: q ? q.ltp : inst.base_price,
  });
});

// Underlyings available for the F&O chain (indices + all stocks).
router.get('/markets/underlyings', requireAuth, (req, res) => {
  const indices = market.getIndices().map((i) => ({ symbol: i.symbol, name: i.symbol, kind: 'index', ltp: i.ltp, change_pct: i.change_pct }));
  const stocks = market.snapshot().quotes.map((q) => ({ symbol: q.symbol, name: q.name, kind: 'stock', ltp: q.ltp, change_pct: q.change_pct }));
  res.json({ underlyings: [...indices, ...stocks] });
});

module.exports = { router };
