import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { getCollaborationOAuthRedirectUrl } from '@/lib/collaboration/oauthRedirect';

describe('team sign-in return URL', () => {
  it('drops prior OAuth codes, nested redirects, and project navigation', () => {
    const currentUrl = 'https://punchlist-pwa.vercel.app/project/123?code=old-code&redirect_to=https%3A%2F%2Fpunchlist-pwa.vercel.app%2F%3Fcode%3Dolder-code#section';

    expect(getCollaborationOAuthRedirectUrl(currentUrl)).toBe('https://punchlist-pwa.vercel.app/');
  });

  it('returns to the current deployment origin while developing', () => {
    expect(getCollaborationOAuthRedirectUrl('http://localhost:3000/project/123?sync=1'))
      .toBe('http://localhost:3000/');
  });

  it('keeps prior sign-in parameters out of the Azure authorization request', async () => {
    const supabase = createClient('https://example.supabase.co', 'test-publishable-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const redirectTo = getCollaborationOAuthRedirectUrl(
      'https://punchlist-pwa.vercel.app/?code=old-code&redirect_to=https%3A%2F%2Fpunchlist-pwa.vercel.app%2F%3Fcode%3Dolder-code'
    );

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: { redirectTo, scopes: 'openid email profile', skipBrowserRedirect: true },
    });

    expect(error).toBeNull();
    const authorizationUrl = new URL(data.url!);
    expect(authorizationUrl.searchParams.get('redirect_to')).toBe('https://punchlist-pwa.vercel.app/');
    expect(data.url).not.toContain('old-code');
  });
});
