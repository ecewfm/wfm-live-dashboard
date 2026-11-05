// app/api/kpi/hourly-snapshot/route.ts
// Hit by Vercel Cron every minute (vercel.json). Reads every account's KPI tiles
// and folds the reading into the current hour's record — the Hourly page's KPI
// columns (see runKpiHourlySnapshot() in lib/hourlyReportServer.ts). The CRMs only
// give live numbers, so a minute this doesn't run is a reading that's gone.
//
// Protected by CRON_SECRET, same as /api/cliq/scan.

import { runKpiHourlySnapshot, HourlyTableMissing, HOURLY_SQL_HINT } from '@/lib/hourlyReportServer'

export const maxDuration = 60

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return Response.json(await runKpiHourlySnapshot())
  } catch (e: any) {
    if (e instanceof HourlyTableMissing) return Response.json({ error: `The KPI readings table is missing — ${HOURLY_SQL_HINT}.` }, { status: 500 })
    console.error('[kpi/hourly-snapshot] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
