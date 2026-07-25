# Finvora — App download (PWA + APK)

Both the installable **PWA** and a downloadable **Android APK** come from the *same*
built web app — no separate mobile codebase. The APK is a thin native wrapper
(TWA) around the deployed PWA, so it auto-updates whenever you redeploy.

> **Prerequisite:** the app must be live on an **HTTPS domain** first (your plan:
> buy domain + hosting → deploy → then generate the APK). Locally you can already
> test "Add to Home Screen" over `http://localhost` on the same machine.

The manifest, icons, theme and service worker are all already configured:
- `client/public/manifest.webmanifest` — name "Finvora", standalone, 192/512 + maskable icons, theme `#0c0c0e`.
- `client/public/icons/icon-192.png`, `icon-512.png` — Finvora lime-on-charcoal mark (regenerate with `node client/scripts/gen-icons.mjs`).
- Service worker (`sw.js`) — offline shell + auto-update.

---

## 1. PWA (works today, no build tools)
On any phone/desktop, open the deployed URL and install:
- **Android/Chrome:** menu → **Install app / Add to Home Screen**.
- **iOS/Safari:** Share → **Add to Home Screen**.
It launches full-screen with the Finvora icon, like a native app. The in-app
**"Install app"** button (added to the header) also triggers this on supported browsers.

## 2. APK — easiest path: PWABuilder (free, no local tools)
1. Deploy the app (Vercel + Render/Railway) so it's live at `https://yourdomain`.
2. Go to **https://www.pwabuilder.com** → paste your URL → **Start**.
3. It scores the manifest/SW (should pass) → **Package for stores** → **Android**.
4. Choose **"Signed APK"** (for direct download) — it generates the APK **and** a
   `assetlinks.json` + a signing key. Download the zip.
5. Put the provided **`assetlinks.json`** at `https://yourdomain/.well-known/assetlinks.json`
   (this verifies app ownership so the APK opens with no browser address bar).
6. Host the `.apk` on your site (e.g. `/downloads/finvora.apk`) and link the
   **"Download APK"** button to it.

## 3. APK — CLI path: Bubblewrap (Google's TWA tool)
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://yourdomain/manifest.webmanifest
bubblewrap build            # -> app-release-signed.apk
```
Needs JDK 17 + Android SDK (Bubblewrap can install them). Same `assetlinks.json`
step as above. Good if you want it scripted/repeatable.

## 4. Bundled APK (works offline-ish): Capacitor
If you want the web assets **inside** the APK (not just a URL wrapper):
```bash
cd client && npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init Finvora com.finvora.app --web-dir dist
npm run build && npx cap add android && npx cap sync
npx cap open android         # build the APK in Android Studio
```
Set `VITE_API_BASE` to your deployed backend URL before `npm run build` (the
bundled app has no local server). Needs Android Studio.

---

### Which to use
- **Just want it on phones fast:** PWA install (nothing to build).
- **Downloadable .apk on your website:** PWABuilder (step 2) — recommended.
- **Play Store later:** PWABuilder can also output a signed **.aab** for the Play Console.

### Note on stores
Google Play accepts TWA/PWA apps. A financial/broker app on the Play Store needs
a Play Console account ($25 one-time) and must meet Google's financial-services
policy (real company details, licences, privacy policy) — that's a later step,
after the legal/registration pieces are in place.
