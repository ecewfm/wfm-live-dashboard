// lib/authServer.ts
// Server-side identity + authorization for the user-management routes.
//
// SERVER ONLY. It uses the service-role key, which bypasses RLS entirely, so
// every exported helper here exists to answer one question before that key is
// ever used: who is calling, and are they allowed to?
//
// The Next 16 docs are emphatic about this and say it in three separate
// places — "Always verify authentication and authorization inside every
// Server Function", "A page-level authentication check does not extend to the
// Server Actions defined within it", and "[Proxy] should not be your only
// line of defense". So the check lives in the route, on its first line, not
// in a proxy/middleware file or a layout.
//
// The browser authenticates with Supabase directly and sends its access token
// as `Authorization: Bearer <token>`. We hand that token to Supabase to
// identify the user; we never trust a user id, role or account list sent in a
// request body.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { UserRole, UserProfile } from './authEmail'

let _admin: SupabaseClient | null = null

/** Service-role client. Never import this module from a 'use client' file. */
export function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    // Deliberately an AuthError so errorResponse passes the text through
    // instead of flattening it to "something went wrong". A missing env var
    // is a setup mistake the operator has to be able to see — and naming it
    // leaks nothing, since the value itself is never echoed.
    throw new AuthError(500,
      'SUPABASE_SERVICE_ROLE_KEY is not set in this deployment. User management needs it — ' +
      'Supabase Dashboard → Project Settings → API → service_role, then add it to the Vercel env ' +
      '(and .env.local for local dev).'
    )
  }
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _admin
}

/** Thrown by the guards; routes turn it into a response. */
export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Turn a thrown AuthError (or anything else) into a response. */
export function errorResponse(e: unknown): Response {
  if (e instanceof AuthError) return json({ error: e.message }, e.status)
  const msg = e instanceof Error ? e.message : String(e)
  // Don't leak internals; the detail is still in the server log.
  console.error('[users] unhandled:', msg)
  return json({ error: 'Something went wrong. Check the server logs.' }, 500)
}

/** Load a profile plus its account assignments. */
export async function loadProfile(userId: string): Promise<UserProfile | null> {
  const db = admin()
  const { data: p, error } = await db
    .from('wfm_profiles')
    .select('id, username, full_name, role, must_reset_password, is_active, created_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(`profile read failed: ${error.message}`)
  if (!p) return null

  const { data: rows, error: aErr } = await db
    .from('wfm_user_accounts').select('account_id').eq('user_id', userId)
  if (aErr) throw new Error(`account read failed: ${aErr.message}`)

  return {
    id: p.id,
    username: p.username,
    fullName: p.full_name,
    role: p.role as UserRole,
    mustResetPassword: !!p.must_reset_password,
    isActive: !!p.is_active,
    accountIds: (rows ?? []).map(r => r.account_id),
    createdAt: p.created_at,
  }
}

/**
 * Identify the caller from the Authorization header.
 * Throws 401 if the token is missing, invalid, or belongs to a user whose
 * profile is gone or deactivated.
 */
export async function requireUser(req: Request): Promise<UserProfile> {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new AuthError(401, 'Not signed in.')

  const { data, error } = await admin().auth.getUser(token)
  if (error || !data?.user) throw new AuthError(401, 'Your session has expired. Please sign in again.')

  const profile = await loadProfile(data.user.id)
  if (!profile) throw new AuthError(401, 'No profile for this login.')
  // Deactivated users are also banned in auth (see setActive), so this is the
  // second of two gates rather than the only one.
  if (!profile.isActive) throw new AuthError(403, 'This account has been deactivated.')
  return profile
}

/** As requireUser, but also checks the role. */
export async function requireRole(req: Request, roles: UserRole[]): Promise<UserProfile> {
  const me = await requireUser(req)
  if (!roles.includes(me.role)) throw new AuthError(403, 'You do not have permission to do that.')
  return me
}

/**
 * Can `actor` administer `target`?
 *
 * - A superuser may act on anyone.
 * - An RTA may act ONLY on team leads, and only ones whose accounts are a
 *   subset of the RTA's own. Without the subset rule an RTA could edit a team
 *   lead shared with another account and, by reassigning them, reach accounts
 *   the RTA cannot see.
 * - Nobody else may administer anyone.
 */
export function canAdminister(actor: UserProfile, target: UserProfile): string | null {
  if (actor.role === 'superuser') return null
  if (actor.role !== 'rta') return 'You do not have permission to manage users.'
  if (target.role !== 'team_lead') return 'RTAs can only manage team leads.'
  const mine = new Set(actor.accountIds)
  const outside = target.accountIds.filter(a => !mine.has(a))
  if (outside.length) return `"${target.username}" also belongs to ${outside.join(', ')}, which you do not manage.`
  return null
}

/**
 * Validate the accounts an actor is trying to assign. An RTA may only hand out
 * accounts they themselves hold; a superuser may assign any real account.
 * Returns a cleaned, de-duplicated list.
 */
export async function validateAccountIds(actor: UserProfile, requested: string[]): Promise<string[]> {
  const unique = [...new Set((requested ?? []).map(s => String(s).trim()).filter(Boolean))]
  if (!unique.length) return []

  const { data, error } = await admin().from('wfm_accounts').select('id').in('id', unique)
  if (error) throw new Error(`account check failed: ${error.message}`)
  const real = new Set((data ?? []).map(r => r.id))
  const missing = unique.filter(id => !real.has(id))
  if (missing.length) throw new AuthError(400, `Unknown account(s): ${missing.join(', ')}`)

  if (actor.role !== 'superuser') {
    const mine = new Set(actor.accountIds)
    const outside = unique.filter(id => !mine.has(id))
    if (outside.length) throw new AuthError(403, `You cannot assign account(s) you do not manage: ${outside.join(', ')}`)
  }
  return unique
}

/** Guard against an admin locking themselves out. */
export function assertNotSelf(actor: UserProfile, targetId: string, what: string): void {
  if (actor.id === targetId) throw new AuthError(400, `You cannot ${what} your own login.`)
}
