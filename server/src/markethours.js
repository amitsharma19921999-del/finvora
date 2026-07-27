// NSE market hours (IST): Mon–Fri, 09:15–15:30, excluding holidays.
// Decides whether an order executes instantly or is queued as an After-Market
// Order (AMO) that runs at the next market open.
//
// Testing/demo override: set MARKET_TEST_STATE=open or =closed to force it.

// Official NSE trading holidays — ADD the full list from NSE's yearly calendar
// (nseindia.com → Resources → Holidays → Trading). A few fixed national holidays
// are pre-filled; weekends are handled automatically.
const HOLIDAYS = new Set([
  '2026-01-26', // Republic Day
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
  // '2026-03-06', '2026-08-15', ... add the rest from the official calendar
]);

const OPEN_MIN = 9 * 60 + 15;   // 09:15
const CLOSE_MIN = 15 * 60 + 30; // 15:30
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

function isMarketOpen(now = new Date()) {
  const force = process.env.MARKET_TEST_STATE;
  if (force === 'open') return true;
  if (force === 'closed') return false;
  const { day, mins, date } = istParts(now);
  if (!isTradingDay(day, date)) return false;
  return mins >= OPEN_MIN && mins <= CLOSE_MIN;
}

// Friendly label for when a queued AMO will run, e.g. "Monday 9:15 AM".
function nextOpenLabel(now = new Date()) {
  const { day, mins, date, baseMs } = istParts(now);
  if (isTradingDay(day, date) && mins < OPEN_MIN) return 'today 9:15 AM';
  for (let i = 1; i <= 10; i++) {
    const nx = new Date(baseMs + i * 86400000);
    const dd = nx.getUTCDay();
    const iso = nx.toISOString().slice(0, 10);
    if (isTradingDay(dd, iso)) return `${DAY_NAMES[dd]} 9:15 AM`;
  }
  return 'the next market open';
}

module.exports = { isMarketOpen, nextOpenLabel };
