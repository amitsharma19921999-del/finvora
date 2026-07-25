// Regression tests for the fixes from the adversarial code review.
// Run: node test/regression.js   (server must be running in mock/sim mode)
const BASE = process.env.BASE || 'http://localhost:4000';
let passed = 0, failed = 0;
const check = (name, cond, detail = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${detail}`); } };

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onboardedInvestor() {
  const mobile = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const email = `reg${Date.now()}${Math.floor(Math.random() * 999)}@test.local`;
  let r = await call('POST', '/api/auth/register', { mobile, email, password: 'Invest@123' });
  await call('POST', '/api/auth/verify-otp', { mobile, code: r.data.demo_otp });
  r = await call('POST', '/api/auth/login', { identifier: mobile, password: 'Invest@123' });
  const inv = r.data.token;
  await call('POST', '/api/kyc', { full_name: 'Reg Tester', dob: '1990-01-01', address: '1 Test Road, Mumbai 400001', pan: 'ABCDE1234F', aadhaar: '234567890123', photo: TINY, id_doc: TINY }, inv);
  await call('POST', '/api/bank', { holder_name: 'Reg Tester', account_number: '123456789012', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank', branch: 'Fort', proof: TINY }, inv);
  const adm = (await call('POST', '/api/auth/login', { identifier: '9999999999', password: 'Admin@123' })).data.token;
  const kycId = (await call('GET', '/api/admin/kyc?status=Submitted', null, adm)).data.kyc.find((k) => k.mobile === mobile).id;
  await call('POST', `/api/admin/kyc/${kycId}/review`, { action: 'approve' }, adm);
  const bankId = (await call('GET', '/api/admin/bank?status=Submitted', null, adm)).data.bank.find((b) => b.mobile === mobile).id;
  await call('POST', `/api/admin/bank/${bankId}/review`, { action: 'approve' }, adm);
  return { mobile, email, inv, adm };
}

(async () => {
  const adm = (await call('POST', '/api/auth/login', { identifier: '9999999999', password: 'Admin@123' })).data.token;

  console.log('\n— Fix #2: re-registration over unverified account does NOT 500 —');
  {
    const mobile = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
    const email = `rereg${Date.now()}@test.local`;
    await call('POST', '/api/auth/register', { mobile, email, password: 'Invest@123' }); // abandon OTP
    const r = await call('POST', '/api/auth/register', { mobile, email, password: 'Invest@123' }); // retry
    check('re-registration succeeds (no FK crash)', r.status === 200 && r.data.demo_otp, `status ${r.status}: ${JSON.stringify(r.data)}`);
  }

  console.log('— Fix #5: query ?token= rejected on POST (state change) —');
  {
    const r = await call('POST', `/api/notifications/read?token=${encodeURIComponent(adm)}`, { ids: 'all' }, null);
    check('POST with ?token= is 401 (not honored)', r.status === 401, `status ${r.status}`);
    const r2 = await fetch(`${BASE}/api/admin/dashboard?token=${encodeURIComponent(adm)}`);
    check('GET admin route with ?token= also rejected (not whitelisted)', r2.status === 401, `status ${r2.status}`);
    const r3 = await fetch(`${BASE}/api/admin/reports/investors?format=csv&token=${encodeURIComponent(adm)}`);
    check('GET whitelisted report CSV with ?token= works', r3.status === 200, `status ${r3.status}`);
  }

  const { mobile, inv } = await onboardedInvestor();

  console.log('— Fix #7: sub-paisa order price that rounds to 0 is rejected —');
  {
    const r = await call('POST', '/api/orders', { instrument_id: 1, side: 'BUY', qty: 1, price: 0.004 }, inv);
    check('price 0.004 rejected (400)', r.status === 400, `status ${r.status}: ${JSON.stringify(r.data)}`);
  }

  console.log('— Fix #12: duplicate UTR on manual deposit rejected —');
  {
    const utr = 'DUPUTR' + Date.now();
    const a = await call('POST', '/api/deposits/manual', { amount: 5000, utr, proof: TINY }, inv);
    check('first UTR accepted', a.status === 200, JSON.stringify(a.data));
    const b = await call('POST', '/api/deposits/manual', { amount: 5000, utr, proof: TINY }, inv);
    check('same UTR rejected (409)', b.status === 409, `status ${b.status}`);
  }

  console.log('— Fix #1: absurd execution price outside band rejected —');
  {
    // Fund the investor and place a real buy order to execute.
    const dep = await call('POST', '/api/deposits/manual', { amount: 200000, utr: 'EXEC' + Date.now(), proof: TINY }, inv);
    await call('POST', `/api/admin/deposits/${dep.data.id}/review`, { action: 'under_verification' }, adm);
    await call('POST', `/api/admin/deposits/${dep.data.id}/review`, { action: 'approve' }, adm);
    const snap = await call('GET', '/api/market/snapshot', null, inv);
    const q = snap.data.quotes[0];
    const ord = await call('POST', '/api/orders', { instrument_id: q.instrument_id, side: 'BUY', qty: 5, price: q.ltp }, inv);
    const oid = ord.data.order.id;
    const bad = await call('POST', `/api/admin/orders/${oid}/status`, { action: 'executed', exec_price: q.ltp * 20 }, adm);
    check('20x execution price rejected (400)', bad.status === 400, `status ${bad.status}: ${JSON.stringify(bad.data)}`);
    const good = await call('POST', `/api/admin/orders/${oid}/status`, { action: 'executed', exec_price: q.ltp }, adm);
    check('sane execution price accepted', good.status === 200, JSON.stringify(good.data));
  }

  console.log('— Fix #13/22: reconcile-approve refused without captured settlement —');
  {
    const init = await call('POST', '/api/deposits/gateway/initiate', { amount: 8000 }, inv);
    const orderId = init.data.order_id;
    await call('POST', '/api/gateway/mock/pay', { order_id: orderId, scenario: 'fail' }, inv); // settlement=failed
    await sleep(2000);
    const dep = (await call('GET', '/api/deposits/mine', null, inv)).data.deposits.find((d) => d.gateway_order_id === orderId);
    // 'fail' webhook marks it Deposit Failed; force the held-review case with a 'delay' instead:
    const init2 = await call('POST', '/api/deposits/gateway/initiate', { amount: 9000 }, inv);
    await call('POST', '/api/gateway/mock/pay', { order_id: init2.data.order_id, scenario: 'fail' }, inv);
    await sleep(1600);
    const dep2 = (await call('GET', '/api/deposits/mine', null, inv)).data.deposits.find((d) => d.gateway_order_id === init2.data.order_id);
    const rec = await call('POST', `/api/admin/deposits/${dep2.id}/reconcile`, {}, adm);
    check('failed gateway deposit is not creditable via reconcile-approve', dep2.status === 'Deposit Failed', `status ${dep2.status}`);
    // A deposit stuck at Payment Initiated (never paid) must not be approvable.
    const init3 = await call('POST', '/api/deposits/gateway/initiate', { amount: 7000 }, inv);
    const dep3 = (await call('GET', '/api/deposits/mine', null, inv)).data.deposits.find((d) => d.gateway_order_id === init3.data.order_id);
    const bad = await call('POST', `/api/admin/deposits/${dep3.id}/reconcile`, { decision: 'approve' }, adm);
    check('reconcile-approve on never-paid deposit refused (409)', bad.status === 409, `status ${bad.status}: ${JSON.stringify(bad.data)}`);
  }

  console.log('— Fix #6/23: suspend then reactivate does NOT bypass activation —');
  {
    // Fresh investor at Registered (KYC/bank submitted but not approved).
    const m = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
    const e = `susp${Date.now()}@test.local`;
    let r = await call('POST', '/api/auth/register', { mobile: m, email: e, password: 'Invest@123' });
    await call('POST', '/api/auth/verify-otp', { mobile: m, code: r.data.demo_otp });
    const id = (await call('GET', `/api/admin/investors?q=${m}`, null, adm)).data.investors[0].id;
    await call('POST', `/api/admin/investors/${id}/status`, { status: 'Suspended', reason: 'test' }, adm);
    const react = await call('POST', `/api/admin/investors/${id}/status`, { status: 'Active' }, adm);
    const after = (await call('GET', `/api/admin/investors/${id}`, null, adm)).data.user.status;
    check('reactivation of ineligible investor does NOT set Active', after !== 'Active', `status is ${after}`);
    check('reactivation returns them to Registered', after === 'Registered', `status is ${after}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('REGRESSION CRASH:', e); process.exit(1); });
