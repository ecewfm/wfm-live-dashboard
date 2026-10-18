// app/api/auth/bootstrap/route.ts
// Creates the very first superuser, because there is no one to authorise it
// yet. Chicken-and-egg: every other user route requires a signed-in admin.
//
// It is unauthenticated, so it is made safe by being SELF-DISABLING: the
// first thing it does is count superusers, and it refuses if there is even
// one. After you run it once the endpoint is permanently inert, and the
// account it creates is forced onto a new password at first sign-in.
//
// GET reports whether bootstrapping is still possible, so the login screen
// can tell a brand-new install apart from a forgotten password.

import { admin, errorResponse, json, AuthError } from '@/lib/authServer'
import { provisionUser } from '@/lib/userAdmin'
import { BOOTSTRAP_USERNAME, DEFAULT_PASSWORD } from '@/lib/authEmail'

async function superuserCount(): Promise<number> {
  const { count, error } = await admin()
    .from('wfm_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'superuser')
  if (error) {
    // The most likely cause by far is that sql/user_auth.sql hasn't been run.
    throw new AuthError(500, `Could not read wfm_profiles (${error.message}). Have you run sql/user_auth.sql?`)
  }
  return count ?? 0
}

export async function GET() {
  try {
    return json({ needsBootstrap: (await superuserCount()) === 0, username: BOOTSTRAP_USERNAME })
  } catch (e) { return errorResponse(e) }
}

export async function POST() {
  try {
    if ((await superuserCount()) > 0) {
      throw new AuthError(409, 'A super user already exists — bootstrap is closed. Ask them to create your account.')
    }
    const result = await provisionUser({
      username: BOOTSTRAP_USERNAME,
      fullName: 'Super User',
      role: 'superuser',
      accountIds: [],          // superusers see every account by role
    })
    return json({
      ok: true,
      username: result.username,
      tempPassword: DEFAULT_PASSWORD,
      note: 'Sign in with this password; you will be asked to choose a new one immediately.',
    })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
