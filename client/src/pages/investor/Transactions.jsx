// Transaction History — the wallet ledger. Every deposit, withdrawal, buy, sell
// and chargeback with signed amounts and the running balance after each entry.
import { useEffect, useState, useCallback } from 'react';
import { api, csvUrl, inr, fmtDateTime } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, MoneyStat, EmptyState, Spinner, DataTable } from '../../components/ui';

// Ledger entry types → badge tones (matches styles.css badge-* classes).
const TYPE_TONE = { DEPOSIT: 'green', WITHDRAWAL: 'amber', BUY: 'blue', SELL: 'purple', CHARGEBACK: 'red' };

function TypeBadge({ type }) {
  return <span className={`badge badge-${TYPE_TONE[type] || 'gray'}`}>{type}</span>;
}

function SignedAmount({ value }) {
  const n = Number(value) || 0;
  return (
    <span className={n >= 0 ? 'text-up' : 'text-down'}>
      {n >= 0 ? '+' : '−'}{inr(Math.abs(n))}
    </span>
  );
}

export default function Transactions() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/transactions/mine');
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    // New ledger entries follow deposits/withdrawals/executions — refresh on any notification.
    const un = subscribe('notification', () => load());
    return un;
  }, [load]);

  if (loading) return <Spinner label="Loading your transactions…" />;

  const wallet = data?.wallet;
  const rows = data?.transactions || [];

  const columns = [
    { key: 'created_at', label: 'When', render: (t) => <span className="small">{fmtDateTime(t.created_at)}</span> },
    { key: 'type', label: 'Type', render: (t) => <TypeBadge type={t.type} /> },
    { key: 'note', label: 'Details', render: (t) => <span className="small">{t.note || '—'}</span> },
    { key: 'amount', label: 'Amount', align: 'right', render: (t) => <SignedAmount value={t.amount} /> },
    { key: 'balance_after', label: 'Balance After', align: 'right', render: (t) => <span className="mono">{inr(t.balance_after)}</span> },
  ];

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Transactions</h1>
          <p className="page-sub">Your complete wallet ledger — money in, money out, and the balance after each entry.</p>
        </div>
        <a className="btn btn-sm" href={csvUrl('/api/statements/transactions')} download>Export CSV</a>
      </div>

      <div className="stat-grid">
        <MoneyStat label="Wallet Balance" value={wallet?.balance || 0} sub="Total funds in wallet" />
        <MoneyStat label="Available Balance" value={wallet?.available || 0} sub="Free to trade or withdraw" />
        <MoneyStat label="Reserved for Orders" value={wallet?.reserved_orders || 0} sub="Held by open buy orders" />
        <MoneyStat label="Reserved for Withdrawals" value={wallet?.reserved_withdrawals || 0} sub="Held by pending withdrawals" />
      </div>

      <Card title="Transaction History" subtitle="Latest entries first" pad={false}>
        {rows.length === 0 ? (
          <EmptyState
            icon="🧾"
            title="No transactions yet"
            text="Once you add funds or place trades, every wallet movement is recorded here."
          />
        ) : (
          <DataTable columns={columns} rows={rows} keyField="id" />
        )}
      </Card>
    </>
  );
}
