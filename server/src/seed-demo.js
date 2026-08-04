// Optional demo data: a fully-onboarded investor with funds, holdings and
// history, so the Administrator Console and reports have content immediately.
// Run with: npm run seed   (safe to re-run; skips if the demo user exists)
const { init, run, get, scryptHash } = require('./db');

(async () => {
  await init(); // open the DB + ensure the schema exists before any query
  if (await get("SELECT id FROM users WHERE mobile = '9876543210'")) {
    console.log('Demo investor already exists — nothing to do.');
    process.exit(0);
  }

  const u = await run("INSERT INTO users (mobile, email, password_hash, role, status) VALUES ('9876543210','demo@finvora.local',?,'investor','Active')", scryptHash('Demo@123'));
  const uid = u.lastInsertRowid;
  await run('INSERT INTO wallets (user_id, balance) VALUES (?, 375000)', uid);

  await run(`INSERT INTO kyc (user_id, full_name, dob, address, pan, aadhaar, status, reviewed_at) VALUES
    (?, 'Demo Investor', '1992-06-15', '14 Marine Drive, Mumbai, Maharashtra 400020', 'ABCDE1234F', '234567890123', 'Approved', datetime('now'))`, uid);
  await run(`INSERT INTO bank_accounts (user_id, holder_name, account_number, ifsc, bank_name, branch, status, reviewed_at) VALUES
    (?, 'Demo Investor', '50100987654321', 'HDFC0000456', 'HDFC Bank', 'Marine Drive, Mumbai', 'Approved', datetime('now'))`, uid);

  const dep = await run("INSERT INTO deposits (user_id, method, amount, utr, status, verified_at) VALUES (?, 'MANUAL', 500000, 'UTR9988776655', 'Deposit Approved', datetime('now'))", uid);
  await run("INSERT INTO transactions (user_id, type, ref_table, ref_id, amount, balance_after, note) VALUES (?, 'DEPOSIT', 'deposits', ?, 500000, 500000, 'Manual deposit approved (UTR UTR9988776655)')", uid, dep.lastInsertRowid);

  const reliance = await get("SELECT id, base_price FROM instruments WHERE symbol = 'RELIANCE'");
  const tcs = await get("SELECT id, base_price FROM instruments WHERE symbol = 'TCS'");
  const infy = await get("SELECT id, base_price FROM instruments WHERE symbol = 'INFY'");

  let bal = 500000;
  for (const [inst, qty, px] of [[reliance, 30, 2890.0], [tcs, 15, 4095.5], [infy, 40, 1540.25]]) {
    const cost = qty * px;
    bal -= cost;
    const o = await run(`INSERT INTO orders (user_id, instrument_id, side, qty, price, ltp_at_order, status, exec_price, exec_qty, exec_time)
                 VALUES (?, ?, 'BUY', ?, ?, ?, 'Executed', ?, ?, datetime('now', '-2 days'))`, uid, inst.id, qty, px, px, px, qty);
    await run('INSERT INTO holdings (user_id, instrument_id, qty, avg_price) VALUES (?, ?, ?, ?)', uid, inst.id, qty, px);
    await run("INSERT INTO transactions (user_id, type, ref_table, ref_id, amount, balance_after, note) VALUES (?, 'BUY', 'orders', ?, ?, ?, ?)",
      uid, o.lastInsertRowid, -cost, bal, `Bought ${qty} @ ₹${px}`);
  }
  await run('UPDATE wallets SET balance = ? WHERE user_id = ?', bal, uid);

  console.log('Demo investor created → mobile: 9876543210  password: Demo@123');
  console.log(`Wallet balance ₹${bal}, holdings: RELIANCE 30, TCS 15, INFY 40`);
  process.exit(0); // the DB pool keeps the event loop alive otherwise
})();
