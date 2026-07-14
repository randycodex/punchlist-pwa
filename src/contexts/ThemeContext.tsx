'use client';

import { ReactNode, useEffect } from 'react';

const STORAGE_KEY = 'punchlist:theme-mode';

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme() {
      document.documentElement.dataset.themeMode = 'system';
      if (media.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }

      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {}
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
  }, []);

  return <>{children}</>;
}
