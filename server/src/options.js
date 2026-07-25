// Shared options (F&O) model — a Black-Scholes-lite premium so calls/puts move
// with the live underlying spot. Representative (there is no free live options
// feed); used by BOTH the option-chain endpoint and the live quote for a traded
// option contract, so the price a customer clicks is the price they trade at.
const round2 = (n) => Math.round(n * 100) / 100;

// Representative lot sizes. Indices use a lookup; stocks scale by price band.
const INDEX_LOTS = { 'NIFTY 50': 75, 'NIFTY BANK': 30, 'SENSEX': 20, 'NIFTY FIN': 65, 'NIFTY IT': 40 };
function lotSizeFor(symbol, kind, spot) {
  if (kind === 'index') return INDEX_LOTS[symbol] || 50;
  if (spot > 2500) return 125;
  if (spot > 1000) return 250;
  if (spot > 500) return 550;
  if (spot > 100) return 1200;
  return 2500;
}

function strikeStep(spot) {
  return spot > 20000 ? 100 : spot > 2000 ? 50 : spot > 500 ? 20 : spot > 100 ? 5 : 2.5;
}
function atmStrike(spot, step = strikeStep(spot)) {
  return Math.round(spot / step) * step;
}

const MS_DAY = 86400000;
function daysToExpiry(expiryIso, now = Date.now()) {
  if (!expiryIso) return 7;
  const t = new Date(`${expiryIso}T15:30:00+05:30`).getTime(); // NSE expiry ~3:30pm IST
  if (Number.isNaN(t)) return 7;
  return Math.max(1, Math.ceil((t - now) / MS_DAY));
}

// Black-Scholes-lite: intrinsic + time value that decays with distance from spot
// and shrinks as expiry approaches (sqrt(T)). iv is a flat representative 16%.
function premium(spot, strike, isCall, expiryIso, now = Date.now()) {
  const iv = 0.16;
  const T = daysToExpiry(expiryIso, now) / 365;
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const dist = Math.abs(spot - strike) / spot;
  const timeVal = spot * iv * Math.sqrt(T) * Math.exp(-dist * 22);
  return round2(intrinsic + timeVal + 0.05);
}

// Representative open interest — peaks around the ATM strike.
function openInterest(spot, strike) {
  return Math.round(50000 * Math.exp(-Math.abs(spot - strike) / (spot * 0.02)) + Math.random() * 3000);
}

// Upcoming expiries (ISO dates) — representative weekly/monthly ladder.
function upcomingExpiries(now = Date.now(), offsets = [7, 14, 28]) {
  return offsets.map((dd) => { const d = new Date(now); d.setDate(d.getDate() + dd); return d.toISOString().slice(0, 10); });
}

// Compact expiry label, e.g. 2026-08-01 -> 01AUG26.
function expiryLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}${mon}${yr}`;
}

// Contract symbol, e.g. NIFTY 50 + 2026-08-01 + 23800 + CE -> "NIFTY 01AUG26 23800 CE".
function contractSymbol(underlying, expiryIso, strike, optType) {
  const u = String(underlying).replace(/\s+/g, '').toUpperCase().replace(/^NIFTY50$/, 'NIFTY');
  return `${u} ${expiryLabel(expiryIso)} ${strike} ${optType}`;
}

module.exports = {
  round2, INDEX_LOTS, lotSizeFor, strikeStep, atmStrike,
  daysToExpiry, premium, openInterest, upcomingExpiries, expiryLabel, contractSymbol,
};
