'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

type CustomItemComposerProps = {
  open: boolean;
  value: string;
  triggerLabel?: string;
  valuePlaceholder?: string;
  secondaryValue?: string;
  secondaryValuePlaceholder?: string;
  submitLabel?: string;
  onOpen: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
  onSecondaryChange?: (value: string) => void;
  onSubmit: () => void;
};

export default function CustomItemComposer({
  open,
  value,
  triggerLabel = '+ Item',
  valuePlaceholder = 'Custom item name',
  secondaryValue,
  secondaryValuePlaceholder = 'Sub-item name',
  submitLabel = 'Add',
  onOpen,
  onClose,
  onChange,
  onSecondaryChange,
  onSubmit,
}: CustomItemComposerProps) {
  const composerRef = useRef<HTMLDivElement | null>(null);
  const requiresSecondaryValue = typeof secondaryValue === 'string' && typeof onSecondaryChange === 'function';
  const canSubmit = value.trim().length > 0;
  const compactTriggerLabels = new Set(['+ Item', '+ Sub Item', '+ Sub Area']);
  const triggerWidthClass = compactTriggerLabels.has(triggerLabel) ? 'mx-auto block w-1/2' : 'w-full';

  useEffect(() => {
    if (!open) return;

    function handleDocumentClick(event: MouseEvent) {
      if (composerRef.current?.contains(event.target as Node)) return;

      const isEmptyPrimary = !value.trim();
      const isEmptySecondary = !requiresSecondaryValue || !secondaryValue.trim();
      if (isEmptyPrimary && isEmptySecondary) {
        onClose();
      }
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [open, onClose, requiresSecondaryValue, secondaryValue, value]);

  if (!open) {
    return (
      <div className="px-1 pt-1">
        <button
          onClick={onOpen}
          className={`${triggerWidthClass} inspection-add-trigger justify-center rounded-[1.2rem] px-6 py-3 text-sm transition`}
        >
          {triggerLabel}
        </button>
      </div>
    );
  }

  return (
    <div ref={composerRef} className="px-1 pt-1">
      <div className="card-surface-subtle space-y-3 rounded-[1.5rem] p-3">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="field-shell"
          placeholder={valuePlaceholder}
          autoFocus
        />
        {requiresSecondaryValue && (
          <input
            type="text"
            value={secondaryValue}
            onChange={(e) => onSecondaryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault();
                onSubmit();
              }
            }}
            className="field-shell"
            placeholder={secondaryValuePlaceholder}
          />
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="rounded-[1rem] bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {submitLabel}
          </button>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-black/[0.04] hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="Cancel adding item"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
