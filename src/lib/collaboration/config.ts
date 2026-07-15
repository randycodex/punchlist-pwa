const DEFAULT_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AREA_CLAIM_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface CollaborationRuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  uaiEmailDomain: string | null;
  allowedEmails: string[];
  joinCodeTtlMs: number;
  areaClaimTimeoutMs: number;
}

export interface CollaborationEmailAccess {
  isConfigured: boolean;
  isAllowed: boolean;
  message: string | null;
}

export function normalizeCollaborationEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

export function collaborationEmailsMatch(
  firstEmail: string | null | undefined,
  secondEmail: string | null | undefined
) {
  const first = normalizeCollaborationEmail(firstEmail);
  const second = normalizeCollaborationEmail(secondEmail);
  return !!first && first === second;
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

function normalizeEmailList(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'));
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
    allowedEmails: normalizeEmailList(process.env.NEXT_PUBLIC_COLLABORATION_ALLOWED_EMAILS),
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

export function getAllowedCollaborationEmailDescription(config = getCollaborationRuntimeConfig()) {
  if (!config) return 'configured collaboration accounts';

  const allowed = [
    config.uaiEmailDomain ? `${config.uaiEmailDomain} accounts` : null,
    ...config.allowedEmails,
  ].filter((entry): entry is string => !!entry);

  return allowed.length > 0 ? allowed.join(' or ') : 'configured collaboration accounts';
}

export function isAllowedCollaborationEmail(email: string) {
  const config = getCollaborationRuntimeConfig();
  if (!config) return false;

  const normalizedEmail = normalizeCollaborationEmail(email) ?? '';
  const emailDomain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
  return (
    (!!config.uaiEmailDomain && emailDomain === config.uaiEmailDomain) ||
    config.allowedEmails.includes(normalizedEmail)
  );
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

  if (!config.uaiEmailDomain && config.allowedEmails.length === 0) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: 'Collaboration requires an allowed email domain or test email.',
    };
  }

  if (!email) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: `Sign in with ${getAllowedCollaborationEmailDescription(config)} to use shared projects.`,
    };
  }

  if (!isAllowedCollaborationEmail(email)) {
    return {
      isConfigured: true,
      isAllowed: false,
      message: `Shared projects are limited to ${getAllowedCollaborationEmailDescription(config)}.`,
    };
  }

  return {
    isConfigured: true,
    isAllowed: true,
    message: null,
  };
}
