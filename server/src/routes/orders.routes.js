// Stages 10 & 12 — Buy / Sell Order placement. Orders execute instantly at the
// live price; only insufficient balance/holdings auto-reject. The fund/holdings
// check + settlement run inside ONE transaction that locks the wallet/holdings
// row (SELECT ... FOR UPDATE), so concurrent orders can't double-spend.
const express = require('express');
const { run, get, all, tx } = require('../db');
const { requireAuth } = require('../auth');
const { validators, settleFill, activity, notifyAdmin, notifyUser, round2 } = require('../util');
const market = require('../marketdata');

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

  // Price is FIXED to the current market price (LTP) — the customer only chooses
  // quantity; the server is authoritative.
  const quote = market.getQuote(inst.id);
  const feedLive = market.feedIsLive() && quote;
  const nPrice = quote ? round2(quote.ltp) : 0;
  if (!(nPrice > 0)) return res.status(400).json({ error: 'Live market price is unavailable for this instrument right now. Please try again shortly.' });

  const feedStatus = feedLive ? 'LIVE' : 'DELAYED';
  let outcome;
  try {
    outcome = await tx(async () => {
      // --- fund / holdings check under a row lock (prevents concurrent double-spend) ---
      let reject = null;
      if (side === 'BUY') {
        await run('INSERT INTO wallets (user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING', req.user.id);
        const w = await get('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', req.user.id);
        const rw = Number((await get("SELECT IFNULL(SUM(amount), 0) s FROM withdrawals WHERE user_id = ? AND status IN ('Withdrawal Pending','Processing')", req.user.id)).s);
        const available = round2((w ? w.balance : 0) - rw);
        if (round2(nQty * nPrice) > available) reject = `Insufficient Balance (required ₹${round2(nQty * nPrice)}, available ₹${available})`;
      } else {
        const h = await get('SELECT qty FROM holdings WHERE user_id = ? AND instrument_id = ? FOR UPDATE', req.user.id, inst.id);
        const held = h ? h.qty : 0;
        if (nQty > held) reject = `Insufficient Holdings (you can sell up to ${held} of ${inst.symbol})`;
      }

      if (reject) {
        const r = await run(
          `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status, reject_reason)
           VALUES (?,?,?,?,?,?,?, 'Rejected', ?)`,
          req.user.id, inst.id, side, nQty, nPrice, quote ? quote.ltp : null, feedStatus, reject
        );
        return { rejected: true, reject, orderId: r.lastInsertRowid };
      }

      // Instant execution — Executed at the live price, order price == exec price.
      const r = await run(
        `INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, feed_status_at_order, status)
         VALUES (?,?,?,?,?,?,?, 'Executed')`,
        req.user.id, inst.id, side, nQty, nPrice, quote ? quote.ltp : nPrice, feedStatus
      );
      const orderId = r.lastInsertRowid;
      const orderRow = await get('SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ?', orderId);
      const { pnl } = await settleFill(orderRow, nPrice, nQty, null);
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

  activity(req.user.id, 'ORDER_EXECUTED', `${side} ${nQty} ${inst.symbol} @ ₹${nPrice}${side === 'SELL' ? ` (P&L ₹${outcome.pnl})` : ''}`);
  notifyUser(req.user.id, 'ORDER_EXECUTED', 'Order Executed ✅',
    `Your ${side} order: ${nQty} × ${inst.symbol} executed @ ₹${nPrice}. Portfolio and wallet updated.`, 'orders', outcome.orderId);
  notifyAdmin(side === 'BUY' ? 'BUY_ORDER' : 'SELL_ORDER', `Order Executed — ${side}`,
    `${req.user.mobile}: ${side} ${nQty} × ${inst.symbol} @ ₹${nPrice}${feedLive ? '' : ' (feed not live at order time)'}.`,
    'orders', outcome.orderId);
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

// Investor cancellation — only Pending orders (kept for completeness; with instant
// execution there normally are none).
router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  const order = await get('SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ? AND o.user_id = ?', req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'Pending') {
    return res.status(409).json({ error: `Only Pending orders can be cancelled. This order is ${order.status}.` });
  }
  await run("UPDATE orders SET status = 'Cancelled' WHERE id = ?", order.id);
  activity(req.user.id, 'ORDER_CANCELLED', `Cancelled ${order.side} ${order.qty} ${order.symbol} (#${order.id})`);
  notifyAdmin('ORDER_CANCELLED', 'Order Cancelled by Investor',
    `${req.user.mobile} cancelled ${order.side} ${order.qty} × ${order.symbol} (#${order.id}) before execution.`, 'orders', order.id);
  res.json({ message: 'Order cancelled. No funds or holdings were affected.', status: 'Cancelled' });
});

module.exports = { router };
