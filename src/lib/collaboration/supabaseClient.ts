import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCollaborationRuntimeConfig } from './config';
import type { CollaborationDatabase } from './database';

let browserClient: SupabaseClient<CollaborationDatabase> | null = null;

export function getCollaborationSupabaseClient() {
  const config = getCollaborationRuntimeConfig();
  if (!config) return null;

  if (!browserClient) {
    browserClient = createClient<CollaborationDatabase>(
      config.supabaseUrl,
      config.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }
    );
  }

  return browserClient;
}
