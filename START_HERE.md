# START HERE — Move Finvora to a new laptop, put it on GitHub, deploy it

This is a complete, do-it-yourself guide. You do **not** need any help — just follow
every line in order. There are two laptops:

- **OLD laptop** = where the project is now (you make the zip here).
- **NEW laptop** = where you upload to GitHub and deploy from.

What you end up with: a live website anyone can open, e.g. `https://finvora.onrender.com`.

Logins (after deploy):
- **Admin:** mobile `9999999999`  password `Admin@123`  ← change this immediately
- **Demo customer:** mobile `9876543210`  password `Demo@123`

---

## PART 1 — On the OLD laptop: make the zip

1. Close the app if it's running (press **Ctrl + C** in the terminal running it).
2. Open **PowerShell** (Start menu → type "PowerShell" → Enter).
3. In PowerShell, go **into** your project folder (the one that contains `server`, `client`,
   `landing`), then copy–paste the block below. It makes a clean `finvora.zip` on your Desktop:

   ```powershell
   # cd into your project folder first, e.g.:  cd "D:\...\insightx"
   $src   = (Get-Location).Path
   $stage = "$env:TEMP\finvora-ship"
   robocopy $src $stage /E /XD node_modules dist .git .vercel data | Out-Null
   Compress-Archive -Path "$stage\*" -DestinationPath "$env:USERPROFILE\Desktop\finvora.zip" -Force
   Remove-Item $stage -Recurse -Force
   "Done -> $env:USERPROFILE\Desktop\finvora.zip"
   ```

   The `data` folder is excluded on purpose — that's the local database full of
   **demo/test data** (the demo investor, test orders, etc.). Leaving it out means
   the new laptop starts with a **clean, empty database**: only the admin login and
   the real NSE instrument list, created automatically on first run. No mock data.

4. Copy `finvora.zip` from your Desktop to the NEW laptop (USB drive, Google Drive, or WeTransfer).

---

## PART 2 — On the NEW laptop: install 3 free tools

Install these (accept all defaults during install):

1. **Node.js v24 (LTS)** → https://nodejs.org
2. **Git** → https://git-scm.com/download/win
3. **GitHub CLI** → https://cli.github.com

Then open a **new** PowerShell window and check they installed (each should print a version):

```powershell
node -v
git --version
gh --version
```

Now unzip `finvora.zip` to a simple location, e.g. `C:\finvora`.
You should end up with the folder: `C:\finvora\insightx`.

---

## PART 3 — Upload to YOUR GitHub account

1. In PowerShell, go into the folder:

   ```powershell
   cd C:\finvora\insightx
   ```

2. Sign in to your GitHub account (a browser will open — log in with the account you want):

   ```powershell
   gh auth login
   ```
   Choose, in order: **GitHub.com** → **HTTPS** → **Login with a web browser** →
   copy the one-time code shown → press Enter → paste the code in the browser → Authorize.

3. Create your repo and upload the code (one command does it all):

   ```powershell
   git init
   git add -A
   git commit -m "Finvora trading platform"
   git branch -M main
   gh repo create finvora --private --source=. --push
   ```

Done. Your code is now at `https://github.com/YOUR-USERNAME/finvora` (private).
Your database and secret keys are **not** uploaded — they are ignored automatically.

> If `gh` didn't work: go to github.com → **New repository** → name it `finvora`,
> choose **Private**, do NOT add a README → **Create**. Then run:
> ```powershell
> git init
> git add -A
> git commit -m "Finvora"
> git branch -M main
> git remote add origin https://github.com/YOUR-USERNAME/finvora.git
> git push -u origin main
> ```
> When asked to sign in, use the browser popup that appears.

---

## PART 4 — Deploy the APP (customer + admin + live data)

This puts the whole working app online on ONE link (Render, free to start).

1. Go to https://render.com → **Get Started** → **Sign in with GitHub** → Authorize.
2. Click **New +** (top right) → **Blueprint**.
3. Pick your repo **`YOUR-USERNAME/finvora`** → **Connect**.
4. It reads the included `render.yaml` and shows one service named **finvora** → click **Apply**.
5. Wait about 5 minutes while it builds.
6. It gives you a URL like **`https://finvora.onrender.com`** — that's your live app
   (customer app AND admin at the same link). **Write this URL down — you need it in Part 5.**
7. Open the URL, log in as admin (`9999999999` / `Admin@123`), and change the password.

### PART 4b — Make your data permanent (free) with Supabase
On Render's free plan the local database resets on every redeploy. To keep your data
(users, KYC, deposits, orders) **permanently — for free**, connect a Supabase Postgres:
1. Create a free project at **https://supabase.com** (save the DB password).
2. **Connect → Connection string → Session pooler** → copy the URI, put your password in it.
3. Render → your `finvora` service → **Environment** → add
   **`DATABASE_URL`** = that URI → **Save** (it redeploys and creates all tables automatically).

Full walkthrough: **[docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)**. Without `DATABASE_URL`
the app still runs (local Postgres) but data resets on redeploy — fine only for testing.

Free-plan note: the site "sleeps" after ~15 min idle; the next visit wakes it in ~30 seconds.

---

## PART 5 — Deploy the LANDING PAGE (marketing website)

1. Go to https://vercel.com → **Sign in with GitHub** (same account).
2. **Add New → Project** → import **`finvora`**.
3. Set **Root Directory** = `landing`  (click "Edit" next to Root Directory and pick the `landing` folder).
4. **Framework Preset** = **Other** → click **Deploy**.
5. You get a URL like `https://finvora.vercel.app` — that's your marketing page.

Now point the landing page's buttons at your real app:

6. On the NEW laptop, open the file `C:\finvora\insightx\landing\index.html` in **Notepad**
   (right-click the file → Open with → Notepad).
7. Press **Ctrl + G**, type **801**, Enter — go to line 801. It reads:

   ```
     var APP_URL = "/app";
   ```

8. Change `/app` to your Render URL from Part 4, so it becomes (use YOUR real URL):

   ```
     var APP_URL = "https://finvora.onrender.com";
   ```

9. Save the file (Ctrl + S). Then upload the change to GitHub — in PowerShell:

   ```powershell
   cd C:\finvora\insightx
   git add landing/index.html
   git commit -m "Point landing buttons at the live app"
   git push
   ```

10. Vercel auto-redeploys in ~1 minute. Now the "Log in / Open account" buttons on your
    landing page open your real app. Done.

---

## Later: your own domain name (optional)

When you buy `finvora.in`:
- In **Vercel** → your landing project → **Settings → Domains** → add `finvora.in`.
- In **Render** → your service → **Settings → Custom Domain** → add `app.finvora.in`.
- Each dashboard shows the exact DNS records to paste at your domain seller. Then re-point
  `APP_URL` (Part 5) to `https://app.finvora.in`.

---

## If something goes wrong

- **`npm` or `node` not recognized** → close PowerShell and open a NEW one after installing Node.
- **Render build failed** → open the build **Logs** in Render; usually it's the wrong Node version.
  Make sure `render.yaml` has `NODE_VERSION` = `24.16.0` (it does by default).
- **Git asks for a password and rejects it** → GitHub no longer takes your account password here;
  use `gh auth login` (Part 3) or a Personal Access Token as the password.
- **Landing buttons still go to /app** → you edited the wrong line or didn't `git push`; redo Part 5
  steps 6–9 and confirm Vercel finished redeploying.

---

## One-page cheat sheet

| Thing | Value |
|---|---|
| Folder that matters | `insightx` |
| GitHub repo name | `finvora` (private) |
| App host | Render → New → Blueprint → pick repo → Apply |
| Landing host | Vercel → import repo → Root Directory = `landing` |
| Landing edit | `landing/index.html` line 801: set `APP_URL` to your Render URL |
| Admin login | `9999999999` / `Admin@123` |
| Demo customer | `9876543210` / `Demo@123` |
| Node version | v24 (v22 minimum) |
