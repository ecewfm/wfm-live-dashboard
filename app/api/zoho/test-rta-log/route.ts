// app/api/zoho/test-rta-log/route.ts
// Manual "Test Workforce RTA Logs" trigger — called from Settings > Zoho
// Integrations. Submits a real, clearly-tagged test record (no Zoho sandbox
// exists for this intake) so the user can confirm in Zoho itself that the
// payload format is accepted. No secret check: matches this app's existing
// security posture (see the other force-* routes in this same directory).

import { testAccountBreachRtaLog } from '@/lib/zohoWebappRequest'
import { getZohoAuthorizedAccountInfo } from '@/lib/zohoAuth'

export async function POST(req: Request) {
  let accountId: string | undefined
  let sites: string[] = []
  let zohoAccountName: string | undefined
  try {
    const body = await req.json()
    accountId = body?.accountId
    sites = Array.isArray(body?.sites) ? body.sites.filter(Boolean) : []
    zohoAccountName = body?.zohoAccountName || undefined
  } catch {
    // no body — accountId stays undefined, caught below
  }

  if (!accountId) {
    return Response.json({ error: 'accountId is required' }, { status: 400 })
  }

  // Runs alongside the actual write attempt (not blocking it) — identifies
  // which Zoho account the stored token belongs to, so a permission error
  // (code 2899) can be diagnosed without guessing from browser screenshots.
  // Soft-fails to null (e.g. token minted before AaaServer.profile.READ was
  // added to the scope list) without affecting the write attempt itself.
  const [result, authorizedAs] = await Promise.all([
    testAccountBreachRtaLog(zohoAccountName || accountId, sites).catch((e: any) => ({ __threw: true, message: e.message })),
    getZohoAuthorizedAccountInfo(),
  ])

  if (result && (result as any).__threw) {
    console.error('[zoho/test-rta-log] failed:', (result as any).message)
    return Response.json({ error: (result as any).message, authorizedAs }, { status: 500 })
  }

  return Response.json({ ...result, authorizedAs })
}
