// API client. Same-origin by default (Vite dev proxy / single-host deploy).
// Set VITE_API_BASE to an absolute URL (e.g. https://finvora-api.onrender.com)
// to point a separately-hosted frontend (Vercel) at a remote backend (Render).
// Throws Error(message) with the server's human-readable error text.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const TOKEN_KEY = 'ix_token';
const USER_KEY = 'ix_user';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
};
export const storeSession = (token, user) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
export const updateStoredUser = (user) => localStorage.setItem(USER_KEY, JSON.stringify(user));
export const clearSession = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); };

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  // A 401 from an auth endpoint (e.g. wrong password on login) is a normal error,
  // not an expired session — don't force a logout/redirect over it.
  const isAuthEndpoint = /^\/api\/auth\/(login|register|verify-otp|resend-otp)$/.test(path);
  if (res.status === 401 && token && !isAuthEndpoint) {
    clearSession();
    window.location.href = '/login';
    throw new Error('Session expired. Please login again.');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body || {}),
};

// Public UI config (cached) — drives hiding of demo-only scaffolding in production.
let _appConfig = null;
export async function getAppConfig() {
  if (_appConfig) return _appConfig;
  try { _appConfig = await request('GET', '/api/app-config'); }
  catch { _appConfig = { brand: 'Finvora', demo_hints: false, sms_demo: false, gateway_mock: false }; }
  return _appConfig;
}

// CSV downloads need the auth token in the query string (no headers on <a> links).
export const csvUrl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}format=csv&token=${encodeURIComponent(getToken() || '')}`;
// Absolute URL for a stored file (KYC/bank/payment proofs) with the auth token.
export const fileUrl = (name) => `${API_BASE}/api/files/${name}?token=${encodeURIComponent(getToken() || '')}`;

// ---- formatting helpers used across all pages --------------------------------
export const inr = (n, opts = {}) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, ...opts }).format(Number(n) || 0);

export const num = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);

export const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).includes('T') || String(s).endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const timeAgo = (s) => {
  if (!s) return '';
  const d = new Date(String(s).includes('T') || String(s).endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

// Reads a File into a compressed data-URL (client-side downscale keeps uploads
// well under the server's 8MB limit). PDFs pass through unchanged.
export function fileToDataUrl(file, maxDim = 1400) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    if (file.type === 'application/pdf') {
      if (file.size > 7 * 1024 * 1024) return reject(new Error('PDF too large (max 7MB).'));
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(file);
      return;
    }
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return reject(new Error('Use a JPG, PNG, WebP image or PDF.'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')); };
    img.src = url;
  });
}
