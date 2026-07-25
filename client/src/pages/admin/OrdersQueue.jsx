// Admin — Trade Execution Management (BPD Stage 11).
// Review incoming orders, execute at a confirmed price, or reject/cancel with a
// reason the investor sees. Live LTP + feed health shown so the desk always
// knows the state of market data while executing.
import { useCallback, useEffect, useState } from 'react';
import { api, inr, num, fmtDateTime } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, EmptyState, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice } from '../../components/market';

const SEGMENTS = [
  { value: 'Open', label: 'Open' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Executing', label: 'Executing' },
  { value: 'Executed', label: 'Executed' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Cancelled', label: 'Cancelled' },
  { value: 'All', label: 'All' },
];

const REJECT_REASONS = ['Insufficient Balance', 'Market Closed', 'Invalid Quantity', 'Invalid Instrument'];

export default function OrdersQueue() {
  const toast = useToast();
  const { byId, health, asOf } = useLivePrices();
  const [orders, setOrders] = useState(null);
  const [seg, setSeg] = useState('Open');
  const [busyRow, setBusyRow] = useState(null); // order id currently mutating

  // Execute… modal
  const [execOrder, setExecOrder] = useState(null);
  const [execPrice, setExecPrice] = useState('');
  const [execQty, setExecQty] = useState('');
  const [execBusy, setExecBusy] = useState(false);

  // Reject… modal
  const [rejectOrder, setRejectOrder] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/orders');
      setOrders(d.orders);
    } catch (e) {
      toast.error(e.message);
      setOrders((prev) => prev || []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // New orders / status changes raise admin notifications — refresh the queue live.
  useEffect(() => subscribe('notification', () => load()), [load]);

  const liveLtp = (o) => {
    const q = byId.get(o.instrument_id);
    return q ? q.ltp : o.ltp;
  };

  const doAction = async (order, body, okFallback) => {
    setBusyRow(order.id);
    try {
      const d = await api.post(`/api/admin/orders/${order.id}/status`, body);
      toast.success(d.message || okFallback);
      await load();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusyRow(null);
    }
  };

  const openExecute = (o) => {
    const ltp = liveLtp(o);
    setExecPrice(ltp != null ? Number(ltp).toFixed(2) : String(o.price));
    setExecQty(String(o.qty));
    setExecOrder(o);
  };

  const submitExecute = async () => {
    if (!execOrder) return;
    const px = Number(execPrice);
    const qty = Number(execQty);
    if (!(px > 0)) { toast.error('Enter a valid execution price.'); return; }
    if (!Number.isInteger(qty) || qty <= 0 || qty > execOrder.qty) {
      toast.error(`Execution quantity must be between 1 and ${execOrder.qty}.`);
      return;
    }
    setExecBusy(true);
    try {
      const d = await api.post(`/api/admin/orders/${execOrder.id}/status`, {
        action: 'executed', exec_price: px, exec_qty: qty,
      });
      toast.success(d.message || 'Order executed.');
      setExecOrder(null);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExecBusy(false);
    }
  };

  const submitReject = async () => {
    if (!rejectOrder) return;
    if (!rejectReason.trim()) { toast.error('Please give the investor a reason for the rejection.'); return; }
    setRejectBusy(true);
    try {
      const d = await api.post(`/api/admin/orders/${rejectOrder.id}/status`, {
        action: 'reject', reason: rejectReason.trim(),
      });
      toast.success(d.message || 'Order rejected.');
      setRejectOrder(null);
      setRejectReason('');
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRejectBusy(false);
    }
  };

  const rows = (orders || []).filter((o) => {
    if (seg === 'All') return true;
    if (seg === 'Open') return o.status === 'Pending' || o.status === 'Executing';
    return o.status === seg;
  });
  const openCount = (orders || []).filter((o) => o.status === 'Pending' || o.status === 'Executing').length;

  const columns = [
    { key: 'created_at', label: 'Placed', render: (o) => <span className="small">{fmtDateTime(o.created_at)}</span> },
    {
      key: 'mobile', label: 'Investor',
      render: (o) => (
        <div>
          <div className="mono">{o.mobile}</div>
          {o.email && <div className="small text-muted">{o.email}</div>}
        </div>
      ),
    },
    {
      key: 'symbol', label: 'Instrument',
      render: (o) => (
        <div>
          <span className="strong">{o.symbol}</span>
          {o.feed_status_at_order === 'UNAVAILABLE' && (
            <div><span className="badge badge-red badge-sm" title="The live market feed was unavailable when the investor placed this order — verify the price carefully before executing.">Feed was UNAVAILABLE</span></div>
          )}
        </div>
      ),
    },
    { key: 'side', label: 'Side', render: (o) => <StatusBadge status={o.side} small /> },
    { key: 'qty', label: 'Qty', align: 'right', render: (o) => <span className="mono">{num(o.qty)}</span> },
    { key: 'price', label: 'Order Price', align: 'right', render: (o) => <span className="mono">{inr(o.price)}</span> },
    {
      key: 'ltp', label: 'Live LTP', align: 'right',
      render: (o) => (liveLtp(o) != null ? <LivePrice value={liveLtp(o)} /> : <span className="text-muted">—</span>),
    },
    {
      key: 'status', label: 'Status',
      render: (o) => (
        <div>
          <StatusBadge status={o.status} />
          {o.status === 'Rejected' && o.reject_reason && (
            <div className="small text-muted">{o.reject_reason}</div>
          )}
        </div>
      ),
    },
    {
      key: 'exec', label: 'Execution',
      render: (o) => {
        if (o.status !== 'Executed') return <span className="text-muted">—</span>;
        return (
          <div className="small">
            <div className="mono">{num(o.exec_qty)} @ {inr(o.exec_price)}</div>
            <div className="text-muted">{fmtDateTime(o.exec_time)}</div>
            {o.realized_pnl != null && (
              <div className={o.realized_pnl >= 0 ? 'text-up' : 'text-down'}>
                P&L {inr(o.realized_pnl)}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'actions', label: 'Actions',
      render: (o) => {
        if (o.status !== 'Pending' && o.status !== 'Executing') return <span className="text-muted">—</span>;
        const busy = busyRow === o.id;
        return (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {o.status === 'Pending' && (
              <button type="button" className="btn btn-warn btn-sm" disabled={busy}
                onClick={() => doAction(o, { action: 'executing' }, 'Order moved to Executing.')}>
                Start Executing
              </button>
            )}
            <button type="button" className="btn btn-success btn-sm" disabled={busy} onClick={() => openExecute(o)}>
              Execute…
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy}
              onClick={() => { setRejectReason(''); setRejectOrder(o); }}>
              Reject…
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => doAction(o, { action: 'cancel' }, 'Order cancelled.')}>
              Cancel
            </button>
          </div>
        );
      },
    },
  ];

  const execLtp = execOrder ? liveLtp(execOrder) : null;

  return (
    <div>
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Trade Execution</h1>
          <p className="page-sub">
            Review investor buy and sell orders, execute them at the confirmed market price, or reject
            with a reason the investor will see. Open orders appear here the moment they are placed.
          </p>
        </div>
        <FeedBadge health={health} asOf={asOf} />
      </div>

      <Card
        title="Orders Queue"
        subtitle={openCount > 0 ? `${openCount} open order${openCount === 1 ? '' : 's'} awaiting action` : 'No orders awaiting action'}
        actions={<Segmented options={SEGMENTS} value={seg} onChange={setSeg} />}
      >
        {orders === null ? (
          <Spinner label="Loading orders…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🧾"
            title={seg === 'Open' ? 'No open orders right now.' : `No ${seg === 'All' ? '' : seg.toLowerCase() + ' '}orders found.`}
            text={seg === 'Open' ? 'New buy and sell orders appear here instantly — no refresh needed.' : 'Try a different filter above.'}
          />
        ) : (
          <DataTable columns={columns} rows={rows} keyField="id" empty="No orders found." />
        )}
      </Card>

      {/* ---- Execute… modal ---- */}
      <Modal
        open={!!execOrder}
        onClose={() => !execBusy && setExecOrder(null)}
        title="Execute Order"
        footer={execOrder && (
          <>
            <button type="button" className="btn btn-ghost" disabled={execBusy} onClick={() => setExecOrder(null)}>
              Back
            </button>
            <button type="button" className={`btn ${execOrder.side === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
              disabled={execBusy} onClick={submitExecute}>
              {execBusy ? 'Executing…' : `Confirm ${execOrder.side === 'BUY' ? 'Buy' : 'Sell'} Execution`}
            </button>
          </>
        )}
      >
        {execOrder && (
          <div>
            <div className="banner banner-info">
              <span className="strong">{execOrder.side === 'BUY' ? 'Buying' : 'Selling'} {num(execOrder.qty)} × {execOrder.symbol}</span>
              {' '}for investor <span className="mono">{execOrder.mobile}</span> · order price {inr(execOrder.price)}
              {execLtp != null && <> · live LTP <LivePrice value={execLtp} /></>}
            </div>
            {execOrder.feed_status_at_order === 'UNAVAILABLE' && (
              <div className="banner banner-warn">
                The market feed was unavailable when this order was placed — double-check the execution price against the live market.
              </div>
            )}
            <div className="form-grid mt-1">
              <Field label="Execution price (₹)" required hint="Pre-filled with the live market price — adjust to the actual fill price.">
                <input className="input" type="number" min="0.05" step="0.05" value={execPrice}
                  onChange={(e) => setExecPrice(e.target.value)} disabled={execBusy} />
              </Field>
              <Field label="Execution quantity" required hint={`Up to ${num(execOrder.qty)} (the ordered quantity).`}>
                <input className="input" type="number" min="1" max={execOrder.qty} step="1" value={execQty}
                  onChange={(e) => setExecQty(e.target.value)} disabled={execBusy} />
              </Field>
            </div>
            {Number(execPrice) > 0 && Number(execQty) > 0 && (
              <p className="small text-muted mt-1">
                Trade value: <span className="mono strong">{inr(Number(execPrice) * Number(execQty))}</span>
                {execOrder.side === 'BUY'
                  ? ' — will be debited from the investor’s wallet and added to holdings.'
                  : ' — will be credited to the investor’s wallet; realised P&L is booked automatically.'}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* ---- Reject… modal ---- */}
      <Modal
        open={!!rejectOrder}
        onClose={() => !rejectBusy && setRejectOrder(null)}
        title="Reject Order"
        footer={rejectOrder && (
          <>
            <button type="button" className="btn btn-ghost" disabled={rejectBusy} onClick={() => setRejectOrder(null)}>
              Back
            </button>
            <button type="button" className="btn btn-danger" disabled={rejectBusy || !rejectReason.trim()} onClick={submitReject}>
              {rejectBusy ? 'Rejecting…' : 'Reject Order'}
            </button>
          </>
        )}
      >
        {rejectOrder && (
          <div>
            <p className="small">
              Rejecting <span className="strong">{rejectOrder.side} {num(rejectOrder.qty)} × {rejectOrder.symbol}</span> for
              investor <span className="mono">{rejectOrder.mobile}</span>. Any reserved funds are released back to their wallet,
              and the reason below is shown to the investor.
            </p>
            <div className="row mt-1" style={{ flexWrap: 'wrap' }}>
              {REJECT_REASONS.map((r) => (
                <button key={r} type="button" className="btn btn-outline btn-sm" disabled={rejectBusy}
                  onClick={() => setRejectReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <Field label="Reason (visible to the investor)" required>
              <textarea className="input" rows="3" value={rejectReason} disabled={rejectBusy}
                placeholder="e.g. Insufficient Balance — wallet does not cover this order."
                onChange={(e) => setRejectReason(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
