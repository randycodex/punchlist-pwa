import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNextOneDriveExportFilename, uploadPdfToOneDrive, uploadReportToOneDrive } from '@/lib/oneDrive';

afterEach(() => vi.unstubAllGlobals());

describe('report export to OneDrive', () => {
  it('versions ZIP files separately while keeping the default PDF naming', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(':/children?$select=name')) return Response.json({ value: [
        { name: 'Fixture_2026.10.23_1.zip' }, { name: 'Fixture_2026.10.23_3.ZIP' },
        { name: 'Fixture_2026.10.23_8.pdf' },
      ] });
      return Response.json({ id: 'folder', folder: {} });
    }));
    const date = new Date(2026, 9, 23);
    expect(await getNextOneDriveExportFilename('export-fixture', ['Fixture'], date, undefined, 'zip')).toBe('Fixture_2026.10.23_4.zip');
    expect(await getNextOneDriveExportFilename('export-fixture', ['Fixture'], date)).toBe('Fixture_2026.10.23_9.pdf');
  });

  it('uploads the ZIP with its MIME type and preserves the existing PDF uploader', async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>(async () => Response.json({ id: 'folder', folder: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const blob = new Blob(['fixture']);
    await uploadReportToOneDrive('zip-export-fixture', 'Areas.zip', blob, 'Fixture', 'zip');
    await uploadPdfToOneDrive('pdf-export-fixture', 'Report.pdf', blob, 'Fixture');
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(new Headers(writes[0][1]?.headers).get('Content-Type')).toBe('application/zip');
    expect(new Headers(writes[1][1]?.headers).get('Content-Type')).toBe('application/pdf');
    expect(writes[0][1]?.body).toBe(blob);
    expect(writes[1][1]?.body).toBe(blob);
    expect(String(writes[0][0])).toContain('/Areas.zip:/content');
  });
});
