// Professional trading chart powered by TradingView's lightweight-charts —
// the same engine real broker terminals use. Real candlesticks with automatic
// price scaling, scroll-zoom, drag-pan, pinch, crosshair with axis labels, a
// volume pane, an OHLC legend and candle/line/area modes.
import { useEffect, useRef, useState, useMemo } from 'react';
import {
  createChart, CrosshairMode, ColorType, LineStyle,
} from 'lightweight-charts';
import { api } from '../api';

const IST = 19800; // seconds; render times in IST (lib treats numeric time as UTC)
const toBar = (c) => ({ time: Math.floor(c.t / 1000) + IST, open: c.o, high: c.h, low: c.l, close: c.c });
const toVol = (c, up, dn) => ({ time: Math.floor(c.t / 1000) + IST, value: c.v, color: c.c >= c.o ? up : dn });

// ---- Fetch history + keep the last (forming) candle live -----------------------
export function useCandles(instrumentId, intervalMin, liveLtp) {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const instRef = useRef(instrumentId);
  instRef.current = instrumentId;

  useEffect(() => {
    if (!instrumentId) return;
    let alive = true;
    setLoading(true);
    api.get(`/api/market/candles?instrument_id=${instrumentId}&interval=${intervalMin}&limit=400`)
      .then((d) => { if (alive && instRef.current === instrumentId) { setCandles(d.candles || []); setLoading(false); } })
      .catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [instrumentId, intervalMin]);

  useEffect(() => {
    if (!liveLtp) return;
    const span = intervalMin * 60000;
    const bucket = Math.floor(Date.now() / span) * span;
    setCandles((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      if (last.t === bucket) {
        return [...prev.slice(0, -1), { ...last, c: liveLtp, h: Math.max(last.h, liveLtp), l: Math.min(last.l, liveLtp) }];
      }
      const next = [...prev, { t: bucket, o: last.c, h: liveLtp, l: liveLtp, c: liveLtp, v: 0 }];
      return next.length > 800 ? next.slice(-800) : next;
    });
  }, [liveLtp, intervalMin]); // eslint-disable-line react-hooks/exhaustive-deps

  return { candles, loading };
}

const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtVol = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${v}`);

function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ---- The chart ----------------------------------------------------------------
export function ProChart({ candles, resetKey, symbol, exchange = 'NSE', chartType = 'candles', height = 380 }) {
  const wrapRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volRef = useRef(null);
  const dataRef = useRef([]);
  const keyRef = useRef(null);
  const firstRef = useRef(null);
  const lastTimeRef = useRef(-Infinity);
  const typeRef = useRef(chartType);
  const hoverRef = useRef(false);
  const [legend, setLegend] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const colors = useMemo(() => ({
    up: cssVar('--up', '#26a69a'), down: cssVar('--down', '#ef5350'),
    text2: cssVar('--text-2', '#868c98'), text3: cssVar('--text-3', '#5a606b'),
    border: cssVar('--border', '#272a33'), grid: cssVar('--border-soft', '#1e2029'),
    accent: cssVar('--accent', '#2dd4bf'),
  }), []);

  // Create the price series for the current chart type.
  const makePriceSeries = (chart, type) => {
    if (type === 'line') {
      return chart.addLineSeries({ color: colors.accent, lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
    }
    if (type === 'area') {
      return chart.addAreaSeries({ lineColor: colors.accent, topColor: 'rgba(45,212,191,.25)', bottomColor: 'rgba(45,212,191,0)', lineWidth: 2 });
    }
    return chart.addCandlestickSeries({
      upColor: colors.up, downColor: colors.down, borderVisible: false,
      wickUpColor: colors.up, wickDownColor: colors.down,
    });
  };

  const seriesData = (type) => (type === 'candles'
    ? dataRef.current.map(toBar)
    : dataRef.current.map((c) => ({ time: Math.floor(c.t / 1000) + IST, value: c.c })));

  // Create chart once.
  useEffect(() => {
    const chart = createChart(wrapRef.current, {
      width: wrapRef.current.clientWidth, height,
      // attributionLogo:false removes the TradingView badge (Apache-2.0 permits it).
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text2, fontSize: 11, fontFamily: 'inherit', attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: colors.border },
        horzLine: { color: colors.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: colors.border },
      },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
      handleScroll: true, handleScale: true,
      watermark: { visible: true, text: '', color: 'rgba(134,140,152,.06)', fontSize: 46, fontStyle: 'bold', horzAlign: 'center', vertAlign: 'center' },
    });
    chartRef.current = chart;
    priceRef.current = makePriceSeries(chart, typeRef.current);

    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;

    chart.subscribeCrosshairMove((param) => {
      const bars = dataRef.current;
      if (!bars.length) return;
      hoverRef.current = !!param.time;
      if (!param.time) { setLegend(bars[bars.length - 1]); return; }
      const hovered = bars.find((b) => Math.floor(b.t / 1000) + IST === param.time);
      if (hovered) setLegend(hovered);
    });

    const ro = new ResizeObserver(() => {
      if (wrapRef.current) chart.applyOptions({ width: wrapRef.current.clientWidth });
    });
    ro.observe(wrapRef.current);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Watermark follows the symbol.
  useEffect(() => {
    chartRef.current?.applyOptions({ watermark: { text: symbol ? `${symbol} · ${exchange}` : '' } });
  }, [symbol, exchange]);

  // Swap series when the chart type changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeRef.current === chartType) return;
    chart.removeSeries(priceRef.current);
    typeRef.current = chartType;
    priceRef.current = makePriceSeries(chart, chartType);
    priceRef.current.setData(seriesData(chartType));
  }, [chartType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Feed data. A full setData resets the view, so on a normal tick we only
  // update the last bar. We detect a fresh dataset (symbol/interval change, or
  // the candles prop catching up after a switch) by the first-bar time — this
  // avoids feeding lightweight-charts an out-of-order bar (which throws).
  useEffect(() => {
    const price = priceRef.current, vol = volRef.current;
    if (!price || !candles.length) return;
    dataRef.current = candles;
    const bars = seriesData(typeRef.current);
    const vols = candles.map((c) => toVol(c, 'rgba(38,166,154,.5)', 'rgba(239,83,80,.5)'));
    const newFirst = bars[0].time, newLast = bars[bars.length - 1].time;
    const keyChanged = keyRef.current !== resetKey;
    const freshDataset = keyChanged || firstRef.current !== newFirst || newLast < lastTimeRef.current;
    try {
      if (freshDataset) {
        price.setData(bars);
        vol.setData(vols);
        if (keyChanged) { chartRef.current.timeScale().fitContent(); keyRef.current = resetKey; }
      } else {
        price.update(bars[bars.length - 1]);
        vol.update(vols[vols.length - 1]);
      }
    } catch {
      // Any ordering hiccup: rebuild the series data wholesale.
      price.setData(bars);
      vol.setData(vols);
      keyRef.current = resetKey;
    }
    firstRef.current = newFirst;
    lastTimeRef.current = newLast;
    if (!hoverRef.current) setLegend(candles[candles.length - 1]);
  }, [candles, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize the chart when it toggles fullscreen.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !wrapRef.current) return;
    const h = expanded ? window.innerHeight - 132 : height;
    requestAnimationFrame(() => {
      chart.applyOptions({ width: wrapRef.current.clientWidth, height: h });
      chart.timeScale().fitContent();
    });
    if (expanded) {
      const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
    return undefined;
  }, [expanded, height]);

  const zoom = (factor) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const bs = ts.options().barSpacing || 8;
    ts.applyOptions({ barSpacing: Math.max(2, Math.min(60, bs * factor)) });
  };
  const fit = () => chartRef.current?.timeScale().fitContent();

  const chg = legend ? legend.c - legend.o : 0;
  return (
    <div className={`pro-chart ${expanded ? 'expanded' : ''}`}>
      {legend && (
        <div className="chart-legend">
          <span className="cl-sym">{symbol}</span>
          <span>O <b>{fmt(legend.o)}</b></span>
          <span>H <b className="text-up">{fmt(legend.h)}</b></span>
          <span>L <b className="text-down">{fmt(legend.l)}</b></span>
          <span>C <b>{fmt(legend.c)}</b></span>
          <span className={chg >= 0 ? 'text-up' : 'text-down'}>{chg >= 0 ? '+' : ''}{fmt(chg)}</span>
          {legend.v > 0 && <span className="cl-vol">Vol <b>{fmtVol(legend.v)}</b></span>}
        </div>
      )}
      <div className="chart-tools">
        <button type="button" title="Zoom in" onClick={() => zoom(1.3)}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoom(1 / 1.3)}>−</button>
        <button type="button" title="Fit / reset" onClick={fit}>⤢</button>
        <button type="button" title={expanded ? 'Exit fullscreen (Esc)' : 'Fullscreen'} onClick={() => setExpanded((v) => !v)}>{expanded ? '✕' : '⛶'}</button>
      </div>
      <div ref={wrapRef} className="chart-canvas" style={{ height: expanded ? undefined : height }} />
    </div>
  );
}

// ---- Market depth ladder (5-level order book) ---------------------------------
export function DepthLadder({ quote }) {
  const book = useMemo(() => {
    if (!quote) return null;
    const tick = Math.max(0.05, +(quote.ltp * 0.0005).toFixed(2));
    const seed = Math.abs(Math.sin(quote.ltp)) * 1000;
    const qtyAt = (i, side) => Math.round(80 + ((seed * (i + 1) * (side === 'b' ? 1.3 : 1.1)) % 900));
    const bids = [], asks = [];
    for (let i = 0; i < 5; i++) {
      bids.push({ price: +(quote.bid - i * tick).toFixed(2), qty: qtyAt(i, 'b') });
      asks.push({ price: +(quote.ask + i * tick).toFixed(2), qty: qtyAt(i, 'a') });
    }
    const maxQty = Math.max(...bids.map((r) => r.qty), ...asks.map((r) => r.qty), 1);
    return { bids, asks, maxQty, bidTot: bids.reduce((s, r) => s + r.qty, 0), askTot: asks.reduce((s, r) => s + r.qty, 0) };
  }, [quote]);

  if (!book) return null;
  const Row = ({ r, side }) => (
    <div className={`depth-row ${side}`}>
      <span className="depth-bar" style={{ width: `${(r.qty / book.maxQty) * 100}%` }} />
      <span className="depth-qty">{r.qty}</span>
      <span className={`depth-price ${side === 'bid' ? 'text-up' : 'text-down'}`}>{fmt(r.price)}</span>
    </div>
  );
  return (
    <div className="depth">
      <div className="depth-col">
        <div className="depth-head"><span>Qty</span><span>Bid</span></div>
        {book.bids.map((r, i) => <Row key={i} r={r} side="bid" />)}
        <div className="depth-total"><span>Total</span><b className="text-up">{book.bidTot.toLocaleString('en-IN')}</b></div>
      </div>
      <div className="depth-col">
        <div className="depth-head"><span>Qty</span><span>Ask</span></div>
        {book.asks.map((r, i) => <Row key={i} r={r} side="ask" />)}
        <div className="depth-total"><span>Total</span><b className="text-down">{book.askTot.toLocaleString('en-IN')}</b></div>
      </div>
    </div>
  );
}
