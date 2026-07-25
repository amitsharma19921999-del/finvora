// Platform Settings — the BPD-defined thresholds admins can tune at runtime.
import { useEffect, useState } from 'react';
import { api, fileToDataUrl, fileUrl } from '../../api';
import { useToast, Card, Field, Spinner } from '../../components/ui';

const PAY_FIELDS = [
  { key: 'pay_account_name', label: 'Account name (as on bank)' },
  { key: 'pay_account_holder', label: 'Account holder' },
  { key: 'pay_account_number', label: 'Account number' },
  { key: 'pay_ifsc', label: 'IFSC code' },
  { key: 'pay_bank', label: 'Bank name' },
  { key: 'pay_branch', label: 'Branch (optional)' },
  { key: 'pay_upi', label: 'UPI ID' },
  { key: 'pay_note', label: 'Note shown to customer' },
];

// Admin edits the bank / UPI / QR the customers pay to. No customer ever types
// these — they just see them and pay, then upload proof.
function PaymentSettingsCard() {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [qrUrl, setQrUrl] = useState(null);
  const [newQr, setNewQr] = useState(null); // data URL
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api.get('/api/admin/payment-settings');
      setForm(Object.fromEntries(PAY_FIELDS.map((f) => [f.key, d[f.key] || ''])));
      setQrUrl(d.pay_qr_file ? fileUrl(d.pay_qr_file) : null);
    } catch (e) { toast.error(e.message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const onQr = async (file) => {
    if (!file) return;
    try { setNewQr(await fileToDataUrl(file, 900)); } catch (e) { toast.error(e.message); }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/payment-settings', { ...form, ...(newQr ? { pay_qr: newQr } : {}) });
      toast.success('Payment details saved — customers now see these.');
      setNewQr(null);
      load();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  if (!form) return <Card title="Payment collection details"><Spinner label="Loading…" /></Card>;
  return (
    <Card title="Payment collection details" subtitle="Bank / UPI / QR your customers pay to. Change any time — it reflects instantly on the customer deposit screen.">
      <form onSubmit={save}>
        <div className="form-grid">
          {PAY_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <input className="input" value={form[f.key]} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} />
            </Field>
          ))}
        </div>
        <div className="mt-2">
          <div className="field-label">Payment QR (PhonePe / UPI scanner)</div>
          <div className="row" style={{ alignItems: 'center', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            {(newQr || qrUrl) && <img src={newQr || qrUrl} alt="Payment QR" style={{ width: 130, height: 130, objectFit: 'contain', background: '#fff', borderRadius: 8, border: '1px solid var(--border)' }} />}
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              {qrUrl || newQr ? 'Replace QR' : 'Upload QR'}
              <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; onQr(f); }} />
            </label>
          </div>
        </div>
        <div className="row mt-3">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Saving…' : 'Save payment details'}</button>
        </div>
      </form>
    </Card>
  );
}

const FIELDS = [
  {
    key: 'price_band_pct',
    label: 'Order price band (±%)',
    hint: 'Order price must be within ±X% of the live LTP. Orders priced outside the band are automatically rejected.',
    step: '0.1',
  },
  {
    key: 'webhook_timeout_min',
    label: 'Gateway webhook timeout (minutes)',
    hint: 'If the payment gateway sends no confirmation within this many minutes, the deposit is held for manual reconciliation instead of auto-crediting.',
    step: '1',
  },
  {
    key: 'feed_stale_sec',
    label: 'Feed staleness threshold (seconds)',
    hint: 'If no price tick arrives for this long, the market data feed is marked Delayed and dashboards warn investors.',
    step: '1',
  },
  {
    key: 'min_deposit',
    label: 'Minimum deposit (₹)',
    hint: 'Deposit requests below this amount are not accepted.',
    step: '1',
  },
  {
    key: 'min_withdrawal',
    label: 'Minimum withdrawal (₹)',
    hint: 'Withdrawal requests below this amount are not accepted.',
    step: '1',
  },
];

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState(null); // { key: 'stringValue' }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.get('/api/admin/settings');
        if (alive) {
          setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(d.settings[f.key] ?? '')])));
        }
      } catch (e) {
        if (alive) toast.error(e.message);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (e) => {
    e.preventDefault();
    const payload = {};
    for (const f of FIELDS) {
      const v = Number(form[f.key]);
      if (!Number.isFinite(v) || v <= 0) {
        toast.error(`${f.label} must be a number greater than zero.`);
        return;
      }
      payload[f.key] = v;
    }
    setBusy(true);
    try {
      const d = await api.post('/api/admin/settings', payload);
      toast.success(d.message);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Platform Settings</h1>
      <p className="page-sub">Risk and operational thresholds defined in the business process document.</p>

      {!form ? (
        <Card><Spinner label="Loading settings…" /></Card>
      ) : (
        <Card title="Thresholds" subtitle="These values control order validation, deposit reconciliation and feed monitoring">
          <div className="banner banner-info">
            Changes apply immediately — no restart needed. New orders, deposits and withdrawals are
            checked against the updated values straight away.
          </div>
          <form onSubmit={save}>
            <div className="form-grid">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} required>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step={f.step}
                    inputMode="decimal"
                    value={form[f.key]}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    required
                  />
                </Field>
              ))}
            </div>
            <div className="row mt-2">
              <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
                {busy ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </form>
        </Card>
      )}

      <PaymentSettingsCard />
    </>
  );
}
