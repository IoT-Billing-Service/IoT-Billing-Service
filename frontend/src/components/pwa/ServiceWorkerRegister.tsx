'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((registration) => {
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  const event = new CustomEvent('sw-update-available', {
                    detail: { registration },
                  });
                  window.dispatchEvent(event);
                }
              });
            }
          });
        })
        .catch(() => {});
    }
  }, []);

  return null;
}
