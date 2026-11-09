// app/api/zoho/accounts-add/route.ts
// Settings → Accounts → "Add accounts from Zoho": adds the ticked Zoho accounts
// as accounts run from Zoho alone — see addZohoOnlyAccounts() in
// lib/zohoOnlyAccounts.ts. Super users only.
//
// Body: { names: string[] } — Zoho account names as a scan returned them.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { addZohoOnlyAccounts } from '@/lib/zohoOnlyAccounts'

export async function POST(req: Request) {
  try {
    await requireRole(req, ['superuser'])
    const b = await req.json().catch(() => ({}))
    const names = Array.isArray(b?.names) ? b.names.filter((n: unknown): n is string => typeof n === 'string' && !!n.trim()) : []
    if (!names.length) throw new AuthError(400, 'Which accounts? (names: [...])')
    if (names.length > 200) throw new AuthError(400, 'Too many at once (200 at most).')
    try {
      return json(await addZohoOnlyAccounts(names))
    } catch (e) {
      throw new AuthError(500, e instanceof Error ? e.message : String(e))
    }
  } catch (e) {
    return errorResponse(e)
  }
}

export const dynamic = 'force-dynamic'
