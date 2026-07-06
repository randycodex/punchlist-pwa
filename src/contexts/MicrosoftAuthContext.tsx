'use client';

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser';
import { getMicrosoftErrorMessage } from '@/lib/microsoftErrors';
import { getCollaborationEmailAccess, type CollaborationEmailAccess } from '@/lib/collaboration';

type MicrosoftAuthContextValue = {
  accessToken: string | null;
  accountEmail: string | null;
  accountName: string | null;
  collaborationAccess: CollaborationEmailAccess;
  canUseCollaboration: boolean;
  isSignedIn: boolean;
  isReady: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  ensureAccessToken: (options?: { interactive?: boolean }) => Promise<string | null>;
};

const MicrosoftAuthContext = createContext<MicrosoftAuthContextValue | undefined>(undefined);

const SCOPES = ['User.Read', 'Files.ReadWrite'];
const DEFAULT_MS_CLIENT_ID = '376ef496-5fa7-447d-9559-2e128a6b74a4';
const DEFAULT_MS_TENANT_ID = 'organizations';

function getResolvedAccount(pca: PublicClientApplication): AccountInfo | null {
  const activeAccount = pca.getActiveAccount();
  if (activeAccount) return activeAccount;

  const accounts = pca.getAllAccounts();
  if (accounts.length === 1) {
    pca.setActiveAccount(accounts[0]);
    return accounts[0];
  }

  return null;
}

function getAccountEmail(account: AccountInfo | null) {
  return account?.username?.trim() || null;
}

export function MicrosoftAuthProvider({ children }: { children: ReactNode }) {
  const clientId = process.env.NEXT_PUBLIC_MS_CLIENT_ID ?? DEFAULT_MS_CLIENT_ID;
  const tenantId = process.env.NEXT_PUBLIC_MS_TENANT_ID?.trim() || DEFAULT_MS_TENANT_ID;
  const redirectUri =
    process.env.NEXT_PUBLIC_MS_REDIRECT_URI?.trim() ||
    (typeof window !== 'undefined' ? `${window.location.origin}/` : '');

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const pca = useMemo(() => {
    if (!clientId || !tenantId || !redirectUri) return null;
    return new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri,
      },
      cache: {
        cacheLocation: 'localStorage',
      },
    });
  }, [clientId, tenantId, redirectUri]);

  const collaborationAccess = useMemo(
    () => getCollaborationEmailAccess(accountEmail),
    [accountEmail]
  );

  function setCurrentAccount(account: AccountInfo | null) {
    setAccountEmail(getAccountEmail(account));
    setAccountName(account?.name?.trim() || null);
  }

  useEffect(() => {
    let active = true;
    if (!pca) {
      void Promise.resolve().then(() => {
        if (active) {
          setIsReady(true);
        }
      });
      return () => {
        active = false;
      };
    }

    pca
      .initialize()
      .then(() => pca.handleRedirectPromise())
      .then(async (result: AuthenticationResult | null) => {
        if (!active) return;
        if (result?.account) {
          pca.setActiveAccount(result.account);
        }
        const account = getResolvedAccount(pca);
        if (!account) {
          setCurrentAccount(null);
          setIsSignedIn(false);
          setIsReady(true);
          return;
        }
        setCurrentAccount(account);
        const tokenResult = await pca.acquireTokenSilent({ scopes: SCOPES, account });
        if (!active) return;
        setAccessToken(tokenResult.accessToken);
        setIsSignedIn(true);
        setIsReady(true);
      })
      .catch(() => {
        if (!active) return;
        setIsReady(true);
      });

    return () => {
      active = false;
    };
  }, [pca]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!navigator.storage?.persist) return;

    void navigator.storage.persist().catch(() => {
      // Persistent storage is best-effort and unsupported on some browsers.
    });
  }, []);

  async function signIn() {
    if (!pca) {
      alert('Microsoft sign-in is not configured. Check NEXT_PUBLIC_MS_* environment variables.');
      return;
    }
    try {
      await pca.initialize();
      await pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
    } catch (error) {
      console.error('Microsoft sign-in failed:', error);
      alert(getMicrosoftErrorMessage(error, 'Microsoft sign-in failed.'));
    }
  }

  async function signOut() {
    if (!pca) return;
    await pca.initialize();
    await pca.logoutRedirect({ postLogoutRedirectUri: redirectUri || '/' });
    setAccessToken(null);
    setCurrentAccount(null);
    setIsSignedIn(false);
  }

  async function ensureAccessToken(options?: { interactive?: boolean }) {
    if (!pca) return null;
    await pca.initialize();
    const account = getResolvedAccount(pca);
    if (!account) {
      setCurrentAccount(null);
      setIsSignedIn(false);
      return null;
    }
    setCurrentAccount(account);
    try {
      const tokenResult = await pca.acquireTokenSilent({ scopes: SCOPES, account });
      setAccessToken(tokenResult.accessToken);
      setIsSignedIn(true);
      return tokenResult.accessToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        if (!options?.interactive) {
          return null;
        }
        try {
          const tokenResult = await pca.acquireTokenPopup({ scopes: SCOPES, account });
          if (tokenResult.account) {
            pca.setActiveAccount(tokenResult.account);
            setCurrentAccount(tokenResult.account);
          }
          setAccessToken(tokenResult.accessToken);
          setIsSignedIn(true);
          return tokenResult.accessToken;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  return (
    <MicrosoftAuthContext.Provider
      value={{
        accessToken,
        accountEmail,
        accountName,
        collaborationAccess,
        canUseCollaboration: collaborationAccess.isAllowed,
        isSignedIn,
        isReady,
        signIn,
        signOut,
        ensureAccessToken,
      }}
    >
      {children}
    </MicrosoftAuthContext.Provider>
  );
}

export function useMicrosoftAuth() {
  const context = useContext(MicrosoftAuthContext);
  if (!context) {
    throw new Error('useMicrosoftAuth must be used within a MicrosoftAuthProvider');
  }
  return context;
}
