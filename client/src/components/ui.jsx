// Shared UI kit — every page builds from these. Keep pages consistent:
// <Card>, <Field>, <DataTable>, <StatusBadge>, <Modal>, <Toast> via useToast().
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { inr, fileToDataUrl } from '../api';

// ---- Toasts ------------------------------------------------------------------
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);
  const value = {
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
    info: (m) => push(m, 'info'),
  };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">{t.kind === 'success' ? '✓' : t.kind === 'error' ? '✕' : 'ℹ'}</span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Status badges — one map for every lifecycle status in the BPD ----------
const STATUS_TONE = {
  // KYC / Bank
  'Submitted': 'blue', 'Under Review': 'amber', 'Approved': 'green', 'Rejected': 'red',
  // Account
  'OTP Pending': 'gray', 'Registered': 'blue', 'Active': 'green', 'Suspended': 'red',
  // Deposits (manual + gateway)
  'Deposit Pending': 'blue', 'Deposit Under Verification': 'amber',
  'Deposit Approved': 'green', 'Deposit Rejected': 'red',
  'Payment Initiated': 'gray', 'Gateway Confirmation Pending': 'amber',
  'Deposit Approved (Auto)': 'green', 'Deposit Failed': 'red',
  // Orders
  'Pending': 'blue', 'Executing': 'amber', 'Executed': 'green', 'Cancelled': 'gray',
  // Withdrawals
  'Withdrawal Pending': 'blue', 'Processing': 'amber', 'Completed': 'green',
  // Misc
  'Not Submitted': 'gray', 'LIVE': 'green', 'DELAYED': 'amber', 'DOWN': 'red',
  'BUY': 'green', 'SELL': 'red', 'MANUAL': 'gray', 'GATEWAY': 'purple',
};
export function StatusBadge({ status, small }) {
  if (!status) return <span className="badge badge-gray">—</span>;
  const tone = STATUS_TONE[status] || 'gray';
  return <span className={`badge badge-${tone}${small ? ' badge-sm' : ''}`}>{status}</span>;
}

// ---- Building blocks ---------------------------------------------------------
export function Card({ title, subtitle, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, required, children }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}{required && <em className="req">*</em>}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Stat({ label, value, tone, sub }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${tone ? ` text-${tone}` : ''}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function MoneyStat({ label, value, tone, sub }) {
  return <Stat label={label} value={inr(value)} tone={tone} sub={sub} />;
}

export function EmptyState({ icon = '📭', title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <p className="empty-title">{title}</p>
      {text && <p className="empty-text">{text}</p>}
      {action}
    </div>
  );
}

// Password box with a show/hide eye, so you can check what you typed before
// submitting (mistyped passwords are the most common login failure).
export function PasswordInput({ value, onChange, placeholder = 'Your password', autoComplete = 'current-password', ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <input
        className="input pw-input"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        {...rest}
      />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {show ? '🙈' : '👁'}
      </button>
    </span>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return <div className="spinner-wrap"><span className="spinner" aria-hidden /> {label}</div>;
}

// ---- DataTable ----------------------------------------------------------------
// columns: [{ key, label, render?(row), align?, width? }]
// stickyLast: pins the final column (the row actions) to the right edge on phones,
// so buttons like "Sell" stay reachable without discovering the table scrolls sideways.
export function DataTable({ columns, rows, keyField = 'id', empty = 'No records yet.', onRowClick, stickyLast }) {
  if (!rows || rows.length === 0) return <EmptyState title={empty} />;
  return (
    <div className={`tbl-wrap${stickyLast ? ' tbl-sticky-last' : ''}`}>
      <table className="tbl">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align || 'left', width: c.width }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[keyField]} className={onRowClick ? 'row-click' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Modal --------------------------------------------------------------------
export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ---- File input with preview (KYC docs, proofs) -------------------------------
export function FileInput({ label, hint, required, value, onChange, accept = 'image/*,.pdf' }) {
  const ref = useRef(null);
  const [error, setError] = useState('');
  const pick = async (file) => {
    setError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      onChange(dataUrl);
    } catch (e) { setError(e.message); }
  };
  const isPdf = value && value.startsWith('data:application/pdf');
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <div className="file-input">
        <input ref={ref} type="file" accept={accept} hidden
          onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) pick(f); }} />
        {value ? (
          <div className="file-preview">
            {isPdf ? <span className="file-pdf">📄 PDF attached</span> : <img src={value} alt="preview" />}
            <div className="file-preview-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current.click()}>Replace</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Remove</button>
            </div>
          </div>
        ) : (
          <button type="button" className="file-drop" onClick={() => ref.current.click()}>
            <span aria-hidden>📎</span> Tap to upload <small>JPG / PNG / PDF</small>
          </button>
        )}
      </div>
    </Field>
  );
}

// ---- Segmented control / tabs -------------------------------------------------
export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
          className={`segment${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Onboarding stepper (Stages 2-6) ------------------------------------------
export function Stepper({ steps }) {
  // steps: [{ label, state: 'done' | 'current' | 'todo' | 'blocked', detail }]
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s.label} className={`step step-${s.state}`}>
          <span className="step-dot">{s.state === 'done' ? '✓' : i + 1}</span>
          <div className="step-info">
            <span className="step-label">{s.label}</span>
            {s.detail && <span className="step-detail">{s.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
