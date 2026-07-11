'use client';

import { useEffect } from 'react';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type { AppNotification } from '@/types';
import {
  NOTIFICATION_SEVERITY_CONTAINER_CLASSES,
  NOTIFICATION_SEVERITY_TITLE_CLASSES,
} from '@/lib/statusClasses';

const AUTO_DISMISS_MS: Partial<Record<AppNotification['severity'], number>> = {
  info: 8000,
  warning: 15000,
  // critical: never auto-dismissed
};

export function NotificationToast() {
  const notifications = useNotificationStore((s) => s.notifications);
  const dismiss = useNotificationStore((s) => s.dismiss);

  const visible = notifications.filter((n) => !n.dismissed).slice(0, 5);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    visible.forEach((n) => {
      const delay = AUTO_DISMISS_MS[n.severity];
      if (delay !== undefined) {
        timers.push(setTimeout(() => dismiss(n.id), delay));
      }
    });

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, dismiss]);

  if (visible.length === 0) return null;

  return (
    <div
      className="fixed right-4 top-4 z-50 flex flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {visible.map((n) => (
        <div
          key={n.id}
          className={`flex w-80 items-start gap-3 rounded border p-3 shadow-lg ${NOTIFICATION_SEVERITY_CONTAINER_CLASSES[n.severity]}`}
          role="alert"
        >
          <div className="min-w-0 flex-1">
            <p
              className={`text-sm font-semibold ${NOTIFICATION_SEVERITY_TITLE_CLASSES[n.severity]}`}
            >
              {n.title}
            </p>
            <p className="mt-0.5 text-xs opacity-90">{n.message}</p>
          </div>
          <button
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-current"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
