const CACHE_NAME = 'shift-care-v1';
const APP_SHELL = ['index.html', 'employee.html', 'manager.html', 'admin.html', 'verify-email.html', 'css/style.css', 'js/api.js', 'manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'Shift & Care', body: 'You have a new notification.' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: 'manifest.json' }));
});
