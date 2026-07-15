// lib/breaches.ts
// The single, canonical breach-detection algorithm — shared by the live
// Dashboard/Overview pages (client-side, via components/Dashboard.tsx) AND
// the Zoho Cliq scan (server-side, via app/api/cliq/scan/route.ts). Keeping
// this in one place means there is never a second copy to drift out of sync
// — whichever thresholds/KPI logic you see on screen is exactly what the
// Cliq alert used to decide whether to fire.

import type { AccountData, Thresholds, DataSourceConfig } from './types'
import { extractPercent, parseDurationToSeconds, formatSeconds, resolveCell, type StatusThresholds } from './utils'

export interface BreachRow {
  entity: string; metric: string; value: string; threshold: string
  severity: 'warning' | 'critical'
}

// ── Freshest updated_at across all of an account's KPI rows ───────────────────
// Rows are fetched with no guaranteed order, and an orphaned row from a LOB the
// scraper no longer reports (never re-written, so it stays frozen at whatever
// time it last succeeded) can otherwise get picked arbitrarily and make the
// whole account look stale even though the LOBs actually shown are live. Using
// the MAX across all rows reflects whether the account is actually being scraped.
export function mostRecentUpdatedAt(rows: Record<string, any>[], colName: string): string | undefined {
  let best: string | undefined
  for (const row of rows) {
    const v = row?.[colName]
    if (!v) continue
    if (!best || new Date(v).getTime() > new Date(best).getTime()) best = v
  }
  return best
}

// ── Build breaches for one account ────────────────────────────────────────────
// agentTimers: live in-memory ticking timers, keyed `${accountId}:${agentName}`
// — a browser-UI-only feature (Dashboard.tsx ticks these every second between
// polls). Server-side callers with no such concept should pass {} — duration
// then always falls back to parseDurationToSeconds(a._duration), same as the
// browser does for any agent without a timer entry yet.
export function buildBreaches(
  accountId: string, accountData: AccountData | undefined,
  agentTimers: Record<string, number>, kpiTh: Thresholds,
  statusTh: StatusThresholds, ds: DataSourceConfig
): BreachRow[] {
  if (!accountData) return []
  const rows: BreachRow[] = []
  const kpiRows = accountData.kpiRows ?? []

  const checkKpi = (
    num: number, th: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean },
    entity: string, metric: string, value: string, thLabel: string
  ) => {
    if (isNaN(num)) return
    if (th.excludeZero && num === 0) return
    const isCrit = th.direction === 'desc' ? num <= th.crit : num >= th.crit
    const isWarn = th.direction === 'desc' ? num <= th.warn : num >= th.warn
    if (isCrit)       rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical' })
    else if (isWarn)  rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning'  })
  }

  // KPI breaches — one pass per manually-defined group
  ;(ds.groups ?? []).forEach(group => {
    const g       = group.name || 'KPI'
    const rc      = (b: any) => resolveCell(kpiRows, b, ds.kpiGroupCol, group.groupVal)
    const slaRaw  = rc(group.cells.sla)
    const waitRaw = rc(group.cells.wait)
    const ahtRaw  = rc(group.cells.aht)
    const abnRaw  = rc(group.cells.abn)

    if (group.cells.sla)  checkKpi(extractPercent(slaRaw), kpiTh.sla, g, ds.kpiLabels.sla, slaRaw.replace(/\s+/g,''), `≥${kpiTh.sla.targ}%`)
    if (group.cells.wait) { const n = parseInt(waitRaw || '0'); checkKpi(n, kpiTh.wait, g, ds.kpiLabels.wait, String(n), String(kpiTh.wait.targ)) }
    if (group.cells.aht)  { const m = Math.round(parseDurationToSeconds(ahtRaw) / 60); if (m > 0) checkKpi(m, kpiTh.aht, g, ds.kpiLabels.aht, ahtRaw, `<${kpiTh.aht.targ}m`) }
    if (group.cells.abn)  checkKpi(extractPercent(abnRaw), kpiTh.abn, g, ds.kpiLabels.abn, abnRaw.replace(/\s+/g,''), `<${kpiTh.abn.targ}%`)

    // Extra custom tiles carry their own thresholds
    ;(ds.extraTiles ?? []).forEach(t => {
      if (!group.cells[t.key]) return
      const raw = rc(group.cells[t.key])
      const num = extractPercent(raw)
      if (isNaN(num)) return
      const dir: 'asc' | 'desc' = t.higherIsBetter ? 'desc' : 'asc'
      checkKpi(num, { warn: t.warn, crit: t.crit, direction: dir }, g, t.label, raw, String(t.targ))
    })
  })

  // Agent status breaches — agents are pre-normalized in fetchAccount to
  // _name/_status/_duration regardless of single-table vs agentSources.
  accountData.agents.forEach(a => {
    const status = String(a._status ?? '')
    const thSt   = statusTh[status]
    if (!thSt || thSt.crit >= 999 || thSt.excluded) return
    const name  = String(a._name ?? '')
    const key   = `${accountId}:${name}`
    const secs  = agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
    const mins  = secs / 60
    const dur   = formatSeconds(secs)
    if (mins >= thSt.crit)       rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.crit}m`, severity: 'critical' })
    else if (mins >= thSt.warn)  rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.warn}m`, severity: 'warning'  })
  })

  return rows
}
