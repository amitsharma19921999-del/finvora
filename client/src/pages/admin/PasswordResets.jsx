// Admin — Password Reset Approvals.
// An investor's "forgot password" lands here as Pending. Approving issues a
// one-time code and opens a 30-minute window in which they may set a new password.
//
// Passwords themselves are stored as one-way scrypt hashes and can never be read
// back or displayed — support works by resetting, not by revealing.
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Used', label: 'Used' },
  { value: 'Rejected', label: 'Rejected' },
];

export default function PasswordResets() {
  const toast = useToast();
  const [filter, setFilter] = useState('Pending');
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null); // { mobile, code } shown after approval in demo SMS mode

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/password-resets' + (filter ? `?status=${encodeURIComponent(filter)}` : ''));
      setRows(d.resets);
    } catch (e) {
      toast.error(e.message);
      setRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => { setRows(null); load(); }, [load]);
  useEffect(() => subscribe('notification', (n) => {
    if (!n || !n.type || n.type === 'PASSWORD_RESET') load();
  }), [load]);

  const close = () => { setSel(null); setRejecting(false); setReason(''); };

  const review = async (action) => {
    if (action === 'reject' && reason.trim().length < 3) {
      toast.error('Enter a reason for the investor.');
      return;
    }
    setBusy(true);
    try {
      const d = await api.post(`/api/admin/password-resets/${sel.id}/review`, { action, reason: reason.trim() });
      toast.success(d.message);
      if (d.demo_otp) setIssued({ mobile: sel.mobile, code: d.demo_otp });
      close();
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'id', label: '#', width: 60 },
    {
      key: 'mobile', label: 'Investor',
      render: (r) => (
        <div>
          <strong className="mono">{r.mobile}</strong>
          <div className="small text-muted">{r.full_name || '—'} · {r.email}</div>
        </div>
      ),
    },
    { key: 'note', label: 'Their message', render: (r) => <span className="small">{r.note || '—'}</span> },
    { key: 'requested_at', label: 'Requested', render: (r) => <span className="small">{fmtDateTime(r.requested_at)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => (
        <button type="button" className="btn btn-sm tap" onClick={() => setSel(r)}>
          {r.status === 'Pending' ? 'Review' : 'View'}
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="row-between mb-2">
        <div>
          <h1 className="page-title">Password Resets</h1>
          <p className="page-sub">
            Verify the investor&apos;s identity, then approve to let them set a new password.
            Stored passwords are one-way hashes and can never be displayed — support resets, never reveals.
          </p>
        </div>
      </div>

      <div className="mb-2">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      {issued && (
        <div className="banner banner-warn mb-2">
          <div>
            <b>One-time code for {issued.mobile}: <span className="mono">{issued.code}</span></b>
            <div className="small">
              SMS is in demo mode, so no text was sent — read this code to the investor over a
              verified channel. It expires in 10 minutes and works once.
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setIssued(null)}>Dismiss</button>
        </div>
      )}

      <Card
        title="Reset requests"
        subtitle={rows ? `${rows.length} record${rows.length === 1 ? '' : 's'}` : undefined}
        pad={false}
      >
        {rows === null ? <Spinner label="Loading requests…" />
          : <DataTable columns={columns} rows={rows} keyField="id" empty="No password reset requests." stickyLast />}
      </Card>

      <Modal
        open={!!sel}
        onClose={close}
        title={sel ? `Reset request #${sel.id}` : ''}
        footer={sel && sel.status === 'Pending' && (
          rejecting ? (
            <>
              <button type="button" className="btn" onClick={() => setRejecting(false)} disabled={busy}>Back</button>
              <button type="button" className="btn btn-danger" onClick={() => review('reject')} disabled={busy}>
                {busy ? 'Rejecting…' : 'Confirm reject'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setRejecting(true)} disabled={busy}>Reject</button>
              <button type="button" className="btn btn-primary" onClick={() => review('approve')} disabled={busy}>
                {busy ? 'Approving…' : 'Approve reset'}
              </button>
            </>
          )
        )}
      >
        {sel && (
          <>
            <div className="row-between mb-2">
              <StatusBadge status={sel.status} />
              <span className="small text-muted">Requested {fmtDateTime(sel.requested_at)}</span>
            </div>
            <div className="row-between small"><span className="text-muted">Mobile</span><b className="mono">{sel.mobile}</b></div>
            <div className="row-between small"><span className="text-muted">Email</span><b>{sel.email}</b></div>
            <div className="row-between small"><span className="text-muted">Name</span><b>{sel.full_name || '—'}</b></div>
            {sel.reviewed_at && (
              <div className="row-between small"><span className="text-muted">Reviewed</span><b>{fmtDateTime(sel.reviewed_at)}</b></div>
            )}
            {sel.reject_reason && (
              <div className="row-between small"><span className="text-muted">Reject reason</span><b>{sel.reject_reason}</b></div>
            )}
            {sel.note && <p className="small mt-2"><b>Investor&apos;s message:</b> {sel.note}</p>}

            {rejecting ? (
              <Field label="Reason (shown to the investor)" required>
                <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Could not verify your identity over the phone." />
              </Field>
            ) : sel.status === 'Pending' && (
              <div className="banner banner-info small mt-2">
                Verify the investor&apos;s identity before approving. Approval sends a one-time code
                and lets them set a new password within 30 minutes.
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
