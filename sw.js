// خدمة العمل دون اتصال للتطبيق — تحفظ واجهة التطبيق، والبيانات دائماً من Supabase
const CACHE = 'buffet-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co')) return;
  // الشبكة أولاً (لتصل التحديثات فوراً)، والنسخة المحفوظة عند انقطاع الإنترنت
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && u.origin === self.location.origin) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
