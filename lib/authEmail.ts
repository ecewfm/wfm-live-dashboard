// lib/authEmail.ts
// Username → auth-email mapping, plus the shared user/role types.
//
// People sign in with a USERNAME, which may be a bare handle (`super@wfmlive`,
// `vn20012`) that is not a valid email address. Supabase Auth requires a
// unique, syntactically valid email per auth user, so every username is folded
// into one internal domain. Nothing is ever sent to these addresses — users
// are created with email_confirm already true and never see the mapped value.
//
// Pure functions only: this module is imported by both the browser and the
// server routes, so it must never touch secrets or a Supabase client.

/** Not a real domain, and deliberately not resolvable — no mail can escape. */
export const INTERNAL_EMAIL_DOMAIN = 'users.wfmlive.local'

/** The password every new or admin-reset account starts on. */
export const DEFAULT_PASSWORD = 'default!123'

/** The first account, created by POST /api/auth/bootstrap. */
export const BOOTSTRAP_USERNAME = 'super@wfmlive'

export type UserRole = 'superuser' | 'rta' | 'team_lead'

export const ROLE_LABELS: Record<UserRole, string> = {
  superuser: 'Super User',
  rta:       'RTA',
  team_lead: 'Team Lead',
}

export interface UserProfile {
  id: string
  username: string
  fullName: string | null
  role: UserRole
  mustResetPassword: boolean
  isActive: boolean
  /** Empty for a superuser, which implicitly sees every account. */
  accountIds: string[]
  createdAt?: string
}

/**
 * Map a username to the address used with Supabase Auth.
 *
 * EVERY username is folded into INTERNAL_EMAIL_DOMAIN, including ones that
 * already look like real email. That is on purpose: it means Supabase can
 * never deliver mail to a real mailbox (no stray password-reset or
 * confirmation messages), and there is exactly one rule to reason about
 * instead of two code paths.
 *
 *   super@wfmlive   -> super-wfmlive@users.wfmlive.local
 *   rta@some        -> rta-some@users.wfmlive.local
 *   jdoe@corp.com   -> jdoe-corp-com@users.wfmlive.local
 *   vn20012         -> vn20012@users.wfmlive.local
 *
 * CAVEAT: the slug is lossy, so two DIFFERENT usernames can map to the same
 * address (`a.b` and `a-b` both become `a-b`). The unique index on
 * lower(username) stops duplicate usernames, but not this. If it ever
 * happens, Supabase rejects the second create with "already registered" and
 * provisionUser surfaces that as a plain error rather than silently
 * attaching the new person to the existing login.
 */
export function authEmailForUsername(username: string): string {
  const local = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // '@', '.', spaces — all become one separator
    .replace(/-+/g, '-')           // no runs: "a..b" must not yield "a..b", which
    .replace(/^-+|-+$/g, '')       // some address validators reject
    || 'user'
  return `${local}@${INTERNAL_EMAIL_DOMAIN}`
}

/** Shared by the client form and the server route so the rules can't drift. */
export function validateNewPassword(pw: string, confirm?: string): string | null {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.'
  if (pw === DEFAULT_PASSWORD) return 'Please choose a password other than the default one.'
  if (confirm !== undefined && pw !== confirm) return 'The two passwords do not match.'
  return null
}

/** Usernames are typed by hand constantly; keep them predictable. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

export function isValidUsername(raw: string): string | null {
  const u = normalizeUsername(raw)
  if (u.length < 3) return 'Username must be at least 3 characters.'
  if (u.length > 64) return 'Username must be 64 characters or fewer.'
  if (/\s/.test(u)) return 'Username cannot contain spaces.'
  if (!/[a-z0-9]/i.test(u)) return 'Username must contain at least one letter or number.'
  return null
}

/**
 * Which accounts a profile may see, given the full account list.
 * Superusers are not enumerated in wfm_user_accounts — the role itself means
 * "all", so a newly added account is visible to them with no extra wiring.
 */
export function visibleAccountsFor(profile: Pick<UserProfile, 'role' | 'accountIds'>, allAccountIds: string[]): string[] {
  if (profile.role === 'superuser') return allAccountIds
  const allowed = new Set(profile.accountIds)
  return allAccountIds.filter(id => allowed.has(id))
}

/** Capability checks, in one place so the UI and the server agree. */
export const can = {
  /** See the Settings modal at all. */
  openSettings:  (r: UserRole) => r === 'superuser' || r === 'rta',
  /** Change thresholds, data sources, integrations. */
  editSettings:  (r: UserRole) => r === 'superuser' || r === 'rta',
  /** See the Users tab. */
  manageUsers:   (r: UserRole) => r === 'superuser' || r === 'rta',
  /** Create/edit accounts themselves, and global integrations. */
  manageAccounts: (r: UserRole) => r === 'superuser',
  /** Import a roster file. */
  importUsers:   (r: UserRole) => r === 'superuser',
  /** Which roles this role is allowed to hand out. */
  assignableRoles: (r: UserRole): UserRole[] =>
    r === 'superuser' ? ['superuser', 'rta', 'team_lead']
    : r === 'rta'     ? ['team_lead']
    : [],
}
