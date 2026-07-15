'use client';

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
  return (
    <div className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
        <h2 className="mb-4 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          {title}
        </h2>
        <p className="whitespace-pre-line text-sm leading-6 text-gray-600 dark:text-gray-300">
          {message}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
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
  );
}
