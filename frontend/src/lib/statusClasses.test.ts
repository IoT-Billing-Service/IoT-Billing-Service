import { describe, it, expect } from 'vitest';
import {
  TX_STATUS_CLASSES,
  TX_STATUS_FALLBACK_CLASSES,
  NOTIFICATION_SEVERITY_CONTAINER_CLASSES,
  NOTIFICATION_SEVERITY_TITLE_CLASSES,
} from './statusClasses';
import type { TxStatus, NotificationSeverity } from './statusClasses';

const TX_STATUSES: TxStatus[] = ['pending', 'confirmed', 'failed'];
const SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical'];

const hasColor = (cls: string) => /\b(?:bg|text|border)-\S+/.test(cls);

describe('TX_STATUS_CLASSES', () => {
  it('covers every TxStatus value', () => {
    for (const status of TX_STATUSES) {
      expect(TX_STATUS_CLASSES).toHaveProperty(status);
    }
  });

  it.each(TX_STATUSES)('%s → non-empty string containing a color class', (status) => {
    const cls = TX_STATUS_CLASSES[status];
    expect(cls).toBeTruthy();
    expect(hasColor(cls)).toBe(true);
  });

  it('each status produces a distinct class string', () => {
    const values = TX_STATUSES.map((s) => TX_STATUS_CLASSES[s]);
    expect(new Set(values).size).toBe(TX_STATUSES.length);
  });
});

describe('TX_STATUS_FALLBACK_CLASSES', () => {
  it('is a non-empty string containing a color class', () => {
    expect(TX_STATUS_FALLBACK_CLASSES).toBeTruthy();
    expect(hasColor(TX_STATUS_FALLBACK_CLASSES)).toBe(true);
  });

  it('is distinct from every named status class', () => {
    for (const status of TX_STATUSES) {
      expect(TX_STATUS_FALLBACK_CLASSES).not.toBe(TX_STATUS_CLASSES[status]);
    }
  });
});

describe('NOTIFICATION_SEVERITY_CONTAINER_CLASSES', () => {
  it('covers every severity value', () => {
    for (const sev of SEVERITIES) {
      expect(NOTIFICATION_SEVERITY_CONTAINER_CLASSES).toHaveProperty(sev);
    }
  });

  it.each(SEVERITIES)('%s → non-empty string containing a color class', (sev) => {
    const cls = NOTIFICATION_SEVERITY_CONTAINER_CLASSES[sev];
    expect(cls).toBeTruthy();
    expect(hasColor(cls)).toBe(true);
  });

  it('each severity produces a distinct class string', () => {
    const values = SEVERITIES.map((s) => NOTIFICATION_SEVERITY_CONTAINER_CLASSES[s]);
    expect(new Set(values).size).toBe(SEVERITIES.length);
  });
});

describe('NOTIFICATION_SEVERITY_TITLE_CLASSES', () => {
  it('covers every severity value', () => {
    for (const sev of SEVERITIES) {
      expect(NOTIFICATION_SEVERITY_TITLE_CLASSES).toHaveProperty(sev);
    }
  });

  it.each(SEVERITIES)('%s → non-empty string containing a color class', (sev) => {
    const cls = NOTIFICATION_SEVERITY_TITLE_CLASSES[sev];
    expect(cls).toBeTruthy();
    expect(hasColor(cls)).toBe(true);
  });
});
