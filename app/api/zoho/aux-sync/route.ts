// app/api/zoho/aux-sync/route.ts
// Hit by Vercel Cron every minute (vercel.json). Keeps every enabled account's
// "Zoho Breaks & Aux" agent section current — see lib/zohoAux.ts. Calls Zoho
// only when today's cached copy is older than the pull interval (default 5 min),
// and not at all while no account has the feature on; the other runs just
// re-match the cached logs against each account's agents.
//
// Protected by CRON_SECRET, same as /api/cliq/scan. The Settings button uses
// /api/zoho/aux-sync-now instead.

import { runZohoAuxSync } from '@/lib/zohoAux'

export const maxDuration = 60

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return Response.json(await runZohoAuxSync({ force: false }))
  } catch (e: any) {
    console.error('[zoho/aux-sync] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
