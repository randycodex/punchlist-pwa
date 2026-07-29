import { describe, expect, it } from 'vitest';

import {
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
  isMicrosoftMissingObjectError,
  isMicrosoftTransientSyncError,
} from '@/lib/microsoftErrors';

describe('Microsoft sync error classification', () => {
  it('treats the OneDrive missing-object wording from iPhone as recoverable', () => {
    const error = new Error('The object can not be found here.');

    expect(isMicrosoftMissingObjectError(error)).toBe(true);
    expect(isMicrosoftTransientSyncError(error)).toBe(true);
    expect(getMicrosoftRetryDelayMs(error)).toBe(15_000);
    expect(getMicrosoftErrorMessage(error, 'OneDrive backup failed.')).toBe(
      'Saved locally. Microsoft is catching up.'
    );
  });

  it('recognizes a Graph 404 even when the message changes', () => {
    const error = Object.assign(new Error('Unknown Graph response.'), { status: 404 });
    expect(isMicrosoftMissingObjectError(error)).toBe(true);
  });
});
