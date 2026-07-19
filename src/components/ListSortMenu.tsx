'use client';

export type ListSortOption = 'issues' | 'alphabetical' | 'progress';

type ListSortMenuProps = {
  value: ListSortOption;
  onChange: (value: ListSortOption) => void;
};

const options: Array<{ value: ListSortOption; label: string }> = [
  { value: 'issues', label: 'Issues first' },
  { value: 'alphabetical', label: 'A–Z' },
  { value: 'progress', label: 'Progress' },
];

export default function ListSortMenu({ value, onChange }: ListSortMenuProps) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Sort list">
      {options.map((option) => {
        const isSelected = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`min-h-10 min-w-0 rounded-full px-2 py-2 text-center text-[13px] font-medium transition-colors ${
              isSelected
                ? 'bg-[var(--accent)] text-white'
                : 'bg-black/[0.07] text-gray-600 hover:bg-black/[0.10] dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
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
