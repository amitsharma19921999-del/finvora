// Admin — full investor profile (BPD Section 4): identity, wallet, KYC, bank,
// holdings and recent activity, plus Suspend / Reactivate account control.
// Suspension always records a reason (audit rule); manual activation of a
// Registered account is refused by the server — its message is surfaced as-is.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, inr, num, fmtDateTime } from '../../api';
import {
  useToast, Card, MoneyStat, EmptyState, Spinner, DataTable, Modal, StatusBadge,
} from '../../components/ui';

function KV({ label, children }) {
  return (
    <div className="row-between" style={{ padding: '6px 0' }}>
      <span className="small text-muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export default function InvestorDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Admin-set password. Existing passwords are one-way hashes — they can never be
  // read back or shown, so support works by setting a new one.
  const [pwdOpen, setPwdOpen] = useState(false);
  const [newPwd, setNewPwd] = useState('');

  // Manual wallet correction — used when a trade was deleted without reversing,
  // so the recorded balance needs putting back by hand.
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');

  const [adjMode, setAdjMode] = useState('set'); // 'set' = exact balance, 'delta' = +/- amount
  const [adjNotify, setAdjNotify] = useState(false);

  const adjustWallet = async () => {
    const val = Number(adjAmount);
    if (!Number.isFinite(val) || (adjMode === 'delta' && val === 0)) {
      toast.error(adjMode === 'set' ? 'Enter the balance you want.' : 'Enter a non-zero amount (minus sign to debit).');
      return;
    }
    if (adjReason.trim().length < 3) { toast.error('Enter a reason — it is kept in the audit log.'); return; }
    setBusy(true);
    try {
      const body = adjMode === 'set'
        ? { set_balance: val, reason: adjReason.trim(), notify: adjNotify }
        : { amount: val, reason: adjReason.trim(), notify: adjNotify };
      const d = await api.post(`/api/admin/investors/${id}/adjust-wallet`, body);
      toast.success(d.message);
      setAdjOpen(false);
      setAdjAmount(''); setAdjReason('');
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Remove the investor-facing messages a deletion generated.
  const clearNotifications = async (type) => {
    setBusy(true);
    try {
      const d = await api.post(`/api/admin/investors/${id}/notifications/clear`, type ? { type } : {});
      toast.success(d.message);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setPassword = async () => {
    if (newPwd.length < 8 || !/[A-Za-z]/.test(newPwd) || !/\d/.test(newPwd)) {
      toast.error('Password must be at least 8 characters with letters and numbers.');
      return;
    }
    setBusy(true);
    try {
      const d = await api.post(`/api/admin/investors/${id}/set-password`, { password: newPwd });
      toast.success(d.message);
      setPwdOpen(false);
      setNewPwd('');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get(`/api/admin/investors/${id}`);
      setData(d);
      setNotFound(false);
    } catch (e) {
      toast.error(e.message);
      if (e.status === 404) setNotFound(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (status, why) => {
    setBusy(true);
    try {
      const d = await api.post(`/api/admin/investors/${id}/status`, { status, reason: why || '' });
      toast.success(d.message);
      setSuspendOpen(false);
      setReason('');
      await load();
    } catch (e) {
      // e.g. server refuses manual Active while the account is still Registered.
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner label="Loading investor profile…" />;
  if (notFound || !data) {
    return (
      <div>
        <Link to="/admin/investors" className="btn btn-ghost btn-sm">← All investors</Link>
        <EmptyState icon="🔍" title="Investor not found" text="This profile may have been removed or the link is incorrect."
          action={<Link to="/admin/investors" className="btn btn-primary btn-sm">Back to investor list</Link>} />
      </div>
    );
  }

  const { user, wallet, kyc, bank, holdings, orders, deposits, withdrawals, transactions } = data;
  const displayName = (kyc && kyc.full_name) || user.email;
  const suspended = user.status === 'Suspended';

  return (
    <div>
      <Link to="/admin/investors" className="btn btn-ghost btn-sm">← All investors</Link>

      <div className="row-between mt-2" style={{ marginBottom: 18 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>{displayName}</h1>
          <p className="small text-muted mono" style={{ margin: 0 }}>#{user.id} · {user.mobile} · {user.email} · Registered {fmtDateTime(user.created_at)}</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <StatusBadge status={user.status} />
          {suspended ? (
            <button type="button" className="btn btn-success btn-sm" disabled={busy}
              onClick={() => setStatus('Active')}>
              {busy ? 'Working…' : 'Reactivate account'}
            </button>
          ) : (
            <button type="button" className="btn btn-danger btn-sm" disabled={busy}
              onClick={() => setSuspendOpen(true)}>
              Suspend account
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPwdOpen(true)}>
            Reset password
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setAdjAmount(''); setAdjReason(''); setAdjOpen(true); }}>
            Adjust balance
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <MoneyStat label="Wallet Balance" value={wallet.balance} />
        <MoneyStat label="Available to Trade" value={wallet.available} tone={wallet.available > 0 ? 'up' : undefined} />
        <MoneyStat label="Reserved for Orders" value={wallet.reserved_orders} sub="Pending / Executing buy orders" />
        <MoneyStat label="Reserved for Withdrawals" value={wallet.reserved_withdrawals} sub="Pending / Processing payouts" />
      </div>

      <div className="grid-2">
        <Card
          title="KYC summary"
          actions={<Link to="/admin/kyc" className="btn btn-sm">Open KYC queue</Link>}
        >
          {!kyc ? (
            <EmptyState icon="🪪" title="KYC not submitted yet" text="The investor has not sent identity documents for verification." />
          ) : (
            <>
              <KV label="Status"><StatusBadge status={kyc.status} /></KV>
              <KV label="Full name">{kyc.full_name}</KV>
              <KV label="PAN"><span className="mono">{kyc.pan}</span></KV>
              <KV label="Date of birth">{kyc.dob}</KV>
              <KV label="Submitted">{fmtDateTime(kyc.submitted_at)}</KV>
              {kyc.reviewed_at && <KV label="Reviewed">{fmtDateTime(kyc.reviewed_at)}</KV>}
              {kyc.status === 'Rejected' && kyc.reject_reason && (
                <div className="banner banner-danger mt-2">Rejected: {kyc.reject_reason}</div>
              )}
            </>
          )}
        </Card>

        <Card
          title="Bank account"
          actions={<Link to="/admin/bank" className="btn btn-sm">Open bank queue</Link>}
        >
          {!bank ? (
            <EmptyState icon="🏦" title="Bank details not submitted yet" text="The investor has not added a bank account for deposits and withdrawals." />
          ) : (
            <>
              <KV label="Status"><StatusBadge status={bank.status} /></KV>
              <KV label="Account holder">{bank.holder_name}</KV>
              <KV label="Bank">{bank.bank_name} — {bank.branch}</KV>
              <KV label="Account number"><span className="mono">{bank.account_number}</span></KV>
              <KV label="IFSC"><span className="mono">{bank.ifsc}</span></KV>
              <KV label="Submitted">{fmtDateTime(bank.submitted_at)}</KV>
              {bank.status === 'Rejected' && bank.reject_reason && (
                <div className="banner banner-danger mt-2">Rejected: {bank.reject_reason}</div>
              )}
            </>
          )}
        </Card>
      </div>

      <div className="grid-2 mt-2">
        <Card title="Holdings" subtitle="Current portfolio positions" pad={false}>
          <DataTable
            columns={[
              { key: 'symbol', label: 'Symbol', render: (h) => <strong className="mono">{h.symbol}</strong> },
              { key: 'qty', label: 'Qty', align: 'right', render: (h) => num(h.qty) },
              { key: 'avg_price', label: 'Avg. Price', align: 'right', render: (h) => inr(h.avg_price) },
              { key: 'invested', label: 'Invested', align: 'right', render: (h) => inr(h.qty * h.avg_price) },
            ]}
            rows={holdings}
            empty="No holdings — nothing bought yet."
          />
        </Card>

        <Card title="Recent orders" subtitle="Last 20 orders" pad={false}>
          <DataTable
            columns={[
              { key: 'id', label: 'ID', render: (o) => <span className="mono">#{o.id}</span> },
              {
                key: 'symbol', label: 'Order',
                render: (o) => (
                  <div>
                    <StatusBadge status={o.side} small /> <strong className="mono">{o.symbol}</strong>
                    <div className="small text-muted">{num(o.qty)} @ {inr(o.price)}{o.exec_price ? ` · filled @ ${inr(o.exec_price)}` : ''}</div>
                  </div>
                ),
              },
              { key: 'status', label: 'Status', render: (o) => <StatusBadge status={o.status} small /> },
              { key: 'created_at', label: 'Placed', render: (o) => <span className="small">{fmtDateTime(o.created_at)}</span> },
            ]}
            rows={orders}
            empty="No orders placed yet."
          />
        </Card>
      </div>

      <div className="grid-2 mt-2">
        <Card title="Recent deposits" subtitle="Last 20 deposits" pad={false}>
          <DataTable
            columns={[
              { key: 'id', label: 'ID', render: (d) => <span className="mono">#{d.id}</span> },
              { key: 'method', label: 'Method', render: (d) => <StatusBadge status={d.method} small /> },
              { key: 'amount', label: 'Amount', align: 'right', render: (d) => <span className="mono">{inr(d.amount)}</span> },
              { key: 'status', label: 'Status', render: (d) => <StatusBadge status={d.status} small /> },
              { key: 'created_at', label: 'Date', render: (d) => <span className="small">{fmtDateTime(d.created_at)}</span> },
            ]}
            rows={deposits}
            empty="No deposits made yet."
          />
        </Card>

        <Card title="Recent withdrawals" subtitle="Last 20 withdrawal requests" pad={false}>
          <DataTable
            columns={[
              { key: 'id', label: 'ID', render: (w) => <span className="mono">#{w.id}</span> },
              { key: 'amount', label: 'Amount', align: 'right', render: (w) => <span className="mono">{inr(w.amount)}</span> },
              { key: 'status', label: 'Status', render: (w) => <StatusBadge status={w.status} small /> },
              { key: 'created_at', label: 'Requested', render: (w) => <span className="small">{fmtDateTime(w.created_at)}</span> },
            ]}
            rows={withdrawals}
            empty="No withdrawal requests yet."
          />
        </Card>
      </div>

      <Card title="Recent transactions" subtitle="Wallet ledger — last 30 entries" className="mt-2" pad={false}>
        <DataTable
          columns={[
            { key: 'id', label: 'ID', render: (t) => <span className="mono">#{t.id}</span> },
            { key: 'type', label: 'Type', render: (t) => <span className="badge badge-gray badge-sm">{t.type}</span> },
            {
              key: 'amount', label: 'Amount', align: 'right',
              render: (t) => (
                <span className={`mono ${t.amount >= 0 ? 'text-up' : 'text-down'}`}>
                  {t.amount >= 0 ? '+' : ''}{inr(t.amount)}
                </span>
              ),
            },
            { key: 'balance_after', label: 'Balance After', align: 'right', render: (t) => <span className="mono">{inr(t.balance_after)}</span> },
            { key: 'note', label: 'Note', render: (t) => <span className="small text-muted">{t.note || '—'}</span> },
            { key: 'created_at', label: 'Date', render: (t) => <span className="small">{fmtDateTime(t.created_at)}</span> },
          ]}
          rows={transactions}
          empty="No wallet activity yet."
        />
      </Card>

      <Modal
        open={suspendOpen}
        onClose={() => !busy && setSuspendOpen(false)}
        title="Suspend investor account"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setSuspendOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={busy || reason.trim().length < 3}
              onClick={() => setStatus('Suspended', reason.trim())}>
              {busy ? 'Suspending…' : 'Suspend account'}
            </button>
          </>
        }
      >
        <p className="small text-2">
          Suspending blocks {displayName} from trading, deposits and withdrawals. The investor is notified
          immediately and the action is recorded in the audit log with your reason.
        </p>
        <label className="field mt-2">
          <span className="field-label">Reason for suspension<em className="req">*</em></span>
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. Suspicious deposit activity pending investigation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="field-hint">Required — shared with the investor and kept for audit.</span>
        </label>
      </Modal>

      <Modal
        open={pwdOpen}
        onClose={() => !busy && setPwdOpen(false)}
        title={`Set a new password for ${displayName}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setPwdOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || newPwd.length < 8}
              onClick={setPassword}>
              {busy ? 'Updating…' : 'Set password'}
            </button>
          </>
        }
      >
        <div className="banner banner-info small">
          Existing passwords are stored as one-way hashes, so they cannot be viewed — not by
          anyone, including administrators. You can only set a <b>new</b> one here.
        </div>
        <p className="small text-2 mt-2">
          Verify the investor&apos;s identity first. After saving, share the password over a
          verified channel and ask them to change it once they log in. This action is audited
          and {displayName} is notified.
        </p>
        <label className="field mt-2">
          <span className="field-label">New password<em className="req">*</em></span>
          <input
            className="input"
            type="text"
            autoComplete="new-password"
            placeholder="At least 8 characters, letters and numbers"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />
          <span className="field-hint">Shown in clear so you can read it out — it is never stored in this form.</span>
        </label>
      </Modal>

      <Modal
        open={adjOpen}
        onClose={() => !busy && setAdjOpen(false)}
        title={`Adjust wallet balance — ${displayName}`}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAdjOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={adjustWallet} disabled={busy || !adjAmount}>
              {busy ? 'Applying…' : 'Apply adjustment'}
            </button>
          </>
        )}
      >
        <div className="row-between small">
          <span className="text-muted">Current balance</span>
          <b className="mono">{inr(wallet.balance)}</b>
        </div>

        <div className="row mt-2" style={{ gap: 8 }}>
          <button type="button" className={`btn btn-sm ${adjMode === 'set' ? 'btn-primary' : ''}`}
            disabled={busy} onClick={() => { setAdjMode('set'); setAdjAmount(''); }}>
            Set exact balance
          </button>
          <button type="button" className={`btn btn-sm ${adjMode === 'delta' ? 'btn-primary' : ''}`}
            disabled={busy} onClick={() => { setAdjMode('delta'); setAdjAmount(''); }}>
            Credit / debit
          </button>
        </div>

        <label className="field mt-2">
          <span className="field-label">
            {adjMode === 'set' ? 'New balance (₹)' : 'Amount (₹) — minus to debit'}<em className="req">*</em>
          </span>
          <input className="input mono" type="number" step="0.01" value={adjAmount} disabled={busy}
            placeholder={adjMode === 'set' ? 'e.g. 12000' : 'e.g. 2628.80  or  -2628.80'}
            onChange={(e) => setAdjAmount(e.target.value)} />
          {adjAmount !== '' && Number.isFinite(Number(adjAmount)) ? (
            <span className="field-hint">
              {adjMode === 'set' ? (
                <>
                  Balance <b className="mono">{inr(wallet.balance)}</b> → <b className="mono">{inr(Number(adjAmount))}</b>
                  {' '}(a {Number(adjAmount) - (wallet.balance || 0) >= 0 ? 'credit' : 'debit'} of{' '}
                  <b className="mono">{inr(Math.abs(Number(adjAmount) - (wallet.balance || 0)))}</b>)
                </>
              ) : (
                <>New balance would be <b className="mono">{inr((wallet.balance || 0) + Number(adjAmount))}</b></>
              )}
            </span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">Reason<em className="req">*</em></span>
          <input className="input" type="text" value={adjReason} disabled={busy}
            placeholder="e.g. Correction after removing trade #142"
            onChange={(e) => setAdjReason(e.target.value)} />
        </label>

        <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={adjNotify} disabled={busy}
            onChange={(e) => setAdjNotify(e.target.checked)} style={{ marginTop: 3 }} />
          <span className="small">
            Notify the investor
            <span className="text-muted"> — off by default. The ledger entry is still written either way.</span>
          </span>
        </label>

        <div className="banner banner-info small mt-2">
          <div>
            <b>Clear their notifications</b>
            <div>Removes the &quot;Trade Removed&quot; messages a deletion produced.</div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => clearNotifications('ORDER_DELETED')}>
              Clear &quot;Trade Removed&quot;
            </button>
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => clearNotifications(null)}>
              Clear all
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
