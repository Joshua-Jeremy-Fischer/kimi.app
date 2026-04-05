self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'ESO Bot', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
      actions: [
        { action: 'yes', title: 'Ja, helfen!' },
        { action: 'no',  title: 'Nein, danke' }
      ]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  if (event.action === 'yes') {
    event.waitUntil(clients.openWindow(url + '?checkin=yes'));
  } else if (event.action === 'no') {
    // Stille Ablehnung — kein Öffnen
    fetch('/api/push/checkin-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'no' })
    }).catch(() => {});
  } else {
    event.waitUntil(clients.openWindow(url));
  }
});
