// app/api/zoho/test-rta-log/route.ts
// Manual "Test Workforce RTA Logs" trigger — called from Settings > Zoho
// Integrations. Submits a real, clearly-tagged test record (no Zoho sandbox
// exists for this intake) so the user can confirm in Zoho itself that the
// payload format is accepted. No secret check: matches this app's existing
// security posture (see the other force-* routes in this same directory).

import { testAccountBreachRtaLog } from '@/lib/zohoWebappRequest'

export async function POST(req: Request) {
  let accountId: string | undefined
  try {
    const body = await req.json()
    accountId = body?.accountId
  } catch {
    // no body — accountId stays undefined, caught below
  }

  if (!accountId) {
    return Response.json({ error: 'accountId is required' }, { status: 400 })
  }

  try {
    const result = await testAccountBreachRtaLog(accountId)
    return Response.json(result)
  } catch (e: any) {
    console.error('[zoho/test-rta-log] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
