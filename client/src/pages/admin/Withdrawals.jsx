// Admin — Withdrawal Approval (BPD Stage 14).
// Lifecycle: Withdrawal Pending → (approve) Processing → (complete) Completed.
// Reject at any open stage returns the reserved amount to the investor's wallet.
import { useCallback, useEffect, useState } from 'react';
import { api, inr, fmtDateTime } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, EmptyState, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';

const SEGMENTS = [
  { value: 'Open', label: 'Open' },
  { value: 'All', label: 'All' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Rejected', label: 'Rejected' },
];

const REJECT_REASONS = ['Bank details mismatch', 'Insufficient available balance', 'Suspicious activity — verification needed'];

export default function Withdrawals() {
  const toast = useToast();
  const [seg, setSeg] = useState('Open');
  const [items, setItems] = useState(null);
  const [busyRow, setBusyRow] = useState(null);

  // Reject… modal
  const [rejectWd, setRejectWd] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);

  const load = useCallback(async (segment) => {
    const s = segment || seg;
    try {
      // Completed / Rejected can be long histories — let the server filter those.
      const path = (s === 'Completed' || s === 'Rejected')
        ? `/api/admin/withdrawals?status=${encodeURIComponent(s)}`
        : '/api/admin/withdrawals';
      const d = await api.get(path);
      setItems(d.withdrawals);
    } catch (e) {
      toast.error(e.message);
      setItems((prev) => prev || []);
    }
  }, [seg]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setItems(null); load(seg); }, [seg]); // eslint-disable-line react-hooks/exhaustive-deps

  // New withdrawal requests raise admin notifications — keep the queue fresh.
  useEffect(() => subscribe('notification', () => load()), [load]);

  const review = async (wd, body, okFallback) => {
    setBusyRow(wd.id);
    try {
      const d = await api.post(`/api/admin/withdrawals/${wd.id}/review`, body);
      toast.success(d.message || okFallback);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyRow(null);
    }
  };

  const submitReject = async () => {
    if (!rejectWd) return;
    if (!rejectReason.trim()) { toast.error('Please give the investor a reason for the rejection.'); return; }
    setRejectBusy(true);
    try {
      const d = await api.post(`/api/admin/withdrawals/${rejectWd.id}/review`, {
        action: 'reject', reason: rejectReason.trim(),
      });
      toast.success(d.message || 'Withdrawal rejected.');
      setRejectWd(null);
      setRejectReason('');
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRejectBusy(false);
    }
  };

  const rows = (items || []).filter((w) => {
    if (seg === 'Open') return w.status === 'Withdrawal Pending' || w.status === 'Processing';
    if (seg === 'All') return true;
    return w.status === seg;
  });
  const openCount = seg === 'Open' || seg === 'All'
    ? (items || []).filter((w) => w.status === 'Withdrawal Pending' || w.status === 'Processing').length
    : null;

  const columns = [
    { key: 'created_at', label: 'Requested', render: (w) => <span className="small">{fmtDateTime(w.created_at)}</span> },
    {
      key: 'mobile', label: 'Investor',
      render: (w) => (
        <div>
          <div className="mono">{w.mobile}</div>
          {w.email && <div className="small text-muted">{w.email}</div>}
        </div>
      ),
    },
    { key: 'amount', label: 'Amount', align: 'right', render: (w) => <span className="mono strong">{inr(w.amount)}</span> },
    {
      key: 'bank_display', label: 'Bank Account',
      render: (w) => (w.bank_display ? <span className="small">{w.bank_display}</span> : <span className="text-muted small">No approved bank on file</span>),
    },
    {
      key: 'status', label: 'Status',
      render: (w) => (
        <div>
          <StatusBadge status={w.status} />
          {w.status === 'Rejected' && w.reject_reason && (
            <div className="small text-muted">{w.reject_reason}</div>
          )}
        </div>
      ),
    },
    {
      key: 'processed_at', label: 'Processed',
      render: (w) => (w.processed_at ? <span className="small">{fmtDateTime(w.processed_at)}</span> : <span className="text-muted">—</span>),
    },
    {
      key: 'actions', label: 'Actions',
      render: (w) => {
        if (w.status !== 'Withdrawal Pending' && w.status !== 'Processing') return <span className="text-muted">—</span>;
        const busy = busyRow === w.id;
        return (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {w.status === 'Withdrawal Pending' && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                onClick={() => review(w, { action: 'approve' }, 'Withdrawal approved — now Processing.')}>
                {busy ? 'Working…' : 'Approve → Processing'}
              </button>
            )}
            {w.status === 'Processing' && (
              <button type="button" className="btn btn-success btn-sm" disabled={busy}
                onClick={() => review(w, { action: 'complete' }, 'Withdrawal completed — funds transferred.')}>
                {busy ? 'Working…' : 'Mark Completed (funds transferred)'}
              </button>
            )}
            <button type="button" className="btn btn-danger btn-sm" disabled={busy}
              onClick={() => { setRejectReason(''); setRejectWd(w); }}>
              Reject…
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <h1 className="page-title">Withdrawal Approvals</h1>
      <p className="page-sub">
        When an investor requests a withdrawal, the amount is reserved from their available balance.
        <strong> Approve</strong> moves it to Processing while you transfer the funds via NEFT/RTGS to their approved
        bank account, then <strong>Mark Completed</strong> once the transfer is done — the wallet is debited at that
        point. Rejecting at any open stage releases the amount straight back to the investor's wallet.
      </p>

      <Card
        title="Withdrawal Requests"
        subtitle={openCount === null ? undefined : openCount > 0 ? `${openCount} request${openCount === 1 ? '' : 's'} awaiting action` : 'Nothing awaiting action'}
        actions={<Segmented options={SEGMENTS} value={seg} onChange={setSeg} />}
      >
        {items === null ? (
          <Spinner label="Loading withdrawals…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🏦"
            title={seg === 'Open' ? 'No withdrawals waiting for you.' : `No ${seg === 'All' ? '' : seg.toLowerCase() + ' '}withdrawals found.`}
            text={seg === 'Open' ? 'New withdrawal requests appear here the moment investors submit them.' : 'Try a different filter above.'}
          />
        ) : (
          <DataTable columns={columns} rows={rows} keyField="id" empty="No withdrawals found." />
        )}
      </Card>

      {/* ---- Reject… modal ---- */}
      <Modal
        open={!!rejectWd}
        onClose={() => !rejectBusy && setRejectWd(null)}
        title="Reject Withdrawal"
        footer={rejectWd && (
          <>
            <button type="button" className="btn btn-ghost" disabled={rejectBusy} onClick={() => setRejectWd(null)}>
              Back
            </button>
            <button type="button" className="btn btn-danger" disabled={rejectBusy || !rejectReason.trim()} onClick={submitReject}>
              {rejectBusy ? 'Rejecting…' : 'Reject Withdrawal'}
            </button>
          </>
        )}
      >
        {rejectWd && (
          <div>
            <p className="small">
              Rejecting the <span className="strong">{inr(rejectWd.amount)}</span> withdrawal for
              investor <span className="mono">{rejectWd.mobile}</span>. The amount will be released back to their
              wallet immediately, and the reason below is shown to the investor.
            </p>
            <div className="row mt-1" style={{ flexWrap: 'wrap' }}>
              {REJECT_REASONS.map((r) => (
                <button key={r} type="button" className="btn btn-outline btn-sm" disabled={rejectBusy}
                  onClick={() => setRejectReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <Field label="Reason (visible to the investor)" required>
              <textarea className="input" rows="3" value={rejectReason} disabled={rejectBusy}
                placeholder="e.g. Bank details mismatch — please re-verify your bank account."
                onChange={(e) => setRejectReason(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
