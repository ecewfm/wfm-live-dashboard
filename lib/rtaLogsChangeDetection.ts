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
  const currentKpi: Record<string, string> = {}
  const currentAgent: Record<string, string[]> = {}

  for (const b of breaches) {
    if (b.kind === 'kpi') {
      currentKpi[`${b.entity}|${b.metric}`] = b.value
    } else {
      const names = currentAgent[b.metric] ?? (currentAgent[b.metric] = [])
      if (!names.includes(b.entity)) names.push(b.entity)
    }
  }

  const prevKpi   = stored?.kpi   ?? {}
  const prevAgent = stored?.agent ?? {}

  let shouldSend = false

  for (const key of Object.keys(currentKpi)) {
    if (prevKpi[key] !== currentKpi[key]) { shouldSend = true; break }
  }
  if (!shouldSend) {
    for (const key of Object.keys(currentAgent)) {
      const prevNames = prevAgent[key] ?? []
      if (currentAgent[key].some(name => !prevNames.includes(name))) { shouldSend = true; break }
    }
  }

  return { shouldSend, currentSnapshot: { kpi: currentKpi, agent: currentAgent } }
}

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000

export interface RtaKpiSignalDueResult {
  dueHeartbeat:    RtaKpiSignal[]
  dueBreachChange: RtaKpiSignal[]
  // Pure bookkeeping, independent of whether anything is actually sent to
  // Zoho this cycle — always safe to merge into the stored state as-is:
  //   - clearedBreachChangeKeys: tiles that just healed. Dropping their
  //     entry means a LATER re-breach at the same old value counts as fresh
  //     (mirrors the account-wide baseline-clear this file's header
  //     documents, now scoped per tile).
  clearedBreachChangeKeys: string[]
  // The NEW {key: value} entries for signals this result marks "due" —
  // the caller merges these into stored state ONLY if its send this cycle
  // actually succeeds (same "advance only on confirmed send" discipline as
  // every other cooldown/baseline in this codebase, e.g. Cliq's own
  // cliq_last_sent_at) — a failed send must stay due and retry next cycle,
  // not go silent for another 60 minutes / until the next value change.
  heartbeatAdvance:    Record<string, string>
  breachChangeAdvance: Record<string, string>
}

// Per-tile counterpart to computeRtaLogsChangeSignal() above, for GroupTile.
// rtaReportMode ('heartbeat' | 'breach_change') tiles — see
// lib/breaches.ts's collectRtaKpiSignals(). Unlike the account-wide KPI
// branch above (now unused), this is genuinely per-tile: each signal is
// judged independently against its OWN last-sent state, keyed by the
// stable `${groupId}:${tileKey}` (survives a tile being renamed, unlike the
// old `${entity}|${metric}` text key).
export function computeRtaKpiSignalDue(
  signals: RtaKpiSignal[], stored: RtaLogsState | null | undefined, now: number,
  // Mirrors the real scan's "Force Scan Now" forceSend flag — bypasses the
  // 60-minute heartbeat wait and the breach-change value-diff check, same as
  // forceSend already bypasses computeRtaLogsChangeSignal's agent check.
  // Still only includes a 'breach_change' tile when it's ACTUALLY breaching
  // right now (forcing a send for a healthy tile makes no sense) — only the
  // "did it change" part is skipped.
  force = false
): RtaKpiSignalDueResult {
  const prevHeartbeat    = stored?.kpiHeartbeat    ?? {}
  const prevBreachChange = stored?.kpiBreachChange ?? {}

  const dueHeartbeat:    RtaKpiSignal[] = []
  const dueBreachChange: RtaKpiSignal[] = []
  const clearedBreachChangeKeys: string[] = []
  const heartbeatAdvance:    Record<string, string> = {}
  const breachChangeAdvance: Record<string, string> = {}

  for (const s of signals) {
    if (s.mode === 'heartbeat') {
      const lastSent = prevHeartbeat[s.key]
      if (force || !lastSent || now - new Date(lastSent).getTime() >= HEARTBEAT_INTERVAL_MS) {
        dueHeartbeat.push(s)
        heartbeatAdvance[s.key] = new Date(now).toISOString()
      }
      continue
    }
    // 'breach_change' — only while breaching, only when the value differs
    // from the last one actually reported.
    if (s.severity === null) {
      if (s.key in prevBreachChange) clearedBreachChangeKeys.push(s.key)
      continue
    }
    if (force || prevBreachChange[s.key] !== s.value) {
      dueBreachChange.push(s)
      breachChangeAdvance[s.key] = s.value
    }
  }

  return { dueHeartbeat, dueBreachChange, clearedBreachChangeKeys, heartbeatAdvance, breachChangeAdvance }
}
