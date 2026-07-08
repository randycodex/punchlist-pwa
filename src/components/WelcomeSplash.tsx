'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import Image from 'next/image';

const SPLASH_DURATION_MS = 1000;

export default function WelcomeSplash({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
    }, SPLASH_DURATION_MS);

    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      {children}
      <div
        aria-hidden="true"
        className={`fixed inset-0 z-[120] flex items-center justify-center transition-opacity duration-300 ${
          visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ backgroundColor: 'var(--surface)' }}
      >
        <Image
          src="/uai-logo.png"
          alt="UAI Logo"
          width={337}
          height={184}
          priority
          className="h-20 w-auto object-contain"
        />
      </div>
    </>
  );
}
