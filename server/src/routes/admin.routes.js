// Administrator Console (BPD Section 4, Stages 4/5/8/11/14, Section 6.1).
// Every mutation is audited (Section 8: all admin actions logged in Audit Reports)
// and every rejection requires a reason.
const express = require('express');
const { run, get, all, tx, setting, settingStr, setSetting, scryptHash } = require('../db');
const { requireAdmin } = require('../auth');
const { wallet, creditWallet, settleFill, round2, audit, notifyUser, notifyAdmin, checkActivation, saveDataUrl } = require('../util');
const { issueOtp } = require('./auth.routes');
const { emit } = require('../realtime');
const market = require('../marketdata');

const router = express.Router();
router.use(requireAdmin);

const needReason = (reason) => !reason || String(reason).trim().length < 3;

// --- Dashboard ---------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  const c = async (sql, ...p) => (await get(sql, ...p)).n;
  res.json({
    investors_total: await c("SELECT COUNT(*) n FROM users WHERE role = 'investor'"),
    investors_active: await c("SELECT COUNT(*) n FROM users WHERE role = 'investor' AND status = 'Active'"),
    kyc_pending: await c("SELECT COUNT(*) n FROM kyc WHERE status IN ('Submitted','Under Review')"),
    bank_pending: await c("SELECT COUNT(*) n FROM bank_accounts WHERE status IN ('Submitted','Under Review')"),
    deposits_pending: await c("SELECT COUNT(*) n FROM deposits WHERE status IN ('Deposit Pending','Deposit Under Verification') OR (status = 'Gateway Confirmation Pending')"),
    deposits_review: await c('SELECT COUNT(*) n FROM deposits WHERE needs_review = 1 AND status NOT IN (\'Deposit Approved\',\'Deposit Approved (Auto)\',\'Deposit Failed\',\'Deposit Rejected\')'),
    orders_open: await c("SELECT COUNT(*) n FROM orders WHERE status IN ('Pending','Executing')"),
    withdrawals_open: await c("SELECT COUNT(*) n FROM withdrawals WHERE status IN ('Withdrawal Pending','Processing')"),
    deposits_today: (await get("SELECT IFNULL(SUM(amount),0) s FROM deposits WHERE status IN ('Deposit Approved','Deposit Approved (Auto)') AND date(verified_at) = date('now')")).s,
    withdrawals_today: (await get("SELECT IFNULL(SUM(amount),0) s FROM withdrawals WHERE status = 'Completed' AND date(processed_at) = date('now')")).s,
    unread_notifications: await c("SELECT COUNT(*) n FROM notifications WHERE audience = 'ADMIN' AND is_read = 0"),
    feed: market.publicHealth(),
  });
});

// --- Investor Management -----------------------------------------------------
router.get('/investors', async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = await all(
    `SELECT u.id, u.mobile, u.email, u.status, u.created_at,
            (SELECT status FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1) kyc_status,
            (SELECT full_name FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1) full_name,
            (SELECT status FROM bank_accounts WHERE user_id = u.id ORDER BY id DESC LIMIT 1) bank_status,
            IFNULL((SELECT balance FROM wallets WHERE user_id = u.id), 0) balance,
            (SELECT COUNT(*) FROM orders WHERE user_id = u.id) order_count
     FROM users u WHERE u.role = 'investor' AND (u.mobile LIKE ? OR u.email LIKE ? OR IFNULL((SELECT full_name FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1),'') LIKE ?)
     ORDER BY u.id DESC LIMIT 300`, q, q, q);
  res.json({ investors: rows });
});

router.get('/investors/:id', async (req, res) => {
  const user = await get("SELECT id, mobile, email, status, created_at FROM users WHERE id = ? AND role = 'investor'", req.params.id);
  if (!user) return res.status(404).json({ error: 'Investor not found.' });
  res.json({
    user,
    wallet: await wallet(user.id),
    kyc: await get('SELECT * FROM kyc WHERE user_id = ? ORDER BY id DESC', user.id) || null,
    bank: await get('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY id DESC', user.id) || null,
    holdings: await all(`SELECT h.*, i.symbol FROM holdings h JOIN instruments i ON i.id = h.instrument_id WHERE h.user_id = ? AND h.qty > 0`, user.id),
    orders: await all(`SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 20`, user.id),
    deposits: await all('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id),
    withdrawals: await all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id),
    transactions: await all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30', user.id),
  });
});

router.post('/investors/:id/status', async (req, res) => {
  const { status, reason } = req.body || {};
  if (!['Active', 'Suspended'].includes(status)) return res.status(400).json({ error: 'Status must be Active or Suspended.' });
  const user = await get("SELECT * FROM users WHERE id = ? AND role = 'investor'", req.params.id);
  if (!user) return res.status(404).json({ error: 'Investor not found.' });

  let newStatus = status;
  if (status === 'Active') {
    // Activation eligibility is enforced for ANY transition to Active (including
    // un-suspending) — never let an admin bypass the KYC+Bank rule (BPD §8).
    const kycOk = await get("SELECT id FROM kyc WHERE user_id = ? AND status = 'Approved'", user.id);
    const bankOk = await get("SELECT id FROM bank_accounts WHERE user_id = ? AND status = 'Approved'", user.id);
    if (!kycOk || !bankOk) {
      // Un-suspending an investor who isn't yet eligible restores their onboarding
      // status instead of activating them.
      if (user.status === 'Suspended') {
        const otpVerified = await get("SELECT id FROM kyc WHERE user_id = ?", user.id) || user.status !== 'OTP Pending';
        newStatus = otpVerified ? 'Registered' : 'OTP Pending';
      } else {
        return res.status(409).json({ error: 'Cannot activate: the account activates automatically once KYC and Bank are both Approved.' });
      }
    }
  }
  await run('UPDATE users SET status = ? WHERE id = ?', newStatus, user.id);
  audit(req.user.id, `INVESTOR_${newStatus.toUpperCase()}`, 'users', user.id, reason || '');
  notifyUser(user.id, 'ACCOUNT_STATUS', `Account ${newStatus === 'Suspended' ? 'Suspended' : newStatus === 'Active' ? 'Active' : 'Updated'}`,
    newStatus === 'Suspended' ? `Your account has been suspended.${reason ? ` Reason: ${reason}` : ''} Contact support.`
      : newStatus === 'Active' ? 'Your account is active again.'
      : 'Your account suspension has been lifted — complete onboarding to reactivate trading.');
  // Push the status change so a live client's session updates immediately.
  emit(user.id, 'accountStatus', { status: newStatus });
  res.json({ message: newStatus === status ? `Investor marked ${newStatus}.` : `Suspension lifted — investor returned to ${newStatus} (KYC/Bank not both Approved, so not activated).` });
});

// --- KYC Approval (Stage 4) --------------------------------------------------
// --- Password resets (admin-gated) -------------------------------------------
// NOTE: passwords are stored as one-way scrypt hashes and cannot be read back or
// displayed. Support works by RESETTING a password, never by revealing it.
router.get('/password-resets', async (req, res) => {
  const { status } = req.query;
  const base = `SELECT p.*, u.mobile, u.email,
      (SELECT full_name FROM kyc WHERE user_id = u.id ORDER BY id DESC LIMIT 1) full_name
    FROM password_resets p JOIN users u ON u.id = p.user_id`;
  const rows = status
    ? await all(`${base} WHERE p.status = ? ORDER BY p.id DESC LIMIT 200`, status)
    : await all(`${base} ORDER BY p.id DESC LIMIT 200`);
  res.json({ resets: rows });
});

router.post('/password-resets/:id/review', async (req, res) => {
  const { action, reason } = req.body || {};
  const pr = await get(
    'SELECT p.*, u.mobile, u.email FROM password_resets p JOIN users u ON u.id = p.user_id WHERE p.id = ?',
    req.params.id);
  if (!pr) return res.status(404).json({ error: 'Reset request not found.' });
  if (pr.status !== 'Pending') return res.status(409).json({ error: `This request is already ${pr.status}.` });

  if (action === 'reject') {
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required.' });
    await run("UPDATE password_resets SET status = 'Rejected', reject_reason = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?",
      reason, req.user.id, pr.id);
    audit(req.user.id, 'PASSWORD_RESET_REJECTED', 'password_resets', pr.id, { reason });
    notifyUser(pr.user_id, 'PASSWORD_RESET_REJECTED', 'Password Reset Rejected',
      `Your password reset request was rejected: ${reason}`);
    return res.json({ message: 'Request rejected and the investor notified.' });
  }
  if (action !== 'approve') return res.status(400).json({ error: "action must be 'approve' or 'reject'." });

  // Approve: open a 30-minute window and issue the one-time code.
  await run("UPDATE password_resets SET status = 'Approved', reviewed_at = datetime('now'), reviewed_by = ?, approved_until = datetime('now','+30 minutes') WHERE id = ?",
    req.user.id, pr.id);
  const otp = await issueOtp(pr.mobile, 'reset');
  audit(req.user.id, 'PASSWORD_RESET_APPROVED', 'password_resets', pr.id, { mobile: pr.mobile });
  notifyUser(pr.user_id, 'PASSWORD_RESET_APPROVED', 'Password Reset Approved ✅',
    'Your password reset was approved. Use the one-time code we sent to set a new password within 30 minutes.');
  res.json({
    message: `Approved — ${pr.mobile} can set a new password within 30 minutes.`,
    // In free/demo SMS mode no real text is sent, so hand the code to the admin
    // to relay to the investor. With Twilio configured this is absent (real SMS).
    ...(otp.demo_otp ? { demo_otp: otp.demo_otp, demo_mode: true } : {}),
  });
});

// Admin sets an investor's password directly (the support path).
router.post('/investors/:id/set-password', async (req, res) => {
  const { password } = req.body || {};
  const user = await get("SELECT * FROM users WHERE id = ? AND role = 'investor'", req.params.id);
  if (!user) return res.status(404).json({ error: 'Investor not found.' });
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers.' });
  }
  await run('UPDATE users SET password_hash = ? WHERE id = ?', scryptHash(password), user.id);
  // Close out any open request — it has been serviced.
  await run("UPDATE password_resets SET status = 'Used', used_at = datetime('now') WHERE user_id = ? AND status IN ('Pending','Approved')", user.id);
  audit(req.user.id, 'PASSWORD_SET_BY_ADMIN', 'users', user.id, { mobile: user.mobile });
  notifyUser(user.id, 'PASSWORD_CHANGED', 'Password Changed by Support',
    'Your Finvora password was changed by our support team. If you did not request this, contact us immediately.');
  res.json({ message: `Password updated for ${user.mobile}. Share it securely and ask them to change it after logging in.` });
});

router.get('/kyc', async (req, res) => {
  const status = req.query.status;
  const base = `SELECT k.*, u.mobile, u.email FROM kyc k JOIN users u ON u.id = k.user_id`;
  const rows = status
    ? await all(`${base} WHERE k.status = ? ORDER BY k.id DESC LIMIT 200`, status)
    : await all(`${base} ORDER BY CASE k.status WHEN 'Submitted' THEN 0 WHEN 'Under Review' THEN 1 ELSE 2 END, k.id DESC LIMIT 200`);
  res.json({ kyc: rows });
});

router.post('/kyc/:id/review', async (req, res) => {
  const { action, reason } = req.body || {};
  const row = await get('SELECT * FROM kyc WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'KYC record not found.' });
  if (['Approved', 'Rejected'].includes(row.status)) return res.status(409).json({ error: `KYC already ${row.status}.` });

  if (action === 'under_review') {
    await run("UPDATE kyc SET status = 'Under Review' WHERE id = ?", row.id);
    audit(req.user.id, 'KYC_UNDER_REVIEW', 'kyc', row.id, '');
    notifyUser(row.user_id, 'KYC_STATUS', 'KYC Under Review', 'Your KYC documents are being reviewed by our team.');
    return res.json({ message: 'KYC moved to Under Review.', status: 'Under Review' });
  }
  if (action === 'approve') {
    await run("UPDATE kyc SET status = 'Approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", req.user.id, row.id);
    audit(req.user.id, 'KYC_APPROVED', 'kyc', row.id, `PAN ${row.pan}`);
    notifyUser(row.user_id, 'KYC_STATUS', 'KYC Approved ✅', 'Your KYC has been approved.');
    const activated = await checkActivation(row.user_id);
    return res.json({ message: `KYC approved.${activated ? ' Investor account activated.' : ''}`, status: 'Approved' });
  }
  if (action === 'reject') {
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required (business rule — audit & investor communication).' });
    await run("UPDATE kyc SET status = 'Rejected', reject_reason = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", reason, req.user.id, row.id);
    audit(req.user.id, 'KYC_REJECTED', 'kyc', row.id, reason);
    notifyUser(row.user_id, 'KYC_STATUS', 'KYC Rejected', `Your KYC was rejected: ${reason}. Please correct and resubmit.`);
    return res.json({ message: 'KYC rejected.', status: 'Rejected' });
  }
  res.status(400).json({ error: 'Unknown action. Use under_review / approve / reject.' });
});

// --- Bank Approval (Stage 5) -------------------------------------------------
router.get('/bank', async (req, res) => {
  const status = req.query.status;
  const base = `SELECT b.*, u.mobile, u.email FROM bank_accounts b JOIN users u ON u.id = b.user_id`;
  const rows = status
    ? await all(`${base} WHERE b.status = ? ORDER BY b.id DESC LIMIT 200`, status)
    : await all(`${base} ORDER BY CASE b.status WHEN 'Submitted' THEN 0 WHEN 'Under Review' THEN 1 ELSE 2 END, b.id DESC LIMIT 200`);
  res.json({ bank: rows });
});

router.post('/bank/:id/review', async (req, res) => {
  const { action, reason } = req.body || {};
  const row = await get('SELECT * FROM bank_accounts WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Bank record not found.' });
  if (['Approved', 'Rejected'].includes(row.status)) return res.status(409).json({ error: `Bank details already ${row.status}.` });

  if (action === 'under_review') {
    await run("UPDATE bank_accounts SET status = 'Under Review' WHERE id = ?", row.id);
    audit(req.user.id, 'BANK_UNDER_REVIEW', 'bank_accounts', row.id, '');
    notifyUser(row.user_id, 'BANK_STATUS', 'Bank Details Under Review', 'Your bank details are being verified.');
    return res.json({ message: 'Bank details moved to Under Review.', status: 'Under Review' });
  }
  if (action === 'approve') {
    await run("UPDATE bank_accounts SET status = 'Approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", req.user.id, row.id);
    audit(req.user.id, 'BANK_APPROVED', 'bank_accounts', row.id, `${row.bank_name} ****${String(row.account_number).slice(-4)}`);
    notifyUser(row.user_id, 'BANK_STATUS', 'Bank Details Approved ✅', 'Your bank account is verified. You can now add funds and request withdrawals.');
    const activated = await checkActivation(row.user_id);
    return res.json({ message: `Bank details approved.${activated ? ' Investor account activated.' : ''}`, status: 'Approved' });
  }
  if (action === 'reject') {
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required.' });
    await run("UPDATE bank_accounts SET status = 'Rejected', reject_reason = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", reason, req.user.id, row.id);
    audit(req.user.id, 'BANK_REJECTED', 'bank_accounts', row.id, reason);
    notifyUser(row.user_id, 'BANK_STATUS', 'Bank Details Rejected', `Your bank details were rejected: ${reason}. Please correct and resubmit.`);
    return res.json({ message: 'Bank details rejected.', status: 'Rejected' });
  }
  res.status(400).json({ error: 'Unknown action. Use under_review / approve / reject.' });
});

// --- Deposit Verification & Approval (Stage 8) -------------------------------
router.get('/deposits', async (req, res) => {
  const { status, needs_review } = req.query;
  let rows;
  const base = `SELECT d.*, u.mobile, u.email FROM deposits d JOIN users u ON u.id = d.user_id`;
  if (needs_review === '1') {
    rows = await all(`${base} WHERE d.needs_review = 1 AND d.status NOT IN ('Deposit Approved','Deposit Approved (Auto)','Deposit Failed','Deposit Rejected') ORDER BY d.id DESC LIMIT 200`);
  } else if (status) {
    rows = await all(`${base} WHERE d.status = ? ORDER BY d.id DESC LIMIT 200`, status);
  } else {
    rows = await all(`${base} ORDER BY CASE WHEN d.status IN ('Deposit Pending','Deposit Under Verification','Gateway Confirmation Pending') THEN 0 ELSE 1 END, d.id DESC LIMIT 200`);
  }
  res.json({ deposits: rows });
});

// Manual-path verification: Deposit Pending -> Under Verification -> Approved | Rejected.
router.post('/deposits/:id/review', async (req, res) => {
  const { action, reason } = req.body || {};
  const dep = await get('SELECT * FROM deposits WHERE id = ?', req.params.id);
  if (!dep) return res.status(404).json({ error: 'Deposit not found.' });
  if (dep.method !== 'MANUAL') return res.status(409).json({ error: 'Gateway deposits are auto-verified via webhook — use Reconcile for held ones.' });
  if (['Deposit Approved', 'Deposit Rejected'].includes(dep.status)) return res.status(409).json({ error: `Deposit already ${dep.status}.` });

  if (action === 'under_verification') {
    await run("UPDATE deposits SET status = 'Deposit Under Verification' WHERE id = ?", dep.id);
    audit(req.user.id, 'DEPOSIT_UNDER_VERIFICATION', 'deposits', dep.id, `₹${dep.amount} UTR ${dep.utr}`);
    notifyUser(dep.user_id, 'DEPOSIT_STATUS', 'Deposit Under Verification', `Your deposit of ₹${dep.amount} is being verified (screenshot, bank credit, UTR, amount).`);
    return res.json({ message: 'Deposit moved to Under Verification.', status: 'Deposit Under Verification' });
  }
  if (action === 'approve') {
    // Business rule: approval only after Under Verification checks are complete.
    if (dep.status !== 'Deposit Under Verification') {
      return res.status(409).json({ error: 'Move the deposit to Under Verification first (verify screenshot, bank credit, UTR, amount), then approve.' });
    }
    // Backstop against crediting the same bank reference twice.
    const utrClash = await get("SELECT id FROM deposits WHERE utr = ? AND id != ? AND status IN ('Deposit Approved','Deposit Approved (Auto)')", dep.utr, dep.id);
    if (utrClash) return res.status(409).json({ error: `This UTR was already approved on deposit #${utrClash.id}. Reject this one as a duplicate.` });
    await tx(async () => {
      await run("UPDATE deposits SET status = 'Deposit Approved', verified_at = datetime('now'), verified_by = ? WHERE id = ?", req.user.id, dep.id);
      await creditWallet(dep.user_id, dep.amount, 'DEPOSIT', 'deposits', dep.id, `Manual deposit approved (UTR ${dep.utr})`);
    });
    audit(req.user.id, 'DEPOSIT_APPROVED', 'deposits', dep.id, `₹${dep.amount} UTR ${dep.utr}`);
    notifyUser(dep.user_id, 'DEPOSIT_APPROVED', 'Deposit Approved ✅', `₹${dep.amount} has been credited to your trading wallet.`, 'deposits', dep.id);
    return res.json({ message: 'Deposit approved and wallet credited.', status: 'Deposit Approved' });
  }
  if (action === 'reject') {
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required.' });
    await run("UPDATE deposits SET status = 'Deposit Rejected', reject_reason = ?, verified_at = datetime('now'), verified_by = ? WHERE id = ?", reason, req.user.id, dep.id);
    audit(req.user.id, 'DEPOSIT_REJECTED', 'deposits', dep.id, reason);
    notifyUser(dep.user_id, 'DEPOSIT_STATUS', 'Deposit Rejected', `Your deposit of ₹${dep.amount} was rejected: ${reason}. You may resubmit with correct proof.`);
    return res.json({ message: 'Deposit rejected.', status: 'Deposit Rejected' });
  }
  res.status(400).json({ error: 'Unknown action. Use under_verification / approve / reject.' });
});

// Gateway-path reconciliation (webhook timeout / amount mismatch) against the
// gateway settlement records (BPD Section 8/10).
router.post('/deposits/:id/reconcile', async (req, res) => {
  const { decision } = req.body || {};
  const dep = await get('SELECT * FROM deposits WHERE id = ?', req.params.id);
  if (!dep || dep.method !== 'GATEWAY') return res.status(404).json({ error: 'Gateway deposit not found.' });
  if (!['Payment Initiated', 'Gateway Confirmation Pending'].includes(dep.status)) {
    return res.status(409).json({ error: `Deposit already ${dep.status}.` });
  }
  // Settlement evidence: the mock ledger in mock mode, else the recorded webhook
  // event for this order (razorpay). Either way, we only approve on real capture.
  let settlement = await get('SELECT * FROM mock_gateway_payments WHERE order_id = ? ORDER BY id DESC', dep.gateway_order_id);
  if (!settlement) {
    const ev = await get('SELECT * FROM gateway_events WHERE order_id = ? ORDER BY id DESC', dep.gateway_order_id);
    if (ev) {
      try {
        const p = JSON.parse(ev.payload);
        const captured = (p.event === 'payment.captured') || (p.event === 'payment.captured'.replace('.', '.'));
        settlement = { txn_id: p.txn_id || (p.payload?.payment?.entity?.id), amount: round2(p.amount || (p.payload?.payment?.entity?.amount || 0) / 100), status: captured ? 'captured' : 'failed' };
      } catch { /* unparseable event payload */ }
    }
  }

  if (decision === 'approve') {
    // BPD Section 8/9: a gateway deposit is only Approved on evidence of an
    // actual capture whose amount matches. Anything else must go the 'fail' path
    // — never credit the full initiated amount on missing/failed settlement.
    if (!settlement || settlement.status !== 'captured') {
      return res.status(409).json({ error: 'The gateway settlement does not show a captured payment for this order. Mark it Failed, or wait for the settlement record before approving.' });
    }
    const creditAmount = round2(Math.min(settlement.amount, dep.amount));
    await tx(async () => {
      await run("UPDATE deposits SET status = 'Deposit Approved', needs_review = 0, verified_at = datetime('now'), verified_by = ?, gateway_txn_id = IFNULL(gateway_txn_id, ?), gateway_amount = IFNULL(gateway_amount, ?) WHERE id = ?",
        req.user.id, settlement ? settlement.txn_id : null, settlement ? settlement.amount : null, dep.id);
      await creditWallet(dep.user_id, creditAmount, 'DEPOSIT', 'deposits', dep.id, `Gateway deposit approved after manual reconciliation${settlement ? ` (txn ${settlement.txn_id})` : ''}`);
    });
    audit(req.user.id, 'DEPOSIT_RECONCILED_APPROVED', 'deposits', dep.id,
      `Credited ₹${creditAmount}${settlement ? `; settlement showed ₹${settlement.amount} (${settlement.status})` : '; no settlement record found'}`);
    notifyUser(dep.user_id, 'DEPOSIT_APPROVED', 'Deposit Approved ✅', `₹${creditAmount} credited to your wallet after gateway reconciliation.`, 'deposits', dep.id);
    return res.json({ message: `Approved after reconciliation — credited ₹${creditAmount}.`, settlement });
  }
  if (decision === 'fail') {
    await run("UPDATE deposits SET status = 'Deposit Failed', needs_review = 0, verified_at = datetime('now'), verified_by = ?, review_note = 'Marked failed after reconciliation' WHERE id = ?", req.user.id, dep.id);
    audit(req.user.id, 'DEPOSIT_RECONCILED_FAILED', 'deposits', dep.id, settlement ? `Settlement: ₹${settlement.amount} ${settlement.status}` : 'No settlement record');
    notifyUser(dep.user_id, 'DEPOSIT_FAILED', 'Deposit Failed', `Your online deposit of ₹${dep.amount} could not be confirmed with the gateway. Any debited amount will be refunded by the gateway. Please retry.`, 'deposits', dep.id);
    return res.json({ message: 'Marked as Deposit Failed after reconciliation.', settlement });
  }
  // No decision: return the settlement record for the admin to inspect.
  res.json({ settlement: settlement || null, deposit: dep });
});

// Refund / chargeback initiated by the gateway (BPD Section 10 exception).
router.post('/deposits/:id/chargeback', async (req, res) => {
  const { reason } = req.body || {};
  if (needReason(reason)) return res.status(400).json({ error: 'A chargeback reason is required.' });
  const dep = await get('SELECT * FROM deposits WHERE id = ?', req.params.id);
  if (!dep || dep.method !== 'GATEWAY') return res.status(404).json({ error: 'Gateway deposit not found.' });
  if (!['Deposit Approved', 'Deposit Approved (Auto)'].includes(dep.status)) {
    return res.status(409).json({ error: 'Chargeback applies only to approved gateway deposits.' });
  }
  if (dep.review_note && dep.review_note.startsWith('CHARGEBACK')) return res.status(409).json({ error: 'Chargeback already recorded for this deposit.' });
  await tx(async () => {
    await creditWallet(dep.user_id, -dep.amount, 'CHARGEBACK', 'deposits', dep.id, `Gateway refund/chargeback: ${reason}`);
    await run("UPDATE deposits SET review_note = ? WHERE id = ?", `CHARGEBACK: ${reason}`, dep.id);
  });
  audit(req.user.id, 'DEPOSIT_CHARGEBACK', 'deposits', dep.id, `₹${dep.amount} debited — ${reason}`);
  notifyUser(dep.user_id, 'DEPOSIT_STATUS', 'Deposit Chargeback', `₹${dep.amount} was debited from your wallet due to a gateway refund/chargeback: ${reason}.`, 'deposits', dep.id);
  res.json({ message: `Chargeback recorded — ₹${dep.amount} debited from investor wallet.` });
});

// --- Trade Execution Management (Stage 11) -----------------------------------
router.get('/orders', async (req, res) => {
  const { status, side } = req.query;
  let sql = `SELECT o.*, u.mobile, u.email, i.symbol, i.name FROM orders o
             JOIN users u ON u.id = o.user_id JOIN instruments i ON i.id = o.instrument_id`;
  const conds = [], params = [];
  if (status) { conds.push('o.status = ?'); params.push(status); }
  if (side) { conds.push('o.side = ?'); params.push(side); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ` ORDER BY CASE o.status WHEN 'Pending' THEN 0 WHEN 'Executing' THEN 1 ELSE 2 END, o.id DESC LIMIT 300`;
  const rows = (await all(sql, ...params)).map((o) => {
    const q = market.getQuote(o.instrument_id);
    return { ...o, ltp: q ? q.ltp : null };
  });
  res.json({ orders: rows });
});

router.post('/orders/:id/status', async (req, res) => {
  const { action, exec_price, exec_qty, reason } = req.body || {};
  const order = await get(`SELECT o.*, i.symbol FROM orders o JOIN instruments i ON i.id = o.instrument_id WHERE o.id = ?`, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  if (action === 'executing') {
    if (order.status !== 'Pending') return res.status(409).json({ error: `Only Pending orders can move to Executing (current: ${order.status}).` });
    await run("UPDATE orders SET status = 'Executing', updated_by = ? WHERE id = ?", req.user.id, order.id);
    audit(req.user.id, 'ORDER_EXECUTING', 'orders', order.id, `${order.side} ${order.qty} ${order.symbol}`);
    notifyUser(order.user_id, 'ORDER_STATUS', 'Order Executing', `Your ${order.side} order for ${order.qty} × ${order.symbol} is being executed by the trading desk.`, 'orders', order.id);
    return res.json({ message: 'Order moved to Executing.', status: 'Executing' });
  }

  if (action === 'executed') {
    if (!['Pending', 'Executing'].includes(order.status)) return res.status(409).json({ error: `Order already ${order.status}.` });
    const px = round2(Number(exec_price));
    const qty = Number(exec_qty || order.qty);
    if (!(px > 0)) return res.status(400).json({ error: 'Enter a valid execution price.' });
    if (!Number.isInteger(qty) || qty <= 0 || qty > order.qty) return res.status(400).json({ error: `Execution quantity must be between 1 and ${order.qty}.` });
    // Sanity band on the execution price so a fat-finger fill can't debit/credit
    // a wildly wrong amount (e.g. 45× the order). Compared to the live LTP when
    // the feed is up, otherwise to the order price.
    {
      const band = await setting('price_band_pct');
      const q = market.getQuote(order.instrument_id);
      const ref = (market.feedIsLive() && q) ? q.ltp : order.price;
      const devPct = ref > 0 ? Math.abs(px - ref) / ref * 100 : 100;
      if (devPct > band) {
        return res.status(400).json({ error: `Execution price ₹${px} deviates ${devPct.toFixed(1)}% from the ${(market.feedIsLive() && q) ? 'live price' : 'order price'} ₹${ref} (allowed ±${band}%). Re-check the fill price.` });
      }
    }

    try {
      await tx(async () => {
        // Releasing this order's own reservation, is the rest of the wallet enough?
        if (order.side === 'BUY') {
          const cost = round2(qty * px);
          const w = await wallet(order.user_id);
          const availableExcl = round2(w.available + order.qty * order.price);
          if (cost > availableExcl + 0.01) throw new Error(`Investor balance insufficient for this execution (cost ₹${cost}, available ₹${availableExcl}).`);
        }
        // Shared settlement — also sets the order price equal to the execution
        // price so the two never diverge in the investor's order history.
        await settleFill(order, px, qty, req.user.id);
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    audit(req.user.id, 'ORDER_EXECUTED', 'orders', order.id, `${order.side} ${qty} ${order.symbol} @ ₹${px}`);
    notifyUser(order.user_id, 'ORDER_EXECUTED', `Order Executed ✅`,
      `Your ${order.side} order: ${qty} × ${order.symbol} executed @ ₹${px}. Portfolio and wallet updated.`, 'orders', order.id);
    return res.json({ message: `Order executed: ${qty} × ${order.symbol} @ ₹${px}.`, status: 'Executed' });
  }

  if (action === 'reject') {
    if (!['Pending', 'Executing'].includes(order.status)) return res.status(409).json({ error: `Order already ${order.status}.` });
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required (e.g. Insufficient Balance, Market Closed, Invalid Quantity).' });
    await run("UPDATE orders SET status = 'Rejected', reject_reason = ?, updated_by = ? WHERE id = ?", reason, req.user.id, order.id);
    audit(req.user.id, 'ORDER_REJECTED', 'orders', order.id, reason);
    notifyUser(order.user_id, 'ORDER_REJECTED', 'Order Rejected', `Your ${order.side} order for ${order.qty} × ${order.symbol} was rejected: ${reason}.`, 'orders', order.id);
    return res.json({ message: 'Order rejected.', status: 'Rejected' });
  }

  if (action === 'cancel') {
    if (!['Pending', 'Executing'].includes(order.status)) return res.status(409).json({ error: `Order already ${order.status}.` });
    await run("UPDATE orders SET status = 'Cancelled', updated_by = ? WHERE id = ?", req.user.id, order.id);
    audit(req.user.id, 'ORDER_CANCELLED', 'orders', order.id, reason || 'Cancelled by administrator before execution');
    notifyUser(order.user_id, 'ORDER_STATUS', 'Order Cancelled', `Your ${order.side} order for ${order.qty} × ${order.symbol} was cancelled${reason ? `: ${reason}` : ''}. No funds or holdings were affected.`, 'orders', order.id);
    return res.json({ message: 'Order cancelled.', status: 'Cancelled' });
  }

  res.status(400).json({ error: 'Unknown action. Use executing / executed / reject / cancel.' });
});

// --- Withdrawal Approval (Stage 14) ------------------------------------------
router.get('/withdrawals', async (req, res) => {
  const { status } = req.query;
  const base = `SELECT w.*, u.mobile, u.email,
    (SELECT bank_name || ' ****' || substr(account_number, -4) FROM bank_accounts WHERE user_id = w.user_id AND status = 'Approved' ORDER BY id DESC LIMIT 1) bank_display
    FROM withdrawals w JOIN users u ON u.id = w.user_id`;
  const rows = status
    ? await all(`${base} WHERE w.status = ? ORDER BY w.id DESC LIMIT 200`, status)
    : await all(`${base} ORDER BY CASE w.status WHEN 'Withdrawal Pending' THEN 0 WHEN 'Processing' THEN 1 ELSE 2 END, w.id DESC LIMIT 200`);
  res.json({ withdrawals: rows });
});

router.post('/withdrawals/:id/review', async (req, res) => {
  const { action, reason } = req.body || {};
  const wd = await get('SELECT * FROM withdrawals WHERE id = ?', req.params.id);
  if (!wd) return res.status(404).json({ error: 'Withdrawal not found.' });

  if (action === 'approve') {
    if (wd.status !== 'Withdrawal Pending') return res.status(409).json({ error: `Withdrawal already ${wd.status}.` });
    const w = await wallet(wd.user_id);
    // Rule: requested amount must not exceed Available Balance (its own reservation excluded).
    const availableExcl = round2(w.available + wd.amount);
    if (wd.amount > availableExcl + 0.01) {
      return res.status(400).json({ error: `Cannot approve: amount ₹${wd.amount} exceeds investor's available balance ₹${availableExcl}.` });
    }
    await run("UPDATE withdrawals SET status = 'Processing', processed_by = ? WHERE id = ?", req.user.id, wd.id);
    audit(req.user.id, 'WITHDRAWAL_APPROVED', 'withdrawals', wd.id, `₹${wd.amount} — moving to Processing (NEFT/RTGS)`);
    notifyUser(wd.user_id, 'WITHDRAWAL_STATUS', 'Withdrawal Processing', `Your withdrawal of ₹${wd.amount} is approved and being transferred to your bank account via NEFT/RTGS.`, 'withdrawals', wd.id);
    return res.json({ message: 'Withdrawal approved — now Processing.', status: 'Processing' });
  }
  if (action === 'complete') {
    if (wd.status !== 'Processing') return res.status(409).json({ error: `Only Processing withdrawals can be completed (current: ${wd.status}).` });
    // Re-check the balance at completion time: a chargeback or other debit could
    // have reduced the wallet since approval. Never let the balance go negative.
    const bal = (await wallet(wd.user_id)).balance;
    if (wd.amount > bal + 0.01) {
      return res.status(409).json({ error: `Cannot complete: investor wallet balance ₹${bal} is now below the withdrawal amount ₹${wd.amount} (likely a chargeback). Reject this withdrawal instead.` });
    }
    await tx(async () => {
      await creditWallet(wd.user_id, -wd.amount, 'WITHDRAWAL', 'withdrawals', wd.id, `Withdrawal completed — transferred to bank`);
      await run("UPDATE withdrawals SET status = 'Completed', processed_at = datetime('now'), processed_by = ? WHERE id = ?", req.user.id, wd.id);
    });
    audit(req.user.id, 'WITHDRAWAL_COMPLETED', 'withdrawals', wd.id, `₹${wd.amount} transferred`);
    notifyUser(wd.user_id, 'WITHDRAWAL_STATUS', 'Withdrawal Completed ✅', `₹${wd.amount} has been transferred to your approved bank account.`, 'withdrawals', wd.id);
    return res.json({ message: 'Withdrawal completed — funds transferred.', status: 'Completed' });
  }
  if (action === 'reject') {
    if (!['Withdrawal Pending', 'Processing'].includes(wd.status)) return res.status(409).json({ error: `Withdrawal already ${wd.status}.` });
    if (needReason(reason)) return res.status(400).json({ error: 'A rejection reason is required.' });
    await run("UPDATE withdrawals SET status = 'Rejected', reject_reason = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?", reason, req.user.id, wd.id);
    audit(req.user.id, 'WITHDRAWAL_REJECTED', 'withdrawals', wd.id, reason);
    notifyUser(wd.user_id, 'WITHDRAWAL_STATUS', 'Withdrawal Rejected', `Your withdrawal of ₹${wd.amount} was rejected: ${reason}. The amount remains in your wallet.`, 'withdrawals', wd.id);
    return res.json({ message: 'Withdrawal rejected — funds released back to available balance.', status: 'Rejected' });
  }
  res.status(400).json({ error: 'Unknown action. Use approve / complete / reject.' });
});

// --- Feed control & monitor (Live Market Data Integration module) ------------
router.get('/feed', async (req, res) => {
  res.json({
    health: market.publicHealth(),
    log: await all('SELECT * FROM feed_health_log ORDER BY id DESC LIMIT 50'),
  });
});

router.post('/feed/toggle', (req, res) => {
  const paused = Boolean((req.body || {}).paused);
  market.setAdminPaused(paused, req.user.email);
  audit(req.user.id, paused ? 'FEED_DISCONNECTED' : 'FEED_RECONNECTED', 'feed', null, paused ? 'Feed manually disconnected (simulation)' : 'Feed reconnected');
  res.json({ message: paused ? 'Feed disconnected — dashboard prices now flagged Delayed/Unavailable.' : 'Feed reconnected — live prices resumed.', health: market.publicHealth() });
});

// --- Settings (BPD "defined" thresholds: price band, webhook timeout, staleness) ---
router.get('/settings', async (req, res) => {
  res.json({ settings: Object.fromEntries((await all('SELECT key, value FROM settings')).map((r) => [r.key, Number(r.value)])) });
});

router.post('/settings', async (req, res) => {
  const allowed = ['price_band_pct', 'webhook_timeout_min', 'feed_stale_sec', 'min_deposit', 'min_withdrawal'];
  const updates = {};
  for (const key of allowed) {
    if (key in (req.body || {})) {
      const v = Number(req.body[key]);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: `Invalid value for ${key}.` });
      await run('UPDATE settings SET value = ? WHERE key = ?', String(v), key);
      updates[key] = v;
    }
  }
  audit(req.user.id, 'SETTINGS_UPDATED', 'settings', null, JSON.stringify(updates));
  res.json({ message: 'Settings updated.', updates });
});

// --- Payment-collection details (bank / UPI / QR shown to customers) ----------
const PAY_FIELDS = ['pay_account_name', 'pay_account_holder', 'pay_account_number', 'pay_ifsc', 'pay_bank', 'pay_branch', 'pay_upi', 'pay_note'];
router.get('/payment-settings', async (req, res) => {
  const out = {};
  for (const k of PAY_FIELDS) out[k] = await settingStr(k);
  const qr = await settingStr('pay_qr_file');
  res.json({ ...out, pay_qr_file: qr || null });
});

router.post('/payment-settings', async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const k of PAY_FIELDS) {
    if (k in body) { await setSetting(k, String(body[k] ?? '').trim()); updates[k] = body[k]; }
  }
  // Optional QR image (data URL) — stored with a shared 'payqr' prefix so any
  // logged-in customer can view it (see the files route).
  if (body.pay_qr) {
    const name = saveDataUrl(body.pay_qr, 'payqr');
    if (!name) return res.status(400).json({ error: 'Upload a valid QR image (JPG/PNG/WebP, max 8MB).' });
    await setSetting('pay_qr_file', name);
    updates.pay_qr_file = name;
  }
  if (body.pay_qr_clear) await setSetting('pay_qr_file', '');
  audit(req.user.id, 'PAYMENT_SETTINGS_UPDATED', 'settings', null, JSON.stringify(Object.keys(updates)));
  res.json({ message: 'Payment details updated — customers will now see these.' });
});

module.exports = { router };
