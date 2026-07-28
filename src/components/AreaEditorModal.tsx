'use client';

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { FacadeElevationDrawing } from '@/types';
import {
  APARTMENT_UNIT_TYPES,
  AREA_TYPE_DEFINITIONS,
  FACADE_ORIENTATIONS,
  FACADE_TYPES,
  getAreaTypeDefinition,
  type AreaFormValue,
  type AreaTypeKey,
  type ApartmentUnitType,
  type FacadeOrientation,
  type FacadeType,
} from '@/lib/areas';
import { ClipboardPaste, FileText, Upload, X } from 'lucide-react';

const FACADE_LEVEL_CUSTOM_VALUE = '__custom__';
const MAX_ELEVATION_FILE_SIZE = 25 * 1024 * 1024;
const ELEVATION_FILE_ACCEPT = '.pdf,image/jpeg,image/png,image/webp,application/pdf';
const ELEVATION_FILE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MIN_BULK_APARTMENT_UNITS = 2;
const MAX_BULK_APARTMENT_UNITS = 5000;
const BULK_APARTMENT_PAGE_SIZE = 50;
const MAX_BULK_SCHEDULE_FILE_SIZE = 2 * 1024 * 1024;

function getFacadeTypeValues(value: string): string[] {
  return value.split(',').map((type) => type.trim()).filter(Boolean);
}

function getCustomFacadeType(value: string): string {
  return getFacadeTypeValues(value).find((type) => !FACADE_TYPES.includes(type as FacadeType)) ?? '';
}

type BulkApartmentUnit = {
  id: string;
  unitType: ApartmentUnitType | '';
  areaNumber: string;
};

type ParsedBulkApartmentUnit = Omit<BulkApartmentUnit, 'id'>;

type BulkApartmentScheduleParseResult =
  | { units: ParsedBulkApartmentUnit[]; error: '' }
  | { units: []; error: string };

function createBulkApartmentUnit(): BulkApartmentUnit {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    unitType: '',
    areaNumber: '',
  };
}

function createBulkApartmentUnits(count: number): BulkApartmentUnit[] {
  return Array.from({ length: count }, () => createBulkApartmentUnit());
}

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
    ['unit', 'unitnumber', 'apartment', 'apartmentnumber', 'number'].includes(cell)
  );
  return hasTypeHeader && hasNumberHeader;
}

function parseBulkApartmentSchedule(text: string): BulkApartmentScheduleParseResult {
  const lines = text.split(/\r?\n/);
  const units: ParsedBulkApartmentUnit[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const cells = parseDelimitedScheduleLine(line).filter(Boolean);
    if (isBulkScheduleHeader(cells)) continue;

    const typedCells = cells
      .map((cell, cellIndex) => ({ cellIndex, unitType: normalizeApartmentUnitType(cell) }))
      .filter((entry) => entry.unitType);
    if (typedCells.length !== 1) {
      return {
        units: [],
        error: `Line ${index + 1} needs one unit type: EFF, 0BR, Dorm, 1BR, 2BR, 3BR, or 4BR.`,
      };
    }

    const typedCell = typedCells[0];
    const areaNumber = cells.find((cell, cellIndex) => cellIndex !== typedCell.cellIndex && cell.trim())?.trim() ?? '';
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

function createElevationDrawingId() {
  return globalThis.crypto?.randomUUID?.() ?? `elevation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getDefaultDrawingName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').trim() || 'Elevation';
}

function inferElevationMimeType(file: File) {
  if (file.type) return file.type;
  return file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '';
}

function isSupportedElevationFile(file: File) {
  const mimeType = inferElevationMimeType(file);
  return ELEVATION_FILE_TYPES.has(mimeType);
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read elevation file.'));
    reader.readAsDataURL(file);
  });
}

type AreaEditorModalProps = {
  open: boolean;
  title: string;
  value: AreaFormValue;
  recentAreaTypeKeys: AreaTypeKey[];
  facadeLevelOptions?: string[];
  facadeElevationDrawings?: FacadeElevationDrawing[];
  enableFacadeLevelBatch?: boolean;
  lockAreaType?: boolean;
  onChange: (value: AreaFormValue) => void;
  onClose: () => void;
  onSubmit: (values?: AreaFormValue[]) => void;
  submitLabel: string;
};

export default function AreaEditorModal({
  open,
  title,
  value,
  recentAreaTypeKeys,
  facadeLevelOptions = [],
  facadeElevationDrawings = [],
  enableFacadeLevelBatch = false,
  lockAreaType = false,
  onChange,
  onClose,
  onSubmit,
  submitLabel,
}: AreaEditorModalProps) {
  const [levelMode, setLevelMode] = useState('');
  const [elevationError, setElevationError] = useState('');
  const [apartmentCreationMode, setApartmentCreationMode] = useState<'single' | 'multiple'>('single');
  const [bulkUnitCount, setBulkUnitCount] = useState(String(MIN_BULK_APARTMENT_UNITS));
  const [bulkApartmentUnits, setBulkApartmentUnits] = useState<BulkApartmentUnit[]>(() =>
    createBulkApartmentUnits(MIN_BULK_APARTMENT_UNITS)
  );
  const [bulkUnitPage, setBulkUnitPage] = useState(1);
  const [showBulkScheduleImport, setShowBulkScheduleImport] = useState(false);
  const [bulkScheduleText, setBulkScheduleText] = useState('');
  const [bulkScheduleError, setBulkScheduleError] = useState('');
  const [bulkScheduleStatus, setBulkScheduleStatus] = useState('');
  const [bulkFillUnitType, setBulkFillUnitType] = useState<ApartmentUnitType | ''>('');
  const [customFacadeTypeEnabled, setCustomFacadeTypeEnabled] = useState(
    () => Boolean(getCustomFacadeType(value.areaNumber))
  );
  const [customFacadeType, setCustomFacadeType] = useState(() => getCustomFacadeType(value.areaNumber));
  const elevationInputRef = useRef<HTMLInputElement | null>(null);
  const bulkScheduleFileInputRef = useRef<HTMLInputElement | null>(null);
  const orderedAreaTypes = useMemo(() => {
    const preferredOrder: AreaTypeKey[] = ['apartment_unit', 'custom'];
    const recentSet = new Set(recentAreaTypeKeys);
    const preferred = preferredOrder
      .filter((key) => !recentSet.has(key))
      .map((key) => AREA_TYPE_DEFINITIONS.find((definition) => definition.key === key))
      .filter((definition): definition is (typeof AREA_TYPE_DEFINITIONS)[number] => !!definition);
    const recent = recentAreaTypeKeys
      .map((key) => AREA_TYPE_DEFINITIONS.find((definition) => definition.key === key))
      .filter((definition): definition is (typeof AREA_TYPE_DEFINITIONS)[number] => !!definition);

    const alphabetical = [...AREA_TYPE_DEFINITIONS]
      .filter((definition) => !recentSet.has(definition.key) && !preferredOrder.includes(definition.key))
      .sort((a, b) => a.label.localeCompare(b.label));

    return [...recent, ...preferred, ...alphabetical];
  }, [recentAreaTypeKeys]);

  if (!open) return null;

  const selectedDefinition = getAreaTypeDefinition(value.areaTypeKey);
  const selectedOrientation = selectedDefinition.key === 'facade' ? (value.unitType as FacadeOrientation | '') : '';
  const selectedLevelMode = value.facadeLevel.trim()
    ? facadeLevelOptions.includes(value.facadeLevel.trim())
      ? value.facadeLevel.trim()
      : FACADE_LEVEL_CUSTOM_VALUE
    : levelMode;
  const selectedFacadeLevels = value.facadeLevel.split(',').map((level) => level.trim()).filter(Boolean);
  const selectedFacadeLevelSet = new Set(selectedFacadeLevels);
  const selectedFacadeTypes = getFacadeTypeValues(value.areaNumber);
  const matchingElevationDrawings = selectedOrientation
    ? facadeElevationDrawings.filter((drawing) => drawing.orientation === selectedOrientation)
    : [];
  const selectedStoredElevationDrawing =
    value.elevationDrawingId && !value.pendingElevationDrawing
      ? matchingElevationDrawings.find((drawing) => drawing.id === value.elevationDrawingId) ?? null
      : null;
  const selectedElevationDrawing = value.pendingElevationDrawing ?? selectedStoredElevationDrawing;
  const isBulkApartmentCreation =
    !lockAreaType && selectedDefinition.key === 'apartment_unit' && apartmentCreationMode === 'multiple';
  const normalizedBulkUnitNumbers = bulkApartmentUnits.map((unit) => unit.areaNumber.trim().toLocaleLowerCase());
  const bulkUnitNumberCounts = new Map<string, number>();
  normalizedBulkUnitNumbers.forEach((unitNumber) => {
    if (unitNumber) {
      bulkUnitNumberCounts.set(unitNumber, (bulkUnitNumberCounts.get(unitNumber) ?? 0) + 1);
    }
  });
  const duplicateBulkUnitNumbers = new Set(
    [...bulkUnitNumberCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([unitNumber]) => unitNumber)
  );
  const parsedBulkUnitCount = Number.parseInt(bulkUnitCount, 10);
  const isBulkUnitCountValid =
    Number.isInteger(parsedBulkUnitCount) &&
    parsedBulkUnitCount >= MIN_BULK_APARTMENT_UNITS &&
    parsedBulkUnitCount <= MAX_BULK_APARTMENT_UNITS &&
    parsedBulkUnitCount === bulkApartmentUnits.length;
  const hasIncompleteBulkApartmentUnits = bulkApartmentUnits.some(
    (unit) => !unit.unitType || !unit.areaNumber.trim()
  );
  const hasDuplicateBulkApartmentUnits = duplicateBulkUnitNumbers.size > 0;
  const bulkUnitPageCount = Math.max(1, Math.ceil(bulkApartmentUnits.length / BULK_APARTMENT_PAGE_SIZE));
  const activeBulkUnitPage = Math.min(bulkUnitPage, bulkUnitPageCount);
  const firstVisibleBulkUnitIndex = (activeBulkUnitPage - 1) * BULK_APARTMENT_PAGE_SIZE;
  const visibleBulkApartmentUnits = bulkApartmentUnits.slice(
    firstVisibleBulkUnitIndex,
    firstVisibleBulkUnitIndex + BULK_APARTMENT_PAGE_SIZE
  );

  function handleBulkUnitCountChange(nextValue: string) {
    const digitsOnly = nextValue.replace(/\D/g, '');
    setBulkUnitCount(digitsOnly);
    setBulkScheduleStatus('');
    const parsedCount = Number.parseInt(digitsOnly, 10);
    if (
      !Number.isInteger(parsedCount) ||
      parsedCount < MIN_BULK_APARTMENT_UNITS ||
      parsedCount > MAX_BULK_APARTMENT_UNITS
    ) {
      return;
    }

    setBulkApartmentUnits((current) => {
      if (current.length === parsedCount) return current;
      if (current.length > parsedCount) return current.slice(0, parsedCount);
      return [...current, ...createBulkApartmentUnits(parsedCount - current.length)];
    });
    setBulkUnitPage((currentPage) =>
      Math.min(currentPage, Math.max(1, Math.ceil(parsedCount / BULK_APARTMENT_PAGE_SIZE)))
    );
  }

  function updateBulkApartmentUnit(index: number, patch: Partial<Omit<BulkApartmentUnit, 'id'>>) {
    setBulkApartmentUnits((current) =>
      current.map((unit, unitIndex) => (unitIndex === index ? { ...unit, ...patch } : unit))
    );
  }

  function applyBulkApartmentSchedule(scheduleText: string) {
    setBulkScheduleText(scheduleText);
    const result = parseBulkApartmentSchedule(scheduleText);
    if (result.error) {
      setBulkScheduleError(result.error);
      setBulkScheduleStatus('');
      setShowBulkScheduleImport(true);
      return;
    }

    const importedUnits = result.units.map((unit) => ({ ...createBulkApartmentUnit(), ...unit }));
    setBulkApartmentUnits(importedUnits);
    setBulkUnitCount(String(importedUnits.length));
    setBulkUnitPage(1);
    setBulkScheduleError('');
    setBulkScheduleStatus(`Imported ${importedUnits.length.toLocaleString()} units.`);
    setShowBulkScheduleImport(false);
  }

  async function handleBulkScheduleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_BULK_SCHEDULE_FILE_SIZE) {
      setBulkScheduleError('Use a schedule file under 2 MB.');
      setBulkScheduleStatus('');
      setShowBulkScheduleImport(true);
      return;
    }

    try {
      applyBulkApartmentSchedule(await file.text());
    } catch (error) {
      console.error('Failed to read unit schedule:', error);
      setBulkScheduleError('Unable to read that schedule file.');
      setBulkScheduleStatus('');
    }
  }

  function fillBlankBulkUnitTypes(scope: 'page' | 'all') {
    if (!bulkFillUnitType) return;
    const pageStart = firstVisibleBulkUnitIndex;
    const pageEnd = pageStart + BULK_APARTMENT_PAGE_SIZE;
    setBulkApartmentUnits((current) =>
      current.map((unit, index) => {
        const isInScope = scope === 'all' || (index >= pageStart && index < pageEnd);
        return isInScope && !unit.unitType ? { ...unit, unitType: bulkFillUnitType } : unit;
      })
    );
  }

  function handleClose() {
    onClose();
  }

  function handleSubmit() {
    if (!isBulkApartmentCreation) {
      onSubmit();
      return;
    }

    if (!isBulkUnitCountValid || hasIncompleteBulkApartmentUnits || hasDuplicateBulkApartmentUnits) return;
    const forms = bulkApartmentUnits.map((unit) => ({
      ...value,
      areaTypeKey: 'apartment_unit' as const,
      unitType: unit.unitType,
      areaNumber: unit.areaNumber.trim(),
      customAreaName: '',
      facadeLevel: '',
      facadeLevelMode: '' as const,
      elevationDrawingId: '',
      pendingElevationDrawing: null,
    }));
    onSubmit(forms);
  }

  async function handleElevationFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!selectedOrientation) {
      setElevationError('Select an orientation before uploading an elevation.');
      return;
    }

    if (!isSupportedElevationFile(file)) {
      setElevationError('Upload a PDF, JPG, PNG, or WebP elevation.');
      return;
    }

    if (file.size > MAX_ELEVATION_FILE_SIZE) {
      setElevationError('Use an elevation file under 25 MB.');
      return;
    }

    try {
      const now = new Date();
      const drawing: FacadeElevationDrawing = {
        id: createElevationDrawingId(),
        orientation: selectedOrientation,
        name: getDefaultDrawingName(file.name),
        fileName: file.name,
        mimeType: inferElevationMimeType(file),
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
        createdAt: now,
        updatedAt: now,
      };
      setElevationError('');
      onChange({
        ...value,
        elevationDrawingId: drawing.id,
        pendingElevationDrawing: drawing,
      });
    } catch (error) {
      console.error('Failed to read elevation file:', error);
      setElevationError('Unable to read that elevation file.');
    }
  }

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className={`modal-panel my-4 w-full rounded-[1.9rem] p-6 ${isBulkApartmentCreation ? 'max-w-2xl' : 'max-w-md'}`}>
        <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{title}</h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
          {lockAreaType ? 'Update the label details for this area.' : 'Choose the area type and label details.'}
        </p>

        <div className="space-y-4">
          {!lockAreaType ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Area
              </label>
              <select
                value={value.areaTypeKey}
                onChange={(e) => {
                  const nextAreaType = e.target.value as AreaTypeKey;
                  const keepsFacadeFields = nextAreaType === 'facade';
                  const nextUnitType =
                    nextAreaType === 'apartment_unit'
                      ? APARTMENT_UNIT_TYPES.includes(value.unitType as ApartmentUnitType)
                        ? value.unitType
                        : ''
                      : keepsFacadeFields && FACADE_ORIENTATIONS.includes(value.unitType as FacadeOrientation)
                        ? value.unitType
                        : '';
                  const keepsElevationDrawing = keepsFacadeFields && Boolean(nextUnitType);
                  setLevelMode('');
                  setElevationError('');
                  if (nextAreaType !== 'apartment_unit') {
                    setApartmentCreationMode('single');
                  }
                  if (!keepsFacadeFields) {
                    setCustomFacadeTypeEnabled(false);
                    setCustomFacadeType('');
                  }
                  onChange({
                    ...value,
                    areaTypeKey: nextAreaType,
                    unitType: nextUnitType,
                    customAreaName: nextAreaType === 'custom' ? value.customAreaName : '',
                    areaNumber: keepsFacadeFields ? value.areaNumber : '',
                    facadeLevel: keepsFacadeFields ? value.facadeLevel : '',
                    facadeLevelMode: keepsFacadeFields
                      ? enableFacadeLevelBatch
                        ? 'yes'
                        : value.facadeLevelMode
                      : '',
                    elevationDrawingId: keepsElevationDrawing ? value.elevationDrawingId : '',
                    pendingElevationDrawing: keepsElevationDrawing ? value.pendingElevationDrawing ?? null : null,
                  });
                }}
                className="field-shell"
              >
                {orderedAreaTypes.map((definition) => (
                  <option key={definition.key} value={definition.key}>
                    {definition.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Area
              </label>
              <div className="field-shell flex items-center justify-between gap-3">
                <span>{selectedDefinition.label}</span>
                <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-semibold text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                  Locked
                </span>
              </div>
            </div>
          )}

          {!lockAreaType && selectedDefinition.key === 'apartment_unit' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Add
              </label>
              <div className="grid grid-cols-2 gap-1 rounded-[1rem] soft-control p-1 dark:bg-white/[0.04]">
                {(['single', 'multiple'] as const).map((mode) => {
                  const selected = apartmentCreationMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setApartmentCreationMode(mode)}
                      className={`rounded-[0.75rem] px-3 py-2 text-sm font-medium transition ${
                        selected
                          ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.12] dark:text-white'
                          : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
                      }`}
                      aria-pressed={selected}
                    >
                      {mode === 'single' ? 'Single unit' : 'Multiple units'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isBulkApartmentCreation && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Number of Units
                </label>
                <input
                  type="number"
                  min={MIN_BULK_APARTMENT_UNITS}
                  max={MAX_BULK_APARTMENT_UNITS}
                  inputMode="numeric"
                  value={bulkUnitCount}
                  onChange={(event) => handleBulkUnitCountChange(event.target.value)}
                  className="field-shell"
                  aria-describedby="bulk-unit-count-help"
                />
                <p id="bulk-unit-count-help" className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {isBulkUnitCountValid
                    ? `Supports large projects with up to ${MAX_BULK_APARTMENT_UNITS.toLocaleString()} units.`
                    : `Enter between ${MIN_BULK_APARTMENT_UNITS} and ${MAX_BULK_APARTMENT_UNITS.toLocaleString()} units.`}
                </p>
              </div>

              <div className="rounded-[1rem] soft-control p-3 dark:bg-white/[0.03]">
                <button
                  type="button"
                  onClick={() => {
                    setShowBulkScheduleImport((current) => !current);
                    setBulkScheduleError('');
                  }}
                  className="flex w-full items-center justify-between gap-3 text-left"
                  aria-expanded={showBulkScheduleImport}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                    <ClipboardPaste className="h-4 w-4" />
                    Paste or Import Unit Schedule
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {showBulkScheduleImport ? 'Hide' : 'Open'}
                  </span>
                </button>

                {showBulkScheduleImport && (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Paste two columns from Excel or Sheets in either order: unit number and unit type. CSV/TSV headers are allowed.
                    </p>
                    <textarea
                      value={bulkScheduleText}
                      onChange={(event) => {
                        setBulkScheduleText(event.target.value);
                        setBulkScheduleError('');
                        setBulkScheduleStatus('');
                      }}
                      className="field-shell min-h-32 resize-y font-mono text-sm"
                      placeholder={'Unit Number\tUnit Type\n101\tEFF\n102\t1BR\n103\t2BR'}
                      aria-label="Unit schedule"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => applyBulkApartmentSchedule(bulkScheduleText)}
                        disabled={!bulkScheduleText.trim()}
                        className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                      >
                        Import Pasted Rows
                      </button>
                      <button
                        type="button"
                        onClick={() => bulkScheduleFileInputRef.current?.click()}
                        className="flex items-center gap-2 rounded-xl border-0 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.06]"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Choose CSV / TSV
                      </button>
                      <input
                        ref={bulkScheduleFileInputRef}
                        type="file"
                        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                        className="hidden"
                        onChange={(event) => void handleBulkScheduleFileChange(event)}
                      />
                    </div>
                  </div>
                )}

                {bulkScheduleError && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-300">{bulkScheduleError}</p>
                )}
                {bulkScheduleStatus && (
                  <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    {bulkScheduleStatus}
                  </p>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Unit Details</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {bulkApartmentUnits.length} units
                  </span>
                </div>
                <div className="mb-3 grid gap-2 rounded-[0.9rem] soft-control p-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] dark:bg-white/[0.03]">
                  <select
                    value={bulkFillUnitType}
                    onChange={(event) => setBulkFillUnitType(event.target.value as ApartmentUnitType)}
                    className="field-shell min-w-0 px-3 py-2 text-sm"
                    aria-label="Unit type to fill"
                  >
                    <option value="">Choose type to fill</option>
                    {APARTMENT_UNIT_TYPES.map((unitType) => (
                      <option key={unitType} value={unitType}>
                        {unitType}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => fillBlankBulkUnitTypes('page')}
                    disabled={!bulkFillUnitType}
                    className="rounded-xl border-0 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                  >
                    Fill Page Blanks
                  </button>
                  <button
                    type="button"
                    onClick={() => fillBlankBulkUnitTypes('all')}
                    disabled={!bulkFillUnitType}
                    className="rounded-xl border-0 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                  >
                    Fill All Blanks
                  </button>
                </div>
                <div className="max-h-[22rem] space-y-2 overflow-y-auto rounded-[1rem] soft-control p-3 dark:bg-white/[0.03]">
                  {visibleBulkApartmentUnits.map((unit, visibleIndex) => {
                    const index = firstVisibleBulkUnitIndex + visibleIndex;
                    const normalizedNumber = unit.areaNumber.trim().toLocaleLowerCase();
                    const hasDuplicateNumber = Boolean(normalizedNumber && duplicateBulkUnitNumbers.has(normalizedNumber));
                    return (
                      <div key={unit.id} className="grid grid-cols-[2rem_minmax(0,0.85fr)_minmax(0,1.15fr)] items-center gap-2">
                        <span className="text-center text-xs font-semibold tabular-nums text-gray-400 dark:text-gray-500">
                          {index + 1}
                        </span>
                        <select
                          value={unit.unitType}
                          onChange={(event) =>
                            updateBulkApartmentUnit(index, {
                              unitType: event.target.value as ApartmentUnitType,
                            })
                          }
                          className="field-shell min-w-0 px-3"
                          aria-label={`Unit ${index + 1} type`}
                        >
                          <option value="">Type</option>
                          {APARTMENT_UNIT_TYPES.map((unitType) => (
                            <option key={unitType} value={unitType}>
                              {unitType}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={unit.areaNumber}
                          onChange={(event) =>
                            updateBulkApartmentUnit(index, { areaNumber: event.target.value })
                          }
                          className={`field-shell min-w-0 px-3 ${hasDuplicateNumber ? 'border-red-500 dark:border-red-400' : ''}`}
                          placeholder="Unit number"
                          aria-label={`Unit ${index + 1} number`}
                          aria-invalid={hasDuplicateNumber}
                        />
                      </div>
                    );
                  })}
                </div>
                {bulkUnitPageCount > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setBulkUnitPage((page) => Math.max(1, page - 1))}
                      disabled={activeBulkUnitPage === 1}
                      className="rounded-xl border-0 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                    >
                      Previous 50
                    </button>
                    <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                      Page {activeBulkUnitPage} of {bulkUnitPageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setBulkUnitPage((page) => Math.min(bulkUnitPageCount, page + 1))}
                      disabled={activeBulkUnitPage === bulkUnitPageCount}
                      className="rounded-xl border-0 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                    >
                      Next 50
                    </button>
                  </div>
                )}
                {hasDuplicateBulkApartmentUnits && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-300">
                    Each unit number must be unique in this batch.
                  </p>
                )}
              </div>
            </div>
          )}

          {selectedDefinition.requiresUnitType && !isBulkApartmentCreation && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Unit Type
              </label>
              <select
                value={value.unitType}
                onChange={(e) =>
                  onChange({
                    ...value,
                    unitType: e.target.value as ApartmentUnitType,
                  })
                }
                className="field-shell"
              >
                <option value="">Select unit type</option>
                {APARTMENT_UNIT_TYPES.map((unitType) => (
                  <option key={unitType} value={unitType}>
                    {unitType}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedDefinition.requiresOrientation && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Orientation
              </label>
              <select
                value={value.unitType}
                onChange={(e) => {
                  const nextOrientation = e.target.value as FacadeOrientation;
                  setElevationError('');
                  onChange({
                    ...value,
                    unitType: nextOrientation,
                    elevationDrawingId: '',
                    pendingElevationDrawing: null,
                  });
                }}
                className="field-shell"
              >
                <option value="">Select orientation</option>
                {FACADE_ORIENTATIONS.map((orientation) => (
                  <option key={orientation} value={orientation}>
                    {orientation}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedDefinition.requiresOrientation && enableFacadeLevelBatch && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Levels
              </label>
              {facadeLevelOptions.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 rounded-[1rem] soft-control p-3 dark:bg-white/[0.05]">
                  {facadeLevelOptions.map((level) => {
                    const selected = selectedFacadeLevelSet.has(level);
                    return (
                      <label key={level} className="flex cursor-pointer items-center gap-2 rounded-[0.75rem] px-2 py-1.5 text-sm text-gray-800 transition hover:bg-black/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.06]">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            const next = selected
                              ? selectedFacadeLevels.filter((entry) => entry !== level)
                              : [...selectedFacadeLevels, level];
                            onChange({ ...value, facadeLevelMode: 'yes', facadeLevel: next.join(',') });
                          }}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                        <span>{level}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Set a project level range first to create facade levels.
                </p>
              )}
              {facadeLevelOptions.length > 0 && selectedFacadeLevels.length === 0 && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Pick at least one floor for this facade inspection.
                </p>
              )}
            </div>
          )}

          {selectedDefinition.requiresOrientation && !enableFacadeLevelBatch && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Level
              </label>
              <select
                value={selectedLevelMode}
                onChange={(e) => {
                  setLevelMode(e.target.value);
                  onChange({
                    ...value,
                    facadeLevel:
                      e.target.value === FACADE_LEVEL_CUSTOM_VALUE
                        ? value.facadeLevel
                        : e.target.value,
                  });
                }}
                className="field-shell"
              >
                <option value="">Select level</option>
                {facadeLevelOptions.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
                <option value={FACADE_LEVEL_CUSTOM_VALUE}>Custom</option>
              </select>
              {selectedLevelMode === FACADE_LEVEL_CUSTOM_VALUE && (
                <input
                  type="text"
                  value={value.facadeLevel}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      facadeLevel: e.target.value,
                    })
                  }
                  className="field-shell mt-2"
                  placeholder="Type floor or level"
                />
              )}
            </div>
          )}

          {selectedDefinition.requiresFacadeType && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Type
              </label>
              <div className="flex flex-col gap-2 rounded-[1rem] soft-control px-4 py-3 dark:bg-white/[0.05]">
                {FACADE_TYPES.map((type) => {
                  const selected = selectedFacadeTypes.includes(type);
                  return (
                    <label key={type} className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          const current = getFacadeTypeValues(value.areaNumber);
                          const next = selected
                            ? current.filter((t) => t !== type)
                            : [...current, type];
                          onChange({ ...value, areaNumber: next.join(',') });
                        }}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                      <span className="text-sm text-gray-800 dark:text-gray-200">{type}</span>
                    </label>
                  );
                })}
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={customFacadeTypeEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setCustomFacadeTypeEnabled(enabled);
                      const standardTypes = getFacadeTypeValues(value.areaNumber).filter((type) =>
                        FACADE_TYPES.includes(type as FacadeType)
                      );
                      onChange({
                        ...value,
                        areaNumber: [
                          ...standardTypes,
                          ...(enabled && customFacadeType.trim() ? [customFacadeType.trim()] : []),
                        ].join(','),
                      });
                    }}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span className="text-sm text-gray-800 dark:text-gray-200">Custom</span>
                </label>
                {customFacadeTypeEnabled && (
                  <input
                    type="text"
                    value={customFacadeType}
                    onChange={(event) => {
                      const nextCustomType = event.target.value.replace(/,/g, ' ');
                      setCustomFacadeType(nextCustomType);
                      const standardTypes = getFacadeTypeValues(value.areaNumber).filter((type) =>
                        FACADE_TYPES.includes(type as FacadeType)
                      );
                      onChange({
                        ...value,
                        areaNumber: [...standardTypes, ...(nextCustomType.trim() ? [nextCustomType.trim()] : [])].join(','),
                      });
                    }}
                    className="field-shell mt-1"
                    placeholder="Enter custom facade type"
                    aria-label="Custom facade type name"
                  />
                )}
              </div>
            </div>
          )}

          {selectedDefinition.key === 'facade' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Elevation Drawing
              </label>
              <div className="rounded-[1rem] soft-control p-3 dark:bg-white/[0.05]">
                {selectedOrientation ? (
                  <div className="space-y-3">
                    <select
                      value={value.elevationDrawingId}
                      onChange={(e) => {
                        setElevationError('');
                        onChange({
                          ...value,
                          elevationDrawingId: e.target.value,
                          pendingElevationDrawing: null,
                        });
                      }}
                      className="field-shell"
                    >
                      <option value="">No drawing selected</option>
                      {matchingElevationDrawings.map((drawing) => (
                        <option key={drawing.id} value={drawing.id}>
                          {drawing.name}
                        </option>
                      ))}
                    </select>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => elevationInputRef.current?.click()}
                        className="flex h-10 flex-1 items-center justify-center gap-2 soft-control rounded-2xl px-4 text-sm font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
                      >
                        <Upload className="h-4 w-4" />
                        Upload PDF/JPEG
                      </button>
                      {selectedElevationDrawing && (
                        <button
                          type="button"
                          onClick={() => {
                            setElevationError('');
                            onChange({
                              ...value,
                              elevationDrawingId: '',
                              pendingElevationDrawing: null,
                            });
                          }}
                          className="flex h-10 w-10 items-center justify-center soft-control rounded-2xl text-gray-600 transition hover:bg-white hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.08]"
                          aria-label="Clear elevation drawing"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <input
                      ref={elevationInputRef}
                      type="file"
                      accept={ELEVATION_FILE_ACCEPT}
                      className="hidden"
                      onChange={(event) => void handleElevationFileChange(event)}
                    />

                    {selectedElevationDrawing && (
                      <div className="rounded-[0.9rem] border-0 bg-white/80 p-3 dark:bg-white/[0.05]">
                        <div className="flex items-start gap-2">
                          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-gray-900 dark:text-white">
                              {selectedElevationDrawing.name}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                              {selectedElevationDrawing.fileName} - {formatFileSize(selectedElevationDrawing.size)}
                            </div>
                          </div>
                        </div>
                        {value.pendingElevationDrawing && (
                          <input
                            type="text"
                            value={value.pendingElevationDrawing.name}
                            onChange={(e) =>
                              onChange({
                                ...value,
                                pendingElevationDrawing: {
                                  ...value.pendingElevationDrawing!,
                                  name: e.target.value,
                                  updatedAt: new Date(),
                                },
                              })
                            }
                            className="field-shell mt-3"
                            placeholder="Drawing name"
                          />
                        )}
                      </div>
                    )}

                    {elevationError && (
                      <p className="text-xs text-red-600 dark:text-red-300">{elevationError}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Select an orientation to choose or upload an elevation.
                  </p>
                )}
              </div>
            </div>
          )}

          {selectedDefinition.requiresCustomName && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Area Name
              </label>
              <input
                type="text"
                value={value.customAreaName}
                onChange={(e) =>
                  onChange({
                    ...value,
                    customAreaName: e.target.value,
                  })
                }
                className="field-shell"
                placeholder="Enter custom area name"
              />
            </div>
          )}

          {!selectedDefinition.requiresOrientation && !isBulkApartmentCreation && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Number / Floor
              </label>
              <input
                type="text"
                value={value.areaNumber}
                onChange={(e) =>
                  onChange({
                    ...value,
                    areaNumber: e.target.value,
                  })
                }
                className="field-shell"
                placeholder="e.g., 306, 12F, B1"
              />
            </div>
          )}

        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={handleClose}
            className="flex-1 soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              (isBulkApartmentCreation &&
                (!isBulkUnitCountValid || hasIncompleteBulkApartmentUnits || hasDuplicateBulkApartmentUnits)) ||
              (!isBulkApartmentCreation && selectedDefinition.requiresUnitType && !value.unitType) ||
              (selectedDefinition.requiresOrientation && !value.unitType) ||
              (selectedDefinition.requiresOrientation &&
                enableFacadeLevelBatch &&
                (facadeLevelOptions.length === 0 || selectedFacadeLevels.length === 0)) ||
              (selectedDefinition.requiresOrientation &&
                !enableFacadeLevelBatch &&
                !value.facadeLevel.trim()) ||
              (!!value.pendingElevationDrawing && !value.pendingElevationDrawing.name.trim()) ||
              (selectedDefinition.requiresFacadeType && !value.areaNumber) ||
              (selectedDefinition.requiresFacadeType &&
                customFacadeTypeEnabled &&
                !customFacadeType.trim()) ||
              (selectedDefinition.requiresCustomName && !value.customAreaName.trim())
            }
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {isBulkApartmentCreation ? `Add ${bulkApartmentUnits.length} Units` : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
