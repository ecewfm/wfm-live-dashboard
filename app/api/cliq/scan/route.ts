// app/api/cliq/scan/route.ts
// Hit by Vercel Cron on the schedule in vercel.json (every minute). Protected
// by CRON_SECRET so it can't be triggered by an arbitrary public request —
// Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// invocations when that env var is set.
//
// For a manual on-demand scan (e.g. a "Force Scan Now" button), use
// /api/cliq/force-scan instead — same underlying logic, no secret required
// since it's only ever called from this app's own Settings UI.

import { runCliqScan } from '@/lib/cliqScan'

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await runCliqScan({ forceSend: false })
    return Response.json(result)
  } catch (e: any) {
    console.error('[cliq/scan] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
