'use client';

import type { AreaListViewMode } from '@/features/projects/areaListView';

type AreaListViewToggleProps = {
  value: AreaListViewMode;
  onChange: (value: AreaListViewMode) => void;
};

export default function AreaListViewToggle({ value, onChange }: AreaListViewToggleProps) {
  const isGrouped = value === 'grouped';

  return (
    <button
      type="button"
      onClick={() => onChange(isGrouped ? 'all' : 'grouped')}
      className={`min-h-10 w-full min-w-0 rounded-full px-1.5 py-2 text-center text-[12px] font-medium transition-colors ${
        isGrouped
          ? 'bg-[var(--accent)] text-white'
          : 'bg-black/[0.08] text-gray-700 hover:bg-black/[0.12] dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12]'
      }`}
      aria-label="Group areas by type"
      aria-pressed={isGrouped}
    >
      Grouped
    </button>
  );
}
