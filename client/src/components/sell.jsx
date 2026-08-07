// Sell-from-holdings ticket.
//
// Placing the order straight from the holding row (rather than routing to the
// trading terminal) is what makes F&O positions closable: option contracts are
// deliberately kept out of the live quote map / watchlist, so the terminal can
// never select them. The server prices them fine, so we post the order directly.
import { useState } from 'react';
import { api, inr, num } from '../api';
import { useToast, Modal, Field } from './ui';

export function SellModal({ holding, onClose, onDone }) {
  const toast = useToast();
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  if (!holding) return null;

  const max = Number(holding.qty) || 0;
  const ltp = Number(holding.ltp) || 0;
  const n = Number(qty) || 0;
  const est = n * ltp;
  const avg = Number(holding.avg_price) || 0;
  const pnl = n > 0 ? (ltp - avg) * n : 0;

  const submit = async (e) => {
    e?.preventDefault();
    if (!Number.isInteger(n) || n <= 0) { toast.error('Enter a whole quantity greater than zero.'); return; }
    if (n > max) { toast.error(`You hold only ${max} — cannot sell ${n}.`); return; }
    setBusy(true);
    try {
      const d = await api.post('/api/orders', { instrument_id: holding.instrument_id, side: 'SELL', qty: n });
      toast.success(d.message);
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={`Sell ${holding.symbol}`}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-sell" onClick={submit} disabled={busy || n <= 0}>
            {busy ? 'Placing…' : `Sell ${n > 0 ? num(n) : ''}`.trim()}
          </button>
        </>
      )}
    >
      <div className="row-between small"><span className="text-muted">Holding</span><b>{holding.name || holding.symbol}</b></div>
      <div className="row-between small"><span className="text-muted">You hold</span><b className="mono">{num(max)}</b></div>
      <div className="row-between small"><span className="text-muted">Avg. price</span><b className="mono">{inr(avg)}</b></div>
      <div className="row-between small"><span className="text-muted">Market price (LTP)</span><b className="mono">{inr(ltp)}</b></div>

      <form onSubmit={submit}>
        <Field label="Quantity to sell" required hint={`Maximum ${num(max)}.`}>
          <input
            className="input mono" type="number" min="1" max={max} step="1" inputMode="numeric"
            placeholder={`Up to ${max}`} value={qty} autoFocus
            onChange={(e) => setQty(e.target.value)}
          />
        </Field>
        <div className="row" style={{ gap: 8, marginTop: -4, marginBottom: 10, flexWrap: 'wrap' }}>
          {[25, 50, 100].map((p) => (
            <button key={p} type="button" className="btn btn-sm"
              onClick={() => setQty(String(Math.max(1, Math.floor((max * p) / 100))))}>
              {p}%
            </button>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setQty(String(max))}>All</button>
        </div>
      </form>

      <div className="row-between"><span className="small text-muted">Estimated proceeds</span><strong className="mono">{inr(est)}</strong></div>
      {n > 0 && (
        <div className="row-between">
          <span className="small text-muted">Estimated P&amp;L</span>
          <strong className={`mono ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
            {pnl >= 0 ? '+' : '−'}{inr(Math.abs(pnl))}
          </strong>
        </div>
      )}
      <p className="small text-muted mt-2">
        Sells execute at the live market price. Outside market hours the order is queued as an
        After-Market Order and fills at the next open.
      </p>
    </Modal>
  );
}
