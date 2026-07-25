// Authentication: scrypt password hashing + HMAC-SHA256 JWTs (node:crypto only).
const crypto = require('crypto');
const config = require('./config');
const { get } = require('./db');

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, days = 7) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + days * 86400 };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  try {
    const [head, body, sig] = String(token).split('.');
    const expect = crypto.createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest('base64url');
    if (sig !== expect) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// EventSource and browser <img>/<a download> links cannot set an Authorization
// header, so a ?token= query param is allowed — but ONLY for GET requests on the
// specific streaming/download endpoints that need it. Every mutation (all POSTs)
// and every other route requires the header, so a leaked URL token cannot be
// replayed to change state or hit arbitrary endpoints.
const QUERY_TOKEN_PATHS = /^\/api\/(stream|files\/|statements\/|admin\/reports\/)/;

async function authFromRequest(req) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const fullPath = (req.baseUrl || '') + (req.path || ''); // routers strip the mount from req.path
  if (!token && req.method === 'GET' && QUERY_TOKEN_PATHS.test(fullPath)) token = req.query.token;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = await get('SELECT id, mobile, email, role, status FROM users WHERE id = ?', payload.uid);
  return user || null;
}

async function requireAuth(req, res, next) {
  const user = await authFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please login.' });
  if (user.status === 'Suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    next();
  });
}

module.exports = { verifyPassword, signToken, verifyToken, authFromRequest, requireAuth, requireAdmin };
