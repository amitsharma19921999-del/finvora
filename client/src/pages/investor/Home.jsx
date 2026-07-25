// Investor Home — onboarding journey until the account is Active, then a
// snapshot dashboard (wallet, top movers, quick actions). BPD Stages 4-6.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, num } from '../../api';
import { useAuth } from '../../auth';
import { subscribe } from '../../realtime';
import { useToast, Card, MoneyStat, Spinner, Stepper, StatusBadge } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice, ChangePct } from '../../components/market';

const IN_REVIEW = ['Submitted', 'Under Review'];

export default function Home() {
  const { user, me, refreshMe } = useAuth();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [justActivated, setJustActivated] = useState(false);

  // Fresh onboarding + wallet numbers every time the page opens.
  useEffect(() => { refreshMe(); }, [refreshMe]);

  // The auth context already refreshes on 'accountStatus'; we also listen here
  // so the page can celebrate the activation the instant it happens.
  useEffect(() => {
    const un = subscribe('accountStatus', (evt) => {
      refreshMe();
      if (evt && evt.status === 'Active') {
        setJustActivated(true);
        toastRef.current?.success('Your account is now active. You can start trading!');
      }
    });
    return un;
  }, [refreshMe]);

  // Deposits/withdrawals/trades arrive as 'notification' events (not
  // 'accountStatus'), so refresh wallet/onboarding numbers on those too.
  useEffect(() => subscribe('notification', () => refreshMe()), [refreshMe]);

  // Suspended: /api/auth/me returns 403 (me stays null), so surface it here
  // before the loading spinner rather than spinning forever.
  if (user?.status === 'Suspended') {
    return (
      <div>
        <h1 className="page-title">Account Suspended</h1>
        <div className="banner banner-danger">
          Your account has been suspended. Please contact support to resolve this — trading, funding and withdrawals are paused.
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div>
        <h1 className="page-title">Home</h1>
        <Spinner label="Loading your account…" />
      </div>
    );
  }

  if (user?.status !== 'Active') return <OnboardingJourney me={me} />;
  return <ActiveDashboard me={me} justActivated={justActivated} />;
}

// ---- Not yet Active: guided onboarding ----------------------------------------
function OnboardingJourney({ me }) {
  const { kyc_status: kycStatus, bank_status: bankStatus } = me.onboarding;
  const kycRejected = kycStatus === 'Rejected';
  const bankRejected = bankStatus === 'Rejected';
  const bothApproved = kycStatus === 'Approved' && bankStatus === 'Approved';

  if (me.user?.status === 'Suspended') {
    return (
      <div>
        <h1 className="page-title">Account Suspended</h1>
        <div className="banner banner-danger">
          Your account has been suspended. Please contact support to resolve this.
        </div>
      </div>
    );
  }

  const kycState = kycStatus === 'Approved' ? 'done'
    : kycRejected ? 'blocked'
    : IN_REVIEW.includes(kycStatus) ? 'current'
    : 'current'; // Not Submitted — this is the next thing to do

  const bankState = bankStatus === 'Approved' ? 'done'
    : bankRejected ? 'blocked'
    : IN_REVIEW.includes(bankStatus) ? 'current'
    : kycStatus === 'Not Submitted' ? 'todo' : 'current';

  const steps = [
    { label: 'Register', state: 'done', detail: 'Mobile verified — account created' },
    {
      label: 'Complete KYC',
      state: kycState,
      detail: kycRejected ? (
        <span>
          Rejected — {me.kyc?.reject_reason || 'please review and try again'}.{' '}
          <Link to="/app/kyc">Resubmit</Link>
        </span>
      ) : IN_REVIEW.includes(kycStatus) ? 'Under review'
        : kycStatus === 'Approved' ? 'Identity verified'
        : 'Upload your PAN, Aadhaar and photo — takes about 2 minutes',
    },
    {
      label: 'Add Bank Details',
      state: bankState,
      detail: bankRejected ? (
        <span>
          Rejected — {me.bank?.reject_reason || 'please review and try again'}.{' '}
          <Link to="/app/bank">Resubmit</Link>
        </span>
      ) : IN_REVIEW.includes(bankStatus) ? 'Under review'
        : bankStatus === 'Approved' ? 'Bank account verified'
        : 'Link the bank account you will use for deposits and withdrawals',
    },
    {
      label: 'Account Activation',
      state: bothApproved ? 'current' : 'todo',
      detail: bothApproved
        ? 'Both approvals received — your account will activate automatically any moment now'
        : 'Happens automatically once your KYC and bank details are both approved',
    },
  ];

  const kycAction = kycStatus === 'Not Submitted' || kycRejected;
  const bankAction = bankStatus === 'Not Submitted' || bankRejected;

  return (
    <div>
      <h1 className="page-title">Welcome to Finvora</h1>
      <p className="page-sub">A few quick steps and you&rsquo;ll be ready to invest.</p>

      {kycRejected && (
        <div className="banner banner-danger">
          Your KYC was rejected: {me.kyc?.reject_reason || 'reason not provided'}. Please correct the details and resubmit.
        </div>
      )}
      {bankRejected && (
        <div className="banner banner-danger">
          Your bank details were rejected: {me.bank?.reject_reason || 'reason not provided'}. Please correct the details and resubmit.
        </div>
      )}

      <Card title="Your Onboarding Journey" subtitle="Track each step below — we review submissions promptly.">
        <Stepper steps={steps} />

        {(kycAction || bankAction) && (
          <div className="row mt-3">
            {kycAction && (
              <Link className="btn btn-primary" to="/app/kyc">
                {kycRejected ? 'Resubmit KYC' : 'Complete KYC'}
              </Link>
            )}
            {bankAction && (
              <Link className={`btn ${kycAction ? 'btn-ghost' : 'btn-primary'}`} to="/app/bank">
                {bankRejected ? 'Resubmit Bank Details' : 'Add Bank Details'}
              </Link>
            )}
          </div>
        )}

        <div className="row mt-3 small">
          <span className="row">KYC <StatusBadge status={kycStatus} small /></span>
          <span className="row">Bank <StatusBadge status={bankStatus} small /></span>
          <span className="row">Account <StatusBadge status={me.onboarding.account_status} small /></span>
        </div>
      </Card>

      <div className="banner banner-info mt-2">
        No extra action needed for activation — the moment both your KYC and bank details are
        approved, your account switches to Active automatically and this page becomes your
        trading dashboard.
      </div>
    </div>
  );
}

// ---- Active: Kestrel-style dashboard ------------------------------------------
const money = (n) => inr(n);
const signed = (n) => `${n >= 0 ? '+' : '−'}${inr(Math.abs(n))}`;

// Smooth SVG area chart of portfolio value over a window (synthesized from the
// real current value — the demo has no long price history yet).
function AreaChart({ end, ret, points = 40, height = 150 }) {
  const data = useMemo(() => {
    const arr = [];
    const start = end - ret;
    let seed = Math.abs(Math.sin(end)) * 1000;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < points; i++) {
      const base = start + (end - start) * (i / (points - 1));
      const noise = (rnd() - 0.5) * Math.abs(ret || end * 0.02) * 0.5;
      arr.push(Math.max(0, base + noise * (i / points)));
    }
    arr[arr.length - 1] = end;
    return arr;
  }, [end, ret, points]);
  const W = 720;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * W;
  const y = (v) => 8 + (1 - (v - min) / range) * (height - 16);
  const line = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const up = ret >= 0;
  const col = up ? 'var(--up)' : 'var(--down)';
  const gid = up ? 'gU' : 'gD';
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.28" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${line} ${W},${height}`} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function StatTile({ label, value, valueTone, deltaAmount, deltaPct, sub }) {
  const up = (deltaAmount ?? deltaPct ?? 0) >= 0;
  const parts = [];
  if (deltaAmount != null) parts.push(`${up ? '+' : '−'}${inr(Math.abs(deltaAmount))}`);
  if (deltaPct != null) parts.push(`(${up ? '+' : '−'}${Math.abs(deltaPct).toFixed(2)}%)`);
  return (
    <div className="kstat">
      <div className="kstat-label">{label}</div>
      <div className={`kstat-value ${valueTone === 'up' ? 'text-up' : valueTone === 'down' ? 'text-down' : ''}`}>{value}</div>
      <div className="kstat-meta">
        {parts.length > 0 && <span className={up ? 'text-up' : 'text-down'}>{parts.join(' ')}</span>}
        {sub && <span className="kstat-sub"> {sub}</span>}
      </div>
    </div>
  );
}

function ActiveDashboard({ me, justActivated }) {
  const { quotes, health, asOf } = useLivePrices();
  const [pf, setPf] = useState(null);
  const [pulse, setPulse] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [range, setRange] = useState('1M');

  const load = async () => { try { setPf(await api.get('/api/portfolio')); } catch { /* ignore */ } };
  useEffect(() => { load(); api.get('/api/markets/pulse').then(setPulse).catch(() => {}); }, []);
  useEffect(() => subscribe('notification', load), []); // eslint-disable-line react-hooks/exhaustive-deps

  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const name = (me.user?.email ? me.user.email.split('@')[0] : 'investor').replace(/^\w/, (c) => c.toUpperCase());

  const wallet = pf?.wallet || me.wallet || {};
  const t = pf?.totals || {};
  const holdings = pf?.holdings || [];
  const portfolioValue = (t.market_value || 0) + (wallet.balance || 0);
  const allTime = (t.unrealized_pnl || 0) + (t.realized_pnl || 0);
  const allTimePct = t.invested ? (allTime / t.invested) * 100 : 0;
  const todayPnl = holdings.reduce((s, h) => s + h.qty * h.ltp * ((h.day_change_pct || 0) / 100), 0);
  const todayPct = t.market_value ? (todayPnl / t.market_value) * 100 : 0;
  const watch = quotes.slice(0, 8);

  return (
    <div className="dash">
      {/* header */}
      <div className="dash-head">
        <div>
          <span className="acct-pill">● Account active · KYC &amp; bank verified · INV-{String(me.user?.id || 0).padStart(4, '0')}</span>
          <h1 className="dash-greet">Good {partOfDay}, {name}</h1>
          <p className="dash-sub">Here&rsquo;s how your portfolio is doing today.</p>
        </div>
        <div className="dash-actions">
          <Link className="btn btn-outline-k" to="/app/funds">Add funds</Link>
          <Link className="btn btn-primary" to="/app/trade">Trade now</Link>
        </div>
      </div>

      {justActivated && <div className="banner banner-success">Your account is now Active — you can add funds and place your first order.</div>}

      {/* stat tiles */}
      <div className="kstat-grid">
        <StatTile label="Portfolio value" value={money(portfolioValue)} deltaAmount={allTime} deltaPct={allTimePct} sub="all-time" />
        <StatTile label="Today's P&L" value={signed(todayPnl)} valueTone={todayPnl >= 0 ? 'up' : 'down'} deltaPct={todayPct} sub="today" />
        <StatTile label="Available balance" value={money(wallet.available)} sub="ready to trade / withdraw" />
        <StatTile label="Invested" value={money(t.invested)} sub={`${holdings.length} instrument${holdings.length === 1 ? '' : 's'}`} />
      </div>

      <div className="dash-grid">
        {/* performance chart */}
        <div className="panel k-perf">
          <div className="k-panel-head">
            <div>
              <div className="k-panel-title">Portfolio performance</div>
              <div className="small text-muted">Last 30 days · <span className={allTime >= 0 ? 'text-up' : 'text-down'}>{allTime >= 0 ? '+' : '−'}{inr(Math.abs(allTime))} ({allTimePct >= 0 ? '+' : '−'}{Math.abs(allTimePct).toFixed(2)}%)</span></div>
            </div>
            <div className="k-range">
              {['1W', '1M', '1Y'].map((r) => (
                <button key={r} className={`k-range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
          </div>
          <div className="k-perf-chart">
            <AreaChart end={portfolioValue || 100000} ret={allTime || (portfolioValue || 100000) * 0.05} points={range === '1W' ? 20 : range === '1Y' ? 60 : 40} />
          </div>
        </div>

        {/* market pulse */}
        {!dismissed && (
          <div className="panel k-pulse">
            <div className="k-pulse-top">
              <span className="k-pulse-label">MARKET PULSE</span>
              <span className="k-conf-ring">{pulse ? pulse.confidence : '—'}<small>confidence</small></span>
            </div>
            <p className="k-pulse-text">{pulse ? pulse.advisory : 'Reading the tape…'}</p>
            <p className="k-pulse-note"><b>rationale</b> {pulse?.note || 'Advisory only — Finvora never auto-executes. All orders route to the manual desk for review.'}</p>
            <div className="row">
              <Link className="btn btn-sm btn-primary" to="/app/markets">Review markets</Link>
              <button className="btn btn-sm btn-ghost" onClick={() => setDismissed(true)}>Dismiss</button>
            </div>
          </div>
        )}
      </div>

      {/* holdings */}
      <div className="panel">
        <div className="k-panel-head" style={{ padding: '16px 18px' }}>
          <div className="k-panel-title">Holdings</div>
          <Link className="small" to="/app/portfolio" style={{ color: 'var(--accent)' }}>View portfolio</Link>
        </div>
        {!pf ? <div style={{ padding: 18 }}><Spinner label="Loading holdings…" /></div>
          : holdings.length === 0 ? <div className="small text-muted" style={{ padding: '4px 18px 18px' }}>No holdings yet — <Link to="/app/trade" style={{ color: 'var(--accent)' }}>place your first trade</Link>.</div>
          : (
            <div className="k-table-wrap">
              <table className="k-table">
                <thead><tr><th>INSTRUMENT</th><th className="r">LTP</th><th className="r">VALUE</th><th className="r">P&amp;L</th></tr></thead>
                <tbody>
                  {holdings.map((h) => (
                    <tr key={h.instrument_id}>
                      <td><div className="k-inst"><b>{h.symbol}</b><span className="small text-muted">{num(h.qty)} @ {inr(h.avg_price)}</span></div></td>
                      <td className="r mono">{inr(h.ltp)}</td>
                      <td className="r mono">{inr(h.market_value)}</td>
                      <td className={`r mono ${h.unrealized_pnl >= 0 ? 'text-up' : 'text-down'}`}>
                        {h.unrealized_pnl >= 0 ? '+' : '−'}{inr(Math.abs(h.unrealized_pnl))}<div className="small">({h.pnl_pct >= 0 ? '+' : '−'}{Math.abs(h.pnl_pct).toFixed(2)}%)</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {/* watchlist */}
      <div className="panel">
        <div className="k-panel-head" style={{ padding: '16px 18px' }}>
          <div className="k-panel-title">Watchlist</div>
          <FeedBadge health={health} asOf={asOf} />
        </div>
        <div className="k-watch">
          {watch.length === 0 ? <div style={{ padding: 18 }}><Spinner label="Loading market…" /></div>
            : watch.map((q) => (
              <Link key={q.instrument_id} to="/app/trade" className="k-watch-row">
                <span className="k-inst"><b>{q.symbol}</b><span className="small text-muted">{q.name}</span></span>
                <span className="k-watch-r"><LivePrice value={q.ltp} /><ChangePct value={q.change_pct} /></span>
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}
