'use client';

import { useState, type ReactNode } from 'react';
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

  return (
    <div className="space-y-3">
      {groupDefinitions.map((group) => {
        const groupedAreas = areas.filter((area) => getAreaGroupKey(area) === group.key);
        if (groupedAreas.length === 0) return null;
        if (!shouldRenderAreaGroup(groupedAreas.length)) return renderArea(groupedAreas[0]);

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
    </div>
  );
}
