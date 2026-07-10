'use client';

import { useEffect } from 'react';
import AppErrorFallback from '@/components/AppErrorFallback';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Punchlist route failed:', error);
  }, [error]);

  return <AppErrorFallback onRetry={reset} />;
}
