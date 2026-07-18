'use client';

export type ListSortOption = 'issues' | 'alphabetical' | 'progress';

type ListSortPillsProps = {
  value: ListSortOption;
  onChange: (value: ListSortOption) => void;
};

const options: Array<{ value: ListSortOption; label: string }> = [
  { value: 'issues', label: 'Issues first' },
  { value: 'alphabetical', label: 'A–Z' },
  { value: 'progress', label: 'Progress' },
];

export default function ListSortPills({ value, onChange }: ListSortPillsProps) {
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label="Sort list">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
        Sort
      </span>
      <div className="scrollbar-hidden flex min-w-0 gap-2 overflow-x-auto">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              value === option.value
                ? 'bg-[var(--accent)] text-white'
                : 'bg-black/[0.07] text-gray-700 hover:bg-black/[0.10] dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.10]'
            }`}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
