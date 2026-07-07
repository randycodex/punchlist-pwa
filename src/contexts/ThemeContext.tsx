'use client';

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

type Theme = 'light' | 'dark';
type ThemeMode = Theme | 'system';

interface ThemeContextType {
  theme: Theme;
  themeMode: ThemeMode;
  setThemeMode: (_mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'punchlist:theme-mode';
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function getStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';

  try {
    const storedMode = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(storedMode) ? storedMode : 'system';
  } catch {
    return 'system';
  }
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? getSystemTheme() : mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getStoredThemeMode()));

  useEffect(() => {
    if (themeMode !== 'system') {
      setTheme(themeMode);
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme() {
      setTheme(media.matches ? 'dark' : 'light');
    }

    applyTheme();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', applyTheme);
    } else {
      media.addListener(applyTheme);
    }

    return () => {
      if (typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', applyTheme);
      } else {
        media.removeListener(applyTheme);
      }
    };
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.dataset.themeMode = themeMode;
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    try {
      if (themeMode === 'system') {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, themeMode);
      }
    } catch {}
  }, [theme, themeMode]);

  const value = useMemo<ThemeContextType>(
    () => ({
      theme,
      themeMode,
      setThemeMode,
      toggleTheme: () => {
        setThemeMode((currentMode) => {
          const activeTheme = resolveTheme(currentMode);
          return activeTheme === 'dark' ? 'light' : 'dark';
        });
      },
    }),
    [theme, themeMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
