// lib/globalAlarm.ts
// The global breach alarm: one sound, configured by a super user (Settings →
// Alarm), that every signed-in dashboard plays for the accounts it can see.
//
// WHEN IT RINGS — only when a breach actually CHANGES:
//   - a KPI breach whose value changes while still breaching
//     (SLA 85% → 74%, both under threshold: rings; stays at 85%: silent);
//   - an agent-status breach with a NEW agent in it, or a new aux/status
//     starting to breach (every agent under it is new).
// An agent's duration climbing, or a breach clearing, does not ring. The rule
// itself is explainBreachChanges() in lib/rtaLogsChangeDetection.ts — the SAME
// function Workforce RTA Logs uses, so the two can never disagree.
//
// Also:
//   - Opening the page is silent: the first data seen for an account becomes
//     the baseline. Otherwise every reload would ring for breaches that were
//     already on screen.
//   - Stale data ("DATA NOT IN SYNC") never rings and doesn't move the
//     baseline — frozen numbers aren't news.
//   - The baseline follows the live breach list every cycle, so an agent who
//     stops breaching and breaches again LATER (more than AGENT_MEMORY_MS
//     after last seen) counts as new; a brief flicker doesn't.

import { supabase } from './supabase'
import type { BreachRow } from './breaches'
import { explainBreachChanges, type BreachChange, type RtaLogsState } from './rtaLogsChangeDetection'
import { playAlarm, audioAllowed, unlockAudio, onAudioStateChange } from './alarmSounds'

export interface GlobalAlarmSettings {
  enabled: boolean
  soundKind: 'builtin' | 'upload'
  builtinKey: string
  soundUrl: string | null
  soundName: string | null
  volume: number
  severity: 'all' | 'critical'
  minGapSeconds: number
}

export const DEFAULT_ALARM_SETTINGS: GlobalAlarmSettings = {
  enabled: false, soundKind: 'builtin', builtinKey: 'siren', soundUrl: null, soundName: null,
  volume: 0.8, severity: 'all', minGapSeconds: 30,
}

/** Read the one global row. Falls back to "off" if the table isn't migrated yet. */
export async function loadAlarmSettings(): Promise<GlobalAlarmSettings> {
  try {
    const { data, error } = await supabase.from('wfm_alarm_settings').select('*').eq('id', 'global').maybeSingle()
    if (error || !data) return DEFAULT_ALARM_SETTINGS
    return {
      enabled: !!data.enabled,
      soundKind: data.sound_kind === 'upload' && data.sound_url ? 'upload' : 'builtin',
      builtinKey: data.builtin_key || 'siren',
      soundUrl: data.sound_url ?? null,
      soundName: data.sound_name ?? null,
      volume: typeof data.volume === 'number' ? data.volume : 0.8,
      severity: data.severity === 'critical' ? 'critical' : 'all',
      minGapSeconds: Number.isFinite(data.min_gap_seconds) ? data.min_gap_seconds : 30,
    }
  } catch {
    return DEFAULT_ALARM_SETTINGS
  }
}

// ── The rule ─────────────────────────────────────────────────────────────────
export interface AlarmEvent { accountId: string; changes: BreachChange[] }

/** Per-account memory between evaluations. */
export interface AlarmBaseline {
  /** Last cycle's KPI values, `${entity}|${metric}` → value. */
  kpi: Record<string, string>
  /** breach type (metric) → agent → when last seen breaching (ms). */
  agentSeen: Record<string, Record<string, number>>
}

/**
 * How long an agent stays "known" after they were last seen breaching.
 *
 * Agent timers tick locally every second and get corrected by fresh data
 * every ~30s, so an agent sitting right at a threshold can drop out of the
 * breach list and come straight back. Without this memory each bounce would
 * count as a "new agent breaching" and ring. A genuine re-breach — the agent
 * changed status, then ran long again — takes longer than this anyway.
 */
export const AGENT_MEMORY_MS = 2 * 60 * 1000

/**
 * Compare every eligible account's breaches with its baseline. PURE — no
 * timers, audio or React (pass `now` in) — so the rule can be tested directly.
 *
 * The comparison always uses ALL breaches; `severity` only filters which
 * changes are allowed to ring. Filtering before comparing would make every
 * warning look brand-new the moment someone switched "critical only" off.
 *
 * @param baselines  memory per account (absent = never seen → sets it silently)
 * @param breaches   current breach rows per account
 * @param eligible   accounts whose data is loaded, configured, and not stale
 */
export function evaluateAlarm(
  baselines: Map<string, AlarmBaseline>,
  breaches: Record<string, BreachRow[]>,
  eligible: string[],
  severity: 'all' | 'critical',
  now: number,
): { events: AlarmEvent[]; next: Map<string, AlarmBaseline> } {
  const next = new Map(baselines)
  const events: AlarmEvent[] = []

  for (const accountId of eligible) {
    const rows = breaches[accountId] ?? []
    const prev = baselines.get(accountId)

    // What counts as already known: last cycle's KPI values, and every agent
    // seen breaching within AGENT_MEMORY_MS.
    const known: RtaLogsState | undefined = prev && {
      kpi: prev.kpi,
      agent: Object.fromEntries(Object.entries(prev.agentSeen).map(([metric, agents]) =>
        [metric, Object.keys(agents).filter(a => now - agents[a] <= AGENT_MEMORY_MS)])),
    }
    const { changes, currentSnapshot } = explainBreachChanges(rows, known)

    // First sighting of the account sets the baseline without ringing.
    if (prev && changes.length) {
      const sevOf = (c: BreachChange) => c.kind === 'kpi'
        ? rows.find(r => r.kind === 'kpi' && r.entity === c.entity && r.metric === c.metric)?.severity
        : rows.find(r => r.kind === 'agent' && r.entity === c.agent && r.metric === c.metric)?.severity
      const ringing = severity === 'all' ? changes : changes.filter(c => sevOf(c) === 'critical')
      if (ringing.length) events.push({ accountId, changes: ringing })
    }

    // Next memory: KPI values as of now; agents kept while still within memory.
    const agentSeen: Record<string, Record<string, number>> = {}
    for (const [metric, agents] of Object.entries(prev?.agentSeen ?? {})) {
      for (const [a, t] of Object.entries(agents)) {
        if (now - t <= AGENT_MEMORY_MS) (agentSeen[metric] ??= {})[a] = t
      }
    }
    for (const [metric, agents] of Object.entries(currentSnapshot.agent)) {
      for (const a of agents) (agentSeen[metric] ??= {})[a] = now
    }
    next.set(accountId, { kpi: currentSnapshot.kpi, agentSeen })
  }
  return { events, next }
}

/** Short human summary for the bell's tooltip, e.g. "Flex — SLA 85% → 74%". */
export function describeEvent(e: AlarmEvent, name: (id: string) => string): string {
  const first = e.changes[0]
  const more = e.changes.length > 1 ? ` (+${e.changes.length - 1} more)` : ''
  const what = first.kind === 'kpi'
    ? `${first.metric}${first.entity && first.entity !== 'Global' ? ` (${first.entity})` : ''} ${first.previous ? `${first.previous} → ` : ''}${first.value}`
    : `${first.agent} breaching ${first.metric}`
  return `${name(e.accountId)} — ${what}${more}`
}

// ── Playing it ───────────────────────────────────────────────────────────────
let uploaded: HTMLAudioElement | null = null
let uploadedSrc: string | null = null

/** Keep one preloaded <audio> per uploaded file, so it plays without a fetch delay. */
export function preloadAlarm(s: GlobalAlarmSettings): void {
  if (typeof window === 'undefined') return
  if (s.soundKind !== 'upload' || !s.soundUrl) { uploaded = null; uploadedSrc = null; return }
  if (uploadedSrc === s.soundUrl) return
  uploaded = new Audio(s.soundUrl)
  uploaded.preload = 'auto'
  uploadedSrc = s.soundUrl
}

/** 'played' | 'blocked' (browser needs a click/keypress on the page first). */
export async function playGlobalAlarm(s: GlobalAlarmSettings): Promise<'played' | 'blocked'> {
  if (s.soundKind === 'upload' && s.soundUrl) {
    preloadAlarm(s)
    const a = uploaded!
    try {
      a.volume = Math.min(1, Math.max(0, s.volume))
      a.currentTime = 0
      await a.play()
      return 'played'
    } catch {
      return 'blocked'
    }
  }
  return playAlarm(s.builtinKey, s.volume) ? 'played' : 'blocked'
}

export { audioAllowed, unlockAudio, onAudioStateChange }

// ── Per-screen mute (a convenience, not a setting) ──────────────────────────
const MUTE_KEY = 'wfm_alarm_muted'
export function isMutedHere(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
export function setMutedHere(muted: boolean): void {
  try { muted ? localStorage.setItem(MUTE_KEY, '1') : localStorage.removeItem(MUTE_KEY) } catch {}
}
