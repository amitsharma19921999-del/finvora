// Stage 7 — Add Funds: ONE way to pay — transfer to the company's bank / UPI / QR
// (all set by the admin, reflected live here), then upload proof with the UTR.
// No online gateway, no customer-entered UPI: the destination is fixed by admin.
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, inr, fmtDateTime, fileUrl } from '../../api';
import { useAuth } from '../../auth';
import { subscribe } from '../../realtime';
import {
  useToast, Card, Field, MoneyStat, Spinner, DataTable,
  FileInput, StatusBadge,
} from '../../components/ui';

export default function Funds() {
  const { user } = useAuth();
  const toast = useToast();
  const active = user?.status === 'Active';

  // Company payment details (admin-controlled) + the deposit request form
  const [details, setDetails] = useState(null);
  const [manualAmount, setManualAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [proof, setProof] = useState(null);
  const [busyManual, setBusyManual] = useState(false);

  // History + wallet
  const [deposits, setDeposits] = useState([]);
  const [walletInfo, setWalletInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    try {
      const d = await api.get('/api/deposits/mine');
      setDeposits(d.deposits || []);
      setWalletInfo(d.wallet || null);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Reload the list the moment a deposit notification arrives (admin approval etc.)
  useEffect(() => {
    const un = subscribe('notification', () => { loadHistory(); });
    return un;
  }, [loadHistory]);

  // Company payment details (also carries min_deposit) — live from admin settings.
  useEffect(() => {
    if (!active || details) return;
    let alive = true;
    api.get('/api/deposits/payment-details')
      .then((d) => alive && setDetails(d))
      .catch((e) => alive && toast.error(e.message));
    return () => { alive = false; };
  }, [active, details]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(String(text));
      toast.success(`${label} copied to clipboard.`);
    } catch {
      toast.error('Could not copy automatically — please copy it manually.');
    }
  };

  const submitManual = async (e) => {
    e.preventDefault();
    setBusyManual(true);
    try {
      const res = await api.post('/api/deposits/manual', { amount: Number(manualAmount), utr, proof });
      toast.success(res.message);
      setManualAmount('');
      setUtr('');
      setProof(null);
      loadHistory();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyManual(false);
    }
  };

  const minDeposit = details?.min_deposit;
  const minHint = minDeposit ? `Minimum deposit is ${inr(minDeposit)}.` : 'Enter the amount you transferred.';

  const historyColumns = [
    { key: 'created_at', label: 'Date', render: (r) => <span className="small">{fmtDateTime(r.created_at)}</span> },
    { key: 'method', label: 'Method', render: (r) => <StatusBadge status={r.method} small /> },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span className="mono">{inr(r.amount)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'ref', label: 'Reference',
      render: (r) => {
        const ref = r.method === 'MANUAL' ? r.utr : (r.gateway_txn_id || r.gateway_order_id);
        return ref ? <span className="mono small">{ref}</span> : '—';
      },
    },
    {
      key: 'note', label: 'Remarks',
      render: (r) => {
        if (r.reject_reason) return <span className="small text-down">{r.reject_reason}</span>;
        if (r.review_note) return <span className="small text-muted">{r.review_note}</span>;
        return '—';
      },
    },
  ];

  return (
    <div>
      <h1 className="page-title">Add Funds</h1>
      <p className="page-sub">Transfer to our account below, then upload the payment proof. Once we verify it, your Finvora wallet is credited and ready to invest.</p>

      {walletInfo && (
        <div className="stat-grid mb-1">
          <MoneyStat label="Wallet Balance" value={walletInfo.balance} sub="Total funds in your wallet" />
          <MoneyStat label="Available to Invest" value={walletInfo.available} tone="up" sub="After holds for open orders & withdrawals" />
        </div>
      )}

      {!active ? (
        <div className="banner banner-warn">
          Your account isn’t active yet, so deposits are disabled. Finish KYC and bank verification first.{' '}
          <Link to="/app" className="strong">Go to onboarding →</Link>
        </div>
      ) : (
        <Card
          title="Add money to your wallet"
          subtitle="Pay to the account / UPI / QR below, then share the reference. This is the only deposit method."
        >
          <div className="grid-2">
            <div>
              <p className="strong mb-1">Step 1 — Pay to our account</p>
              {!details ? <Spinner label="Fetching payment details…" /> : (
                <div className="col gap-1">
                  {details.qr_file && (
                    <div style={{ textAlign: 'center', marginBottom: 8 }}>
                      <img src={fileUrl(details.qr_file)} alt="Scan to pay via UPI / PhonePe"
                        style={{ width: 190, height: 190, objectFit: 'contain', background: '#fff', borderRadius: 10, border: '1px solid var(--border)', padding: 6 }} />
                      <div className="small text-muted mt-1">Scan &amp; pay with any UPI app (PhonePe, GPay, Paytm…)</div>
                    </div>
                  )}
                  <div className="row-between">
                    <span className="small text-muted">Account name</span>
                    <span className="strong">{details.account_name}</span>
                  </div>
                  {details.account_holder && (
                    <div className="row-between">
                      <span className="small text-muted">Account holder</span>
                      <span className="strong">{details.account_holder}</span>
                    </div>
                  )}
                  <div className="row-between">
                    <span className="small text-muted">Account number</span>
                    <span className="row gap-1">
                      <span className="mono">{details.account_number}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(details.account_number, 'Account number')}>Copy</button>
                    </span>
                  </div>
                  <div className="row-between">
                    <span className="small text-muted">IFSC</span>
                    <span className="row gap-1">
                      <span className="mono">{details.ifsc}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(details.ifsc, 'IFSC code')}>Copy</button>
                    </span>
                  </div>
                  <div className="row-between">
                    <span className="small text-muted">Bank</span>
                    <span className="small">{details.bank}</span>
                  </div>
                  <div className="row-between">
                    <span className="small text-muted">UPI ID</span>
                    <span className="row gap-1">
                      <span className="mono">{details.upi_id}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(details.upi_id, 'UPI ID')}>Copy</button>
                    </span>
                  </div>
                  {details.note && <div className="banner banner-info small">{details.note}</div>}
                </div>
              )}
            </div>
            <div>
              <p className="strong mb-1">Step 2 — Share your payment details</p>
              <form onSubmit={submitManual}>
                <div className="form-grid">
                  <Field label="Amount paid (₹)" hint={minHint} required>
                    <input
                      className="input" type="number" inputMode="decimal" min="1" step="any"
                      placeholder="e.g. 10000" value={manualAmount}
                      onChange={(e) => setManualAmount(e.target.value)} required
                    />
                  </Field>
                  <Field label="UTR / reference number" hint="Find this in your bank or UPI app under the transaction details." required>
                    <input
                      className="input" type="text" placeholder="e.g. UTR2318744412"
                      value={utr} onChange={(e) => setUtr(e.target.value)} required
                    />
                  </Field>
                  <div className="span-2">
                    <FileInput
                      label="Payment proof" required value={proof} onChange={setProof}
                      hint="Screenshot or PDF of the payment confirmation."
                    />
                  </div>
                  <div className="span-2">
                    <button className="btn btn-primary btn-lg" type="submit" disabled={busyManual || !proof}>
                      {busyManual ? 'Submitting…' : 'Submit Deposit Request'}
                    </button>
                  </div>
                </div>
              </form>
              <p className="small text-muted mt-1">
                Our team verifies your payment against the bank statement. You’ll get a notification
                the moment your wallet is credited.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Deposit History"
        subtitle="Every deposit request and where it stands."
        className="mt-1"
      >
        {loading ? <Spinner label="Loading your deposits…" /> : (
          <DataTable
            columns={historyColumns}
            rows={deposits}
            empty="No deposits yet. Add funds above to start investing."
          />
        )}
      </Card>
    </div>
  );
}
