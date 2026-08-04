// After-Market Order runner: executes orders that were queued while the market
// was closed, as soon as the market is open and the feed has a live price.
const { all, get, run, tx } = require('./db');
const { settleFill, round2, activity, notifyUser } = require('./util');
const market = require('./marketdata');
const { isMarketOpen, segmentOf } = require('./markethours');

let busy = false;

async function runOnce() {
  if (busy) return;
  // Equity and commodity sessions differ (15:30 vs 23:30 IST), so run whenever
  // EITHER is open and filter per order below.
  if (!market.feedIsLive()) return;
  if (!isMarketOpen(new Date(), 'equity') && !isMarketOpen(new Date(), 'commodity')) return;
  busy = true;
  try {
    const pend = await all("SELECT o.*, i.symbol, i.kind, i.exchange FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.status = 'Pending' ORDER BY o.id");
    for (const o of pend) {
      if (!isMarketOpen(new Date(), segmentOf(o))) continue; // that segment is still shut
      const quote = market.getQuote(o.instrument_id);
      const px = quote ? round2(quote.ltp) : 0;
      if (!(px > 0)) continue; // no price for this instrument yet — retry next cycle

      let result = null;
      try {
        result = await tx(async () => {
          if (o.side === 'BUY') {
            await run('INSERT INTO wallets (user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING', o.user_id);
            const w = await get('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', o.user_id);
            // available excluding THIS order's own reservation
            const rOpen = Number((await get("SELECT IFNULL(SUM(qty * price), 0) s FROM orders WHERE user_id = ? AND side = 'BUY' AND status IN ('Pending','Executing') AND id <> ?", o.user_id, o.id)).s);
            const rw = Number((await get("SELECT IFNULL(SUM(amount), 0) s FROM withdrawals WHERE user_id = ? AND status IN ('Withdrawal Pending','Processing')", o.user_id)).s);
            const available = round2((w ? w.balance : 0) - rOpen - rw);
            if (round2(o.qty * px) > available) {
              await run("UPDATE orders SET status = 'Rejected', reject_reason = ? WHERE id = ?", `Insufficient Balance at market open (needed ₹${round2(o.qty * px)}, available ₹${available})`, o.id);
              return 'rejected-balance';
            }
          } else {
            const h = await get('SELECT qty FROM holdings WHERE user_id = ? AND instrument_id = ? FOR UPDATE', o.user_id, o.instrument_id);
            if (!h || h.qty < o.qty) {
              await run("UPDATE orders SET status = 'Rejected', reject_reason = 'Insufficient Holdings at market open' WHERE id = ?", o.id);
              return 'rejected-holdings';
            }
          }
          await settleFill(o, px, o.qty, null); // sets Executed, price = px
          return 'executed';
        });
      } catch (e) { continue; } // leave Pending, retry next cycle

      if (result === 'executed') {
        activity(o.user_id, 'ORDER_EXECUTED', `AMO ${o.side} ${o.qty} ${o.symbol} @ ₹${px} (at market open)`);
        notifyUser(o.user_id, 'ORDER_EXECUTED', 'After-Market Order Executed ✅',
          `Your ${o.side} order: ${o.qty} × ${o.symbol} executed @ ₹${px} at market open. Portfolio updated.`, 'orders', o.id);
      } else if (result && result.startsWith('rejected')) {
        notifyUser(o.user_id, 'ORDER_REJECTED', `${o.side === 'BUY' ? 'Buy' : 'Sell'} Order Rejected`,
          `Your after-market ${o.side} of ${o.qty} × ${o.symbol} could not execute at market open (${result === 'rejected-balance' ? 'insufficient balance' : 'insufficient holdings'}).`, 'orders', o.id);
      }
    }
  } finally {
    busy = false;
  }
}

function startAmoRunner() {
  setInterval(() => { runOnce().catch(() => {}); }, 60000).unref?.();
  setTimeout(() => { runOnce().catch(() => {}); }, 8000); // catch any AMOs already due at boot
}

module.exports = { startAmoRunner, runOnce };
