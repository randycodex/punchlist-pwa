import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createProject, createArea, createLocation, createItem, createCheckpoint } from '@/lib/db';
import { generateSelectedAreaExport } from '@/features/export/selectedAreaExport';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  // No network or live inspection records: PDFs use only this disposable snapshot.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
  const project = createProject('Export fixture', '123 Sample Street', 'Inspector');
  project.areas = ['Unit A', 'Unit B', 'Unselected C', 'Empty D'].map((name, index) => {
    const area = createArea(project.id, name, index);
    if (index === 3) return area;
    const room = createLocation(area.id, `Room ${index}`, 0);
    const item = createItem(room.id, 'Walls', 0);
    const issue = createCheckpoint(item.id, `Issue ${index}`, 0);
    issue.status = 'needsReview';
    issue.issueState = 'open';
    issue.comments = `UniqueIssue${index}`;
    const okay = createCheckpoint(item.id, `Reviewed ${index}`, 1);
    okay.status = 'ok';
    okay.comments = `UniqueReviewed${index}`;
    item.checkpoints.push(issue, okay); room.items.push(item); area.locations.push(room);
    return area;
  });
  return project;
}

async function entries(blob: Blob) {
  return Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer())));
}

describe('selected area report files', () => {
  it.each(['issues', 'full'] as const)('creates real PDFs scoped to each selected area in %s mode, including empty areas', async (mode) => {
    const project = fixture();
    const before = structuredClone(project);
    const progress: string[] = [];
    const report = await generateSelectedAreaExport(project, [project.areas[1].id, project.areas[0].id, project.areas[3].id], mode, 'individual', (value) => progress.push(value));
    expect(report.extension).toBe('zip');
    expect(report.blob.type).toBe('application/zip');
    const files = await entries(report.blob);
    expect(files).toHaveLength(3);
    for (const [index, [name, data]] of files.entries()) {
      const areaIndex = [1, 0, 3][index];
      expect(name).toContain(['Unit_B', 'Unit_A', 'Empty_D'][index]);
      const pdf = strFromU8(data);
      expect(pdf.startsWith('%PDF-')).toBe(true);
      if (areaIndex === 3) {
        expect(pdf).toContain('Empty D');
        expect(pdf).toContain(mode === 'issues' ? 'No issues recorded.' : 'No checklist content recorded.');
      } else {
        expect(pdf).toContain(`UniqueIssue${areaIndex}`);
        expect(pdf.includes(`UniqueReviewed${areaIndex}`)).toBe(mode === 'full');
      }
      expect(pdf).not.toContain('UniqueIssue2');
      expect(pdf).not.toContain(`UniqueIssue${areaIndex === 0 ? 1 : 0}`);
    }
    expect(progress).toContain('Creating PDF 2 of 3: Unit A');
    expect(progress.at(-1)).toBe('Finishing ZIP…');
    expect(project).toEqual(before);
  });

  it('retains combined PDF output with only the selected areas', async () => {
    const project = fixture();
    const report = await generateSelectedAreaExport(project, project.areas.slice(0, 2).map((area) => area.id), 'full', 'combined');
    expect(report.filename).toMatch(/_Selected_Areas_\d{4}\.\d{2}\.\d{2}\.pdf$/);
    expect(report.blob.type).toBe('application/pdf');
    const pdf = await report.blob.text();
    expect(pdf).toContain('UniqueIssue0');
    expect(pdf).toContain('UniqueReviewed1');
    expect(pdf).not.toContain('UniqueIssue2');
  });

  it('keeps colliding and unsafe area names in separate, portable ZIP entries', async () => {
    const project = fixture();
    project.projectName = '../../A:/\\Project';
    project.areas[0].name = 'Unit A';
    project.areas[1].name = 'unit a';
    project.areas[2].name = '../Unit A';
    project.areas[3].name = 'x'.repeat(400);
    const ids = project.areas.map((area) => area.id);
    const report = await generateSelectedAreaExport(project, [...ids, ids[0]], 'issues', 'individual');
    const files = await entries(report.blob);
    expect(files).toHaveLength(4);
    expect(new Set(files.map(([name]) => name.toLowerCase())).size).toBe(4);
    expect(files[1][0]).toMatch(/_2.pdf$/);
    expect(files[2][0]).toMatch(/_3.pdf$/);
    for (const [name] of files) {
      expect(name).not.toMatch(/[\\/:]/);
      expect(name.length).toBeLessThan(240);
    }
  });

  it.each(['combined', 'individual'] as const)('rejects empty, removed and deleted selections for %s instead of exporting extra areas', async (format) => {
    const project = fixture();
    project.areas[1].deletedAt = new Date();
    await expect(generateSelectedAreaExport(project, [], 'full', format)).rejects.toThrow('Select at least one');
    await expect(generateSelectedAreaExport(project, ['missing'], 'full', format)).rejects.toThrow('no longer available');
    await expect(generateSelectedAreaExport(project, [project.areas[1].id], 'full', format)).rejects.toThrow('no longer available');
  });
});
