'use client';

import { ChevronDown } from 'lucide-react';

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
  const selectedLabel = options.find((option) => option.value === value)?.label ?? 'A–Z';

  return (
    <label className="relative flex min-h-10 items-center gap-3 border-t border-black/[0.08] px-2.5 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:bg-black/[0.04] dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]">
      <span>Sort</span>
      <span className="ml-auto text-gray-500 dark:text-gray-400">{selectedLabel}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as ListSortOption)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Sort list"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
