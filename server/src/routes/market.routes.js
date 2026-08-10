// Stage 9 — Live Market Data endpoints + SSE stream (prices, notifications,
// feed health) and secure serving of uploaded documents.
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { requireAuth } = require('../auth');
const { addClient } = require('../realtime');
const market = require('../marketdata');

const router = express.Router();

router.get('/market/snapshot', requireAuth, (req, res) => {
  res.json(market.snapshot());
});

// OHLC candles for the trading-terminal chart. interval in minutes (1/5/15/60).
// Fetches real multi-day history on demand for the opened instrument (yahoo mode).
router.get('/market/candles', requireAuth, async (req, res) => {
  const instrumentId = Number(req.query.instrument_id);
  const interval = Math.max(1, Math.min(240, Number(req.query.interval) || 1));
  const limit = Math.max(20, Math.min(400, Number(req.query.limit) || 150));
  if (!instrumentId) return res.status(400).json({ error: 'instrument_id is required.' });
  try { await market.ensureDetail(instrumentId); } catch { /* fall back to cached/sim candles */ }
  res.json(market.getCandles(instrumentId, interval, limit));
});

// SSE — EventSource cannot set headers, so the JWT arrives as ?token=.
router.get('/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = addClient(res, req.user);
  // Prime the stream so dashboards render immediately.
  res.write(`event: prices\ndata: ${JSON.stringify(market.snapshot())}\n\n`);
  res.write(`event: feedHealth\ndata: ${JSON.stringify(market.publicHealth())}\n\n`);
});

// Uploaded documents (KYC photos/IDs, bank proofs, payment screenshots).
// Admin can view all; investors only their own (file names are prefixed u<id>-).
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
router.get('/files/:name', requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  // Admins see all; investors see their own uploads (u<id>- prefix) and the
  // shared payment QR (payqr- prefix), which any customer needs to pay.
  if (req.user.role !== 'admin' && !name.startsWith(`u${req.user.id}-`) && !name.startsWith('payqr-')) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const file = path.join(config.uploadsDir(), name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found.' });
  res.setHeader('Content-Type', MIME[name.split('.').pop()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

module.exports = { router };
