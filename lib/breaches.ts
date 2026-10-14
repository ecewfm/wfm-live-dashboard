// lib/breaches.ts
// The single, canonical breach-detection algorithm — shared by the live
// Dashboard/Overview pages (client-side, via components/Dashboard.tsx) AND
// the Zoho Cliq scan (server-side, via app/api/cliq/scan/route.ts). Keeping
// this in one place means there is never a second copy to drift out of sync
// — whichever thresholds/KPI logic you see on screen is exactly what the
// Cliq alert used to decide whether to fire.

import type { AccountData, Thresholds, DataSourceConfig, AgentSource, RtaReportFlags } from './types'
import { extractPercent, parseDurationToSeconds, formatSeconds, resolveCell, type StatusThresholds } from './utils'

// ── Normalize one raw agent row from a configured AgentSource ────────────────
// CANONICAL — used by BOTH components/Dashboard.tsx (client, live polling)
// AND lib/cliqScan.ts (server, the Cliq/Workforce Logs/RTA Logs scan) so
// there is only ever one implementation of "how a raw table row becomes a
// breach-checkable agent", same reasoning as buildBreaches() itself below.
// CONFIRMED this drifted out of sync once already (2026-09-29): the
// server-side copy in lib/cliqScan.ts never mapped _extra_*/_extraDuration_*/
// _extraMetric_* at all, silently making every TEXT-BASED custom-column
// breach (AgentExtraColumn.breachText, e.g. Wyze's "Out of adherence")
// invisible to the Cliq/Workforce Logs/RTA Logs scan — Cliq alerts and
// Workforce Logs had been silently blind to this breach TYPE this whole
// time, not just the newer RTA Logs AI test that surfaced it.
export function normalizeAgentRow(row: Record<string, any>, src: AgentSource): Record<string, any> {
  const out: Record<string, any> = {
    ...row,
    _agentGroup:   src.groupByCol ? String(row[src.groupByCol] ?? '') : src.label,
    _name:         String(row[src.nameCol]     ?? ''),
    _status:       String(row[src.statusCol]   ?? ''),
    _duration:     String(row[src.durationCol] ?? ''),
    _durationSecs: src.durationSecsCol ? String(row[src.durationSecsCol] ?? '') : '',
  }
  Object.keys(src.extraCols || {}).forEach(key => {
    const colName = src.extraCols[key]
    if (colName) out[`_extra_${key}`] = String(row[colName] ?? '')
    const durCol = src.extraDurationCols?.[key]
    if (durCol) out[`_extraDuration_${key}`] = String(row[durCol] ?? '')
    const metricCol = src.extraMetricCols?.[key]
    if (metricCol) out[`_extraMetric_${key}`] = String(row[metricCol] ?? '')
  })
  return out
}

// ── Which extra KPI tables does this account's config actually need? ───────
// CANONICAL — used by BOTH components/Dashboard.tsx (client fetch) AND
// lib/cliqScan.ts (server fetch) so there is only ever one implementation of
// "given a DataSourceConfig, which distinct per-group source tables need
// fetching, and which group id(s) does each one feed" — same reasoning as
// normalizeAgentRow() above (and the SAME class of client/server drift bug
// that one was fixed for, avoided here by sharing this from the start
// instead of writing it twice). Pure — no Supabase client, no I/O — each
// caller does its own `.from(table).select('*').eq(accountCol, accountId)`
// with its own client (anon client in the browser, service/anon in
// cliqScan.ts), then threads the results back keyed by group id the same
// way via kpiRowsByGroup.
export interface KpiGroupSourceQuery {
  key:        string    // dedup key, "table::accountCol" — identical source config shared by multiple groups fetches once
  table:      string
  accountCol: string
  groupIds:   string[]
}

export function collectKpiGroupSourceQueries(ds: DataSourceConfig): KpiGroupSourceQuery[] {
  const map = new Map<string, KpiGroupSourceQuery>()
  ;(ds.groups ?? []).forEach(g => {
    if (!g.source || !g.source.table) return
    const accountCol = g.source.accountCol || 'account_id'
    const key = `${g.source.table}::${accountCol}`
    if (!map.has(key)) map.set(key, { key, table: g.source.table, accountCol, groupIds: [] })
    map.get(key)!.groupIds.push(g.id)
  })
  return [...map.values()]
}

// ── Shared warn/crit evaluation — used by both the breach-row builder below
// AND collectRtaKpiSignals() so the two never silently drift apart on what
// counts as breaching.
function evalThreshold(
  num: number, th: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
): { isCrit: boolean; isWarn: boolean } {
  if (th.excludeZero && num === 0) return { isCrit: false, isWarn: false }
  return {
    isCrit: th.direction === 'desc' ? num <= th.crit : num >= th.crit,
    isWarn: th.direction === 'desc' ? num <= th.warn : num >= th.warn,
  }
}

export interface RtaKpiSignal {
  key:         string   // stable id `${groupId}:${tileKey}` — survives label renames, unlike BreachRow's entity+metric
  entity:      string   // group name
  metric:      string   // tile label
  value:       string
  threshold:   string
  severity:    'warning' | 'critical' | null   // null = not currently breaching (only possible when wantsHeartbeat)
  // Independent checkboxes, not mutually exclusive — both can be true for
  // the same KPI (see RtaReportFlags in lib/types.ts).
  wantsHeartbeat:    boolean
  wantsBreachChange: boolean
}

// ── RTA Logs per-KPI reporting flags — EVERY KPI threshold gets this
// control: the 4 generic Thresholds keys (sla/wait/aht/abn), each GroupTile
// on an independent-tiles group, and each account-wide ExtraTile. See
// RtaReportFlags in lib/types.ts. Deliberately a SEPARATE pass from
// buildBreaches(), not a side-channel on it: the heartbeat flag needs a
// KPI's CURRENT value even when it is NOT breaching, and buildBreaches()
// only ever pushes a row when something IS breaching — every other consumer
// (Cliq, Workforce Logs, the live Dashboard/Overview breach table) only ever
// wants actual breaches, so that contract stays unchanged for them.
export function collectRtaKpiSignals(
  ds: DataSourceConfig, accountData: AccountData | undefined, kpiTh: Thresholds
): RtaKpiSignal[] {
  if (!accountData) return []
  const kpiRows = accountData.kpiRows ?? []
  const out: RtaKpiSignal[] = []

  const push = (key: string, entity: string, metric: string, num: number, value: string, thLabel: string, th: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean }, flags: RtaReportFlags | undefined) => {
    const wantsHeartbeat = !!flags?.rtaReportHeartbeat
    const wantsBreachChange = !!flags?.rtaReportBreachChange
    if ((!wantsHeartbeat && !wantsBreachChange) || isNaN(num)) return
    const { isCrit, isWarn } = evalThreshold(num, th)
    out.push({ key, entity, metric, value, threshold: thLabel, severity: isCrit ? 'critical' : isWarn ? 'warning' : null, wantsHeartbeat, wantsBreachChange })
  }

  ;(ds.groups ?? []).forEach(group => {
    const g = group.name || 'KPI'
    const groupRows = group.source ? (accountData.kpiRowsByGroup?.[group.id] ?? []) : kpiRows
    const rc = (b: any) => resolveCell(groupRows, b, ds.kpiGroupCol, group.groupVal)

    if (group.tiles && group.tiles.length) {
      group.tiles.forEach(tile => {
        if (!tile.cell) return
        const raw = rc(tile.cell)
        push(`${group.id}:${tile.key}`, g, tile.label, extractPercent(raw), raw.replace(/\s+/g, ''), String(tile.targ), tile, tile)
      })
      return
    }

    // Legacy shared-label/shared-threshold path — formulas MUST mirror
    // buildBreaches()'s own legacy path (same function, below) exactly, or
    // a heartbeat/breach-change reading here would disagree with what the
    // Dashboard/Cliq/Workforce Logs show for the exact same cell.
    if (group.cells.sla) {
      const raw = rc(group.cells.sla)
      push(`${group.id}:sla`, g, ds.kpiLabels.sla, extractPercent(raw), raw.replace(/\s+/g, ''), `≥${kpiTh.sla.targ}%`, kpiTh.sla, kpiTh.sla)
    }
    if (group.cells.wait) {
      const raw = rc(group.cells.wait)
      const n = parseInt(raw || '0')
      push(`${group.id}:wait`, g, ds.kpiLabels.wait, n, String(n), String(kpiTh.wait.targ), kpiTh.wait, kpiTh.wait)
    }
    if (group.cells.aht) {
      const raw = rc(group.cells.aht)
      const m = Math.round(parseDurationToSeconds(raw) / 60)
      if (m > 0) push(`${group.id}:aht`, g, ds.kpiLabels.aht, m, raw, `<${kpiTh.aht.targ}m`, kpiTh.aht, kpiTh.aht)
    }
    if (group.cells.abn) {
      const raw = rc(group.cells.abn)
      push(`${group.id}:abn`, g, ds.kpiLabels.abn, extractPercent(raw), raw.replace(/\s+/g, ''), `<${kpiTh.abn.targ}%`, kpiTh.abn, kpiTh.abn)
    }

    ;(ds.extraTiles ?? []).forEach(t => {
      if (!group.cells[t.key]) return
      const raw = rc(group.cells[t.key])
      const num = extractPercent(raw)
      const dir: 'asc' | 'desc' = t.higherIsBetter ? 'desc' : 'asc'
      push(`${group.id}:${t.key}`, g, t.label, num, raw, String(t.targ), { warn: t.warn, crit: t.crit, direction: dir }, t)
    })
  })

  return out
}

export interface BreachRow {
  entity: string; metric: string; value: string; threshold: string
  severity: 'warning' | 'critical'
  // 'kpi' (account/queue-level, e.g. SLA %) vs 'agent' (a specific agent's
  // status/duration breach) — used by lib/rtaLogsChangeDetection.ts to
  // decide whether a repeat breach is "new" differently per kind: a KPI
  // breach is new whenever its VALUE changes (even while still breaching);
  // an agent breach is new only when a NAME not seen before joins that
  // breach type, not on every duration tick for an already-known agent.
  kind: 'kpi' | 'agent'
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
    const { isCrit, isWarn } = evalThreshold(num, th)
    if (isCrit)       rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical', kind: 'kpi' })
    else if (isWarn)  rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning',  kind: 'kpi' })
  }

  // KPI breaches — one pass per manually-defined group
  ;(ds.groups ?? []).forEach(group => {
    const g       = group.name || 'KPI'
    // A group with its own `source` (see KpiGroup.source, lib/types.ts) reads
    // from ITS OWN fetched rows (accountData.kpiRowsByGroup[group.id]) instead
    // of the account-wide kpiRows — e.g. Flex's "First Reply Time" group
    // reading flex_overwatch_first_reply while every other group keeps
    // reading flex_explore_tiles via the shared kpiRows below.
    const groupRows = group.source ? (accountData.kpiRowsByGroup?.[group.id] ?? []) : kpiRows
    const rc      = (b: any) => resolveCell(groupRows, b, ds.kpiGroupCol, group.groupVal)

    // Independent-tiles group (see GroupTile in lib/types.ts) — every tile
    // carries its OWN label/binding/thresholds, entirely separate from every
    // other group, instead of sharing ds.kpiLabels/ds.extraTiles/kpiTh.
    if (group.tiles && group.tiles.length) {
      group.tiles.forEach(tile => {
        if (!tile.cell) return
        const raw = rc(tile.cell)
        const num = extractPercent(raw)
        checkKpi(num, tile, g, tile.label, raw.replace(/\s+/g, ''), String(tile.targ))
      })
      return
    }

    // Legacy shared-label/shared-threshold path — unchanged.
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
    const name   = String(a._name ?? '')

    // Excluded statuses (e.g. "Logged Out"/"Offline") never breach AT ALL —
    // not just duration, but ALSO the text-based custom-column check below.
    // Matches this setting's own stated intent (see StatusThresholds in
    // lib/utils.ts: "shouldn't be breach-checked... at all") — an agent who
    // isn't actively working shouldn't get flagged just because a stale
    // Adherence/etc. value was left over from before they went offline.
    if (statusTh[status]?.excluded) return

    // Duration-based: how long the agent has been in this status. Skipped
    // entirely in "static" mode (ds.agentDurationStatic — see Settings' Data
    // Sources tab) since the mapped column isn't real elapsed time there
    // (e.g. a ticket count) — there's no meaningful "how long" to threshold.
    const thSt = statusTh[status]
    if (thSt && thSt.crit < 999 && !ds.agentDurationStatic) {
      const key  = `${accountId}:${name}`
      const secs = agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
      const mins = secs / 60
      const dur  = formatSeconds(secs)
      if (mins >= thSt.crit)      rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.crit}m`, severity: 'critical', kind: 'agent' })
      else if (mins >= thSt.warn) rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.warn}m`, severity: 'warning',  kind: 'agent' })
    }

    // Static-mode Duration: a plain NUMERIC threshold on the value itself
    // (e.g. breach when "Ticket Solved" is at/below a number) — see
    // DataSourceConfig.agentDurationStaticThreshold's comment. Independent of
    // (and the direct replacement for) the minutes-in-status check above,
    // which is skipped in static mode since there's no real elapsed time.
    if (ds.agentDurationStatic && ds.agentDurationStaticThreshold) {
      const th  = ds.agentDurationStaticThreshold
      const raw = String(a._duration ?? '')
      const num = extractPercent(raw)
      if (!isNaN(num) && !(th.excludeZero && num === 0)) {
        const isCrit = th.direction === 'desc' ? num <= th.crit : num >= th.crit
        const isWarn = th.direction === 'desc' ? num <= th.warn : num >= th.warn
        const label  = ds.agentDurationLabel || 'Duration'
        const cmp    = th.direction === 'desc' ? '≤' : '≥'
        if (isCrit)      rows.push({ entity: name, metric: label, value: raw, threshold: `${cmp}${th.crit}`, severity: 'critical', kind: 'agent' })
        else if (isWarn) rows.push({ entity: name, metric: label, value: raw, threshold: `${cmp}${th.warn}`, severity: 'warning',  kind: 'agent' })
      }
    }

    // Text-based: some CRMs flag a problem as a literal status word instead
    // of a duration (e.g. Wyze's Adherence column reading "Out of
    // adherence") — checked against every custom Agent Table column that has
    // a breachText configured (see AgentExtraColumn in lib/types.ts).
    // Independent of the duration check above — an agent can breach on both
    // at once, as two separate rows.
    ;(ds.agentExtraCols ?? []).forEach(col => {
      const trigger = (col.breachText || '').trim()
      if (!trigger) return
      const raw = String(a[`_extra_${col.key}`] ?? '')
      if (raw.toLowerCase().includes(trigger.toLowerCase())) {
        // An optional companion duration column (see DataSourceConfig.
        // agentExtraDurationColsMap/AgentSource.extraDurationCols) shows
        // something more useful as the breach's Value — e.g. "how long has
        // this agent been out of adherence" — instead of just repeating the
        // trigger text, which the Threshold column already shows. Governed
        // by the SAME account-wide agentDurationStatic setting as the main
        // Duration column (not a separate toggle) — Running ticks this value
        // live too (via the compound agentTimers key Dashboard.tsx seeds for
        // it), Static shows it exactly as scraped, same as the main column.
        const extraDurRaw = String(a[`_extraDuration_${col.key}`] ?? '').trim()
        let durationVal = extraDurRaw
        if (extraDurRaw && !ds.agentDurationStatic) {
          const durKey = `${accountId}:${name}:extraDur:${col.key}`
          const durSecs = agentTimers[durKey] ?? parseDurationToSeconds(extraDurRaw)
          durationVal = formatSeconds(durSecs)
        }
        // An optional companion metric column (see DataSourceConfig.
        // agentExtraMetricColsMap/AgentSource.extraMetricCols) — same idea as
        // the duration companion, but for Metric: any raw column's per-agent
        // value (commonly the account's own status column) replaces this
        // column's fixed label. Combined with the duration above, a row
        // reads "Junnel | Away | 4m 26s | Out of adherence" instead of
        // "Junnel | Adherence | Out of adherence | Out of adherence".
        const metricVal = String(a[`_extraMetric_${col.key}`] ?? '').trim()
        rows.push({ entity: name, metric: metricVal || col.label, value: durationVal || raw, threshold: trigger, severity: col.breachSeverity || 'critical', kind: 'agent' })
      }
    })
  })

  return rows
}
