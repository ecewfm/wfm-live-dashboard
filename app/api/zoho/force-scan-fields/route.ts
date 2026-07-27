// app/api/zoho/force-scan-fields/route.ts
// Manual "Scan Zoho Field Options Now" trigger — called from Settings >
// Zoho Integrations. Same scan logic as the scheduled daily
// /api/zoho/scan-fields (Vercel Cron). No secret check: this app has no auth
// layer anywhere else either, so this matches the existing security posture
// rather than introducing a one-off exception.

import { scanZohoFields } from '@/lib/zohoFieldScan'

export async function POST() {
  try {
    const result = await scanZohoFields()
    return Response.json(result)
  } catch (e: any) {
    console.error('[zoho/force-scan-fields] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
