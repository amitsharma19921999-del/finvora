# Finvora Trading Platform

Complete Phase-1 implementation of the **Finvora Business Process Document v2.1** —
all 14 stages of the investor lifecycle, the Administrator Console with a real-time
Notification Centre, Payment Gateway Integration (webhook auto-verification),
Live Market Data Integration (feed health monitoring), and the full Reporting
Module including Audit and Gateway Settlement reports.

**100% free stack** — no paid services, no API keys required to run:
- **Client**: React + Vite **PWA** (installable on Android/iOS as a mobile app, works as a web app)
- **Server**: Node.js + Express + SQLite (built into Node — no database install)
- **Real-time**: Server-Sent Events (Notification Centre + live prices)
- **Payment gateway**: built-in mock PSP with signed webhooks (Razorpay test-mode adapter included)
- **Market feed**: built-in live simulator (free Yahoo Finance adapter included)

See **[FREE_SETUP_REQUIREMENTS.md](FREE_SETUP_REQUIREMENTS.md)** for the optional
free accounts (Razorpay test keys, Twilio trial, hosting) and how to plug them in.

## Run it (2 terminals)

```bash
# Terminal 1 — API server  (http://localhost:4000)
cd server
npm install
npm start

# Terminal 2 — PWA dev server  (http://localhost:5173)
cd client
npm install
npm run dev
```

Open **http://localhost:5173**.

| Role | Login | Password |
|---|---|---|
| Administrator | `9999999999` | `Admin@123` |
| Demo investor (optional, run `npm run seed` in server/) | `9876543210` | `Demo@123` |

New investors: **Register** → the OTP is shown on screen (demo mode) → complete
KYC + bank → the admin approves both → the account activates automatically.

## Production build (single server)

```bash
cd client && npm run build     # outputs client/dist
cd ../server && npm start      # serves API + PWA together on :4000
```

Deploy the `server/` folder (with `client/dist` built) to any free Node host
(Render.com free tier). The PWA is then installable from your HTTPS URL, and
[PWABuilder](https://www.pwabuilder.com) can wrap it into a free Play-Store APK.

## What's implemented (BPD v2.1 traceability)

| BPD Section | Implementation |
|---|---|
| Stage 1-2 Contact/Registration | Mobile+email+password with OTP verification (demo/Twilio modes) |
| Stage 3 Login | JWT auth, investor & admin roles |
| Stage 4 KYC | Submitted → Under Review → Approved/Rejected, PAN/Aadhaar validation, doc uploads, resubmission |
| Stage 5 Bank | Same lifecycle, IFSC/account validation, proof upload |
| Stage 6 Activation | Automatic when KYC + Bank both Approved |
| Stage 7 Deposits | Manual path (QR/details + proof + UTR) **and** gateway path (UPI/Card/NetBanking) |
| Stage 8 Verification | Manual: Pending → Under Verification → Approved/Rejected. Gateway: signed-webhook auto-approval, amount-match rule, duplicate-webhook dedup, timeout → reconciliation |
| Stage 9 Dashboard | Live LTP/bid-ask/high-low, "Data as of" timestamp, feed-health indicator |
| Stage 10/12 Orders | Price-band validation vs live LTP, auto-reject (insufficient balance/holdings), feed-down recording, Pending → Executing → Executed/Rejected/Cancelled |
| Stage 11 Execution | Admin trade desk: execute with price/qty, holdings & wallet update |
| Stage 13/14 Withdrawals | Available-balance rule, Pending → Processing → Completed/Rejected |
| Section 4.1 Notification Centre | Real-time (SSE) — all 7 alert types incl. Gateway Payment Failed & Feed Disconnected |
| Section 6.2 Reports | All 9 reports + CSV export (incl. Audit, Gateway Settlement, Feed Health) |
| Sections 8-10 | Business rules, validation rules and every exception scenario implemented & tested |
| Section 11 | Dependencies documented in FREE_SETUP_REQUIREMENTS.md |

## Tests

With the server running (`npm start` in `server/`):

```bash
cd server
node test/smoke.js        # 62 end-to-end checks across all 14 stages
node test/regression.js   # 13 checks guarding the security/correctness fixes
```

The codebase also passed an adversarial multi-agent review (5 dimensions ×
independent refutation); all 23 confirmed findings — money-math, auth, gateway
webhook atomicity/forgery, activation-rule bypass, and client-flow bugs — are
fixed and covered by the regression suite.

## Project layout

```
finvora/
├── server/            Express API + SQLite (node:sqlite), zero external services
│   ├── src/           config, db (schema+seed), auth, realtime (SSE), marketdata,
│   │   │              gateway (mock PSP + Razorpay), util (wallet/notify/audit)
│   │   └── routes/    auth, kyc-bank, deposits, orders, portfolio, withdrawals,
│   │                  admin, reports, market
│   └── test/smoke.js  full-journey API test
├── client/            React PWA (investor app + admin console)
│   ├── public/        manifest, service worker, generated icons
│   └── src/           api, realtime, auth, design system, shared components,
│       └── pages/     auth/, investor/ (11 pages), admin/ (12 pages)
└── docs/PAGES_SPEC.md UI build contract
```
