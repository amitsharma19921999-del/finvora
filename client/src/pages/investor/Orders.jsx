// Investor — My Orders (BPD Stages 10-12). Order history with live status
// updates over SSE, cancellation of Pending orders, and CSV statement export.
// Lifecycle: Pending -> Executing -> Executed | Rejected | Cancelled.
import { useCallback, useEffect, useState } from 'react';
import { api, csvUrl, inr, num, fmtDateTime } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Executing', label: 'Executing' },
  { value: 'Executed', label: 'Executed' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Cancelled', label: 'Cancelled' },
];

export default function Orders() {
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (withSpinner) => {
    if (withSpinner) setLoading(true);
    try {
      const q = filter ? `?status=${encodeURIComponent(filter)}` : '';
      const d = await api.get(`/api/orders/mine${q}`);
      setOrders(d.orders || []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      if (withSpinner) setLoading(false);
    }
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(true); }, [load]);

  // Order status changes (Executing / Executed / Rejected) arrive as
  // notifications on the SSE stream — refresh the list quietly when they do.
  useEffect(() => {
    const un = subscribe('notification', () => load(false));
    return un;
  }, [load]);

  const doCancel = async () => {
    if (!cancelTarget) return;
    setBusy(true);
    try {
      const d = await api.post(`/api/orders/${cancelTarget.id}/cancel`);
      toast.success(d.message || 'Order cancelled.');
      setCancelTarget(null);
      await load(false);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: 'created_at', label: 'Placed',
      render: (r) => <span className="small">{fmtDateTime(r.created_at)}</span>,
    },
    {
      key: 'symbol', label: 'Stock',
      render: (r) => (
        <div>
          <span className="mono">{r.symbol}</span>
          <div className="tiny">{r.name}</div>
        </div>
      ),
    },
    { key: 'side', label: 'Side', render: (r) => <StatusBadge status={r.side} small /> },
    { key: 'qty', label: 'Qty', align: 'right', render: (r) => <span className="mono">{num(r.qty)}</span> },
    { key: 'price', label: 'Order Price', align: 'right', render: (r) => <span className="mono">{inr(r.price)}</span> },
    {
      key: 'ltp_at_order', label: 'LTP at Order', align: 'right',
      render: (r) => (
        <div>
          <span className="mono">{r.ltp_at_order != null ? inr(r.ltp_at_order) : '—'}</span>
          {r.feed_status_at_order === 'UNAVAILABLE' && (
            <div><span className="badge badge-amber badge-sm">feed offline</span></div>
          )}
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (r) => (
        <div>
          <StatusBadge status={r.status} />
          {r.reject_reason && <div className="tiny text-down">{r.reject_reason}</div>}
        </div>
      ),
    },
    {
      key: 'exec_price', label: 'Execution',
      render: (r) => (r.status === 'Executed' ? (
        <div className="small">
          <div className="mono">{inr(r.exec_price)} × {num(r.exec_qty != null ? r.exec_qty : r.qty)}</div>
          <div className="tiny">{fmtDateTime(r.exec_time)}</div>
        </div>
      ) : '—'),
    },
    {
      key: 'realized_pnl', label: 'Realised P&L', align: 'right',
      render: (r) => (r.realized_pnl == null ? '—' : (
        <span className={`mono ${Number(r.realized_pnl) >= 0 ? 'text-up' : 'text-down'}`}>
          {inr(r.realized_pnl)}
        </span>
      )),
    },
    {
      key: 'actions', label: '',
      render: (r) => (r.status === 'Pending' ? (
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setCancelTarget(r)}>
          Cancel
        </button>
      ) : null),
    },
  ];

  return (
    <div>
      <h1 className="page-title">My Orders</h1>
      <p className="page-sub">Every buy and sell order you have placed, with live status updates from our trading desk.</p>

      <Card
        title="Order History"
        actions={<a className="btn btn-sm" href={csvUrl('/api/statements/orders')} download>Export CSV</a>}
      >
        <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
          <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        </div>
        <div className="mt-2">
          {loading ? (
            <Spinner label="Loading your orders…" />
          ) : (
            <DataTable
              columns={columns}
              rows={orders}
              empty={filter
                ? `No ${filter.toLowerCase()} orders right now.`
                : 'You have not placed any orders yet. Head to the Trade screen to place your first order.'}
            />
          )}
        </div>
      </Card>

      <Modal
        open={!!cancelTarget}
        onClose={() => !busy && setCancelTarget(null)}
        title="Cancel this order?"
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCancelTarget(null)} disabled={busy}>
              Keep Order
            </button>
            <button type="button" className="btn btn-danger" onClick={doCancel} disabled={busy}>
              {busy ? 'Cancelling…' : 'Yes, Cancel Order'}
            </button>
          </>
        )}
      >
        {cancelTarget && (
          <>
            <p>You are about to cancel this pending order:</p>
            <p className="mono">
              {cancelTarget.side} {num(cancelTarget.qty)} × {cancelTarget.symbol} @ {inr(cancelTarget.price)}
            </p>
            <p className="small">
              No funds or holdings are affected — the order simply will not be sent for execution.
              Only Pending orders can be cancelled.
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}
