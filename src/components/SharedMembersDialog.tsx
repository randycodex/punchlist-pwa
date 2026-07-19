'use client';

import { ArrowRightLeft, Loader2, UserMinus } from 'lucide-react';
import type { CollaborationProjectMember } from '@/lib/collaboration';

type SharedMembersDialogProps = {
  projectName: string;
  members: CollaborationProjectMember[];
  loading: boolean;
  canTransferOwnership: boolean;
  canRemoveMembers: boolean;
  transferringOwnership: boolean;
  removingMemberEmail?: string;
  removalError?: string;
  onClose: () => void;
  onRefresh: () => void;
  onTransferOwnership: () => void;
  onRemoveMember: (member: CollaborationProjectMember) => void;
};

function formatMemberStatus(status: CollaborationProjectMember['accessState']) {
  if (status === 'active') return 'Active';
  if (status === 'invited') return 'Invited';
  return 'Removed';
}

function formatMemberJoinMethod(method: CollaborationProjectMember['joinedBy']) {
  return method === 'joinCode' ? 'Joined by code' : 'Email invite';
}

export default function SharedMembersDialog({
  projectName,
  members,
  loading,
  canTransferOwnership,
  canRemoveMembers,
  transferringOwnership,
  removingMemberEmail,
  removalError,
  onClose,
  onRefresh,
  onTransferOwnership,
  onRemoveMember,
}: SharedMembersDialogProps) {
  return (
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shared-members-title"
    >
      <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
        <h2 id="shared-members-title" className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Shared Members</h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{projectName}</p>
        {removalError && (
          <div className="mb-4 rounded-[1.15rem] bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-300">
            {removalError}
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-3 rounded-[1.25rem] soft-control px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading members...
          </div>
        ) : members.length === 0 ? (
          <div className="rounded-[1.25rem] soft-control px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            No shared project members found.
          </div>
        ) : (
          <div className="space-y-3">
            {members.map((member) => (
              <div key={`${member.projectId}:${member.email}`} className="rounded-[1.25rem] soft-control p-4 dark:bg-white/[0.04]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                      {member.displayName || member.email}
                    </div>
                    <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{member.email}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {member.isOwner && (
                      <span className="rounded-full bg-black/[0.06] px-2.5 py-1 text-[11px] font-semibold text-gray-700 dark:bg-white/[0.08] dark:text-gray-300">
                        Owner
                      </span>
                    )}
                    <span className="rounded-full bg-green-500/10 px-2.5 py-1 text-[11px] font-semibold text-green-700 dark:bg-green-400/10 dark:text-green-300">
                      {formatMemberStatus(member.accessState)}
                    </span>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-gray-500 dark:text-gray-400">
                  <div>{formatMemberJoinMethod(member.joinedBy)}</div>
                  <div>
                    {member.joinedAt
                      ? `Joined ${member.joinedAt.toLocaleString()}`
                      : `Invited ${member.invitedAt.toLocaleString()}`}
                  </div>
                </div>
                {canRemoveMembers && !member.isOwner && (
                  <button
                    type="button"
                    onClick={() => onRemoveMember(member)}
                    disabled={!!removingMemberEmail}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15"
                  >
                    {removingMemberEmail === member.email ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserMinus className="h-4 w-4" />
                    )}
                    {removingMemberEmail === member.email ? 'Removing...' : 'Remove member'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canTransferOwnership && (
          <div className="mt-4 rounded-[1.25rem] soft-control p-4 dark:bg-white/[0.04]">
            <div className="text-sm font-semibold text-gray-900 dark:text-white">Project ownership</div>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              Hand owner controls to an existing active member.
            </p>
            <button
              onClick={onTransferOwnership}
              disabled={transferringOwnership}
              className="mt-3 flex w-full items-center justify-center gap-2 soft-control rounded-2xl px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              <ArrowRightLeft className="h-4 w-4" />
              {transferringOwnership ? 'Transferring...' : 'Transfer ownership'}
            </button>
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            Done
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
