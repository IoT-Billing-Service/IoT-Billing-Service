import { create } from 'zustand';
import type { AppNotification } from '@/types';
import { cachePut } from '@/services/indexedDbCache';

const CRITICAL_KEY = 'pending-critical';

interface NotificationStore {
  notifications: AppNotification[];
  add: (notification: AppNotification) => void;
  dismiss: (id: string) => void;
  hydrateCritical: (notifications: AppNotification[]) => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],

  add(notification) {
    set((state) => ({ notifications: [notification, ...state.notifications] }));
    if (notification.severity === 'critical') {
      const criticalPending = get().notifications.filter(
        (n) => n.severity === 'critical' && !n.dismissed,
      );
      cachePut('notifications', CRITICAL_KEY, criticalPending).catch(() => {});
    }
  },

  dismiss(id) {
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, dismissed: true } : n)),
    }));
    const criticalPending = get().notifications.filter(
      (n) => n.severity === 'critical' && !n.dismissed,
    );
    cachePut('notifications', CRITICAL_KEY, criticalPending).catch(() => {});
  },

  hydrateCritical(notifications) {
    set((state) => ({ notifications: [...notifications, ...state.notifications] }));
  },
}));
