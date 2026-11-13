// app/api/cliq/hourly-report-now/route.ts
// Settings → Zoho Integrations → Hourly report to Cliq → "Send the last hour now":
// the report for the hour that just ended, sent right away to the channel and with
// the settings shown in the modal (saved or not). A one-off — it doesn't count as
// that hour's automatic report. See sendHourlyReportNow() in lib/hourlyCliq.ts.
//
// Body: { accountId, channel, config: { tz?, mode?, hiddenGroups?, picturePerGroup? } }.
// Super users and RTAs (the roles that edit Settings); an RTA only for an
// account assigned to them.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { sendHourlyReportNow } from '@/lib/hourlyCliq'

// Builds the report, then draws and uploads one picture per KPI group — 60 s cut off
// Ashley Digital's after the 2nd of 3 pictures (2026-11-13). Vercel Pro allows 300.
export const maxDuration = 300

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    const body = await req.json().catch(() => ({}))
    const accountId = String(body?.accountId || '').trim()
    if (!accountId) throw new AuthError(400, 'Which account? (accountId)')
    if (me.role !== 'superuser' && !me.accountIds.includes(accountId)) throw new AuthError(403, 'That account isn\'t assigned to you.')
    const channel = String(body?.channel || '').trim()
    if (!channel) throw new AuthError(400, 'Enter the account\'s Cliq channel first.')
    const c = body?.config && typeof body.config === 'object' ? body.config : {}
    const config = {
      tz: typeof c.tz === 'string' ? c.tz : undefined,
      mode: c.mode === 'avg' || c.mode === 'worst' || c.mode === 'last' ? c.mode : undefined,
      hiddenGroups: Array.isArray(c.hiddenGroups) ? c.hiddenGroups.filter((g: unknown) => typeof g === 'string') : undefined,
      picturePerGroup: c.picturePerGroup === true,
    }
    return json(await sendHourlyReportNow(accountId, { channel, config }))
  } catch (e) {
    return errorResponse(e)
  }
}

export const dynamic = 'force-dynamic'
