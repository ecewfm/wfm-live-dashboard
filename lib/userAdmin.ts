// lib/userAdmin.ts
// Create / edit / deactivate / delete users. SERVER ONLY — every function
// here uses the service-role key, so callers must have passed a guard from
// lib/authServer.ts first.
//
// All provisioning funnels through provisionUser(), so there is exactly one
// place that knows how an auth user and a profile are kept consistent. The
// single-create form, the roster import and the bootstrap route all call it.

import { admin, AuthError, loadProfile } from './authServer'
import {
  UserRole, UserProfile, DEFAULT_PASSWORD,
  authEmailForUsername, normalizeUsername, isValidUsername,
} from './authEmail'

/** ~100 years. Supabase has no "disable" flag, so a long ban is the lever. */
const BAN_FOREVER = '876000h'

export interface ProvisionInput {
  username: string
  fullName: string
  role: UserRole
  accountIds: string[]
  /** Defaults to DEFAULT_PASSWORD with a forced reset on first sign-in. */
  password?: string
  isActive?: boolean
  /**
   * Let an RTA / team lead be created with no accounts. Only the roster
   * import sets this: its accounts may not exist in WFM Live yet, and the
   * person should still get a login (they see an empty dashboard until one is
   * assigned). The single-create form keeps requiring at least one.
   */
  allowNoAccounts?: boolean
}

export interface ProvisionResult {
  id: string
  username: string
  tempPassword: string
}

/**
 * Create one login. Six steps, with a rollback — if the profile write fails
 * after the auth user exists, the auth user is deleted again. Without that,
 * a retry hits "already registered" and the operator is stuck with an
 * orphaned login they cannot see in the UI.
 */
export async function provisionUser(input: ProvisionInput): Promise<ProvisionResult> {
  const db = admin()

  // 1. Validate.
  const username = normalizeUsername(input.username)
  const bad = isValidUsername(username)
  if (bad) throw new AuthError(400, bad)
  const fullName = (input.fullName || '').trim() || username
  if (input.role !== 'superuser' && input.accountIds.length === 0 && !input.allowNoAccounts) {
    throw new AuthError(400, `A ${input.role === 'rta' ? 'RTA' : 'team lead'} needs at least one account.`)
  }
  // A superuser sees everything by role; account rows would be dead data.
  const accountIds = input.role === 'superuser' ? [] : input.accountIds

  // 2. Friendlier duplicate message than the unique index would give.
  const { data: clash } = await db
    .from('wfm_profiles').select('id').ilike('username', username).maybeSingle()
  if (clash) throw new AuthError(409, `The username "${username}" is already taken.`)

  // 3. Create the auth user. email_confirm because the address is synthetic
  //    and no confirmation mail could ever be received.
  const authEmail = authEmailForUsername(username)
  const password = input.password || DEFAULT_PASSWORD
  const { data: created, error: aErr } = await db.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (aErr || !created?.user) {
    const m = aErr?.message || 'unknown error'
    if (/already|registered|exists/i.test(m)) {
      throw new AuthError(409, `Another login already uses the address derived from "${username}". Pick a different username.`)
    }
    throw new AuthError(400, `Could not create the login: ${m}`)
  }
  const id = created.user.id

  // 4-6. Fill in the profile the trigger stubbed out, then the accounts.
  //      Anything that fails from here rolls the auth user back.
  try {
    const { error: pErr } = await db.from('wfm_profiles').update({
      username,
      full_name: fullName,
      auth_email: authEmail,
      role: input.role,
      must_reset_password: true,
      is_active: input.isActive !== false,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (pErr) throw new Error(pErr.message)

    if (accountIds.length) {
      const { error: uaErr } = await db.from('wfm_user_accounts')
        .insert(accountIds.map(account_id => ({ user_id: id, account_id })))
      if (uaErr) throw new Error(uaErr.message)
    }

    if (input.isActive === false) {
      await db.auth.admin.updateUserById(id, { ban_duration: BAN_FOREVER })
    }
  } catch (e) {
    await db.auth.admin.deleteUser(id).catch(() => {})
    throw new AuthError(400, `Could not save the profile: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { id, username, tempPassword: password }
}

/** Users the actor is allowed to SEE (not necessarily to edit). */
export async function listUsers(actor: UserProfile): Promise<UserProfile[]> {
  const db = admin()
  const { data: profiles, error } = await db
    .from('wfm_profiles')
    .select('id, username, full_name, role, must_reset_password, is_active, created_at')
    .order('username')
  if (error) throw new Error(`user list failed: ${error.message}`)

  const { data: links, error: lErr } = await db.from('wfm_user_accounts').select('user_id, account_id')
  if (lErr) throw new Error(`assignment list failed: ${lErr.message}`)

  const byUser = new Map<string, string[]>()
  for (const l of links ?? []) {
    const arr = byUser.get(l.user_id) ?? []
    arr.push(l.account_id)
    byUser.set(l.user_id, arr)
  }

  const all: UserProfile[] = (profiles ?? []).map(p => ({
    id: p.id,
    username: p.username,
    fullName: p.full_name,
    role: p.role as UserRole,
    mustResetPassword: !!p.must_reset_password,
    isActive: !!p.is_active,
    accountIds: byUser.get(p.id) ?? [],
    createdAt: p.created_at,
  }))

  if (actor.role === 'superuser') return all
  // An RTA sees themselves plus anyone sharing one of their accounts. They can
  // only EDIT team leads (canAdminister decides that separately) — seeing the
  // other RTAs on an account is useful context, not a permission.
  const mine = new Set(actor.accountIds)
  return all.filter(u => u.id === actor.id || u.accountIds.some(a => mine.has(a)))
}

export interface UpdateInput {
  fullName?: string
  role?: UserRole
  accountIds?: string[]
}

export async function updateUser(targetId: string, patch: UpdateInput): Promise<void> {
  const db = admin()
  const target = await loadProfile(targetId)
  if (!target) throw new AuthError(404, 'That user no longer exists.')

  const role = patch.role ?? target.role
  const accountIds = role === 'superuser' ? [] : (patch.accountIds ?? target.accountIds)
  // Only refuse when the edit itself tries to strip every account. A person
  // imported before their accounts existed legitimately has none, and must
  // still be renameable without first being forced to assign something.
  if (role !== 'superuser' && patch.accountIds !== undefined && accountIds.length === 0) {
    throw new AuthError(400, `A ${role === 'rta' ? 'RTA' : 'team lead'} needs at least one account.`)
  }

  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.fullName !== undefined) fields.full_name = patch.fullName.trim() || target.username
  if (patch.role !== undefined) fields.role = patch.role
  const { error } = await db.from('wfm_profiles').update(fields).eq('id', targetId)
  if (error) throw new Error(`update failed: ${error.message}`)

  // Replace the assignment set only when it was actually part of the request,
  // so a rename can't wipe someone's accounts.
  if (patch.accountIds !== undefined || patch.role !== undefined) {
    const { error: dErr } = await db.from('wfm_user_accounts').delete().eq('user_id', targetId)
    if (dErr) throw new Error(`clearing accounts failed: ${dErr.message}`)
    if (accountIds.length) {
      const { error: iErr } = await db.from('wfm_user_accounts')
        .insert(accountIds.map(account_id => ({ user_id: targetId, account_id })))
      if (iErr) throw new Error(`saving accounts failed: ${iErr.message}`)
    }
  }
}

/**
 * Deactivate/reactivate. Flips the profile flag AND bans the auth user, so an
 * already-signed-in person loses access when their token next refreshes
 * rather than lingering until they happen to log out.
 */
export async function setActive(targetId: string, active: boolean): Promise<void> {
  const db = admin()
  const { error } = await db.from('wfm_profiles')
    .update({ is_active: active, updated_at: new Date().toISOString() })
    .eq('id', targetId)
  if (error) throw new Error(`status change failed: ${error.message}`)
  const { error: bErr } = await db.auth.admin.updateUserById(targetId, {
    ban_duration: active ? 'none' : BAN_FOREVER,
  })
  if (bErr) throw new Error(`auth status change failed: ${bErr.message}`)
}

/** The profile row goes with it via `on delete cascade`. */
export async function deleteUser(targetId: string): Promise<void> {
  const { error } = await admin().auth.admin.deleteUser(targetId)
  if (error) throw new Error(`delete failed: ${error.message}`)
}

/** Admin reset: back to the default password, forced change on next sign-in. */
export async function resetPassword(targetId: string): Promise<string> {
  const db = admin()
  const { error } = await db.auth.admin.updateUserById(targetId, { password: DEFAULT_PASSWORD })
  if (error) throw new Error(`password reset failed: ${error.message}`)
  const { error: pErr } = await db.from('wfm_profiles')
    .update({ must_reset_password: true, updated_at: new Date().toISOString() })
    .eq('id', targetId)
  if (pErr) throw new Error(`password reset flag failed: ${pErr.message}`)
  return DEFAULT_PASSWORD
}

/**
 * The signed-in user choosing their own password. Done server-side in one
 * call because clearing must_reset_password is a wfm_profiles write, and
 * browsers deliberately have no write access to that table.
 */
export async function setOwnPassword(userId: string, password: string): Promise<void> {
  const db = admin()
  const { error } = await db.auth.admin.updateUserById(userId, { password })
  if (error) throw new Error(`could not set password: ${error.message}`)
  const { error: pErr } = await db.from('wfm_profiles')
    .update({ must_reset_password: false, updated_at: new Date().toISOString() })
    .eq('id', userId)
  if (pErr) throw new Error(`could not clear the reset flag: ${pErr.message}`)
}
