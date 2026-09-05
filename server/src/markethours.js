// Indian market hours (IST), per segment:
//   equity    — NSE/BSE cash + F&O: Mon–Fri 09:15–15:30
//   commodity — MCX non-agri:       Mon–Fri 09:00–23:30 while US daylight saving
//               is on, and 09:00–23:55 in the US winter. MCX tracks the COMEX /
//               NYMEX close, so the IST cut-off moves 25 minutes twice a year.
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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- US daylight saving (2nd Sunday of March → 1st Sunday of November, 02:00 ET)
// MCX's evening session tracks the US metals/energy close, so the Indian cut-off
// moves with it — 25 minutes, because 23:55 IST is the outer limit SEBI permits.
//
// THE DIRECTION IS COUNTER-INTUITIVE and most broker pages state it backwards:
// the LATER close (23:55) is the US WINTER one. MCX moves the close EARLIER, to
// 23:30, when US DST begins. Confirmed by the MCX circular effective 09-Mar-2026
// (close changed 23:55 -> 23:30) and by MCX Market Watch snapshots stamped 23:30
// through the DST months. Do not "fix" this by swapping it back.
function nthSundayUtc(year, monthIdx, n) {
  const d = new Date(Date.UTC(year, monthIdx, 1));
  const shift = (7 - d.getUTCDay()) % 7;          // days to the first Sunday
  d.setUTCDate(1 + shift + (n - 1) * 7);
  d.setUTCHours(7, 0, 0, 0);                       // ~02:00 US Eastern
  return d.getTime();
}
function usDstActive(now = new Date()) {
  const y = now.getUTCFullYear();
  const t = now.getTime();
  return t >= nthSundayUtc(y, 2, 2) && t < nthSundayUtc(y, 10, 1);
}

// Session windows, in minutes past IST midnight.
function sessionFor(segment, now = new Date()) {
  if (segment === 'commodity') {
    const dst = usDstActive(now); // US summer -> the EARLIER 23:30 close
    return {
      open: 9 * 60,
      close: dst ? 23 * 60 + 30 : 23 * 60 + 55,
      openLabel: '9:00 AM',
      closeLabel: dst ? '11:30 PM' : '11:55 PM',
      name: 'MCX commodity',
    };
  }
  return {
    open: 9 * 60 + 15,
    close: 15 * 60 + 30,
    openLabel: '9:15 AM',
    closeLabel: '3:30 PM',
    name: 'NSE/BSE equity & F&O',
  };
}

// An instruments row -> its segment. Kept deliberately loose: a row that lost its
// `kind` but kept exchange='MCX' (or vice versa) must still be treated as a
// commodity, otherwise it would silently inherit the 15:30 equity cut-off.
const segmentOf = (inst) => {
  if (!inst) return 'equity';
  const kind = String(inst.kind || '').toLowerCase();
  const exch = String(inst.exchange || '').toUpperCase();
  return kind === 'commodity' || exch === 'MCX' || exch === 'NCDEX' ? 'commodity' : 'equity';
};

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
  const s = sessionFor(segment, now);
  return mins >= s.open && mins <= s.close;
}

// Friendly label for when a queued AMO will run, e.g. "Monday 9:15 AM".
function nextOpenLabel(now = new Date(), segment = 'equity') {
  const { day, mins, date, baseMs } = istParts(now);
  const s = sessionFor(segment, now);
  if (isTradingDay(day, date) && mins < s.open) return `today ${s.openLabel}`;
  for (let i = 1; i <= 10; i++) {
    const nx = new Date(baseMs + i * 86400000);
    const dd = nx.getUTCDay();
    const iso = nx.toISOString().slice(0, 10);
    if (isTradingDay(dd, iso)) return `${DAY_NAMES[dd]} ${s.openLabel}`;
  }
  return 'the next market open';
}

// "MCX commodity 9:00 AM–11:55 PM" — used in the AMO message so a client (and we)
// can see WHICH session the server applied to their order.
const sessionLabel = (segment, now = new Date()) => {
  const s = sessionFor(segment, now);
  return `${s.name} ${s.openLabel}–${s.closeLabel}`;
};

// One-line snapshot for /api/health and the boot log.
function sessionSnapshot(now = new Date()) {
  const { mins, date, day } = istParts(now);
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const out = { ist: `${date} ${hhmm}`, trading_day: isTradingDay(day, date) };
  for (const seg of ['equity', 'commodity']) {
    const s = sessionFor(seg, now);
    out[seg] = { open: isMarketOpen(now, seg), window: `${s.openLabel}–${s.closeLabel}` };
  }
  return out;
}

module.exports = {
  isMarketOpen, nextOpenLabel, segmentOf, sessionFor, sessionLabel, sessionSnapshot, usDstActive,
};
