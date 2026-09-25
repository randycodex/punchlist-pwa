'use client';

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { localAccountKey } from '@/lib/localAccount';

export type QuickSortOption = 'issues' | 'alphabetical' | 'progress';
export type CameraQuality = 'high' | 'medium' | 'low';
export type CameraFacing = 'rear' | 'front';
export type DensityMode = 'compact' | 'comfortable';
export type ExportLocation = 'local' | 'onedrive';
export type FilenameFormat = 'project-date' | 'project-only' | 'date-project';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type DefaultItemState = 'pending' | 'ok';

type AppSettings = {
  homeShowOnlyIssues: boolean;
  projectShowOnlyIssues: boolean;
  inspectionShowOnlyIssues: boolean;
  quickSort: QuickSortOption;
  profileName: string;
  profileInitials: string;
  cameraQuality: CameraQuality;
  autoSaveAfterCapture: boolean;
  defaultCamera: CameraFacing;
  saveCopyToPhotos: boolean;
  defaultItemState: DefaultItemState;
  autoExpandNextItem: boolean;
  density: DensityMode;
  defaultExportLocation: ExportLocation;
  filenameFormat: FilenameFormat;
  dateFormat: DateFormat;
  confirmBeforeDelete: boolean;
  lastSyncAt: string | null;
};

type AppSettingsContextValue = AppSettings & {
  setHomeShowOnlyIssues: (value: boolean) => void;
  setProjectShowOnlyIssues: (value: boolean) => void;
  setInspectionShowOnlyIssues: (value: boolean) => void;
  setQuickSort: (value: QuickSortOption) => void;
  setProfileName: (value: string) => void;
  setProfileInitials: (value: string) => void;
  setCameraQuality: (value: CameraQuality) => void;
  setAutoSaveAfterCapture: (value: boolean) => void;
  setDefaultCamera: (value: CameraFacing) => void;
  setSaveCopyToPhotos: (value: boolean) => void;
  setDefaultItemState: (value: DefaultItemState) => void;
  setAutoExpandNextItem: (value: boolean) => void;
  setDensity: (value: DensityMode) => void;
  setDefaultExportLocation: (value: ExportLocation) => void;
  setFilenameFormat: (value: FilenameFormat) => void;
  setDateFormat: (value: DateFormat) => void;
  setConfirmBeforeDelete: (value: boolean) => void;
  markSyncedNow: () => void;
};

const STORAGE_KEY = 'punchlist:app-settings';

const defaultSettings: AppSettings = {
  homeShowOnlyIssues: false,
  projectShowOnlyIssues: false,
  inspectionShowOnlyIssues: false,
  quickSort: 'issues',
  profileName: '',
  profileInitials: '',
  cameraQuality: 'high',
  autoSaveAfterCapture: true,
  defaultCamera: 'rear',
  saveCopyToPhotos: false,
  defaultItemState: 'pending',
  autoExpandNextItem: false,
  density: 'comfortable',
  defaultExportLocation: 'local',
  filenameFormat: 'project-date',
  dateFormat: 'MM/DD/YYYY',
  confirmBeforeDelete: true,
  lastSyncAt: null,
};

const AppSettingsContext = createContext<AppSettingsContextValue | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === 'undefined') return defaultSettings;
    try {
      const raw = window.localStorage.getItem(localAccountKey(STORAGE_KEY));
      if (!raw) return defaultSettings;
      const rawSettings = JSON.parse(raw) as Partial<AppSettings> & { showOnlyIssues?: boolean };
      const parsed = { ...defaultSettings, ...rawSettings } as AppSettings;
      if (typeof rawSettings.showOnlyIssues === 'boolean' && rawSettings.homeShowOnlyIssues === undefined) {
        parsed.homeShowOnlyIssues = rawSettings.showOnlyIssues;
      }
      if (parsed.profileName === 'Inspector' && parsed.profileInitials === 'IN') {
        parsed.profileName = '';
        parsed.profileInitials = '';
      }
      return parsed;
    } catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(localAccountKey(STORAGE_KEY), JSON.stringify(settings));
    } catch {}
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.density = settings.density;
  }, [settings.density]);

  const value = useMemo<AppSettingsContextValue>(
    () => ({
      ...settings,
      setHomeShowOnlyIssues: (homeShowOnlyIssues) => setSettings((prev) => ({ ...prev, homeShowOnlyIssues })),
      setProjectShowOnlyIssues: (projectShowOnlyIssues) => setSettings((prev) => ({ ...prev, projectShowOnlyIssues })),
      setInspectionShowOnlyIssues: (inspectionShowOnlyIssues) => setSettings((prev) => ({ ...prev, inspectionShowOnlyIssues })),
      setQuickSort: (quickSort) => setSettings((prev) => ({ ...prev, quickSort })),
      setProfileName: (profileName) => setSettings((prev) => ({ ...prev, profileName })),
      setProfileInitials: (profileInitials) => setSettings((prev) => ({ ...prev, profileInitials })),
      setCameraQuality: (cameraQuality) => setSettings((prev) => ({ ...prev, cameraQuality })),
      setAutoSaveAfterCapture: (autoSaveAfterCapture) => setSettings((prev) => ({ ...prev, autoSaveAfterCapture })),
      setDefaultCamera: (defaultCamera) => setSettings((prev) => ({ ...prev, defaultCamera })),
      setSaveCopyToPhotos: (saveCopyToPhotos) => setSettings((prev) => ({ ...prev, saveCopyToPhotos })),
      setDefaultItemState: (defaultItemState) => setSettings((prev) => ({ ...prev, defaultItemState })),
      setAutoExpandNextItem: (autoExpandNextItem) => setSettings((prev) => ({ ...prev, autoExpandNextItem })),
      setDensity: (density) => setSettings((prev) => ({ ...prev, density })),
      setDefaultExportLocation: (defaultExportLocation) => setSettings((prev) => ({ ...prev, defaultExportLocation })),
      setFilenameFormat: (filenameFormat) => setSettings((prev) => ({ ...prev, filenameFormat })),
      setDateFormat: (dateFormat) => setSettings((prev) => ({ ...prev, dateFormat })),
      setConfirmBeforeDelete: (confirmBeforeDelete) => setSettings((prev) => ({ ...prev, confirmBeforeDelete })),
      markSyncedNow: () =>
        setSettings((prev) => ({
          ...prev,
          lastSyncAt: new Date().toISOString(),
        })),
    }),
    [settings]
  );

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error('useAppSettings must be used within an AppSettingsProvider');
  }
  return context;
}
