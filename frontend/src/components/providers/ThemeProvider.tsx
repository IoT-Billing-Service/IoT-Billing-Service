'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react';

type ThemeMode = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  isHighContrast: boolean;
  /** Perceptually uniform chart color palette for the current theme.
   *  Uses Viridis for standard themes, Inferno for high-contrast themes. */
  chartPalette: string[];
  /** Font-size scale factor (1.5 in high-contrast modes, 1 otherwise). */
  fontSizeScale: number;
  /** Whether the user prefers reduced motion (CSS prefers-reduced-motion: reduce). */
  prefersReducedMotion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_KEY = 'iot-billing-theme';
const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'high-contrast-light', 'high-contrast-dark'];

/*
 * Perceptually uniform color maps (colorblind-safe)
 * ─── Viridis  — used for standard themes
 * ─── Inferno — used for high-contrast themes (maximises visibility)
 */
const VIRIDIS_PALETTE = ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'];
const INFERNO_PALETTE = ['#fcffa4', '#fca50a', '#dd513a', '#932667', '#1a0a3e'];

function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.classList.remove('light', 'dark', 'high-contrast-light', 'high-contrast-dark');
  root.classList.add(mode);

  // Apply contrast-boost and text-shadow as inline custom props
  // for properties referenced by the old globals.css definitions.
  const isHC = mode === 'high-contrast-light' || mode === 'high-contrast-dark';
  root.style.setProperty('--contrast-boost', isHC ? '2' : '1');
  root.style.setProperty('--text-shadow', isHC ? '0 0 2px currentColor' : 'none');

  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // localStorage unavailable
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark';
    const stored = localStorage.getItem(THEME_KEY) as ThemeMode | null;
    const initial = stored ?? getSystemTheme();
    applyTheme(initial);
    return initial;
  });

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  // Listen for prefers-reduced-motion
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setPrefersReducedMotion(e.matches);
    };
    handler(mq);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    applyTheme(newMode);
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const idx = THEME_ORDER.indexOf(prev);
      const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]!;
      applyTheme(next);
      return next;
    });
  }, []);

  const isHighContrast = mode === 'high-contrast-light' || mode === 'high-contrast-dark';

  // Memoized chart palette based on current mode
  const chartPalette = useMemo<string[]>(() => {
    return isHighContrast ? INFERNO_PALETTE : VIRIDIS_PALETTE;
  }, [isHighContrast]);

  // Font-size scale: 1.5x in high-contrast modes for WCAG AAA
  const fontSizeScale = isHighContrast ? 1.5 : 1;

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode,
      toggle,
      isHighContrast,
      chartPalette,
      fontSizeScale,
      prefersReducedMotion,
    }),
    [mode, setMode, toggle, isHighContrast, chartPalette, fontSizeScale, prefersReducedMotion],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
