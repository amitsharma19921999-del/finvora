// Investor — Stage 4: KYC submission & verification status.
// Lifecycle: (none) -> Submitted -> Under Review -> Approved | Rejected (resubmit allowed).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../api';
import { useAuth } from '../../auth';
import { useToast, Card, Field, Spinner, StatusBadge, FileInput } from '../../components/ui';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Matches the server rule (util.js): a real Aadhaar never starts with 0 or 1.
const AADHAAR_RE = /^[2-9]\d{11}$/;
// Youngest allowed date of birth (must be 18+).
const MAX_DOB = new Date(Date.now() - 18 * 365.25 * 86400000).toISOString().slice(0, 10);

export default function Kyc() {
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const [loading, setLoading] = useState(true);
  const [kyc, setKyc] = useState(null);
  const [form, setForm] = useState({ full_name: '', dob: '', address: '', pan: '', aadhaar: '' });
  const [photo, setPhoto] = useState(null);
  const [idDoc, setIdDoc] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api.get('/api/kyc/mine');
      setKyc(d.kyc);
      if (d.kyc && d.kyc.status === 'Rejected') {
        // Pre-fill the resubmission form with what was sent last time.
        setForm({
          full_name: d.kyc.full_name || '',
          dob: d.kyc.dob || '',
          address: d.kyc.address || '',
          pan: d.kyc.pan || '',
          aadhaar: d.kyc.aadhaar || '',
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
    if (!PAN_RE.test(form.pan)) { toast.error('PAN must match the format ABCDE1234F.'); return; }
    if (!AADHAAR_RE.test(form.aadhaar)) { toast.error('Aadhaar must be the 12-digit number on your card (it never starts with 0 or 1).'); return; }
    if (!photo) { toast.error('Please upload your photograph.'); return; }
    if (!idDoc) { toast.error('Please upload your identity document.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/kyc', { ...form, photo, id_doc: idDoc });
      toast.success(res.message);
      setPhoto(null);
      setIdDoc(null);
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
      <h1 className="page-title">KYC Verification</h1>
      <p className="page-sub">Verify your identity to unlock funding and trading on Finvora.</p>
    </>
  );

  if (loading) return <>{header}<Spinner label="Checking your KYC status…" /></>;

  const status = kyc?.status;
  const bankApproved = me?.onboarding?.bank_status === 'Approved';

  // ---- In review: Submitted / Under Review -------------------------------------
  if (status === 'Submitted' || status === 'Under Review') {
    return (
      <>
        {header}
        <Card title="Your documents are with our team" actions={<StatusBadge status={status} />}>
          <p className="small">Submitted on {fmtDateTime(kyc.submitted_at)}</p>
          <div className="banner banner-info mt-2">
            <strong>What happens next?</strong> Our compliance team checks your PAN, Aadhaar and documents —
            this usually takes less than one working day. You will get a notification the moment the review is done,
            and your account activates automatically once both KYC and bank details are approved.
            No action is needed from you right now.
          </div>
          <div className="mt-2">
            <div className="row-between"><span className="small">Full name</span><span>{kyc.full_name}</span></div>
            <div className="row-between"><span className="small">Date of birth</span><span>{kyc.dob}</span></div>
            <div className="row-between"><span className="small">PAN</span><span className="mono">{kyc.pan}</span></div>
            <div className="row-between"><span className="small">Aadhaar</span><span className="mono">•••• •••• {String(kyc.aadhaar || '').slice(-4)}</span></div>
          </div>
          {!bankApproved && (
            <p className="small mt-2">
              While you wait, you can <Link to="/app/bank">submit your bank details</Link> — both reviews run in parallel.
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
        <Card title="KYC verified" actions={<StatusBadge status="Approved" />}>
          <div className="banner banner-success">
            Your identity has been verified{kyc.reviewed_at ? ` on ${fmtDateTime(kyc.reviewed_at)}` : ''}. This step is complete — you never need to do it again.
          </div>
          {bankApproved ? (
            <p className="mt-2">Your bank details are verified too, so your account is fully set up. Happy investing!</p>
          ) : (
            <>
              <p className="mt-2">One step left: add your bank account so deposits and withdrawals can be verified against it.</p>
              <Link className="btn btn-primary mt-2" to="/app/bank">Add bank details</Link>
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
          <strong>Your KYC was rejected.</strong> Reason: {kyc.reject_reason || 'Not specified.'} Your earlier
          details are pre-filled below — fix the issue, re-upload your documents and resubmit.
        </div>
      )}
      <Card
        title={status === 'Rejected' ? 'Resubmit your KYC' : 'Complete your KYC'}
        subtitle="Use the exact details printed on your PAN and Aadhaar cards."
      >
        <form className="form-grid" onSubmit={submit}>
          <Field label="Full name" hint="Exactly as printed on your PAN card." required>
            <input className="input" value={form.full_name} onChange={set('full_name')}
              placeholder="e.g. Rahul Sharma" minLength={3} autoComplete="name" required />
          </Field>
          <Field label="Date of birth" hint="You must be at least 18 years old to invest." required>
            <input className="input" type="date" value={form.dob} onChange={set('dob')} max={MAX_DOB} required />
          </Field>
          <div className="span-2">
            <Field label="Residential address" hint="Your complete current address, including city and PIN code." required>
              <textarea className="input" rows={3} value={form.address} onChange={set('address')}
                placeholder="House / flat, street, city, state, PIN code" minLength={10} required />
            </Field>
          </div>
          <Field label="PAN" hint="Format: ABCDE1234F" required>
            <input className="input mono" value={form.pan} maxLength={10} placeholder="ABCDE1234F"
              autoCapitalize="characters" spellCheck={false} required
              onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))} />
          </Field>
          <Field label="Aadhaar number" hint="The 12-digit number on your Aadhaar card." required>
            <input className="input mono" value={form.aadhaar} maxLength={12} inputMode="numeric"
              placeholder="234512345678" required
              onChange={(e) => setForm((f) => ({ ...f, aadhaar: e.target.value.replace(/\D/g, '') }))} />
          </Field>
          <FileInput label="Photograph" hint="A clear, recent passport-style photo of yourself." required
            value={photo} onChange={setPhoto} />
          <FileInput label="Identity document" hint="PAN card or Aadhaar card — photo or PDF." required
            value={idDoc} onChange={setIdDoc} />
          <div className="span-2 mt-2">
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Submitting…' : status === 'Rejected' ? 'Resubmit KYC' : 'Submit for verification'}
            </button>
            <p className="small mt-2">
              Your documents are stored securely and used only to verify your identity, as required by regulation.
            </p>
          </div>
        </form>
      </Card>
    </>
  );
}
