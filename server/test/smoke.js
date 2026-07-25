// End-to-end API smoke test — drives the complete BPD v2.1 journey:
// register → OTP → KYC → bank → approvals → activation → deposits (gateway
// auto-webhook + manual) → orders (band check, auto-reject, cancel, execute)
// → portfolio → withdrawal lifecycle → reports. Run: node test/smoke.js
const BASE = process.env.BASE || 'http://localhost:4000';
let passed = 0, failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mobile = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const email = `smoke${Date.now()}@test.local`;

  console.log('\n— Stage 2: Registration + OTP —');
  let r = await call('POST', '/api/auth/register', { mobile, email, password: 'Invest@123' });
  check('register returns demo OTP', r.status === 200 && r.data.demo_otp, JSON.stringify(r.data));
  r = await call('POST', '/api/auth/verify-otp', { mobile, code: '000000' });
  check('wrong OTP rejected', r.status === 400);
  r = await call('POST', '/api/auth/resend-otp', { mobile });
  const otp = r.data.demo_otp;
  r = await call('POST', '/api/auth/verify-otp', { mobile, code: otp });
  check('OTP verify creates account (Registered)', r.status === 200 && r.data.user.status === 'Registered');
  const inv = r.data.token;

  console.log('— Stage 3: Login —');
  r = await call('POST', '/api/auth/login', { identifier: mobile, password: 'wrong' });
  check('bad password rejected', r.status === 401);
  r = await call('POST', '/api/auth/login', { identifier: email, password: 'Invest@123' });
  check('login by email works', r.status === 200);
  r = await call('POST', '/api/auth/login', { identifier: '9999999999', password: 'Admin@123' });
  const adm = r.data.token;
  check('admin login', r.status === 200 && r.data.user.role === 'admin');

  console.log('— Gate: trading blocked before activation —');
  r = await call('POST', '/api/orders', { instrument_id: 1, side: 'BUY', qty: 1, price: 100 }, inv);
  check('order blocked before Active', r.status === 403);
  r = await call('POST', '/api/deposits/manual', { amount: 1000, utr: 'UTR123456', proof: TINY_PNG }, inv);
  check('deposit blocked before Active', r.status === 403);

  console.log('— Stage 4: KYC —');
  r = await call('POST', '/api/kyc', { full_name: 'Smoke Tester', dob: '1990-01-01', address: '221B Baker Street, Mumbai 400001', pan: 'ABCDE1234F', aadhaar: '234567890123', photo: TINY_PNG, id_doc: TINY_PNG }, inv);
  check('KYC submitted', r.status === 200, JSON.stringify(r.data));
  r = await call('POST', '/api/kyc', { full_name: 'Dup', dob: '1990-01-01', address: 'x'.repeat(12), pan: 'ABCDE1234F', aadhaar: '234567890123', photo: TINY_PNG, id_doc: TINY_PNG }, inv);
  check('duplicate KYC blocked', r.status === 409);
  let q = await call('GET', '/api/admin/kyc?status=Submitted', null, adm);
  const kycId = q.data.kyc.find((k) => k.mobile === mobile).id;
  r = await call('POST', `/api/admin/kyc/${kycId}/review`, { action: 'reject' }, adm);
  check('reject without reason blocked', r.status === 400);
  r = await call('POST', `/api/admin/kyc/${kycId}/review`, { action: 'under_review' }, adm);
  check('KYC → Under Review', r.status === 200);
  r = await call('POST', `/api/admin/kyc/${kycId}/review`, { action: 'approve' }, adm);
  check('KYC → Approved', r.status === 200);

  console.log('— Stage 5: Bank —');
  r = await call('POST', '/api/bank', { holder_name: 'Smoke Tester', account_number: '123456789012', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank', branch: 'Fort', proof: TINY_PNG }, inv);
  check('bank submitted', r.status === 200, JSON.stringify(r.data));
  q = await call('GET', '/api/admin/bank?status=Submitted', null, adm);
  const bankId = q.data.bank.find((b) => b.mobile === mobile).id;
  r = await call('POST', `/api/admin/bank/${bankId}/review`, { action: 'approve' }, adm);
  check('bank approved + activation message', r.status === 200 && /activated/i.test(r.data.message), r.data.message);

  console.log('— Stage 6: Activation —');
  r = await call('GET', '/api/auth/me', null, inv);
  check('account Active after both approvals', r.data.user.status === 'Active');

  console.log('— Stage 7/8: Gateway deposit (auto-verify via signed webhook) —');
  r = await call('POST', '/api/deposits/gateway/initiate', { amount: 100000 }, inv);
  check('gateway initiate', r.status === 200 && r.data.order_id, JSON.stringify(r.data));
  const orderRef = r.data.order_id;
  r = await call('POST', '/api/gateway/mock/pay', { order_id: orderRef, instrument: 'UPI', scenario: 'success' }, inv);
  check('mock pay accepted', r.status === 200);
  await sleep(2200); // webhook fires after ~1.2s
  r = await call('GET', '/api/deposits/mine', null, inv);
  const gwDep = r.data.deposits.find((d) => d.gateway_order_id === orderRef);
  check('deposit auto-approved via webhook', gwDep.status === 'Deposit Approved (Auto)', gwDep.status);
  check('wallet credited ₹100000', r.data.wallet.balance === 100000, String(r.data.wallet.balance));

  console.log('— duplicate webhook + amount mismatch scenarios —');
  r = await call('POST', '/api/deposits/gateway/initiate', { amount: 5000 }, inv);
  const mmOrder = r.data.order_id;
  await call('POST', '/api/gateway/mock/pay', { order_id: mmOrder, scenario: 'mismatch' }, inv);
  await sleep(2000);
  r = await call('GET', '/api/deposits/mine', null, inv);
  const mmDep = r.data.deposits.find((d) => d.gateway_order_id === mmOrder);
  check('mismatch held for review (not credited)', mmDep.needs_review === 1 && mmDep.status === 'Gateway Confirmation Pending', `${mmDep.status}/${mmDep.needs_review}`);
  r = await call('POST', `/api/admin/deposits/${mmDep.id}/reconcile`, {}, adm);
  check('reconcile returns settlement record', r.data.settlement && r.data.settlement.amount === 5500, JSON.stringify(r.data.settlement));
  r = await call('POST', `/api/admin/deposits/${mmDep.id}/reconcile`, { decision: 'fail' }, adm);
  check('reconcile decision fail', r.status === 200);

  console.log('— Stage 7/8: Manual deposit path —');
  const uniqueUtr = 'UTR' + mobile + Math.floor(Number(String(email).replace(/\D/g, '').slice(-6)) || 100000);
  r = await call('POST', '/api/deposits/manual', { amount: 50000, utr: uniqueUtr, proof: TINY_PNG }, inv);
  const manId = r.data.id;
  check('manual deposit created', r.status === 200 && r.data.status === 'Deposit Pending');
  r = await call('POST', `/api/admin/deposits/${manId}/review`, { action: 'approve' }, adm);
  check('approve before verification blocked', r.status === 409);
  await call('POST', `/api/admin/deposits/${manId}/review`, { action: 'under_verification' }, adm);
  r = await call('POST', `/api/admin/deposits/${manId}/review`, { action: 'approve' }, adm);
  check('manual deposit approved', r.status === 200);
  r = await call('GET', '/api/deposits/mine', null, inv);
  check('wallet = ₹150000', r.data.wallet.balance === 150000, String(r.data.wallet.balance));

  console.log('— Stage 9/10: Orders —');
  r = await call('GET', '/api/market/snapshot', null, inv);
  const quote = r.data.quotes[0];
  check('snapshot has live quotes + health', r.data.quotes.length >= 10 && r.data.health.status === 'LIVE');
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'BUY', qty: 1, price: Math.round(quote.ltp * 1.5) }, inv);
  check('price outside band rejected (400)', r.status === 400 && r.data.band_pct, JSON.stringify(r.data));
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'BUY', qty: 100000, price: quote.ltp }, inv);
  check('insufficient balance → auto-Rejected order recorded', r.status === 200 && r.data.auto_rejected && r.data.order.status === 'Rejected', JSON.stringify(r.data.order?.status));
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'SELL', qty: 5, price: quote.ltp }, inv);
  check('sell without holdings → auto-Rejected', r.data.auto_rejected === true);

  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'BUY', qty: 10, price: quote.ltp }, inv);
  check('buy order Pending', r.status === 200 && r.data.order.status === 'Pending', JSON.stringify(r.data));
  const buyId = r.data.order.id;
  r = await call('GET', '/api/auth/me', null, inv);
  check('funds reserved for open buy', r.data.wallet.available < 150000, String(r.data.wallet.available));

  // investor cancels a second pending order
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'BUY', qty: 1, price: quote.ltp }, inv);
  const cancelId = r.data.order.id;
  r = await call('POST', `/api/orders/${cancelId}/cancel`, {}, inv);
  check('investor cancels Pending order', r.status === 200);

  console.log('— Stage 11: Trade Execution Management —');
  r = await call('POST', `/api/admin/orders/${buyId}/status`, { action: 'executing' }, adm);
  check('order → Executing', r.status === 200);
  r = await call('POST', `/api/orders/${buyId}/cancel`, {}, inv);
  check('investor cannot cancel Executing order', r.status === 409);
  const execPx = Math.round(quote.ltp * 100) / 100;
  r = await call('POST', `/api/admin/orders/${buyId}/status`, { action: 'executed', exec_price: execPx }, adm);
  check('order Executed', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', '/api/portfolio', null, inv);
  check('holdings updated (10 qty)', r.data.holdings.length === 1 && r.data.holdings[0].qty === 10, JSON.stringify(r.data.holdings));

  console.log('— Stage 12: Sell order —');
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'SELL', qty: 4, price: quote.ltp }, inv);
  const sellId = r.data.order.id;
  check('sell order Pending', r.data.order.status === 'Pending');
  r = await call('POST', `/api/admin/orders/${sellId}/status`, { action: 'executed', exec_price: execPx + 10 }, adm);
  check('sell Executed with P&L', r.status === 200);
  r = await call('GET', '/api/portfolio', null, inv);
  check('holdings reduced to 6', r.data.holdings[0].qty === 6, JSON.stringify(r.data.holdings.map(h => h.qty)));
  check('realized P&L recorded', r.data.totals.realized_pnl !== 0, String(r.data.totals.realized_pnl));

  console.log('— Stages 13/14: Withdrawal —');
  r = await call('GET', '/api/auth/me', null, inv);
  const avail = r.data.wallet.available;
  r = await call('POST', '/api/withdrawals', { amount: avail + 1000 }, inv);
  check('over-available withdrawal blocked', r.status === 400);
  r = await call('POST', '/api/withdrawals', { amount: 20000 }, inv);
  const wdId = r.data.id;
  check('withdrawal Pending', r.status === 200 && r.data.status === 'Withdrawal Pending');
  r = await call('POST', `/api/admin/withdrawals/${wdId}/review`, { action: 'complete' }, adm);
  check('complete before approve blocked', r.status === 409);
  r = await call('POST', `/api/admin/withdrawals/${wdId}/review`, { action: 'approve' }, adm);
  check('withdrawal → Processing', r.status === 200);
  r = await call('POST', `/api/admin/withdrawals/${wdId}/review`, { action: 'complete' }, adm);
  check('withdrawal → Completed', r.status === 200);
  r = await call('GET', '/api/transactions/mine', null, inv);
  check('WITHDRAWAL ledger entry present', r.data.transactions.some((t) => t.type === 'WITHDRAWAL'));

  console.log('— Reports & Notification Centre —');
  for (const rep of ['investors', 'deposits', 'withdrawals', 'trading', 'portfolio', 'activity', 'audit', 'gateway-settlement', 'feed-health']) {
    const rr = await call('GET', `/api/admin/reports/${rep}`, null, adm);
    check(`report ${rep}`, rr.status === 200, String(rr.status));
  }
  r = await call('GET', '/api/notifications/mine', null, adm);
  const types = new Set(r.data.notifications.map((n) => n.type));
  check('admin notified: KYC/deposit/orders/withdrawal', ['KYC_SUBMITTED', 'DEPOSIT_REQUEST', 'BUY_ORDER', 'SELL_ORDER', 'WITHDRAWAL_REQUEST'].every((t) => types.has(t)), [...types].join(','));
  r = await call('GET', '/api/admin/reports/audit', null, adm);
  check('audit trail populated', r.data.rows.length >= 8, String(r.data.rows.length));

  console.log('— Feed disconnect exception (Section 10) —');
  r = await call('POST', '/api/admin/feed/toggle', { paused: true }, adm);
  check('feed toggled DOWN', r.data.health.status === 'DOWN');
  r = await call('POST', '/api/orders', { instrument_id: quote.instrument_id, side: 'BUY', qty: 1, price: quote.ltp * 2 }, inv);
  check('order NOT blocked when feed down; feed status recorded', r.status === 200 && r.data.order.feed_status_at_order === 'UNAVAILABLE', JSON.stringify(r.data));
  await call('POST', `/api/admin/orders/${r.data.order.id}/status`, { action: 'cancel' }, adm);
  r = await call('POST', '/api/admin/feed/toggle', { paused: false }, adm);
  check('feed reconnected LIVE', r.data.health.status === 'LIVE');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1); });
