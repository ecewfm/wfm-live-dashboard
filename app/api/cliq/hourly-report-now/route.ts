// app/api/cliq/hourly-report-now/route.ts
// Settings → Zoho Integrations → Hourly report to Cliq → "Send the last hour now":
// the report for the hour that just ended, sent right away to the channel and with
// the settings shown in the modal (saved or not). A one-off — it doesn't count as
// that hour's automatic report. See sendHourlyReportNow() in lib/hourlyCliq.ts.
//
// Body: { accountId, channel, config: { tz?, mode?, hiddenGroups? } }.
// Super users and RTAs (the roles that edit Settings); an RTA only for an
// account assigned to them.

import { requireRole, errorResponse, json, AuthError } from '@/lib/authServer'
import { sendHourlyReportNow } from '@/lib/hourlyCliq'

export const maxDuration = 60

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
    }
    return json(await sendHourlyReportNow(accountId, { channel, config }))
  } catch (e) {
    return errorResponse(e)
  }
}

export const dynamic = 'force-dynamic'
