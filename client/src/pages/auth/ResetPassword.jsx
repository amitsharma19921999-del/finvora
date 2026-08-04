// Forgot password — step 2. Needs the admin-approved request plus the one-time
// code issued on approval. Both are checked server-side.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast, Field } from '../../components/ui';

export default function ResetPassword() {
  const navigate = useNavigate();
  const toast = useToast();
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) { toast.error('Enter your registered 10-digit mobile number.'); return; }
    if (!/^\d{4,8}$/.test(code.trim())) { toast.error('Enter the one-time code you received.'); return; }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      toast.error('Password must be at least 8 characters with letters and numbers.');
      return;
    }
    if (password !== confirm) { toast.error('Both passwords must match.'); return; }
    setBusy(true);
    try {
      const d = await api.post('/api/auth/reset-password', { mobile: mobile.trim(), code: code.trim(), password });
      toast.success(d.message);
      navigate('/login', { replace: true });
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
        <p className="auth-sub">Enter the one-time code from our team and choose a new password.</p>

        <form onSubmit={submit} noValidate>
          <Field label="Registered mobile number" required>
            <input className="input" type="tel" inputMode="numeric" maxLength={10} autoComplete="username"
              placeholder="9876543210" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="One-time code" required>
            <input className="input mono" type="text" inputMode="numeric" maxLength={8} autoComplete="one-time-code"
              placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="New password" required hint="At least 8 characters, with letters and numbers.">
            <input className="input" type="password" autoComplete="new-password"
              placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm new password" required>
            <input className="input" type="password" autoComplete="new-password"
              placeholder="Re-enter new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary btn-lg btn-block mt-2" disabled={busy}>
            {busy ? 'Updating…' : 'Set new password'}
          </button>
        </form>

        <p className="auth-foot">
          Don&apos;t have a code yet? <Link to="/forgot-password">Request a reset</Link>
        </p>
        <p className="auth-foot"><Link to="/login">Back to login</Link></p>
      </div>
    </div>
  );
}
