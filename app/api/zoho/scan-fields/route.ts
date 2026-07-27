// app/api/zoho/scan-fields/route.ts
// Hit by Vercel Cron once a day (see vercel.json). Protected by CRON_SECRET
// so it can't be triggered by an arbitrary public request — Vercel
// automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// invocations when that env var is set.
//
// For a manual on-demand scan (e.g. the "Scan Zoho Field Options Now"
// button in Settings), use /api/zoho/force-scan-fields instead — same
// underlying logic, no secret required since it's only ever called from
// this app's own Settings UI.

import { scanZohoFields } from '@/lib/zohoFieldScan'

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await scanZohoFields()
    return Response.json(result)
  } catch (e: any) {
    console.error('[zoho/scan-fields] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
