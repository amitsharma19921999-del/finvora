// Angel One SmartAPI connectivity + data-quality check.
//
//   cd ~/finvora/server && node test/angel-check.js
//
// Run this AFTER putting the ANGEL_* values in server/.env. It logs in, pulls
// live quotes, compares them against the old Yahoo feed so you can see the delay
// for yourself, and fetches a real option chain.
const config = require('../src/config');
const angel = require('../src/feeds/angel');

const pad = (s, n) => String(s).padEnd(n);
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function yahoo(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=1d&interval=1m`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const m = (await r.json())?.chart?.result?.[0]?.meta;
    return m ? { ltp: m.regularMarketPrice, at: m.regularMarketTime ? new Date(m.regularMarketTime * 1000) : null } : null;
  } catch { return null; }
}

(async () => {
  console.log('\n===== 1. CREDENTIALS =====');
  const a = config.angel;
  console.log('  ANGEL_API_KEY      :', a.apiKey ? 'set (' + a.apiKey.slice(0, 4) + '…)' : 'MISSING');
  console.log('  ANGEL_CLIENT_CODE  :', a.clientCode || 'MISSING');
  console.log('  ANGEL_MPIN         :', a.pin ? 'set' : 'MISSING');
  console.log('  ANGEL_TOTP_SECRET  :', a.totpSecret ? 'set' : 'MISSING');
  if (!angel.configured()) {
    console.log('\n  ✗ Credentials incomplete — add them to server/.env and re-run.');
    process.exit(1);
  }
  console.log('  current TOTP       :', angel.totp(a.totpSecret), '(should match your authenticator app)');

  console.log('\n===== 2. LOGIN =====');
  try {
    await angel.login();
    console.log('  ✓ Logged in to SmartAPI');
  } catch (e) {
    console.log('  ✗ LOGIN FAILED:', e.message);
    console.log('    → check the MPIN, client code, and that the TOTP secret matches.');
    process.exit(1);
  }

  console.log('\n===== 3. INSTRUMENTS =====');
  await angel.loadScripMaster();
  console.log('  ', JSON.stringify(angel._counts()));

  console.log('\n===== 4. LIVE EQUITIES — SmartAPI vs Yahoo =====');
  const SYMS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN'];
  const toks = SYMS.map((s) => angel.equityToken(s)).filter(Boolean);
  const rows = await angel.quote({ NSE: toks.map((t) => t.token) }, 'FULL');
  const byTok = new Map(rows.map((r) => [String(r.symbolToken), r]));
  console.log('  ' + pad('SYMBOL', 11) + pad('SmartAPI (live)', 18) + pad('Yahoo (delayed)', 18) + pad('DIFF', 12) + 'Yahoo quoted at');
  for (let i = 0; i < SYMS.length; i++) {
    const t = angel.equityToken(SYMS[i]);
    const r = t && byTok.get(t.token);
    const y = await yahoo(SYMS[i]);
    if (!r) { console.log('  ' + pad(SYMS[i], 11) + 'no data'); continue; }
    const diff = y ? (r.ltp - y.ltp) : null;
    const lag = y?.at ? Math.round((Date.now() - y.at.getTime()) / 60000) + ' min ago' : '?';
    console.log('  ' + pad(SYMS[i], 11) + pad(inr(r.ltp), 18) + pad(y ? inr(y.ltp) : '—', 18)
      + pad(diff == null ? '—' : (diff >= 0 ? '+' : '') + diff.toFixed(2), 12) + lag);
  }

  console.log('\n===== 5. REAL MCX COMMODITIES =====');
  const cs = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER'].map((n) => angel.commodityToken(n)).filter(Boolean);
  const crows = await angel.quote({ MCX: cs.map((c) => c.token) }, 'FULL');
  if (!crows.length) console.log('  (no data — MCX may be closed, or your account lacks the commodity segment)');
  for (const r of crows) {
    const c = cs.find((x) => x.token === String(r.symbolToken));
    console.log('  ' + pad(c ? c.symbol : r.tradingSymbol, 24) + pad(inr(r.ltp), 16) + 'lot ' + (c ? c.lotsize : '?'));
  }

  console.log('\n===== 6. REAL OPTION CHAIN (the big one) =====');
  const exp = angel.expiriesFor('NIFTY')[0];
  console.log('  nearest NIFTY expiry:', exp);
  const contracts = angel.optionsFor('NIFTY', exp);
  console.log('  contracts available :', contracts.length);
  const ces = contracts.filter((c) => c.type === 'CE').sort((a, b) => a.strike - b.strike);
  const mid = ces.slice(Math.max(0, Math.floor(ces.length / 2) - 3), Math.floor(ces.length / 2) + 3);
  const orows = await angel.quote({ NFO: mid.map((c) => c.token) }, 'FULL');
  console.log('  ' + pad('CONTRACT', 26) + pad('PREMIUM', 14) + pad('OPEN INTEREST', 16) + 'IV');
  for (const r of orows) {
    const c = mid.find((x) => x.token === String(r.symbolToken));
    console.log('  ' + pad(c ? c.symbol : r.tradingSymbol, 26) + pad(inr(r.ltp), 14)
      + pad(Number(r.opnInterest || 0).toLocaleString('en-IN'), 16) + (r.impliedVolatility ?? '—'));
  }
  if (orows.length) {
    console.log('\n  ✓ These are REAL market premiums with REAL open interest.');
    console.log('    Your current app invents these from a formula with a fixed 16% volatility.');
  }

  console.log('\n===== DONE =====');
  console.log('  If sections 4-6 show data, set FEED_MODE=angel in server/.env and restart.\n');
  process.exit(0);
})().catch((e) => { console.error('\nCRASH:', e.message); process.exit(2); });
