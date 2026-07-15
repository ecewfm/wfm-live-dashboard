// app/api/cliq/force-scan/route.ts
// Manual "Force Scan Now" trigger — called from the Settings > Cliq Alerts
// tab. Same scan logic as the scheduled /api/cliq/scan (Vercel Cron), but
// bypasses the per-account cooldown (NOT the staleness suppression — mirrors
// the old GAS tool's "Force Scan" button exactly). No secret check: this app
// has no auth layer anywhere else either, so this matches the existing
// security posture rather than introducing a one-off exception.

import { runCliqScan } from '@/lib/cliqScan'

export async function POST() {
  try {
    const result = await runCliqScan({ forceSend: true })
    return Response.json(result)
  } catch (e: any) {
    console.error('[cliq/force-scan] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
