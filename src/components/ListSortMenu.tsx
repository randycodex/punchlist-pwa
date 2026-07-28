'use client';

export type ListSortOption =
  | 'issues'
  | 'issues-reverse'
  | 'alphabetical'
  | 'alphabetical-reverse'
  | 'date-newest'
  | 'date-oldest';

export type ListSortGroup = 'issues' | 'alphabetical' | 'date';

type ListSortMenuProps = {
  value: ListSortOption;
  onChange: (value: ListSortOption) => void;
};

const options: Array<{ value: ListSortGroup; label: string }> = [
  { value: 'issues', label: 'Issues' },
  { value: 'alphabetical', label: 'A–Z' },
  { value: 'date', label: 'Date' },
];

export function getNextListSortOption(value: ListSortOption, group: ListSortGroup): ListSortOption {
  if (group === 'issues') return value === 'issues' ? 'issues-reverse' : 'issues';
  if (group === 'alphabetical') return value === 'alphabetical' ? 'alphabetical-reverse' : 'alphabetical';
  return value === 'date-newest' ? 'date-oldest' : 'date-newest';
}

export default function ListSortMenu({ value, onChange }: ListSortMenuProps) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Sort list">
      {options.map((option) => {
        const isSelected =
          (option.value === 'issues' && (value === 'issues' || value === 'issues-reverse')) ||
          (option.value === 'alphabetical' && (value === 'alphabetical' || value === 'alphabetical-reverse')) ||
          (option.value === 'date' && (value === 'date-newest' || value === 'date-oldest'));
        const label = !isSelected
          ? option.label
          : option.value === 'alphabetical'
            ? value === 'alphabetical-reverse' ? 'Z–A' : 'A–Z'
            : `${option.label} ${
              value === 'issues-reverse' || value === 'date-oldest' ? '↑' : '↓'
            }`;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(getNextListSortOption(value, option.value))}
            className={`min-h-10 min-w-0 rounded-full px-1.5 py-2 text-center text-[12px] font-medium transition-colors ${
              isSelected
                ? 'bg-[#FFDEAD] text-gray-900 dark:bg-[#555D50] dark:text-white'
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
