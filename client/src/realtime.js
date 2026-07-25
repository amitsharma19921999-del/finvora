// Real-time layer — one EventSource per session streaming named events from
// /api/stream: 'prices', 'notification', 'feedHealth', 'accountStatus'.
// EventSource auto-reconnects; the server primes new connections with a snapshot.
import { getToken, API_BASE } from './api';

let source = null;
const handlers = new Map(); // event -> Set<fn>
const EVENTS = ['prices', 'notification', 'feedHealth', 'accountStatus'];

function ensureConnected() {
  if (source || !getToken()) return;
  source = new EventSource(`${API_BASE}/api/stream?token=${encodeURIComponent(getToken())}`);
  for (const ev of EVENTS) {
    source.addEventListener(ev, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of handlers.get(ev) || []) fn(data);
    });
  }
}

export function subscribe(event, fn) {
  ensureConnected();
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event)?.delete(fn);
}

export function disconnect() {
  if (source) { source.close(); source = null; }
  handlers.clear();
}

export function reconnect() {
  disconnect();
  ensureConnected();
}
