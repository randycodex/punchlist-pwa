import { Zip, ZipPassThrough } from 'fflate';
import { generateProjectPDF, type PdfExportMode } from '@/lib/pdfExport';
import { formatDateForExport, sanitizeExportNamePart } from '@/lib/projectNaming';
import type { Project } from '@/types';

export type AreaExportFormat = 'combined' | 'individual';

/** Generate from one loaded snapshot without saving or changing inspection data. */
export async function generateSelectedAreaExport(
  project: Project,
  areaIds: string[],
  mode: PdfExportMode,
  format: AreaExportFormat,
  onProgress?: (message: string) => void,
  now = new Date(),
): Promise<{ blob: Blob; filename: string; extension: 'pdf' | 'zip' }> {
  const ids = [...new Set(areaIds)];
  const activeAreas = new Map(project.areas.filter((area) => !area.deletedAt).map((area) => [area.id, area]));
  if (!ids.length) throw new Error('Select at least one area to export.');
  const areas = ids.map((id) => {
    const area = activeAreas.get(id);
    if (!area) throw new Error('A selected area is no longer available. Select the areas again and retry.');
    return area;
  });
  const projectName = sanitizeExportNamePart(project.projectName).slice(0, 80);
  const date = formatDateForExport(now);
  if (format === 'combined') {
    onProgress?.('Creating PDF…');
    return {
      blob: await generateProjectPDF(project, mode, { areaIds: ids }),
      filename: `${projectName}_Selected_Areas_${date}.pdf`,
      extension: 'pdf',
    };
  }

  // Stream each completed PDF into the ZIP so we don't retain all PDF byte arrays.
  // Photos are already compressed; storing the PDFs avoids extra compression work.
  const parts: Blob[] = [];
  let zipError: Error | undefined;
  let finished = false;
  let byteCount = 0;
  const zip = new Zip((error, chunk, final) => {
    if (error) { zipError = error; return; }
    byteCount += chunk.byteLength;
    if (byteCount >= 0xffffffff) {
      zipError = new Error('This ZIP is too large. Select fewer areas and export again.');
      return;
    }
    parts.push(new Blob([new Uint8Array(chunk)]));
    finished = final;
  });
  if (areas.length >= 65535) throw new Error('Select fewer areas for a single ZIP export.');
  const reportName = mode === 'issues' ? 'Issues' : 'Inspection_Record';
  const usedNames = new Set<string>();
  try {
    for (const [index, area] of areas.entries()) {
      onProgress?.(`Creating PDF ${index + 1} of ${areas.length}: ${area.name}`);
      // Let the browser paint progress between reports, especially on mobile.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const base = `${projectName}_${sanitizeExportNamePart(area.name).slice(0, 80)}_${reportName}_${date}`;
      let filename = `${base}.pdf`;
      let suffix = 2;
      while (usedNames.has(filename.toLowerCase())) filename = `${base}_${suffix++}.pdf`;
      usedNames.add(filename.toLowerCase());

      const blob = await generateProjectPDF({ ...project, areas: [area] }, mode, { areaIds: [area.id] });
      const file = new ZipPassThrough(filename);
      zip.add(file);
      file.push(new Uint8Array(await blob.arrayBuffer()), true);
      if (zipError) throw zipError;
    }
    onProgress?.('Finishing ZIP…');
    zip.end();
    if (zipError) throw zipError;
    if (!finished) throw new Error('The ZIP could not be completed. Please try again.');
    return {
      blob: new Blob(parts, { type: 'application/zip' }),
      filename: `${projectName}_Selected_Areas_${reportName}_${date}.zip`,
      extension: 'zip',
    };
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
