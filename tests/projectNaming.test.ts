import { describe, expect, it } from 'vitest';
import {
  formatDateForExport,
  getOneDriveProjectFolderName,
  sanitizeExportNamePart,
  sanitizeOneDriveProjectFolderPart,
} from '@/lib/projectNaming';

describe('project file and folder naming', () => {
  it('creates OneDrive-safe project folder names with stable fallbacks', () => {
    expect(sanitizeOneDriveProjectFolderPart('  12 / Main:Street  ', 'project')).toBe('12-Main-Street');
    expect(sanitizeOneDriveProjectFolderPart('***', 'project')).toBe('project');
    expect(
      getOneDriveProjectFolderName({
        projectName: 'Fallback Project',
        oneDriveFolderName: '',
      })
    ).toBe('Fallback-Project');
  });

  it('creates consistent PDF export names and local dates', () => {
    expect(sanitizeExportNamePart('  12 / Main Project  ')).toBe('12_Main_Project');
    expect(sanitizeExportNamePart('***')).toBe('Project');
    expect(formatDateForExport(new Date(2026, 6, 9, 12))).toBe('2026.07.09');
  });
});
