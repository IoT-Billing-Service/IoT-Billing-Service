import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../src/utils/sanitizer';

describe('sanitizeHtml', () => {
  it('strips <script> tags and their content', () => {
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe('');
  });

  it('strips onerror event attributes', () => {
    expect(sanitizeHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('returns plain text for javascript: string (no tag context)', () => {
    expect(sanitizeHtml('javascript:void(0)')).toBe('javascript:void(0)');
  });

  it('strips <a> tag but preserves link text', () => {
    expect(sanitizeHtml('<a href="javascript:void(0)">click</a>')).toBe('click');
  });

  it('preserves plain text', () => {
    expect(sanitizeHtml('Device status: online')).toBe('Device status: online');
  });

  it('preserves Unicode and emoji sequences', () => {
    expect(sanitizeHtml('Device 设备 🔌')).toBe('Device 设备 🔌');
  });
});
