import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoSaveDraft } from './useAutoSaveDraft';

const KEY = 'test-draft-key';

const INITIAL = { name: '', deviceId: '', type: '' };

function makeEntry(data: typeof INITIAL, savedAt = Date.now()) {
  return JSON.stringify({ data, savedAt });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('useAutoSaveDraft – initial state', () => {
  it('starts with initial values and no pending draft when storage is empty', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    expect(result.current.values).toEqual(INITIAL);
    expect(result.current.pendingDraft).toBeNull();
  });

  it('surfaces a pending draft when one exists in localStorage', () => {
    const saved = { name: 'Sensor A', deviceId: 'D-1', type: 'sensor' };
    localStorage.setItem(KEY, makeEntry(saved));

    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    // pendingDraft reflects what is in storage (not yet applied to form)
    expect(result.current.pendingDraft?.data).toEqual(saved);
    // Form values are still the initial values until the user restores
    expect(result.current.values).toEqual(INITIAL);
  });

  it('ignores corrupt localStorage entries', () => {
    localStorage.setItem(KEY, 'not-valid-json{{{');

    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    expect(result.current.pendingDraft).toBeNull();
    expect(result.current.values).toEqual(INITIAL);
  });
});

describe('useAutoSaveDraft – updateField and debounced save', () => {
  it('updates the form value immediately', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Gateway B');
    });

    expect(result.current.values.name).toBe('Gateway B');
  });

  it('does not write to localStorage before the debounce fires', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Gateway B');
    });

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('writes to localStorage after the debounce delay', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Gateway B');
    });

    act(() => {
      vi.runAllTimers();
    });

    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const entry = JSON.parse(raw!);
    expect(entry.data.name).toBe('Gateway B');
  });

  it('resets the debounce timer when called multiple times in quick succession', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'A');
      result.current.updateField('name', 'AB');
      result.current.updateField('name', 'ABC');
    });

    act(() => {
      vi.runAllTimers();
    });

    const raw = localStorage.getItem(KEY);
    const entry = JSON.parse(raw!);
    expect(entry.data.name).toBe('ABC');
  });
});

describe('useAutoSaveDraft – restoreDraft', () => {
  it('applies the saved draft values to the form', () => {
    const saved = { name: 'Sensor X', deviceId: 'D-99', type: 'actuator' };
    localStorage.setItem(KEY, makeEntry(saved));

    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.restoreDraft();
    });

    expect(result.current.values).toEqual(saved);
    expect(result.current.pendingDraft).toBeNull();
  });

  it('is a no-op when there is no pending draft', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.restoreDraft();
    });

    expect(result.current.values).toEqual(INITIAL);
  });
});

describe('useAutoSaveDraft – discardDraft', () => {
  it('clears pendingDraft and removes the key from localStorage', () => {
    const saved = { name: 'Old device', deviceId: 'D-0', type: 'gateway' };
    localStorage.setItem(KEY, makeEntry(saved));

    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.discardDraft();
    });

    expect(result.current.pendingDraft).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    // Form values are unchanged (still initial, draft was never applied)
    expect(result.current.values).toEqual(INITIAL);
  });
});

describe('useAutoSaveDraft – clearDraft', () => {
  it('removes the key from storage and resets form to initial values', async () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Will be cleared');
    });

    act(() => {
      vi.runAllTimers();
    });

    act(() => {
      result.current.clearDraft();
    });

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(result.current.values).toEqual(INITIAL);
    expect(result.current.pendingDraft).toBeNull();
  });

  it('cancels the pending debounce so no write happens after clear', () => {
    const { result } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Typed but cleared');
      // Clear before debounce fires
      result.current.clearDraft();
    });

    act(() => {
      vi.runAllTimers();
    });

    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('useAutoSaveDraft – cleanup', () => {
  it('cancels the debounce timer on unmount', () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const { result, unmount } = renderHook(() => useAutoSaveDraft(KEY, INITIAL));

    act(() => {
      result.current.updateField('name', 'Unmount test');
    });

    unmount();

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
