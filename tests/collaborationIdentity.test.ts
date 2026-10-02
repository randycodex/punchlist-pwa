import { describe, expect, it } from 'vitest';
import {
  collaborationEmailsMatch,
  getCollaborationErrorMessage,
  normalizeCollaborationEmail,
} from '@/lib/collaboration';
import { CollaborationRequestTimeoutError } from '@/lib/collaboration/request';

describe('collaboration identity helpers', () => {
  it('normalizes email case and surrounding whitespace', () => {
    expect(normalizeCollaborationEmail('  HiginioJimenez@Outlook.com ')).toBe(
      'higiniojimenez@outlook.com'
    );
  });

  it('matches only two present normalized email addresses', () => {
    expect(collaborationEmailsMatch('HJIMENEZ@UAI-NY.COM', 'hjimenez@uai-ny.com')).toBe(true);
    expect(collaborationEmailsMatch('hjimenez@uai-ny.com', 'higiniojimenez@outlook.com')).toBe(false);
    expect(collaborationEmailsMatch(null, null)).toBe(false);
  });

  it('keeps database error codes out of user-facing messages', () => {
    expect(getCollaborationErrorMessage({
      message: 'This shared project code is invalid or expired.',
      code: '22023',
    })).toBe('This shared project code is invalid or expired.');
  });

  it('hides raw database constraint details from users', () => {
    expect(getCollaborationErrorMessage({
      message: 'duplicate key value violates unique constraint "project_members_active_user_idx"',
      details: 'Key (project_id, user_id) already exists.',
      code: '23505',
    }, 'Failed to join this shared project.')).toBe('Failed to join this shared project.');
  });

  it('removes timeout implementation details from collaboration errors', () => {
    expect(getCollaborationErrorMessage({
      message: 'CollaborationRequestTimeoutError: Publishing shared data timed out after 90 seconds. Check your connection and try again.',
      details: 'fetchWithCollaborationTimeout@https://example.test/chunk.js:1:1',
    })).toBe('The team service did not respond in time. Your work is still saved on this device. Please try again.');
  });

  it('identifies the timed-out team operation without exposing internals', () => {
    expect(getCollaborationErrorMessage(new CollaborationRequestTimeoutError('Pulling shared area updates', 90_000)))
      .toBe('Pulling shared area updates timed out after 90 seconds. Please try again. Your work remains saved on this device.');
  });

  it('replaces raw database statement timeout errors', () => {
    expect(getCollaborationErrorMessage({
      message: 'canceling statement due to statement timeout',
      code: '57014',
    })).toBe('The team service took too long to process this. Please try again.');
  });

  it('hides raw mobile fetch stacks and confirms local work is preserved', () => {
    expect(getCollaborationErrorMessage({
      message: 'TypeError: Failed to fetch',
      details: 'at r2 (https://punchlist-pwa.vercel.app/_next/static/chunks/app.js:1:1)',
    })).toBe(
      'The request to the team service did not complete. Your work is still saved on this device. Please try again.'
    );
  });

  it.each([
    new TypeError('Failed to fetch'),
    new TypeError('Load failed'),
    { message: 'Network request failed' },
    { message: 'NetworkError when attempting to fetch resource.' },
  ])('describes a failed request without diagnosing the internet connection', (error) => {
    expect(getCollaborationErrorMessage(error)).toBe(
      'The request to the team service did not complete. Your work is still saved on this device. Please try again.'
    );
  });

  it('preserves a server permission error rather than treating it as connectivity', () => {
    expect(getCollaborationErrorMessage({
      message: 'You do not have access to back up this shared project.',
      code: '42501',
    })).toBe('You do not have access to back up this shared project.');
  });
});
