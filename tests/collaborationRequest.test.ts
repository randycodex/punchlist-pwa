import { describe, expect, it } from 'vitest';

import {
  COLLABORATION_REQUEST_TIMEOUT_MS,
  COLLABORATION_TRANSFER_TIMEOUT_MS,
  CollaborationRequestTimeoutError,
  getCollaborationRequestPolicy,
  withCollaborationTimeout,
} from '@/lib/collaboration/request';

describe('collaboration request timeout', () => {
  it('returns a request that finishes inside the limit', async () => {
    await expect(withCollaborationTimeout(Promise.resolve('ok'), 'Test request', 50)).resolves.toBe('ok');
  });

  it('returns a useful timeout error instead of hanging forever', async () => {
    await expect(
      withCollaborationTimeout(new Promise(() => {}), 'Test request', 5)
    ).rejects.toBeInstanceOf(CollaborationRequestTimeoutError);
  });

  it('allows full shared snapshot transfers more time than lightweight requests', () => {
    expect(getCollaborationRequestPolicy(
      'https://example.supabase.co/rest/v1/rpc/publish_shared_project_snapshot',
      { method: 'POST' }
    )).toEqual({
      operation: 'Publishing shared data',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    });

    expect(getCollaborationRequestPolicy(
      'https://example.supabase.co/auth/v1/user',
      { method: 'GET' }
    )).toEqual({
      operation: 'Collaboration request',
      timeoutMs: COLLABORATION_REQUEST_TIMEOUT_MS,
    });

    expect(getCollaborationRequestPolicy(
      'https://example.supabase.co/storage/v1/object/punchlist-attachments/project/photo.jpg',
      { method: 'POST' }
    )).toEqual({
      operation: 'Uploading shared attachments',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    });
  });
});
