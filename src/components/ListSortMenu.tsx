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
    <div className="grid h-full grid-cols-3 overflow-hidden" role="group" aria-label="Sort list">
      {options.map((option, index) => {
        const isSelected = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`min-h-10 min-w-0 border-t border-black/[0.08] px-2 py-2 text-center text-[13px] font-medium transition-colors dark:border-white/[0.08] ${
              index === 0 ? '' : 'border-l'
            } ${
              isSelected
                ? 'bg-[var(--accent)] text-white'
                : 'text-gray-600 hover:bg-black/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.05]'
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
