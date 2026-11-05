// app/api/zoho/crm-match/route.ts
// Settings → Zoho ↔ CRM's data: the account's Zoho people with their Zoho status
// right now, the Zoho types they use, and the mismatches the check last stored —
// see getZohoCrmMatchInfo() in lib/zohoAux.ts. Server-side because the Zoho
// cache (every employee's logs) is service-role only, so the role check on the
// first line is what protects it: the roles that can edit settings, and an RTA
// only for an account assigned to them.
//
// Query: account=<id>, plus the modal's current (maybe unsaved) "Zoho Account"
// (zohoAccounts) and "Extra Zoho names" (extraNames), one per line.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { getZohoCrmMatchInfo } from '@/lib/zohoAux'

export async function GET(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const p = new URL(req.url).searchParams
    const account = (p.get('account') || '').trim()
    if (!account) throw new AuthError(400, 'Which account? (account=…)')
    if (me.role !== 'superuser' && !me.accountIds.includes(account)) throw new AuthError(403, 'That account isn\'t assigned to you.')
    return json(await getZohoCrmMatchInfo(account, {
      zohoAccounts: (p.get('zohoAccounts') || '').slice(0, 2000),
      extraNames: (p.get('extraNames') || '').slice(0, 5000),
    }))
  } catch (e) {
    return errorResponse(e)
  }
}

// Session-dependent and never cacheable.
export const dynamic = 'force-dynamic'
