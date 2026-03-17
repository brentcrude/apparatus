# 🌊 ProxyWave Browser

A fully working proxy browser that runs entirely in the browser — deployable as a static site on GitHub Pages with zero backend.

## 🚀 Deploy to GitHub Pages

1. **Create a new GitHub repo** (e.g. `proxywave`)
2. **Upload these 3 files** to the root:
   - `index.html`
   - `proxy.js`
   - `sw.js`
3. Go to **Settings → Pages → Deploy from branch → `main` / `(root)`**
4. Visit `https://yourusername.github.io/proxywave`

## ✅ How it actually works

### CORS Proxy Backends
The browser fetches real pages by routing them through free CORS proxy APIs:
- **AllOrigins** (`api.allorigins.win`) — primary
- **CorsProxy.io** (`corsproxy.io`) — fallback
- **CodeTabs** (`api.codetabs.com`) — fallback
- **ThingProxy** — fallback

These fetch the target page server-side and return it with CORS headers, bypassing browser security restrictions.

### HTML Rewriting
After fetching a page, `proxy.js` rewrites all URLs in the HTML:
- `<a href>` links → intercepted with `__pw_navigate()` calls
- `<img src>`, `<script src>`, `<link href>` → routed through proxy
- CSS `url()` references → proxied
- CSP meta tags → stripped
- Tracker URLs → blocked

### Blob URL Display
The rewritten HTML is turned into a `Blob URL` and loaded into an `<iframe>`, giving a full page render without needing a server.

### Service Worker
`sw.js` registers a service worker that can intercept and proxy additional fetch requests originating from within the iframe.

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + L` | Focus address bar |
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close tab |
| `Ctrl/Cmd + Shift + I` | Toggle DevTools |
| `F5` | Reload |
| `Alt + ←/→` | Back / Forward |

## ⚠️ Limitations

- **JavaScript-heavy SPAs** (React/Vue apps) may not work fully — their JS makes many fetch() calls that our rewriter can't intercept
- **Authentication / cookies** won't persist between pages
- **HTTPS mixed-content** some assets may be blocked
- **Rate limits** — the free CORS proxy APIs have usage limits; for production, self-host a proxy backend (Node.js `http-proxy-middleware` works great)

## 🛠 Self-hosting the proxy backend

For best results, deploy a simple Node.js proxy:

```js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
app.use('/proxy', (req, res) => {
  const target = req.query.url;
  // fetch target, strip X-Frame-Options, return with CORS headers
});
```

Then change `BACKENDS[0]` in `proxy.js` to point to your server.

## 📁 Files

| File | Purpose |
|---|---|
| `index.html` | Browser shell UI — tabs, address bar, devtools |
| `proxy.js` | Core proxy engine — fetching, HTML rewriting, URL routing |
| `sw.js` | Service worker — request interception |
| `README.md` | This file |
