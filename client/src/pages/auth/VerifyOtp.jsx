// Stage 2 — OTP verification: 6-digit code confirms the mobile number and
// activates the session (status becomes "Registered").
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useToast } from '../../components/ui';

const RESEND_COOLDOWN = 30; // seconds

export default function VerifyOtp() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const toast = useToast();

  const mobile = location.state?.mobile || '';
  const [demoOtp, setDemoOtp] = useState(location.state?.demo_otp || null);
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);
  const boxes = useRef([]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Reached directly without a registration in progress — start over.
  if (!mobile) return <Navigate to="/register" replace />;

  const verify = async (code) => {
    if (busy) return;
    setBusy(true);
    try {
      const d = await api.post('/api/auth/verify-otp', { mobile, code });
      toast.success(d.message || 'Account created successfully.');
      login(d.token, d.user);
      navigate('/app', { replace: true });
    } catch (err) {
      toast.error(err.message);
      setDigits(['', '', '', '', '', '']);
      boxes.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  const applyDigits = (next, focusIndex) => {
    setDigits(next);
    if (focusIndex !== undefined) boxes.current[focusIndex]?.focus();
    if (next.every((d) => d !== '')) verify(next.join(''));
  };

  const onChange = (i, raw) => {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      const next = [...digits];
      next[i] = '';
      setDigits(next);
      return;
    }
    // Typing multiple digits (or a paste routed into onChange) fills forward.
    const next = [...digits];
    let j = i;
    for (const ch of clean.slice(0, 6 - i)) { next[j] = ch; j += 1; }
    applyDigits(next, Math.min(j, 5));
  };

  const onKeyDown = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) {
        next[i] = '';
        setDigits(next);
      } else if (i > 0) {
        next[i - 1] = '';
        setDigits(next);
        boxes.current[i - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      boxes.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < 5) {
      boxes.current[i + 1]?.focus();
    }
  };

  const onPaste = (e) => {
    e.preventDefault();
    const clean = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!clean) return;
    const next = ['', '', '', '', '', ''];
    clean.split('').forEach((ch, idx) => { next[idx] = ch; });
    applyDigits(next, Math.min(clean.length, 5));
  };

  const resend = async () => {
    setResending(true);
    try {
      const d = await api.post('/api/auth/resend-otp', { mobile });
      toast.success(d.message || 'OTP re-sent.');
      if (d.demo_otp) setDemoOtp(d.demo_otp);
      setCooldown(RESEND_COOLDOWN);
      setDigits(['', '', '', '', '', '']);
      boxes.current[0]?.focus();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setResending(false);
    }
  };

  const maskedMobile = `+91 ${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}`;

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-mark" aria-hidden>FV</span>
          <span className="logo-text">FIN<b>VORA</b></span>
        </div>
        <p className="auth-sub">Enter the 6-digit OTP sent to {maskedMobile}. The code is valid for 10 minutes.</p>

        {demoOtp && (
          <div className="demo-otp">
            Demo mode — no SMS is sent. Your OTP is <b>{demoOtp}</b>
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); if (digits.every((d) => d !== '')) verify(digits.join('')); }}>
          <div className="otp-inputs" onPaste={onPaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { boxes.current[i] = el; }}
                className="otp-box"
                type="text"
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                maxLength={6}
                value={d}
                disabled={busy}
                aria-label={`OTP digit ${i + 1}`}
                autoFocus={i === 0}
                onChange={(e) => onChange(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onFocus={(e) => e.target.select()}
              />
            ))}
          </div>

          <button type="submit" className="btn btn-primary btn-lg btn-block mt-2"
            disabled={busy || digits.some((d) => d === '')}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
        </form>

        <p className="auth-foot">
          Didn&rsquo;t get the code?{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={resend}
            disabled={resending || cooldown > 0}>
            {resending ? 'Sending…' : cooldown > 0 ? `Resend OTP in ${cooldown}s` : 'Resend OTP'}
          </button>
        </p>
        <p className="auth-foot">
          Wrong number? <Link to="/register">Register again</Link> · <Link to="/login">Back to login</Link>
        </p>
      </div>
    </div>
  );
}
