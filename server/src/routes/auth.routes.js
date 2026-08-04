// Stages 2-3 & 6 — Registration (OTP-verified), Login, account summary.
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { run, get, scryptHash } = require('../db');
const { verifyPassword, signToken, requireAuth } = require('../auth');
const { validators, activity, wallet, notifyAdmin, notifyUser } = require('../util');

const router = express.Router();

async function issueOtp(mobile, purpose = 'register') {
  const code = String(crypto.randomInt(100000, 999999));
  await run("INSERT INTO otps (mobile, code, purpose, expires_at) VALUES (?,?,?,datetime('now','+10 minutes'))", mobile, code, purpose);
  if (config.smsMode === 'twilio' && config.twilio.sid) {
    // Real SMS via Twilio REST API (free trial credits) — fire and forget.
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: `+91${mobile}`, From: config.twilio.from, Body: `${code} is your Finvora verification OTP. Valid for 10 minutes.` }),
    }).catch((e) => console.error('[sms] twilio send failed:', e.message));
    return { sent: true };
  }
  console.log(`[otp] DEMO MODE — OTP for ${mobile}: ${code}`);
  return { sent: true, demo_otp: code }; // demo mode: shown on screen (free, no SMS provider)
}

// Stage 2 — Registration: Mobile, Email, Password -> OTP verification.
router.post('/register', async (req, res) => {
  const { mobile, email, password } = req.body || {};
  if (!validators.mobile(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  if (!validators.email(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers.' });
  }
  const emailNorm = String(email).toLowerCase().trim();
  const existingMobile = await get('SELECT * FROM users WHERE mobile = ?', mobile);
  const existingEmail = await get('SELECT * FROM users WHERE email = ?', emailNorm);
  if ((existingMobile && existingMobile.status !== 'OTP Pending') || (existingEmail && existingEmail.status !== 'OTP Pending')) {
    return res.status(409).json({ error: 'An account with this mobile or email already exists. Please login.' });
  }
  // Re-registration over an unverified attempt is allowed. Delete the dependent
  // wallet row first — wallets.user_id is a FK with no ON DELETE CASCADE, so
  // deleting the user directly would throw a FK-constraint error.
  const purge = async (id) => { await run('DELETE FROM wallets WHERE user_id = ?', id); await run('DELETE FROM users WHERE id = ?', id); };
  if (existingMobile) await purge(existingMobile.id);
  if (existingEmail && (!existingMobile || existingEmail.id !== existingMobile.id)) await purge(existingEmail.id);

  const r = await run("INSERT INTO users (mobile, email, password_hash, role, status) VALUES (?,?,?,'investor','OTP Pending')",
    mobile, emailNorm, scryptHash(password));
  await run('INSERT INTO wallets (user_id, balance) VALUES (?, 0)', r.lastInsertRowid);
  activity(r.lastInsertRowid, 'REGISTER_INITIATED', `Registration started for ${mobile}`);
  const otp = await issueOtp(mobile);
  res.json({ message: 'OTP sent to your mobile number.', mobile, ...(otp.demo_otp ? { demo_otp: otp.demo_otp, demo_mode: true } : {}) });
});

// Stage 2 — OTP verification completes registration => status "Registered".
router.post('/verify-otp', async (req, res) => {
  const { mobile, code } = req.body || {};
  const user = await get("SELECT * FROM users WHERE mobile = ? AND status = 'OTP Pending'", mobile);
  if (!user) return res.status(400).json({ error: 'No pending registration found for this mobile number.' });
  const otp = await get("SELECT * FROM otps WHERE mobile = ? AND code = ? AND consumed = 0 AND expires_at > datetime('now') ORDER BY id DESC", mobile, String(code || '').trim());
  if (!otp) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
  await run('UPDATE otps SET consumed = 1 WHERE id = ?', otp.id);
  await run("UPDATE users SET status = 'Registered' WHERE id = ?", user.id);
  activity(user.id, 'REGISTERED', 'Mobile verified via OTP — account created');
  const token = signToken({ uid: user.id, role: user.role });
  res.json({ message: 'Account created successfully.', token, user: { id: user.id, mobile: user.mobile, email: user.email, role: user.role, status: 'Registered' } });
});

router.post('/resend-otp', async (req, res) => {
  const { mobile } = req.body || {};
  const user = await get("SELECT * FROM users WHERE mobile = ? AND status = 'OTP Pending'", mobile);
  if (!user) return res.status(400).json({ error: 'No pending registration found for this mobile number.' });
  const otp = await issueOtp(mobile);
  res.json({ message: 'OTP re-sent.', ...(otp.demo_otp ? { demo_otp: otp.demo_otp, demo_mode: true } : {}) });
});

// Stage 3 — Login with registered credentials (mobile or email + password).
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  const id = String(identifier || '').toLowerCase().trim();
  const user = await get('SELECT * FROM users WHERE mobile = ? OR email = ?', id, id);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials. Check your mobile/email and password.' });
  }
  if (user.status === 'OTP Pending') {
    const otp = await issueOtp(user.mobile);
    return res.status(403).json({ error: 'Mobile number not verified yet. Enter the OTP to continue.', need_otp: true, mobile: user.mobile, ...(otp.demo_otp ? { demo_otp: otp.demo_otp, demo_mode: true } : {}) });
  }
  if (user.status === 'Suspended') return res.status(403).json({ error: 'Your account is suspended. Please contact support.' });
  activity(user.id, 'LOGIN', `${user.role} logged in`);
  const token = signToken({ uid: user.id, role: user.role });
  res.json({ token, user: { id: user.id, mobile: user.mobile, email: user.email, role: user.role, status: user.status } });
});

// --- Forgot password (admin-gated) -------------------------------------------
// The investor raises a request; an administrator must approve it before any new
// password can be set. Approval issues a one-time code (see admin routes).
router.post('/forgot-password', async (req, res) => {
  const { identifier, note } = req.body || {};
  const id = String(identifier || '').toLowerCase().trim();
  // Always answer identically so this endpoint can't be used to discover which
  // mobiles/emails have accounts.
  const generic = {
    message: 'If that account exists, your request has been sent to our team. You will be notified once it is approved.',
  };
  if (!id) return res.json(generic);
  const user = await get('SELECT * FROM users WHERE mobile = ? OR email = ?', id, id);
  if (!user || user.role !== 'investor') return res.json(generic);

  const open = await get("SELECT id FROM password_resets WHERE user_id = ? AND status IN ('Pending','Approved')", user.id);
  if (!open) {
    const r = await run('INSERT INTO password_resets (user_id, note) VALUES (?,?)',
      user.id, String(note || '').trim().slice(0, 300) || null);
    activity(user.id, 'PASSWORD_RESET_REQUESTED', 'Investor requested a password reset');
    notifyAdmin('PASSWORD_RESET', 'Password Reset Requested',
      `${user.mobile} (${user.email}) requested a password reset — approve it to let them set a new password.`,
      'password_resets', r.lastInsertRowid);
  }
  res.json(generic);
});

// Complete the reset: requires an APPROVED request that hasn't expired, plus the
// one-time code issued when the admin approved it.
router.post('/reset-password', async (req, res) => {
  const { mobile, code, password } = req.body || {};
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers.' });
  }
  const user = await get('SELECT * FROM users WHERE mobile = ?', String(mobile || '').trim());
  if (!user) return res.status(400).json({ error: 'Invalid reset request.' });
  const pr = await get(
    "SELECT * FROM password_resets WHERE user_id = ? AND status = 'Approved' AND approved_until > datetime('now') ORDER BY id DESC",
    user.id);
  if (!pr) {
    return res.status(403).json({ error: 'No approved reset request found (or it expired). Please request a password reset and wait for approval.' });
  }
  const otp = await get(
    "SELECT * FROM otps WHERE mobile = ? AND code = ? AND purpose = 'reset' AND consumed = 0 AND expires_at > datetime('now') ORDER BY id DESC",
    user.mobile, String(code || '').trim());
  if (!otp) return res.status(400).json({ error: 'Invalid or expired one-time code.' });

  await run('UPDATE otps SET consumed = 1 WHERE id = ?', otp.id);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', scryptHash(password), user.id);
  await run("UPDATE password_resets SET status = 'Used', used_at = datetime('now') WHERE id = ?", pr.id);
  activity(user.id, 'PASSWORD_RESET', 'Password changed via an approved reset request');
  notifyUser(user.id, 'PASSWORD_CHANGED', 'Password Changed',
    'Your Finvora password was just changed. If this was not you, contact support immediately.');
  res.json({ message: 'Password updated. You can now log in with your new password.' });
});

// Onboarding & account summary — drives the investor onboarding dashboard.
router.get('/me', requireAuth, async (req, res) => {
  const kyc = await get('SELECT id, status, reject_reason, submitted_at, reviewed_at FROM kyc WHERE user_id = ? ORDER BY id DESC', req.user.id);
  const bank = await get('SELECT id, status, reject_reason, holder_name, bank_name, account_number, ifsc, submitted_at FROM bank_accounts WHERE user_id = ? ORDER BY id DESC', req.user.id);
  res.json({
    user: req.user,
    kyc: kyc || null,
    bank: bank || null,
    wallet: await wallet(req.user.id),
    onboarding: {
      registered: true,
      kyc_status: kyc ? kyc.status : 'Not Submitted',
      bank_status: bank ? bank.status : 'Not Submitted',
      account_status: req.user.status, // Registered -> Active once both approved (Stage 6)
    },
  });
});

module.exports = { router, issueOtp };
