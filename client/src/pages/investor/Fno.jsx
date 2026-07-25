// F&O · Options Chain — a broker-grade, TRADABLE option chain derived from the
// live spot. Underlyings drive a chip selector; picking one loads
// /api/markets/options and renders CALLS | STRIKE | PUTS. Tap any Call/Put LTP to
// open an order ticket: the contract is materialised via
// /api/markets/options/select and the trade goes through the normal /orders
// pipeline (fixed premium, lots × lot size). Premiums track the spot — the chain
// refetches on every 'prices' tick, throttled to at most once per ~4s.
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, num } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Segmented, Spinner, EmptyState, Modal, Field } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice, ChangePct } from '../../components/market';

// Option LTP / premiums render as plain 2-decimal numbers (no ₹) — exactly how a
// real option chain shows them.
const fmt2 = (n) =>
  Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

// Two stacked semi-transparent layers of the same variable deepen the wash for the
// in-the-money side — keeps us strictly on CSS variables (no raw colours).
const DEEP_GREEN = 'linear-gradient(var(--up-soft), var(--up-soft)), var(--up-soft)';
const DEEP_RED = 'linear-gradient(var(--down-soft), var(--down-soft)), var(--down-soft)';

const DEFAULT_SYMBOL = 'NIFTY 50';

// ---- Order ticket for a single option contract -----------------------------
function OptionTicket({ ctx, onClose, onPlaced }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [side, setSide] = useState('BUY');
  const [lots, setLots] = useState('1');
  const [sel, setSel] = useState(null); // { instrument_id, lot_size, ltp } from /select
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Materialise the contract + fetch its live premium when the ticket opens.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.post('/api/markets/options/select', {
      underlying: ctx.underlying, expiry: ctx.expiry, strike: ctx.strike, opt_type: ctx.opt_type,
    })
      .then((d) => { if (alive) setSel(d); })
      .catch((e) => { if (alive) { toast.error(e.message); onClose(); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lotSize = sel?.lot_size || ctx.lot_size || 1;
  const premium = sel?.ltp ?? ctx.premium ?? 0;
  const nLots = Math.max(0, Math.floor(Number(lots) || 0));
  const qty = nLots * lotSize;
  const total = qty * premium;
  const isCall = ctx.opt_type === 'CE';

  const submit = async () => {
    if (!sel || nLots < 1) return;
    setBusy(true);
    try {
      const out = await api.post('/api/orders', { instrument_id: sel.instrument_id, side, qty });
      if (out.auto_rejected) toast.error(out.message);
      else toast.success(out.message || 'Order placed.');
      onPlaced?.();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? undefined : onClose}
      title={`${ctx.underlying} ${num(ctx.strike)} ${ctx.opt_type} · ${shortDate(ctx.expiry)}`}>
      {loading ? (
        <Spinner label="Fetching contract…" />
      ) : (
        <div>
          {/* Buy / Sell */}
          <Segmented
            value={side}
            onChange={setSide}
            options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell (square off)' }]}
          />

          <div className="grid-2 mt-2" style={{ gap: 14 }}>
            <div>
              <div className="small text-muted">Premium (LTP)</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{fmt2(premium)}</div>
              <div className="small text-muted mt-1">Fixed to live market — you choose only the lots.</div>
            </div>
            <div>
              <div className="small text-muted">Lot size</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{lotSize}</div>
              <div className="small text-muted mt-1">{isCall ? 'Call option' : 'Put option'}</div>
            </div>
          </div>

          <div className="mt-2">
            <Field label="Lots" hint={`Quantity = ${nLots || 0} × ${lotSize} = ${num(qty)} units`} required>
              <input
                className="input mono" type="number" inputMode="numeric" min="1" step="1"
                value={lots} onChange={(e) => setLots(e.target.value)}
                style={{ maxWidth: 160 }}
              />
            </Field>
          </div>

          <div className="row-between mt-2" style={{ alignItems: 'baseline' }}>
            <span className="small text-muted">{side === 'BUY' ? 'Total premium payable' : 'Total premium receivable'}</span>
            <span className="mono" style={{ fontSize: 20, fontWeight: 700 }}>₹{fmt2(total)}</span>
          </div>

          {side === 'SELL' && (
            <div className="banner banner-info small mt-2">
              Selling squares off an option you already hold. To open a fresh short you must first hold the contract.
            </div>
          )}

          <div className="row mt-2" style={{ gap: 10 }}>
            <button
              type="button"
              className={`btn btn-lg ${side === 'BUY' ? 'btn-success' : 'btn-danger'}`}
              disabled={busy || nLots < 1 || !(premium > 0)}
              onClick={submit}
              style={{ flex: 1 }}
            >
              {busy ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${nLots || 0} lot${nLots === 1 ? '' : 's'} · ₹${fmt2(total)}`}
            </button>
            <button type="button" className="btn btn-ghost btn-lg" disabled={busy} onClick={onClose}>Cancel</button>
          </div>

          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => navigate('/app/orders')}>
            View my orders →
          </button>
        </div>
      )}
    </Modal>
  );
}

export default function Fno() {
  const toast = useToast();
  const { health, asOf } = useLivePrices();

  const [underlyings, setUnderlyings] = useState([]);
  const [loadingU, setLoadingU] = useState(true);

  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [options, setOptions] = useState(null);
  const [loadingChain, setLoadingChain] = useState(true);
  const [expiry, setExpiry] = useState(null);
  const [ticket, setTicket] = useState(null); // { underlying, expiry, strike, opt_type, premium, lot_size }

  // Keep the latest selected symbol / expiry reachable from the tick handler.
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const expiryRef = useRef(expiry);
  expiryRef.current = expiry;
  const lastFetch = useRef(0);

  // ---- Underlyings (once) -----------------------------------------------------
  useEffect(() => {
    let alive = true;
    api
      .get('/api/markets/underlyings')
      .then((d) => {
        if (!alive) return;
        const list = d?.underlyings || [];
        setUnderlyings(list);
        if (list.length && !list.some((u) => u.symbol === DEFAULT_SYMBOL)) {
          setSymbol(list[0].symbol);
        }
      })
      .catch((e) => toast?.error?.(e.message))
      .finally(() => alive && setLoadingU(false));
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Chain fetch (stable) — server echoes the expiry it priced -------------
  const fetchChain = useCallback(async (sym, exp) => {
    lastFetch.current = Date.now();
    try {
      const url = `/api/markets/options?symbol=${encodeURIComponent(sym)}${exp ? `&expiry=${encodeURIComponent(exp)}` : ''}`;
      const d = await api.get(url);
      setOptions(d);
      setExpiry(d?.expiry || d?.expiries?.[0] || null);
    } catch (e) {
      toast?.error?.(e.message);
    } finally {
      setLoadingChain(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload the chain whenever the selected underlying changes (nearest expiry).
  useEffect(() => {
    if (!symbol) return;
    setLoadingChain(true);
    fetchChain(symbol, null);
  }, [symbol, fetchChain]);

  // Switching expiry re-prices the chain for that expiry.
  const onExpiry = (exp) => { setExpiry(exp); fetchChain(symbolRef.current, exp); };

  // Keep premiums live — refetch on ticks (current symbol + expiry), throttled.
  useEffect(() => {
    const un = subscribe('prices', () => {
      if (Date.now() - lastFetch.current < 4000) return;
      const sym = symbolRef.current;
      if (sym) fetchChain(sym, expiryRef.current);
    });
    return un;
  }, [fetchChain]);

  if (loadingU) return <Spinner label="Loading markets…" />;

  const selected = underlyings.find((u) => u.symbol === symbol);
  const spot = options?.spot;
  const rows = options?.rows || [];
  const lotSize = options?.lot_size || 1;
  const expiries = options?.expiries || [];
  const expiryOptions = expiries.map((e) => ({ value: e, label: shortDate(e) }));

  const chips = [...underlyings].sort(
    (a, b) => (a.kind === 'index' ? 0 : 1) - (b.kind === 'index' ? 0 : 1),
  );

  const openTicket = (strike, opt_type, premium) =>
    setTicket({ underlying: symbol, expiry, strike, opt_type, premium, lot_size: lotSize });

  // ---- shared cell styling ----------------------------------------------------
  const cell = {
    fontVariantNumeric: 'tabular-nums',
    fontSize: 13,
    padding: '8px 14px',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)',
  };
  const ltpCell = { ...cell, cursor: 'pointer' };
  const groupTh = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.09em',
    textTransform: 'uppercase',
    padding: '9px 14px',
    textAlign: 'center',
    borderBottom: '1px solid var(--border)',
  };
  const colTh = {
    fontSize: 10.5,
    fontWeight: 600,
    color: 'var(--text-3)',
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    padding: '6px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-soft)',
  };

  return (
    <>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">F&amp;O · Options</h1>
          <p className="page-sub">Live option chain — tap any premium to buy or sell.</p>
        </div>
        <FeedBadge health={health} asOf={asOf} />
      </div>

      {/* Underlying selector — indices first, horizontally scrollable */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          overflowX: 'auto',
          paddingBottom: 4,
          marginTop: 4,
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {chips.map((u) => {
          const sel = u.symbol === symbol;
          const up = Number(u.change_pct || 0) >= 0;
          return (
            <button
              key={u.symbol}
              type="button"
              onClick={() => setSymbol(u.symbol)}
              title={u.name}
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '7px 14px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: sel ? 'var(--accent-soft)' : 'var(--surface)',
                color: sel ? 'var(--accent)' : 'var(--text-2)',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{u.symbol}</span>
              <span
                className={up ? 'text-up' : 'text-down'}
                style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
              >
                {up ? '+' : '−'}
                {Math.abs(Number(u.change_pct || 0)).toFixed(2)}%
              </span>
            </button>
          );
        })}
      </div>

      {/* Spot header + expiry */}
      <div className="card pad mt-2" style={{ padding: '18px 22px' }}>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 18 }}>
          <div>
            <div className="small text-muted" style={{ marginBottom: 3 }}>
              {selected?.name || symbol} · Spot
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span
                className="mono"
                style={{ fontSize: 30, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
              >
                {spot != null ? <LivePrice value={spot} /> : '—'}
              </span>
              <ChangePct value={selected?.change_pct} />
            </div>
            {options && (
              <div className="small text-muted mono" style={{ marginTop: 5, fontVariantNumeric: 'tabular-nums' }}>
                ATM {options.atm != null ? num(options.atm) : '—'} · Step{' '}
                {options.step != null ? num(options.step) : '—'} · Lot {lotSize}
              </div>
            )}
          </div>

          {expiryOptions.length > 0 && (
            <div>
              <div className="small text-muted" style={{ marginBottom: 7 }}>
                Expiry
              </div>
              <Segmented options={expiryOptions} value={expiry} onChange={onExpiry} />
            </div>
          )}
        </div>
      </div>

      {/* Option chain */}
      <div className="card mt-2" style={{ overflow: 'hidden' }}>
        {loadingChain && !options ? (
          <div className="pad">
            <Spinner label="Loading option chain…" />
          </div>
        ) : rows.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon="🧮"
              title="No option chain available"
              text="This underlying doesn't have a derived chain right now."
            />
          </div>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table
              style={{
                width: '100%',
                minWidth: 720,
                borderCollapse: 'collapse',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <thead>
                <tr>
                  <th colSpan={3} style={{ ...groupTh, color: 'var(--up-ink)', background: 'var(--up-soft)' }}>
                    Calls
                  </th>
                  <th rowSpan={2} style={{ ...groupTh, verticalAlign: 'middle', background: 'var(--bg-soft)' }}>
                    Strike
                  </th>
                  <th colSpan={3} style={{ ...groupTh, color: 'var(--down-ink)', background: 'var(--down-soft)' }}>
                    Puts
                  </th>
                </tr>
                <tr>
                  <th style={{ ...colTh, textAlign: 'right' }}>OI</th>
                  <th style={{ ...colTh, textAlign: 'right' }}>Chg%</th>
                  <th style={{ ...colTh, textAlign: 'right' }}>LTP</th>
                  <th style={{ ...colTh, textAlign: 'left' }}>LTP</th>
                  <th style={{ ...colTh, textAlign: 'left' }}>Chg%</th>
                  <th style={{ ...colTh, textAlign: 'left' }}>OI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isAtm = row.atm === true;
                  const call = row.call || {};
                  const put = row.put || {};
                  const callItm = spot != null && row.strike < spot; // call ITM below spot
                  const putItm = spot != null && row.strike > spot; // put ITM above spot
                  const callBg = isAtm ? 'var(--bg-soft)' : callItm ? DEEP_GREEN : 'var(--up-soft)';
                  const putBg = isAtm ? 'var(--bg-soft)' : putItm ? DEEP_RED : 'var(--down-soft)';
                  const strikeBg = isAtm ? 'var(--bg-soft)' : 'var(--surface)';
                  const rowFw = isAtm ? 700 : 500;

                  return (
                    <tr key={row.strike}>
                      {/* CALLS — right-aligned toward the centre */}
                      <td style={{ ...cell, textAlign: 'right', background: callBg, fontWeight: rowFw, color: 'var(--text-2)' }}>
                        {num(call.oi)}
                      </td>
                      <td style={{ ...cell, textAlign: 'right', background: callBg }}>
                        <ChangePct value={call.change_pct} />
                      </td>
                      <td
                        style={{ ...ltpCell, textAlign: 'right', background: callBg, fontWeight: callItm ? 700 : 600, color: 'var(--up-ink)' }}
                        onClick={() => openTicket(row.strike, 'CE', call.ltp)}
                        title="Tap to trade this Call"
                      >
                        {fmt2(call.ltp)}
                      </td>

                      {/* STRIKE */}
                      <td style={{ ...cell, textAlign: 'center', background: strikeBg }}>
                        <span className="mono" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                          {num(row.strike)}
                        </span>
                        {isAtm && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 9.5,
                              fontWeight: 800,
                              letterSpacing: '.1em',
                              padding: '1px 6px',
                              borderRadius: 6,
                              background: 'var(--accent-soft)',
                              color: 'var(--accent)',
                              verticalAlign: 'middle',
                            }}
                          >
                            ATM
                          </span>
                        )}
                      </td>

                      {/* PUTS — left-aligned toward the centre */}
                      <td
                        style={{ ...ltpCell, textAlign: 'left', background: putBg, fontWeight: putItm ? 700 : 600, color: 'var(--down-ink)' }}
                        onClick={() => openTicket(row.strike, 'PE', put.ltp)}
                        title="Tap to trade this Put"
                      >
                        {fmt2(put.ltp)}
                      </td>
                      <td style={{ ...cell, textAlign: 'left', background: putBg }}>
                        <ChangePct value={put.change_pct} />
                      </td>
                      <td style={{ ...cell, textAlign: 'left', background: putBg, fontWeight: rowFw, color: 'var(--text-2)' }}>
                        {num(put.oi)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="small text-muted mt-2" style={{ maxWidth: 720 }}>
        Tap a Call or Put premium to place an order. {options?.note}
      </p>

      {ticket && (
        <OptionTicket
          ctx={ticket}
          onClose={() => setTicket(null)}
          onPlaced={() => { lastFetch.current = 0; }}
        />
      )}
    </>
  );
}
