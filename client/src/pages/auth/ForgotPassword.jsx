// Forgot password — step 1. Raises a reset request that an administrator must
// approve before any new password can be set (admin-gated reset policy).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast, Field } from '../../components/ui';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!identifier.trim()) { toast.error('Enter your registered mobile number or email.'); return; }
    setBusy(true);
    try {
      const d = await api.post('/api/auth/forgot-password', { identifier: identifier.trim(), note: note.trim() });
      setSent(true);
      toast.success(d.message);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-mark" aria-hidden>FV</span>
          <span className="logo-text">FIN<b>VORA</b></span>
        </div>

        {sent ? (
          <>
            <p className="auth-sub">Request sent for approval.</p>
            <div className="banner banner-info small">
              Our team reviews password resets manually for your security. Once approved you
              will receive a <b>one-time code</b> on your registered mobile — then you can set a
              new password. The code is valid for 30 minutes.
            </div>
            <button type="button" className="btn btn-primary btn-lg btn-block mt-2"
              onClick={() => navigate('/reset-password')}>
              I have my code — set a new password
            </button>
            <p className="auth-foot"><Link to="/login">Back to login</Link></p>
          </>
        ) : (
          <>
            <p className="auth-sub">Enter your registered mobile or email and we&apos;ll send the request to our team.</p>
            <form onSubmit={submit} noValidate>
              <Field label="Registered mobile number or email" required>
                <input className="input" type="text" inputMode="email" autoComplete="username"
                  placeholder="9876543210 or you@example.com"
                  value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
              </Field>
              <Field label="Message for the support team (optional)">
                <input className="input" type="text" maxLength={300}
                  placeholder="e.g. I changed my phone and cannot log in"
                  value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button type="submit" className="btn btn-primary btn-lg btn-block mt-2" disabled={busy}>
                {busy ? 'Sending…' : 'Request password reset'}
              </button>
            </form>
            <p className="auth-foot">
              Already have a code? <Link to="/reset-password">Set a new password</Link>
            </p>
            <p className="auth-foot"><Link to="/login">Back to login</Link></p>
          </>
        )}
      </div>
    </div>
  );
}
