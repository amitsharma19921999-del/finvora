// Stages 4-5 — KYC Submission & Bank Account Submission (investor side).
// Lifecycles: Submitted -> Under Review -> Approved | Rejected (resubmission allowed after rejection).
const express = require('express');
const { run, get } = require('../db');
const { requireAuth } = require('../auth');
const { validators, saveDataUrl, activity, notifyAdmin } = require('../util');

const router = express.Router();

router.post('/kyc', requireAuth, async (req, res) => {
  const { full_name, dob, address, pan, aadhaar, photo, id_doc } = req.body || {};
  const existing = await get("SELECT * FROM kyc WHERE user_id = ? AND status IN ('Submitted','Under Review','Approved') ORDER BY id DESC", req.user.id);
  if (existing) return res.status(409).json({ error: `KYC already ${existing.status === 'Approved' ? 'approved' : 'submitted and awaiting review'}.` });

  if (!full_name || String(full_name).trim().length < 3) return res.status(400).json({ error: 'Enter your full name as per PAN.' });
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 86400000);
  if (!(age >= 18 && age < 120)) return res.status(400).json({ error: 'You must be at least 18 years old to invest.' });
  if (!address || String(address).trim().length < 10) return res.status(400).json({ error: 'Enter your complete address.' });
  if (!validators.pan(pan)) return res.status(400).json({ error: 'Invalid PAN format. Expected format: ABCDE1234F.' });
  if (!validators.aadhaar(aadhaar)) return res.status(400).json({ error: 'Invalid Aadhaar number. Enter the 12-digit number.' });

  const photoFile = saveDataUrl(photo, `u${req.user.id}-kyc-photo`);
  const idDocFile = saveDataUrl(id_doc, `u${req.user.id}-kyc-iddoc`);
  if (!photoFile) return res.status(400).json({ error: 'Upload a valid photograph (JPG/PNG/WebP, max 8MB).' });
  if (!idDocFile) return res.status(400).json({ error: 'Upload a valid identity document (image or PDF, max 8MB).' });

  const r = await run(
    `INSERT INTO kyc (user_id, full_name, dob, address, pan, aadhaar, photo_file, id_doc_file, status)
     VALUES (?,?,?,?,?,?,?,?,'Submitted')`,
    req.user.id, String(full_name).trim(), dob, String(address).trim(),
    String(pan).toUpperCase(), String(aadhaar).replace(/\s/g, ''), photoFile, idDocFile
  );
  activity(req.user.id, 'KYC_SUBMITTED', `KYC #${r.lastInsertRowid} submitted`);
  notifyAdmin('KYC_SUBMITTED', 'New KYC Submission', `${full_name} (${req.user.mobile}) submitted KYC documents.`, 'kyc', r.lastInsertRowid);
  res.json({ message: 'KYC submitted. Status: Submitted — our team will review it shortly.', id: r.lastInsertRowid, status: 'Submitted' });
});

router.get('/kyc/mine', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM kyc WHERE user_id = ? ORDER BY id DESC', req.user.id);
  res.json({ kyc: row || null });
});

router.post('/bank', requireAuth, async (req, res) => {
  const { holder_name, account_number, ifsc, bank_name, branch, proof } = req.body || {};
  const existing = await get("SELECT * FROM bank_accounts WHERE user_id = ? AND status IN ('Submitted','Under Review','Approved') ORDER BY id DESC", req.user.id);
  if (existing) return res.status(409).json({ error: `Bank details already ${existing.status === 'Approved' ? 'approved' : 'submitted and awaiting review'}.` });

  if (!holder_name || String(holder_name).trim().length < 3) return res.status(400).json({ error: 'Enter the account holder name.' });
  if (!validators.accountNumber(account_number)) return res.status(400).json({ error: 'Invalid account number (9-18 digits expected).' });
  if (!validators.ifsc(ifsc)) return res.status(400).json({ error: 'Invalid IFSC code. Expected format: HDFC0001234.' });
  if (!bank_name || !branch) return res.status(400).json({ error: 'Enter the bank name and branch.' });

  const proofFile = saveDataUrl(proof, `u${req.user.id}-bank-proof`);
  if (!proofFile) return res.status(400).json({ error: 'Upload a cancelled cheque or bank proof (image or PDF, max 8MB).' });

  const r = await run(
    `INSERT INTO bank_accounts (user_id, holder_name, account_number, ifsc, bank_name, branch, proof_file, status)
     VALUES (?,?,?,?,?,?,?,'Submitted')`,
    req.user.id, String(holder_name).trim(), String(account_number).replace(/\s/g, ''),
    String(ifsc).toUpperCase(), String(bank_name).trim(), String(branch).trim(), proofFile
  );
  activity(req.user.id, 'BANK_SUBMITTED', `Bank account #${r.lastInsertRowid} submitted`);
  notifyAdmin('BANK_SUBMITTED', 'New Bank Details Submission', `${holder_name} (${req.user.mobile}) submitted bank details for verification.`, 'bank_accounts', r.lastInsertRowid);
  res.json({ message: 'Bank details submitted. Status: Submitted — verification in progress.', id: r.lastInsertRowid, status: 'Submitted' });
});

router.get('/bank/mine', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY id DESC', req.user.id);
  res.json({ bank: row || null });
});

module.exports = { router };
