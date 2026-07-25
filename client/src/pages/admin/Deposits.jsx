// Admin — Deposit Verification & Approval (BPD Stage 8).
// Single funding path: manual bank / UPI / QR transfer to the company account.
//   Deposit Pending -> Under Verification -> Approved (credits wallet) | Rejected.
// (The online payment gateway was removed — customers only ever pay to the
//  admin-set bank / UPI / QR and upload proof.)
import { useCallback, useEffect, useState } from 'react';
import { api, inr, fmtDateTime, fileUrl } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Field, Spinner, DataTable, Modal, Segmented, StatusBadge } from '../../components/ui';

const ACTION_STATUSES = ['Deposit Pending', 'Deposit Under Verification'];

const FILTERS = [
  { value: 'action', label: 'Needs Action' },
  { value: 'all', label: 'All' },
];

function Info({ label, children }) {
  return (
    <div className="mt-1">
      <div className="small text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

export default function Deposits() {
  const toast = useToast();
  const [filter, setFilter] = useState('action');
  const [rows, setRows] = useState(null); // null = loading
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async (silent) => {
    if (!silent) setRows(null);
    try {
      const d = await api.get('/api/admin/deposits');
      let list = d.deposits || [];
      if (filter === 'action') list = list.filter((x) => ACTION_STATUSES.includes(x.status));
      setRows(list);
    } catch (e) {
      toast.error(e.message);
      setRows([]);
    }
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  // Real-time: any platform notification (new deposit, approval) refreshes the queue.
  useEffect(() => subscribe('notification', () => load(true)), [load]);

  const openDeposit = (d) => {
    setSelected(d);
    setShowReject(false); setRejectReason('');
  };
  const closeModal = () => { if (!busy) setSelected(null); };

  // Manual path: under_verification / approve / reject
  const manualReview = async (action, reason) => {
    setBusy(action);
    try {
      const body = reason ? { action, reason } : { action };
      const d = await api.post(`/api/admin/deposits/${selected.id}/review`, body);
      toast.success(d.message);
      if (action === 'under_verification') setSelected((s) => (s ? { ...s, status: d.status } : s));
      else setSelected(null);
      setShowReject(false); setRejectReason('');
      load(true);
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  const columns = [
    { key: 'created_at', label: 'Received', render: (d) => <span className="small">{fmtDateTime(d.created_at)}</span> },
    {
      key: 'mobile', label: 'Investor',
      render: (d) => (<div><div>{d.mobile}</div><div className="small text-muted">{d.email}</div></div>),
    },
    { key: 'amount', label: 'Amount', align: 'right', render: (d) => <span className="mono">{inr(d.amount)}</span> },
    {
      key: 'status', label: 'Status',
      render: (d) => <StatusBadge status={d.status} />,
    },
    {
      key: 'ref', label: 'Reference (UTR)',
      render: (d) => <span className="mono small">{d.utr || '—'}</span>,
    },
    {
      key: 'note', label: 'Notes',
      render: (d) => (d.review_note || d.reject_reason)
        ? <span className="small text-amber">{d.review_note || d.reject_reason}</span>
        : <span className="text-muted">—</span>,
    },
    {
      key: 'open', label: '',
      render: (d) => (
        <button type="button" className="btn btn-sm"
          onClick={(e) => { e.stopPropagation(); openDeposit(d); }}>
          Open
        </button>
      ),
    },
  ];

  const sel = selected;
  const isPdfProof = sel && sel.proof_file && sel.proof_file.toLowerCase().endsWith('.pdf');

  return (
    <div>
      <h1 className="page-title">Deposit Verification</h1>
      <p className="page-sub">
        Verify and approve investor bank / UPI transfers. Wallet credits happen only on
        approval; every rejection needs a reason.
      </p>

      <Segmented options={FILTERS} value={filter} onChange={setFilter} />

      <div className="mt-2">
        <Card
          title="Deposit requests"
          subtitle={rows === null ? 'Loading…' : `${rows.length} record${rows.length === 1 ? '' : 's'} — newest first, updates in real time`}
        >
          {rows === null ? (
            <Spinner label="Loading deposits…" />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              onRowClick={openDeposit}
              empty={filter === 'action'
                ? 'No deposits need your attention right now.'
                : 'No deposits yet.'}
            />
          )}
        </Card>
      </div>

      <Modal
        open={Boolean(sel)}
        onClose={closeModal}
        wide
        title={sel ? `Deposit #${sel.id} — Bank transfer` : ''}
      >
        {sel && (
          <div>
            <div className="grid-2">
              <Info label="Investor">
                {sel.mobile}
                <div className="small text-muted">{sel.email}</div>
              </Info>
              <Info label="Requested at">{fmtDateTime(sel.created_at)}</Info>
              <Info label="Amount claimed">{inr(sel.amount)}</Info>
              <Info label="Current status"><StatusBadge status={sel.status} /></Info>
            </div>

            {(sel.review_note || sel.reject_reason) && (
              <div className="banner banner-warn mt-2">
                {sel.review_note || sel.reject_reason}
              </div>
            )}

            <div className="mt-2">
              <Info label="UTR / transaction reference">
                <span className="mono">{sel.utr || '—'}</span>
              </Info>

              <Info label="Payment proof">
                {sel.proof_file ? (
                  isPdfProof ? (
                    <a className="btn btn-sm" href={fileUrl(sel.proof_file)} target="_blank" rel="noreferrer">
                      Open PDF proof
                    </a>
                  ) : (
                    <a href={fileUrl(sel.proof_file)} target="_blank" rel="noreferrer" title="Open full size">
                      <img src={fileUrl(sel.proof_file)} alt="Payment proof uploaded by the investor" />
                    </a>
                  )
                ) : (
                  <span className="small text-muted">No proof file attached.</span>
                )}
              </Info>

              {['Deposit Pending', 'Deposit Under Verification'].includes(sel.status) && (
                <div className="banner banner-info mt-2">
                  Verify against your bank: the screenshot, the actual credit in your account, the UTR, and the amount received.
                </div>
              )}

              {sel.status === 'Deposit Pending' && (
                <div className="row mt-2">
                  <button type="button" className="btn btn-primary" disabled={Boolean(busy)}
                    onClick={() => manualReview('under_verification')}>
                    {busy === 'under_verification' ? 'Moving…' : 'Move to Under Verification'}
                  </button>
                </div>
              )}

              {sel.status === 'Deposit Under Verification' && !showReject && (
                <div className="row mt-2">
                  <button type="button" className="btn btn-success" disabled={Boolean(busy)}
                    onClick={() => manualReview('approve')}>
                    {busy === 'approve' ? 'Approving…' : 'Approve (credits wallet)'}
                  </button>
                  <button type="button" className="btn btn-danger" disabled={Boolean(busy)}
                    onClick={() => setShowReject(true)}>
                    Reject
                  </button>
                </div>
              )}

              {showReject && (
                <div className="mt-2">
                  <Field label="Rejection reason" required
                    hint="Shared with the investor — e.g. UTR not found, amount not credited to our account.">
                    <textarea className="input" rows={3} value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Why is this deposit being rejected?" />
                  </Field>
                  <div className="row mt-1">
                    <button type="button" className="btn btn-danger"
                      disabled={Boolean(busy) || rejectReason.trim().length < 3}
                      onClick={() => manualReview('reject', rejectReason.trim())}>
                      {busy === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={Boolean(busy)}
                      onClick={() => setShowReject(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
