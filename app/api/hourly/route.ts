// app/api/hourly/route.ts
// The Hourly page's data for one account and day — its KPI hours and its people
// in Zoho (shifts + Time Tracker sessions), see getHourlyReport() in
// lib/hourlyReportServer.ts. Server-side because the Zoho caches (every
// employee's shifts and logs) are service-role only, so the role check on the
// first line is what protects them: super users and RTAs, an RTA only for an
// account assigned to them.
//
// Query: account=<id>, date=YYYY-MM-DD, tz=<one of HOURLY_TIMEZONES>.
// May pull from Zoho first (a date it hasn't got, or an old copy), hence the
// longer maxDuration.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { getHourlyReport } from '@/lib/hourlyReportServer'
import { isHourlyTz } from '@/lib/hourlyReport'

export const maxDuration = 60

export async function GET(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const p = new URL(req.url).searchParams
    const account = (p.get('account') || '').trim()
    if (!account) throw new AuthError(400, 'Which account? (account=…)')
    if (me.role !== 'superuser' && !me.accountIds.includes(account)) throw new AuthError(403, 'That account isn\'t assigned to you.')
    const date = p.get('date') || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new AuthError(400, 'date must be YYYY-MM-DD.')
    // Schedules look ahead; nothing further than two weeks out is worth a Zoho pull.
    if (Date.parse(date) > Date.now() + 14 * 86400e3) throw new AuthError(400, 'That date is too far ahead — up to two weeks from today.')
    const tz = p.get('tz') || ''
    if (!isHourlyTz(tz)) throw new AuthError(400, 'Unknown time zone.')
    return json(await getHourlyReport(account, date, tz))
  } catch (e) {
    return errorResponse(e)
  }
}

// Session-dependent and never cacheable.
export const dynamic = 'force-dynamic'
