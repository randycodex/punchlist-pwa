import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createArea, createProject } from '@/lib/db';
import {
  AppUpdateWaitingError,
  OfflineBuildMismatchError,
  isOfflineUpdateError,
  prepareSavedProjectPages,
} from '@/features/offline/sitePreparation';

const ready = { ready: true, build: 'test', missing: [] as string[] };
const offlineAppStatus = readFileSync(
  resolve(process.cwd(), 'src/features/offline/OfflineAppStatus.tsx'),
  'utf8'
);
const sitePreparation = readFileSync(
  resolve(process.cwd(), 'src/features/offline/sitePreparation.ts'),
  'utf8'
);

describe('saved project offline preparation', () => {
  it('prepares every saved area without requiring a prior visit, excluding removed records', async () => {
    const project = createProject('Offline');
    project.areas = Array.from({ length: 12 }, (_, index) => createArea(project.id, String(index), index));
    project.areas[0].deletedAt = new Date();
    project.areas[1].purgedAt = new Date();
    const deleted = createProject('Removed'); deleted.deletedAt = new Date();
    const check = vi.fn(async (_paths: string[], prepare = false) => ({ ...ready, ready: prepare }));
    await prepareSavedProjectPages([project, deleted], check);
    const prepared = check.mock.calls.filter(([, prepare]) => prepare).flatMap(([paths]) => paths);
    expect(prepared).toEqual(['/', `/project/${project.id}`, ...project.areas.slice(2).map((area) => `/project/${project.id}/area/${area.id}`)]);
    expect(check.mock.calls.every(([paths]) => paths.length <= 5)).toBe(true);
  });
  it('checks existing copies without downloading them again and reports incomplete preparation', async () => {
    const check = vi.fn(async () => ready);
    await prepareSavedProjectPages([], check);
    expect(check).toHaveBeenCalledExactlyOnceWith(['/']);
    await expect(prepareSavedProjectPages([], async () => ({ ...ready, ready: false }))).rejects.toThrow('unavailable offline');
  });
});

describe('offline version mismatch handling', () => {
  it('classifies waiting updates and build mismatches as update errors, not prep retries', () => {
    expect(isOfflineUpdateError(new OfflineBuildMismatchError())).toBe(true);
    expect(isOfflineUpdateError(new AppUpdateWaitingError('waiting'))).toBe(true);
    expect(isOfflineUpdateError(new Error('Some saved pages are still unavailable offline.'))).toBe(false);
  });

  it('rejects mismatched worker builds with OfflineBuildMismatchError instead of a Retry loop message', () => {
    expect(sitePreparation).toContain('new OfflineBuildMismatchError()');
    expect(sitePreparation).not.toContain('The offline copy belongs to an earlier app version');
  });

  it('routes version mismatch to Update now or Reload to update, not Retry', () => {
    expect(offlineAppStatus).toContain('isOfflineUpdateError');
    expect(offlineAppStatus).toContain('Update now');
    expect(offlineAppStatus).toContain('Reload to update');
    expect(offlineAppStatus).toContain("action === 'reload'");
    expect(offlineAppStatus).toContain("notice.action !== 'reload'");
    expect(offlineAppStatus).toContain('Save your changes first');
  });
});
