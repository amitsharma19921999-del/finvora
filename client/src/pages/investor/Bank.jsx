// Investor — Stage 5: Bank account submission & verification status.
// Lifecycle: (none) -> Submitted -> Under Review -> Approved | Rejected (resubmit allowed).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../api';
import { useAuth } from '../../auth';
import { useToast, Card, Field, Spinner, StatusBadge, FileInput } from '../../components/ui';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

const maskAccount = (n) => {
  const s = String(n || '');
  return s.length <= 4 ? s : `•••• •••• ${s.slice(-4)}`;
};

export default function Bank() {
  const toast = useToast();
  const { user, me, refreshMe } = useAuth();
  const [loading, setLoading] = useState(true);
  const [bank, setBank] = useState(null);
  const [form, setForm] = useState({ holder_name: '', account_number: '', ifsc: '', bank_name: '', branch: '' });
  const [proof, setProof] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api.get('/api/bank/mine');
      setBank(d.bank);
      if (d.bank && d.bank.status === 'Rejected') {
        // Pre-fill the resubmission form with what was sent last time.
        setForm({
          holder_name: d.bank.holder_name || '',
          account_number: d.bank.account_number || '',
          ifsc: d.bank.ifsc || '',
          bank_name: d.bank.bank_name || '',
          branch: d.bank.branch || '',
        });
      }
    } catch (e) {
      toast.error(e.message);
    }
  };

  useEffect(() => {
    (async () => { await load(); setLoading(false); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!ACCOUNT_RE.test(form.account_number)) { toast.error('Account number should be 9 to 18 digits.'); return; }
    if (!IFSC_RE.test(form.ifsc)) { toast.error('IFSC must match the format HDFC0001234.'); return; }
    if (!proof) { toast.error('Please upload a cancelled cheque or bank proof.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/bank', { ...form, proof });
      toast.success(res.message);
      setProof(null);
      await load();
      refreshMe();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <>
      <h1 className="page-title">Bank Account</h1>
      <p className="page-sub">Link the bank account you will use for deposits and withdrawals.</p>
    </>
  );

  if (loading) return <>{header}<Spinner label="Checking your bank verification status…" /></>;

  const status = bank?.status;
  const kycApproved = me?.onboarding?.kyc_status === 'Approved';
  const accountActive = user?.status === 'Active';

  // ---- In review: Submitted / Under Review -------------------------------------
  if (status === 'Submitted' || status === 'Under Review') {
    return (
      <>
        {header}
        <Card title="Your bank details are being verified" actions={<StatusBadge status={status} />}>
          <p className="small">Submitted on {fmtDateTime(bank.submitted_at)}</p>
          <div className="banner banner-info mt-2">
            <strong>What happens next?</strong> Our team matches your account details against the proof you
            uploaded — usually within one working day. You will get a notification once the review is done, and
            your account activates automatically when both KYC and bank details are approved.
            Withdrawals will only ever go to this verified account.
          </div>
          <div className="mt-2">
            <div className="row-between"><span className="small">Account holder</span><span>{bank.holder_name}</span></div>
            <div className="row-between"><span className="small">Account number</span><span className="mono">{maskAccount(bank.account_number)}</span></div>
            <div className="row-between"><span className="small">IFSC</span><span className="mono">{bank.ifsc}</span></div>
            <div className="row-between"><span className="small">Bank &amp; branch</span><span>{bank.bank_name}, {bank.branch}</span></div>
          </div>
          {!kycApproved && (
            <p className="small mt-2">
              While you wait, make sure your <Link to="/app/kyc">KYC</Link> is submitted too — both reviews run in parallel.
            </p>
          )}
        </Card>
      </>
    );
  }

  // ---- Approved ----------------------------------------------------------------
  if (status === 'Approved') {
    return (
      <>
        {header}
        <Card title="Bank account verified" actions={<StatusBadge status="Approved" />}>
          <div className="banner banner-success">
            Your bank account is verified{bank.reviewed_at ? ` (on ${fmtDateTime(bank.reviewed_at)})` : ''}. All
            deposits and withdrawals will be matched against this account.
          </div>
          <div className="mt-2">
            <div className="row-between"><span className="small">Account holder</span><span>{bank.holder_name}</span></div>
            <div className="row-between"><span className="small">Account number</span><span className="mono">{maskAccount(bank.account_number)}</span></div>
            <div className="row-between"><span className="small">IFSC</span><span className="mono">{bank.ifsc}</span></div>
            <div className="row-between"><span className="small">Bank &amp; branch</span><span>{bank.bank_name}, {bank.branch}</span></div>
          </div>
          {accountActive ? (
            <>
              <p className="mt-2">Your account is active — you are ready to add funds and start investing.</p>
              <Link className="btn btn-primary mt-2" to="/app/funds">Add funds</Link>
            </>
          ) : kycApproved ? (
            <p className="mt-2">Your account will activate shortly now that both verifications are approved.</p>
          ) : (
            <>
              <p className="mt-2">One step left: complete your KYC so your account can activate.</p>
              <Link className="btn btn-primary mt-2" to="/app/kyc">Complete KYC</Link>
            </>
          )}
        </Card>
      </>
    );
  }

  // ---- Fresh form or resubmission after rejection ------------------------------
  return (
    <>
      {header}
      {status === 'Rejected' && (
        <div className="banner banner-danger">
          <strong>Your bank details were rejected.</strong> Reason: {bank.reject_reason || 'Not specified.'} Your
          earlier details are pre-filled below — fix the issue, re-upload your proof and resubmit.
        </div>
      )}
      <Card
        title={status === 'Rejected' ? 'Resubmit your bank details' : 'Add your bank details'}
        subtitle="Use an account held in your own name — money can only move between Finvora and this account."
      >
        <form className="form-grid" onSubmit={submit}>
          <Field label="Account holder name" hint="Exactly as it appears on your bank records." required>
            <input className="input" value={form.holder_name} onChange={set('holder_name')}
              placeholder="e.g. Rahul Sharma" minLength={3} autoComplete="name" required />
          </Field>
          <Field label="Account number" hint="9 to 18 digits, no spaces." required>
            <input className="input mono" value={form.account_number} maxLength={18} inputMode="numeric"
              placeholder="000123456789" required
              onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value.replace(/\D/g, '') }))} />
          </Field>
          <Field label="IFSC code" hint="Format: HDFC0001234 — printed on your cheque book and passbook." required>
            <input className="input mono" value={form.ifsc} maxLength={11} placeholder="HDFC0001234"
              autoCapitalize="characters" spellCheck={false} required
              onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))} />
          </Field>
          <Field label="Bank name" required>
            <input className="input" value={form.bank_name} onChange={set('bank_name')}
              placeholder="e.g. HDFC Bank" required />
          </Field>
          <Field label="Branch" required>
            <input className="input" value={form.branch} onChange={set('branch')}
              placeholder="e.g. Andheri West, Mumbai" required />
          </Field>
          <FileInput label="Cancelled cheque / bank proof"
            hint="A cancelled cheque, passbook front page or bank statement showing your name, account number and IFSC."
            required value={proof} onChange={setProof} />
          <div className="span-2 mt-2">
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Submitting…' : status === 'Rejected' ? 'Resubmit bank details' : 'Submit for verification'}
            </button>
            <p className="small mt-2">
              For your safety, withdrawals are only ever paid out to this verified bank account.
            </p>
          </div>
        </form>
      </Card>
    </>
  );
}
