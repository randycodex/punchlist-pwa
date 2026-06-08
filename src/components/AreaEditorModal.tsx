'use client';

import { useMemo, useState } from 'react';
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

const FACADE_LEVEL_CUSTOM_VALUE = '__custom__';

type AreaEditorModalProps = {
  open: boolean;
  title: string;
  value: AreaFormValue;
  recentAreaTypeKeys: AreaTypeKey[];
  facadeLevelOptions?: string[];
  enableFacadeLevelBatch?: boolean;
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
  enableFacadeLevelBatch = false,
  onChange,
  onClose,
  onSubmit,
  submitLabel,
}: AreaEditorModalProps) {
  const [levelMode, setLevelMode] = useState('');
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
  const selectedLevelMode = value.facadeLevel.trim()
    ? facadeLevelOptions.includes(value.facadeLevel.trim())
      ? value.facadeLevel.trim()
      : FACADE_LEVEL_CUSTOM_VALUE
    : levelMode;

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
        <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{title}</h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Choose the area type and label details.</p>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Area
            </label>
            <select
              value={value.areaTypeKey}
              onChange={(e) => {
                setLevelMode('');
                onChange({
                  ...value,
                  areaTypeKey: e.target.value as AreaTypeKey,
                  unitType: e.target.value === 'apartment_unit' ? value.unitType : '',
                  customAreaName: e.target.value === 'custom' ? value.customAreaName : '',
                  areaNumber: e.target.value === 'facade' ? value.areaNumber : '',
                  facadeLevel: e.target.value === 'facade' ? value.facadeLevel : '',
                  facadeLevelMode: e.target.value === 'facade' ? value.facadeLevelMode : '',
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
                onChange={(e) =>
                  onChange({
                    ...value,
                    unitType: e.target.value as FacadeOrientation,
                  })
                }
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
                  Yes
                </option>
                <option value="no">No</option>
              </select>
              {facadeLevelOptions.length === 0 && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Set a project level range first to create facade levels.
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
                (!value.facadeLevelMode || (value.facadeLevelMode === 'yes' && facadeLevelOptions.length === 0))) ||
              (selectedDefinition.requiresOrientation &&
                !enableFacadeLevelBatch &&
                !value.facadeLevel.trim()) ||
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
