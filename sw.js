/**
 * ProxyWave Service Worker
 * Intercepts navigation requests and routes through CORS proxy
 */

const VERSION = 'pw-v1';
const PROXY_BACKENDS = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
  'https://api.codetabs.com/v1/proxy?quest=',
];

// Which backend to use (rotates on failure)
let backendIdx = 0;

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  
  // Only intercept requests tagged for proxying
  if (!url.includes('/__proxy__/')) return;
  
  const targetUrl = url.split('/__proxy__/')[1];
  if (!targetUrl) return;

  event.respondWith(fetchViaProxy(targetUrl, event.request));
});

async function fetchViaProxy(targetUrl, originalRequest) {
  // Decode the target URL
  const decoded = decodeURIComponent(targetUrl);
  
  for (let i = 0; i < PROXY_BACKENDS.length; i++) {
    const backend = PROXY_BACKENDS[(backendIdx + i) % PROXY_BACKENDS.length];
    try {
      const proxyUrl = backend + encodeURIComponent(decoded);
      const resp = await fetch(proxyUrl, {
        method: 'GET',
        headers: { 'Accept': '*/*' }
      });
      if (resp.ok) {
        backendIdx = (backendIdx + i) % PROXY_BACKENDS.length;
        return resp;
      }
    } catch(e) {
      // try next backend
    }
  }
  
  return new Response('Proxy fetch failed', { status: 502 });
}
