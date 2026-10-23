// app/api/zoho/aux-status/route.ts
// When Zoho breaks & aux were last pulled (for today) — shown in Settings →
// Zoho Integrations. Server-side because wfm_zoho_sync is service-role only.

import { getZohoAuxStatus } from '@/lib/zohoAux'

export async function GET() {
  try {
    return Response.json(await getZohoAuxStatus())
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
