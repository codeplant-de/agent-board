// Mobile browsers refuse `new Notification()`, so the board shows its notifications through this worker and opens the task
// when one is clicked. It must stay without a `fetch` handler: it never sees a request, so it cannot serve or alter a page.
const TASK_PATH = /^\/t\/[A-Za-z0-9_-]+$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.path;
  const target = typeof path === 'string' && TASK_PATH.test(path) ? path : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      await open.focus();
      open.postMessage({ type: 'agent-board:open', path: target });
    })(),
  );
});
