const DEFAULT_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AREA_CLAIM_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface CollaborationRuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  uaiEmailDomain: string | null;
  joinCodeTtlMs: number;
  areaClaimTimeoutMs: number;
}

export interface CollaborationEmailAccess {
  isConfigured: boolean;
  isAllowed: boolean;
  message: string | null;
}

function normalizeSupabaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeEmailDomain(value: string | undefined) {
  const trimmed = value?.trim().toLowerCase().replace(/^@/, '');
  return trimmed || null;
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getCollaborationRuntimeConfig(): CollaborationRuntimeConfig | null {
  const supabaseUrl = normalizeSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    uaiEmailDomain: normalizeEmailDomain(process.env.NEXT_PUBLIC_UAI_EMAIL_DOMAIN),
    joinCodeTtlMs: readPositiveIntegerEnv(
      process.env.NEXT_PUBLIC_COLLABORATION_JOIN_CODE_TTL_MS,
      DEFAULT_JOIN_CODE_TTL_MS
    ),
    areaClaimTimeoutMs: readPositiveIntegerEnv(
      process.env.NEXT_PUBLIC_COLLABORATION_AREA_CLAIM_TIMEOUT_MS,
      DEFAULT_AREA_CLAIM_TIMEOUT_MS
    ),
  };
}

export function isCollaborationConfigured() {
  return getCollaborationRuntimeConfig() !== null;
}

export function isAllowedCollaborationEmail(email: string) {
  const domain = getCollaborationRuntimeConfig()?.uaiEmailDomain;
  if (!domain) return false;

  const [, emailDomain] = email.trim().toLowerCase().split('@');
  return emailDomain === domain;
}

export function getCollaborationEmailAccess(email: string | null | undefined): CollaborationEmailAccess {
  const config = getCollaborationRuntimeConfig();
  if (!config) {
    return {
      isConfigured: false,
      isAllowed: false,
      message: 'Collaboration is not configured.',
    };
  }

  if (!config.uaiEmailDomain) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: 'Collaboration requires an allowed UAI email domain.',
    };
  }

  if (!email) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: `Sign in with a ${config.uaiEmailDomain} account to use shared projects.`,
    };
  }

  if (!isAllowedCollaborationEmail(email)) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: `Shared projects are limited to ${config.uaiEmailDomain} accounts.`,
    };
  }

  return {
    isConfigured: true,
    isAllowed: true,
    message: null,
  };
}
