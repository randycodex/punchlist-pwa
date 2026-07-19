import { describe, expect, it } from 'vitest';
import {
  collaborationEmailsMatch,
  getCollaborationErrorMessage,
  normalizeCollaborationEmail,
} from '@/lib/collaboration';

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
    })).toBe('The team service is taking too long to respond. Check your connection and try again.');
  });

  it('replaces raw database statement timeout errors', () => {
    expect(getCollaborationErrorMessage({
      message: 'canceling statement due to statement timeout',
      code: '57014',
    })).toBe('The team service took too long to process this. Please try again.');
  });
});
