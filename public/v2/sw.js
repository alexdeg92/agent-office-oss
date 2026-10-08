// Retires the v1 UI's service worker (S16 follow-up). v1 registered /sw.js with scope '/'; browsers that installed it
// check this URL for updates, install this version, and it unregisters itself. The v2 UI registers no worker.
// Safe to delete once no browser can still hold a v1 registration (well after S16).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));
