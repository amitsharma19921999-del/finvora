// Stage 13 — Withdrawal Request (investor side).
// Lifecycle: Withdrawal Pending -> Processing -> Completed | Rejected.
const express = require('express');
const { run, get, setting } = require('../db');
const { requireAuth } = require('../auth');
const { validators, wallet, activity, notifyAdmin, round2 } = require('../util');

const router = express.Router();

router.post('/withdrawals', requireAuth, async (req, res) => {
  if (req.user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account must be Active to withdraw funds.' });
  }
  const bank = await get("SELECT * FROM bank_accounts WHERE user_id = ? AND status = 'Approved' ORDER BY id DESC", req.user.id);
  if (!bank) return res.status(403).json({ error: 'Withdrawals are paid to your approved bank account. Get your bank details approved first.' });

  const amt = round2(Number((req.body || {}).amount));
  if (!validators.amount(amt) || amt < await setting('min_withdrawal')) {
    return res.status(400).json({ error: `Enter a valid amount (minimum ₹${await setting('min_withdrawal')}).` });
  }
  const w = await wallet(req.user.id);
  // BPD Section 8/9: withdrawal must not exceed Available Balance.
  if (amt > w.available) {
    return res.status(400).json({ error: `Amount exceeds your Available Balance of ₹${w.available}. (Funds reserved by open orders/withdrawals are not withdrawable.)` });
  }

  const r = await run("INSERT INTO withdrawals (user_id, amount, status) VALUES (?,?,'Withdrawal Pending')", req.user.id, amt);
  activity(req.user.id, 'WITHDRAWAL_REQUESTED', `Withdrawal #${r.lastInsertRowid} of ₹${amt} requested`);
  notifyAdmin('WITHDRAWAL_REQUEST', 'New Withdrawal Request',
    `${req.user.mobile} requested a withdrawal of ₹${amt} to ${bank.bank_name} ****${String(bank.account_number).slice(-4)}.`,
    'withdrawals', r.lastInsertRowid);
  res.json({
    message: 'Withdrawal request submitted. Status: Withdrawal Pending — funds will be transferred to your approved bank account after review.',
    id: r.lastInsertRowid, status: 'Withdrawal Pending', wallet: await wallet(req.user.id),
  });
});

module.exports = { router };
