'use client';

export type ListSortOption = 'issues' | 'alphabetical' | 'progress' | 'date-newest' | 'date-oldest';

type ListSortMenuProps = {
  value: ListSortOption;
  onChange: (value: ListSortOption) => void;
};

const options: Array<{ value: ListSortOption | 'date'; label: string }> = [
  { value: 'issues', label: 'Issues first' },
  { value: 'alphabetical', label: 'A–Z' },
  { value: 'progress', label: 'Progress' },
  { value: 'date', label: 'Date' },
];

export default function ListSortMenu({ value, onChange }: ListSortMenuProps) {
  return (
    <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Sort list">
      {options.map((option) => {
        const isDate = option.value === 'date';
        const isSelected = isDate ? value === 'date-newest' || value === 'date-oldest' : value === option.value;
        const label = isDate && isSelected
          ? `${option.label} ${value === 'date-oldest' ? '↑' : '↓'}`
          : option.label;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              if (isDate) {
                onChange(value === 'date-newest' ? 'date-oldest' : 'date-newest');
                return;
              }
              onChange(option.value as ListSortOption);
            }}
            className={`min-h-10 min-w-0 rounded-full px-1.5 py-2 text-center text-[12px] font-medium transition-colors ${
              isSelected
                ? 'bg-[var(--accent)] text-white'
                : 'bg-black/[0.08] text-gray-700 hover:bg-black/[0.12] dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12]'
            }`}
            aria-pressed={isSelected}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
