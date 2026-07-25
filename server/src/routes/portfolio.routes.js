// Portfolio & Holdings, Transaction History, investor notifications and
// statements (BPD Stage 9 dashboard data + "View Reports" for investors).
const express = require('express');
const { get, all, run } = require('../db');
const { requireAuth } = require('../auth');
const { wallet, round2, sendReport } = require('../util');
const market = require('../marketdata');

const router = express.Router();

router.get('/portfolio', requireAuth, async (req, res) => {
  const holdings = await all(
    `SELECT h.*, i.symbol, i.name, i.exchange FROM holdings h
     JOIN instruments i ON i.id = h.instrument_id WHERE h.user_id = ? AND h.qty > 0 ORDER BY i.symbol`, req.user.id);
  const enriched = holdings.map((h) => {
    const q = market.getQuote(h.instrument_id);
    const ltp = q ? q.ltp : h.avg_price;
    const invested = round2(h.qty * h.avg_price);
    const marketValue = round2(h.qty * ltp);
    return {
      ...h, ltp, invested, market_value: marketValue,
      unrealized_pnl: round2(marketValue - invested),
      pnl_pct: invested ? round2(((marketValue - invested) / invested) * 100) : 0,
      day_change_pct: q ? q.change_pct : 0,
    };
  });
  const realized = (await get(
    "SELECT IFNULL(SUM(realized_pnl), 0) s FROM orders WHERE user_id = ? AND side = 'SELL' AND status = 'Executed'", req.user.id)).s;
  res.json({
    holdings: enriched,
    totals: {
      invested: round2(enriched.reduce((s, h) => s + h.invested, 0)),
      market_value: round2(enriched.reduce((s, h) => s + h.market_value, 0)),
      unrealized_pnl: round2(enriched.reduce((s, h) => s + h.unrealized_pnl, 0)),
      realized_pnl: round2(realized),
    },
    wallet: await wallet(req.user.id),
    feed: market.publicHealth(),
  });
});

router.get('/transactions/mine', requireAuth, async (req, res) => {
  const rows = await all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 300', req.user.id);
  res.json({ transactions: rows, wallet: await wallet(req.user.id) });
});

// Investor statements — CSV downloads (investor-facing reports).
router.get('/statements/transactions', requireAuth, async (req, res) => {
  const rows = await all(`SELECT id, created_at, type, amount, balance_after, note FROM transactions
                    WHERE user_id = ? ORDER BY id DESC`, req.user.id);
  sendReport(res, 'finvora-transactions', rows, req.query.format || 'csv');
});

router.get('/statements/orders', requireAuth, async (req, res) => {
  const rows = await all(`SELECT o.id, o.created_at, i.symbol, o.side, o.qty, o.price, o.status,
                           o.exec_price, o.exec_qty, o.exec_time, o.realized_pnl, o.reject_reason
                    FROM orders o JOIN instruments i ON i.id = o.instrument_id
                    WHERE o.user_id = ? ORDER BY o.id DESC`, req.user.id);
  sendReport(res, 'finvora-orders', rows, req.query.format || 'csv');
});

// Notifications (investor + admin share these; scoped by audience).
router.get('/notifications/mine', requireAuth, async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await all("SELECT * FROM notifications WHERE audience = 'ADMIN' ORDER BY id DESC LIMIT 100")
    : await all("SELECT * FROM notifications WHERE audience = 'USER' AND user_id = ? ORDER BY id DESC LIMIT 100", req.user.id);
  const unread = rows.filter((n) => !n.is_read).length;
  res.json({ notifications: rows, unread });
});

router.post('/notifications/read', requireAuth, async (req, res) => {
  const { ids } = req.body || {};
  if (ids === 'all') {
    if (req.user.role === 'admin') await run("UPDATE notifications SET is_read = 1 WHERE audience = 'ADMIN'");
    else await run("UPDATE notifications SET is_read = 1 WHERE audience = 'USER' AND user_id = ?", req.user.id);
  } else if (Array.isArray(ids)) {
    for (const id of ids) {
      if (req.user.role === 'admin') await run("UPDATE notifications SET is_read = 1 WHERE id = ? AND audience = 'ADMIN'", Number(id));
      else await run("UPDATE notifications SET is_read = 1 WHERE id = ? AND audience = 'USER' AND user_id = ?", Number(id), req.user.id);
    }
  }
  res.json({ ok: true });
});

router.get('/withdrawals/mine', requireAuth, async (req, res) => {
  const rows = await all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  res.json({ withdrawals: rows, wallet: await wallet(req.user.id) });
});

module.exports = { router };
