'use client';

import { useState, useEffect, useCallback } from 'react';

function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

export function PushNotificationManager() {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isSupported = isPushSupported();

  useEffect(() => {
    if (!isSupported || Notification.permission !== 'granted') return;

    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        setIsSubscribed(!!subscription);
      })
      .catch(() => {
        setIsSubscribed(false);
      });
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (Notification.permission === 'denied') {
      return;
    }

    setIsLoading(true);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setIsLoading(false);
        return;
      }

      const registration = await navigator.serviceWorker.ready;

      let vapidPublicKey: string | null = null;
      try {
        const res = await fetch('/api/notifications/vapid-public-key');
        if (res.ok) {
          const data = await res.json();
          vapidPublicKey = data.publicKey;
        }
      } catch {
        // VAPID key unavailable; proceed without push
      }

      if (vapidPublicKey) {
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(vapidPublicKey) as unknown as string,
        });

        await fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        });
      }

      setIsSubscribed(true);
    } catch {
      // subscription failed
    } finally {
      setIsLoading(false);
    }
  }, []);

  if (!isSupported) return null;

  return (
    <div className="flex items-center gap-3">
      {!isSubscribed ? (
        <button
          onClick={subscribe}
          disabled={isLoading}
          className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-50"
          type="button"
        >
          {isLoading ? 'Enabling...' : 'Enable Push Notifications'}
        </button>
      ) : (
        <span className="text-xs text-green-400">Notifications active</span>
      )}
    </div>
  );
}
