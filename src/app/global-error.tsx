'use client';

import { useEffect } from 'react';
import AppErrorFallback from '@/components/AppErrorFallback';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Punchlist application failed:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <AppErrorFallback onRetry={reset} />
      </body>
    </html>
  );
}
