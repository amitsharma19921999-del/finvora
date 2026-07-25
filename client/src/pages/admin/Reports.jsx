// Admin Reports — BPD Section 6.2, all nine reports with filters + CSV export.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, csvUrl, inr, fmtDateTime } from '../../api';
import { useToast, Card, Field, Stat, Spinner, DataTable, StatusBadge } from '../../components/ui';
import { FeedBadge } from '../../components/market';

const DEPOSIT_STATUSES = [
  'Deposit Pending', 'Deposit Under Verification', 'Deposit Approved', 'Deposit Rejected',
  'Payment Initiated', 'Gateway Confirmation Pending', 'Deposit Approved (Auto)', 'Deposit Failed',
];
const WITHDRAWAL_STATUSES = ['Withdrawal Pending', 'Processing', 'Completed', 'Rejected'];
const ORDER_STATUSES = ['Pending', 'Executing', 'Executed', 'Rejected', 'Cancelled'];

const REPORTS = [
  { value: 'investors', label: 'Investors',
    desc: 'Every investor account with KYC, bank and wallet position plus lifetime deposits and withdrawals.' },
  { value: 'deposits', label: 'Deposits', dates: true, statuses: DEPOSIT_STATUSES, method: true,
    desc: 'All deposit requests across manual bank transfer and the payment gateway.' },
  { value: 'withdrawals', label: 'Withdrawals', dates: true, statuses: WITHDRAWAL_STATUSES,
    desc: 'All withdrawal requests and how each one was processed.' },
  { value: 'trading', label: 'Trading', dates: true, statuses: ORDER_STATUSES, side: true,
    desc: 'Every order placed, with execution details and realised P&L.' },
  { value: 'portfolio', label: 'Portfolio',
    desc: 'Current holdings of every investor, valued at the latest market price.' },
  { value: 'activity', label: 'Activity', dates: true,
    desc: 'Investor and system activity trail (latest 1,000 entries).' },
  { value: 'audit', label: 'Audit', dates: true,
    desc: 'Every admin action — who did what, to which record, and when (latest 1,000 entries).' },
  { value: 'gateway-settlement', label: 'Gateway Settlement',
    desc: 'Reconciliation of payment-gateway records against platform deposits. Anything not MATCHED needs attention.' },
  { value: 'feed-health', label: 'Feed Health',
    desc: 'Market data feed uptime and every LIVE / DELAYED / DOWN transition.' },
];

// ---- dynamic column helpers ---------------------------------------------------
const ACRO = { id: 'ID', utr: 'UTR', ltp: 'LTP', pnl: 'P&L', kyc: 'KYC', txn: 'Txn' };
const pretty = (key) =>
  key.split('_').map((w) => ACRO[w] || w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const MONEY_RE = /(amount|balance|invested|market_value|pnl|price|ltp|deposited|withdrawn)/;
const DATE_RE = /(_at$|^at$|_time$)/;
const STATUS_RE = /(status|^side$|^method$)/;

const money = (v) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? (v ?? '—') : inr(v);

function ReconBadge({ value }) {
  const s = String(value || '');
  let tone = 'gray';
  if (s.startsWith('MATCHED')) tone = 'green';
  else if (/MISMATCH|INVESTIGATE|NO PLATFORM DEPOSIT|DIFFERENCE|NEVER COMPLETED/.test(s)) tone = 'red';
  else if (/PENDING|AWAITING|HELD/.test(s)) tone = 'amber';
  return <span className={`badge badge-${tone}`}>{s || '—'}</span>;
}

function buildColumns(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).map((key) => {
    const label = pretty(key);
    if (key === 'reconciliation') {
      return { key, label, render: (r) => <ReconBadge value={r[key]} /> };
    }
    if (STATUS_RE.test(key)) {
      return { key, label, render: (r) => (r[key] && r[key] !== '-' ? <StatusBadge status={r[key]} small /> : '—') };
    }
    if (MONEY_RE.test(key)) {
      return { key, label, align: 'right', render: (r) => money(r[key]) };
    }
    if (DATE_RE.test(key)) {
      return { key, label, render: (r) => fmtDateTime(r[key]) };
    }
    const sample = rows.find((r) => r[key] !== null && r[key] !== undefined && r[key] !== '');
    const numeric = sample ? typeof sample[key] === 'number' : false;
    return { key, label, align: numeric ? 'right' : 'left' };
  });
}

export default function Reports() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('report');
  const [report, setReport] = useState(REPORTS.some((r) => r.value === fromUrl) ? fromUrl : 'investors');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [side, setSide] = useState('');
  const [method, setMethod] = useState('');
  const [rows, setRows] = useState([]);
  const [feed, setFeed] = useState(null); // feed-health payload {current, uptime_pct, transitions}
  const [loading, setLoading] = useState(true);

  const def = REPORTS.find((r) => r.value === report);

  const path = useMemo(() => {
    const qs = new URLSearchParams();
    if (def.dates) {
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
    }
    if (def.statuses && status) qs.set('status', status);
    if (def.side && side) qs.set('side', side);
    if (def.method && method) qs.set('method', method);
    const q = qs.toString();
    return `/api/admin/reports/${report}${q ? `?${q}` : ''}`;
  }, [report, from, to, status, side, method, def]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const d = await api.get(path);
        if (!alive) return;
        if (report === 'feed-health') {
          setFeed(d);
          setRows([]);
        } else {
          setFeed(null);
          setRows(Array.isArray(d.rows) ? d.rows : []);
        }
      } catch (e) {
        if (alive) toast.error(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, report]);

  const changeReport = (v) => {
    setReport(v);
    setStatus('');
    setSide('');
    setMethod('');
    setParams(v === 'investors' ? {} : { report: v }, { replace: true });
  };

  const columns = useMemo(() => buildColumns(rows), [rows]);
  const keyed = useMemo(() => rows.map((r, i) => ({ ...r, _k: `r${i}` })), [rows]);

  const transitionCols = [
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} small /> },
    { key: 'detail', label: 'Detail', render: (r) => r.detail || '—' },
    { key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) },
  ];

  return (
    <>
      <h1 className="page-title">Reports</h1>
      <p className="page-sub">Operational and compliance reports — filter, review and export as CSV.</p>

      <Card>
        <div className="form-grid">
          <Field label="Report">
            <select className="select" value={report} onChange={(e) => changeReport(e.target.value)}>
              {REPORTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          {def.dates && (
            <Field label="From date">
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          )}
          {def.dates && (
            <Field label="To date">
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          )}
          {def.statuses && (
            <Field label="Status">
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {def.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
          {def.side && (
            <Field label="Side">
              <select className="select" value={side} onChange={(e) => setSide(e.target.value)}>
                <option value="">Buy & Sell</option>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </Field>
          )}
          {def.method && (
            <Field label="Method">
              <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">All methods</option>
                <option value="MANUAL">Manual bank transfer</option>
                <option value="GATEWAY">Payment gateway</option>
              </select>
            </Field>
          )}
        </div>
        <div className="row-between mt-2">
          <span className="small text-muted">{def.desc}</span>
          <a className="btn btn-sm" href={csvUrl(path)} download>Export CSV</a>
        </div>
      </Card>

      {loading ? (
        <Card className="mt-2"><Spinner label="Building report…" /></Card>
      ) : report === 'feed-health' && feed ? (
        <>
          <Card className="mt-2" title="Feed Health Monitor" subtitle="How reliable the market data feed has been"
            actions={<FeedBadge health={feed.current} />}>
            <div className="stat-grid">
              <Stat label="Uptime" value={`${feed.uptime_pct}%`}
                tone={feed.uptime_pct >= 99 ? 'green' : 'amber'}
                sub="Share of time the feed stayed LIVE" />
              <Stat label="Current Status" value={<StatusBadge status={feed.current?.status} />}
                sub={feed.current?.admin_paused ? 'Disconnected by admin (simulation)' : 'Automatic monitoring'} />
              <Stat label="Feed Mode" value={(feed.current?.mode || '—').toUpperCase()} sub="Price source" />
              <Stat label="Last Tick" value={fmtDateTime(feed.current?.last_tick_at)} sub="Most recent price update" />
            </div>
          </Card>
          <Card className="mt-2" title="Status Transitions" subtitle="Every change between LIVE, DELAYED and DOWN — newest first">
            <DataTable columns={transitionCols} rows={feed.transitions} keyField="id"
              empty="No feed transitions recorded yet." />
          </Card>
        </>
      ) : (
        <Card className="mt-2" title={`${def.label} Report`}
          actions={<span className="small text-muted">{rows.length} {rows.length === 1 ? 'record' : 'records'}</span>}>
          <DataTable columns={columns} rows={keyed} keyField="_k"
            empty="No records match these filters. Try widening the date range or clearing the status filter." />
        </Card>
      )}
    </>
  );
}
