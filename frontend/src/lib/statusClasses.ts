import type { PendingTransaction } from '@/services/indexedDbCache';
import type { AppNotification } from '@/types';

export type TxStatus = PendingTransaction['status'];
export type NotificationSeverity = AppNotification['severity'];

/**
 * Full static class strings per transaction status.
 * These are map-looked-up at runtime; all values must be complete Tailwind
 * utility strings so the CSS scanner sees them as literals, never as partial
 * interpolations (e.g. `bg-${status}-500`).
 */
export const TX_STATUS_CLASSES: Record<TxStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  confirmed: 'bg-green-500/20 text-green-300 border-green-500/40',
  failed: 'bg-red-500/20 text-red-300 border-red-500/40',
};

export const TX_STATUS_FALLBACK_CLASSES = 'bg-gray-500/20 text-gray-300 border-gray-500/40';

/**
 * Full static class strings per notification severity — container element.
 */
export const NOTIFICATION_SEVERITY_CONTAINER_CLASSES: Record<NotificationSeverity, string> = {
  info: 'border-green-500 bg-green-950 text-green-100',
  warning: 'border-amber-500 bg-amber-950 text-amber-100',
  critical: 'border-red-500 bg-red-950 text-red-100',
};

/**
 * Full static class strings per notification severity — title element.
 */
export const NOTIFICATION_SEVERITY_TITLE_CLASSES: Record<NotificationSeverity, string> = {
  info: 'text-green-300',
  warning: 'text-amber-300',
  critical: 'text-red-300',
};
