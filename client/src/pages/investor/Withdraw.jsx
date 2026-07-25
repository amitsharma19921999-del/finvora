// Stage 13 — Withdrawal Request. Requires an Active account and an Approved bank
// account; funds are paid out only to that verified account.
// Lifecycle: Withdrawal Pending -> Processing (NEFT/RTGS) -> Completed | Rejected.
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, fmtDateTime } from '../../api';
import { useAuth } from '../../auth';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, MoneyStat, EmptyState, Spinner, DataTable, StatusBadge } from '../../components/ui';

export default function Withdraw() {
  const toast = useToast();
  const { user, me, refreshMe } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/withdrawals/mine');
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    // Admin approvals/completions arrive as notifications — refresh the list live.
    const un = subscribe('notification', () => { load(); refreshMe(); });
    return un;
  }, [load, refreshMe]);

  const submit = async (e) => {
    e.preventDefault();
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error('Enter the amount you want to withdraw.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/withdrawals', { amount: amt });
      toast.success(res.message);
      setAmount('');
      await load();
      refreshMe();
    } catch (e2) {
      toast.error(e2.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !me) return <Spinner label="Loading withdrawal details…" />;

  const wallet = data?.wallet || me.wallet;
  const rows = data?.withdrawals || [];
  const bank = me.bank;
  const isActive = user?.status === 'Active';
  const bankApproved = bank?.status === 'Approved';
  const canWithdraw = isActive && bankApproved;
  const maskedBank = bank
    ? `${bank.bank_name} · A/C ••••${String(bank.account_number).slice(-4)} · IFSC ${bank.ifsc}`
    : null;

  const columns = [
    { key: 'created_at', label: 'Requested', render: (w) => <span className="small">{fmtDateTime(w.created_at)}</span> },
    { key: 'amount', label: 'Amount', align: 'right', render: (w) => inr(w.amount) },
    { key: 'status', label: 'Status', render: (w) => <StatusBadge status={w.status} /> },
    {
      key: 'reject_reason', label: 'Reason',
      render: (w) => (w.reject_reason ? <span className="text-down small">{w.reject_reason}</span> : '—'),
    },
    { key: 'processed_at', label: 'Processed', render: (w) => <span className="small">{fmtDateTime(w.processed_at)}</span> },
  ];

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Withdraw Funds</h1>
          <p className="page-sub">Transfer money from your wallet to your verified bank account.</p>
        </div>
      </div>

      {!isActive && (
        <div className="banner banner-warn">
          Your account isn't Active yet, so withdrawals are locked. Finish KYC and bank verification first.{' '}
          <Link to="/app">Go to onboarding</Link>
        </div>
      )}
      {isActive && !bankApproved && (
        <div className="banner banner-warn">
          Withdrawals are paid only to an approved bank account. Your bank details are{' '}
          {bank ? <>currently <StatusBadge status={bank.status} small /></> : 'not submitted yet'}.{' '}
          <Link to="/app/bank">Verify your bank account</Link>
        </div>
      )}

      <div className="stat-grid">
        <MoneyStat label="Available Balance" value={wallet?.available || 0} tone="up" sub="Maximum you can withdraw" />
        <MoneyStat label="Wallet Balance" value={wallet?.balance || 0} sub="Total funds in wallet" />
        <MoneyStat
          label="On Hold"
          value={(wallet?.reserved_orders || 0) + (wallet?.reserved_withdrawals || 0)}
          sub="Reserved by open orders and pending withdrawals"
        />
      </div>

      <div className="grid-2">
        <Card title="Request a Withdrawal" subtitle="Reviewed by our team, then transferred via NEFT/RTGS">
          <form onSubmit={submit}>
            <Field label="Amount (₹)" required hint="Minimum ₹100. Cannot exceed your Available Balance.">
              <div className="row">
                <input
                  className="input" type="number" min="1" step="0.01" inputMode="decimal"
                  placeholder="e.g. 5000" value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={!canWithdraw || busy}
                />
                <button
                  type="button" className="btn btn-ghost btn-sm"
                  onClick={() => setAmount(String(wallet?.available || ''))}
                  disabled={!canWithdraw || busy || !(wallet?.available > 0)}
                >
                  Max
                </button>
              </div>
            </Field>
            {canWithdraw && maskedBank && (
              <p className="small">Funds will be transferred to your approved bank account: <strong>{maskedBank}</strong></p>
            )}
            <button className="btn btn-primary btn-block mt-2" type="submit" disabled={!canWithdraw || busy}>
              {busy ? 'Submitting request…' : 'Request Withdrawal'}
            </button>
          </form>
        </Card>

        <Card title="How Withdrawals Work" subtitle="Track each request in the history below">
          <div className="small">
            <p>
              <StatusBadge status="Withdrawal Pending" small /> Your request is with our team for review.
              The amount is set aside from your Available Balance right away.
            </p>
            <p className="mt-2">
              <StatusBadge status="Processing" small /> Approved — the transfer to your bank is on its way via NEFT/RTGS.
            </p>
            <p className="mt-2">
              <StatusBadge status="Completed" small /> Money has reached your bank account and your wallet ledger is updated.
            </p>
            <p className="mt-2">
              <StatusBadge status="Rejected" small /> The request couldn't be processed — the reason appears in the history
              and the amount is released back to your Available Balance.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Withdrawal History" subtitle="Latest requests first" pad={false} className="mt-2">
        {rows.length === 0 ? (
          <EmptyState
            icon="🏦"
            title="No withdrawals yet"
            text="Your withdrawal requests and their progress will appear here."
          />
        ) : (
          <DataTable columns={columns} rows={rows} keyField="id" />
        )}
      </Card>
    </>
  );
}
