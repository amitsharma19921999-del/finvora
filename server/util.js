// Shared business helpers: wallet math, notifications, audit/activity logging,
// validators (BPD Section 9), file storage, CSV export.
// Money helpers (wallet, creditWallet, sellableQty, settleFill, checkActivation)
// are ASYNC (Postgres). Notifications/audit/activity are fire-and-forget so callers
// don't have to await pure side effects.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { run, get } = require('./db');
const { emit } = require('./realtime');

const round2 = (n) => Math.round(n * 100) / 100;

// --- Wallet & Available Balance (BPD Stage 9/12: available = withdrawable) ---
// available = balance − funds reserved by open BUY orders − open withdrawal requests

// Cash that a client's open BUY orders (queued AMOs, orders being worked) have
// tied up. An order only ever blocks the MARGIN it will consume when it fills —
// the same cost/leverage that settleFill debits. Reserving the full notional
// instead would, at 100x, hold ₹82,000 for an order that costs ₹820 to carry:
// one after-hours commodity order would push `available` far negative and lock
// the client out of trading until it filled.
async function reservedForOrders(userId, excludeOrderId = null) {
  // The exclusion is spliced into the SQL rather than parameterised: Postgres
  // cannot infer a type for a bare `$n IS NULL` and rejects the statement.
  const base = "SELECT IFNULL(SUM(qty * price), 0) s FROM orders WHERE user_id = ? AND side = 'BUY' AND status IN ('Pending','Executing')";
  const row = excludeOrderId
    ? await get(`${base} AND id <> ?`, userId, excludeOrderId)
    : await get(base, userId);
  const gross = Number(row.s);
  const p = await get('SELECT leverage FROM risk_profiles WHERE user_id = ?', userId);
  const lev = Math.max(1, Number(p && p.leverage) || 1);
  return round2(gross / lev);
}

async function wallet(userId) {
  let w = await get('SELECT balance FROM wallets WHERE user_id = ?', userId);
  if (!w) { await run('INSERT INTO wallets (user_id, balance) VALUES (?, 0)', userId); w = { balance: 0 }; }
  const rb = await reservedForOrders(userId);
  const rw = Number((await get("SELECT IFNULL(SUM(amount), 0) s FROM withdrawals WHERE user_id = ? AND status IN ('Withdrawal Pending','Processing')", userId)).s);
  return {
    balance: round2(w.balance),
    reserved_orders: round2(rb),
    reserved_withdrawals: round2(rw),
    available: round2(w.balance - rb - rw),
  };
}

async function creditWallet(userId, amount, type, refTable, refId, note) {
  // Normalize to paisa once so the balance and the ledger row never diverge.
  const amt = round2(amount);
  await run('UPDATE wallets SET balance = round((balance + ?)::numeric, 2) WHERE user_id = ?', amt, userId);
  const bal = round2((await get('SELECT balance FROM wallets WHERE user_id = ?', userId)).balance);
  await run('INSERT INTO transactions (user_id, type, ref_table, ref_id, amount, balance_after, note) VALUES (?,?,?,?,?,?,?)',
    userId, type, refTable || null, refId || null, amt, bal, note || null);
  return bal;
}

// Sellable = held qty − qty locked in open SELL orders for that instrument
async function sellableQty(userId, instrumentId) {
  const h = await get('SELECT qty FROM holdings WHERE user_id = ? AND instrument_id = ?', userId, instrumentId);
  if (!h) return 0;
  const locked = Number((await get("SELECT IFNULL(SUM(qty), 0) s FROM orders WHERE user_id = ? AND instrument_id = ? AND side = 'SELL' AND status IN ('Pending','Executing')", userId, instrumentId)).s);
  return h.qty - locked;
}

// Settle an executed fill: move the money + holdings and mark the order Executed.
// The order's price is ALWAYS set equal to the execution price (px). Callers
// validate funds/holdings first and wrap this in a transaction. `order` must carry
// .symbol (join it). Returns { pnl } (0 for BUY).
// `leverage` only matters on a BUY: it decides how much cash is actually blocked.
// At 1x that is the whole cost (plain cash trading). At 100x only 1/100th leaves
// the wallet — otherwise a leveraged buy would drain the balance to zero (or
// negative) and the client could never trade again.
async function settleFill(order, px, qty, byUserId, leverage = 1) {
  px = round2(px);
  qty = Number(qty);
  const lev = Math.max(1, Number(leverage) || 1);
  if (order.side === 'BUY') {
    const cost = round2(qty * px);
    const margin = round2(cost / lev);
    await creditWallet(order.user_id, -margin, 'BUY', 'orders', order.id,
      `Bought ${qty} × ${order.symbol} @ ₹${px}${lev > 1 ? ` (margin ₹${margin} at ${lev}x)` : ''}`);
    const h = await get('SELECT * FROM holdings WHERE user_id = ? AND instrument_id = ?', order.user_id, order.instrument_id);
    if (h) {
      const newQty = h.qty + qty;
      const newAvg = round2((h.qty * h.avg_price + qty * px) / newQty);
      // legacy rows predate margin_used — treat them as fully paid (1x)
      const prevMargin = h.margin_used == null ? round2(h.qty * h.avg_price) : Number(h.margin_used);
      await run('UPDATE holdings SET qty = ?, avg_price = ?, margin_used = ? WHERE id = ?',
        newQty, newAvg, round2(prevMargin + margin), h.id);
    } else {
      await run('INSERT INTO holdings (user_id, instrument_id, qty, avg_price, margin_used) VALUES (?,?,?,?,?)',
        order.user_id, order.instrument_id, qty, px, margin);
    }
    await run("UPDATE orders SET status = 'Executed', price = ?, exec_price = ?, exec_qty = ?, exec_time = datetime('now'), updated_by = ? WHERE id = ?",
      px, px, qty, byUserId || null, order.id);
    return { pnl: 0, margin };
  }
  // SELL — release the margin this slice tied up, then settle the profit or loss.
  const h = await get('SELECT * FROM holdings WHERE user_id = ? AND instrument_id = ?', order.user_id, order.instrument_id);
  if (!h || h.qty < qty) throw new Error(`Investor holds only ${h ? h.qty : 0} × ${order.symbol} — cannot execute sell of ${qty}.`);
  const pnl = round2((px - h.avg_price) * qty);
  const heldMargin = h.margin_used == null ? round2(h.qty * h.avg_price) : Number(h.margin_used);
  const release = round2(heldMargin * (qty / h.qty));
  if (h.qty === qty) await run('DELETE FROM holdings WHERE id = ?', h.id);
  else await run('UPDATE holdings SET qty = qty - ?, margin_used = ? WHERE id = ?', qty, round2(heldMargin - release), h.id);
  await creditWallet(order.user_id, round2(release + pnl), 'SELL', 'orders', order.id,
    `Sold ${qty} × ${order.symbol} @ ₹${px} (P&L ₹${pnl})`);
  await run("UPDATE orders SET status = 'Executed', price = ?, exec_price = ?, exec_qty = ?, realized_pnl = ?, exec_time = datetime('now'), updated_by = ? WHERE id = ?",
    px, px, qty, pnl, byUserId || null, order.id);
  return { pnl, released: release };
}

// --- Notifications (fire-and-forget; not awaited by callers) ------------------
function notifyAdmin(type, title, body, refTable, refId) {
  run("INSERT INTO notifications (audience, type, title, body, ref_table, ref_id) VALUES ('ADMIN',?,?,?,?,?)",
    type, title, body || null, refTable || null, refId || null)
    .then((r) => emit('ADMIN', 'notification', { id: r.lastInsertRowid, type, title, body, ref_table: refTable, ref_id: refId, created_at: new Date().toISOString() }))
    .catch((e) => console.error('[notifyAdmin]', e.message));
}

function notifyUser(userId, type, title, body, refTable, refId) {
  run("INSERT INTO notifications (audience, user_id, type, title, body, ref_table, ref_id) VALUES ('USER',?,?,?,?,?,?)",
    userId, type, title, body || null, refTable || null, refId || null)
    .then((r) => emit(userId, 'notification', { id: r.lastInsertRowid, type, title, body, ref_table: refTable, ref_id: refId, created_at: new Date().toISOString() }))
    .catch((e) => console.error('[notifyUser]', e.message));
}

// --- Audit & Activity (fire-and-forget) --------------------------------------
function audit(adminId, action, entity, entityId, details) {
  run('INSERT INTO audit_log (admin_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)',
    adminId, action, entity, entityId || null, typeof details === 'string' ? details : JSON.stringify(details || {}))
    .catch((e) => console.error('[audit]', e.message));
}

function activity(userId, action, details) {
  run('INSERT INTO activity_log (user_id, action, details) VALUES (?,?,?)', userId || null, action, details || null)
    .catch((e) => console.error('[activity]', e.message));
}

// --- Validators (BPD Section 9) ----------------------------------------------
const validators = {
  mobile: (v) => /^[6-9]\d{9}$/.test(String(v || '')),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '')),
  pan: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v || '').toUpperCase()),
  aadhaar: (v) => /^[2-9]\d{11}$/.test(String(v || '').replace(/\s/g, '')),
  ifsc: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v || '').toUpperCase()),
  accountNumber: (v) => /^\d{9,18}$/.test(String(v || '').replace(/\s/g, '')),
  amount: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
  qty: (v) => Number.isInteger(Number(v)) && Number(v) > 0,
};

// --- Base64 file storage (KYC docs, bank proof, payment screenshots) ---------
function saveDataUrl(dataUrl, prefix) {
  const m = String(dataUrl || '').match(/^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === 'application/pdf' ? 'pdf' : m[2].replace('jpeg', 'jpg');
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 8 * 1024 * 1024) return null;
  fs.writeFileSync(path.join(config.uploadsDir(), name), buf);
  return name;
}

// --- CSV export (Section 6.2 reports) ----------------------------------------
function toCsv(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function sendReport(res, name, rows, format) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows));
  }
  res.json({ rows });
}

// Account Activation (BPD Stage 6): both KYC and Bank must be Approved.
async function checkActivation(userId) {
  const u = await get('SELECT id, status FROM users WHERE id = ?', userId);
  if (!u || u.status !== 'Registered') return false;
  const kycOk = await get("SELECT id FROM kyc WHERE user_id = ? AND status = 'Approved'", userId);
  const bankOk = await get("SELECT id FROM bank_accounts WHERE user_id = ? AND status = 'Approved'", userId);
  if (kycOk && bankOk) {
    await run("UPDATE users SET status = 'Active' WHERE id = ?", userId);
    activity(userId, 'ACCOUNT_ACTIVATED', 'KYC and Bank both approved — account activated');
    notifyUser(userId, 'ACCOUNT_ACTIVATED', 'Account Activated 🎉',
      'Your KYC and bank details are approved. You now have access to all trading features.');
    emit(userId, 'accountStatus', { status: 'Active' });
    return true;
  }
  return false;
}

module.exports = {
  round2, wallet, reservedForOrders, creditWallet, sellableQty, settleFill,
  notifyAdmin, notifyUser, audit, activity,
  validators, saveDataUrl, toCsv, sendReport, checkActivation,
};
