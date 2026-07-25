# Finvora — What YOU need to get (everything is FREE)

The application runs **fully free with zero signups** out of the box (demo/mock modes for OTP,
payment gateway, and market feed). The items below are the *optional* free accounts you can get
to switch each integration from demo mode to a real provider. Get them in any order — the app
works end-to-end without any of them.

## 0. Already on your machine (nothing to get)
- **Node.js v24** — already installed (checked). Runs the API server and builds the PWA.
- **Database** — SQLite, built into Node.js. No install, no server, no cost. Data lives in `server/data/finvora.db`.

## 1. Payment Gateway (Stage 7/8 — online deposits)  — FREE (test mode)
The app ships with a **built-in mock gateway** (UPI / Card / Net Banking simulator with real
signed webhooks) so you can demo the full auto-verified deposit flow with no account.

To use a real gateway in **test mode (free, no charges)**:
- Sign up at **https://razorpay.com** (free account, instant test keys — no business KYC needed for test mode)
- Dashboard → Settings → API Keys → *Generate Test Keys* → copy `Key Id` + `Key Secret`
- Dashboard → Settings → Webhooks → add `https://<your-server>/api/gateway/webhook`, set a webhook secret
- Put them in `server/.env`:
  ```
  GATEWAY_MODE=razorpay
  RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
  RAZORPAY_KEY_SECRET=xxxxxxxx
  RAZORPAY_WEBHOOK_SECRET=xxxxxxxx
  ```
- Going **live** later requires Razorpay's merchant KYC (free to complete; they take per-transaction fees only).
  Alternatives with the same model: PayU, Cashfree.

## 2. Live Market Data Feed (Stage 9) — FREE options
Ships with a built-in **simulated live feed** (random-walk NSE-style prices, tick-by-tick, feed
health monitor) — zero cost, zero signup, perfect for the Phase-1 "display only" requirement.

Free real-quote options when you want them:
- **Yahoo Finance (no key, unofficial)** — set `FEED_MODE=yahoo` in `server/.env`; NSE symbols are polled (e.g. `RELIANCE.NS`). Free, ~1–5s delayed, no signup.
- **Upstox / Zerodha Kite (broker market-data API)** — free API tier with a trading account, official licensed NSE/BSE data. For production, per the BPD Section 11.2, a licensed feed subscription is the commercial dependency.

## 3. SMS OTP (Stage 2) — FREE demo mode included
Default `SMS_MODE=demo`: the OTP is shown on-screen/in server logs (standard for development).
For real SMS later (free trial credits):
- **Twilio** — https://www.twilio.com/try-twilio (free trial credit; verify your own number)
- **MSG91 / Fast2SMS** (India) — free trial credits
- Set `SMS_MODE=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` in `server/.env`.

## 4. Hosting (optional — it runs on your PC for free)
- **Render.com** — free web service tier: deploy `server/` (it also serves the built PWA). Free account only.
- **Vercel / Netlify** — free static hosting for `client/dist` if you want the PWA on a separate CDN.
- A free `onrender.com` HTTPS URL is enough for the PWA to be installable on phones and for real gateway webhooks.

## 5. Mobile app (SDK/APK) — FREE
The client is a **PWA**: on any phone, open the URL → "Add to Home Screen" → it installs and runs
like a native app (standalone window, icon, offline shell). If you want an actual **APK** for the
Play Store: use **PWABuilder (https://www.pwabuilder.com)** or **Bubblewrap** — both free — pointed
at your hosted PWA URL. No code changes needed.

## Summary
| Integration | Works now with | Free upgrade |
|---|---|---|
| OTP | Demo (on-screen) | Twilio/MSG91 trial |
| Payment gateway | Built-in mock + signed webhooks | Razorpay **test keys** (free) |
| Market feed | Built-in simulator + health monitor | Yahoo (no key) / broker API |
| Database | SQLite (built-in) | — nothing needed |
| Hosting | Your PC (`npm run dev`) | Render.com free tier |
| Mobile app | Installable PWA | PWABuilder APK (free) |
