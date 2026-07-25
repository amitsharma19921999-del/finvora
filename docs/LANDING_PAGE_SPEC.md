# Finvora — Landing page content & config spec

Hand this to the design tool as the brief, then send the design back and we'll
code it as a static page (own route/site) that links to the PWA + APK download.

## Brand
- **Name:** Finvora  · wordmark "FIN·VORA", monogram "FV" (lime on charcoal)
- **Palette:** charcoal `#0c0c0e` bg · surfaces `#16171a` · **lime accent `#c6f628`** · green `#2ac075` / red `#ef5443` · text `#f4f5f6` / muted `#9ea1a9`
- **Type:** Inter. **Vibe:** premium fintech, dark, generous space (matches the app so the site→app transition is seamless).

## Sections (top → bottom)
1. **Top nav** — FV logo · Markets · Pricing · About · Contact · **[Open web app]** (lime) + **Login**.
2. **Hero** — headline (e.g. "Invest in 136+ NSE stocks. Live data. One clean app.") + subhead + two CTAs: **Download for Android (APK)** and **Open web app / Add to Home Screen** + a phone mockup showing the dashboard. A small "Live NSE data" chip.
3. **Trust strip** — logos/labels: NSE · BSE · live market data · secure. (No borrowed licences — see Legal below.)
4. **Feature grid (4–6):** Live 136-stock market watch & charts · F&O options chain · IPO calendar · Portfolio & P&L · Manual-desk execution (safety) · Deposits/withdrawals.
5. **How it works (4 steps):** Register → Complete KYC & bank → Add funds → Trade. *(This mirrors the app rule: trading unlocks only after KYC + bank verified **and** a deposit is made.)*
6. **App screenshots** — dashboard, trading terminal, markets, portfolio (from the live app).
7. **Security & trust** — encryption, manual review of every order, data privacy.
8. **FAQ** — is my money safe, how to start, charges, withdrawal time, etc.
9. **Download CTA band** — big "Get the Finvora app" + APK button + QR code to the PWA.
10. **Footer** — quick links, social, and the **Legal block** (below).

## Download wiring (we code this after design)
- **Download APK** button → `/downloads/finvora.apk` (host the file you generate via PWABuilder — see [APK_PWA_GUIDE.md](APK_PWA_GUIDE.md)).
- **Open web app** → your app URL (`app.finvora.…`). On mobile, also fire the PWA `beforeinstallprompt` for one-tap install.
- Optional **Play Store** badge once published.

## Legal / regulatory block — PLACEHOLDERS ONLY
> ⚠️ Do **not** use another broker's licence numbers. Fill these with **Finvora's own** details once the entity is registered, or leave blank until then.

```
Registered / Corporate office: [Your registered office address]
SEBI Reg. No.:                 [Your SEBI registration number]
Exchange memberships:          NSE: [__]  BSE: [__]  MCX: [__]  (your own)
Depository (DP):               [Your DP ID — NSDL/CDSL]
CIN:                           [Your company CIN]
Research Analyst / AMFI:       [If applicable — your own]
Contact:                       [Your phone] · [Your email]
```
**Disclaimer (generic, safe to use as-is):**
> "Investments in the securities market are subject to market risks. Read all the
> related documents carefully before investing."

Useful-links row (public sites, fine to link): SEBI · NSE · BSE · NSDL · CDSL · MCX · NCDEX · RBI · AMFI.

© 2026 Finvora. All rights reserved.

## Contact section (use YOUR details)
Address, phone, email, and a "Chat with us" widget — all **your** contact info.
