// app/api/auth/password/route.ts
// The signed-in user setting their OWN password (first sign-in, or a later
// voluntary change).
//
// This is a server route rather than a plain supabase.auth.updateUser() call
// in the browser because clearing must_reset_password is a write to
// wfm_profiles, and browsers have no write access to that table by design.
// Doing both here keeps them atomic from the user's point of view — there is
// no window where the password changed but the forced-reset screen persists.

import { requireUser, errorResponse, json, AuthError } from '@/lib/authServer'
import { setOwnPassword } from '@/lib/userAdmin'
import { validateNewPassword } from '@/lib/authEmail'

export async function POST(req: Request) {
  try {
    // Note: requireUser allows a user whose must_reset_password is still true
    // — that is exactly who calls this.
    const me = await requireUser(req)
    const body = await req.json().catch(() => ({}))
    const password = String(body.password ?? '')

    // Same validator the client form uses, so the rules cannot drift apart.
    const bad = validateNewPassword(password, body.confirm === undefined ? undefined : String(body.confirm))
    if (bad) throw new AuthError(400, bad)

    await setOwnPassword(me.id, password)
    return json({ ok: true })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
