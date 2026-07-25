# Database — Supabase (free Postgres) for production

The app now uses **Postgres**. It picks the database automatically:

- **No `DATABASE_URL` set** → runs on an embedded **PGlite** (real Postgres in-process,
  file-persisted to `server/data/pgdata`). Great for local dev — zero setup.
- **`DATABASE_URL` set** → connects to that Postgres (your **Supabase** project) — this is
  what production uses, so your data is permanent and survives redeploys.

The schema + admin seed are created automatically on first boot. Nothing to run by hand.

## 1) Create the free Supabase database
1. Go to **https://supabase.com** → sign in → **New project**.
2. Pick a name + a strong **database password** (save it) + a region near you → **Create**.
3. Wait ~2 minutes for it to provision.

## 2) Get the connection string (use the **Session pooler** — works on Render)
1. In your project: **Connect** (top bar) → **Connection string** → **Session pooler** tab.
2. Copy the URI. It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-xx-xxxx-1.pooler.supabase.com:5432/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with the database password from step 1.

> Use the **Session pooler** (port 5432), not the "Direct connection" — Render can't reach
> Supabase's direct (IPv6-only) endpoint, but the pooler works over IPv4.

## 3) Give it to your app on Render
- Render → your `finvora` service → **Environment** → **Add Environment Variable**:
  - **Key:** `DATABASE_URL`
  - **Value:** the full connection string from step 2
- **Save** → Render redeploys. On boot the app creates all tables + the admin user in Supabase.

That's it — your data (users, KYC, deposits, orders, wallet) now lives in Supabase and is
permanent. You can even keep Render on the **free** plan.

## Local development
Just run `npm start` with **no** `DATABASE_URL` — it uses the embedded PGlite and stores data in
`server/data/pgdata`. To test against Supabase locally instead, set `DATABASE_URL` in your shell.

## Notes
- Free Supabase pauses a project after ~1 week of no activity; open the dashboard to resume.
- The admin login on a fresh database is `9999999999` / `Admin@123` — change it immediately.
- Set your bank / UPI / QR in **Admin → Settings → Payment Details** after first login.
