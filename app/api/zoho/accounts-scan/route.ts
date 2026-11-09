// app/api/zoho/accounts-scan/route.ts
// Settings → Accounts → "Scan Zoho": every account on today's Zoho schedule or
// in today's Time Tracker logs, and whether WFM Live already has it — see
// scanZohoAccounts() in lib/zohoOnlyAccounts.ts. Super users only (the Zoho
// caches are service-role only, and this is account management). May pull
// today's schedules / time logs first if the cached copy is old.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { scanZohoAccounts } from '@/lib/zohoOnlyAccounts'

export const maxDuration = 60

export async function GET(req: Request) {
  try {
    await requireRole(req, ['superuser'])
    try {
      return json(await scanZohoAccounts())
    } catch (e) {
      // Its own errors (Zoho, Supabase) are worth showing a super user as they are.
      throw new AuthError(500, e instanceof Error ? e.message : String(e))
    }
  } catch (e) {
    return errorResponse(e)
  }
}

export const dynamic = 'force-dynamic'
