// Admin Dashboard — operations overview (BPD Section 4). Every counter is a
// shortcut into its work queue, and the feed-health card mirrors Stage 9.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, num } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Stat, Spinner, EmptyState } from '../../components/ui';
import { FeedBadge } from '../../components/market';

// A stat tile that acts as a shortcut into the matching admin queue.
function ClickStat({ to, label, value, sub, tone }) {
  const navigate = useNavigate();
  return (
    <div
      role="link"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      title={`Open ${label}`}
      onClick={() => navigate(to)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(to); } }}
    >
      <Stat label={label} value={value} sub={sub} tone={tone} />
    </div>
  );
}

export default function Dashboard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/dashboard');
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    // A new admin notification means a queue changed — refresh the counters.
    const un1 = subscribe('notification', () => load());
    // Keep the feed-health card live without a full reload.
    const un2 = subscribe('feedHealth', (h) => setData((prev) => (prev ? { ...prev, feed: h } : prev)));
    return () => { un1(); un2(); };
  }, [load]);

  if (loading && !data) {
    return (
      <>
        <h1 className="page-title">Operations dashboard</h1>
        <p className="page-sub">Everything that needs your attention, in one place.</p>
        <Spinner label="Loading dashboard…" />
      </>
    );
  }

  if (!data) {
    return (
      <>
        <h1 className="page-title">Operations dashboard</h1>
        <p className="page-sub">Everything that needs your attention, in one place.</p>
        <EmptyState
          icon="📡"
          title="Could not load the dashboard."
          text="Check your connection and try again."
          action={<button type="button" className="btn btn-primary btn-sm" onClick={() => { setLoading(true); load(); }}>Retry</button>}
        />
      </>
    );
  }

  const feed = data.feed;

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Operations dashboard</h1>
          <p className="page-sub">Live overview — counters refresh automatically as investor activity comes in.</p>
        </div>
        <FeedBadge health={feed} asOf={feed?.last_tick_at} />
      </div>

      <div className="stat-grid">
        <ClickStat to="/admin/investors" label="Investors" value={num(data.investors_total)}
          sub={`${num(data.investors_active)} with active accounts`} />
        <ClickStat to="/admin/kyc" label="KYC Pending" value={num(data.kyc_pending)}
          sub="Awaiting document review" />
        <ClickStat to="/admin/bank" label="Bank Pending" value={num(data.bank_pending)}
          sub="Awaiting bank verification" />
        <ClickStat to="/admin/deposits" label="Deposits Pending" value={num(data.deposits_pending)}
          sub="Awaiting verification" />
        <ClickStat to="/admin/deposits" label="Needs Review" value={num(data.deposits_review)}
          tone={data.deposits_review > 0 ? 'amber' : undefined}
          sub={data.deposits_review > 0 ? 'Gateway deposits need reconciliation' : 'No gateway exceptions'} />
        <ClickStat to="/admin/orders" label="Open Orders" value={num(data.orders_open)}
          sub="Pending or executing" />
        <ClickStat to="/admin/withdrawals" label="Open Withdrawals" value={num(data.withdrawals_open)}
          sub="Pending or processing" />
        <ClickStat to="/admin/deposits" label="Deposits Today" value={inr(data.deposits_today)}
          sub="Approved and credited today" />
        <ClickStat to="/admin/withdrawals" label="Withdrawals Today" value={inr(data.withdrawals_today)}
          sub="Completed transfers today" />
      </div>

      <div>
        <Card
          title="Market data feed"
          subtitle="Investor dashboards flag prices as Delayed or Unavailable the moment the feed degrades."
          actions={<Link className="btn btn-sm" to="/admin/feed">Open feed monitor</Link>}
        >
          <div className="row-between">
            <FeedBadge health={feed} asOf={feed?.last_tick_at} />
            {feed?.mode && <span className="small text-muted mono">Mode: {feed.mode}</span>}
          </div>
          {feed?.admin_paused && (
            <div className="banner banner-warn mt-2">
              The feed is manually paused. Investors are seeing stale prices — reconnect it from the feed monitor when ready.
            </div>
          )}
          {!feed?.admin_paused && feed?.status === 'DOWN' && (
            <div className="banner banner-danger mt-2">
              The feed is down. Investor prices are flagged Unavailable until it recovers.
            </div>
          )}
          {!feed?.admin_paused && feed?.status === 'DELAYED' && (
            <div className="banner banner-warn mt-2">
              Ticks have gone stale. Investor prices are flagged Delayed until fresh data arrives.
            </div>
          )}
        </Card>

      </div>
    </>
  );
}
