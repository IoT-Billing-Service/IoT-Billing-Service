import DOMPurify from 'dompurify';

export function sanitizeHtml(input: string): string {
  if (typeof window === 'undefined') {
    return input.replace(/<[^>]*>/g, '');
  }
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onfocus', 'onmouseover'],
  });
}
