'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const DEBOUNCE_MS = 500;

interface DraftEntry<T> {
  data: T;
  savedAt: number;
}

function readDraft<T>(key: string): DraftEntry<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const entry = JSON.parse(raw) as DraftEntry<T>;
      if (entry?.data && typeof entry.savedAt === 'number') return entry;
    }
  } catch {
    // corrupt or unavailable storage
  }
  return null;
}

export function useAutoSaveDraft<T extends object>(key: string, initialValues: T) {
  const initialRef = useRef(initialValues);
  const [values, setValues] = useState<T>(initialValues);
  const [pendingDraft, setPendingDraft] = useState<DraftEntry<T> | null>(() => readDraft<T>(key));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (data: T) => {
      try {
        localStorage.setItem(key, JSON.stringify({ data, savedAt: Date.now() }));
      } catch {
        // storage quota exceeded — silently skip
      }
    },
    [key],
  );

  const updateField = useCallback(
    <K extends keyof T>(field: K, value: T[K]) => {
      setValues((prev) => {
        const next = { ...prev, [field]: value };
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => persist(next), DEBOUNCE_MS);
        return next;
      });
    },
    [persist],
  );

  // Accept the pending draft — populate the form with saved values
  const restoreDraft = useCallback(() => {
    if (pendingDraft) {
      setValues(pendingDraft.data);
      setPendingDraft(null);
    }
  }, [pendingDraft]);

  // Reject the pending draft — discard without touching form values
  const discardDraft = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    setPendingDraft(null);
  }, [key]);

  // Called after a successful submit — flush timer and wipe storage
  const clearDraft = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    setPendingDraft(null);
    setValues(initialRef.current);
  }, [key]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    values,
    updateField,
    pendingDraft,
    restoreDraft,
    discardDraft,
    clearDraft,
  };
}
