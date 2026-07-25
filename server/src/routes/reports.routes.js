// Reporting Module (BPD Section 6.2) — all nine reports, JSON + CSV export:
// Investor, Deposit, Withdrawal, Trading, Portfolio, Activity, Audit,
// Payment Gateway Settlement, Feed Health Monitor.
const express = require('express');
const { get, all } = require('../db');
const { requireAdmin } = require('../auth');
const { sendReport, round2 } = require('../util');
const market = require('../marketdata');

const router = express.Router();
router.use(requireAdmin);

function dateFilter(query, column) {
  const conds = [], params = [];
  if (query.from) { conds.push(`date(${column}) >= date(?)`); params.push(query.from); }
  if (query.to) { conds.push(`date(${column}) <= date(?)`); params.push(query.to); }
  return { conds, params };
}

router.get('/reports/investors', async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.mobile, u.email, u.status account_status, u.created_at registered_at,
            IFNULL((SELECT full_name FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1), '') full_name,
            IFNULL((SELECT status FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1), 'Not Submitted') kyc_status,
            IFNULL((SELECT status FROM bank_accounts WHERE user_id = u.id ORDER BY id DESC LIMIT 1), 'Not Submitted') bank_status,
            IFNULL((SELECT balance FROM wallets WHERE user_id = u.id), 0) wallet_balance,
            (SELECT COUNT(*) FROM orders WHERE user_id = u.id) total_orders,
            IFNULL((SELECT SUM(amount) FROM deposits WHERE user_id = u.id AND status IN ('Deposit Approved','Deposit Approved (Auto)')), 0) total_deposited,
            IFNULL((SELECT SUM(amount) FROM withdrawals WHERE user_id = u.id AND status = 'Completed'), 0) total_withdrawn
     FROM users u WHERE u.role = 'investor' ORDER BY u.id`);
  sendReport(res, 'investor-report', rows, req.query.format);
});

router.get('/reports/deposits', async (req, res) => {
  const { conds, params } = dateFilter(req.query, 'd.created_at');
  if (req.query.status) { conds.push('d.status = ?'); params.push(req.query.status); }
  if (req.query.method) { conds.push('d.method = ?'); params.push(req.query.method); }
  const rows = await all(
    `SELECT d.id, d.created_at, u.mobile, u.email, d.method, d.amount, d.status, d.utr,
            d.gateway_order_id, d.gateway_txn_id, d.gateway_amount, d.needs_review, d.review_note, d.reject_reason, d.verified_at
     FROM deposits d JOIN users u ON u.id = d.user_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY d.id DESC`, ...params);
  sendReport(res, 'deposit-report', rows, req.query.format);
});

router.get('/reports/withdrawals', async (req, res) => {
  const { conds, params } = dateFilter(req.query, 'w.created_at');
  if (req.query.status) { conds.push('w.status = ?'); params.push(req.query.status); }
  const rows = await all(
    `SELECT w.id, w.created_at, u.mobile, u.email, w.amount, w.status, w.reject_reason, w.processed_at
     FROM withdrawals w JOIN users u ON u.id = w.user_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY w.id DESC`, ...params);
  sendReport(res, 'withdrawal-report', rows, req.query.format);
});

router.get('/reports/trading', async (req, res) => {
  const { conds, params } = dateFilter(req.query, 'o.created_at');
  if (req.query.status) { conds.push('o.status = ?'); params.push(req.query.status); }
  if (req.query.side) { conds.push('o.side = ?'); params.push(req.query.side); }
  const rows = await all(
    `SELECT o.id, o.created_at, u.mobile, i.symbol, o.side, o.qty, o.price, o.ltp_at_order,
            o.feed_status_at_order, o.status, o.exec_price, o.exec_qty, o.exec_time, o.realized_pnl, o.reject_reason
     FROM orders o JOIN users u ON u.id = o.user_id JOIN instruments i ON i.id = o.instrument_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY o.id DESC`, ...params);
  sendReport(res, 'trading-report', rows, req.query.format);
});

router.get('/reports/portfolio', async (req, res) => {
  const rows = (await all(
    `SELECT u.mobile, u.email, h.instrument_id, i.symbol, h.qty, h.avg_price, ROUND((h.qty * h.avg_price)::numeric, 2) invested
     FROM holdings h JOIN users u ON u.id = h.user_id JOIN instruments i ON i.id = h.instrument_id
     WHERE h.qty > 0 ORDER BY u.id, i.symbol`)).map((r) => {
    const q = market.getQuote(r.instrument_id);
    const ltp = q ? q.ltp : r.avg_price;
    const { instrument_id, ...rest } = r;
    return { ...rest, ltp, market_value: round2(r.qty * ltp), unrealized_pnl: round2(r.qty * ltp - r.invested) };
  });
  sendReport(res, 'portfolio-report', rows, req.query.format);
});

router.get('/reports/activity', async (req, res) => {
  const { conds, params } = dateFilter(req.query, 'a.created_at');
  const rows = await all(
    `SELECT a.id, a.created_at, IFNULL(u.mobile, '-') mobile, IFNULL(u.email, '-') email, a.action, a.details
     FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 1000`, ...params);
  sendReport(res, 'activity-report', rows, req.query.format);
});

router.get('/reports/audit', async (req, res) => {
  const { conds, params } = dateFilter(req.query, 'a.created_at');
  const rows = await all(
    `SELECT a.id, a.created_at, u.email admin, a.action, a.entity, a.entity_id, a.details
     FROM audit_log a JOIN users u ON u.id = a.admin_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 1000`, ...params);
  sendReport(res, 'audit-report', rows, req.query.format);
});

// Payment Gateway Settlement Report — reconciliation between gateway records
// and platform deposits (BPD 6.2 NEW).
router.get('/reports/gateway-settlement', async (req, res) => {
  const settlements = await all('SELECT * FROM mock_gateway_payments ORDER BY id DESC');
  const rows = await Promise.all(settlements.map(async (s) => {
    const dep = await get('SELECT * FROM deposits WHERE gateway_order_id = ?', s.order_id);
    let match;
    if (!dep) match = 'NO PLATFORM DEPOSIT';
    else if (s.status === 'failed') match = dep.status === 'Deposit Failed' ? 'MATCHED (failed)' : 'STATUS MISMATCH';
    else if (['Deposit Approved (Auto)', 'Deposit Approved'].includes(dep.status)) {
      match = Math.abs(s.amount - dep.amount) < 0.01 ? 'MATCHED' : 'APPROVED WITH AMOUNT DIFFERENCE';
    } else if (dep.status === 'Deposit Failed') match = 'CAPTURED AT GATEWAY, FAILED ON PLATFORM — REFUND DUE';
    else if (!s.webhook_sent) match = 'WEBHOOK PENDING — RECONCILE';
    else if (dep.needs_review) match = 'HELD FOR MANUAL REVIEW';
    else match = 'AWAITING CONFIRMATION';
    return {
      gateway_txn_id: s.txn_id, gateway_order_id: s.order_id, gateway_amount: s.amount,
      gateway_status: s.status, gateway_method: s.method, webhook_sent: s.webhook_sent ? 'Yes' : 'No',
      platform_deposit_id: dep ? dep.id : '-', platform_amount: dep ? dep.amount : '-',
      platform_status: dep ? dep.status : '-', reconciliation: match, captured_at: s.created_at,
    };
  }));
  // Gateway deposits on platform with no gateway record at all.
  for (const dep of await all("SELECT * FROM deposits WHERE method = 'GATEWAY' AND gateway_order_id NOT IN (SELECT order_id FROM mock_gateway_payments) ORDER BY id DESC")) {
    rows.push({
      gateway_txn_id: '-', gateway_order_id: dep.gateway_order_id, gateway_amount: '-',
      gateway_status: 'NO GATEWAY RECORD', gateway_method: '-', webhook_sent: '-',
      platform_deposit_id: dep.id, platform_amount: dep.amount, platform_status: dep.status,
      reconciliation: dep.status === 'Payment Initiated' ? 'PAYMENT NEVER COMPLETED' : 'NO GATEWAY RECORD — INVESTIGATE',
      captured_at: dep.created_at,
    });
  }
  sendReport(res, 'gateway-settlement-report', rows, req.query.format);
});

// Feed Health Monitor Report — uptime/status of the market data feed (BPD 6.2 NEW).
router.get('/reports/feed-health', async (req, res) => {
  const log = await all('SELECT * FROM feed_health_log ORDER BY id ASC');
  let liveMs = 0, totalMs = 0;
  for (let i = 0; i < log.length; i++) {
    const start = new Date(log[i].created_at + 'Z').getTime();
    const end = i + 1 < log.length ? new Date(log[i + 1].created_at + 'Z').getTime() : Date.now();
    totalMs += end - start;
    if (log[i].status === 'LIVE') liveMs += end - start;
  }
  const rows = log.slice().reverse().map((l) => ({ id: l.id, at: l.created_at, status: l.status, detail: l.detail }));
  if (req.query.format === 'csv') return sendReport(res, 'feed-health-report', rows, 'csv');
  res.json({
    current: market.publicHealth(),
    uptime_pct: totalMs ? round2((liveMs / totalMs) * 100) : 100,
    transitions: rows,
  });
});

module.exports = { router };
