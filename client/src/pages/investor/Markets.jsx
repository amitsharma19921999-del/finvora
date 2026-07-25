// Markets / Discover — the flagship customer-facing screen: live indices strip,
// product shortcuts, top movers (gainers/losers/most-active) and a live watchlist.
// Everything stays live: useLivePrices() streams indices + quotes, and the movers
// list re-fetches on each 'prices' tick, throttled to at most once every 4s.
import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, num } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Spinner, EmptyState, Segmented } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice, ChangePct } from '../../components/market';

const tnum = { fontVariantNumeric: 'tabular-nums' };

// Signed, 2-dp change value — green when up, red when down.
function signed(n) {
  const v = Number(n) || 0;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}

const SHORTCUTS = [
  { to: '/app/trade', icon: '📈', title: 'Stocks', sub: 'Invest in shares' },
  { to: '/app/fno', icon: '🎯', title: 'F&O', sub: 'Futures & Options' },
  { to: '/app/ipo', icon: '🚀', title: 'IPO', sub: 'Apply to new listings' },
  { to: null, icon: '🏦', title: 'Mutual Funds', sub: 'Curated fund baskets', soon: true },
];

function IndexTile({ ix }) {
  const up = Number(ix.change_pct) >= 0;
  const ink = up ? 'var(--up-ink)' : 'var(--down-ink)';
  return (
    <div
      style={{
        flex: '0 0 auto', minWidth: 168,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: '14px 16px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.02em', color: 'var(--text)' }}>
        {ix.symbol}
      </span>
      <span className="mono" style={{ ...tnum, fontSize: 21, fontWeight: 650, letterSpacing: '-.01em' }}>
        {Number(ix.ltp || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      <span className="mono" style={{ ...tnum, fontSize: 12.5, fontWeight: 600, color: ink }}>
        {signed(ix.change)} ({signed(ix.change_pct)}%)
      </span>
    </div>
  );
}

function ShortcutTile({ s }) {
  const inner = (
    <>
      <div style={{ fontSize: 26, lineHeight: 1 }} aria-hidden>{s.icon}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 650, fontSize: 15, color: 'var(--text)' }}>
          {s.title}
          {s.soon && <span className="badge badge-gray badge-sm">Coming soon</span>}
        </span>
        <span className="small" style={{ color: 'var(--text-3)' }}>{s.sub}</span>
      </div>
    </>
  );
  const style = {
    display: 'flex', alignItems: 'center', gap: 14,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', padding: '18px 20px',
    color: 'var(--text)', textDecoration: 'none',
    cursor: s.to ? 'pointer' : 'default', opacity: s.to ? 1 : 0.7,
  };
  if (!s.to) return <div style={style}>{inner}</div>;
  return <Link to={s.to} style={style} className="shortcut-tile">{inner}</Link>;
}

function MoverRow({ m }) {
  const up = Number(m.change_pct) >= 0;
  return (
    <Link
      to="/app/trade"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 4px', borderBottom: '1px solid var(--border-soft)',
        color: 'var(--text)', textDecoration: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <strong style={{ fontSize: 14 }}>{m.symbol}</strong>
        <span className="small" style={{ color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
          {m.name}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
        <span className="mono" style={{ ...tnum, fontWeight: 650, fontSize: 13.5 }}>{inr(m.ltp)}</span>
        <span style={{ fontSize: 12 }}><ChangePct value={m.change_pct} /></span>
      </div>
    </Link>
  );
}

function WatchRow({ q }) {
  return (
    <Link
      to="/app/trade"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 4px', borderBottom: '1px solid var(--border-soft)',
        color: 'var(--text)', textDecoration: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <strong style={{ fontSize: 14 }}>{q.symbol}</strong>
        <span className="small" style={{ color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
          {q.name}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
        <span className="mono" style={{ ...tnum, fontSize: 13.5 }}><LivePrice value={q.ltp} /></span>
        <span style={{ fontSize: 12 }}><ChangePct value={q.change_pct} /></span>
      </div>
    </Link>
  );
}

export default function Markets() {
  const toast = useToast();
  const { indices, quotes, health, asOf } = useLivePrices();

  const [movers, setMovers] = useState(null);
  const [moversLoading, setMoversLoading] = useState(true);
  const [tab, setTab] = useState('gainers');
  const lastFetch = useRef(0);

  const loadMovers = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const d = await api.get('/api/markets/movers');
      setMovers(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setMoversLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadMovers();
    // Keep movers live — refetch on each price tick, throttled to <=1 / 4s.
    const un = subscribe('prices', () => {
      if (Date.now() - lastFetch.current >= 4000) loadMovers();
    });
    return un;
  }, [loadMovers]);

  const moverList = (movers && movers[tab]) || [];
  const watchlist = (quotes || []).slice(0, 8);

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Markets</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Live indices, movers and everything to trade.</p>
        </div>
        <FeedBadge health={health} asOf={asOf} />
      </div>

      {/* 1 — Live indices strip */}
      <div style={{ marginTop: 24, marginBottom: 24 }}>
        {(!indices || indices.length === 0) ? (
          <Spinner label="Loading indices…" />
        ) : (
          <div
            style={{
              display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4,
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {indices.map((ix) => <IndexTile key={ix.symbol} ix={ix} />)}
          </div>
        )}
      </div>

      {/* 2 — Product shortcuts */}
      <div
        style={{
          display: 'grid', gap: 14, marginBottom: 24,
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        }}
      >
        {SHORTCUTS.map((s) => <ShortcutTile key={s.title} s={s} />)}
      </div>

      {/* 3 — Top movers */}
      <Card
        title="Top Movers"
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'gainers', label: 'Gainers' },
              { value: 'losers', label: 'Losers' },
              { value: 'active', label: 'Most Active' },
            ]}
          />
        }
      >
        {moversLoading ? (
          <Spinner label="Loading movers…" />
        ) : moverList.length === 0 ? (
          <EmptyState icon="📊" title="Nothing to show" text="Movers appear here once the market feed has data." />
        ) : (
          <div>
            {moverList.map((m) => <MoverRow key={m.instrument_id} m={m} />)}
          </div>
        )}
      </Card>

      {/* 4 — Watchlist */}
      <Card
        title="Watchlist"
        actions={<Link className="btn btn-sm btn-ghost" to="/app/trade">See all</Link>}
      >
        {watchlist.length === 0 ? (
          <EmptyState icon="⭐" title="No instruments yet" text="Your tracked stocks will show live prices here." />
        ) : (
          <div>
            {watchlist.map((q) => <WatchRow key={q.instrument_id} q={q} />)}
          </div>
        )}
      </Card>
    </>
  );
}
