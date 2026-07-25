// Admin — Bank Account Verification Queue (BPD Stage 5).
// Lifecycle: Submitted -> Under Review -> Approved | Rejected (reason mandatory).
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, fileUrl } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'Submitted', label: 'Submitted' },
  { value: 'Under Review', label: 'Under Review' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Rejected', label: 'Rejected' },
];


// Uploaded bank proof — inline image preview, or a link for PDFs.
function DocView({ label, file }) {
  return (
    <div>
      <p className="small text-muted mb-1">{label}</p>
      {!file ? (
        <p className="small">Not uploaded.</p>
      ) : file.toLowerCase().endsWith('.pdf') ? (
        <a className="btn btn-sm" href={fileUrl(file)} target="_blank" rel="noreferrer">Open PDF</a>
      ) : (
        <a href={fileUrl(file)} target="_blank" rel="noreferrer" title="Open full size">
          <img src={fileUrl(file)} alt={label} style={{ maxWidth: '100%', borderRadius: 8 }} />
        </a>
      )}
    </div>
  );
}

export default function BankQueue() {
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null);        // bank record open in the review modal
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/bank' + (filter ? `?status=${encodeURIComponent(filter)}` : ''));
      setRows(d.bank);
    } catch (e) {
      toast.error(e.message);
      setRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => { setRows(null); load(); }, [load]);

  // New bank submissions arrive as admin notifications — refresh the queue live.
  useEffect(() => {
    const un = subscribe('notification', (n) => {
      if (!n || !n.type || n.type === 'BANK_SUBMITTED') load();
    });
    return un;
  }, [load]);

  const openReview = (row) => { setSel(row); setRejecting(false); setReason(''); };
  const closeReview = () => { if (!busy) { setSel(null); setRejecting(false); setReason(''); } };

  const review = async (action) => {
    if (!sel) return;
    if (action === 'reject' && reason.trim().length < 3) {
      toast.error('Enter a rejection reason — the investor will see it and can resubmit.');
      return;
    }
    setBusy(true);
    try {
      const body = action === 'reject' ? { action, reason: reason.trim() } : { action };
      const d = await api.post(`/api/admin/bank/${sel.id}/review`, body);
      toast.success(d.message);
      setSel(null); setRejecting(false); setReason('');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'submitted_at', label: 'Submitted', render: (r) => <span className="small">{fmtDateTime(r.submitted_at)}</span> },
    {
      key: 'holder_name', label: 'Account holder',
      render: (r) => (
        <div>
          <span className="strong">{r.holder_name}</span>
          <div className="small text-muted mono">{r.mobile}</div>
        </div>
      ),
    },
    {
      key: 'bank_name', label: 'Bank',
      render: (r) => (
        <div>
          {r.bank_name}
          <div className="small text-muted">{r.branch}</div>
        </div>
      ),
    },
    { key: 'account_number', label: 'Account no.', render: (r) => <span className="mono">{r.account_number}</span> },
    { key: 'ifsc', label: 'IFSC', render: (r) => <span className="mono">{r.ifsc}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => <button type="button" className="btn btn-sm btn-primary" onClick={() => openReview(r)}>Review</button>,
    },
  ];

  const actionable = sel && ['Submitted', 'Under Review'].includes(sel.status);

  return (
    <>
      <div className="row-between mb-2">
        <div>
          <h1 className="page-title">Bank Account Approvals</h1>
          <p className="page-sub">Match the proof document against the holder name, account number and IFSC. Approving bank details (with KYC) activates the investor's account and enables deposits and withdrawals.</p>
        </div>
      </div>

      <div className="mb-2">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      <Card title="Bank verification queue" subtitle={rows ? `${rows.length} submission${rows.length === 1 ? '' : 's'}` : undefined} pad={false}>
        {rows === null ? (
          <Spinner label="Loading bank submissions…" />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            empty={filter ? `No bank submissions with status "${filter}".` : 'No bank details submitted yet. New submissions appear here the moment investors send them.'}
          />
        )}
      </Card>

      <Modal
        open={Boolean(sel)}
        onClose={closeReview}
        title={sel ? `Bank Review — ${sel.holder_name}` : ''}
        wide
        footer={sel && (
          rejecting ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setRejecting(false); setReason(''); }}>Back</button>
              <button type="button" className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => review('reject')}>
                {busy ? 'Rejecting…' : 'Confirm Rejection'}
              </button>
            </>
          ) : actionable ? (
            <>
              {sel.status === 'Submitted' && (
                <button type="button" className="btn btn-warn" disabled={busy} onClick={() => review('under_review')}>
                  {busy ? 'Please wait…' : 'Move to Under Review'}
                </button>
              )}
              <button type="button" className="btn btn-success" disabled={busy} onClick={() => review('approve')}>
                {busy ? 'Approving…' : 'Approve'}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={closeReview}>Close</button>
          )
        )}
      >
        {sel && (
          <>
            <div className="row-between mb-2">
              <StatusBadge status={sel.status} />
              <span className="small text-muted">Submitted {fmtDateTime(sel.submitted_at)}</span>
            </div>

            {sel.status === 'Rejected' && sel.reject_reason && (
              <div className="banner banner-danger mb-2">Rejected: {sel.reject_reason}</div>
            )}
            {sel.status === 'Approved' && (
              <div className="banner banner-success mb-2">Approved {sel.reviewed_at ? `on ${fmtDateTime(sel.reviewed_at)}` : ''}.</div>
            )}

            <div className="form-grid">
              <div><p className="small text-muted mb-1">Account holder name</p><p className="strong">{sel.holder_name}</p></div>
              <div><p className="small text-muted mb-1">Account number</p><p className="mono">{sel.account_number}</p></div>
              <div><p className="small text-muted mb-1">IFSC code</p><p className="mono">{sel.ifsc}</p></div>
              <div><p className="small text-muted mb-1">Bank &amp; branch</p><p>{sel.bank_name} — {sel.branch}</p></div>
              <div><p className="small text-muted mb-1">Mobile</p><p className="mono">{sel.mobile || '—'}</p></div>
              <div><p className="small text-muted mb-1">Email</p><p>{sel.email || '—'}</p></div>
            </div>

            <div className="divider" />

            <div className="mt-2">
              <DocView label="Bank proof (cancelled cheque / passbook / statement)" file={sel.proof_file} />
            </div>

            {rejecting && (
              <div className="mt-3">
                <Field label="Rejection reason" required hint="The investor sees this message and can correct and resubmit.">
                  <textarea
                    className="input"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Account holder name does not match the uploaded proof."
                    autoFocus
                  />
                </Field>
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
