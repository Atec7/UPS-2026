// =====================================================================
// Service Worker — funciona offline, atualiza sob demanda
// =====================================================================
// Ao publicar uma nova versão, altere VERSION (mesmo valor de version.json
// e de APP_VERSION em app.js). O cache é versionado para forçar recarga.
// =====================================================================
var VERSION = '1.1.0';
var CACHE = 'ups-system-' + VERSION;
var SHELL = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './manifest.json',
  './version.json',
  './sw.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/marker-icon.png',
  './vendor/leaflet/marker-icon-2x.png',
  './vendor/leaflet/marker-shadow.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(SHELL);
    }).catch(function(err) {
      console.warn('Pré-cache parcial:', err);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Navegações: rede primeiro, cache como fallback (permite usar offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function(res) {
        var copy = res.clone();
        caches.open(CACHE).then(function(cache) { cache.put('./index.html', copy); });
        return res;
      }).catch(function() {
        return caches.match(req).then(function(cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Requisições para o Firebase (API): pura rede, nunca em cache.
  // Offline elas rejeitam e a camada db.js usa o espelho local.
  if (url.hostname.indexOf('firebaseio') !== -1) {
    e.respondWith(fetch(req));
    return;
  }

  var isSameOrigin = url.origin === self.location.origin;

  // version.json nunca entra em cache (precisa ser sempre fresco)
  if (url.pathname.indexOf('version.json') !== -1) return;

  // Assets locais (estáticos do app): rede primeiro, cache como fallback.
  // Assim, em linha, a recarga sempre traz a versão mais recente; offline usa o cache.
  if (isSameOrigin) {
    e.respondWith(
      fetch(req).then(function(res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function(cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function() {
        return caches.match(req);
      })
    );
    return;
  }

  // Recursos externos (Leaflet CDN, fontes, tiles, geocode): cache-first
  e.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function(cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function() { return cached; });
    })
  );
});
