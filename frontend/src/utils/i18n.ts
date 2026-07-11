const _storage: Record<string, string> = {};

export function t(key: string, fallback?: string): string {
  return _storage[key] ?? fallback ?? key;
}

export function setTranslations(map: Record<string, string>): void {
  Object.assign(_storage, map);
}
