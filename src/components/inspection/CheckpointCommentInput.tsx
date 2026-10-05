'use client';

import { Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type CheckpointCommentInputProps = {
  checkpointId: string;
  initialValue: string;
  savedComment: string;
  recentComments: string[];
  autoFocus: boolean;
  onChange: (value: string) => void;
  onBlur: (value: string) => void | Promise<void>;
  onOpenPhotoLibrary: () => void;
};

// Keep typing state below the checkpoint's status and photo controls. Updating
// this draft must not render the attachment gallery or the inspection list.
export default function CheckpointCommentInput({
  checkpointId,
  initialValue,
  savedComment,
  recentComments,
  autoFocus,
  onChange,
  onBlur,
  onOpenPhotoLibrary,
}: CheckpointCommentInputProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(initialValue);
  const [initialComment] = useState(() => savedComment.trim());
  const [previousDraft, setPreviousDraft] = useState<string | null>(null);
  const suggestedComments = [...new Set([...recentComments, initialComment].filter(Boolean))].slice(0, 5);

  function updateDraft(value: string) {
    setDraft(value);
    onChange(value);
  }

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  return (
    <>
      <div className="relative">
        <textarea
          id={`checkpoint-note-${checkpointId}`}
          ref={inputRef}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          onBlur={(event) => void Promise.resolve(onBlur(event.target.value)).catch(() => {})}
          className="field-shell field-shell-with-action min-h-[112px] resize-none text-base"
          placeholder="Add inspection note"
        />
        <div className="absolute right-3 top-3 flex gap-2">
          <button
            type="button"
            data-inspection-inline-action="true"
            onClick={(event) => {
              event.stopPropagation();
              onOpenPhotoLibrary();
            }}
            className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-gray-100 text-gray-700 transition hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700"
            aria-label="Open photo library"
            title="Open photo library"
          >
            <Paperclip className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>
      {suggestedComments.length > 0 && (
        <div className="-mx-1 mt-3 overflow-x-auto pb-1">
          {previousDraft !== null && (
            <button type="button" className="min-h-11 px-3 text-xs font-semibold accent-text" onClick={() => { updateDraft(previousDraft); setPreviousDraft(null); }}>
              Undo inserted note
            </button>
          )}
          <div className="flex w-max min-w-full gap-2 px-1">
            {suggestedComments.map((comment) => (
              <button
                key={comment}
                onClick={() => {
                  setPreviousDraft(draft);
                  updateDraft(draft.trim() ? `${draft.trimEnd()}\n${comment}` : comment);
                }}
                className="segmented-chip shrink-0 whitespace-nowrap px-3 py-1.5 text-left text-xs transition hover:bg-white hover:text-gray-900 dark:hover:bg-white/[0.1] dark:hover:text-white"
              >
                {comment.length > 48 ? `${comment.slice(0, 45)}…` : comment}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
