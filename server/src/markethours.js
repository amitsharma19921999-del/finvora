// Indian market hours (IST), per segment:
//   equity    — NSE/BSE cash + F&O: Mon–Fri 09:15–15:30
//   commodity — MCX non-agri:       Mon–Fri 09:00–23:30
// Decides whether an order executes instantly or is queued as an After-Market
// Order (AMO) that runs at the next open for THAT segment.
//
// Testing/demo override: set MARKET_TEST_STATE=open or =closed to force it.

// Official NSE/MCX trading holidays — ADD the full list from the yearly calendar
// (nseindia.com → Resources → Holidays). A few fixed national holidays are
// pre-filled; weekends are handled automatically.
const HOLIDAYS = new Set([
  '2026-01-26', // Republic Day
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
  // '2026-03-06', '2026-08-15', ... add the rest from the official calendar
]);

// Session windows, in minutes past IST midnight.
const SESSIONS = {
  equity: { open: 9 * 60 + 15, close: 15 * 60 + 30, openLabel: '9:15 AM' },
  commodity: { open: 9 * 60, close: 23 * 60 + 30, openLabel: '9:00 AM' },
};
const sessionFor = (segment) => SESSIONS[segment] || SESSIONS.equity;

// An instruments row -> its segment.
const segmentOf = (inst) => (
  inst && (inst.kind === 'commodity' || inst.exchange === 'MCX' || inst.exchange === 'NCDEX')
    ? 'commodity' : 'equity'
);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// IST wall-clock parts, independent of the server's own timezone.
function istParts(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000);
  return {
    day: ist.getUTCDay(),
    mins: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    date: ist.toISOString().slice(0, 10),
    baseMs: ist.getTime(),
  };
}

const isTradingDay = (day, dateIso) => day !== 0 && day !== 6 && !HOLIDAYS.has(dateIso);

function isMarketOpen(now = new Date(), segment = 'equity') {
  const force = process.env.MARKET_TEST_STATE;
  if (force === 'open') return true;
  if (force === 'closed') return false;
  const { day, mins, date } = istParts(now);
  if (!isTradingDay(day, date)) return false;
  const s = sessionFor(segment);
  return mins >= s.open && mins <= s.close;
}

// Friendly label for when a queued AMO will run, e.g. "Monday 9:15 AM".
function nextOpenLabel(now = new Date(), segment = 'equity') {
  const { day, mins, date, baseMs } = istParts(now);
  const s = sessionFor(segment);
  if (isTradingDay(day, date) && mins < s.open) return `today ${s.openLabel}`;
  for (let i = 1; i <= 10; i++) {
    const nx = new Date(baseMs + i * 86400000);
    const dd = nx.getUTCDay();
    const iso = nx.toISOString().slice(0, 10);
    if (isTradingDay(dd, iso)) return `${DAY_NAMES[dd]} ${s.openLabel}`;
  }
  return 'the next market open';
}

module.exports = { isMarketOpen, nextOpenLabel, segmentOf, SESSIONS };
