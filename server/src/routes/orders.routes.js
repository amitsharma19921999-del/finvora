// Stages 10 & 12 — Buy / Sell Order placement.
//  - Market OPEN (Mon–Fri 9:15–15:30 IST): orders execute instantly at the live
//    price. Only insufficient balance/holdings auto-reject.
//  - Market CLOSED (after hours / weekends / holidays): the order is accepted as
//    an After-Market Order (AMO) — Pending — and auto-executes at the next open.
// The fund/holdings check + settlement run inside ONE transaction that locks the
// wallet/holdings row (SELECT ... FOR UPDATE) so concurrent orders can't overspend.
const express = require('express');
const { run, get, all, tx } = require('../db');
const { requireAuth } = require('../auth');
const { validators, settleFill, activity, notifyAdmin, notifyUser, round2, reservedForOrders } = require('../util');
const market = require('../marketdata');
const { isMarketOpen, nextOpenLabel, segmentOf, sessionLabel } = require('../markethours');
const risk = require('../risk');

const router = express.Router();

router.post('/orders', requireAuth, async (req, res) => {
  if (req.user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account must be Active to place orders. Complete KYC and bank verification.' });
  }
  const { instrument_id, side, qty } = req.body || {};
  const inst = await get('SELECT * FROM instruments WHERE id = ?', Number(instrument_id));
  if (!inst) return res.status(400).json({ error: 'Invalid trading instrument.' });
  if (!['BUY', 'SELL'].includes(side)) return res.status(400).json({ error: 'Order side must be BUY or SELL.' });
  if (!validators.qty(qty)) return res.status(400).json({ error: 'Quantity must be a positive whole number.' });
  const nQty = Number(qty);

  // Commodities and options trade in fixed exchange lots — reject anything that
  // isn't a whole multiple, so an order can't be placed for a size MCX/NFO would
  // never accept.
  const lot = Number(inst.lot_size) || 1;
  if (lot > 1 && nQty % lot !== 0) {
    return res.status(400).json({
      error: `${inst.symbol} trades in lots of ${lot}. Enter a multiple of ${lot} (e.g. ${lot}, ${lot * 2}).`,
    });
  }

  // Price is FIXED to the current market price (LTP) — the customer only chooses quantity.
  const quote = market.getQuote(inst.id);
  const feedLive = market.feedIsLive() && quote;
  const nPrice = quote ? round2(quote.ltp) : 0;
  if (!(nPrice > 0)) return res.status(400).json({ error: 'Live market price is unavailable for this instrument right now. Please try again shortly.' });

  // Commodities (MCX) trade until 23:30 IST, equities until 15:30 — check the
  // session for THIS instrument's segment, not the equity session.
  const profile = await risk.profileFor(req.user.id);
  const lev = Number(profile.leverage) || 1;

  const segment = segmentOf(inst);
  const marketOpen = isMarketOpen(new Date(), segment);
  const feedStatus = marketOpen ? (feedLive ? 'LIVE' : 'DELAYED') : 'AMO';

  let outcome;
  try {
    outcome = await tx(async () => {
      // --- fund / holdings check under a row lock ---
      let reject = null;
      if (side === 'BUY') {
        await run('INSERT INTO wallets (user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING', req.user.id);
        const w = await get('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', req.user.id);
        // open BUY orders block only the margin they will consume, not the notional
        const rOpen = await reservedForOrders(req.user.id);
        const rw = Number((await get("SELECT IFNULL(SUM(amount), 0) s FROM withdrawals WHERE user_id = ? AND status IN ('Withdrawal Pending','Processing')", req.user.id)).s);
        const available = round2((w ? w.balance : 0) - rOpen - rw);
        // Buying power = cash x the client's leverage (1 unless an admin raised it).
        const power = risk.buyingPower(available, profile);
        if (round2(nQty * nPrice) > power) {
          reject = lev > 1
            ? `Insufficient Margin (required ₹${round2(nQty * nPrice)}, buying power ₹${power} = ₹${available} × ${lev}x)`
            : `Insufficient Balance (required ₹${round2(nQty * nPrice)}, available ₹${available})`;
        }
      } else {
        const h = await get('SELECT qty FROM holdings WHERE user_id = ? AND instrument_id = ? FOR UPDATE', req.user.id, inst.id);
        const held = h ? h.qty : 0;
        const lockedSells = Number((await get("SELECT IFNULL(SUM(qty), 0) s FROM orders WHERE user_id = ? AND instrument_id = ? AND side = 'SELL' AND status IN ('Pending','Executing')", req.user.id, inst.id)).s);
        const sellable = held - lockedSells;
        if (nQty > sellable) reject = `Insufficient Holdings (you can sell up to ${sellable} of ${inst.symbol})`;
      }

      if (reject) {
        const r = await run(
          `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status, reject_reason)
           VALUES (?,?,?,?,?,?,?, 'Rejected', ?)`,
          req.user.id, inst.id, side, nQty, nPrice, quote ? quote.ltp : null, feedStatus, reject
        );
        return { rejected: true, reject, orderId: r.lastInsertRowid };
      }

      if (!marketOpen) {
        // After-Market Order — record as Pending; the AMO runner fills it at open.
        const r = await run(
          `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status)
           VALUES (?,?,?,?,?,?,?, 'Pending')`,
          req.user.id, inst.id, side, nQty, nPrice, quote ? quote.ltp : nPrice, 'AMO'
        );
        return { amo: true, orderId: r.lastInsertRowid };
      }

      // Instant execution (market open) — Executed at the live price; order price == exec price.
      const r = await run(
        `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status)
         VALUES (?,?,?,?,?,?,?, 'Executed')`,
        req.user.id, inst.id, side, nQty, nPrice, quote ? quote.ltp : nPrice, feedStatus
      );
      const orderId = r.lastInsertRowid;
      const orderRow = await get('SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ?', orderId);
      const { pnl } = await settleFill(orderRow, nPrice, nQty, null, lev);
      return { rejected: false, orderId, pnl };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const order = await get('SELECT * FROM orders WHERE id = ?', outcome.orderId);

  if (outcome.rejected) {
    activity(req.user.id, 'ORDER_PLACED', `${side} ${nQty} ${inst.symbol} @ ₹${nPrice} — auto-rejected (${outcome.reject})`);
    notifyUser(req.user.id, 'ORDER_REJECTED', `${side === 'BUY' ? 'Buy' : 'Sell'} Order Rejected`,
      `Your ${side} order for ${nQty} × ${inst.symbol} was rejected: ${outcome.reject}.`, 'orders', outcome.orderId);
    return res.status(200).json({ order, auto_rejected: true, message: `Order rejected: ${outcome.reject}` });
  }

  if (outcome.amo) {
    const when = nextOpenLabel(new Date(), segment);
    // Name the session that was applied — a commodity queued outside 9:00–11:55 PM
    // is correct, a commodity queued at 4 PM means it was misfiled as equity.
    const sess = sessionLabel(segment);
    activity(req.user.id, 'ORDER_PLACED', `${side} ${nQty} ${inst.symbol} — after-market order (${sess}), queued for ${when}`);
    notifyUser(req.user.id, 'ORDER_QUEUED', 'After-Market Order Queued',
      `${sess} is closed right now. Your ${side} order for ${nQty} × ${inst.symbol} is placed as an After-Market Order and will execute at the next open (${when}).`, 'orders', outcome.orderId);
    notifyAdmin(side === 'BUY' ? 'BUY_ORDER' : 'SELL_ORDER', 'After-Market Order',
      `${req.user.mobile}: ${side} ${nQty} × ${inst.symbol} queued (${sess} closed) — runs ${when}.`, 'orders', outcome.orderId);
    return res.json({
      order, amo: true, segment, session: sess,
      message: `${sess} is closed — order placed as an After-Market Order. It will execute at the next open (${when}).`,
    });
  }

  activity(req.user.id, 'ORDER_EXECUTED', `${side} ${nQty} ${inst.symbol} @ ₹${nPrice}${side === 'SELL' ? ` (P&L ₹${outcome.pnl})` : ''}`);
  notifyUser(req.user.id, 'ORDER_EXECUTED', 'Order Executed ✅',
    `Your ${side} order: ${nQty} × ${inst.symbol} executed @ ₹${nPrice}. Portfolio and wallet updated.`, 'orders', outcome.orderId);
  notifyAdmin(side === 'BUY' ? 'BUY_ORDER' : 'SELL_ORDER', `Order Executed — ${side}`,
    `${req.user.mobile}: ${side} ${nQty} × ${inst.symbol} @ ₹${nPrice}.`, 'orders', outcome.orderId);
  res.json({ order, message: `${side === 'BUY' ? 'Buy' : 'Sell'} order executed at ₹${nPrice}. Your portfolio is updated.` });
});

router.get('/orders/mine', requireAuth, async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await all(`SELECT o.*, i.symbol, i.name FROM orders o JOIN instruments i ON i.id = o.instrument_id
           WHERE o.user_id = ? AND o.status = ? ORDER BY o.id DESC LIMIT 200`, req.user.id, status)
    : await all(`SELECT o.*, i.symbol, i.name FROM orders o JOIN instruments i ON i.id = o.instrument_id
           WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 200`, req.user.id);
  res.json({ orders: rows });
});

// Investor cancellation — Pending orders only (covers queued After-Market Orders).
router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  const order = await get('SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ? AND o.user_id = ?', req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'Pending') {
    return res.status(409).json({ error: `Only Pending orders can be cancelled. This order is ${order.status}.` });
  }
  await run("UPDATE orders SET status = 'Cancelled' WHERE id = ?", order.id);
  activity(req.user.id, 'ORDER_CANCELLED', `Cancelled ${order.side} ${order.qty} ${order.symbol} (#${order.id})`);
  notifyAdmin('ORDER_CANCELLED', 'Order Cancelled by Investor',
    `${req.user.mobile} cancelled ${order.side} ${order.qty} × ${order.symbol} (#${order.id}).`, 'orders', order.id);
  res.json({ message: 'Order cancelled. No funds or holdings were affected.', status: 'Cancelled' });
});

module.exports = { router };
