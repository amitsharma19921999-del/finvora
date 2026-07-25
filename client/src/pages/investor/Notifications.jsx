// Investor — Notifications inbox. Live-updating via useNotifications() (SSE):
// KYC and bank reviews, deposit outcomes, order executions, withdrawals and
// account activation all land here the moment they happen.
import { useState } from 'react';
import { timeAgo } from '../../api';
import { useToast, Card, EmptyState } from '../../components/ui';
import { useNotifications } from '../../components/market';

// Server notification types are prefixed (KYC_STATUS, DEPOSIT_APPROVED,
// ORDER_EXECUTED, WITHDRAWAL_STATUS, ACCOUNT_ACTIVATED, BANK_STATUS…).
const ICONS = [
  ['KYC', '🪪'],
  ['DEPOSIT', '💰'],
  ['ORDER', '⚡'],
  ['WITHDRAW', '🏦'],
  ['BANK', '🏦'],
  ['ACCOUNT', '🎉'],
];

function iconFor(type) {
  const t = String(type || '').toUpperCase();
  const hit = ICONS.find(([key]) => t.includes(key));
  return hit ? hit[1] : '🔔';
}

export default function Notifications() {
  const toast = useToast();
  const { items, unread, markAllRead } = useNotifications();
  const [busy, setBusy] = useState(false);

  const onMarkAll = async () => {
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

  return (
    <div>
      <h1 className="page-title">Notifications</h1>
      <p className="page-sub">Real-time updates on your KYC, deposits, orders and withdrawals — no refresh needed.</p>

      <Card
        title="Inbox"
        subtitle={unread > 0 ? `${unread} unread` : 'You are all caught up'}
        actions={(
          <button type="button" className="btn btn-sm" onClick={onMarkAll} disabled={busy || unread === 0}>
            {busy ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      >
        {items.length === 0 ? (
          <EmptyState
            icon="🔔"
            title="No notifications yet"
            text="Updates about your account, deposits, orders and withdrawals will appear here the moment they happen."
          />
        ) : (
          <div>
            {items.map((n, i) => (
              <div
                key={n.id != null ? n.id : `live-${i}`}
                className={`notif${n.is_read ? '' : ' notif-unread'}`}
              >
                <span className="notif-icon" aria-hidden>{iconFor(n.type)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="notif-title">{n.title}</div>
                  <div className="notif-body">{n.body}</div>
                </div>
                <span className="notif-time">{timeAgo(n.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
