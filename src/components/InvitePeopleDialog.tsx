'use client';

import { useState } from 'react';
import { Check, Copy, QrCode, Share2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

type InvitePeopleDialogProps = {
  projectName: string;
  code: string;
  expiresAt: string;
  inviteUrl: string;
  onClose: () => void;
};

type CopyStatus = 'link' | 'code' | null;

export default function InvitePeopleDialog({
  projectName,
  code,
  expiresAt,
  inviteUrl,
  onClose,
}: InvitePeopleDialogProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>(null);

  async function copyText(value: string, status: Exclude<CopyStatus, null>) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = value;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
    }
    setCopyStatus(status);
    window.setTimeout(() => setCopyStatus(null), 1800);
  }

  async function shareInvite() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join ${projectName}`,
          text: `Join the shared punch-list project "${projectName}".`,
          url: inviteUrl,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }

    await copyText(inviteUrl, 'link');
  }

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-people-title"
    >
      <div className="modal-panel max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
        <h2 id="invite-people-title" className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          Invite People
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">{projectName}</p>
        <p className="mt-4 text-sm leading-6 text-gray-600 dark:text-gray-300">
          Share the link or QR code. The invite code is available as a fallback.
        </p>

        <div
          className="mt-5 flex justify-center rounded-[1.4rem] soft-control p-5"
          role="img"
          aria-label={`QR code invitation for ${projectName}`}
        >
          <div className="flex flex-col items-center gap-3">
            <QRCodeSVG value={inviteUrl} size={184} level="M" marginSize={1} />
            <div className="flex items-center gap-2 text-xs font-medium text-gray-600">
              <QrCode className="h-4 w-4" />
              Scan to join
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            onClick={() => void shareInvite()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            <Share2 className="h-4 w-4" />
            Share link
          </button>
          <button
            onClick={() => void copyText(inviteUrl, 'link')}
            className="flex items-center justify-center gap-2 soft-control rounded-2xl px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            {copyStatus === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copyStatus === 'link' ? 'Link copied' : 'Copy link'}
          </button>
        </div>

        <div className="mt-4 rounded-[1.25rem] soft-control px-4 py-4 dark:bg-white/[0.04]">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
            Invite code
          </div>
          <div className="mt-2 flex items-center justify-between gap-4">
            <div className="select-all font-mono text-2xl font-semibold tracking-[0.16em] text-gray-900 dark:text-white">
              {code}
            </div>
            <button
              onClick={() => void copyText(code, 'code')}
              className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-black/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              {copyStatus === 'code' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copyStatus === 'code' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Expires {new Date(expiresAt).toLocaleString()}
          </div>
        </div>

        <p className="mt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">
          Anyone with this link or code can join the shared project until the invitation expires.
        </p>

        <button
          onClick={onClose}
          className="mt-5 w-full soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
