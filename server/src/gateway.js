// Payment Gateway Integration (BPD Stages 7-8, Sections 8-11).
// GATEWAY_MODE=mock     — built-in simulator (free): real signed webhooks, dedup,
//                         amount-match auto-approval, delayed-webhook & mismatch
//                         scenarios, settlement ledger for reconciliation.
// GATEWAY_MODE=razorpay — Razorpay test mode (free keys): order creation via REST
//                         API + x-razorpay-signature webhook verification.
const crypto = require('crypto');
const config = require('./config');
const { run, get, tx, setting } = require('./db');
const { creditWallet, notifyAdmin, notifyUser, round2 } = require('./util');

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function signPayload(rawBody) {
  return hmacHex(config.gatewayWebhookSecret, rawBody);
}

// --- Webhook processing — the single verification path for gateway deposits ---
// Rules (BPD Section 8/9): signature must be valid AND amount must exactly match
// the initiated amount for auto-approval; any mismatch routes to manual review;
// duplicate transaction IDs are ignored (Section 10).
async function processWebhook({ rawBody, signature, provider }) {
  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch { return { status: 400, body: { error: 'Invalid JSON payload' } }; }

  const secret = provider === 'razorpay' ? config.razorpay.webhookSecret : config.gatewayWebhookSecret;
  const expected = hmacHex(secret, rawBody);
  // Compare BYTE lengths (timingSafeEqual works on buffers) — a JS string-length
  // check can pass for a multibyte header value while the byte lengths differ.
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature || '');
  const sigValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  // Normalize mock vs razorpay payload shapes.
  let event, txnId, orderId, amount;
  if (provider === 'razorpay') {
    event = payload.event; // payment.captured | payment.failed
    const p = payload.payload?.payment?.entity || {};
    txnId = p.id; orderId = p.order_id; amount = round2((p.amount || 0) / 100);
  } else {
    event = payload.event; txnId = payload.txn_id; orderId = payload.order_id; amount = round2(payload.amount || 0);
  }
  if (!txnId || !orderId) return { status: 400, body: { error: 'Missing transaction/order id' } };

  if (!sigValid) {
    notifyAdmin('GATEWAY_MISMATCH', 'Gateway webhook signature invalid',
      `Webhook for order ${orderId} (txn ${txnId}) failed signature verification — possible tampering. Held for manual review.`, 'deposits', null);
    const dep = await get('SELECT * FROM deposits WHERE gateway_order_id = ?', orderId);
    if (dep && !['Deposit Approved (Auto)', 'Deposit Approved', 'Deposit Failed'].includes(dep.status)) {
      await run("UPDATE deposits SET needs_review = 1, review_note = 'Webhook signature invalid — manual review required' WHERE id = ?", dep.id);
    }
    return { status: 400, body: { error: 'Invalid signature' } };
  }

  const dep = await get('SELECT * FROM deposits WHERE gateway_order_id = ?', orderId);
  const insertEvent = async () => await run('INSERT INTO gateway_events (txn_id, order_id, payload, signature_valid) VALUES (?,?,?,1)', txnId, orderId, rawBody.toString());
  const isDuplicate = (e) => /UNIQUE|constraint/i.test(e.message);

  // No matching deposit, or already finalized: record the event (for settlement
  // reconciliation), deduped, with no wallet effect.
  if (!dep || ['Deposit Approved (Auto)', 'Deposit Approved', 'Deposit Failed', 'Deposit Rejected'].includes(dep.status)) {
    try { await insertEvent(); } catch (e) {
      if (isDuplicate(e)) return { status: 200, body: { message: 'Duplicate webhook ignored (already processed).' } };
      throw e;
    }
    return { status: 200, body: { message: dep ? 'Deposit already finalized.' : 'No matching deposit on platform — recorded for settlement reconciliation.' } };
  }

  // Dedup insert + deposit effect must be atomic: on any failure the whole
  // transaction rolls back (dedup row included) so the PSP's retry reprocesses,
  // rather than leaving the event deduped but the wallet uncredited.
  let outcome;
  try {
    outcome = await tx(async () => {
      await insertEvent(); // throws UNIQUE on a duplicate webhook -> rolls back
      if (event === 'payment.failed') {
        await run("UPDATE deposits SET status = 'Deposit Failed', gateway_txn_id = ?, gateway_amount = ?, verified_at = datetime('now') WHERE id = ?", txnId, amount, dep.id);
        return 'failed';
      }
      if (Math.abs(amount - dep.amount) < 0.01) { // payment.captured, amount matches
        await run("UPDATE deposits SET status = 'Deposit Approved (Auto)', gateway_txn_id = ?, gateway_amount = ?, needs_review = 0, verified_at = datetime('now') WHERE id = ?", txnId, amount, dep.id);
        await creditWallet(dep.user_id, dep.amount, 'DEPOSIT', 'deposits', dep.id, `Online deposit auto-verified (gateway txn ${txnId})`);
        return 'approved';
      }
      await run("UPDATE deposits SET gateway_txn_id = ?, gateway_amount = ?, needs_review = 1, review_note = ? WHERE id = ?",
        txnId, amount, `Amount mismatch: initiated ₹${dep.amount}, gateway captured ₹${amount} — manual reconciliation required`, dep.id);
      return 'mismatch';
    });
  } catch (e) {
    if (isDuplicate(e)) return { status: 200, body: { message: 'Duplicate webhook ignored (already processed).' } };
    console.error('[gateway] webhook processing failed and rolled back:', e.message);
    return { status: 500, body: { error: 'Temporary error processing webhook — please retry.' } };
  }

  // Notifications after the transaction commits.
  if (outcome === 'failed') {
    notifyUser(dep.user_id, 'DEPOSIT_FAILED', 'Deposit Failed',
      `Your online payment of ₹${dep.amount} failed at the gateway. Please retry, or use the manual bank-transfer option.`, 'deposits', dep.id);
    notifyAdmin('GATEWAY_PAYMENT_FAILED', 'Gateway Payment Failed',
      `Online payment failed for deposit #${dep.id} (₹${dep.amount}, order ${orderId}).`, 'deposits', dep.id);
    return { status: 200, body: { message: 'Payment failure recorded.' } };
  }
  if (outcome === 'approved') {
    notifyUser(dep.user_id, 'DEPOSIT_APPROVED', 'Deposit Approved (Auto)',
      `₹${dep.amount} has been credited to your trading wallet. Payment verified automatically via the payment gateway.`, 'deposits', dep.id);
    notifyAdmin('DEPOSIT_AUTO_APPROVED', 'Gateway Deposit Auto-Approved',
      `Deposit #${dep.id} of ₹${dep.amount} auto-verified via webhook (txn ${txnId}).`, 'deposits', dep.id);
    return { status: 200, body: { message: 'Deposit auto-approved.' } };
  }
  // Amount mismatch => held for manual review + reconciliation (BPD Section 8).
  notifyAdmin('GATEWAY_MISMATCH', 'Gateway Amount Mismatch — Manual Review',
    `Deposit #${dep.id}: initiated ₹${dep.amount} but gateway captured ₹${amount}. Reconcile against the settlement report.`, 'deposits', dep.id);
  return { status: 200, body: { message: 'Amount mismatch — routed to manual review.' } };
}

// --- Mock gateway: simulates the PSP capturing a payment, then firing the
// signed webhook back at our own endpoint-processing code path.
async function mockCapture(deposit, { instrument = 'UPI', scenario = 'success' }) {
  const txnId = `PAY${Date.now()}${crypto.randomInt(100, 999)}`;
  const failed = scenario === 'fail';
  const capturedAmount = scenario === 'mismatch' ? round2(deposit.amount + 500) : deposit.amount;

  await run('INSERT INTO mock_gateway_payments (txn_id, order_id, amount, method, status, webhook_sent) VALUES (?,?,?,?,?,?)',
    txnId, deposit.gateway_order_id, capturedAmount, instrument, failed ? 'failed' : 'captured', scenario === 'delay' ? 0 : 1);

  // Payment left the investor's hands => Gateway Confirmation Pending (lifecycle Stage 7).
  await run("UPDATE deposits SET status = 'Gateway Confirmation Pending' WHERE id = ?", deposit.id);

  if (scenario === 'delay') return { txnId, webhook: 'delayed' }; // webhook never arrives -> reconciliation path

  const body = JSON.stringify({
    event: failed ? 'payment.failed' : 'payment.captured',
    txn_id: txnId, order_id: deposit.gateway_order_id, amount: capturedAmount,
    method: instrument, captured_at: new Date().toISOString(),
  });
  const raw = Buffer.from(body);
  // Deliver the webhook asynchronously like a real PSP (~1.2s later).
  setTimeout(() => {
    try { processWebhook({ rawBody: raw, signature: signPayload(raw), provider: 'mock' }); }
    catch (e) { console.error('[gateway] mock webhook delivery failed:', e.message); }
  }, 1200);
  return { txnId, webhook: 'scheduled' };
}

// --- Razorpay adapter (test mode — free) -------------------------------------
async function razorpayCreateOrder(amountInr, receipt) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amountInr * 100), currency: 'INR', receipt }),
  });
  if (!r.ok) throw new Error(`Razorpay order creation failed (${r.status}): ${await r.text()}`);
  return r.json();
}

// --- Webhook-timeout watchdog (BPD Section 8): deposits stuck at
// "Gateway Confirmation Pending" beyond the timeout get flagged for
// reconciliation against the settlement report.
function startWatchdog() {
  setInterval(async () => {
    try {
      const timeoutMin = await setting('webhook_timeout_min');
      // Flag both 'Gateway Confirmation Pending' (webhook lost after capture) and
      // 'Payment Initiated' (investor may have paid but never returned to the app,
      // so no webhook/return advanced the status) for reconciliation.
      const stuck = await require('./db').all(
        `SELECT * FROM deposits WHERE method = 'GATEWAY' AND needs_review = 0
         AND status IN ('Gateway Confirmation Pending','Payment Initiated')
         AND created_at < datetime('now', ?)`, `-${timeoutMin} minutes`);
      for (const dep of stuck) {
        await run("UPDATE deposits SET needs_review = 1, review_note = 'Webhook not received within timeout — reconcile against gateway settlement report' WHERE id = ?", dep.id);
        notifyAdmin('GATEWAY_MISMATCH', 'Gateway Webhook Timeout — Reconciliation Needed',
          `Deposit #${dep.id} (₹${dep.amount}) has no webhook confirmation after ${timeoutMin} min. Check the settlement report.`, 'deposits', dep.id);
      }
    } catch (e) { console.error('[gateway] watchdog error:', e.message); }
  }, 60000).unref();
}

module.exports = { processWebhook, mockCapture, razorpayCreateOrder, startWatchdog, signPayload };
