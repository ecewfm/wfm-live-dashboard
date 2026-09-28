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

import type { BreachRow } from './breaches'

export interface RtaLogsState {
  // key: `${entity}|${metric}` for a KPI breach -> its last-reported value
  kpi: Record<string, string>
  // key: metric (the breach "type", e.g. "Case Follow Up Duration") ->
  // every agent name last reported for it
  agent: Record<string, string[]>
}

export const EMPTY_RTA_LOGS_STATE: RtaLogsState = { kpi: {}, agent: {} }

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
