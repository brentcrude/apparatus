/**
 * ProxyWave Core Engine v3
 * - Links rewritten with data-pw-href (not javascript: hrefs)
 * - postMessage bridge between iframe and parent handles navigation
 * - Resource URLs routed through CORS backends
 */

const ProxyEngine = (() => {

  const BACKENDS = [
    { name: 'AllOrigins', fn: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'CorsProxy',  fn: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'CodeTabs',   fn: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  ];

  let activeBackend = 0;
  const stats = { requests: 0, bytes: 0, blocked: 0, latencies: [] };

  // ── FETCH ───────────────────────────────────────────────────────────
  async function fetchPage(url, onLog) {
    const log = onLog || (() => {});
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;
    log('proxy', `Routing: ${url}`);
    stats.requests++;

    for (let i = 0; i < BACKENDS.length; i++) {
      const idx = (activeBackend + i) % BACKENDS.length;
      const b = BACKENDS[idx];
      log('net', `[${b.name}] GET ${url}`);
      try {
        const t0 = Date.now();
        const resp = await fetch(b.fn(url), { headers: { Accept: 'text/html,*/*' } });
        if (!resp.ok) { log('warn', `[${b.name}] HTTP ${resp.status}`); continue; }
        const text = await resp.text();
        const ms = Date.now() - t0;
        activeBackend = idx;
        stats.latencies.push(ms);
        stats.bytes += text.length;
        log('success', `[${b.name}] OK — ${(text.length / 1024).toFixed(1)}KB in ${ms}ms`);
        return { content: rewriteHTML(text, url, log), url, ms, backend: b.name };
      } catch (e) {
        log('error', `[${b.name}] ${e.message}`);
      }
    }
    throw new Error('All backends failed for: ' + url);
  }

  // ── REWRITER ────────────────────────────────────────────────────────
  function rewriteHTML(html, baseUrl, log) {
    // Strip CSP meta tags first (they'd block our injected script)
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*\/?>/gi, '');

    // Block trackers
    let blocked = 0;
    const trackers = [
      /(<script\b[^>]*?src\s*=\s*['"][^'"]*(?:google-analytics|googletagmanager|doubleclick|hotjar|clarity)[^'"]*['"][^>]*>)([\s\S]*?<\/script>)?/gi,
    ];
    trackers.forEach(p => {
      const m = html.match(p); if (m) blocked += m.length;
      html = html.replace(p, '<!-- tracker removed -->');
    });
    if (blocked) { stats.blocked += blocked; log('info', `Blocked ${blocked} tracker(s)`); }

    html = rewriteResources(html, baseUrl);
    html = rewriteAnchors(html, baseUrl);

    const bridge = makeBridge(baseUrl);
    const toolbar = makeToolbar(baseUrl);

    // Inject bridge into <head>
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, bridge + '</head>');
    } else {
      html = bridge + html;
    }

    // Inject toolbar at start of <body>
    const bm = html.match(/<body[^>]*>/i);
    if (bm) {
      html = html.replace(bm[0], bm[0] + toolbar);
    } else {
      html = toolbar + html;
    }

    return html;
  }

  function abs(url, base) {
    if (!url) return null;
    url = url.trim();
    if (!url || url.startsWith('data:') || url.startsWith('blob:') ||
        url.startsWith('javascript:') || url.startsWith('mailto:') ||
        url.startsWith('tel:') || url === '#') return null;
    try { return new URL(url, base).href; } catch (e) { return null; }
  }

  function proxyRes(url, base) {
    const a = abs(url, base);
    return a ? `https://api.allorigins.win/raw?url=${encodeURIComponent(a)}` : url;
  }

  function rewriteResources(html, baseUrl) {
    // src attributes on media/script/embed elements
    html = html.replace(
      /(<(?:img|script|video|audio|source|track|embed)\b[^>]*?\s)src(\s*=\s*)(['"])(.*?)\3/gis,
      (m, pre, eq, q, url) => {
        const r = proxyRes(url, baseUrl);
        return r === url ? m : `${pre}src${eq}${q}${r}${q}`;
      }
    );
    // <link href> — stylesheets, icons
    html = html.replace(
      /(<link\b[^>]*?\s)href(\s*=\s*)(['"])(.*?)\3/gis,
      (m, pre, eq, q, url) => {
        if (url.startsWith('#') || url.startsWith('data:')) return m;
        const r = proxyRes(url, baseUrl);
        return r === url ? m : `${pre}href${eq}${q}${r}${q}`;
      }
    );
    // CSS url() in <style> and inline style=""
    html = html.replace(/url\(\s*(['"]?)((?!data:|blob:)[^)'"]{4,})\1\s*\)/gi, (m, q, url) => {
      const a2 = abs(url, baseUrl);
      if (!a2) return m;
      return `url(${q}https://api.allorigins.win/raw?url=${encodeURIComponent(a2)}${q})`;
    });
    return html;
  }

  function rewriteAnchors(html, baseUrl) {
    // Replace href with data-pw-href so the bridge can intercept cleanly
    // Keep href="#" so the link is still clickable (cursor: pointer, etc.)
    return html.replace(
      /(<a\b[^>]*?)\shref(\s*=\s*)(['"])(.*?)\3/gis,
      (m, pre, eq, q, url) => {
        // Keep special schemes untouched
        if (/^(javascript:|mailto:|tel:|#)/.test(url.trim())) return m;
        const resolved = abs(url, baseUrl);
        if (!resolved) return m;
        // Escape for attribute
        const safe = resolved.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `${pre} data-pw-href="${safe}" href="#"`;
      }
    );
  }

  // ── BRIDGE SCRIPT ───────────────────────────────────────────────────
  function makeBridge(baseUrl) {
    return `<script id="__pw_bridge__">
(function(){
  var BASE = ${JSON.stringify(baseUrl)};
  function nav(url) {
    try { window.parent.postMessage({type:'__pw_nav__', url: url}, '*'); } catch(e){}
  }
  function resolve(url) {
    if (!url || url === '#') return null;
    url = url.trim();
    if (/^(javascript:|mailto:|tel:)/.test(url)) return null;
    try { return new URL(url, BASE).href; } catch(e) { return null; }
  }
  // Click delegation — catches data-pw-href and any remaining hrefs
  document.addEventListener('click', function(e) {
    var el = e.target;
    // Walk up the DOM to find an anchor
    for (var i = 0; i < 6 && el; i++) {
      if (el.tagName === 'A') break;
      el = el.parentElement;
    }
    if (!el || el.tagName !== 'A') return;
    var target = el.getAttribute('data-pw-href') || el.getAttribute('href');
    if (!target || target === '#') return;
    var url = resolve(target);
    if (!url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    nav(url);
  }, true);
  // Form interception
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = form.getAttribute('action') || BASE;
    var resolved = resolve(action) || BASE;
    var params = new URLSearchParams(new FormData(form)).toString();
    var url = params ? (resolved.includes('?') ? resolved + '&' + params : resolved + '?' + params) : resolved;
    e.preventDefault();
    nav(url);
  }, true);
  window.__pw_navigate = nav;
})();
<\/script>`;
  }

  // ── TOOLBAR HTML ────────────────────────────────────────────────────
  function makeToolbar(url) {
    let host = url;
    try { host = new URL(url).hostname; } catch (e) {}
    return `<div id="__pw_bar__" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;height:30px;background:linear-gradient(90deg,#0a0a0f 0%,#111118 100%);border-bottom:1px solid rgba(0,229,255,0.2);display:flex;align-items:center;gap:8px;padding:0 12px;font-family:monospace;font-size:11px;color:#6b6b85;box-shadow:0 2px 12px rgba(0,0,0,0.8)">
  <span style="color:#00e5ff;font-weight:bold">🌊</span>
  <span style="color:#e8e8f0;font-size:12px">${host}</span>
  <span style="color:#6b6b85">·</span>
  <span style="display:flex;align-items:center;gap:4px"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block"></span><span style="color:#10b981">proxied</span></span>
  <span style="margin-left:auto;font-size:9px;color:#7c3aed;letter-spacing:.06em">IP MASKED · TLS 1.3</span>
</div><div style="height:30px"></div>`;
  }

  function getStats() { return { ...stats }; }
  function getActiveBackend() { return BACKENDS[activeBackend].name; }

  return { fetchPage, getStats, getActiveBackend, BACKENDS };
})();

window.ProxyEngine = ProxyEngine;
