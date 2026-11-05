// app/api/cliq/hourly-report/route.ts
// Hit by Vercel Cron every minute (vercel.json). From 2 to 30 minutes past each
// hour it sends the hourly report (message + picture of the day's table) to Cliq
// for the accounts that have it on and haven't had that hour's yet, a few per
// minute — see runHourlyCliqReports() in lib/hourlyCliq.ts. Outside that window
// it returns straight away.
//
// Protected by CRON_SECRET, same as /api/cliq/scan.

import { runHourlyCliqReports } from '@/lib/hourlyCliq'

// Can pull Zoho's time logs / schedules for the day first, then draw and upload pictures.
export const maxDuration = 120

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return Response.json(await runHourlyCliqReports())
  } catch (e: any) {
    console.error('[cliq/hourly-report] failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
