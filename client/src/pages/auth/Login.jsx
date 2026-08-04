// Stage 3 — Login with mobile or email + password. Unverified accounts are
// routed back to OTP verification; roles land on their own dashboards.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getAppConfig } from '../../api';
import { useAuth } from '../../auth';
import { useToast, Field } from '../../components/ui';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoHints, setDemoHints] = useState(false);

  // Only surface the demo-login helper (incl. admin credentials) on an
  // unconfigured demo deployment — a configured/production server hides it.
  useEffect(() => { getAppConfig().then((c) => setDemoHints(!!c.demo_hints)); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      toast.error('Enter your mobile/email and password.');
      return;
    }
    setBusy(true);
    try {
      const d = await api.post('/api/auth/login', { identifier: identifier.trim(), password });
      login(d.token, d.user);
      navigate(d.user.role === 'admin' ? '/admin' : '/app', { replace: true });
    } catch (err) {
      // Mobile not verified yet — server issues a fresh OTP; finish verification.
      if (err.status === 403 && err.data?.need_otp) {
        toast.info(err.message);
        navigate('/verify-otp', {
          state: { mobile: err.data.mobile, demo_otp: err.data.demo_otp, demo_mode: err.data.demo_mode },
        });
      } else {
        toast.error(err.message);
      }
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
        <p className="auth-sub">Welcome back. Login to manage your investments.</p>

        <form onSubmit={submit} noValidate>
          <Field label="Mobile number or email" required>
            <input className="input" type="text" autoComplete="username" inputMode="email"
              placeholder="9876543210 or you@example.com"
              value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          </Field>

          <Field label="Password" required>
            <input className="input" type="password" autoComplete="current-password"
              placeholder="Your password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>

          <button type="submit" className="btn btn-primary btn-lg btn-block mt-2" disabled={busy}>
            {busy ? 'Logging in…' : 'Login'}
          </button>
        </form>

        <p className="auth-foot" style={{ marginTop: 12 }}>
          <Link to="/forgot-password">Forgot password?</Link>
        </p>

        {demoHints && (
          <div className="banner banner-info mt-2 small">
            <b>Demo logins</b><br />
            Admin: <span className="mono">9999999999</span> / <span className="mono">Admin@123</span><br />
            Investor: register a new account — OTPs appear on screen in demo mode.
          </div>
        )}

        <p className="auth-foot">
          New to Finvora? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
