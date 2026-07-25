// Live-market building blocks: price hooks, feed-health chip with "Data as of"
// timestamp (BPD Stage 9), flashing price cells, SVG sparkline, notifications hook.
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { subscribe } from '../realtime';

// ---- Live prices --------------------------------------------------------------
// Returns { quotes: [], bySymbol: Map, byId: Map, health, asOf }
export function useLivePrices() {
  const [snap, setSnap] = useState({ quotes: [], indices: [], health: null, as_of: null });
  useEffect(() => {
    let alive = true;
    api.get('/api/market/snapshot').then((s) => alive && setSnap(s)).catch(() => {});
    const un1 = subscribe('prices', (s) => alive && setSnap(s));
    const un2 = subscribe('feedHealth', (h) => alive && setSnap((prev) => ({ ...prev, health: h })));
    return () => { alive = false; un1(); un2(); };
  }, []);
  const byId = new Map(snap.quotes.map((q) => [q.instrument_id, q]));
  const bySymbol = new Map(snap.quotes.map((q) => [q.symbol, q]));
  return { quotes: snap.quotes, indices: snap.indices || [], byId, bySymbol, health: snap.health, asOf: snap.as_of };
}

// ---- Feed health chip — always shows whether data is live or stale ------------
export function FeedBadge({ health, asOf }) {
  const status = health?.status || '…';
  const t = asOf || health?.last_tick_at;
  const time = t ? new Date(t).toLocaleTimeString('en-IN', { hour12: false }) : '—';
  // With a real feed (yahoo), reflect real market state so a closed market reads
  // as "Market Closed" rather than a false "feed down".
  const closed = health?.market_state && !['REGULAR', 'PRE', 'POST'].includes(health.market_state);
  const preOrPost = health?.market_state === 'PRE' || health?.market_state === 'POST';
  let label, cls;
  if (status === 'LIVE' && closed) { label = `Market Closed · as of ${time}`; cls = 'feed-closed'; }
  else if (status === 'LIVE' && preOrPost) { label = `${health.market_state === 'PRE' ? 'Pre-market' : 'Post-market'} · ${time}`; cls = 'feed-live'; }
  else if (status === 'LIVE') { label = `Live · Data as of ${time}`; cls = 'feed-live'; }
  else if (status === 'DELAYED') { label = `Data Delayed · ${time}`; cls = 'feed-delayed'; }
  else if (status === 'DOWN') { label = `Feed Unavailable · ${time}`; cls = 'feed-down'; }
  else { label = 'Connecting'; cls = 'feed-delayed'; }
  return (
    <span className={`feed-badge ${cls}`} title={`Market data: ${status}${health?.market_state ? ` (${health.market_state})` : ''}`}>
      <span className="feed-dot" aria-hidden />
      {label}
    </span>
  );
}

// ---- Price that flashes green/red on tick -------------------------------------
export function LivePrice({ value, prefix = '₹' }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (prev.current !== undefined && value !== prev.current) {
      setFlash(value > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(''), 600);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
    return undefined;
  }, [value]);
  return <span className={`live-price ${flash ? `flash-${flash}` : ''}`}>{prefix}{Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}

export function ChangePct({ value }) {
  const v = Number(value || 0);
  return <span className={v >= 0 ? 'text-up' : 'text-down'}>{v >= 0 ? '▲' : '▼'} {Math.abs(v).toFixed(2)}%</span>;
}

// ---- Sparkline (single series — thin line, no legend needed) -----------------
export function Sparkline({ data = [], width = 120, height = 36, tone }) {
  if (!data || data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - 3 - ((v - min) / range) * (height - 6)}`).join(' ');
  const rising = data[data.length - 1] >= data[0];
  const color = tone || (rising ? 'var(--up)' : 'var(--down)');
  return (
    <svg width={width} height={height} className="spark" role="img" aria-label={`Price trend, ${rising ? 'rising' : 'falling'}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---- Notifications (investor + admin share the endpoint) ----------------------
// A module-level store shared by every useNotifications() instance, so the Bell
// in the layout header and the Notifications page always agree — mark-all-read
// or a new SSE event updates all of them at once (the Bell never remounts, so
// per-instance state would leave its badge stale).
const notifStore = { items: [], unread: 0, listeners: new Set(), sseWired: false, loaded: false };

function notifEmit() {
  const snapshot = { items: notifStore.items, unread: notifStore.unread };
  for (const fn of notifStore.listeners) fn(snapshot);
}

async function notifLoad() {
  try {
    const d = await api.get('/api/notifications/mine');
    notifStore.items = d.notifications;
    notifStore.unread = d.unread;
    notifStore.loaded = true;
    notifEmit();
  } catch { /* not logged in yet */ }
}

function notifWireSse() {
  if (notifStore.sseWired) return;
  notifStore.sseWired = true;
  subscribe('notification', (n) => {
    notifStore.items = [{ ...n, is_read: 0 }, ...notifStore.items];
    notifStore.unread += 1;
    notifEmit();
  });
}

export function useNotifications() {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((x) => x + 1);
    notifStore.listeners.add(listener);
    notifWireSse();
    if (!notifStore.loaded) notifLoad();
    return () => notifStore.listeners.delete(listener);
  }, []);
  const markAllRead = useCallback(async () => {
    await api.post('/api/notifications/read', { ids: 'all' });
    notifStore.items = notifStore.items.map((n) => ({ ...n, is_read: 1 }));
    notifStore.unread = 0;
    notifEmit();
  }, []);
  return { items: notifStore.items, unread: notifStore.unread, markAllRead, reload: notifLoad };
}
