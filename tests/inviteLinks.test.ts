import { describe, expect, it } from 'vitest';
import {
  buildSharedProjectInviteUrl,
  getSharedProjectJoinCodeFromSearch,
} from '@/features/collaboration/inviteLinks';

describe('shared project invite links', () => {
  it('builds a normalized link that opens the join flow', () => {
    expect(buildSharedProjectInviteUrl(' ab12cd ', 'https://punchlist.example.com')).toBe(
      'https://punchlist.example.com/?join=AB12CD'
    );
  });

  it('reads and normalizes a join code from the query string', () => {
    expect(getSharedProjectJoinCodeFromSearch('?join=ab12cd&source=qr')).toBe('AB12CD');
  });

  it('ignores an empty join parameter', () => {
    expect(getSharedProjectJoinCodeFromSearch('?join=%20%20')).toBeNull();
  });
});
