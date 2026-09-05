'use client';

import OfflineAppStatus from '@/features/offline/OfflineAppStatus';
import { ReactNode } from 'react';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { MicrosoftAuthProvider } from '@/contexts/MicrosoftAuthContext';
import { CollaborationAuthProvider } from '@/contexts/CollaborationAuthContext';
import { SyncStatusProvider } from '@/contexts/SyncStatusContext';
import { AppSettingsProvider } from '@/contexts/AppSettingsContext';

export default function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MicrosoftAuthProvider>
      <CollaborationAuthProvider>
        <SyncStatusProvider>
          <AppSettingsProvider>
            <ThemeProvider>
              <OfflineAppStatus />
              {children}
            </ThemeProvider>
          </AppSettingsProvider>
        </SyncStatusProvider>
      </CollaborationAuthProvider>
    </MicrosoftAuthProvider>
  );
}
