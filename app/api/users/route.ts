// app/api/users/route.ts
// List / create / update / delete users.
//
// Ids travel in the body or query string rather than a [id] path segment: in
// Next 16 a dynamic segment's `params` is a Promise that must be awaited, and
// there is nothing to gain from the extra route file here.
//
// Every handler calls a guard on its FIRST line. The service-role key below
// bypasses RLS completely, so that guard is the only thing protecting this.

import { requireRole, canAdminister, validateAccountIds, assertNotSelf, errorResponse, json, loadProfile, AuthError } from '@/lib/authServer'
import { listUsers, provisionUser, updateUser, setActive, deleteUser, resetPassword } from '@/lib/userAdmin'
import { can, UserRole } from '@/lib/authEmail'

export async function GET(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    return json({ users: await listUsers(me), me })
  } catch (e) { return errorResponse(e) }
}

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const body = await req.json().catch(() => ({}))

    const role = body.role as UserRole
    if (!can.assignableRoles(me.role).includes(role)) {
      throw new AuthError(403, `You cannot create ${role ? `"${role}"` : 'that kind of'} users.`)
    }
    const accountIds = await validateAccountIds(me, body.accountIds ?? [])

    const result = await provisionUser({
      username: body.username ?? '',
      fullName: body.fullName ?? '',
      role,
      accountIds,
    })
    return json({ ok: true, ...result })
  } catch (e) { return errorResponse(e) }
}

export async function PATCH(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const body = await req.json().catch(() => ({}))
    const targetId = String(body.id || '')
    if (!targetId) throw new AuthError(400, 'Which user?')

    const target = await loadProfile(targetId)
    if (!target) throw new AuthError(404, 'That user no longer exists.')
    const denied = canAdminister(me, target)
    if (denied) throw new AuthError(403, denied)

    // Separate actions so one endpoint doesn't need a mode flag.
    if (body.action === 'reset-password') {
      const tempPassword = await resetPassword(targetId)
      return json({ ok: true, tempPassword })
    }
    if (body.action === 'set-active') {
      // Deactivating yourself would end your own session on the next refresh.
      if (body.isActive === false) assertNotSelf(me, targetId, 'deactivate')
      await setActive(targetId, body.isActive !== false)
      return json({ ok: true })
    }

    // Plain edit. Editable here: full name, role, accounts. NOT the username — it is
    // what the login's auth address is derived from (lib/authEmail), so it is chosen
    // once at creation; any `username` in the body is ignored on purpose.
    //
    // Re-sending the role someone already has is not a change, so an admin can
    // still rename THEMSELVES — only an actual change to your own role is refused.
    const roleChange = body.role !== undefined && body.role !== target.role ? body.role : undefined
    if (roleChange !== undefined) {
      // Changing your own role is how an admin accidentally demotes themselves
      // out of the ability to change it back.
      assertNotSelf(me, targetId, 'change the role of')
      if (!can.assignableRoles(me.role).includes(roleChange)) {
        throw new AuthError(403, `You cannot grant the "${roleChange}" role.`)
      }
    }
    const accountIds = body.accountIds === undefined
      ? undefined
      : await validateAccountIds(me, body.accountIds)

    await updateUser(targetId, { fullName: body.fullName, role: roleChange, accountIds })
    return json({ ok: true })
  } catch (e) { return errorResponse(e) }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const targetId = new URL(req.url).searchParams.get('id') || ''
    if (!targetId) throw new AuthError(400, 'Which user?')
    assertNotSelf(me, targetId, 'delete')

    const target = await loadProfile(targetId)
    if (!target) return json({ ok: true })          // already gone
    const denied = canAdminister(me, target)
    if (denied) throw new AuthError(403, denied)

    await deleteUser(targetId)
    return json({ ok: true })
  } catch (e) { return errorResponse(e) }
}

// Session-dependent and never cacheable. GET route handlers have defaulted to
// dynamic since 15, so this is belt-and-braces rather than load-bearing.
export const dynamic = 'force-dynamic'
