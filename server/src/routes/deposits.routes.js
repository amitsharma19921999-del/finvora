// Stage 7 — Fund Deposit Request: manual bank-transfer path ONLY. Customers pay
// to the company's admin-set bank / UPI / QR and upload proof — they never enter
// payment details or use any online gateway. (The webhook handler is retained but
// inert unless a real payment gateway is deliberately wired up later.)
const express = require('express');
const { run, get, all, setting, settingStr } = require('../db');
const { requireAuth } = require('../auth');
const { validators, saveDataUrl, activity, notifyAdmin, wallet, round2 } = require('../util');
const gateway = require('../gateway');

const router = express.Router();

function requireActive(req, res, next) {
  if (req.user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account is not active yet. Complete KYC and bank verification first.' });
  }
  next();
}

// --- Manual bank-transfer path ------------------------------------------------
// Company payment details (admin-editable) shown to the investor. The customer
// does NOT enter these — they just pay to them and upload proof.
router.get('/deposits/payment-details', requireAuth, requireActive, async (req, res) => {
  const qr = await settingStr('pay_qr_file');
  res.json({
    account_name: await settingStr('pay_account_name'),
    account_holder: await settingStr('pay_account_holder'),
    account_number: await settingStr('pay_account_number'),
    ifsc: await settingStr('pay_ifsc'),
    bank: [await settingStr('pay_bank'), await settingStr('pay_branch')].filter(Boolean).join(', '),
    upi_id: await settingStr('pay_upi'),
    qr_file: qr || null,
    min_deposit: await setting('min_deposit'),
    note: await settingStr('pay_note'),
  });
});

router.post('/deposits/manual', requireAuth, requireActive, async (req, res) => {
  const { amount, utr, proof } = req.body || {};
  const amt = round2(Number(amount));
  if (!validators.amount(amt) || amt < await setting('min_deposit')) {
    return res.status(400).json({ error: `Enter a valid amount (minimum ₹${await setting('min_deposit')}).` });
  }
  if (!utr || String(utr).trim().length < 6) {
    return res.status(400).json({ error: 'Enter the UTR / transaction reference number from your bank (min 6 characters).' });
  }
  // Duplicate-UTR guard: the same bank reference must not fund two deposits
  // (rejected/failed ones are excluded so a genuine resubmission still works).
  const dupeUtr = await get("SELECT id FROM deposits WHERE utr = ? AND status NOT IN ('Deposit Rejected','Deposit Failed')", String(utr).trim());
  if (dupeUtr) return res.status(409).json({ error: 'This UTR / reference number has already been submitted on another deposit.' });
  const proofFile = saveDataUrl(proof, `u${req.user.id}-deposit-proof`);
  if (!proofFile) return res.status(400).json({ error: 'Upload a valid payment proof (image or PDF, max 8MB).' });

  const r = await run("INSERT INTO deposits (user_id, method, amount, utr, proof_file, status) VALUES (?,?,?,?,?,'Deposit Pending')",
    req.user.id, 'MANUAL', amt, String(utr).trim(), proofFile);
  activity(req.user.id, 'DEPOSIT_REQUESTED', `Manual deposit #${r.lastInsertRowid} of ₹${amt} (UTR ${utr})`);
  notifyAdmin('DEPOSIT_REQUEST', 'New Deposit Request',
    `${req.user.mobile} requested a manual deposit of ₹${amt} (UTR ${utr}). Verification pending.`, 'deposits', r.lastInsertRowid);
  res.json({ message: 'Deposit request submitted. Status: Deposit Pending — it will be verified by our team.', id: r.lastInsertRowid, status: 'Deposit Pending' });
});

router.get('/deposits/mine', requireAuth, async (req, res) => {
  const rows = await all('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  res.json({ deposits: rows, wallet: await wallet(req.user.id) });
});

module.exports = { router };

// --- Webhook endpoints (mounted separately with raw-body access) -------------
// POST /api/gateway/webhook          (mock PSP,   header: x-gateway-signature)
// POST /api/gateway/webhook/razorpay (Razorpay,   header: x-razorpay-signature)
module.exports.webhookHandler = (provider) => async (req, res) => {
  const signature = provider === 'razorpay' ? req.headers['x-razorpay-signature'] : req.headers['x-gateway-signature'];
  const out = await gateway.processWebhook({ rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body || {})), signature: String(signature || ''), provider });
  res.status(out.status).json(out.body);
};
