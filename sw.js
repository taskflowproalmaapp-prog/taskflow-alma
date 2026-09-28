// TaskFlow Pro — service worker
// Dos trabajos: (1) permitir que el navegador ofrezca "Instalar app" de
// verdad (no solo un acceso directo), y (2) mostrar las notificaciones
// push que manda el servidor.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Sin caché agresivo a propósito — esta app cambia seguido y no queremos
// que alguien quede pegado viendo una versión vieja. Esto solo deja pasar
// las peticiones normales; es lo mínimo que algunos navegadores piden para
// considerar la app instalable.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener("push", (event) => {
  let data = { title: "TaskFlow Pro", body: "Tienes una novedad.", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { title: parsed.title || data.title, body: parsed.body || data.body, url: parsed.url || data.url };
    }
  } catch (e) {
    try { data.body = event.data.text(); } catch (e2) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
