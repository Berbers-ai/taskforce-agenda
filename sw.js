/* Service worker: offline app-shell en pushmeldingen */
const CACHE = 'taskforcex-v7';
const SHELL = ['./', 'index.html', 'app.js', 'vendor/supabase-2.119.1.js', 'manifest.webmanifest', 'config.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netwerk eerst (zodat updates direct binnenkomen), cache als je offline bent.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: e.data && e.data.text() }; }
  const title = String(d.title || 'TaskForce X').slice(0, 120);
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(d.id || '') ? d.id : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : '';
  e.waitUntil(self.registration.showNotification(title, {
    body: String(d.body || '').slice(0, 240),
    tag: d.tag || undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    actions: id && date ? [{ action: 'done', title: 'Klaar' }] : [],
    data: { id, date }
  }));
});

// Tik op de melding: open de app op die dag. Knop "Klaar": open de app en vink de taak af.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { id, date } = e.notification.data || {};
  const link = e.action === 'done' && id && date ? `#done=${id}@${date}` : date ? `#d=${date}` : '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        if (link) c.postMessage({ link });
        return c.focus();
      }
    }
    return self.clients.openWindow(new URL('./' + link, self.registration.scope).href);
  }));
});
