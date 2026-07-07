'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';

type AreaNotesCardProps = {
  value: string;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
  onBlur: (value: string) => void;
};

export default function AreaNotesCard({ value, isExpanded, onToggle, onChange, onBlur }: AreaNotesCardProps) {
  const hasNotes = value.trim().length > 0;

  return (
    <div className="card-surface-subtle overflow-hidden rounded-[1.7rem]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full px-4 py-4 text-left transition hover:bg-black/[0.02] dark:hover:bg-white/[0.04]"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[1.02rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
              General Notes
            </div>
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {hasNotes ? '1 note' : 'No notes'}
            </div>
          </div>
          {isExpanded ? (
            <ChevronDown className="h-5 w-5 shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-2.5 pb-2.5 pt-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => onBlur(e.target.value)}
            placeholder="Add general notes for this area"
            rows={4}
            className="field-shell min-h-[128px] resize-none text-sm"
          />
        </div>
      )}
    </div>
  );
}
