// Stage 9 — Trading Terminal (flagship page).
// A real trading-desk view: live market watch, candlestick chart with interval
// tabs, 5-level market depth, and a colored Buy/Sell order ticket. Feed health +
// "Data as of" timestamp stay visible; price entry validates against the live
// LTP band (BPD Stage 9/10). Execution remains manual via the trading desk.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, inr, num, fmtDateTime } from '../../api';
import { useAuth } from '../../auth';
import { subscribe } from '../../realtime';
import { useToast, Field, Spinner, StatusBadge } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice, ChangePct } from '../../components/market';
import { ProChart, DepthLadder, useCandles, fmtVol } from '../../components/chart';
import { SellModal } from '../../components/sell';

const px2 = (v) => Number(v || 0).toFixed(2);
const INTERVALS = [{ label: '1m', v: 1 }, { label: '5m', v: 5 }, { label: '15m', v: 15 }, { label: '1H', v: 60 }];
const CHART_TYPES = [{ v: 'candles', label: 'Candlestick', icon: '▮' }, { v: 'line', label: 'Line', icon: '╱' }, { v: 'area', label: 'Area', icon: '◺' }];

export default function Trade() {
  const toast = useToast();
  const { user } = useAuth();
  const { quotes, byId, health, asOf } = useLivePrices();

  const [selectedId, setSelectedId] = useState(null);
  const [interval, setIntervalMin] = useState(5);
  const [chartType, setChartType] = useState('candles');
  const [side, setSide] = useState('BUY');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [qtyError, setQtyError] = useState('');
  const [priceError, setPriceError] = useState('');
  const [band, setBand] = useState(5);
  const [busy, setBusy] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [orders, setOrders] = useState(null);
  const [bottomTab, setBottomTab] = useState('orders');
  const [sellRow, setSellRow] = useState(null); // holding open in the sell ticket

  // On a phone the chart pushes the order ticket ~1.7 screens down, so the Buy/Sell
  // controls are effectively invisible. A sticky bar keeps them one tap away and
  // scrolls the ticket into view with the right side pre-selected.
  const ticketRef = useRef(null);
  const jumpToTicket = (s) => {
    setSide(s);
    setQtyError(''); setPriceError('');
    ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const isActive = user?.status === 'Active';
  const sel = selectedId ? byId.get(selectedId) : null;
  const { candles } = useCandles(sel?.instrument_id, interval, sel?.ltp);

  const loadPortfolio = async () => { try { setPortfolio(await api.get('/api/portfolio')); } catch (e) { toast.error(e.message); } };
  const loadOrders = async () => { try { const d = await api.get('/api/orders/mine'); setOrders(d.orders || []); } catch (e) { toast.error(e.message); } };
  useEffect(() => { loadPortfolio(); loadOrders(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => subscribe('notification', () => { loadOrders(); loadPortfolio(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // /app/trade?instrument=<id>&side=SELL — used by the "Sell" button on Portfolio
  // and Home so the ticket opens on the holding the investor actually tapped.
  const [params] = useSearchParams();
  const wantId = Number(params.get('instrument')) || null;
  const wantSide = String(params.get('side') || '').toUpperCase() === 'SELL' ? 'SELL' : null;

  // Apply the deep-link once per distinct ?instrument= value, so arriving here
  // from Portfolio always lands on that holding, while still letting the user
  // pick a different instrument afterwards without being yanked back.
  const appliedRef = useRef(null);
  useEffect(() => {
    if (!quotes.length) return;
    if (wantId && appliedRef.current !== wantId) {
      const target = quotes.find((q) => q.instrument_id === wantId);
      if (target) {
        appliedRef.current = wantId;
        setSelectedId(target.instrument_id);
        setPrice(px2(target.ltp));
        if (wantSide) setSide(wantSide);
        return;
      }
    }
    if (!selectedId) { setSelectedId(quotes[0].instrument_id); setPrice(px2(quotes[0].ltp)); }
  }, [quotes, selectedId, wantId, wantSide]);

  const listRef = useRef(null);
  const selectInstrument = (q) => {
    setSelectedId(q.instrument_id);
    setPrice(px2(q.ltp));
    setPriceError(''); setQtyError('');
  };
  // Keep the selected instrument visible in the (now long) watchlist.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-id="${selectedId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const heldQty = (portfolio?.holdings || []).find((h) => h.instrument_id === sel?.instrument_id)?.qty || 0;
  // Orders execute at the current market price — size is the only input.
  const marketPrice = sel ? sel.ltp : 0;
  const absChange = sel ? sel.ltp - sel.prev_close : 0;

  // MCX commodities trade in fixed exchange lots (1 CRUDEOILM lot = 10 barrels,
  // 1 NATURALGAS lot = 1250 mmBtu). Every real broker asks for LOTS, so the box
  // takes lots and we multiply up — otherwise a client has to know to type 1250.
  const lotSize = Number(sel?.lot_size) || 1;
  const lotted = lotSize > 1;
  const sizeLabel = lotted ? 'Lots' : 'Quantity';
  const orderQty = (Number(qty) || 0) * lotSize; // units actually sent to the server
  const est = orderQty * marketPrice;
  const heldLots = lotted ? heldQty / lotSize : heldQty;

  const submit = async (e) => {
    e.preventDefault();
    setQtyError('');
    if (!sel) { toast.error('Select an instrument first.'); return; }
    const nInput = Number(qty);
    if (!Number.isInteger(nInput) || nInput <= 0) {
      setQtyError(lotted ? 'Enter a whole number of lots.' : 'Quantity must be a positive whole number.');
      return;
    }
    setBusy(true);
    try {
      // No price sent — the server fixes it to the live market price.
      const res = await api.post('/api/orders', { instrument_id: sel.instrument_id, side, qty: nInput * lotSize });
      if (res.auto_rejected) toast.error(res.message);
      else { toast.success(res.message); setQty(''); }
      loadOrders(); loadPortfolio();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  const feedTrouble = health?.status === 'DOWN' || health?.status === 'DELAYED';

  return (
    <div className="trade-page">
      <div className="row-between mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>Trading Terminal</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Live charts, market depth and one-click order entry.</p>
        </div>
        <FeedBadge health={health} asOf={asOf} />
      </div>

      {feedTrouble && (
        <div className="banner banner-warn">
          <span aria-hidden>⚠️</span>
          <span>Market data {health.status === 'DOWN' ? 'is currently unavailable' : 'is delayed'} — orders are not blocked; execution is handled by our trading desk.</span>
        </div>
      )}

      <div className="terminal">
        {/* ---- Market watch --------------------------------------------------- */}
        <aside className="panel mkt-watch">
          <div className="mkt-head">
            <span className="panel-title">Market Watch</span>
            <span className="small text-muted">{quotes.length}</span>
          </div>
          <InstrumentSearch quotes={quotes} selectedId={selectedId} onSelect={selectInstrument} />
          <div className="mw-list" ref={listRef}>
            {quotes.length === 0 ? (
              <div className="pad"><Spinner label="Loading market…" /></div>
            ) : quotes.map((q) => {
              const up = Number(q.change_pct) >= 0;
              const on = q.instrument_id === selectedId;
              return (
                <button key={q.instrument_id} data-id={q.instrument_id} className={`mw-row ${on ? 'active' : ''}`} onClick={() => selectInstrument(q)}>
                  <span className="mw-sym"><b>{q.symbol}</b><span className="mw-name">{q.name}</span></span>
                  <span className="mw-num">
                    <LivePrice value={q.ltp} prefix="" />
                    <span className={`mw-chg ${up ? 'text-up' : 'text-down'}`}>{up ? '+' : ''}{Number(q.change_pct).toFixed(2)}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ---- Chart ---------------------------------------------------------- */}
        <section className="panel chart-area">
          {sel ? (
            <>
              <div className="inst-head">
                <div className="inst-id">
                  <h2>{sel.symbol}</h2>
                  <span className="chip-ex">{sel.exchange}</span>
                  <span className="inst-name">{sel.name}</span>
                </div>
                {sel.indicative && (
                  <span className="badge badge-amber" title="Derived from the international futures contract and converted at the live USD/INR rate. Not the official MCX settlement price.">
                    Indicative price
                  </span>
                )}
                <div className="inst-ltp">
                  <span className={`inst-price ${absChange >= 0 ? 'text-up' : 'text-down'}`}>{inr(sel.ltp)}</span>
                  <span className={`inst-delta ${absChange >= 0 ? 'text-up' : 'text-down'}`}>
                    {absChange >= 0 ? '+' : ''}{px2(absChange)} (<ChangePct value={sel.change_pct} />)
                  </span>
                </div>
              </div>

              <div className="inst-stats">
                <span>O <b>{px2(sel.open)}</b></span>
                <span>H <b className="text-up">{px2(sel.high)}</b></span>
                <span>L <b className="text-down">{px2(sel.low)}</b></span>
                <span>PC <b>{px2(sel.prev_close)}</b></span>
                <span>Vol <b>{fmtVol(sel.volume || 0)}</b></span>
                <span className="inst-bidask">Bid <b className="text-up">{px2(sel.bid)}</b> · Ask <b className="text-down">{px2(sel.ask)}</b></span>
              </div>

              <div className="interval-tabs">
                {INTERVALS.map((it) => (
                  <button key={it.v} className={`iv-tab ${interval === it.v ? 'active' : ''}`} onClick={() => setIntervalMin(it.v)}>{it.label}</button>
                ))}
                <span className="iv-spacer" />
                <div className="ctype">
                  {CHART_TYPES.map((t) => (
                    <button key={t.v} className={`ct-btn ${chartType === t.v ? 'active' : ''}`} title={t.label} onClick={() => setChartType(t.v)}>{t.icon}</button>
                  ))}
                </div>
              </div>

              <ProChart candles={candles} resetKey={`${sel.instrument_id}:${interval}`}
                symbol={sel.symbol} exchange={sel.exchange} chartType={chartType} height={384} />
            </>
          ) : (
            <div className="pad"><Spinner label="Waiting for market data…" /></div>
          )}
        </section>

        {/* ---- Order ticket + depth ------------------------------------------ */}
        <aside className="order-col">
          <div className="panel ticket" ref={ticketRef}>
            <div className="ticket-tabs">
              <button className={`tk-tab buy ${side === 'BUY' ? 'active' : ''}`} onClick={() => { setSide('BUY'); setQtyError(''); }}>BUY</button>
              <button className={`tk-tab sell ${side === 'SELL' ? 'active' : ''}`} onClick={() => { setSide('SELL'); setQtyError(''); }}>SELL</button>
            </div>

            {!isActive ? (
              <div className="banner banner-warn" style={{ margin: 12 }}>
                <span aria-hidden>🔒</span>
                <span>Trading unlocks once your account is Active. <Link to="/app">Complete onboarding</Link></span>
              </div>
            ) : !sel ? (
              <div className="pad small text-muted">Select an instrument to trade.</div>
            ) : (
              <form onSubmit={submit} className="ticket-body">
                <div className="tk-inst">
                  <b>{sel.symbol}</b>
                  <span className="small text-muted">LTP {inr(sel.ltp)}</span>
                </div>
                <div className="row-between small tk-avail">
                  {side === 'BUY'
                    ? <><span className="text-muted">Available</span><strong className="mono">{portfolio ? inr(portfolio.wallet.available) : '—'}</strong></>
                    : (
                      <><span className="text-muted">Holding</span><strong className="mono">
                        {portfolio ? (lotted ? `${num(heldLots)} lot${heldLots === 1 ? '' : 's'}` : `${num(heldQty)} qty`) : '—'}
                      </strong></>
                    )}
                </div>

                <Field label={sizeLabel} required error={qtyError}
                  hint={lotted ? `1 lot = ${num(lotSize)}${sel.quote_unit ? ` × ${sel.quote_unit.replace('₹ / ', '')}` : ''}` : undefined}>
                  <input className="input" type="number" min="1" step="1" inputMode="numeric"
                    placeholder={lotted ? 'Lots' : 'Qty'} value={qty}
                    onChange={(e) => { setQty(e.target.value); setQtyError(''); }} />
                </Field>
                {lotted && orderQty > 0 && (
                  <div className="row-between small tk-avail">
                    <span className="text-muted">Order size</span>
                    <strong className="mono">{num(orderQty)}</strong>
                  </div>
                )}
                <div className="tk-price">
                  <span className="small text-muted">Price · at market</span>
                  <span className="tk-price-val"><LivePrice value={sel.ltp} /> <span className="tk-mkt-tag">MARKET</span></span>
                </div>

                <div className="row-between tk-est">
                  <span className="small text-muted">Est. {side === 'BUY' ? 'cost' : 'proceeds'}</span>
                  <strong className="mono">{inr(est)}</strong>
                </div>
                <button type="submit" className={`btn btn-lg btn-block ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`} disabled={busy}>
                  {busy ? 'Placing…' : `${side} ${sel.symbol}`}
                </button>
                <p className="small text-muted tk-note">Executed by our trading desk. Pending orders can be cancelled.</p>
              </form>
            )}
          </div>

          <div className="panel depth-panel">
            <div className="mkt-head"><span className="panel-title">Market Depth</span>{sel && <span className="small text-muted">{sel.symbol}</span>}</div>
            {sel ? <DepthLadder quote={sel} /> : <div className="pad small text-muted">—</div>}
          </div>
        </aside>
      </div>

      {/* ---- Positions / Orders -------------------------------------------- */}
      <div className="panel mt-3 bottom-panel">
        <div className="bp-tabs">
          <button className={`bp-tab ${bottomTab === 'orders' ? 'active' : ''}`} onClick={() => setBottomTab('orders')}>Orders</button>
          <button className={`bp-tab ${bottomTab === 'holdings' ? 'active' : ''}`} onClick={() => setBottomTab('holdings')}>Holdings</button>
          <span className="bp-spacer" />
          <Link className="btn btn-sm" to={bottomTab === 'orders' ? '/app/orders' : '/app/portfolio'}>View all</Link>
        </div>

        {bottomTab === 'orders' ? (
          orders === null ? <div className="pad"><Spinner label="Loading orders…" /></div>
            : orders.length === 0 ? <div className="pad small text-muted">No orders yet — place your first order above.</div>
            : (
              <div className="tbl-scroll">
                <table className="term-table">
                  <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th className="ta-r">Qty</th><th className="ta-r">Price</th><th>Status</th></tr></thead>
                  <tbody>
                    {orders.slice(0, 8).map((o) => (
                      <tr key={o.id}>
                        <td className="small">{fmtDateTime(o.created_at)}</td>
                        <td><b>{o.symbol}</b></td>
                        <td><span className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side}</span></td>
                        <td className="ta-r mono">{num(o.qty)}</td>
                        <td className="ta-r mono">{inr(o.price)}</td>
                        <td><StatusBadge status={o.status} small /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        ) : (
          !portfolio ? <div className="pad"><Spinner label="Loading holdings…" /></div>
            : (portfolio.holdings || []).length === 0 ? <div className="pad small text-muted">No holdings yet.</div>
            : (
              <div className="tbl-scroll">
                <table className="term-table">
                  <thead><tr><th>Instrument</th><th className="ta-r">Qty</th><th className="ta-r">Avg</th><th className="ta-r">LTP</th><th className="ta-r">Value</th><th className="ta-r">P&L</th><th /></tr></thead>
                  <tbody>
                    {portfolio.holdings.map((h) => (
                      <tr key={h.instrument_id} className="clickable" onClick={() => { const q = byId.get(h.instrument_id); if (q) selectInstrument(q); }}>
                        <td><b>{h.symbol}</b></td>
                        <td className="ta-r mono">{num(h.qty)}</td>
                        <td className="ta-r mono">{inr(h.avg_price)}</td>
                        <td className="ta-r mono">{inr(h.ltp)}</td>
                        <td className="ta-r mono">{inr(h.market_value)}</td>
                        <td className={`ta-r mono ${h.unrealized_pnl >= 0 ? 'text-up' : 'text-down'}`}>{h.unrealized_pnl >= 0 ? '+' : ''}{inr(h.unrealized_pnl)}</td>
                        <td className="ta-r">
                          {/* stopPropagation so the row's select-instrument click doesn't also fire */}
                          <button type="button" className="btn btn-sm btn-sell tap"
                            onClick={(e) => { e.stopPropagation(); setSellRow(h); }}>
                            Sell
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      {sellRow && (
        <SellModal
          holding={sellRow}
          onClose={() => setSellRow(null)}
          onDone={() => { loadPortfolio(); loadOrders(); }}
        />
      )}

      {/* Phone-only sticky trade bar — the ticket itself is far below the chart. */}
      {isActive && sel && (
        <div className="mobile-trade-bar">
          <button type="button" className="btn btn-lg btn-buy" onClick={() => jumpToTicket('BUY')}>
            BUY {sel.symbol}
          </button>
          <button type="button" className="btn btn-lg btn-sell" onClick={() => jumpToTicket('SELL')}>
            SELL
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Ranked instrument search (autocomplete dropdown, keyboard nav) ------------
function highlightMatch(text, q) {
  const i = text.toUpperCase().indexOf(q.toUpperCase());
  if (i < 0 || !q) return text;
  return (<>{text.slice(0, i)}<mark className="sr-hl">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>);
}

function InstrumentSearch({ quotes, selectedId, onSelect }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);

  const results = useMemo(() => {
    const s = q.trim().toUpperCase();
    if (!s) return [];
    const scored = [];
    for (const it of quotes) {
      const sym = it.symbol.toUpperCase(), nm = it.name.toUpperCase();
      let score = -1;
      if (sym === s) score = 0;
      else if (sym.startsWith(s)) score = 1;
      else if (nm.startsWith(s)) score = 2;
      else if (sym.includes(s)) score = 3;
      else if (nm.includes(s)) score = 4;
      if (score >= 0) scored.push({ it, score });
    }
    scored.sort((a, b) => a.score - b.score || a.it.symbol.localeCompare(b.it.symbol));
    return scored.slice(0, 8).map((x) => x.it);
  }, [q, quotes]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (it) => { if (!it) return; onSelect(it); setQ(''); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  return (
    <div className="mkt-search-wrap" ref={wrapRef}>
      <svg className="mkt-search-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden>
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input className="mkt-search" placeholder="Search & load any stock…" value={q} aria-label="Search instruments"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => q && setOpen(true)} onKeyDown={onKey} />
      {q && <button className="mkt-search-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQ(''); setOpen(false); }} aria-label="Clear search">×</button>}
      {open && q && (
        <div className="search-dd" role="listbox">
          {results.length ? results.map((it, i) => {
            const up = Number(it.change_pct) >= 0;
            return (
              <button key={it.instrument_id} role="option" aria-selected={i === active}
                className={`sr ${i === active ? 'on' : ''} ${it.instrument_id === selectedId ? 'cur' : ''}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(it)}>
                <span className="sr-l"><b>{highlightMatch(it.symbol, q)}</b><span className="sr-n">{highlightMatch(it.name, q)}</span></span>
                <span className="sr-r">
                  <span className="mono">{Number(it.ltp).toFixed(2)}</span>
                  <span className={up ? 'text-up' : 'text-down'}>{up ? '+' : ''}{Number(it.change_pct).toFixed(2)}%</span>
                </span>
              </button>
            );
          }) : <div className="sr-empty">No stock matches “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
