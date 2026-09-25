'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AREA_TYPE_DEFINITIONS, getAreaGroupKey, type AreaGroupKey } from '@/lib/areas';
import { getAreaStats, type Area, type Project } from '@/types';
import { getAreaFloor, getProjectFloorLevels, groupAreasByFloor, type UnitFloorNumbering } from '@/lib/unitFloors';
import { shouldRenderAreaGroup } from './areaListView';

type AreaGroupListProps = {
  unitFloorNumbering?: UnitFloorNumbering;
  projectLevelRange?: Pick<Project, 'facadeLevelStart' | 'facadeLevelEnd'> | null;
  areas: Area[];
  renderArea: (area: Area, nested?: boolean) => ReactNode;
  selectedAreaIds?: ReadonlySet<string>;
  onSelectAreas?: (areaIds: string[], selected: boolean) => void;
};

const groupDefinitions: Array<{ key: AreaGroupKey; label: string }> = [
  { key: 'units', label: 'Floors' },
  { key: 'facades', label: 'Facades' },
  ...AREA_TYPE_DEFINITIONS
    .filter((definition) => definition.key !== 'apartment_unit' && definition.key !== 'facade')
    .map((definition) => ({
      key: `type:${definition.key}` as AreaGroupKey,
      label: definition.label,
    })),
];

function getDisplayGroupKey(area: Area): AreaGroupKey {
  return getAreaGroupKey(area) === 'units' || getAreaFloor(area) !== null ? 'units' : getAreaGroupKey(area);
}

export default function AreaGroupList({ areas, renderArea, unitFloorNumbering, projectLevelRange, selectedAreaIds, onSelectAreas }: AreaGroupListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AreaGroupKey>>(new Set());
  const projectFloorLevels = getProjectFloorLevels(projectLevelRange);
  const areaCountsByGroup = useMemo(
    () => areas.reduce((counts, area) => {
      const key = getDisplayGroupKey(area);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map<AreaGroupKey, number>()),
    [areas]
  );
  const groupedEntries = groupDefinitions
    .map((group) => ({
      group,
      areas: areas.filter((area) => getDisplayGroupKey(area) === group.key),
    }))
    .filter((entry) => entry.group.key === 'units'
      ? entry.areas.length > 0 || projectFloorLevels.length > 0
      : shouldRenderAreaGroup(entry.areas.length));
  const ungroupedAreas = areas.filter(
    (area) => getDisplayGroupKey(area) !== 'units' &&
      !shouldRenderAreaGroup(areaCountsByGroup.get(getDisplayGroupKey(area)) ?? 0)
  );
  const expandableGroupKeys = groupedEntries.map(({ group }) => group.key);
  const areAllGroupsCollapsed = expandableGroupKeys.length > 0 &&
    expandableGroupKeys.every((key) => collapsedGroups.has(key));
  const expandableGroupKeySignature = expandableGroupKeys.join(',');

  useEffect(() => {
    const groupKeys = expandableGroupKeySignature
      ? expandableGroupKeySignature.split(',') as AreaGroupKey[]
      : [];
    function toggleAllGroups() {
      setCollapsedGroups((current) => {
        const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => current.has(key));
        return allCollapsed ? new Set() : new Set(groupKeys);
      });
    }

    window.addEventListener('punchlist-toggle-area-groups', toggleAllGroups);
    return () => {
      window.removeEventListener('punchlist-toggle-area-groups', toggleAllGroups);
    };
  }, [expandableGroupKeySignature]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('punchlist-area-groups-state', {
      detail: { allCollapsed: areAllGroupsCollapsed },
    }));
  }, [areAllGroupsCollapsed]);

  return (
    <div className="space-y-3">
      {groupedEntries.map(({ group, areas: groupedAreas }) => {
        const isCollapsed = collapsedGroups.has(group.key);
        const contentId = `area-group-${group.key}`;
        const allSelected = groupedAreas.every((area) => selectedAreaIds?.has(area.id));
        const areasWithIssues = onSelectAreas ? groupedAreas.filter((area) => getAreaStats(area).issues > 0) : [];
        const allIssuesSelected = areasWithIssues.length > 0 && areasWithIssues.every((area) => selectedAreaIds?.has(area.id));

        return (
          <section key={group.key} aria-labelledby={`${contentId}-label`}>
            <button
              type="button"
              onClick={() => {
                setCollapsedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                });
              }}
              className="area-group-toggle soft-control flex w-full items-center justify-between rounded-[1.2rem] px-4 py-3 text-left transition hover:bg-white dark:hover:bg-white/[0.08]"
              aria-expanded={!isCollapsed}
              aria-controls={contentId}
            >
              <span id={`${contentId}-label`} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {group.label}
              </span>
              <span className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                {groupedAreas.length}
                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            </button>
            {onSelectAreas && groupedAreas.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
                <button
                  type="button"
                  className="segmented-chip min-h-11 px-3 py-2 text-sm"
                  aria-label={`${allSelected ? 'Deselect' : 'Select'} all ${group.label}`}
                  onClick={() => onSelectAreas(groupedAreas.map((area) => area.id), !allSelected)}
                >
                  {allSelected ? 'Deselect all' : 'Select all'} ({groupedAreas.length})
                </button>
                {areasWithIssues.length > 0 && (
                  <button
                    type="button"
                    className="segmented-chip min-h-11 px-3 py-2 text-sm"
                    aria-label={`${allIssuesSelected ? 'Deselect' : 'Select'} all ${group.label} with issues`}
                    onClick={() => onSelectAreas(areasWithIssues.map((area) => area.id), !allIssuesSelected)}
                  >
                    {allIssuesSelected ? 'Deselect with issues' : 'Select all with issues'} ({areasWithIssues.length})
                  </button>
                )}
                <span className="text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
                  {groupedAreas.filter((area) => selectedAreaIds?.has(area.id)).length} selected
                </span>
              </div>
            )}
            {!isCollapsed && (
              <div id={contentId} className="list-stack mt-2">
                {group.key === 'units' ? groupAreasByFloor(groupedAreas, unitFloorNumbering, projectLevelRange).map(({ floor, areas: floorAreas }) => (
                  <details key={floor ?? '__unknown'} className={`group/floor inspection-location-surface overflow-hidden rounded-[1.7rem] ${onSelectAreas && floorAreas.some((area) => selectedAreaIds?.has(area.id)) ? 'ring-2 ring-orange-500/70' : ''}`}>
                    <summary className="flex min-h-16 w-full cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-left transition hover:bg-black/[0.02] dark:hover:bg-white/[0.04] [&::-webkit-details-marker]:hidden">
                      <span className="text-[1.02rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{floor === null ? 'Floor not set' : floor === 'Roof' ? 'Roof' : `Floor ${floor}`}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                        {onSelectAreas && floorAreas.some((area) => selectedAreaIds?.has(area.id)) && (
                          <span className="rounded-full bg-orange-500/15 px-2 py-1 font-semibold text-orange-700 dark:text-orange-300">
                            {floorAreas.filter((area) => selectedAreaIds?.has(area.id)).length} selected
                          </span>
                        )}
                        {floorAreas.length} {floorAreas.length === 1 ? 'area' : 'areas'}
                        <ChevronRight aria-hidden="true" className="h-4 w-4 group-open/floor:hidden" />
                        <ChevronDown aria-hidden="true" className="hidden h-4 w-4 group-open/floor:block" />
                      </span>
                    </summary>
                    <div className="list-stack px-3 pb-3">
                      {floorAreas.length > 0 ? floorAreas.map((area) => renderArea(area, true)) : (
                        <p className="px-2 py-2 text-sm text-gray-500 dark:text-gray-400">No areas yet</p>
                      )}
                    </div>
                  </details>
                )) : groupedAreas.map((area) => renderArea(area))}
              </div>
            )}
          </section>
        );
      })}
      {groupedEntries.length > 0 && ungroupedAreas.length > 0 && (
        <div aria-hidden="true" className="py-3">
          <div className="h-px w-full bg-black/10 dark:bg-white/10" />
        </div>
      )}
      {ungroupedAreas.map((area) => renderArea(area))}
    </div>
  );
}
