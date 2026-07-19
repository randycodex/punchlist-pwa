'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import CollaborationAvatar from '@/components/CollaborationAvatar';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { getCollaborationProfileInitials } from '@/lib/collaboration';

type UserProfileModalProps = {
  open: boolean;
  onClose: () => void;
};

const PROFILE_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

function getMetadataName(userMetadata: Record<string, unknown>, key: string) {
  const value = userMetadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export default function UserProfileModal({ open, onClose }: UserProfileModalProps) {
  const collaborationAuth = useCollaborationAuth();
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!open) return;
    const profile = collaborationAuth.profile;
    const metadata = collaborationAuth.user?.user_metadata ?? {};
    const fullName = getMetadataName(metadata, 'full_name') || getMetadataName(metadata, 'name');
    const fullNameParts = fullName.split(/\s+/).filter(Boolean);
    const emailUsername = (collaborationAuth.user?.email?.split('@')[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 30);

    setUsername(profile?.username ?? (emailUsername.length >= 3 ? emailUsername : ''));
    setFirstName(
      profile?.firstName ?? (getMetadataName(metadata, 'given_name') || fullNameParts[0] || '')
    );
    setLastName(
      profile?.lastName ?? (getMetadataName(metadata, 'family_name') || fullNameParts.slice(1).join(' ') || '')
    );
    setJobTitle(profile?.jobTitle ?? '');
    setSaveError('');
    setIsSaving(false);
  }, [collaborationAuth.profile, collaborationAuth.user, open]);

  const initials = useMemo(
    () => getCollaborationProfileInitials({ firstName, lastName }) || '--',
    [firstName, lastName]
  );
  const canSave =
    PROFILE_USERNAME_PATTERN.test(username.trim()) &&
    Boolean(firstName.trim() && lastName.trim() && jobTitle.trim());

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || isSaving) return;

    setIsSaving(true);
    setSaveError('');
    try {
      await collaborationAuth.saveProfile({ username, firstName, lastName, jobTitle });
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save your profile.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="modal-overlay fixed inset-0 z-[160] flex items-start justify-center overflow-y-auto p-4">
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="modal-panel my-4 w-full max-w-lg rounded-[1.9rem] p-6"
        role="dialog"
        aria-modal="true"
        aria-label={collaborationAuth.profile ? 'Profile' : undefined}
        aria-labelledby={collaborationAuth.profile ? undefined : 'profile-modal-title'}
      >
        <div className="flex items-start gap-4">
          <CollaborationAvatar
            name={[firstName, lastName].filter(Boolean).join(' ') || 'Your account'}
            src={collaborationAuth.profile?.avatarUrl}
            initials={initials}
            size="lg"
          />
          {!collaborationAuth.profile && (
            <h2 id="profile-modal-title" className="text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
              Create Profile
            </h2>
          )}
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label htmlFor="profile-username" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Username
            </label>
            <input
              id="profile-username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
              minLength={3}
              maxLength={30}
              pattern="[a-z0-9][a-z0-9._-]{2,29}"
              autoCapitalize="none"
              autoCorrect="off"
              className="field-shell"
              placeholder="randy.s"
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="profile-first-name" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                First Name
              </label>
              <input
                id="profile-first-name"
                type="text"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                maxLength={80}
                autoComplete="given-name"
                className="field-shell"
                required
              />
            </div>
            <div>
              <label htmlFor="profile-last-name" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Last Name
              </label>
              <input
                id="profile-last-name"
                type="text"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                maxLength={80}
                autoComplete="family-name"
                className="field-shell"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="profile-job-title" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Job Title
            </label>
            <input
              id="profile-job-title"
              type="text"
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
              maxLength={120}
              autoComplete="organization-title"
              className="field-shell"
              placeholder="Project Manager"
              required
            />
          </div>

          {(saveError || collaborationAuth.profileErrorMessage) && (
            <p className="text-sm text-red-600 dark:text-red-300">
              {saveError || collaborationAuth.profileErrorMessage}
            </p>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="flex-1 soft-control rounded-2xl px-4 py-3 font-medium text-gray-700 transition hover:bg-white disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave || isSaving}
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {isSaving ? 'Saving...' : 'Save Profile'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
