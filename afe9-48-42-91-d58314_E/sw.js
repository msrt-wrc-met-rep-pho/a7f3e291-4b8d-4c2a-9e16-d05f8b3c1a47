// sw.js — StageHand Service Worker
// Caches HTML detail pages (photos, weather, notes, forecasts) for offline/poor signal use.
// Strategy: network-first with 4s timeout, fall back to cache.
// GitHub API calls and images are never cached here.

const CACHE_VERSION = 'v1';
const CACHE_NAME    = 'stagehand-' + self.registration.scope.split('/').filter(Boolean).pop() + '-' + CACHE_VERSION;

const CACHE_PATTERNS = [
  /\/photos\.html$/,
  /\/weather\.html$/,
  /\/notes\.html$/,
  /\/forecasts\/forecasts\.html$/,
  /\/launch\.html$/,
];

const NEVER_CACHE = [
  /api\.github\.com/,
  /img\.youtube\.com/,
  /\/stats\//,
];

function shouldCache(url) {
  if (NEVER_CACHE.some(p => p.test(url))) return false;
  return CACHE_PATTERNS.some(p => p.test(url));
}

// Track which URLs were served from cache (keyed by client ID)
const _cacheHits = new Set();

// ── Install — no pre-caching, just activate immediately ──────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Delete old caches from previous versions
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('stagehand-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch — network-first with timeout, fall back to cache ────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Never intercept GitHub API or other non-cacheable resources
  if (NEVER_CACHE.some(p => p.test(url))) return;

  // Only apply strategy to cacheable HTML pages
  if (!shouldCache(url)) return;

  event.respondWith(networkFirstWithTimeout(event.request, 4000));
});

async function networkFirstWithTimeout(request, timeoutMs) {
  const cache = await caches.open(CACHE_NAME);

  // Race network against timeout
  const networkPromise = fetch(request.clone())
    .then(response => {
      if (response && response.status === 200) {
        // Cache a clone of the successful response
        cache.put(request, response.clone());
      }
      return response;
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );

  try {
    // Try network first — if it responds within timeout, use it
    return await Promise.race([networkPromise, timeoutPromise]);
  } catch (e) {
    // Network timed out or failed — try cache
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW] Serving from cache:', request.url);
      // Add custom header so page can detect cache hit
      const headers = new Headers(cached.headers);
      headers.set('X-From-SW-Cache', '1');
      const cachedWithHeader = new Response(cached.body, {
        status:  cached.status,
        statusText: cached.statusText,
        headers
      });
      return cachedWithHeader;
    }
    // Nothing in cache — let the network error propagate
    return networkPromise;
  }
}

// ── Handle page messages ──────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_CACHE_STATUS') {
    // Page checks if it should show the cached banner
    // We can't know here, but we reply to let the page know SW is active
    event.source.postMessage({ type: 'SW_READY' });
  }
});
