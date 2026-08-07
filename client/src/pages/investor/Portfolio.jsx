// Stage 12 — Portfolio & Holdings: live-valued positions with P&L and wallet snapshot.
// Holdings come from /api/portfolio; live prices are merged over them on every tick
// so market value and unrealized P&L update in real time.
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, num } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, MoneyStat, EmptyState, Spinner, DataTable } from '../../components/ui';
import { useLivePrices, FeedBadge, LivePrice, ChangePct } from '../../components/market';
import { SellModal } from '../../components/sell';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function Portfolio() {
  const toast = useToast();
  const { byId, health, asOf } = useLivePrices();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sellRow, setSellRow] = useState(null); // holding open in the sell ticket

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/portfolio');
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    // Reload positions when something changes server-side (e.g. an order executes).
    const un = subscribe('notification', () => load());
    return un;
  }, [load]);

  if (loading) return <Spinner label="Loading your portfolio…" />;

  // Merge the latest live quote over each holding and revalue client-side.
  const holdings = (data?.holdings || []).map((h) => {
    const q = byId.get(h.instrument_id);
    const ltp = q ? q.ltp : h.ltp;
    const marketValue = r2(h.qty * ltp);
    const unrealized = r2(marketValue - h.invested);
    return {
      ...h,
      ltp,
      market_value: marketValue,
      unrealized_pnl: unrealized,
      pnl_pct: h.invested ? r2((unrealized / h.invested) * 100) : 0,
      day_change_pct: q ? q.change_pct : h.day_change_pct,
    };
  });

  const invested = r2(holdings.reduce((s, h) => s + h.invested, 0));
  const marketValue = r2(holdings.reduce((s, h) => s + h.market_value, 0));
  const unrealized = r2(marketValue - invested);
  const unrealizedPct = invested ? (unrealized / invested) * 100 : 0;
  const realized = r2(data?.totals?.realized_pnl || 0);
  const wallet = data?.wallet;

  const columns = [
    {
      key: 'symbol', label: 'Stock',
      render: (h) => (
        <div>
          <strong>{h.symbol}</strong>
          <div className="small">{h.name}</div>
        </div>
      ),
    },
    { key: 'qty', label: 'Qty', align: 'right', render: (h) => num(h.qty) },
    { key: 'avg_price', label: 'Avg. Price', align: 'right', render: (h) => inr(h.avg_price) },
    { key: 'ltp', label: 'LTP', align: 'right', render: (h) => <LivePrice value={h.ltp} /> },
    { key: 'day_change_pct', label: 'Day', align: 'right', render: (h) => <ChangePct value={h.day_change_pct} /> },
    { key: 'market_value', label: 'Value', align: 'right', render: (h) => inr(h.market_value) },
    {
      key: 'unrealized_pnl', label: 'P&L', align: 'right',
      render: (h) => (
        <span className={h.unrealized_pnl >= 0 ? 'text-up' : 'text-down'}>
          {h.unrealized_pnl >= 0 ? '+' : '−'}{inr(Math.abs(h.unrealized_pnl))}
          <span className="small"> ({h.unrealized_pnl >= 0 ? '+' : '−'}{Math.abs(h.pnl_pct).toFixed(2)}%)</span>
        </span>
      ),
    },
    {
      key: 'actions', label: '', align: 'right',
      // Sell straight from the row. Routing to the terminal instead would break
      // F&O positions — option contracts are not in the watchlist, so the
      // terminal cannot select them.
      render: (h) => (
        <button type="button" className="btn btn-sm btn-sell tap" onClick={() => setSellRow(h)}>Sell</button>
      ),
    },
  ];

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">Your holdings, valued with live market prices.</p>
        </div>
        <FeedBadge health={health} asOf={asOf} />
      </div>

      <div className="stat-grid">
        <MoneyStat label="Invested" value={invested} sub="Cost of current holdings" />
        <MoneyStat label="Market Value" value={marketValue} sub="At latest prices" />
        <MoneyStat
          label="Unrealized P&L"
          value={unrealized}
          tone={unrealized >= 0 ? 'up' : 'down'}
          sub={`${unrealized >= 0 ? '▲' : '▼'} ${Math.abs(unrealizedPct).toFixed(2)}%`}
        />
        <MoneyStat
          label="Realized P&L"
          value={realized}
          tone={realized >= 0 ? 'up' : 'down'}
          sub="From executed sell orders"
        />
        <MoneyStat label="Wallet Balance" value={wallet?.balance || 0} sub="Total funds in wallet" />
        <MoneyStat label="Available Balance" value={wallet?.available || 0} sub="Free to trade or withdraw" />
      </div>

      <Card title="Holdings" subtitle={holdings.length ? `${holdings.length} stock${holdings.length > 1 ? 's' : ''} held` : undefined} pad={false}>
        {holdings.length === 0 ? (
          <EmptyState
            icon="📊"
            title="No holdings yet"
            text="When your buy orders execute, your investments appear here with live prices and P&L."
            action={<Link className="btn btn-primary" to="/app/trade">Start Trading</Link>}
          />
        ) : (
          <DataTable columns={columns} rows={holdings} keyField="id" stickyLast />
        )}
      </Card>

      {sellRow && <SellModal holding={sellRow} onClose={() => setSellRow(null)} onDone={load} />}
    </>
  );
}
