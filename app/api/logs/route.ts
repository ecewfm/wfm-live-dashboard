// app/api/logs/route.ts
// The Loggings page's data — every Cliq message and Workforce RTA Logs
// submission the webapp made (lib/notificationLog.ts). Super users only: the
// table is RLS-locked and read here with the service-role key, so the role
// check on the first line is the only thing protecting it.
//
// Query: kind=cliq|rta_log, status=sent|failed, account=<id>,
// since=<ISO time>, q=<search> (+ names=<account ids whose display name
// matched it>), limit (≤ 200, a page's size), page=<n> (1 = newest) and
// upTo=<row id> — the newest id of the view's first page, so the pages after
// it don't shift as new rows are logged. first=1 also returns the matching
// total (the page count) and the 24 h counts.

import { requireRole, errorResponse, json } from '@/lib/authServer'
import { listNotifications, notificationCounts, LogTableMissing, type NotificationKind, type NotificationStatus } from '@/lib/notificationLog'

export async function GET(req: Request) {
  try {
    await requireRole(req, ['superuser'])
    const p = new URL(req.url).searchParams
    const kind = p.get('kind')
    const status = p.get('status')
    const since = p.get('since')
    const upTo = Number(p.get('upTo'))
    const upToId = Number.isFinite(upTo) && upTo > 0 ? upTo : undefined
    const limit = Math.min(Math.max(Number(p.get('limit')) || 20, 1), 200)
    const page = Math.max(Math.floor(Number(p.get('page'))) || 1, 1)
    const first = p.get('first') === '1'
    const search = (p.get('q') || '').trim().slice(0, 100)
    const names = (p.get('names') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)

    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [list, counts] = await Promise.all([
      listNotifications({
        kind: kind === 'cliq' || kind === 'rta_log' ? kind as NotificationKind : undefined,
        status: status === 'sent' || status === 'failed' ? status as NotificationStatus : undefined,
        accountId: p.get('account') || undefined,
        sinceIso: since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : undefined,
        search: search || undefined,
        searchAccountIds: search ? names : undefined,
        upToId,
        offset: (page - 1) * limit,
        limit,
        withTotal: first,
      }),
      first ? notificationCounts(day) : null,
    ])
    return json({
      rows: list.rows,
      upTo: upToId ?? list.rows[0]?.id ?? null,
      ...(first ? { total: list.total ?? 0, counts } : {}),
    })
  } catch (e) {
    if (e instanceof LogTableMissing) return json({ rows: [], upTo: null, total: 0, counts: null, needsMigration: true })
    return errorResponse(e)
  }
}

// Session-dependent and never cacheable.
export const dynamic = 'force-dynamic'
