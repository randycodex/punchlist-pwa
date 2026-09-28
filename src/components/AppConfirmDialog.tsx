'use client';

import { createPortal } from 'react-dom';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

type AppConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function AppConfirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
  onCancel,
  onConfirm,
}: AppConfirmDialogProps) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  if (!mounted) return null;
  return createPortal(
    <div className="modal-overlay modal-overlay-confirm fixed inset-0 flex items-center justify-center p-4">
      <div className="modal-panel max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
        <h2 className="mb-4 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          {title}
        </h2>
        <p className="whitespace-pre-line text-sm leading-6 text-gray-600 dark:text-gray-300">
          {message}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-2xl px-4 py-3 font-medium transition ${
              danger
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-zinc-900 text-white hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  , document.body);
}
