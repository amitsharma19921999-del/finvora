# Finvora landing site — deploy

The landing site is a **self-contained static page** (`landing/index.html` + `robots.txt`,
`sitemap.xml`, `icons/`, `manifest.webmanifest`). It's separate from the React trading
app so it loads instantly and ranks well (static HTML, full SEO tags, JSON-LD).

## Recommended architecture (two hosts, one brand)
| Part | Folder | Domain | Host |
|---|---|---|---|
| **Landing site** | `landing/` | `finvora.in` (root) | **Vercel** (static) |
| **Trading app** (PWA) | `client/` | `app.finvora.in` | **Vercel** (SPA) |
| **API** | `server/` | `api.finvora.in` | **Render / Railway** |

The landing's "Log in / Open account / Open web app" buttons point to **`/app`** — change
that to `https://app.finvora.in` (edit the `APP_URL` const / the hrefs in `landing/index.html`)
once the app is on its own subdomain. Then the app's `VITE_API_BASE` points at `api.finvora.in`.

## Deploy the landing (Vercel)
1. Vercel → **Add New → Project** → import the repo → **Root Directory = `landing`**.
2. Framework preset **Other** (it's static). Deploy. Point `finvora.in` at it.
3. `robots.txt` + `sitemap.xml` are served automatically; submit the sitemap in Google Search Console.

## Wire the APK download
1. Generate the signed APK with **PWABuilder** (see [APK_PWA_GUIDE.md](APK_PWA_GUIDE.md)) against the deployed **app** URL.
2. Put the file at `landing/downloads/finvora.apk` (the "Download APK" button already links there).
3. Also drop PWABuilder's `assetlinks.json` at `landing/.well-known/assetlinks.json` (verifies the TWA).

## iOS vs Android on the landing (already built in)
- **Android / desktop:** shows "Download APK" + one-tap "Install web app" (PWA prompt).
- **iPhone / iPad:** APK button is hidden (iOS can't install APKs); shows an **"Add to Home Screen" guide** (Safari → Share → Add to Home Screen) because that's the only way to install a PWA on iOS. The web app then works fully, including live prices.
- A "Having trouble installing?" note covers Android "install from unknown source" and iOS Safari-only steps.

## Before going live — LEGAL
The footer's regulatory block uses **placeholders** (`[Your SEBI registration]`, `[Registered office]`, etc.).
Fill them with **Finvora's own** registered details once the entity is registered. Do **not** use any
other broker's licence numbers. The generic market-risk disclaimer is standard and already included.

## SEO checklist (already done in the page)
- Unique `<title>` + meta description, canonical, theme-color.
- Open Graph + Twitter card, JSON-LD (Organization + WebSite + SoftwareApplication).
- Semantic HTML5, one `<h1>`, alt text, `robots.txt`, `sitemap.xml`.
- No render-blocking external requests (inline CSS/JS, system fonts) → fast LCP.
- After deploy: run Lighthouse, submit sitemap to Google Search Console + Bing Webmaster.
