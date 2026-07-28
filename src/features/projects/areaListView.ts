import type { ListSortOption } from '@/components/ListSortMenu';

export type AreaListViewMode = 'grouped' | 'all';

export const AREA_VIEW_MODE_STORAGE_KEY = 'punchlist-area-view-mode';
export const GROUPED_AREA_SORT_STORAGE_KEY = 'punchlist-grouped-area-sort';
export const ALL_AREA_SORT_STORAGE_KEY = 'punchlist-all-area-sort';

export function shouldRenderAreaGroup(areaCount: number): boolean {
  return areaCount > 1;
}

export function isListSortOption(value: string | null): value is ListSortOption {
  return value === 'issues' || value === 'issues-reverse' ||
    value === 'alphabetical' || value === 'alphabetical-reverse' ||
    value === 'date-newest' || value === 'date-oldest';
}

export function getSortForAreaViewMode(
  mode: AreaListViewMode,
  savedGroupedSort: string | null,
  savedAllSort: string | null,
  fallbackGroupedSort: ListSortOption
): ListSortOption {
  if (mode === 'all') {
    return isListSortOption(savedAllSort) ? savedAllSort : 'date-oldest';
  }
  return isListSortOption(savedGroupedSort) ? savedGroupedSort : fallbackGroupedSort;
}
