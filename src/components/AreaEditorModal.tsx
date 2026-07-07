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
} from '@/lib/areas';
import { FileText, Upload, X } from 'lucide-react';

const FACADE_LEVEL_CUSTOM_VALUE = '__custom__';
const MAX_ELEVATION_FILE_SIZE = 25 * 1024 * 1024;
const ELEVATION_FILE_ACCEPT = '.pdf,image/jpeg,image/png,image/webp,application/pdf';
const ELEVATION_FILE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

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
  onSubmit: () => void;
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
  const elevationInputRef = useRef<HTMLInputElement | null>(null);
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
  const matchingElevationDrawings = selectedOrientation
    ? facadeElevationDrawings.filter((drawing) => drawing.orientation === selectedOrientation)
    : [];
  const selectedStoredElevationDrawing =
    value.elevationDrawingId && !value.pendingElevationDrawing
      ? matchingElevationDrawings.find((drawing) => drawing.id === value.elevationDrawingId) ?? null
      : null;
  const selectedElevationDrawing = value.pendingElevationDrawing ?? selectedStoredElevationDrawing;

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
      <div className="modal-panel my-4 w-full max-w-md rounded-[1.9rem] p-6">
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
                  onChange({
                    ...value,
                    areaTypeKey: nextAreaType,
                    unitType: nextUnitType,
                    customAreaName: nextAreaType === 'custom' ? value.customAreaName : '',
                    areaNumber: keepsFacadeFields ? value.areaNumber : '',
                    facadeLevel: keepsFacadeFields ? value.facadeLevel : '',
                    facadeLevelMode: keepsFacadeFields ? value.facadeLevelMode : '',
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

          {selectedDefinition.requiresUnitType && (
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
              <select
                value={value.facadeLevelMode}
                onChange={(e) =>
                  onChange({
                    ...value,
                    facadeLevelMode: e.target.value as AreaFormValue['facadeLevelMode'],
                    facadeLevel: e.target.value === 'yes' ? value.facadeLevel : '',
                  })
                }
                className="field-shell"
              >
                <option value="">Select levels</option>
                <option value="yes" disabled={facadeLevelOptions.length === 0}>
                  Pick floors
                </option>
                <option value="no">No levels</option>
              </select>
              {value.facadeLevelMode === 'yes' && facadeLevelOptions.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2 rounded-[1rem] border border-[var(--surface-border)] bg-white/70 p-3 dark:bg-white/[0.05]">
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
                            onChange({ ...value, facadeLevel: next.join(',') });
                          }}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                        <span>{level}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {facadeLevelOptions.length === 0 && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Set a project level range first to create facade levels.
                </p>
              )}
              {value.facadeLevelMode === 'yes' && facadeLevelOptions.length > 0 && selectedFacadeLevels.length === 0 && (
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
              <div className="flex flex-col gap-2 rounded-[1rem] border border-[var(--surface-border)] bg-white/70 px-4 py-3 dark:bg-white/[0.05]">
                {FACADE_TYPES.map((type) => {
                  const selected = value.areaNumber.split(',').filter(Boolean).includes(type);
                  return (
                    <label key={type} className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          const current = value.areaNumber.split(',').filter(Boolean);
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
              </div>
            </div>
          )}

          {selectedDefinition.key === 'facade' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Elevation Drawing
              </label>
              <div className="rounded-[1rem] border border-[var(--surface-border)] bg-white/70 p-3 dark:bg-white/[0.05]">
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
                        className="flex h-10 flex-1 items-center justify-center gap-2 rounded-2xl border border-gray-300/90 bg-white/70 px-4 text-sm font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
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
                          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-300/90 bg-white/70 text-gray-600 transition hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
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
                      <div className="rounded-[0.9rem] border border-[var(--surface-border)] bg-white/80 p-3 dark:bg-white/[0.05]">
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

          {!selectedDefinition.requiresOrientation && (
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
            onClick={onClose}
            className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={
              (selectedDefinition.requiresUnitType && !value.unitType) ||
              (selectedDefinition.requiresOrientation && !value.unitType) ||
              (selectedDefinition.requiresOrientation &&
                enableFacadeLevelBatch &&
                (!value.facadeLevelMode ||
                  (value.facadeLevelMode === 'yes' &&
                    (facadeLevelOptions.length === 0 || selectedFacadeLevels.length === 0)))) ||
              (selectedDefinition.requiresOrientation &&
                !enableFacadeLevelBatch &&
                !value.facadeLevel.trim()) ||
              (!!value.pendingElevationDrawing && !value.pendingElevationDrawing.name.trim()) ||
              (selectedDefinition.requiresFacadeType && !value.areaNumber) ||
              (selectedDefinition.requiresCustomName && !value.customAreaName.trim())
            }
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
