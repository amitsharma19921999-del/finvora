// Stage 2 — Registration: mobile + email + password, then OTP verification.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast, Field } from '../../components/ui';

const MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Register() {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ mobile: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => {
    const value = key === 'mobile' ? e.target.value.replace(/\D/g, '').slice(0, 10) : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((er) => ({ ...er, [key]: undefined }));
  };

  // Mirrors the server's rules so investors see problems before submitting.
  const validate = () => {
    const er = {};
    if (!MOBILE_RE.test(form.mobile)) er.mobile = 'Enter a valid 10-digit Indian mobile number.';
    if (!EMAIL_RE.test(form.email)) er.email = 'Enter a valid email address.';
    if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) {
      er.password = 'Password must be at least 8 characters with letters and numbers.';
    }
    if (form.confirm !== form.password) er.confirm = 'Passwords do not match.';
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const d = await api.post('/api/auth/register', {
        mobile: form.mobile,
        email: form.email.trim(),
        password: form.password,
      });
      toast.success(d.message || 'OTP sent to your mobile number.');
      navigate('/verify-otp', { state: { mobile: d.mobile, demo_otp: d.demo_otp, demo_mode: d.demo_mode } });
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
        <p className="auth-sub">Open your investment account in minutes. We&rsquo;ll verify your mobile number with an OTP.</p>

        <form onSubmit={submit} noValidate>
          <Field label="Mobile number" required error={errors.mobile}
            hint="10-digit Indian mobile — your OTP is sent here.">
            <input className="input" type="tel" inputMode="numeric" autoComplete="tel-national"
              placeholder="e.g. 9876543210" value={form.mobile} onChange={set('mobile')} />
          </Field>

          <Field label="Email address" required error={errors.email}>
            <input className="input" type="email" autoComplete="email"
              placeholder="you@example.com" value={form.email} onChange={set('email')} />
          </Field>

          <Field label="Password" required error={errors.password}
            hint="At least 8 characters, with both letters and numbers.">
            <input className="input" type="password" autoComplete="new-password"
              placeholder="Create a password" value={form.password} onChange={set('password')} />
          </Field>

          <Field label="Confirm password" required error={errors.confirm}>
            <input className="input" type="password" autoComplete="new-password"
              placeholder="Re-enter your password" value={form.confirm} onChange={set('confirm')} />
          </Field>

          <button type="submit" className="btn btn-primary btn-lg btn-block mt-2" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="auth-foot">
          Already have an account? <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
