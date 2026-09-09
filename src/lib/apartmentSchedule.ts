import type { ApartmentUnitType } from './areas';

export const MIN_BULK_APARTMENT_UNITS = 2;
export const MAX_BULK_APARTMENT_UNITS = 5000;
type ParsedBulkApartmentUnit = { unitType: ApartmentUnitType | ''; areaNumber: string };
type BulkApartmentScheduleParseResult =
  | { units: ParsedBulkApartmentUnit[]; error: '' }
  | { units: []; error: string };

function normalizeApartmentUnitType(value: string): ApartmentUnitType | '' {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (['EFF', 'EFFICIENCY', 'STUDIO'].includes(normalized)) return 'EFF';
  if (['0BR', '0BED', '0BEDROOM'].includes(normalized)) return '0BR';
  if (['DORM', 'DORMITORY'].includes(normalized)) return 'Dorm';
  if (['1BR', '1BED', '1BEDROOM'].includes(normalized)) return '1BR';
  if (['2BR', '2BED', '2BEDROOM'].includes(normalized)) return '2BR';
  if (['3BR', '3BED', '3BEDROOM'].includes(normalized)) return '3BR';
  if (['4BR', '4BED', '4BEDROOM'].includes(normalized)) return '4BR';
  return '';
}

function parseDelimitedScheduleLine(line: string): string[] {
  if (line.includes('\t')) {
    return line.split('\t').map((cell) => cell.trim());
  }

  if (!line.includes(',')) {
    return line.trim().split(/\s{2,}/).map((cell) => cell.trim());
  }

  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isBulkScheduleHeader(cells: string[]): boolean {
  const normalizedCells = cells.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const hasTypeHeader = normalizedCells.some((cell) => cell.includes('type'));
  const hasNumberHeader = normalizedCells.some((cell) =>
    ['name', 'unit', 'unitnumber', 'apartment', 'apartmentnumber', 'number'].includes(cell)
  );
  return hasTypeHeader && hasNumberHeader;
}

export function parseBulkApartmentSchedule(text: string): BulkApartmentScheduleParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const units: ParsedBulkApartmentUnit[] = [];
  let headerColumns: { number: number; type: number } | undefined;
  const firstContentRows = lines.map(parseDelimitedScheduleLine)
    .map((cells, index) => ({ cells, index }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()));
  const titleIndex = firstContentRows[0]?.cells.filter(Boolean).length === 1 &&
    firstContentRows[1] && isBulkScheduleHeader(firstContentRows[1].cells)
    ? firstContentRows[0].index : -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    const cells = parseDelimitedScheduleLine(line);
    if (index === titleIndex || !cells.some(Boolean)) continue;
    if (isBulkScheduleHeader(cells)) {
      const normalized = cells.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ''));
      headerColumns = {
        number: normalized.findIndex((cell) => ['name', 'unit', 'unitnumber', 'apartment', 'apartmentnumber', 'number'].includes(cell)),
        type: normalized.findIndex((cell) => cell.includes('type')),
      };
      continue;
    }
    if (/^grand total\s*:\s*\d+$/i.test(cells[0]) && cells.slice(1).every((cell) => !cell)) continue;

    const typedCells = cells
      .map((cell, cellIndex) => ({ cellIndex, unitType: normalizeApartmentUnitType(cell) }))
      .filter((entry) => entry.unitType && (!headerColumns || entry.cellIndex === headerColumns.type));
    if (typedCells.length !== 1) {
      return {
        units: [],
        error: `Line ${index + 1} needs one unit type: EFF, 0BR, Dorm, 1BR, 2BR, 3BR, or 4BR.`,
      };
    }

    const typedCell = typedCells[0];
    const rawNumber = headerColumns
      ? cells[headerColumns.number] ?? ''
      : cells.find((cell, cellIndex) => cellIndex !== typedCell.cellIndex && cell.trim()) ?? '';
    const areaNumber = rawNumber.replace(/^UNIT\s+/i, '').trim();
    if (!areaNumber) {
      return { units: [], error: `Line ${index + 1} is missing a unit number.` };
    }

    units.push({ unitType: typedCell.unitType, areaNumber });
  }

  if (units.length < MIN_BULK_APARTMENT_UNITS) {
    return { units: [], error: 'Paste at least two units.' };
  }
  if (units.length > MAX_BULK_APARTMENT_UNITS) {
    return { units: [], error: `Import no more than ${MAX_BULK_APARTMENT_UNITS.toLocaleString()} units at once.` };
  }
  return { units, error: '' };
}
