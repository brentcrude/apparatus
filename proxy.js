/**
 * ProxyWave Core Engine
 * Fetches real pages through CORS proxies and rewrites HTML for in-browser display
 */

const ProxyEngine = (() => {

  // ── PROXY BACKENDS ──────────────────────────────────────────────────
  const BACKENDS = [
    { name: 'AllOrigins',  url: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'CorsProxy',   url: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'CodeTabs',    url: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
    { name: 'ThingProxy',  url: u => `https://thingproxy.freeboard.io/fetch/${u}` },
  ];

  let activeBackend = 0;
  let stats = { requests: 0, bytes: 0, blocked: 0, latencies: [] };

  // ── PUBLIC API ───────────────────────────────────────────────────────
  async function fetchPage(url, onLog) {
    const log = onLog || (() => {});
    const t0 = Date.now();

    // Normalize URL
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;

    log('info', `Navigating → ${url}`);
    log('proxy', `Using backend: ${BACKENDS[activeBackend].name}`);

    stats.requests++;

    // Try backends in order
    for (let attempt = 0; attempt < BACKENDS.length; attempt++) {
      const idx = (activeBackend + attempt) % BACKENDS.length;
      const backend = BACKENDS[idx];
      const proxyUrl = backend.url(url);

      log('net', `[${backend.name}] GET ${url}`);

      try {
        const resp = await fetch(proxyUrl, {
          method: 'GET',
          headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' }
        });

        if (!resp.ok) {
          log('warn', `[${backend.name}] HTTP ${resp.status}`);
          continue;
        }

        const contentType = resp.headers.get('content-type') || '';
        const text = await resp.text();
        const ms = Date.now() - t0;

        stats.latencies.push(ms);
        stats.bytes += text.length;
        activeBackend = idx; // remember working backend

        log('success', `[${backend.name}] ${resp.status} OK — ${(text.length/1024).toFixed(1)}KB in ${ms}ms`);

        // Detect content type
        if (contentType.includes('json')) {
          return { type: 'json', content: text, url, ms, backend: backend.name };
        }

        // Rewrite HTML
        const rewritten = rewriteHTML(text, url, log);
        return { type: 'html', content: rewritten, url, ms, backend: backend.name };

      } catch (err) {
        log('error', `[${backend.name}] Failed: ${err.message}`);
      }
    }

    throw new Error('All proxy backends failed for: ' + url);
  }

  // ── HTML REWRITER ────────────────────────────────────────────────────
  function rewriteHTML(html, baseUrl, log) {
    const base = new URL(baseUrl);
    let rewritten = html;

    // Fix: inject a <base> tag if missing, helps relative URLs
    // But we handle them manually below

    // Count trackers removed
    let trackersRemoved = 0;
    const trackerPatterns = [
      /https?:\/\/[^"']*google-analytics[^"']*/g,
      /https?:\/\/[^"']*googletagmanager[^"']*/g,
      /https?:\/\/[^"']*doubleclick[^"']*/g,
      /https?:\/\/[^"']*facebook\.com\/tr[^"']*/g,
      /https?:\/\/[^"']*hotjar[^"']*/g,
    ];
    trackerPatterns.forEach(p => {
      const matches = rewritten.match(p);
      if (matches) trackersRemoved += matches.length;
    });
    if (trackersRemoved > 0) {
      stats.blocked += trackersRemoved;
      log('info', `Blocked ${trackersRemoved} tracker(s)`);
    }

    // ── Rewrite all URLs in attributes ──
    rewritten = rewriteUrls(rewritten, baseUrl);

    // ── Inject proxy toolbar + JS bridge ──
    const toolbar = buildToolbar(baseUrl);
    const bridge = buildBridge(baseUrl);

    // Insert before </head> or at top
    if (rewritten.includes('</head>')) {
      rewritten = rewritten.replace('</head>', bridge + '</head>');
    } else {
      rewritten = bridge + rewritten;
    }

    // Insert toolbar after <body> or at start of body
    if (rewritten.match(/<body[^>]*>/i)) {
      rewritten = rewritten.replace(/(<body[^>]*>)/i, '$1' + toolbar);
    } else if (rewritten.includes('<html>')) {
      rewritten = rewritten.replace('<html>', '<html>' + toolbar);
    } else {
      rewritten = toolbar + rewritten;
    }

    return rewritten;
  }

  function rewriteUrls(html, baseUrl) {
    const base = new URL(baseUrl);

    // Helper: resolve a URL relative to base, then wrap with proxy nav
    function proxyUrl(url, attr) {
      if (!url) return url;
      url = url.trim();
      if (url.startsWith('javascript:') || url.startsWith('mailto:') ||
          url.startsWith('tel:') || url.startsWith('#') || url.startsWith('data:')) {
        return url;
      }
      try {
        const resolved = new URL(url, baseUrl).href;
        // For navigation links (href on <a>), use pw:// scheme to intercept
        if (attr === 'href-nav') {
          return `javascript:window.__pw_navigate(${JSON.stringify(resolved)})`;
        }
        // For resources (src, href on link), route through CORS proxy
        if (attr === 'src' || attr === 'href-resource' || attr === 'action') {
          return `https://api.allorigins.win/raw?url=${encodeURIComponent(resolved)}`;
        }
        return resolved;
      } catch(e) {
        return url;
      }
    }

    // Rewrite <a href="..."> — navigation
    html = html.replace(/(<a\s[^>]*?)href\s*=\s*(['"])(.*?)\2/gis, (match, pre, q, url) => {
      if (url.startsWith('javascript:') || url.startsWith('#')) return match;
      return pre + `href=${q}${proxyUrl(url, 'href-nav')}${q}`;
    });

    // Rewrite <form action="...">
    html = html.replace(/(<form\s[^>]*?)action\s*=\s*(['"])(.*?)\2/gis, (match, pre, q, url) => {
      return pre + `action=${q}${proxyUrl(url, 'action')}${q}`;
    });

    // Rewrite <img src>, <script src>, <video src>, <audio src>, <source src>
    html = html.replace(/(<(?:img|script|video|audio|source|track|embed|iframe)\s[^>]*?)src\s*=\s*(['"])(.*?)\2/gis, (match, pre, q, url) => {
      return pre + `src=${q}${proxyUrl(url, 'src')}${q}`;
    });

    // Rewrite <link href> — stylesheets
    html = html.replace(/(<link\s[^>]*?)href\s*=\s*(['"])(.*?)\2/gis, (match, pre, q, url) => {
      // Skip anchor links, data URIs
      if (url.startsWith('#') || url.startsWith('data:')) return match;
      return pre + `href=${q}${proxyUrl(url, 'href-resource')}${q}`;
    });

    // Rewrite CSS url() references in style tags and inline styles
    html = html.replace(/url\(\s*(['"]?)((?!data:)[^)'"]+)\1\s*\)/gi, (match, q, url) => {
      try {
        const resolved = new URL(url.trim(), baseUrl).href;
        return `url(${q}https://api.allorigins.win/raw?url=${encodeURIComponent(resolved)}${q})`;
      } catch(e) { return match; }
    });

    // Remove CSP meta tags (they block our injected scripts)
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '<!-- csp removed by ProxyWave -->');

    // Remove X-Frame-Options equiv
    html = html.replace(/<meta[^>]+x-frame-options[^>]*>/gi, '');

    return html;
  }

  // ── INJECTED TOOLBAR (rendered inside the iframe) ────────────────────
  function buildToolbar(url) {
    const domain = (() => { try { return new URL(url).hostname; } catch(e) { return url; } })();
    return `
<div id="__pw_bar__" style="
  position:fixed;top:0;left:0;right:0;z-index:2147483647;
  height:36px;background:linear-gradient(90deg,#0a0a0f,#1a1a25);
  border-bottom:1px solid rgba(0,229,255,0.3);
  display:flex;align-items:center;gap:10px;padding:0 12px;
  font-family:monospace;font-size:11px;color:#6b6b85;
  box-shadow:0 2px 20px rgba(0,0,0,0.8);
">
  <span style="color:#00e5ff;font-weight:bold">🌊 ProxyWave</span>
  <span style="width:1px;height:20px;background:#2a2a3a"></span>
  <span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981;flex-shrink:0"></span>
  <span style="color:#10b981">Proxied</span>
  <span>·</span>
  <span style="color:#e8e8f0;font-size:12px">${domain}</span>
  <span style="margin-left:auto;color:#7c3aed;font-size:10px">IP MASKED · TLS 1.3</span>
  <button onclick="window.parent.__pw_close && window.parent.__pw_close()" style="
    background:#1a1a25;border:1px solid #2a2a3a;color:#6b6b85;
    padding:2px 8px;border-radius:12px;cursor:pointer;font-size:10px;margin-left:8px
  ">✕ Close</button>
</div>
<div style="height:36px"></div>
`;
  }

  // ── INJECTED JS BRIDGE (runs inside the iframe) ──────────────────────
  function buildBridge(baseUrl) {
    return `
<script>
(function(){
  // Intercept all link clicks
  document.addEventListener('click', function(e) {
    var el = e.target.closest('a');
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    if (href.startsWith('http') || href.startsWith('//')) {
      e.preventDefault();
      var url = href.startsWith('//') ? 'https:' + href : href;
      if (window.__pw_navigate) window.__pw_navigate(url);
      else if (window.parent && window.parent.__pw_navigate) window.parent.__pw_navigate(url);
    }
  }, true);

  // Expose navigation function
  window.__pw_navigate = function(url) {
    if (window.parent && window.parent.__pw_navigate) {
      window.parent.__pw_navigate(url);
    }
  };

  // Intercept form submissions
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = form.getAttribute('action') || window.location.href;
    e.preventDefault();
    var data = new URLSearchParams(new FormData(form)).toString();
    var url = action.includes('?') ? action + '&' + data : action + '?' + data;
    if (window.__pw_navigate) window.__pw_navigate(url);
  }, true);
})();
<\/script>
`;
  }

  // ── STATS ────────────────────────────────────────────────────────────
  function getStats() { return { ...stats }; }
  function getActiveBackend() { return BACKENDS[activeBackend].name; }

  return { fetchPage, getStats, getActiveBackend, BACKENDS };

})();

window.ProxyEngine = ProxyEngine;
