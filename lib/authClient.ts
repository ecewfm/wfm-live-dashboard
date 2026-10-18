// lib/authClient.ts
// Browser-side session handling.
//
// The app is a single client-rendered page that already talks to Supabase
// directly, so sign-in uses supabase-js rather than cookies + proxy.ts. The
// Supabase client persists and refreshes the session itself; every call to a
// /api/users route attaches the current access token, which the server
// verifies (lib/authServer.ts). No role or account list is ever sent from
// here — the server derives both from the token.
//
// The profile read below works because sql/user_auth.sql grants exactly one
// policy on each user table: "you may SELECT your own row". There is no
// write policy at all, which is why changing a password goes through
// /api/auth/password instead of a direct update.

'use client'

import { supabase } from './supabase'
import { UserProfile, UserRole, authEmailForUsername } from './authEmail'

export interface SignInResult {
  ok: boolean
  error?: string
  profile?: UserProfile
}

/** The generic failure text. Never reveal whether a username exists. */
const BAD_CREDENTIALS = 'Incorrect username or password.'

export async function signIn(username: string, password: string): Promise<SignInResult> {
  const email = authEmailForUsername(username)
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data?.user) {
    // A deactivated user is banned in auth, so Supabase rejects them here and
    // the message stays generic — we don't confirm the account exists.
    return { ok: false, error: BAD_CREDENTIALS }
  }

  const profile = await loadMyProfile()
  if (!profile) {
    await supabase.auth.signOut()
    return { ok: false, error: 'Your login has no profile. Ask a super user to re-create it.' }
  }
  if (!profile.isActive) {
    await supabase.auth.signOut()
    return { ok: false, error: 'This account has been deactivated.' }
  }
  return { ok: true, profile }
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

/** The signed-in user's own profile, or null if there is no session. */
export async function loadMyProfile(): Promise<UserProfile | null> {
  const { data: sess } = await supabase.auth.getSession()
  const uid = sess?.session?.user?.id
  if (!uid) return null

  const { data: p, error } = await supabase
    .from('wfm_profiles')
    .select('id, username, full_name, role, must_reset_password, is_active')
    .eq('id', uid)
    .maybeSingle()
  if (error || !p) return null

  const { data: rows } = await supabase
    .from('wfm_user_accounts').select('account_id').eq('user_id', uid)

  return {
    id: p.id,
    username: p.username,
    fullName: p.full_name,
    role: p.role as UserRole,
    mustResetPassword: !!p.must_reset_password,
    isActive: !!p.is_active,
    accountIds: (rows ?? []).map(r => r.account_id),
  }
}

/** Current access token, refreshed by supabase-js if it was close to expiry. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token ?? null
}

/**
 * fetch() against this app's own API with the bearer token attached.
 * Throws with the server's message so callers can surface it directly.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken()
  if (!token) throw new Error('Your session has expired. Please sign in again.')

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  // Don't set Content-Type for FormData — the browser must add the multipart
  // boundary itself, and overriding it breaks the upload.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(path, { ...init, headers })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }

  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
  return body
}

/** Set your own password; also clears the forced-reset flag server-side. */
export async function setMyPassword(password: string, confirm: string): Promise<void> {
  await apiFetch('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ password, confirm }),
  })
}

/** Fires on sign-in, sign-out and token refresh. Returns an unsubscribe fn. */
export function onAuthChange(cb: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange(() => cb())
  return () => data.subscription.unsubscribe()
}
