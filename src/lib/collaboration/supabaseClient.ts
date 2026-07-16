import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCollaborationRuntimeConfig } from './config';
import type { CollaborationDatabase } from './database';
import { fetchWithCollaborationTimeout } from './request';

let browserClient: SupabaseClient<CollaborationDatabase> | null = null;

export function getCollaborationSupabaseClient() {
  const config = getCollaborationRuntimeConfig();
  if (!config) return null;

  if (!browserClient) {
    browserClient = createClient<CollaborationDatabase>(
      config.supabaseUrl,
      config.supabaseAnonKey,
      {
        global: {
          fetch: fetchWithCollaborationTimeout,
        },
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

export function clearPersistedCollaborationSession() {
  if (typeof window === 'undefined') return;

  const config = getCollaborationRuntimeConfig();
  if (!config) return;

  const projectRef = new URL(config.supabaseUrl).hostname.split('.')[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  const storages = [window.localStorage, window.sessionStorage];

  for (const storage of storages) {
    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key === storageKey || key?.startsWith(`${storageKey}.`)) {
          storage.removeItem(key);
        }
      }
    } catch (error) {
      console.warn('Could not clear a persisted shared-project session:', error);
    }
  }
}
