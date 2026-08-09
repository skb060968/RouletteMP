const CACHE_VERSION = 'v60';
const CACHE_NAME = `roulette-mp-${CACHE_VERSION}`;
const APP_SHELL = '/index.html';
const STATIC_ASSETS = [
  APP_SHELL,
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/sounds/chip-click.mp3',
  '/sounds/bet-close.mp3',
  '/sounds/spin-loop.mp3',
  '/sounds/win.mp3',
  '/sounds/error.mp3',
  '/sounds/music.mp3',
];

function isSuccessfulFullResponse(response) {
  return response.ok
    && response.status === 200
    && !response.headers.has('Content-Range');
}

function cacheKeyFor(request, isHtmlRequest = false) {
  if (isHtmlRequest) return APP_SHELL;
  const url = new URL(request.url);
  return url.pathname;
}

async function cacheResponse(key, response) {
  if (!isSuccessfulFullResponse(response)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, response.clone());
  } catch (_) {
    // A failed cache write must not fail the network response.
  }
}

async function respondToRangeRequest(request) {
  const cached = await caches.match(cacheKeyFor(request));
  if (!cached || cached.status !== 200) return fetch(request);

  const bytes = await cached.arrayBuffer();
  const size = bytes.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (!match || (!match[1] && !match[2])) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);

  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async (asset) => {
      try {
        const response = await fetch(new Request(asset, { cache: 'reload' }));
        if (isSuccessfulFullResponse(response)) await cache.put(asset, response);
      } catch (_) {
        // A single optional asset must not prevent the worker from installing.
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('roulette-mp-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.headers.has('Range')) {
    event.respondWith(respondToRangeRequest(request));
    return;
  }

  const acceptsHtml = request.mode === 'navigate'
    || request.destination === 'document'
    || request.headers.get('Accept')?.includes('text/html');

  if (acceptsHtml) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        await cacheResponse(cacheKeyFor(request, true), response);
        return response;
      } catch (_) {
        const cachedShell = await caches.match(APP_SHELL);
        return cachedShell || new Response('Offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  const key = cacheKeyFor(request);
  const networkFirst = request.destination === 'script'
    || request.destination === 'style'
    || url.pathname.startsWith('/assets/');

  event.respondWith((async () => {
    if (!networkFirst) {
      const cached = await caches.match(key);
      if (cached) return cached;
    }
    try {
      const response = await fetch(request);
      await cacheResponse(key, response);
      return response;
    } catch (_) {
      const cached = await caches.match(key);
      return cached || new Response('Resource unavailable while offline', {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
