/**
 * ProxyWave Core Engine v4
 *
 * Key fix: CSS is fetched server-side through the CORS proxy, url() references
 * inside it are rewritten, then the whole sheet is inlined as <style> in the HTML.
 * This bypasses the browser refusing to apply stylesheets served as text/plain.
 */

const ProxyEngine = (() => {

  const BACKENDS = [
    { name: 'AllOrigins', fn: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'CorsProxy',  fn: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'CodeTabs',   fn: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  ];

  let activeBackend = 0;
  const stats = { requests: 0, bytes: 0, blocked: 0, latencies: [] };

  // ── FETCH RAW TEXT THROUGH PROXY ─────────────────────────────────────
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

  // ── MAIN ENTRY POINT ─────────────────────────────────────────────────
  async function fetchPage(url, onLog) {
    const log = onLog || (() => {});
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;
    log('proxy', `Routing: ${url}`);
    stats.requests++;

    let html = null, ms = 0, usedBackend = BACKENDS[activeBackend].name;

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
        log('success', `[${b.name}] OK — ${(html.length / 1024).toFixed(1)}KB in ${ms}ms`);
        break;
      } catch (e) {
        log('error', `[${b.name}] ${e.message}`);
      }
    }

    if (!html) throw new Error('All backends failed for: ' + url);

    // Inline all stylesheets before returning (async step)
    log('proxy', 'Inlining stylesheets…');
    const content = await inlineCSS(html, url, log);

    return { content, url, ms, backend: usedBackend };
  }

  // ── CSS INLINER ───────────────────────────────────────────────────────
  // Finds every <link rel="stylesheet" href="…">, fetches the CSS, rewrites
  // its url() references to absolute proxied URLs, replaces the <link> with
  // an inline <style> block.
  async function inlineCSS(html, baseUrl, log) {
    // Collect all stylesheet links
    const linkRe = /<link\b([^>]*?)>/gi;
    const sheetJobs = [];

    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const full = m[0];
      const attrs = m[1];
      // Must be rel="stylesheet" (or rel="preload" as="style")
      if (!/rel\s*=\s*['"]stylesheet['"]/i.test(attrs) &&
          !/rel\s*=\s*['"]preload['"][^>]*as\s*=\s*['"]style['"]/i.test(attrs)) continue;
      const hm = attrs.match(/href\s*=\s*(['"])(.*?)\1/i);
      if (!hm) continue;
      const href = hm[2].trim();
      if (!href || href.startsWith('data:')) continue;
      let absUrl;
      try { absUrl = new URL(href, baseUrl).href; } catch (e) { continue; }
      sheetJobs.push({ full, absUrl });
    }

    log('proxy', `Found ${sheetJobs.length} stylesheet(s) to inline`);

    // Fetch all in parallel (cap at 8)
    const results = await Promise.all(
      sheetJobs.slice(0, 8).map(async job => {
        try {
          const css = await proxyFetch(job.absUrl);
          if (!css) return { ...job, css: null };
          const rewritten = rewriteCSSUrls(css, job.absUrl);
          log('net', `[CSS] inlined ${job.absUrl.split('/').pop() || job.absUrl} (${(css.length/1024).toFixed(1)}KB)`);
          return { ...job, css: rewritten };
        } catch (e) {
          return { ...job, css: null };
        }
      })
    );

    // Replace each <link> with <style> (or comment on failure)
    for (const { full, absUrl, css } of results) {
      if (css) {
        html = html.replace(full, `<style data-pw-src="${absUrl.replace(/"/g,'&quot;')}">\n${css}\n</style>`);
      } else {
        html = html.replace(full, `<!-- ProxyWave: failed to inline ${absUrl} -->`);
      }
    }

    // Now do the rest of the rewriting (images, scripts, anchors, bridge)
    html = rewriteHTML(html, baseUrl, log);
    return html;
  }

  // ── CSS url() REWRITER ────────────────────────────────────────────────
  // Rewrites url() inside a CSS string, resolving relative to the sheet's URL
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

  // ── HTML REWRITER (non-CSS) ───────────────────────────────────────────
  function rewriteHTML(html, baseUrl, log) {
    // Strip CSP
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*\/?>/gi, '');

    // Block trackers
    let blocked = 0;
    html = html.replace(
      /<script\b[^>]*?src\s*=\s*['"][^'"]*(?:google-analytics|googletagmanager|doubleclick|hotjar|clarity)[^'"]*['"][^>]*>[\s\S]*?<\/script>/gi,
      m => { blocked++; return '<!-- tracker blocked -->'; }
    );
    if (blocked) { stats.blocked += blocked; log && log('info', `Blocked ${blocked} tracker(s)`); }

    // Proxy img/script/video/audio src
    html = html.replace(
      /(<(?:img|script|video|audio|source|track|embed)\b[^>]*?\s)src(\s*=\s*)(['"])((?!data:|blob:|https?:\/\/api\.allorigins)[^'"]+)\3/gis,
      (m, pre, eq, q, url) => {
        const a = resolveAbs(url, baseUrl);
        return a ? `${pre}src${eq}${q}https://api.allorigins.win/raw?url=${encodeURIComponent(a)}${q}` : m;
      }
    );

    // Proxy remaining <link href> (non-stylesheet, e.g. icons)
    html = html.replace(
      /(<link\b[^>]*?\s)href(\s*=\s*)(['"])((?!data:|#)[^'"]+)\3/gis,
      (m, pre, eq, q, url) => {
        if (url.startsWith('https://api.allorigins')) return m; // already proxied
        const a = resolveAbs(url, baseUrl);
        return a ? `${pre}href${eq}${q}https://api.allorigins.win/raw?url=${encodeURIComponent(a)}${q}` : m;
      }
    );

    // Rewrite inline style url() references
    html = html.replace(
      /(<[^>]+\bstyle\s*=\s*['"])([^'"]*url\([^)]+\)[^'"]*)\1/gi,
      (m, pre, styleVal) => {
        const rewritten = rewriteCSSUrls(styleVal, baseUrl);
        return pre + rewritten + pre.slice(-1);
      }
    );

    // Rewrite <style> blocks (remaining ones not already inlined)
    html = html.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (m, open, css, close) => open + rewriteCSSUrls(css, baseUrl) + close
    );

    // Rewrite <a href> → data-pw-href
    html = rewriteAnchors(html, baseUrl);

    // Inject bridge + toolbar
    const bridge = makeBridge(baseUrl);
    const toolbar = makeToolbar(baseUrl);

    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, bridge + '\n</head>');
    } else {
      html = bridge + html;
    }

    const bodyMatch = html.match(/<body[^>]*>/i);
    if (bodyMatch) {
      html = html.replace(bodyMatch[0], bodyMatch[0] + toolbar);
    } else {
      html = toolbar + html;
    }

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
        // No href at all — just data-pw-href. Avoids href="#" navigating parent frame.
        // Injected CSS restores cursor:pointer.
        return `${pre} data-pw-href="${a.replace(/"/g, '&quot;')}"`;
      }
    );
  }

  // ── BRIDGE ─────────────────────────────────────────────────────────────
  function makeBridge(baseUrl) {
    return `<style>
/* ProxyWave: restore pointer cursor on rewritten links */
a[data-pw-href]{cursor:pointer!important;text-decoration:underline}
a[data-pw-href]:hover{opacity:.85}
</style>
<script id="__pw_bridge__">
(function(){
  var BASE=${JSON.stringify(baseUrl)};
  function nav(url){try{window.parent.postMessage({type:'__pw_nav__',url:url},'*')}catch(e){}}
  function resolve(url){
    if(!url)return null;
    url=url.trim();
    if(/^(javascript:|mailto:|tel:|#)/.test(url))return null;
    try{return new URL(url,BASE).href}catch(e){return null}
  }
  // Capture phase so we fire before any page JS
  document.addEventListener('click',function(e){
    var el=e.target;
    // Walk up up to 8 levels to find an anchor
    for(var i=0;i<8&&el;i++){if(el.tagName==='A')break;el=el.parentElement;}
    if(!el||el.tagName!=='A')return;
    // Prefer data-pw-href (pre-resolved), fall back to href
    var target=el.getAttribute('data-pw-href')||el.getAttribute('href')||'';
    if(!target)return;
    var url=resolve(target);
    if(!url)return;
    e.preventDefault();
    e.stopImmediatePropagation();
    nav(url);
  },true);
  // Form submissions
  document.addEventListener('submit',function(e){
    var form=e.target;
    var action=form.getAttribute('action')||BASE;
    var resolved=resolve(action)||BASE;
    var params=new URLSearchParams(new FormData(form)).toString();
    var url=params?(resolved.includes('?')?resolved+'&'+params:resolved+'?'+params):resolved;
    e.preventDefault();
    nav(url);
  },true);
  window.__pw_navigate=nav;
})();
<\/script>`;
  }

  // ── TOOLBAR ────────────────────────────────────────────────────────────
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
