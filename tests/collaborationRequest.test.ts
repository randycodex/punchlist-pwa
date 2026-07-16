import { describe, expect, it } from 'vitest';

import {
  CollaborationRequestTimeoutError,
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
});
