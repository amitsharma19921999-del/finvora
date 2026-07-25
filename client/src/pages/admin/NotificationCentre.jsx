// Notification Centre (BPD 4.1) — the admin's real-time event stream. New
// events are pushed over the live connection via useNotifications(); no
// polling, no refresh button needed. Rows deep-link into the matching queue.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../../api';
import { useToast, Card, Segmented, Spinner, EmptyState } from '../../components/ui';
import { useNotifications } from '../../components/market';

// Which queue a notification points at, by its ref_table.
const REF_ROUTE = {
  kyc: '/admin/kyc',
  bank_accounts: '/admin/bank',
  deposits: '/admin/deposits',
  orders: '/admin/orders',
  withdrawals: '/admin/withdrawals',
};

// Filter groups over the admin notification types the server emits.
const GROUPS = {
  kyc: ['KYC_SUBMITTED', 'BANK_SUBMITTED'],
  deposits: ['DEPOSIT_REQUEST', 'DEPOSIT_AUTO_APPROVED'],
  orders: ['BUY_ORDER', 'SELL_ORDER', 'ORDER_CANCELLED'],
  withdrawals: ['WITHDRAWAL_REQUEST'],
  alerts: ['GATEWAY_PAYMENT_FAILED', 'GATEWAY_MISMATCH', 'FEED_DISCONNECTED'],
};

const NOTIF_ICON = {
  KYC_SUBMITTED: '🪪', BANK_SUBMITTED: '🏦',
  DEPOSIT_REQUEST: '💰', DEPOSIT_AUTO_APPROVED: '✅',
  BUY_ORDER: '📈', SELL_ORDER: '📉', ORDER_CANCELLED: '🚫',
  WITHDRAWAL_REQUEST: '🏧',
  GATEWAY_PAYMENT_FAILED: '⚠️', GATEWAY_MISMATCH: '⚠️', FEED_DISCONNECTED: '📡',
};

function notifTarget(n) {
  if (n.ref_table && REF_ROUTE[n.ref_table]) return REF_ROUTE[n.ref_table];
  if (n.type === 'FEED_DISCONNECTED') return '/admin/feed';
  return null;
}

export default function NotificationCentre() {
  const toast = useToast();
  const navigate = useNavigate();
  const { items, unread, markAllRead, reload } = useNotifications();
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // The hook loads in the background; await one reload so we can show a
  // proper spinner instead of flashing an empty state.
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, [reload]);

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    const types = GROUPS[filter] || [];
    return items.filter((n) => types.includes(n.type));
  }, [items, filter]);

  const onMarkAllRead = async () => {
    setBusy(true);
    try {
      await markAllRead();
      toast.success('All notifications marked as read.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openNotification = async (n) => {
    const to = notifTarget(n);
    if (!n.is_read) {
      // Mark just this one read; best-effort — navigation should never block on it.
      try { await api.post('/api/notifications/read', { ids: [n.id] }); } catch { /* ignore */ }
    }
    if (to) navigate(to);
    else reload();
  };

  const emptyText = {
    all: 'New KYC submissions, deposits, orders, withdrawal requests and system alerts will appear here the moment they happen.',
    kyc: 'No KYC or bank submissions waiting. New ones will appear here instantly.',
    deposits: 'No deposit events yet. New deposit requests and auto-approvals will appear here instantly.',
    orders: 'No order events yet. New buy/sell orders and investor cancellations will appear here instantly.',
    withdrawals: 'No withdrawal requests yet. New ones will appear here instantly.',
    alerts: 'No system alerts — no gateway failures, amount mismatches or feed disconnections right now.',
  };

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Notification Centre</h1>
          <p className="page-sub">Updates in real time — new events appear the moment they happen, no refresh needed.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onMarkAllRead}
          disabled={busy || unread === 0}
        >
          {busy ? 'Marking…' : `Mark all read${unread > 0 ? ` (${unread})` : ''}`}
        </button>
      </div>

      <div className="mt-1" style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'kyc', label: 'KYC' },
            { value: 'deposits', label: 'Deposits' },
            { value: 'orders', label: 'Orders' },
            { value: 'withdrawals', label: 'Withdrawals' },
            { value: 'alerts', label: 'Alerts' },
          ]}
        />
      </div>

      <Card className="mt-2" pad={false}>
        <div className="card-body">
          {loading ? (
            <Spinner label="Loading notifications…" />
          ) : filtered.length === 0 ? (
            <EmptyState icon="🔔" title="Nothing here yet." text={emptyText[filter]} />
          ) : (
            filtered.map((n) => {
              const to = notifTarget(n);
              return (
                <div
                  key={n.id}
                  className={`notif${!n.is_read ? ' notif-unread' : ''}`}
                  style={to ? { cursor: 'pointer' } : undefined}
                  role={to ? 'link' : undefined}
                  tabIndex={to ? 0 : undefined}
                  title={to ? 'Open the related queue' : undefined}
                  onClick={() => openNotification(n)}
                  onKeyDown={(e) => { if (to && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNotification(n); } }}
                >
                  <span className="notif-icon" aria-hidden>{NOTIF_ICON[n.type] || '🔔'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="notif-title">{n.title}</div>
                    {n.body && <div className="notif-body">{n.body}</div>}
                  </div>
                  <span className="notif-time">{timeAgo(n.created_at)}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </>
  );
}
