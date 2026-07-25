// Feed Monitor — live market-data health, disconnect simulation and transition log.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, timeAgo } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Stat, Spinner, DataTable, Modal, StatusBadge } from '../../components/ui';
import { FeedBadge } from '../../components/market';

export default function FeedMonitor() {
  const toast = useToast();
  const [health, setHealth] = useState(null);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async (silent) => {
    try {
      const d = await api.get('/api/admin/feed');
      setHealth(d.health);
      setLog(d.log);
    } catch (e) {
      if (!silent) toast.error(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    // Live updates the moment the feed changes state anywhere in the system.
    const un = subscribe('feedHealth', (h) => {
      setHealth(h);
      load(true); // refresh the transitions log too
    });
    return un;
  }, [load]);

  const toggle = async (paused) => {
    setBusy(true);
    try {
      const d = await api.post('/api/admin/feed/toggle', { paused });
      toast.success(d.message);
      setHealth(d.health);
      setConfirmOpen(false);
      load(true);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cols = [
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} small /> },
    { key: 'detail', label: 'Detail', render: (r) => r.detail || '—' },
    { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
  ];

  if (loading) return <Spinner label="Checking feed health…" />;

  const paused = Boolean(health?.admin_paused);

  return (
    <>
      <h1 className="page-title">Feed Monitor</h1>
      <p className="page-sub">Live market data feed — status, controls and transition history.</p>

      <Card
        title="Market Data Feed"
        subtitle="Prices across every dashboard depend on this feed"
        actions={<FeedBadge health={health} />}
      >
        {paused && (
          <div className="banner banner-danger">
            The feed is disconnected by admin (simulation). Investor dashboards are flagging prices as
            Delayed / Unavailable and new orders cannot be price-validated until you reconnect.
          </div>
        )}
        <div className="stat-grid">
          <Stat label="Status" value={<StatusBadge status={health?.status} />}
            sub={paused ? 'Manually disconnected' : 'Automatic monitoring'} />
          <Stat label="Feed Mode" value={(health?.mode || '—').toUpperCase()} sub="Price source" />
          <Stat label="Last Tick" value={health?.last_tick_at ? timeAgo(health.last_tick_at) : '—'}
            sub={fmtDateTime(health?.last_tick_at)} />
          <Stat label="Admin Override" value={paused ? 'Disconnected' : 'None'}
            tone={paused ? 'down' : 'green'}
            sub={paused ? 'Reconnect to resume live prices' : 'Feed running normally'} />
        </div>
        <div className="row mt-2">
          {paused ? (
            <button type="button" className="btn btn-success btn-lg" disabled={busy} onClick={() => toggle(false)}>
              {busy ? 'Reconnecting…' : 'Reconnect Feed'}
            </button>
          ) : (
            <button type="button" className="btn btn-danger btn-lg" onClick={() => setConfirmOpen(true)}>
              Simulate Feed Disconnect
            </button>
          )}
        </div>
      </Card>

      <Card
        className="mt-2"
        title="Transition Log"
        subtitle="Every change between LIVE, DELAYED and DOWN — newest first"
        actions={<Link className="btn btn-ghost btn-sm" to="/admin/reports?report=feed-health">Feed Health report</Link>}
      >
        <DataTable columns={cols} rows={log} keyField="id" empty="No feed transitions recorded yet." />
      </Card>

      <Modal
        open={confirmOpen}
        onClose={() => !busy && setConfirmOpen(false)}
        title="Simulate a feed disconnect?"
        footer={
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => toggle(true)}>
              {busy ? 'Disconnecting…' : 'Disconnect Feed'}
            </button>
          </>
        }
      >
        <p>This pauses the live market data feed to test how the platform behaves when prices stop arriving.</p>
        <ul className="small">
          <li>Every dashboard will flag prices as <strong>Data Delayed</strong>, then <strong>Feed Unavailable</strong>.</li>
          <li>New orders cannot be validated against the live price band while the feed is down.</li>
          <li>Admin receives a <strong>Feed Disconnected</strong> alert and the transition is logged.</li>
        </ul>
        <p className="small text-muted">You can reconnect at any time — live prices resume immediately.</p>
      </Modal>
    </>
  );
}
