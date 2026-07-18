'use client';

type AppMessageDialogProps = {
  title: string;
  message: string;
  onClose: () => void;
  actionLabel?: string;
};

export default function AppMessageDialog({
  title,
  message,
  onClose,
  actionLabel = 'OK',
}: AppMessageDialogProps) {
  return (
    <div className="modal-overlay modal-overlay-message fixed inset-0 flex items-center justify-center p-4">
      <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
        <h2 className="mb-4 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          {title}
        </h2>
        <p className="whitespace-pre-line text-sm leading-6 text-gray-600 dark:text-gray-300">
          {message}
        </p>
        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="min-w-32 rounded-2xl bg-zinc-900 px-5 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
