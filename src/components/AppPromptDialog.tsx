'use client';

import { useEffect, useState } from 'react';

type AppPromptDialogProps = {
  title: string;
  message?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  inputMode?: 'text' | 'email';
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

export default function AppPromptDialog({
  title,
  message,
  label,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  inputMode = 'text',
  onCancel,
  onConfirm,
}: AppPromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const trimmedValue = value.trim();

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
        <h2 className="mb-2 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          {title}
        </h2>
        {message && (
          <p className="mb-5 text-sm leading-6 text-gray-600 dark:text-gray-300">
            {message}
          </p>
        )}
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        <input
          type={inputMode}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmedValue) {
              onConfirm(trimmedValue);
            }
          }}
          className="field-shell"
          placeholder={placeholder}
          autoFocus
        />
        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => onConfirm(trimmedValue)}
            disabled={!trimmedValue}
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
