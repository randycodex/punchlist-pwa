'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AREA_TYPE_DEFINITIONS, getAreaGroupKey, type AreaGroupKey } from '@/lib/areas';
import type { Area } from '@/types';
import { shouldRenderAreaGroup } from './areaListView';

type AreaGroupListProps = {
  areas: Area[];
  renderArea: (area: Area) => ReactNode;
};

const groupDefinitions: Array<{ key: AreaGroupKey; label: string }> = [
  { key: 'units', label: 'Units' },
  { key: 'facades', label: 'Facades' },
  ...AREA_TYPE_DEFINITIONS
    .filter((definition) => definition.key !== 'apartment_unit' && definition.key !== 'facade')
    .map((definition) => ({
      key: `type:${definition.key}` as AreaGroupKey,
      label: definition.label,
    })),
];

export default function AreaGroupList({ areas, renderArea }: AreaGroupListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AreaGroupKey>>(new Set());
  const areaCountsByGroup = useMemo(
    () => areas.reduce((counts, area) => {
      const key = getAreaGroupKey(area);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map<AreaGroupKey, number>()),
    [areas]
  );
  const groupedEntries = groupDefinitions
    .map((group) => ({
      group,
      areas: areas.filter((area) => getAreaGroupKey(area) === group.key),
    }))
    .filter((entry) => shouldRenderAreaGroup(entry.areas.length));
  const ungroupedAreas = areas.filter(
    (area) => !shouldRenderAreaGroup(areaCountsByGroup.get(getAreaGroupKey(area)) ?? 0)
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
            {!isCollapsed && (
              <div id={contentId} className="list-stack mt-2">
                {groupedAreas.map(renderArea)}
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
      {ungroupedAreas.map(renderArea)}
    </div>
  );
}
