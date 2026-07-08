import { jsPDF } from 'jspdf';
import { Area, Checkpoint, FacadeElevationDrawing, Item, Location, Project, checkpointHasIssue, getCheckpointIssueState } from '@/types';
import {
  buildElevationMarkerReferenceMap,
  buildElevationMarkerReferences,
  type ElevationMarkerReference,
} from '@/lib/elevationMarkers';

export type PdfExportMode = 'full' | 'issues';
export type PdfExportOptions = {
  areaIds?: Iterable<string>;
};

type ImageSize = { width: number; height: number };

type LogoAssets = {
  base64: string | null;
  width: number;
  height: number;
};

type LayoutMetrics = {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  headerHeight: number;
  footerHeight: number;
  contentTop: number;
  contentBottom: number;
  contentWidth: number;
  detailColumnGap: number;
  detailColumnsPerPage: number;
  detailColumnWidth: number;
  photoGap: number;
  photosPerRow: number;
  photoWidth: number;
  photoHeight: number;
  statusIconRadius: number;
};

type ExportProject = Omit<Project, 'areas'> & { areas: ExportArea[] };
type ExportArea = Omit<Area, 'locations'> & { locations: ExportLocation[] };
type ExportLocation = Omit<Location, 'items'> & { items: ExportItem[] };
type ExportItem = Omit<Item, 'checkpoints'> & { checkpoints: ExportCheckpoint[] };
type ExportCheckpoint = Checkpoint;

type SummaryArea = {
  areaId: string;
  areaName: string;
  createdAt?: Date | string | number;
  issueCount: number;
  sections: Array<{
    sectionId: string;
    sectionName: string;
    issueCount: number;
    entries: Array<{
      checkpointId: string;
      subItem: string;
      elevationRef: string;
      comment: string;
      photoRef: string;
    }>;
  }>;
};

let logoAssetsPromise: Promise<LogoAssets> | null = null;

async function loadLogoBase64(): Promise<string | null> {
  try {
    const response = await fetch('/uai-logo.png');
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function getImageDimensions(base64: string): Promise<ImageSize> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 1, height: 1 });
    img.src = base64;
  });
}

async function loadLogoAssetsUncached(): Promise<LogoAssets> {
  const base64 = await loadLogoBase64();
  let width = 30;
  let height = 30;

  if (base64) {
    try {
      const dims = await getImageDimensions(base64);
      const maxLogoHeight = 15;
      const aspectRatio = dims.width / dims.height;
      height = maxLogoHeight;
      width = maxLogoHeight * aspectRatio;
    } catch {
      // Keep defaults.
    }
  }

  return { base64, width, height };
}

function loadLogoAssets(): Promise<LogoAssets> {
  logoAssetsPromise ??= loadLogoAssetsUncached();
  return logoAssetsPromise;
}

function createLayout(pdf: jsPDF): LayoutMetrics {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const headerHeight = 14;
  const footerHeight = 34;
  const contentTop = margin + headerHeight;
  const contentBottom = pageHeight - margin - footerHeight;
  const contentWidth = pageWidth - margin * 2;
  const detailColumnGap = 6;
  const detailColumnsPerPage = 1;
  const detailColumnWidth = (contentWidth - detailColumnGap * (detailColumnsPerPage - 1)) / detailColumnsPerPage;
  const photoGap = 4;
  const photosPerRow = 4;
  const photoWidth = (detailColumnWidth - photoGap * (photosPerRow - 1)) / photosPerRow;
  const photoHeight = photoWidth * 1.2;

  return {
    pageWidth,
    pageHeight,
    margin,
    headerHeight,
    footerHeight,
    contentTop,
    contentBottom,
    contentWidth,
    detailColumnGap,
    detailColumnsPerPage,
    detailColumnWidth,
    photoGap,
    photosPerRow,
    photoWidth,
    photoHeight,
    statusIconRadius: 1.6,
  };
}

function sanitizeText(value: string | undefined | null) {
  return (value ?? '').trim();
}

function formatPhotoRefRange(refs: string[]) {
  if (refs.length === 0) return '';
  if (refs.length === 1) return refs[0];
  return `${refs[0]}-${refs[refs.length - 1]}`;
}

function formatDate(value: Date | string | number | undefined, withTime = false) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}

function formatAreaCreatedLabel(value: Date | string | number | undefined) {
  const createdDate = formatDate(value);
  return createdDate ? `Area created: ${createdDate}` : '';
}

function getCoverDateMetadata(project: ExportProject, forceReportDate: boolean) {
  if (!forceReportDate && project.areas.length === 1) {
    return {
      label: 'Date',
      value: formatDate(project.areas[0].createdAt) || formatDate(project.date) || 'N/A',
    };
  }

  return {
    label: 'Report Date',
    value: formatDate(new Date()) || 'N/A',
  };
}

function getGeneratedAt() {
  return formatDate(new Date(), true);
}

function fitImageSize(size: ImageSize, maxWidth: number, maxHeight: number): ImageSize {
  if (size.width <= 0 || size.height <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

async function normalizePhotoForPdf(source: string): Promise<{ src: string; size: ImageSize }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.width);
        canvas.height = Math.max(1, img.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ src: source, size: { width: img.width, height: img.height } });
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({
          src: canvas.toDataURL('image/jpeg', 0.82),
          size: { width: img.width, height: img.height },
        });
      } catch {
        resolve({ src: source, size: { width: img.width, height: img.height } });
      }
    };
    img.onerror = () => resolve({ src: source, size: { width: 1, height: 1 } });
    img.src = source;
  });
}

async function preparePdfPhotos(photos: string[]) {
  const prepared: Array<{ src: string; size: ImageSize }> = [];
  for (const photo of photos) {
    prepared.push(await normalizePhotoForPdf(photo));
  }
  return prepared;
}

function drawStatusIcon(pdf: jsPDF, checkpoint: Checkpoint, x: number, y: number, radius: number) {
  const centerY = y - 1.5;
  const issueState = getCheckpointIssueState(checkpoint);

  pdf.setLineWidth(0.35);

  if (issueState === 'open') {
    pdf.setDrawColor(239, 78, 36);
    pdf.setFillColor(239, 78, 36);
    pdf.circle(x, centerY, radius, 'F');
  } else if (issueState === 'resolved') {
    pdf.setDrawColor(217, 119, 6);
    pdf.setFillColor(217, 119, 6);
    pdf.circle(x, centerY, radius, 'F');
  } else if (issueState === 'verified') {
    pdf.setDrawColor(22, 163, 74);
    pdf.setFillColor(22, 163, 74);
    pdf.circle(x, centerY, radius, 'F');
  } else if (checkpoint.status === 'ok') {
    pdf.setDrawColor(51, 65, 85);
    pdf.circle(x, centerY, radius, 'S');
  } else {
    pdf.setDrawColor(148, 163, 184);
    pdf.circle(x, centerY, radius, 'S');
  }

  pdf.setDrawColor(0, 0, 0);
  pdf.setFillColor(0, 0, 0);
}

function addFooter(pdf: jsPDF, layout: LayoutMetrics, generatedAt: string, summaryPages: Set<number>) {
  const totalPages = pdf.getNumberOfPages();

  for (let page = 1; page <= totalPages; page += 1) {
    pdf.setPage(page);
    const footerFieldsY = layout.pageHeight - layout.margin - 10;
    const dividerY = layout.pageHeight - layout.margin - 5;
    const footerTextY = layout.pageHeight - layout.margin - 1.5;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(90, 90, 90);
    if (summaryPages.has(page)) {
      pdf.text('Date Completed by GC', layout.margin, footerFieldsY);
      pdf.line(layout.margin + 40, footerFieldsY + 0.3, layout.margin + 64, footerFieldsY + 0.3);
      pdf.text('Name', layout.margin + 68, footerFieldsY);
      pdf.line(layout.margin + 81, footerFieldsY + 0.3, layout.margin + 145, footerFieldsY + 0.3);
      pdf.text('Signature', layout.margin + 149, footerFieldsY);
      pdf.line(layout.margin + 167, footerFieldsY + 0.3, layout.pageWidth - layout.margin, footerFieldsY + 0.3);
    }

    pdf.setDrawColor(226, 232, 240);
    pdf.line(
      layout.margin,
      dividerY,
      layout.pageWidth - layout.margin,
      dividerY
    );
    pdf.setTextColor(120, 120, 120);
    pdf.text(`Generated ${generatedAt}`, layout.margin, footerTextY);
    pdf.text(`Page ${page} of ${totalPages}`, layout.pageWidth - layout.margin, footerTextY, {
      align: 'right',
    });
  }

  pdf.setTextColor(0, 0, 0);
}

function addProjectPageHeader(
  pdf: jsPDF,
  projectName: string,
  logo: LogoAssets,
  coverPage: number,
  startPage: number,
  endPage: number,
  layout: LayoutMetrics
) {
  const logoHeight = 5;
  const logoWidth = logo.height > 0 ? (logo.width / logo.height) * logoHeight : logoHeight;
  const logoY = layout.margin - 1;
  const textY = layout.margin + 3;

  for (let page = startPage; page <= endPage; page += 1) {
    if (page === coverPage) continue;

    pdf.setPage(page);
    let textX = layout.margin;

    if (logo.base64) {
      try {
        pdf.addImage(logo.base64, 'PNG', layout.margin, logoY, logoWidth, logoHeight);
        textX = layout.margin + logoWidth + 3;
      } catch {
        textX = layout.margin;
      }
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(71, 85, 105);
    pdf.text(projectName, textX, textY);
  }

  pdf.setTextColor(0, 0, 0);
}

function drawAreaHeader(pdf: jsPDF, area: Pick<ExportArea, 'name' | 'createdAt'>, y: number, layout: LayoutMetrics) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(71, 85, 105);
  pdf.text(area.name, layout.margin, y);

  const createdLabel = formatAreaCreatedLabel(area.createdAt);
  if (createdLabel) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.setTextColor(107, 114, 128);
    pdf.text(createdLabel, layout.margin, y + 5);
    pdf.setTextColor(0, 0, 0);
    return y + 12;
  }

  pdf.setTextColor(0, 0, 0);
  return y + 8;
}

function getAreaHeaderHeight(area: Pick<ExportArea, 'createdAt'>) {
  return formatDate(area.createdAt) ? 12 : 8;
}

const SECTION_GAP = 6;
const GROUP_GAP = 4;
const ITEM_GAP = 3;
const GROUP_TO_ITEM_GAP = 4.5;
const GROUP_INDENT = 5;
const ITEM_INDENT = 10;
const BODY_INDENT = 14;
const IMAGE_RADIUS = 1.8;
const ELEVATION_MIN_IMAGE_HEIGHT = 150;
const ELEVATION_MAX_IMAGE_HEIGHT = 210;

function isGeneralNotesLocation(location: Location | ExportLocation) {
  const locationName = location.name.trim().toLowerCase();
  if (locationName !== 'other') return false;
  if (location.items.length !== 1) return false;
  const item = location.items[0];
  if (item.name.trim().toLowerCase() !== 'general notes') return false;
  return item.checkpoints.length === 1 && item.checkpoints[0].name.trim().toLowerCase() === 'notes';
}

function getCheckpointNotesLines(pdf: jsPDF, checkpoint: Checkpoint, textWidth: number) {
  const notes = sanitizeText(checkpoint.comments);
  return notes ? (pdf.splitTextToSize(notes, textWidth) as string[]) : [];
}

function getCheckpointFileLines(pdf: jsPDF, checkpoint: Checkpoint, textWidth: number) {
  const fileNames = (checkpoint.files ?? []).map((file) => file.name).filter(Boolean);
  return fileNames.length > 0 ? (pdf.splitTextToSize(`Files: ${fileNames.join(', ')}`, textWidth) as string[]) : [];
}

function getCheckpointPhotoSources(checkpoint: Checkpoint) {
  return checkpoint.photos
    .map((photo) => photo.imageData || photo.thumbnail)
    .filter((photo): photo is string => Boolean(photo));
}

function getPhotoGridMetrics(layout: LayoutMetrics, availableWidth: number) {
  const photosPerRow = 3;
  const photoGap = 4;
  const photoWidth = (availableWidth - photoGap * (photosPerRow - 1)) / photosPerRow;
  const photoHeight = photoWidth * 1.18;
  const rowGap = 4;
  return { photosPerRow, photoGap, photoWidth, photoHeight, rowGap };
}

function estimatePhotoBlockHeight(photoCount: number, layout: LayoutMetrics, availableWidth: number) {
  if (photoCount === 0) return 0;
  const grid = getPhotoGridMetrics(layout, availableWidth);
  const rows = Math.ceil(photoCount / grid.photosPerRow);
  return 4 + rows * grid.photoHeight + Math.max(rows - 1, 0) * grid.rowGap + 6;
}

function estimateFirstPhotoRowHeight(photoCount: number, layout: LayoutMetrics, availableWidth: number) {
  if (photoCount === 0) return 0;
  const grid = getPhotoGridMetrics(layout, availableWidth);
  return 4 + grid.photoHeight + 1.5;
}

function estimateCheckpointIntroHeight(pdf: jsPDF, checkpoint: Checkpoint, textWidth: number) {
  const notesLines = getCheckpointNotesLines(pdf, checkpoint, textWidth);
  const fileLines = getCheckpointFileLines(pdf, checkpoint, textWidth);
  return 4.8 + notesLines.length * 3.5 + fileLines.length * 3.4;
}

function estimateCheckpointBlockHeight(pdf: jsPDF, checkpoint: Checkpoint, layout: LayoutMetrics, textWidth: number) {
  const photoCount = getCheckpointPhotoSources(checkpoint).length;
  return estimateCheckpointIntroHeight(pdf, checkpoint, textWidth) + estimatePhotoBlockHeight(photoCount, layout, textWidth) + ITEM_GAP;
}

function estimateCheckpointMinimumStartHeight(pdf: jsPDF, checkpoint: Checkpoint, layout: LayoutMetrics, textWidth: number) {
  const photoCount = getCheckpointPhotoSources(checkpoint).length;
  return estimateCheckpointIntroHeight(pdf, checkpoint, textWidth) + estimateFirstPhotoRowHeight(photoCount, layout, textWidth) + ITEM_GAP;
}

function getUniqueCheckpoints(checkpoints: ExportCheckpoint[]) {
  const seenCheckpointIds = new Set<string>();
  return checkpoints.filter((checkpoint) => {
    if (seenCheckpointIds.has(checkpoint.id)) return false;
    seenCheckpointIds.add(checkpoint.id);
    return true;
  });
}

function estimateItemBlockHeight(pdf: jsPDF, item: ExportItem, layout: LayoutMetrics) {
  let height = GROUP_TO_ITEM_GAP + 1.6;
  for (const checkpoint of item.checkpoints) {
    height += estimateCheckpointBlockHeight(pdf, checkpoint, layout, layout.detailColumnWidth - 20);
  }
  return height + 1.6;
}

function estimateLocationBlockHeight(pdf: jsPDF, location: ExportLocation, layout: LayoutMetrics) {
  let height = 7;
  for (const item of location.items) {
    height += estimateItemBlockHeight(pdf, item, layout);
  }
  return height + 3;
}

function getActiveAreas(project: Project, options?: PdfExportOptions) {
  const areaIds = options?.areaIds ? new Set(options.areaIds) : null;
  return project.areas.filter((area) => !area.deletedAt && (!areaIds || areaIds.has(area.id)));
}

function checkpointShouldRenderAsPdfIssue(checkpoint: Checkpoint) {
  return checkpoint.status === 'needsReview' && checkpointHasIssue(checkpoint);
}

function filterProjectForMode(project: Project, mode: PdfExportMode, options?: PdfExportOptions): ExportProject {
  const activeAreas = getActiveAreas(project, options);

  if (mode === 'full') {
    return {
      ...project,
      areas: activeAreas.map((area) => ({
        ...area,
        locations: area.locations.map((location) => ({
          ...location,
          items: location.items.map((item) => ({
            ...item,
            checkpoints: getUniqueCheckpoints(item.checkpoints),
          })),
        })),
      })),
    };
  }

  return {
    ...project,
    areas: activeAreas
      .map((area) => ({
        ...area,
        locations: area.locations
          .map((location) => ({
            ...location,
            items: location.items
              .map((item) => ({
                ...item,
                checkpoints: getUniqueCheckpoints(item.checkpoints).filter((checkpoint) => checkpointShouldRenderAsPdfIssue(checkpoint)),
              }))
              .filter((item) => item.checkpoints.length > 0),
          }))
          .filter((location) => location.items.length > 0),
      }))
      .filter((area) => area.locations.length > 0),
  };
}

function hasRenderableContent(project: ExportProject, mode: PdfExportMode) {
  return project.areas.some((area) => {
    const printableLocations = getPrintableLocationsForMode(area, mode);
    return printableLocations.length > 0 || (mode === 'full' && Boolean(sanitizeText(area.notes)));
  });
}

function getPrintableLocationsForMode(area: ExportArea, mode: PdfExportMode): ExportLocation[] {
  if (mode === 'full') {
    return area.locations.filter((location) => location.items.length > 0 || isGeneralNotesLocation(location));
  }

  return area.locations
    .map((location) => ({
      ...location,
      items: location.items
        .map((item) => ({
          ...item,
          checkpoints: getUniqueCheckpoints(item.checkpoints).filter((checkpoint) => checkpointShouldRenderAsPdfIssue(checkpoint)),
        }))
        .filter((item) => item.checkpoints.length > 0),
    }))
    .filter((location) => location.items.length > 0);
}

function getEmptyProjectMessage(mode: PdfExportMode) {
  return mode === 'issues' ? 'No issues recorded.' : 'No checklist content recorded.';
}

function getProjectIssueSummary(project: Project) {
  const activeAreas = getActiveAreas(project);
  let totalIssues = 0;
  const areasWithIssues = new Set<string>();
  const areas: SummaryArea[] = [];

  for (const area of activeAreas) {
    let areaIssueCount = 0;
    const sections: Array<{
      sectionId: string;
      sectionName: string;
      issueCount: number;
      entries: Array<{
        checkpointId: string;
        subItem: string;
        elevationRef: string;
        comment: string;
        photoRef: string;
      }>;
    }> = [];

    for (const location of area.locations) {
      let sectionIssueCount = 0;
      const entries: Array<{
        checkpointId: string;
        subItem: string;
        elevationRef: string;
        comment: string;
        photoRef: string;
      }> = [];
      const elevationRefsByCheckpoint = buildElevationMarkerReferenceMap(area, {
        drawingId: area.elevationDrawingId,
        issuesOnly: true,
      });

      for (const item of location.items) {
        for (const checkpoint of getUniqueCheckpoints(item.checkpoints)) {
          if (!checkpointShouldRenderAsPdfIssue(checkpoint)) continue;
          totalIssues += 1;
          areaIssueCount += 1;
          sectionIssueCount += 1;
          areasWithIssues.add(area.id);

          entries.push({
            checkpointId: checkpoint.id,
            subItem: `${item.name} - ${checkpoint.name}`,
            elevationRef: elevationRefsByCheckpoint.get(checkpoint.id)?.markerKey ?? '',
            comment: sanitizeText(checkpoint.comments),
            photoRef: '',
          });
        }
      }

      if (sectionIssueCount > 0) {
        sections.push({
          sectionId: location.id,
          sectionName: location.name,
          issueCount: sectionIssueCount,
          entries,
        });
      }
    }

    if (areaIssueCount > 0) {
      areas.push({
        areaId: area.id,
        areaName: area.name,
        createdAt: area.createdAt,
        issueCount: areaIssueCount,
        sections,
      });
    }
  }

  return {
    totalIssues,
    totalAreasInspected: activeAreas.length,
    totalAreasWithIssues: areasWithIssues.size,
    areas,
  };
}

function buildAreaPhotoReferenceData(area: ExportArea) {
  const checkpointPhotoRefs = new Map<string, string[]>();
  let nextPhotoNumber = 1;

  for (const location of area.locations) {
    for (const item of location.items) {
      for (const checkpoint of getUniqueCheckpoints(item.checkpoints)) {
        if (!checkpointShouldRenderAsPdfIssue(checkpoint)) continue;
        const photoCount = getCheckpointPhotoSources(checkpoint).length;
        if (photoCount === 0) continue;

        const refs = Array.from({ length: photoCount }, () => `P${nextPhotoNumber++}`);
        checkpointPhotoRefs.set(checkpoint.id, refs);
      }
    }
  }

  return { checkpointPhotoRefs };
}

function renderCoverPage(
  pdf: jsPDF,
  project: ExportProject,
  mode: PdfExportMode,
  logo: LogoAssets,
  layout: LayoutMetrics,
  forceReportDate = false
) {
  let y = 20;
  const logoX = layout.margin;
  let titleX = layout.margin;
  let contentTopY = y;
  let logoCenterY = y;

  if (logo.base64) {
    try {
      contentTopY = y - 2;
      pdf.addImage(logo.base64, 'PNG', logoX, contentTopY, logo.width, logo.height);
      titleX = logoX + logo.width + 6;
      logoCenterY = contentTopY + logo.height / 2;
    } catch {
      titleX = layout.margin;
    }
  }

  const coverDate = getCoverDateMetadata(project, forceReportDate);
  const metadata = [
    sanitizeText(project.address) ? `Address: ${sanitizeText(project.address)}` : '',
    sanitizeText(project.inspector) ? `Inspector: ${sanitizeText(project.inspector)}` : '',
    `${coverDate.label}: ${coverDate.value}`,
    sanitizeText(project.gcName) ? `GC: ${sanitizeText(project.gcName)}` : '',
  ].filter(Boolean);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.setTextColor(71, 85, 105);
  const titleLines = pdf.splitTextToSize(`${project.projectName} | PUNCHLIST`, layout.pageWidth - titleX - layout.margin) as string[];

  pdf.setFontSize(8.75);
  const metadataLine = metadata.join(' | ');
  const metadataLines = pdf.splitTextToSize(metadataLine, layout.pageWidth - titleX - layout.margin) as string[];

  const titleBlockHeight = titleLines.length * 6.5;
  const metadataBlockHeight = metadataLines.length > 0 ? metadataLines.length * 4.5 : 0;
  const interBlockGap = metadataLines.length > 0 ? 2 : 0;
  const textBlockHeight = titleBlockHeight + interBlockGap + metadataBlockHeight;
  const titleBaselineY = logo.base64
    ? logoCenterY - textBlockHeight / 2 + 5.5
    : contentTopY + 5.5;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text(titleLines, titleX, titleBaselineY);
  y = titleBaselineY + titleBlockHeight - 1.5;

  if (metadataLines.length > 0) {
    pdf.setFontSize(8.75);
    pdf.text(metadataLines, titleX, y + interBlockGap);
    y += interBlockGap + metadataBlockHeight;
  }

  y += 4;
  pdf.setDrawColor(226, 232, 240);
  pdf.line(layout.margin, y, layout.pageWidth - layout.margin, y);
  y += 4;
  pdf.setTextColor(0, 0, 0);

  return y + 4;
}

function renderIntroPages(
  pdf: jsPDF,
  project: ExportProject,
  mode: PdfExportMode,
  logo: LogoAssets,
  layout: LayoutMetrics,
  forceReportDate = false
) {
  return renderCoverPage(pdf, project, mode, logo, layout, forceReportDate);
}

function renderEmptyIssuesMessage(pdf: jsPDF, layout: LayoutMetrics, startY: number, message: string) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text(message, layout.margin, startY);
  pdf.setTextColor(0, 0, 0);
}

function getAreaSummaryColumns(layout: LayoutMetrics) {
  const tableWidth = layout.contentWidth;
  const sectionColumnWidth = 28;
  const keyColumnWidth = 12;
  const photoColumnWidth = 18;
  const countColumnWidth = 14;
  const detailsWidth = tableWidth - sectionColumnWidth - keyColumnWidth - photoColumnWidth - countColumnWidth - 6;
  const subItemColumnWidth = Math.max(38, detailsWidth * 0.5);
  const commentsColumnWidth = Math.max(28, detailsWidth - subItemColumnWidth);
  return { tableWidth, sectionColumnWidth, keyColumnWidth, subItemColumnWidth, commentsColumnWidth, photoColumnWidth };
}

function getSelectedAreasSummaryColumns(layout: LayoutMetrics) {
  const tableWidth = layout.contentWidth;
  const areaColumnWidth = 34;
  const createdColumnWidth = 22;
  const sectionColumnWidth = 22;
  const keyColumnWidth = 11;
  const photoColumnWidth = 17;
  const countColumnWidth = 12;
  const detailsWidth = tableWidth - areaColumnWidth - createdColumnWidth - sectionColumnWidth - keyColumnWidth - photoColumnWidth - countColumnWidth - 6;
  const subItemColumnWidth = Math.max(32, detailsWidth * 0.46);
  const commentsColumnWidth = Math.max(30, detailsWidth - subItemColumnWidth);

  return {
    tableWidth,
    areaColumnWidth,
    createdColumnWidth,
    sectionColumnWidth,
    keyColumnWidth,
    subItemColumnWidth,
    commentsColumnWidth,
    photoColumnWidth,
    countColumnWidth,
  };
}

function estimateAreaSummaryHeight(pdf: jsPDF, areaSummary: SummaryArea | undefined, layout: LayoutMetrics) {
  if (!areaSummary || areaSummary.sections.length === 0) return 0;

  const { keyColumnWidth, subItemColumnWidth, commentsColumnWidth, photoColumnWidth } = getAreaSummaryColumns(layout);
  return 6 + 5 + areaSummary.sections.reduce((total, section) => {
    const entryLines = section.entries.reduce((linesTotal, entry) => {
      const keyLines = entry.elevationRef
        ? (pdf.splitTextToSize(entry.elevationRef, keyColumnWidth - 1) as string[])
        : [];
      const subItemLines = pdf.splitTextToSize(entry.subItem, subItemColumnWidth - 2) as string[];
      const commentLines = entry.comment
        ? (pdf.splitTextToSize(entry.comment, commentsColumnWidth - 2) as string[])
        : [];
      const photoRefLines = entry.photoRef
        ? (pdf.splitTextToSize(entry.photoRef, photoColumnWidth - 1) as string[])
        : [];
      return linesTotal + Math.max(1, keyLines.length, subItemLines.length, commentLines.length, photoRefLines.length);
    }, 0);
    return total + Math.max(6.5, entryLines * 4.1 + 1.5) + 3;
  }, 0) + 3;
}

function getAreaSummaryRowHeight(
  pdf: jsPDF,
  section: SummaryArea['sections'][number],
  keyColumnWidth: number,
  subItemColumnWidth: number,
  commentsColumnWidth: number,
  photoColumnWidth: number
) {
  const entryLines = section.entries.reduce((linesTotal, entry) => {
    const keyLines = entry.elevationRef
      ? (pdf.splitTextToSize(entry.elevationRef, keyColumnWidth - 1) as string[])
      : [];
    const subItemLines = pdf.splitTextToSize(entry.subItem, subItemColumnWidth - 2) as string[];
    const commentLines = entry.comment
      ? (pdf.splitTextToSize(entry.comment, commentsColumnWidth - 2) as string[])
      : [];
    const photoRefLines = entry.photoRef
      ? (pdf.splitTextToSize(entry.photoRef, photoColumnWidth - 1) as string[])
      : [];
    return linesTotal + Math.max(1, keyLines.length, subItemLines.length, commentLines.length, photoRefLines.length);
  }, 0);

  return Math.max(6.5, entryLines * 4.1 + 1.5);
}

function getSelectedAreasSummaryRowHeight(
  pdf: jsPDF,
  areaSummary: SummaryArea,
  section: SummaryArea['sections'][number],
  columns: ReturnType<typeof getSelectedAreasSummaryColumns>,
  showAreaLabel: boolean
) {
  const areaLabelLines = showAreaLabel
    ? (pdf.splitTextToSize(areaSummary.areaName, columns.areaColumnWidth - 2) as string[])
    : [];
  const createdLabelLines = showAreaLabel && formatDate(areaSummary.createdAt)
    ? (pdf.splitTextToSize(formatDate(areaSummary.createdAt), columns.createdColumnWidth - 2) as string[])
    : [];
  const sectionLines = pdf.splitTextToSize(section.sectionName, columns.sectionColumnWidth - 2) as string[];
  const entryLines = section.entries.reduce((linesTotal, entry) => {
    const keyLines = entry.elevationRef
      ? (pdf.splitTextToSize(entry.elevationRef, columns.keyColumnWidth - 1) as string[])
      : [];
    const subItemLines = pdf.splitTextToSize(entry.subItem, columns.subItemColumnWidth - 2) as string[];
    const commentLines = entry.comment
      ? (pdf.splitTextToSize(entry.comment, columns.commentsColumnWidth - 2) as string[])
      : [];
    const photoRefLines = entry.photoRef
      ? (pdf.splitTextToSize(entry.photoRef, columns.photoColumnWidth - 2) as string[])
      : [];
    return linesTotal + Math.max(1, keyLines.length, subItemLines.length, commentLines.length, photoRefLines.length);
  }, 0);

  return Math.max(
    7,
    areaLabelLines.length * 3.8,
    createdLabelLines.length * 3.8,
    sectionLines.length * 3.8,
    entryLines * 4.1 + 1.5
  );
}

function renderAreaSummaryTableHeader(
  pdf: jsPDF,
  layout: LayoutMetrics,
  y: number
) {
  const { tableWidth, sectionColumnWidth, keyColumnWidth, subItemColumnWidth, commentsColumnWidth } = getAreaSummaryColumns(layout);
  const areaX = layout.margin + 0.5;
  const keyX = areaX + sectionColumnWidth;
  const itemX = keyX + keyColumnWidth;
  const commentsX = itemX + subItemColumnWidth;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.8);
  pdf.text('AREA', areaX, y);
  pdf.text('KEY', keyX, y);
  pdf.text('INSPECTED ITEM', itemX, y);
  pdf.text('COMMENTS', commentsX, y);
  pdf.text('PHOTOS', commentsX + commentsColumnWidth, y);
  pdf.text('ISSUES QTY', layout.margin + tableWidth - 1, y, { align: 'right' });

  return y + 5;
}

function renderSelectedAreasSummaryTableHeader(
  pdf: jsPDF,
  layout: LayoutMetrics,
  y: number
) {
  const {
    tableWidth,
    areaColumnWidth,
    createdColumnWidth,
    sectionColumnWidth,
    keyColumnWidth,
    subItemColumnWidth,
    commentsColumnWidth,
  } = getSelectedAreasSummaryColumns(layout);

  const areaX = layout.margin + 0.5;
  const createdX = areaX + areaColumnWidth;
  const sectionX = createdX + createdColumnWidth;
  const keyX = sectionX + sectionColumnWidth;
  const itemX = keyX + keyColumnWidth;
  const commentsX = itemX + subItemColumnWidth;
  const photosX = commentsX + commentsColumnWidth;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.2);
  pdf.text('AREA', areaX, y);
  pdf.text('CREATED', createdX, y);
  pdf.text('LEVEL', sectionX, y);
  pdf.text('KEY', keyX, y);
  pdf.text('INSPECTED ITEM', itemX, y);
  pdf.text('COMMENTS', commentsX, y);
  pdf.text('PHOTOS', photosX, y);
  pdf.text('QTY', layout.margin + tableWidth - 1, y, { align: 'right' });

  return y + 5;
}

function renderSelectedAreasSummaryBlock(
  pdf: jsPDF,
  projectSummary: ReturnType<typeof getProjectIssueSummary>,
  layout: LayoutMetrics,
  startY: number,
  startSummaryPage: () => number
) {
  if (projectSummary.areas.length <= 1) {
    return startY;
  }

  const columns = getSelectedAreasSummaryColumns(layout);
  const {
    tableWidth,
    areaColumnWidth,
    createdColumnWidth,
    sectionColumnWidth,
    keyColumnWidth,
    subItemColumnWidth,
    commentsColumnWidth,
  } = columns;
  let y = startY;

  const renderTitle = (continued = false) => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(71, 85, 105);
    pdf.text(
      continued ? 'Selected Areas Summary (continued)' : `Selected Areas Summary (${projectSummary.areas.length} areas)`,
      layout.margin,
      y
    );
    y += 5;
    y = renderSelectedAreasSummaryTableHeader(pdf, layout, y);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.4);
    pdf.setTextColor(55, 65, 81);
  };

  renderTitle(false);

  for (const areaSummary of projectSummary.areas) {
    let areaLabelPending = true;
    for (const section of areaSummary.sections) {
      const rowHeight = getSelectedAreasSummaryRowHeight(pdf, areaSummary, section, columns, areaLabelPending);
      if (y + rowHeight > layout.contentBottom) {
        y = startSummaryPage();
        renderTitle(true);
      }

      const areaX = layout.margin + 0.5;
      const createdX = areaX + areaColumnWidth;
      const sectionX = createdX + createdColumnWidth;
      const keyX = sectionX + sectionColumnWidth;
      const itemX = keyX + keyColumnWidth;
      const commentsX = itemX + subItemColumnWidth;
      const photosX = commentsX + commentsColumnWidth;
      const countX = layout.margin + tableWidth - 1;
      const rowTextY = y;

      if (areaLabelPending) {
        const areaLines = pdf.splitTextToSize(areaSummary.areaName, areaColumnWidth - 2) as string[];
        pdf.text(areaLines, areaX, rowTextY);
        const createdDate = formatDate(areaSummary.createdAt);
        if (createdDate) {
          const createdLines = pdf.splitTextToSize(createdDate, createdColumnWidth - 2) as string[];
          pdf.text(createdLines, createdX, rowTextY);
        }
      }

      const sectionLines = pdf.splitTextToSize(section.sectionName, sectionColumnWidth - 2) as string[];
      pdf.text(sectionLines, sectionX, rowTextY);

      let entryY = rowTextY;
      for (const entry of section.entries) {
        const keyLines = entry.elevationRef
          ? (pdf.splitTextToSize(entry.elevationRef, keyColumnWidth - 1) as string[])
          : [];
        const subItemLines = pdf.splitTextToSize(entry.subItem, subItemColumnWidth - 2) as string[];
        const commentLines = entry.comment
          ? (pdf.splitTextToSize(entry.comment, commentsColumnWidth - 2) as string[])
          : [''];
        const photoLines = entry.photoRef
          ? (pdf.splitTextToSize(entry.photoRef, columns.photoColumnWidth - 2) as string[])
          : [];
        const usedLines = Math.max(keyLines.length, subItemLines.length, commentLines.length, photoLines.length, 1);
        if (keyLines.length > 0) {
          pdf.text(keyLines, keyX, entryY);
        }
        pdf.text(subItemLines, itemX, entryY);
        if (entry.comment) {
          pdf.text(commentLines, commentsX, entryY);
        }
        if (photoLines.length > 0) {
          pdf.text(photoLines, photosX, entryY);
        }
        entryY += usedLines * 4.1;
      }

      pdf.text(String(section.issueCount), countX, rowTextY, { align: 'right' });

      y += rowHeight + 3;
      areaLabelPending = false;
    }
  }

  pdf.setTextColor(0, 0, 0);
  return y + 3;
}

function renderAreaSummaryBlock(
  pdf: jsPDF,
  areaSummary: SummaryArea | undefined,
  layout: LayoutMetrics,
  startY: number,
  startSummaryPage: () => number
) {
  if (!areaSummary || areaSummary.sections.length === 0) {
    return startY;
  }

  const { tableWidth, sectionColumnWidth, keyColumnWidth, subItemColumnWidth, commentsColumnWidth, photoColumnWidth } = getAreaSummaryColumns(layout);
  let y = startY;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Area Summary', layout.margin, y);
  y += 5;
  y = renderAreaSummaryTableHeader(pdf, layout, y);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.1);
  pdf.setTextColor(55, 65, 81);

  for (const section of areaSummary.sections) {
    const rowHeight = getAreaSummaryRowHeight(
      pdf,
      section,
      keyColumnWidth,
      subItemColumnWidth,
      commentsColumnWidth,
      photoColumnWidth
    );
    if (y + rowHeight > layout.contentBottom) {
      y = startSummaryPage();
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(71, 85, 105);
      pdf.text('Area Summary (continued)', layout.margin, y);
      y += 5;
      y = renderAreaSummaryTableHeader(pdf, layout, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.1);
      pdf.setTextColor(55, 65, 81);
    }

    const rowTextY = y;
    const sectionX = layout.margin + 0.5;
    const keyX = sectionX + sectionColumnWidth;
    const subItemX = keyX + keyColumnWidth;
    const commentsX = subItemX + subItemColumnWidth;
    const photosX = commentsX + commentsColumnWidth;
    const countX = layout.margin + tableWidth - 1;

    pdf.text(section.sectionName, sectionX, rowTextY);

    let entryY = rowTextY;
    for (const entry of section.entries) {
      const keyLines = entry.elevationRef
        ? (pdf.splitTextToSize(entry.elevationRef, keyColumnWidth - 1) as string[])
        : [];
      const subItemLines = pdf.splitTextToSize(entry.subItem, subItemColumnWidth - 2) as string[];
      const commentLines = entry.comment
        ? (pdf.splitTextToSize(entry.comment, commentsColumnWidth - 2) as string[])
        : [];
      const photoRefLines = entry.photoRef
        ? (pdf.splitTextToSize(entry.photoRef, photoColumnWidth - 1) as string[])
        : [];
      const usedLines = Math.max(1, keyLines.length, subItemLines.length, commentLines.length, photoRefLines.length);

      if (keyLines.length > 0) {
        pdf.text(keyLines, keyX, entryY);
      }
      pdf.text(subItemLines, subItemX, entryY);
      if (commentLines.length > 0) {
        pdf.text(commentLines, commentsX, entryY);
      }
      if (photoRefLines.length > 0) {
        pdf.text(photoRefLines, photosX, entryY);
      }
      entryY += usedLines * 4.1;
    }

    pdf.text(String(section.issueCount), countX, rowTextY, { align: 'right' });
    y += rowHeight + 3;
  }

  pdf.setTextColor(0, 0, 0);
  return y + 2;
}

function getAreaElevationDrawing(project: ExportProject, area: ExportArea): FacadeElevationDrawing | null {
  if (area.areaTypeKey !== 'facade' || !area.elevationDrawingId) return null;
  return project.facadeElevationDrawings?.find((drawing) => drawing.id === area.elevationDrawingId) ?? null;
}

async function prepareElevationDrawingForPdf(drawing: FacadeElevationDrawing) {
  if (!drawing.mimeType.startsWith('image/')) {
    return null;
  }

  return normalizePhotoForPdf(drawing.dataUrl);
}

function drawElevationMarker(
  pdf: jsPDF,
  marker: ElevationMarkerReference,
  imageX: number,
  imageY: number,
  imageWidth: number,
  imageHeight: number
) {
  const x = imageX + (marker.xPercent / 100) * imageWidth;
  const y = imageY + (marker.yPercent / 100) * imageHeight;
  const radius = 3.1;
  const markerText = marker.markerKey.replace(/^E/, '');

  pdf.setDrawColor(255, 255, 255);
  pdf.setFillColor(239, 78, 36);
  pdf.setLineWidth(0.45);
  pdf.circle(x, y, radius, 'FD');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(markerText.length > 1 ? 4.8 : 5.6);
  pdf.setTextColor(255, 255, 255);
  pdf.text(markerText, x, y + 1.45, { align: 'center' });
  pdf.setTextColor(0, 0, 0);
}

async function renderAreaElevationReferenceBlock(
  pdf: jsPDF,
  project: ExportProject,
  area: ExportArea,
  layout: LayoutMetrics,
  startY: number,
  startAreaPage: () => number
) {
  const drawing = getAreaElevationDrawing(project, area);
  if (!drawing) return startY;

  let y = startY + 4;
  const titleBlockHeight = 8;
  const remainingImageHeight = layout.contentBottom - (y + titleBlockHeight) - 9;
  if (remainingImageHeight < ELEVATION_MIN_IMAGE_HEIGHT) {
    y = startAreaPage() + 2;
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Elevation Reference', layout.margin, y);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.8);
  pdf.setTextColor(107, 114, 128);
  pdf.text(drawing.name || drawing.fileName, layout.margin, y + 4.2);
  y += 8;

  const markerReferences = buildElevationMarkerReferences(area, {
    drawingId: drawing.id,
    issuesOnly: true,
  });
  const preparedDrawing = await prepareElevationDrawingForPdf(drawing);

  if (!preparedDrawing) {
    const placeholderHeight = 26;
    pdf.setDrawColor(203, 213, 225);
    pdf.setFillColor(248, 250, 252);
    pdf.roundedRect(layout.margin, y, layout.contentWidth, placeholderHeight, 2, 2, 'FD');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.2);
    pdf.setTextColor(71, 85, 105);
    pdf.text('Elevation drawing preview is available in the app.', layout.margin + 4, y + 10);
    pdf.text(drawing.fileName, layout.margin + 4, y + 16);
    pdf.setTextColor(0, 0, 0);
    return y + placeholderHeight + 5;
  }

  const availableHeight = Math.max(
    46,
    Math.min(ELEVATION_MAX_IMAGE_HEIGHT, layout.contentBottom - y - 9)
  );
  const fitted = fitImageSize(preparedDrawing.size, layout.contentWidth, availableHeight);
  const imageX = layout.margin + (layout.contentWidth - fitted.width) / 2;
  const imageY = y;

  try {
    pdf.addImage(preparedDrawing.src, 'JPEG', imageX, imageY, fitted.width, fitted.height);
  } catch {
    pdf.setFillColor(229, 231, 235);
    pdf.roundedRect(imageX, imageY, fitted.width, fitted.height, IMAGE_RADIUS, IMAGE_RADIUS, 'F');
  }

  for (const marker of markerReferences) {
    drawElevationMarker(pdf, marker, imageX, imageY, fitted.width, fitted.height);
  }

  y += fitted.height + 4;

  if (markerReferences.length > 0 && y + 4 <= layout.contentBottom) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.3);
    pdf.setTextColor(107, 114, 128);
    pdf.text('Elevation keys match the Area Summary KEY column.', layout.margin, y);
    y += 4.5;
  }

  pdf.setTextColor(0, 0, 0);
  return y + 2;
}

function renderPhotos(
  pdf: jsPDF,
  photos: Array<{ src: string; size: ImageSize }>,
  photoRefs: string[],
  startX: number,
  startY: number,
  layout: LayoutMetrics,
  availableWidth: number
) {
  const grid = getPhotoGridMetrics(layout, availableWidth);
  const y = startY + 4;

  for (let index = 0; index < photos.length; index += 1) {
    const col = index % grid.photosPerRow;
    const row = Math.floor(index / grid.photosPerRow);
    const x = startX + col * (grid.photoWidth + grid.photoGap);
    const imageY = y + row * (grid.photoHeight + grid.rowGap);
    const ref = photoRefs[index];
    const fitted = fitImageSize(photos[index]?.size ?? { width: 1, height: 1 }, grid.photoWidth, grid.photoHeight);
    const imageX = x + (grid.photoWidth - fitted.width) / 2;
    const fittedY = imageY;

    if (ref) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7.2);
      pdf.setTextColor(71, 85, 105);
      pdf.text(ref, x, imageY - 1.2);
      pdf.setTextColor(0, 0, 0);
    }

    try {
      pdf.addImage(photos[index].src, 'JPEG', imageX, fittedY, fitted.width, fitted.height);
    } catch {
      pdf.setFillColor(229, 231, 235);
      pdf.roundedRect(x, imageY, grid.photoWidth, grid.photoHeight, IMAGE_RADIUS, IMAGE_RADIUS, 'F');
    }
  }

  const rows = Math.ceil(photos.length / grid.photosPerRow);
  return y + rows * grid.photoHeight + Math.max(rows - 1, 0) * grid.rowGap + 1.5;
}

async function renderCheckpointBlock(
  pdf: jsPDF,
  checkpoint: ExportCheckpoint,
  photoRefs: string[],
  startX: number,
  y: number,
  layout: LayoutMetrics,
  startCheckpointPage: () => number
) {
  const textWidth = layout.contentWidth - BODY_INDENT - 2;
  const noteLines = getCheckpointNotesLines(pdf, checkpoint, textWidth);
  const fileLines = getCheckpointFileLines(pdf, checkpoint, textWidth);
  const photos = await preparePdfPhotos(getCheckpointPhotoSources(checkpoint));
  const itemX = startX + ITEM_INDENT;
  const bodyX = startX + BODY_INDENT;
  const availableWidth = layout.contentWidth - BODY_INDENT - 2;

  const renderCheckpointPrefix = (prefixY: number) => {
    let nextY = prefixY;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    drawStatusIcon(pdf, checkpoint, itemX, nextY, layout.statusIconRadius);
    pdf.text(checkpoint.name, itemX + 4, nextY);
    nextY += 4;

    if (noteLines.length > 0) {
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(8);
      pdf.setTextColor(107, 114, 128);
      pdf.text(noteLines, bodyX, nextY);
      pdf.setTextColor(0, 0, 0);
      pdf.setFont('helvetica', 'normal');
      nextY += noteLines.length * 3.5;
    }

    if (fileLines.length > 0) {
      pdf.setFontSize(7.8);
      pdf.setTextColor(100, 100, 100);
      pdf.text(fileLines, bodyX, nextY);
      pdf.setTextColor(0, 0, 0);
      nextY += fileLines.length * 3.3;
    }

    return nextY;
  };

  y = renderCheckpointPrefix(y);

  if (photos.length > 0) {
    const grid = getPhotoGridMetrics(layout, availableWidth);
    const minPhotoBlockHeight = 5 + grid.photoHeight + 1.5;
    const rowUnit = grid.photoHeight + grid.rowGap;
    let photoIndex = 0;

    while (photoIndex < photos.length) {
      if (layout.contentBottom - y < minPhotoBlockHeight) {
        y = renderCheckpointPrefix(startCheckpointPage());
      }

      const remainingRowsCapacity = Math.max(
        1,
        Math.floor((layout.contentBottom - y - 5 + grid.rowGap) / rowUnit)
      );
      const rowsLeft = Math.ceil((photos.length - photoIndex) / grid.photosPerRow);
      const rowsThisPage = Math.min(rowsLeft, remainingRowsCapacity);
      const photosThisPage = rowsThisPage * grid.photosPerRow;

      y = renderPhotos(
        pdf,
        photos.slice(photoIndex, photoIndex + photosThisPage),
        photoRefs.slice(photoIndex, photoIndex + photosThisPage),
        bodyX,
        y,
        layout,
        availableWidth
      );
      photoIndex += Math.min(photosThisPage, photos.length - photoIndex);

      if (photoIndex < photos.length) {
        y = renderCheckpointPrefix(startCheckpointPage());
      }
    }
  }

  return y + ITEM_GAP;
}

async function renderProjectDetailPages(
  pdf: jsPDF,
  project: ExportProject,
  mode: PdfExportMode,
  logo: LogoAssets,
  layout: LayoutMetrics,
  forceReportDate = false
) {
  const coverPage = pdf.getNumberOfPages();
  const startPage = coverPage;
  const projectSummary = getProjectIssueSummary(project);
  const summaryByArea = new Map(projectSummary.areas.map((area) => [area.areaId, area] as const));
  const summaryPages = new Set<number>();

  for (const area of project.areas) {
    const printableLocations = getPrintableLocationsForMode(area, mode);
    const areaSummary = summaryByArea.get(area.id);
    if (!areaSummary) continue;
    const areaPhotoRefs = buildAreaPhotoReferenceData({ ...area, locations: printableLocations });
    areaSummary.sections = areaSummary.sections.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => ({
        ...entry,
        photoRef: formatPhotoRefRange(areaPhotoRefs.checkpointPhotoRefs.get(entry.checkpointId) ?? []),
      })),
    }));
  }

  let introEndY = renderIntroPages(pdf, project, mode, logo, layout, forceReportDate);
  let firstAreaStartsOnCurrentPage = true;

  if (project.areas.length > 1 && projectSummary.areas.length > 1) {
    summaryPages.add(pdf.getCurrentPageInfo().pageNumber);
    renderSelectedAreasSummaryBlock(
      pdf,
      projectSummary,
      layout,
      introEndY,
      () => {
        pdf.addPage();
        summaryPages.add(pdf.getCurrentPageInfo().pageNumber);
        return layout.contentTop;
      }
    );
    pdf.addPage();
    introEndY = layout.contentTop;
  }

  for (const area of project.areas) {
    const hasAreaNotes = Boolean(sanitizeText(area.notes));
    if (area.locations.length === 0 && !hasAreaNotes) {
      continue;
    }

    const printableLocations = getPrintableLocationsForMode(area, mode);

    if (printableLocations.length === 0 && !(mode === 'full' && hasAreaNotes)) {
      continue;
    }

    const printableArea = { ...area, locations: printableLocations };
    const areaSummary = summaryByArea.get(area.id);
    const areaPhotoRefs = buildAreaPhotoReferenceData(printableArea);
    const areaElevationRefsByCheckpoint = buildElevationMarkerReferenceMap(printableArea, {
      drawingId: printableArea.elevationDrawingId,
      issuesOnly: true,
    });
    const getPrintableCheckpoint = (checkpoint: ExportCheckpoint): ExportCheckpoint => {
      const elevationRef = areaElevationRefsByCheckpoint.get(checkpoint.id)?.markerKey;
      return elevationRef ? { ...checkpoint, name: `${elevationRef} - ${checkpoint.name}` } : checkpoint;
    };
    const drawAreaIntro = (baseY: number, includeSummary: boolean) => {
      let y = drawAreaHeader(pdf, area, baseY, layout);
      if (hasAreaNotes) {
        const noteLines = pdf.splitTextToSize(sanitizeText(area.notes), layout.contentWidth - 2) as string[];
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(8.5);
        pdf.setTextColor(107, 114, 128);
        pdf.text(noteLines, layout.margin, y);
        pdf.setTextColor(0, 0, 0);
        y += noteLines.length * 3.8 + 3;
      }
      if (includeSummary) {
        y = renderAreaSummaryBlock(pdf, areaSummary, layout, y, () => startAreaPage(false));
      }
      return y;
    };
    const startAreaPage = (includeSummary: boolean) => {
      if (firstAreaStartsOnCurrentPage) {
        firstAreaStartsOnCurrentPage = false;
        if (includeSummary) {
          summaryPages.add(pdf.getCurrentPageInfo().pageNumber);
        }
        return drawAreaIntro(introEndY, includeSummary);
      }
      pdf.addPage();
      if (includeSummary) {
        summaryPages.add(pdf.getCurrentPageInfo().pageNumber);
      }
      return drawAreaIntro(layout.contentTop, includeSummary);
    };
    const drawLocationHeader = (name: string, y: number) => {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12);
      pdf.setTextColor(71, 85, 105);
      pdf.text(name, layout.margin, y);
      pdf.setTextColor(0, 0, 0);
      return y + 7.5;
    };

    const getFreshAreaStartY = (baseY: number, includeSummary: boolean) => {
      let freshY = baseY + getAreaHeaderHeight(area);
      if (hasAreaNotes) {
        const noteLines = pdf.splitTextToSize(sanitizeText(area.notes), layout.contentWidth - 2) as string[];
        freshY += noteLines.length * 3.8 + 3;
      }
      if (includeSummary) {
        freshY += estimateAreaSummaryHeight(pdf, areaSummary, layout);
      }
      return freshY;
    };

    let y = startAreaPage(true);
    y = await renderAreaElevationReferenceBlock(
      pdf,
      project,
      printableArea,
      layout,
      y,
      () => startAreaPage(false)
    );
    const continuedAreaStartY = getFreshAreaStartY(layout.contentTop, false);

    for (const location of printableLocations) {
      const locationHeight = estimateLocationBlockHeight(pdf, location, layout);
      const maxLocationHeightOnFreshPage = layout.contentBottom - continuedAreaStartY;
      if (locationHeight <= maxLocationHeightOnFreshPage && y + locationHeight > layout.contentBottom) {
        y = startAreaPage(false);
      }

      const firstItem = location.items[0];
      const firstItemHeight = firstItem ? estimateItemBlockHeight(pdf, firstItem, layout) : 0;
      const locationHeaderHeight = 7.5;
      const maxFirstItemHeightOnFreshPage = layout.contentBottom - (continuedAreaStartY + locationHeaderHeight);
      if (
        firstItem &&
        firstItemHeight <= maxFirstItemHeightOnFreshPage &&
        y + locationHeaderHeight + firstItemHeight > layout.contentBottom
      ) {
        y = startAreaPage(false);
      }
      if (firstItem) {
        const firstRenderedCheckpoints = mode === 'issues'
          ? getUniqueCheckpoints(firstItem.checkpoints).filter((checkpoint) => checkpointShouldRenderAsPdfIssue(checkpoint))
          : getUniqueCheckpoints(firstItem.checkpoints);
        const firstCheckpoint = firstRenderedCheckpoints[0];
        const itemHeaderHeight = GROUP_TO_ITEM_GAP + 1;
        const firstCheckpointMinimumStartHeight = firstCheckpoint
          ? estimateCheckpointMinimumStartHeight(pdf, firstCheckpoint, layout, layout.contentWidth - BODY_INDENT - 2)
          : 0;
        if (firstCheckpoint && y + locationHeaderHeight + itemHeaderHeight + firstCheckpointMinimumStartHeight > layout.contentBottom) {
          y = startAreaPage(false);
        }
      }

      y = drawLocationHeader(location.name, y);

      for (const item of location.items) {
        const renderedCheckpoints = mode === 'issues'
          ? getUniqueCheckpoints(item.checkpoints).filter((checkpoint) => checkpointShouldRenderAsPdfIssue(checkpoint))
          : getUniqueCheckpoints(item.checkpoints);
        if (renderedCheckpoints.length === 0) {
          continue;
        }

        const printableItem = { ...item, checkpoints: renderedCheckpoints };
        const itemHeight = estimateItemBlockHeight(pdf, printableItem, layout);
        const maxItemHeightOnFreshPage = layout.contentBottom - (continuedAreaStartY + locationHeaderHeight);
        const firstCheckpoint = renderedCheckpoints[0];
        const firstCheckpointMinimumStartHeight = firstCheckpoint
          ? estimateCheckpointMinimumStartHeight(pdf, firstCheckpoint, layout, layout.contentWidth - BODY_INDENT - 2)
          : 0;
        const itemHeaderHeight = GROUP_TO_ITEM_GAP + 1;
        if (itemHeight <= maxItemHeightOnFreshPage && y + itemHeight > layout.contentBottom) {
          y = startAreaPage(false);
          y = drawLocationHeader(location.name, y);
        }
        if (firstCheckpoint && y + itemHeaderHeight + firstCheckpointMinimumStartHeight > layout.contentBottom) {
          y = startAreaPage(false);
          y = drawLocationHeader(location.name, y);
        }

        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10);
        pdf.text(item.name, layout.margin + GROUP_INDENT, y);
        y += GROUP_TO_ITEM_GAP;

        const startCheckpointPage = () => {
          let nextY = startAreaPage(false);
          nextY = drawLocationHeader(location.name, nextY);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(10);
          pdf.text(item.name, layout.margin + GROUP_INDENT, nextY);
          return nextY + GROUP_TO_ITEM_GAP;
        };

        for (const checkpoint of renderedCheckpoints) {
          const textWidth = layout.contentWidth - BODY_INDENT - 2;
          const checkpointHeight = estimateCheckpointBlockHeight(pdf, checkpoint, layout, textWidth);
          const checkpointMinimumStartHeight = estimateCheckpointMinimumStartHeight(pdf, checkpoint, layout, textWidth);
          const maxCheckpointHeightOnFreshPage = layout.contentBottom - (continuedAreaStartY + locationHeaderHeight + itemHeaderHeight);
          if (
            y + checkpointMinimumStartHeight > layout.contentBottom ||
            (checkpointHeight <= maxCheckpointHeightOnFreshPage && y + checkpointHeight > layout.contentBottom)
          ) {
            y = startAreaPage(false);
            y = drawLocationHeader(location.name, y);
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(10);
            pdf.text(item.name, layout.margin + GROUP_INDENT, y);
            y += GROUP_TO_ITEM_GAP;
          }

          y = await renderCheckpointBlock(
            pdf,
            getPrintableCheckpoint(checkpoint),
            areaPhotoRefs.checkpointPhotoRefs.get(checkpoint.id) ?? [],
            layout.margin,
            y,
            layout,
            startCheckpointPage
          );
        }

        y += GROUP_GAP;
      }

      y += SECTION_GAP;
    }
  }

  addProjectPageHeader(pdf, project.projectName, logo, coverPage, startPage, pdf.getNumberOfPages(), layout);
  return summaryPages;
}

export async function generateProjectPDF(project: Project, mode: PdfExportMode = 'full', options?: PdfExportOptions): Promise<Blob> {
  const pdf = new jsPDF('p', 'mm', 'a4');
  const logo = await loadLogoAssets();
  const layout = createLayout(pdf);
  const exportProject = filterProjectForMode(project, mode, options);
  const generatedAt = getGeneratedAt();
  const forceReportDate = exportProject.areas.length !== 1;

  const summaryPages = hasRenderableContent(exportProject, mode)
    ? await renderProjectDetailPages(pdf, exportProject, mode, logo, layout, forceReportDate)
    : (() => {
        const messageY = renderCoverPage(pdf, exportProject, mode, logo, layout, forceReportDate);
        renderEmptyIssuesMessage(pdf, layout, messageY, getEmptyProjectMessage(mode));
        return new Set<number>();
      })();
  addFooter(pdf, layout, generatedAt, summaryPages);
  return pdf.output('blob');
}

export async function generateMultiProjectPDF(projects: Project[], mode: PdfExportMode = 'full'): Promise<Blob> {
  const pdf = new jsPDF('p', 'mm', 'a4');
  const logo = await loadLogoAssets();
  const layout = createLayout(pdf);
  const generatedAt = getGeneratedAt();

  const summaryPages = new Set<number>();
  let renderedProjectCount = 0;
  for (const project of projects) {
    const exportProject = filterProjectForMode(project, mode);

    if (renderedProjectCount > 0) {
      pdf.addPage();
    }

    if (hasRenderableContent(exportProject, mode)) {
      const projectSummaryPages = await renderProjectDetailPages(pdf, exportProject, mode, logo, layout, true);
      for (const page of projectSummaryPages) {
        summaryPages.add(page);
      }
    } else {
      const messageY = renderCoverPage(pdf, exportProject, mode, logo, layout, true);
      renderEmptyIssuesMessage(pdf, layout, messageY, getEmptyProjectMessage(mode));
    }

    renderedProjectCount += 1;
  }

  if (renderedProjectCount === 0) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(71, 85, 105);
    pdf.text(
      mode === 'issues'
        ? 'No issues recorded for the selected projects.'
        : 'No checklist content recorded for the selected projects.',
      layout.margin,
      layout.contentTop
    );
    pdf.setTextColor(0, 0, 0);
  }

  addFooter(pdf, layout, generatedAt, summaryPages);
  return pdf.output('blob');
}

export function downloadPDF(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
