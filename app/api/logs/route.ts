// app/api/logs/route.ts
// The Loggings page's data — every Cliq message and Workforce RTA Logs
// submission the webapp made (lib/notificationLog.ts). Super users only: the
// table is RLS-locked and read here with the service-role key, so the role
// check on the first line is the only thing protecting it.
//
// Query: kind=cliq|rta_log, status=sent|failed, account=<id>,
// since=<ISO time>, before=<row id> (the next, older page), limit (≤ 200).

import { requireRole, errorResponse, json } from '@/lib/authServer'
import { listNotifications, notificationCounts, LogTableMissing, type NotificationKind, type NotificationStatus } from '@/lib/notificationLog'

export async function GET(req: Request) {
  try {
    await requireRole(req, ['superuser'])
    const p = new URL(req.url).searchParams
    const kind = p.get('kind')
    const status = p.get('status')
    const since = p.get('since')
    const before = Number(p.get('before'))
    const limit = Math.min(Math.max(Number(p.get('limit')) || 100, 1), 200)

    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [list, counts] = await Promise.all([
      listNotifications({
        kind: kind === 'cliq' || kind === 'rta_log' ? kind as NotificationKind : undefined,
        status: status === 'sent' || status === 'failed' ? status as NotificationStatus : undefined,
        accountId: p.get('account') || undefined,
        sinceIso: since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : undefined,
        beforeId: Number.isFinite(before) && before > 0 ? before : undefined,
        limit,
      }),
      notificationCounts(day),
    ])
    return json({ ...list, counts })
  } catch (e) {
    if (e instanceof LogTableMissing) return json({ rows: [], hasMore: false, counts: null, needsMigration: true })
    return errorResponse(e)
  }
}

// Session-dependent and never cacheable.
export const dynamic = 'force-dynamic'
