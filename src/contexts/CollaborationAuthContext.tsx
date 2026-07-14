'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import {
  getCollaborationSupabaseClient,
  getMyCollaborationProfile,
  saveMyCollaborationProfile,
  type CollaborationUserProfile,
  type CollaborationUserProfileInput,
} from '@/lib/collaboration';

type CollaborationAuthContextValue = {
  isReady: boolean;
  isSigningIn: boolean;
  isSignedIn: boolean;
  canUseCollaboration: boolean;
  user: User | null;
  session: Session | null;
  profile: CollaborationUserProfile | null;
  isProfileLoading: boolean;
  profileErrorMessage: string | null;
  errorMessage: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  saveProfile: (input: CollaborationUserProfileInput) => Promise<CollaborationUserProfile>;
  refreshProfile: () => Promise<void>;
};

const CollaborationAuthContext = createContext<CollaborationAuthContextValue | undefined>(undefined);

export function CollaborationAuthProvider({ children }: { children: ReactNode }) {
  const microsoftAuth = useMicrosoftAuth();
  const supabase = useMemo(() => getCollaborationSupabaseClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(() => !supabase);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [profile, setProfile] = useState<CollaborationUserProfile | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileErrorMessage, setProfileErrorMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    if (!supabase || !user) {
      setProfile(null);
      setProfileErrorMessage(null);
      return;
    }

    setIsProfileLoading(true);
    try {
      setProfile(await getMyCollaborationProfile());
      setProfileErrorMessage(null);
    } catch (error) {
      console.error('Failed to load collaboration profile:', error);
      setProfile(null);
      setProfileErrorMessage(error instanceof Error ? error.message : 'Unable to load your profile.');
    } finally {
      setIsProfileLoading(false);
    }
  }, [supabase, user]);

  useEffect(() => {
    let active = true;
    if (!supabase) {
      return;
    }

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setErrorMessage(error.message);
      }
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setIsReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setErrorMessage(null);
      setIsReady(true);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  async function saveProfile(input: CollaborationUserProfileInput) {
    setProfileErrorMessage(null);
    const savedProfile = await saveMyCollaborationProfile(input);
    setProfile(savedProfile);
    return savedProfile;
  }

  async function signIn() {
    setErrorMessage(null);

    if (!supabase) {
      setErrorMessage('Collaboration is not configured.');
      return;
    }

    setIsSigningIn(true);
    const redirectTo = typeof window !== 'undefined' ? window.location.href : undefined;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo,
        scopes: 'openid email profile',
      },
    });

    if (error) {
      setErrorMessage(error.message);
      setIsSigningIn(false);
    }
  }

  async function signOut() {
    setErrorMessage(null);
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      setErrorMessage(error.message);
    }
    setProfile(null);
    setProfileErrorMessage(null);
  }

  return (
    <CollaborationAuthContext.Provider
      value={{
        isReady,
        isSigningIn,
        isSignedIn: !!session,
        canUseCollaboration: microsoftAuth.canUseCollaboration,
        user,
        session,
        profile,
        isProfileLoading,
        profileErrorMessage,
        errorMessage,
        signIn,
        signOut,
        saveProfile,
        refreshProfile,
      }}
    >
      {children}
    </CollaborationAuthContext.Provider>
  );
}

export function useCollaborationAuth() {
  const context = useContext(CollaborationAuthContext);
  if (!context) {
    throw new Error('useCollaborationAuth must be used within a CollaborationAuthProvider');
  }
  return context;
}
