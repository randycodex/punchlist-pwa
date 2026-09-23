import { beforeEach, describe, expect, it, vi } from 'vitest';

const { channels, channelMock, removeChannelMock } = vi.hoisted(() => {
  const channels = new Map<string, {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }>();
  const channelMock = vi.fn((topic: string) => {
    const existing = channels.get(topic);
    if (existing) return existing;

    let subscribed = false;
    const channel = {
      on: vi.fn(() => {
        if (subscribed) throw new Error(`cannot add callbacks for ${topic} after subscribe()`);
        return channel;
      }),
      subscribe: vi.fn(() => {
        subscribed = true;
        return channel;
      }),
    };
    channels.set(topic, channel);
    return channel;
  });
  return { channels, channelMock, removeChannelMock: vi.fn() };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    channel: channelMock,
    removeChannel: removeChannelMock,
  }),
}));

import { subscribeToSharedProjectSnapshotChanges } from '@/lib/collaboration/sharedProjectSnapshots';
import { subscribeToSharedProjectAreaSnapshotChanges } from '@/lib/collaboration/sharedProjectAreas';
import { subscribeToSharedProjectMetadataSnapshotChanges } from '@/lib/collaboration/sharedProjectMetadata';
import { subscribeToSharedProjectAreaClaimChanges } from '@/lib/collaboration/areaClaims';

describe('shared project realtime subscriptions', () => {
  beforeEach(() => {
    channels.clear();
    channelMock.mockClear();
    removeChannelMock.mockClear();
  });

  it.each([
    ['project snapshot', subscribeToSharedProjectSnapshotChanges],
    ['area snapshot', subscribeToSharedProjectAreaSnapshotChanges],
    ['project metadata', subscribeToSharedProjectMetadataSnapshotChanges],
    ['area claim', subscribeToSharedProjectAreaClaimChanges],
  ])('can resubscribe to %s before the previous channel is removed', (_name, subscribe) => {
    const firstUnsubscribe = subscribe('shared-project', () => {});
    firstUnsubscribe();

    expect(() => subscribe('shared-project', () => {})).not.toThrow();
    expect(channelMock).toHaveBeenCalledTimes(2);
    expect(channelMock.mock.calls[0][0]).not.toBe(channelMock.mock.calls[1][0]);
  });
});
