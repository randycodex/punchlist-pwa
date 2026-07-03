'use client';

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { getCollaborationSupabaseClient } from '@/lib/collaboration';

type CollaborationAuthContextValue = {
  isReady: boolean;
  isSigningIn: boolean;
  isSignedIn: boolean;
  canUseCollaboration: boolean;
  user: User | null;
  session: Session | null;
  errorMessage: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const CollaborationAuthContext = createContext<CollaborationAuthContextValue | undefined>(undefined);

export function CollaborationAuthProvider({ children }: { children: ReactNode }) {
  const microsoftAuth = useMicrosoftAuth();
  const supabase = useMemo(() => getCollaborationSupabaseClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(() => !supabase);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  async function signIn() {
    setErrorMessage(null);

    if (!supabase) {
      setErrorMessage('Collaboration is not configured.');
      return;
    }

    if (!microsoftAuth.canUseCollaboration) {
      setErrorMessage(microsoftAuth.collaborationAccess.message);
      return;
    }

    setIsSigningIn(true);
    const redirectTo = typeof window !== 'undefined' ? window.location.href : undefined;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo,
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
        errorMessage,
        signIn,
        signOut,
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
