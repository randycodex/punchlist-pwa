import type { SupabaseClient } from '@supabase/supabase-js';
import type { CollaborationDatabase } from './database';

let nextSubscriptionId = 0;

export function createCollaborationRealtimeChannel(
  supabase: SupabaseClient<CollaborationDatabase>,
  topic: string
) {
  // Supabase reuses channels with the same topic. React can subscribe again before
  // removeChannel finishes, and callbacks cannot be added to a subscribed channel.
  nextSubscriptionId += 1;
  return supabase.channel(`${topic}:subscription-${nextSubscriptionId}`);
}
