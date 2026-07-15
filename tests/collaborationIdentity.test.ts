import { describe, expect, it } from 'vitest';
import {
  collaborationEmailsMatch,
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
});
