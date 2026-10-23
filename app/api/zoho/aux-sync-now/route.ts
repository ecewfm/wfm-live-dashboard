// app/api/zoho/aux-sync-now/route.ts
// "Pull Zoho breaks & aux now" — Settings → Zoho Integrations. Same run as the
// cron (/api/zoho/aux-sync) but pulls from Zoho straight away instead of waiting
// for the interval, and returns the log (what was pulled, and per account how
// many agents matched) for the panel to show. No secret, matching this app's
// other force-* routes (/api/cliq/force-scan, /api/zoho/force-scan-fields).

import { runZohoAuxSync } from '@/lib/zohoAux'

export const maxDuration = 60

export async function POST() {
  try {
    return Response.json(await runZohoAuxSync({ force: true }))
  } catch (e: any) {
    console.error('[zoho/aux-sync-now] failed:', e)
    return Response.json({ error: e.message, log: [`Failed: ${e.message}`] }, { status: 500 })
  }
}
