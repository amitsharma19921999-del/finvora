// Per-client risk controls (set by an admin in risk_profiles):
//
//   leverage        buying power = available balance x leverage (checked at order time)
//   max_loss        once the day's loss passes this, every open position is closed
//   square_off_time 'HH:MM' IST — close open positions at that time
//
// The engine polls every 15s. Squaring off means placing real SELL fills at the
// live price through the same settlement path as any other trade, so the wallet,
// holdings and ledger stay consistent.
const { all, get, run, tx } = require('./db');
const { settleFill, round2, notifyUser, notifyAdmin, activity } = require('./util');
const market = require('./marketdata');
const { isMarketOpen, segmentOf } = require('./markethours');

const DEFAULT = { leverage: 1, max_loss: null, square_off_time: null };

async function profileFor(userId) {
  const p = await get('SELECT * FROM risk_profiles WHERE user_id = ?', userId);
  return p || { user_id: userId, ...DEFAULT };
}

// Buying power for a BUY: cash available, multiplied by the client's leverage.
const buyingPower = (available, profile) => round2(available * (Number(profile?.leverage) || 1));

// Day P&L = realised on today's sells + unrealised on what is still held.
async function dayPnl(userId) {
  const realised = Number((await get(
    "SELECT IFNULL(SUM(realized_pnl), 0) s FROM orders WHERE user_id = ? AND side = 'SELL' AND status = 'Executed' AND (exec_time)::date = (now())::date",
    userId)).s);
  const holdings = await all(
    'SELECT h.*, i.symbol FROM holdings h JOIN instruments i ON i.id = h.instrument_id WHERE h.user_id = ? AND h.qty > 0',
    userId);
  let unrealised = 0;
  for (const h of holdings) {
    const q = market.getQuote(h.instrument_id);
    if (q && q.ltp > 0) unrealised += (q.ltp - h.avg_price) * h.qty;
  }
  return { realised: round2(realised), unrealised: round2(unrealised), total: round2(realised + unrealised), holdings };
}

// IST wall clock as minutes past midnight.
function istMinutes(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 1440 ? mins : null;
}

// Close every open position at the live price. Returns what was closed.
async function squareOff(userId, why) {
  const holdings = await all(
    'SELECT instrument_id, qty FROM holdings WHERE user_id = ? AND qty > 0', userId);
  const closed = [];
  for (const h of holdings) {
    const inst = await get('SELECT * FROM instruments WHERE id = ?', h.instrument_id);
    if (!inst) continue;
    // Only close what its own market can price and trade right now.
    if (!isMarketOpen(new Date(), segmentOf(inst))) continue;
    const q = market.getQuote(inst.id);
    const px = q && q.ltp > 0 ? round2(q.ltp) : 0;
    if (!px) continue;
    try {
      const pnl = await tx(async () => {
        const cur = await get('SELECT * FROM holdings WHERE user_id = ? AND instrument_id = ? FOR UPDATE', userId, inst.id);
        if (!cur || cur.qty <= 0) return null;
        const r = await run(
          `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status)
           VALUES (?, ?, 'SELL', ?, ?, ?, ?, 'Executed')`,
          userId, inst.id, cur.qty, px, px, 'AUTO',
        );
        const row = await get('SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ?', r.lastInsertRowid);
        const res = await settleFill(row, px, cur.qty, null);
        return { qty: cur.qty, pnl: res.pnl, orderId: r.lastInsertRowid };
      });
      if (pnl) closed.push({ symbol: inst.symbol, ...pnl, price: px });
    } catch (e) {
      console.error('[risk] square-off failed for', inst.symbol, e.message);
    }
  }
  if (closed.length) {
    const summary = closed.map((c) => `${c.qty} × ${c.symbol} @ ₹${c.price}`).join(', ');
    activity(userId, 'AUTO_SQUARE_OFF', `${why} — closed ${summary}`);
    notifyUser(userId, 'AUTO_SQUARE_OFF', 'Positions Closed Automatically',
      `${why}. We closed: ${summary}.`);
    notifyAdmin('AUTO_SQUARE_OFF', 'Auto square-off', `User #${userId}: ${why} — ${summary}`);
  }
  return closed;
}

let busy = false;
const firedToday = new Map(); // userId -> 'YYYY-MM-DD' of the last timed square-off

async function runOnce() {
  if (busy) return;
  if (!market.feedIsLive()) return;
  busy = true;
  try {
    const profiles = await all(
      'SELECT * FROM risk_profiles WHERE max_loss IS NOT NULL OR square_off_time IS NOT NULL');
    const nowMin = istMinutes();
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    for (const p of profiles) {
      // 1. timed square-off
      const cut = parseHHMM(p.square_off_time);
      if (cut != null && nowMin >= cut && firedToday.get(p.user_id) !== today) {
        const closed = await squareOff(p.user_id, `Scheduled square-off at ${p.square_off_time}`);
        firedToday.set(p.user_id, today);
        if (closed.length) continue; // nothing left to breach
      }
      // 2. max-loss square-off
      if (p.max_loss != null && Number(p.max_loss) > 0) {
        const { total, holdings } = await dayPnl(p.user_id);
        if (holdings.length && total <= -Math.abs(Number(p.max_loss))) {
          await squareOff(p.user_id, `Day loss ₹${Math.abs(total)} passed your ₹${Math.abs(Number(p.max_loss))} limit`);
        }
      }
    }
  } catch (e) {
    console.error('[risk] engine error:', e.message);
  } finally {
    busy = false;
  }
}

function startRiskEngine() {
  setInterval(() => { runOnce().catch(() => {}); }, 15000).unref?.();
  setTimeout(() => { runOnce().catch(() => {}); }, 12000);
}

module.exports = { startRiskEngine, runOnce, squareOff, dayPnl, profileFor, buyingPower, parseHHMM };
