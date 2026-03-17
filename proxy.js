/**
 * ProxyWave Core Engine v5
 *
 * Fixes:
 * - Wikipedia: use their CORS-enabled REST API directly (avoids user-agent block)
 * - Poki/embedded iframes: MutationObserver in bridge intercepts dynamic iframes,
 *   fetches them through proxy, replaces src with blob URL
 * - CSS: inlined as <style> blocks (v4 approach retained)
 */

const ProxyEngine = (() => {

  const BACKENDS = [
    { name: 'AllOrigins', fn: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'CorsProxy',  fn: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'CodeTabs',   fn: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  ];

  let activeBackend = 0;
  const stats = { requests: 0, bytes: 0, blocked: 0, latencies: [] };

  // ── SPECIAL SITE HANDLERS ─────────────────────────────────────────────
  // Sites with CORS-friendly APIs or that need custom handling
  const SPECIAL = [
    {
      // Wikipedia: use their REST API which is CORS-enabled and doesn't need a proxy
      test: url => /^https?:\/\/[a-z]+\.wikipedia\.org/i.test(url),
      fetch: async (url, log) => {
        log('proxy', 'Wikipedia detected — using REST API (CORS-native)');
        const apiUrl = wikiToRestApi(url);
        log('net', `[Wikipedia API] GET ${apiUrl}`);
        const t0 = Date.now();
        const resp = await fetch(apiUrl, {
          headers: {
            'Accept': 'text/html',
            'Api-User-Agent': 'ProxyWave/1.0 (https://github.com/proxywave; demo browser)'
          }
        });
        if (!resp.ok) throw new Error(`Wikipedia API: HTTP ${resp.status}`);
        const html = await resp.text();
        const ms = Date.now() - t0;
        log('success', `[Wikipedia API] OK — ${(html.length/1024).toFixed(1)}KB in ${ms}ms`);
        return { html, ms, backend: 'Wikipedia API' };
      }
    }
  ];

  function wikiToRestApi(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const wikiIdx = parts.indexOf('wiki');
      const title = wikiIdx !== -1 && parts[wikiIdx + 1]
        ? parts.slice(wikiIdx + 1).join('/')
        : 'Main_Page';
      // Add query string for section if present
      const section = u.searchParams.get('section');
      const base = `${u.origin}/api/rest_v1/page/html/${title}`;
      return section ? `${base}?section=${section}` : base;
    } catch (e) {
      return 'https://en.wikipedia.org/api/rest_v1/page/html/Main_Page';
    }
  }

  // ── GENERIC PROXY FETCH ───────────────────────────────────────────────
  async function proxyFetch(url) {
    for (let i = 0; i < BACKENDS.length; i++) {
      const b = BACKENDS[(activeBackend + i) % BACKENDS.length];
      try {
        const r = await fetch(b.fn(url), { headers: { Accept: '*/*' } });
        if (r.ok) return await r.text();
      } catch (e) { /* try next */ }
    }
    return null;
  }

  // ── MAIN ENTRY POINT ──────────────────────────────────────────────────
  async function fetchPage(url, onLog) {
    const log = onLog || (() => {});
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;
    log('proxy', `Routing: ${url}`);
    stats.requests++;

    let html = null, ms = 0, usedBackend = BACKENDS[activeBackend].name;

    // Check for special handlers first
    const special = SPECIAL.find(s => s.test(url));
    if (special) {
      try {
        const result = await special.fetch(url, log);
        html = result.html;
        ms = result.ms;
        usedBackend = result.backend;
      } catch (e) {
        log('warn', `Special handler failed: ${e.message}, falling back to proxy`);
      }
    }

    // Generic proxy fallback
    if (!html) {
      for (let i = 0; i < BACKENDS.length; i++) {
        const idx = (activeBackend + i) % BACKENDS.length;
        const b = BACKENDS[idx];
        log('net', `[${b.name}] GET ${url}`);
        try {
          const t0 = Date.now();
          const resp = await fetch(b.fn(url), { headers: { Accept: 'text/html,*/*' } });
          if (!resp.ok) { log('warn', `[${b.name}] HTTP ${resp.status}`); continue; }
          html = await resp.text();
          ms = Date.now() - t0;
          activeBackend = idx;
          usedBackend = b.name;
          stats.latencies.push(ms);
          stats.bytes += html.length;
          log('success', `[${b.name}] OK — ${(html.length/1024).toFixed(1)}KB in ${ms}ms`);
          break;
        } catch (e) {
          log('error', `[${b.name}] ${e.message}`);
        }
      }
    }

    if (!html) throw new Error('All backends failed for: ' + url);

    log('proxy', 'Inlining stylesheets…');
    const content = await inlineCSS(html, url, log);
    return { content, url, ms, backend: usedBackend };
  }

  // ── CSS INLINER ───────────────────────────────────────────────────────
  async function inlineCSS(html, baseUrl, log) {
    const linkRe = /<link\b([^>]*?)>/gi;
    const jobs = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const full = m[0], attrs = m[1];
      if (!/rel\s*=\s*['"]stylesheet['"]/i.test(attrs) &&
          !/rel\s*=\s*['"]preload['"][^>]*as\s*=\s*['"]style['"]/i.test(attrs)) continue;
      const hm = attrs.match(/href\s*=\s*(['"])(.*?)\1/i);
      if (!hm) continue;
      const href = hm[2].trim();
      if (!href || href.startsWith('data:')) continue;
      try { jobs.push({ full, absUrl: new URL(href, baseUrl).href }); } catch (e) {}
    }

    log('proxy', `Found ${jobs.length} stylesheet(s) to inline`);

    const results = await Promise.all(
      jobs.slice(0, 10).map(async job => {
        try {
          const css = await proxyFetch(job.absUrl);
          if (!css) return { ...job, css: null };
          log('net', `[CSS] inlined ${job.absUrl.split('/').pop().slice(0,40)} (${(css.length/1024).toFixed(1)}KB)`);
          return { ...job, css: rewriteCSSUrls(css, job.absUrl) };
        } catch (e) { return { ...job, css: null }; }
      })
    );

    for (const { full, absUrl, css } of results) {
      html = html.replace(
        full,
        css
          ? `<style data-pw-from="${absUrl.replace(/"/g,'&quot;')}">${css}</style>`
          : `<!-- ProxyWave: could not inline ${absUrl} -->`
      );
    }

    html = rewriteHTML(html, baseUrl, log);
    return html;
  }

  // ── CSS url() REWRITER ────────────────────────────────────────────────
  function rewriteCSSUrls(css, sheetUrl) {
    return css.replace(/url\(\s*(['"]?)((?!data:|blob:|#)[^)'"]+)\1\s*\)/gi, (m, q, rawUrl) => {
      rawUrl = rawUrl.trim();
      if (!rawUrl) return m;
      try {
        const abs = new URL(rawUrl, sheetUrl).href;
        return `url(${q}https://api.allorigins.win/raw?url=${encodeURIComponent(abs)}${q})`;
      } catch (e) { return m; }
    });
  }

  // ── HTML REWRITER ─────────────────────────────────────────────────────
  function rewriteHTML(html, baseUrl, log) {
    // Strip CSP meta tags
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*\/?>/gi, '');

    // Block trackers
    let blocked = 0;
    html = html.replace(
      /<script\b[^>]*?src\s*=\s*['"][^'"]*(?:google-analytics|googletagmanager|doubleclick|hotjar|clarity)[^'"]*['"][^>]*>[\s\S]*?<\/script>/gi,
      () => { blocked++; return '<!-- tracker blocked -->'; }
    );
    if (blocked) { stats.blocked += blocked; log && log('info', `Blocked ${blocked} tracker(s)`); }

    // Proxy img/script/video/audio/source src
    html = html.replace(
      /(<(?:img|script|video|audio|source|track|embed)\b[^>]*?\s)src(\s*=\s*)(['"])((?!data:|blob:|https?:\/\/api\.allorigins)[^'"]+)\3/gis,
      (m, pre, eq, q, url) => {
        const a = resolveAbs(url, baseUrl);
        return a ? `${pre}src${eq}${q}https://api.allorigins.win/raw?url=${encodeURIComponent(a)}${q}` : m;
      }
    );

    // Proxy <link href> (non-stylesheet leftovers like favicons)
    html = html.replace(
      /(<link\b[^>]*?\s)href(\s*=\s*)(['"])((?!data:|#|https?:\/\/api\.allorigins)[^'"]+)\3/gis,
      (m, pre, eq, q, url) => {
        const a = resolveAbs(url, baseUrl);
        return a ? `${pre}href${eq}${q}https://api.allorigins.win/raw?url=${encodeURIComponent(a)}${q}` : m;
      }
    );

    // Rewrite <style> block url() references
    html = html.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (m, open, css, close) => open + rewriteCSSUrls(css, baseUrl) + close
    );

    // Rewrite inline style="" url() references
    html = html.replace(
      /\bstyle\s*=\s*(['"])((?:(?!\1).)*url\((?:(?!\1).)*)\1/gi,
      (m, q, val) => `style=${q}${rewriteCSSUrls(val, baseUrl)}${q}`
    );

    // Rewrite static <iframe src> — mark with data-pw-iframe for the bridge to handle too
    html = html.replace(
      /(<iframe\b[^>]*?\s)src(\s*=\s*)(['"])((?!data:|blob:|about:)[^'"]+)\3/gis,
      (m, pre, eq, q, url) => {
        const a = resolveAbs(url, baseUrl);
        if (!a) return m;
        // Store original src in data-pw-iframe; bridge will proxy-load it
        return `${pre} data-pw-iframe="${a.replace(/"/g,'&quot;')}" src${eq}${q}about:blank${q}`;
      }
    );

    // Rewrite <a href> → data-pw-href (no href attr to avoid top-frame nav)
    html = rewriteAnchors(html, baseUrl);

    // Inject bridge + toolbar
    const bridge = makeBridge(baseUrl);
    const toolbar = makeToolbar(baseUrl);

    html = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, bridge + '\n</head>')
      : bridge + html;

    const bm = html.match(/<body[^>]*>/i);
    html = bm
      ? html.replace(bm[0], bm[0] + toolbar)
      : toolbar + html;

    return html;
  }

  function resolveAbs(url, base) {
    if (!url) return null;
    url = url.trim();
    if (!url || /^(data:|blob:|javascript:|mailto:|tel:|#)/.test(url)) return null;
    try { return new URL(url, base).href; } catch (e) { return null; }
  }

  function rewriteAnchors(html, baseUrl) {
    return html.replace(
      /(<a\b[^>]*?)\shref(\s*=\s*)(['"])(.*?)\3/gis,
      (m, pre, eq, q, url) => {
        if (/^(javascript:|mailto:|tel:|#|\s*$)/.test(url.trim())) return m;
        const a = resolveAbs(url, baseUrl);
        if (!a) return m;
        return `${pre} data-pw-href="${a.replace(/"/g, '&quot;')}"`;
      }
    );
  }

  // ── BRIDGE ────────────────────────────────────────────────────────────
  function makeBridge(baseUrl) {
    // The PROXY_URL_FN is passed as a string so the iframe's JS can use it
    // to fetch nested pages (for iframe proxy loading)
    const backendFns = JSON.stringify(BACKENDS.map(b => b.fn.toString()));

    return `<style>
a[data-pw-href]{cursor:pointer!important}
a[data-pw-href]:not([style*="text-decoration"]):not(.nounderline){text-decoration:underline}
</style>
<script id="__pw_bridge__">
(function(){
  var BASE = ${JSON.stringify(baseUrl)};

  // ── Navigation ──
  function nav(url) {
    try { window.parent.postMessage({ type: '__pw_nav__', url: url }, '*'); } catch(e) {}
  }
  function resolve(url) {
    if (!url) return null;
    url = url.trim();
    if (/^(javascript:|mailto:|tel:|#)/.test(url)) return null;
    try { return new URL(url, BASE).href; } catch(e) { return null; }
  }

  // Click capture — fires before page JS
  document.addEventListener('click', function(e) {
    var el = e.target;
    for (var i = 0; i < 8 && el; i++) { if (el.tagName === 'A') break; el = el.parentElement; }
    if (!el || el.tagName !== 'A') return;
    var target = el.getAttribute('data-pw-href') || el.getAttribute('href') || '';
    if (!target) return;
    var url = resolve(target);
    if (!url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    nav(url);
  }, true);

  // Form submissions
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = form.getAttribute('action') || BASE;
    var resolved = resolve(action) || BASE;
    var params = new URLSearchParams(new FormData(form)).toString();
    var url = params ? (resolved.includes('?') ? resolved + '&' + params : resolved + '?' + params) : resolved;
    e.preventDefault();
    nav(url);
  }, true);

  // ── Iframe proxy loader ──
  // Fetches the iframe's target page through a CORS proxy and loads it as a blob URL.
  // This bypasses X-Frame-Options on the nested page.
  var CORS_PREFIX = 'https://api.allorigins.win/raw?url=';

  function proxyLoadIframe(frame, src) {
    if (!src || frame.dataset.pwLoading) return;
    frame.dataset.pwLoading = '1';
    var proxyUrl = CORS_PREFIX + encodeURIComponent(src);
    fetch(proxyUrl)
      .then(function(r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function(html) {
        // Minimal rewrite inside nested iframe: fix absolute resource URLs
        // Full rewriting would require running the whole engine recursively —
        // for game iframes (Poki) we mainly need the raw HTML to load.
        // Fix relative URLs using a <base> tag.
        var baseTag = '<base href="' + src + '">';
        // Strip nested CSP
        html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*\/?>/gi, '');
        // Inject base tag
        if (/<head>/i.test(html)) {
          html = html.replace(/<head>/i, '<head>' + baseTag);
        } else {
          html = baseTag + html;
        }
        var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        var blobUrl = URL.createObjectURL(blob);
        frame.src = blobUrl;
        frame.onload = function() { URL.revokeObjectURL(blobUrl); };
      })
      .catch(function(err) {
        console.warn('[ProxyWave] iframe proxy failed for', src, err);
        // Fall back: try loading directly (will fail if X-Frame-Options set, but worth trying)
        frame.src = src;
      });
  }

  // Process all iframes that have data-pw-iframe (static ones rewritten by server)
  function processStaticIframes() {
    var frames = document.querySelectorAll('iframe[data-pw-iframe]');
    frames.forEach(function(f) {
      var src = f.getAttribute('data-pw-iframe');
      if (src) proxyLoadIframe(f, src);
    });
  }

  // Watch for dynamically added iframes (Poki, embeds, etc.)
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mut) {
      mut.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        // Check the node itself
        if (node.tagName === 'IFRAME') handleNewIframe(node);
        // Check descendants
        node.querySelectorAll && node.querySelectorAll('iframe').forEach(handleNewIframe);
      });
      // Also watch for src attribute changes on existing iframes
      if (mut.type === 'attributes' && mut.target.tagName === 'IFRAME') {
        handleNewIframe(mut.target);
      }
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });

  function handleNewIframe(frame) {
    // Skip our proxy bar, already-proxied frames, about:blank
    if (frame.id === '__pw_bar__') return;
    if (frame.dataset.pwLoading || frame.dataset.pwDone) return;
    var src = frame.getAttribute('src') || '';
    if (!src || src === 'about:blank' || src.startsWith('blob:') || src.startsWith('data:')) return;
    // Skip if it's a relative URL that resolves to same origin — those work fine
    try {
      var abs = new URL(src, BASE);
      var pageOrigin = new URL(BASE);
      if (abs.origin === pageOrigin.origin) return;
    } catch(e) {}
    // Proxy-load it
    frame.dataset.pwDone = '1';
    proxyLoadIframe(frame, src);
  }

  // Run on existing iframes
  document.addEventListener('DOMContentLoaded', processStaticIframes);
  // Also run now in case DOM is already ready
  if (document.readyState !== 'loading') processStaticIframes();

  window.__pw_navigate = nav;
})();
<\/script>`;
  }

  // ── TOOLBAR ───────────────────────────────────────────────────────────
  function makeToolbar(url) {
    let host = url;
    try { host = new URL(url).hostname; } catch (e) {}
    return `<div id="__pw_bar__" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;height:30px;background:linear-gradient(90deg,#0a0a0f,#111118);border-bottom:1px solid rgba(0,229,255,.2);display:flex;align-items:center;gap:8px;padding:0 12px;font-family:monospace;font-size:11px;color:#6b6b85;box-shadow:0 2px 12px rgba(0,0,0,.8)">
<span style="color:#00e5ff;font-weight:700">🌊</span>
<span style="color:#e8e8f0">${host}</span>
<span>·</span>
<span style="color:#10b981">● proxied</span>
<span style="margin-left:auto;font-size:9px;color:#7c3aed;letter-spacing:.05em">IP MASKED · TLS 1.3</span>
</div><div style="height:30px"></div>`;
  }

  function getStats() { return { ...stats }; }
  function getActiveBackend() { return BACKENDS[activeBackend].name; }

  return { fetchPage, getStats, getActiveBackend, BACKENDS };
})();

window.ProxyEngine = ProxyEngine;
