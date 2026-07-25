# Deploying Finvora

Full, do-it-yourself steps (move to another laptop, push to your own GitHub, go
live) are in **[START_HERE.md](START_HERE.md)**. Quick reference below.

The app is one service: the API server also serves the built PWA. It needs an
always-on process (live-feed poller, Server-Sent Events, SQLite), so it runs on a
host that keeps a process alive — **Render** (or Railway). The marketing site
(`landing/`) is static and can go on **Vercel**.

| Part | Folder | Host |
|---|---|---|
| App (API + PWA) | repo root | **Render** (uses `render.yaml`) |
| Landing site | `landing/` | **Vercel** (Root Directory = `landing`) |

## App on Render (one click)
1. https://render.com → sign in with GitHub → **New + → Blueprint** → pick your repo → **Apply**.
2. `render.yaml` builds the PWA and starts the server on one URL (e.g. `https://<name>.onrender.com`).
3. Log in as admin (`9999999999` / `Admin@123`) and change the password.
4. Set your bank / UPI / QR in **Admin → Settings → Payment Details** (none are hard-coded).

Free tier sleeps after ~15 min idle; add a persistent disk (paid) + `DATA_DIR=/var/data`
to keep data across redeploys.

## Landing on Vercel
1. https://vercel.com → import your repo → **Root Directory = `landing`** → Framework **Other** → Deploy.
2. In `landing/index.html` set `APP_URL` to your Render URL so the buttons open the app.

## Going live (optional, set on the app host)
- Real SMS OTP: `SMS_MODE=twilio` + `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM`
- Feed: `FEED_MODE=yahoo` (real NSE, default) or `sim` (demo)

See [`server/.env.example`](server/.env.example) for the full list.
