'use client';

import type { AreaListViewMode } from '@/features/projects/areaListView';

type AreaListViewToggleProps = {
  value: AreaListViewMode;
  onChange: (value: AreaListViewMode) => void;
};

const options: Array<{ value: AreaListViewMode; label: string }> = [
  { value: 'grouped', label: 'Grouped' },
  { value: 'all', label: 'All Areas' },
];

export default function AreaListViewToggle({ value, onChange }: AreaListViewToggleProps) {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Area view">
      {options.map((option) => {
        const isSelected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`min-h-10 rounded-full px-3 py-2 text-center text-[12px] font-medium transition-colors ${
              isSelected
                ? 'bg-[var(--accent)] text-white'
                : 'bg-black/[0.08] text-gray-700 hover:bg-black/[0.12] dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12]'
            }`}
            aria-pressed={isSelected}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
