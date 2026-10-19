// lib/rtaLogsChangeDetection.ts
// Per the user (2026-09-28): Workforce RTA Logs reporting should NOT be
// gated by a plain time cooldown (unlike Cliq/Workforce Logs) — it should
// re-post whenever something actually CHANGED, and stay quiet otherwise,
// specifically:
//   - A KPI/queue-level breach (e.g. SLA %) re-posts every time its VALUE
//     changes while still breaching (75% → 72% → 78%, all under threshold,
//     each posts) — but NOT while it sits at the exact same value.
//   - An agent-status breach re-posts only when a NEW agent name joins that
//     breach type (e.g. a new person breaching "Case Follow Up Duration")
//     — NOT just because an already-known agent's duration keeps climbing.
//
// This compares the CURRENT breach list against a per-account snapshot
// (wfm_settings.rta_logs_state, see sql/rta_logs_change_detection.sql)
// persisted only at the moment a report is actually sent (lib/cliqScan.ts) —
// never touched on a cycle where nothing new happened, so the comparison is
// always against "the state as of the last thing we actually told Zoho".

import type { BreachRow, RtaKpiSignal } from './breaches'

export interface RtaLogsState {
  // key: `${entity}|${metric}` for a KPI breach -> its last-reported value.
  // Superseded by kpiBreachChange below (per-tile GroupTile.rtaReportMode
  // replaced the old account-wide "Report KPI Tile breaches" toggle) —
  // lib/cliqScan.ts no longer feeds any 'kind:kpi' row into
  // computeRtaLogsChangeSignal, so this branch is permanently a no-op going
  // forward. Kept in the type (rather than removed) only so an old stored
  // snapshot from before the migration still parses without a schema change.
  kpi: Record<string, string>
  // key: metric (the breach "type", e.g. "Case Follow Up Duration") ->
  // every agent name last reported for it
  agent: Record<string, string[]>
  // key: `${groupId}:${tileKey}` (RtaKpiSignal.key) -> ISO timestamp of the
  // last successful send for a tile in 'heartbeat' mode.
  kpiHeartbeat?: Record<string, string>
  // key: `${groupId}:${tileKey}` -> last value successfully reported while
  // breaching, for a tile in 'breach_change' mode. Cleared the moment that
  // tile stops breaching (so a later re-breach at the same old value is
  // treated as new), independent of whether a send succeeds that cycle.
  kpiBreachChange?: Record<string, string>
  // ISO timestamp of the last successful "bulk" heartbeat send for the
  // agent-status GROUP as a whole (DataSourceConfig.
  // rtaReportAgentStatusHeartbeat, see lib/types.ts) — one timestamp, not
  // per-status/per-agent, since this reports every currently-breaching agent
  // together on a single 60-minute timer, independent of the existing
  // per-metric `agent` new-arrival tracking above.
  agentHeartbeat?: string
}

export const EMPTY_RTA_LOGS_STATE: RtaLogsState = { kpi: {}, agent: {}, kpiHeartbeat: {}, kpiBreachChange: {} }

export interface RtaLogsChangeResult {
  shouldSend: boolean
  // The full current snapshot — the caller persists this as the new
  // baseline ONLY if it actually sends (whether because shouldSend was true,
  // or because a forced/manual scan sent anyway) — see lib/cliqScan.ts.
  currentSnapshot: RtaLogsState
}

export function computeRtaLogsChangeSignal(breaches: BreachRow[], stored: RtaLogsState | null | undefined): RtaLogsChangeResult {
  const { changes, currentSnapshot } = explainBreachChanges(breaches, stored)
  return { shouldSend: changes.length > 0, currentSnapshot }
}

/** One thing that's new since the stored snapshot. */
export type BreachChange =
  | { kind: 'kpi'; entity: string; metric: string; value: string; previous: string | null }
  | { kind: 'agent'; metric: string; agent: string }

/**
 * THE change rule, shared by Workforce RTA Logs (computeRtaLogsChangeSignal
 * above, server side) and the global breach alarm (lib/globalAlarm.ts,
 * browser side) — one implementation so the two can never disagree about
 * what counts as "something changed":
 *   - a KPI breach whose VALUE differs from the snapshot (or is new),
 *   - an agent name that wasn't in the snapshot for that breach type. A
 *     brand-new breach type (a new aux/status starting to breach) counts too,
 *     since every agent under it is new.
 * A breach that merely clears, or an agent whose duration keeps climbing,
 * is not a change.
 */
export function explainBreachChanges(
  breaches: BreachRow[],
  stored: RtaLogsState | null | undefined,
): { changes: BreachChange[]; currentSnapshot: RtaLogsState } {
  const currentKpi: Record<string, string> = {}
  const currentAgent: Record<string, string[]> = {}
  const kpiRow: Record<string, BreachRow> = {}

  for (const b of breaches) {
    if (b.kind === 'kpi') {
      const key = `${b.entity}|${b.metric}`
      currentKpi[key] = b.value
      kpiRow[key] = b
    } else {
      const names = currentAgent[b.metric] ?? (currentAgent[b.metric] = [])
      if (!names.includes(b.entity)) names.push(b.entity)
    }
  }

  const prevKpi   = stored?.kpi   ?? {}
  const prevAgent = stored?.agent ?? {}
  const changes: BreachChange[] = []

  for (const key of Object.keys(currentKpi)) {
    if (prevKpi[key] !== currentKpi[key]) {
      const r = kpiRow[key]
      changes.push({ kind: 'kpi', entity: r.entity, metric: r.metric, value: r.value, previous: prevKpi[key] ?? null })
    }
  }
  for (const metric of Object.keys(currentAgent)) {
    const prevNames = prevAgent[metric] ?? []
    for (const agent of currentAgent[metric]) {
      if (!prevNames.includes(agent)) changes.push({ kind: 'agent', metric, agent })
    }
  }

  return { changes, currentSnapshot: { kpi: currentKpi, agent: currentAgent } }
}

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000

// Group-level heartbeat due-check for agent-status breaches (DataSourceConfig.
// rtaReportAgentStatusHeartbeat) — one timer for the whole bulk list, NOT
// per-status/per-agent like the KPI side. `force` mirrors "Force Scan Now",
// same as every other due-check in this file.
export function isAgentStatusHeartbeatDue(stored: RtaLogsState | null | undefined, now: number, force: boolean): boolean {
  const last = stored?.agentHeartbeat
  return force || !last || now - new Date(last).getTime() >= HEARTBEAT_INTERVAL_MS
}

export interface RtaKpiSignalDueResult {
  // A signal can be due via EITHER flag (or both at once) — split by
  // severity, not by which flag triggered it, since that's what decides
  // routing downstream: a breaching signal is AI-classification-eligible
  // (it's a real breach, whichever flag fired it); a healthy one is only
  // ever reporting its current value (only possible via the heartbeat flag).
  dueBreaching: RtaKpiSignal[]
  dueHealthy:   RtaKpiSignal[]
  // Pure bookkeeping, independent of whether anything is actually sent to
  // Zoho this cycle — always safe to merge into the stored state as-is:
  //   - clearedBreachChangeKeys: tiles that just healed. Dropping their
  //     entry means a LATER re-breach at the same old value counts as fresh
  //     (mirrors the account-wide baseline-clear this file's header
  //     documents, now scoped per tile).
  clearedBreachChangeKeys: string[]
  // The NEW {key: value} entries for every signal that ended up in
  // dueBreaching/dueHealthy — the caller merges these into stored state
  // ONLY if its send this cycle actually succeeds (same "advance only on
  // confirmed send" discipline as every other cooldown/baseline in this
  // codebase, e.g. Cliq's own cliq_last_sent_at) — a failed send must stay
  // due and retry next cycle, not go silent for another 60 minutes / until
  // the next value change. Advances WHICHEVER flag(s) this signal has
  // enabled, regardless of which flag was the actual trigger this cycle —
  // e.g. a heartbeat-triggered send of a breaching value also updates
  // breachChangeAdvance, so breach-change doesn't immediately re-fire for a
  // value just reported a moment ago via the heartbeat.
  heartbeatAdvance:    Record<string, string>
  breachChangeAdvance: Record<string, string>
}

// Per-tile counterpart to computeRtaLogsChangeSignal() above, for KPIs with
// rtaReportHeartbeat/rtaReportBreachChange set (see RtaReportFlags in
// lib/types.ts, lib/breaches.ts's collectRtaKpiSignals()). Unlike the
// account-wide KPI branch above (now unused), this is genuinely per-tile:
// each signal is judged independently against its OWN last-sent state,
// keyed by the stable `${groupId}:${tileKey}` (survives a tile being
// renamed, unlike the old `${entity}|${metric}` text key).
export function computeRtaKpiSignalDue(
  signals: RtaKpiSignal[], stored: RtaLogsState | null | undefined, now: number,
  // Mirrors the real scan's "Force Scan Now" forceSend flag — bypasses the
  // 60-minute heartbeat wait and the breach-change value-diff check, same as
  // forceSend already bypasses computeRtaLogsChangeSignal's agent check.
  // Still only treats a signal as breach-change-due when it's ACTUALLY
  // breaching right now (forcing a send for a healthy tile via this flag
  // makes no sense) — only the "did it change" part is skipped.
  force = false
): RtaKpiSignalDueResult {
  const prevHeartbeat    = stored?.kpiHeartbeat    ?? {}
  const prevBreachChange = stored?.kpiBreachChange ?? {}

  const dueBreaching: RtaKpiSignal[] = []
  const dueHealthy:   RtaKpiSignal[] = []
  const clearedBreachChangeKeys: string[] = []
  const heartbeatAdvance:    Record<string, string> = {}
  const breachChangeAdvance: Record<string, string> = {}

  for (const s of signals) {
    const breaching = s.severity !== null

    // Healed tiles' breach-change baseline clears regardless of whether
    // this signal is due for any other reason this cycle.
    if (!breaching && s.key in prevBreachChange) clearedBreachChangeKeys.push(s.key)

    const heartbeatDue = s.wantsHeartbeat && (
      force || !prevHeartbeat[s.key] || now - new Date(prevHeartbeat[s.key]).getTime() >= HEARTBEAT_INTERVAL_MS
    )
    const breachChangeDue = s.wantsBreachChange && breaching && (force || prevBreachChange[s.key] !== s.value)

    if (!heartbeatDue && !breachChangeDue) continue

    if (breaching) dueBreaching.push(s); else dueHealthy.push(s)
    if (s.wantsHeartbeat) heartbeatAdvance[s.key] = new Date(now).toISOString()
    if (s.wantsBreachChange && breaching) breachChangeAdvance[s.key] = s.value
  }

  return { dueBreaching, dueHealthy, clearedBreachChangeKeys, heartbeatAdvance, breachChangeAdvance }
}
