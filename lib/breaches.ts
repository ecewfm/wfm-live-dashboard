// lib/breaches.ts
// The single, canonical breach-detection algorithm — shared by the live
// Dashboard/Overview pages (client-side, via components/Dashboard.tsx) AND
// the Zoho Cliq scan (server-side, via app/api/cliq/scan/route.ts). Keeping
// this in one place means there is never a second copy to drift out of sync
// — whichever thresholds/KPI logic you see on screen is exactly what the
// Cliq alert used to decide whether to fire.

import type { AccountData, Thresholds, DataSourceConfig, AgentSource, RtaReportFlags, KpiUnit, KpiGroup, GroupTile, CellBinding, KpiGroupSource } from './types'
import { extractPercent, parseDurationToSeconds, formatSeconds, extractKpiValue, formatKpiThresholdLabel, resolveCell, type StatusThresholds } from './utils'

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

// ── Which KPI tables does this account's config actually need? ────────────
// CANONICAL — used by BOTH components/Dashboard.tsx (client fetch) AND
// lib/cliqScan.ts (server fetch), via fetchKpiSourceRows() below, so there is
// only ever one implementation of "given a DataSourceConfig, which distinct
// alternate tables need fetching" — same reasoning as normalizeAgentRow()
// above (and the SAME class of client/server drift bug that one was fixed
// for). Pure — no Supabase client, no I/O.
//
// Walks TWO levels now: a whole group's `source` (KpiGroup.source) AND an
// individual tile's (GroupTile.source). Dedup is unchanged — one query per
// distinct table+accountCol — so homebase's two TALL tiles (LONGEST WAIT
// TIME + ONLINE AGENTS, both on homebase_omni_queue_stats) still cost
// exactly ONE query, shared with the group if it happens to point there too.
export interface KpiSourceQuery {
  key:        string    // "table::accountCol" — ALSO the AccountData.kpiRowsBySource key, so there is no separate fan-out mapping to get wrong
  table:      string
  accountCol: string
}

/** The ONE identity an alternate KPI source is addressed by. The planner
 *  below (write side) and makeKpiCellResolver()/freshestAcrossSources()
 *  (read side) all derive their key from HERE, so "which bucket do these rows
 *  go in" and "which bucket does this tile read" are the same call rather
 *  than two string templates that have to be kept spelled identically. */
export function kpiSourceKey(src: KpiGroupSource): string {
  return `${src.table}::${src.accountCol || 'account_id'}`
}

/** The ONE precedence rule: tile.source -> group.source -> the account-wide
 *  ds.kpiTable (returned as null). Imported by components/Dashboard.tsx,
 *  lib/cliqScan.ts (indirectly, via the resolver) AND
 *  components/SettingsModal.tsx, so the Settings editor's idea of which table
 *  a slot binds against is literally the same function the renderers and the
 *  Cliq/RTA scan resolve with — bind-time and read-time cannot disagree.
 *
 *  Truthiness of the OBJECT, not fullness of its contents, exactly matching
 *  the existing `group.source ? ... : kpiRows` test: a source toggled ON but
 *  with no table picked yet resolves to an EMPTY row set, so the tile shows
 *  '--' rather than silently reading a different table. */
export function effectiveKpiSource(group: KpiGroup, tile?: GroupTile | null): KpiGroupSource | null {
  if (tile?.source) return tile.source
  return group.source ?? null
}

export function collectKpiSourceQueries(ds: DataSourceConfig): KpiSourceQuery[] {
  const map = new Map<string, KpiSourceQuery>()
  const add = (src: KpiGroupSource | null | undefined) => {
    if (!src || !src.table) return
    const key = kpiSourceKey(src)
    if (!map.has(key)) map.set(key, { key, table: src.table, accountCol: src.accountCol || 'account_id' })
  }
  ;(ds.groups ?? []).forEach(g => {
    add(g.source)
    // Per-TILE sources (GroupTile.source). Array.isArray, NOT `g.tiles ?? []`:
    // lib/cliqScan.ts does a bare `acc.data_source as DataSourceConfig` with
    // NO migrateDataSource() call, so on the server this walks RAW JSONB — a
    // malformed non-array `tiles` would otherwise throw inside
    // fetchAccountData() and take that account's whole scan down.
    ;(Array.isArray(g.tiles) ? g.tiles : []).forEach(t => add(t?.source))
  })
  return [...map.values()]
}

/** How a caller fetches one table's rows for one account. The ONLY thing
 *  each side contributes — the browser passes its anon Supabase client, the
 *  scan passes the server one. Everything else (which tables, dedup, how the
 *  results are keyed) is decided here, once. */
export type KpiSourceFetcher = (table: string, accountCol: string, accountId: string) => Promise<Record<string, any>[]>

/** CANONICAL execute + fan-out. This replaces the two BYTE-IDENTICAL loops
 *  that used to live in components/Dashboard.tsx (fetchAccount) and
 *  lib/cliqScan.ts (fetchAccountData) — the half of the per-group-source
 *  machinery that was never actually shared. Those two had already drifted
 *  by a token elsewhere in the same pair of functions (cliqScan defaults
 *  `ds.kpiAccountCol || 'account_id'` for the account-wide fetch, Dashboard
 *  does not), which is why this one is not left to "mirror it carefully". */
export async function fetchKpiSourceRows(
  ds: DataSourceConfig, accountId: string, fetchTable: KpiSourceFetcher
): Promise<Record<string, Record<string, any>[]>> {
  const queries = collectKpiSourceQueries(ds)
  const results = await Promise.all(queries.map(q => fetchTable(q.table, q.accountCol, accountId)))
  const out: Record<string, Record<string, any>[]> = {}
  queries.forEach((q, i) => { out[q.key] = results[i] ?? [] })
  return out
}

// ── The ONE "which rows does this binding read, and how" function ─────────
// CANONICAL — used by buildBreaches() and collectRtaKpiSignals() below AND by
// KpiGrid()/OverviewCard() in components/Dashboard.tsx. Same reasoning as
// normalizeAgentRow() above, and for the same documented reason: CLAUDE.md
// records TWO separate incidents where a client-side copy and a server-side
// copy of exactly this kind of per-binding step drifted apart silently.
//
// Before per-tile sources this was the one-liner
//     group.source ? (accountData.kpiRowsByGroup?.[group.id] ?? []) : kpiRows
// pasted at FOUR sites (lib/breaches.ts twice, components/Dashboard.tsx
// twice) with a fifth implicit copy inside KpiGrid's `rows` prop. A one-line
// ternary survives being copied; three-tier precedence plus a filtering rule
// does not — so there is now exactly one implementation to call.
export function makeKpiCellResolver(
  ds: DataSourceConfig, group: KpiGroup, accountData: AccountData | undefined
): (binding?: CellBinding | null, tile?: GroupTile | null) => string {
  const accountRows = accountData?.kpiRows ?? []
  return (binding, tile) => {
    const src = effectiveKpiSource(group, tile)

    // No override anywhere up the chain -> the account-wide table, filtered
    // by this group's LOB value. Byte-for-byte the call every one of those
    // five sites made before this function existed.
    if (!src) return resolveCell(accountRows, binding ?? undefined, ds.kpiGroupCol, group.groupVal)

    // An alternate table's rows. `?? []` mirrors the EXISTING semantics of a
    // source toggled ON with no table picked yet (collectKpiSourceQueries
    // skips it, so nothing was fetched): show '--', never silently fall back
    // to a DIFFERENT table's data.
    const rows = accountData?.kpiRowsBySource?.[kpiSourceKey(src)] ?? []

    // ds.kpiGroupCol/group.groupVal describe the shape of the ACCOUNT-WIDE
    // table. They are deliberately NOT applied to a foreign table, which has
    // no such column and carries its own row key instead — the same rule
    // pickCell() in components/SettingsModal.tsx already applies to the row
    // key ("a column from a completely different table that may not even
    // exist here"). Passing them through filters every row away (r[groupCol]
    // is undefined, so '' !== groupVal) and only survives via resolveCell's
    // matchCol-only rescue — i.e. today it is either a no-op or a silent
    // '--'. This is a deterministic rule about the CONFIG, not a sniff of
    // whichever rows a given poll happened to return.
    return resolveCell(rows, binding ?? undefined)
  }
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

  const push = (
    key: string, entity: string, metric: string, raw: string, targ: number,
    th: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean },
    unit: KpiUnit | undefined, flags: RtaReportFlags | undefined
  ) => {
    const wantsHeartbeat = !!flags?.rtaReportHeartbeat
    const wantsBreachChange = !!flags?.rtaReportBreachChange
    if (!wantsHeartbeat && !wantsBreachChange) return
    const { num, value } = extractKpiValue(raw, unit)
    if (isNaN(num)) return
    // A duration sitting at/below 0 (e.g. "00:00") means no data yet, not a
    // real measurement — same guard buildBreaches() applies below, now
    // generalized from "aht specifically" to "whichever KPI is unit:duration".
    if (unit === 'duration' && num <= 0) return
    const { isCrit, isWarn } = evalThreshold(num, th)
    out.push({
      key, entity, metric, value, threshold: formatKpiThresholdLabel(unit, targ, th.direction),
      severity: isCrit ? 'critical' : isWarn ? 'warning' : null, wantsHeartbeat, wantsBreachChange,
    })
  }

  ;(ds.groups ?? []).forEach(group => {
    const g = group.name || 'KPI'
    // ONE resolver — holds the tile.source -> group.source -> account-wide
    // precedence. Pass the TILE for independent-tile groups so a per-tile
    // source is honoured; the legacy `cells` calls below pass no tile and
    // therefore behave exactly as before.
    const rc = makeKpiCellResolver(ds, group, accountData)

    if (group.tiles && group.tiles.length) {
      group.tiles.forEach(tile => {
        if (!tile.cell) return
        push(`${group.id}:${tile.key}`, g, tile.label, rc(tile.cell, tile), tile.targ, tile, tile.kpiUnit, tile)
      })
      return
    }

    // Legacy shared-label/shared-threshold path — formulas MUST mirror
    // buildBreaches()'s own legacy path (same function, below) exactly, or
    // a heartbeat/breach-change reading here would disagree with what the
    // Dashboard/Cliq/Workforce Logs show for the exact same cell.
    if (group.cells.sla)  push(`${group.id}:sla`,  g, ds.kpiLabels.sla,  rc(group.cells.sla),  kpiTh.sla.targ,  kpiTh.sla,  kpiTh.sla.kpiUnit,  kpiTh.sla)
    if (group.cells.wait) push(`${group.id}:wait`, g, ds.kpiLabels.wait, rc(group.cells.wait), kpiTh.wait.targ, kpiTh.wait, kpiTh.wait.kpiUnit, kpiTh.wait)
    if (group.cells.aht)  push(`${group.id}:aht`,  g, ds.kpiLabels.aht,  rc(group.cells.aht),  kpiTh.aht.targ,  kpiTh.aht,  kpiTh.aht.kpiUnit,  kpiTh.aht)
    if (group.cells.abn)  push(`${group.id}:abn`,  g, ds.kpiLabels.abn,  rc(group.cells.abn),  kpiTh.abn.targ,  kpiTh.abn,  kpiTh.abn.kpiUnit,  kpiTh.abn)

    ;(ds.extraTiles ?? []).forEach(t => {
      if (!group.cells[t.key]) return
      const dir: 'asc' | 'desc' = t.higherIsBetter ? 'desc' : 'asc'
      push(`${group.id}:${t.key}`, g, t.label, rc(group.cells[t.key]), t.targ, { warn: t.warn, crit: t.crit, direction: dir }, t.kpiUnit, t)
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
  // Only set for a 'kind:agent' row that came from the named-status duration
  // check below (StatusThresholds-driven, e.g. "On Call" / "Not Ready
  // (Break)") — absent for the OTHER two agent-breach paths (the static-
  // duration-threshold check and the text-trigger custom-column check),
  // which aren't tied to a status from the Status Durations tab at all.
  // Lets lib/cliqScan.ts filter the Cliq message by StatusThresholds[status]
  // .sendToCliq without fragile string-parsing of `metric` (which for THIS
  // path is always `${status} Duration`, but for the other two paths can be
  // any account-configured label that might coincidentally also end in
  // "Duration").
  status?: string
  // Only set for a 'kind:kpi' row — carries that KPI's own Thresholds/
  // GroupTile/ExtraTile.sendToCliq (lib/types.ts) straight through from
  // checkKpi() below, so lib/cliqScan.ts can filter the Cliq message
  // per-KPI the same way it does per-status above.
  sendToCliq?: boolean
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

// ── How fresh is this account's data, across EVERY table it reads? ────────
// CANONICAL — used by components/Dashboard.tsx's page overlay AND its
// OverviewCard AND lib/cliqScan.ts's suppression gate, so the "DATA NOT IN
// SYNC" stamp and the scan's decision to suppress Cliq/Workforce Logs/RTA
// Logs can never disagree about whether an account is live.
//
// Why this has to exist now: until per-tile sources, every staleness check
// read ONLY accountData.kpiRows + ds.kpiUpdatedAt, and KpiGroupSource
// .updatedAtCol was a dead field (written by Settings, read by nothing).
// With one card legitimately mixing three tables that is no longer
// defensible — homebase's Omni-Channel supervisor panel is deliberately not
// re-navigated each scrape cycle, so homebase_omni_queue_stats can freeze
// while the phones table keeps updating, and a frozen ONLINE AGENTS would
// otherwise sit under a green "Live" dot and keep firing Cliq alerts and RTA
// Logs forever.
//
// OLDEST wins: if ANY table feeding this account is stale, the account is
// stale. A source with a blank updatedAtCol contributes NOTHING, so with
// today's saved configs (where that field is blank everywhere) this returns
// exactly what mostRecentUpdatedAt(accountData.kpiRows, ds.kpiUpdatedAt)
// returns — zero behaviour change until someone fills one in.
export function freshestAcrossSources(
  ds: DataSourceConfig, accountData: AccountData | undefined
): string | undefined {
  if (!accountData) return undefined
  const stamps: string[] = []

  const accountWide = mostRecentUpdatedAt(accountData.kpiRows ?? [], ds.kpiUpdatedAt)
  if (accountWide) stamps.push(accountWide)

  // Every DISTINCT alternate source this config actually references, group-
  // level and tile-level alike. Deduped by kpiSourceKey so a table used by
  // three tiles is considered once.
  const seen = new Set<string>()
  const consider = (src: KpiGroupSource | null | undefined) => {
    if (!src || !src.table || !src.updatedAtCol) return
    const key = kpiSourceKey(src)
    if (seen.has(key)) return
    seen.add(key)
    const rows = accountData.kpiRowsBySource?.[key] ?? []
    const t = mostRecentUpdatedAt(rows, src.updatedAtCol)
    // A referenced source with an updatedAtCol configured but NO rows back
    // is a genuine problem (wrong table, wrong accountCol, scraper down),
    // but it has no timestamp to contribute — leaving it out keeps this
    // function honest; the unresolved-binding log in lib/cliqScan.ts is
    // what makes that case visible.
    if (t) stamps.push(t)
  }
  ;(ds.groups ?? []).forEach(g => {
    consider(g.source)
    ;(Array.isArray(g.tiles) ? g.tiles : []).forEach(t => consider(t?.source))
  })

  if (!stamps.length) return undefined   // nothing to judge -> isDataStale(undefined) === false, unchanged from today
  return stamps.reduce((oldest, s) => (new Date(s).getTime() < new Date(oldest).getTime() ? s : oldest))
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
    raw: string, targ: number, th: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean },
    entity: string, metric: string, unit: KpiUnit | undefined, sendToCliq?: boolean
  ) => {
    const { num, value } = extractKpiValue(raw, unit)
    if (isNaN(num)) return
    // A duration sitting at/below 0 (e.g. "00:00") means no data yet, not a
    // real measurement — generalized from the old "aht specifically" guard
    // to whichever KPI is unit:duration.
    if (unit === 'duration' && num <= 0) return
    const { isCrit, isWarn } = evalThreshold(num, th)
    const thLabel = formatKpiThresholdLabel(unit, targ, th.direction)
    if (isCrit)       rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical', kind: 'kpi', sendToCliq })
    else if (isWarn)  rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning',  kind: 'kpi', sendToCliq })
  }

  // KPI breaches — one pass per manually-defined group
  ;(ds.groups ?? []).forEach(group => {
    const g       = group.name || 'KPI'
    // A group with its own `source` (see KpiGroup.source, lib/types.ts) reads
    // from ITS OWN fetched rows (accountData.kpiRowsByGroup[group.id]) instead
    // of the account-wide kpiRows — e.g. Flex's "First Reply Time" group
    // reading flex_overwatch_first_reply while every other group keeps
    // reading flex_explore_tiles via the shared kpiRows below.
    // ONE resolver — see makeKpiCellResolver(). Must stay identical to the
    // one collectRtaKpiSignals() uses above, which is why it is the same
    // function rather than a second copy of the same ternary.
    const rc = makeKpiCellResolver(ds, group, accountData)

    // Independent-tiles group (see GroupTile in lib/types.ts) — every tile
    // carries its OWN label/binding/thresholds, entirely separate from every
    // other group, instead of sharing ds.kpiLabels/ds.extraTiles/kpiTh.
    if (group.tiles && group.tiles.length) {
      group.tiles.forEach(tile => {
        if (!tile.cell) return
        checkKpi(rc(tile.cell, tile), tile.targ, tile, g, tile.label, tile.kpiUnit, tile.sendToCliq)
      })
      return
    }

    // Legacy shared-label/shared-threshold path — formulas driven by each
    // key's kpiUnit (lib/types.ts's KpiUnit) instead of a hardcoded per-key
    // extraction, so "what does this slot actually measure" is an explicit
    // per-account choice (see Thresholds.kpiUnit) rather than assumed from
    // the slot's name.
    if (group.cells.sla)  checkKpi(rc(group.cells.sla),  kpiTh.sla.targ,  kpiTh.sla,  g, ds.kpiLabels.sla,  kpiTh.sla.kpiUnit,  kpiTh.sla.sendToCliq)
    if (group.cells.wait) checkKpi(rc(group.cells.wait), kpiTh.wait.targ, kpiTh.wait, g, ds.kpiLabels.wait, kpiTh.wait.kpiUnit, kpiTh.wait.sendToCliq)
    if (group.cells.aht)  checkKpi(rc(group.cells.aht),  kpiTh.aht.targ,  kpiTh.aht,  g, ds.kpiLabels.aht,  kpiTh.aht.kpiUnit,  kpiTh.aht.sendToCliq)
    if (group.cells.abn)  checkKpi(rc(group.cells.abn),  kpiTh.abn.targ,  kpiTh.abn,  g, ds.kpiLabels.abn,  kpiTh.abn.kpiUnit,  kpiTh.abn.sendToCliq)

    // Extra custom tiles carry their own thresholds
    ;(ds.extraTiles ?? []).forEach(t => {
      if (!group.cells[t.key]) return
      const dir: 'asc' | 'desc' = t.higherIsBetter ? 'desc' : 'asc'
      checkKpi(rc(group.cells[t.key]), t.targ, { warn: t.warn, crit: t.crit, direction: dir }, g, t.label, t.kpiUnit, t.sendToCliq)
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
      if (mins >= thSt.crit)      rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.crit}m`, severity: 'critical', kind: 'agent', status })
      else if (mins >= thSt.warn) rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.warn}m`, severity: 'warning',  kind: 'agent', status })
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
