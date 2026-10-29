// lib/globalAlarm.ts
// The global breach alarm, configured by a super user (Settings → Alarm), that
// every signed-in dashboard plays for the accounts it can see.
//
// WHICH sound (per the user, 2026-10-26): critical and warning breaches each
// have their own sound and volume — alarmSoundFor(). The original single sound
// is the CRITICAL one (same columns); warnings use it too until someone picks
// a warning sound ('same', the default). When both are waiting on the prompt,
// the critical sound plays.
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
// HOW it rings is a setting (`ringMode`, Settings → Alarm):
//   - 'once'      one ring per change (playGlobalAlarm), never more often than
//                 `minGapSeconds`. No prompt, nothing to acknowledge.
//   - 'until_ack' keeps ringing (startAlarmLoop) until someone presses
//                 Acknowledge on that screen. Changes that arrive meanwhile join
//                 the same prompt (mergePending) rather than starting a second
//                 alarm. After an acknowledgement the screen stays quiet for
//                 `minGapSeconds`; changes in that window still show on the
//                 prompt, and the sound starts when it ends.
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
import { playAlarm, stopAllSounds, audioAllowed, unlockAudio, onAudioStateChange } from './alarmSounds'

export interface GlobalAlarmSettings {
  enabled: boolean
  // ── Critical breaches' sound (also the warning sound while warningSoundKind is 'same')
  soundKind: 'builtin' | 'upload'
  builtinKey: string
  soundUrl: string | null
  soundName: string | null
  volume: number
  /** 'all' = warning breaches ring too; 'critical' = critical only. */
  severity: 'all' | 'critical'
  // ── Warning breaches' sound. 'same' = the critical sound above.
  warningSoundKind: 'same' | 'builtin' | 'upload'
  warningBuiltinKey: string
  warningSoundUrl: string | null
  warningSoundName: string | null
  warningVolume: number
  /** 'once' = one ring per change; 'until_ack' = keeps ringing until acknowledged. */
  ringMode: RingMode
  /** 'once': minimum gap between rings. 'until_ack': quiet time after acknowledging. */
  minGapSeconds: number
}

export type RingMode = 'once' | 'until_ack'
export type AlarmSeverity = 'warning' | 'critical'

export const DEFAULT_ALARM_SETTINGS: GlobalAlarmSettings = {
  enabled: false, soundKind: 'builtin', builtinKey: 'siren', soundUrl: null, soundName: null,
  volume: 0.8, severity: 'all',
  warningSoundKind: 'same', warningBuiltinKey: 'chime', warningSoundUrl: null, warningSoundName: null, warningVolume: 0.8,
  ringMode: 'until_ack', minGapSeconds: 30,
}

/** Read the one global row. Falls back to "off" if the table isn't migrated yet. */
export async function loadAlarmSettings(): Promise<GlobalAlarmSettings> {
  try {
    const { data, error } = await supabase.from('wfm_alarm_settings').select('*').eq('id', 'global').maybeSingle()
    if (error || !data) return DEFAULT_ALARM_SETTINGS
    const volume = typeof data.volume === 'number' ? data.volume : 0.8
    return {
      enabled: !!data.enabled,
      soundKind: data.sound_kind === 'upload' && data.sound_url ? 'upload' : 'builtin',
      builtinKey: data.builtin_key || 'siren',
      soundUrl: data.sound_url ?? null,
      soundName: data.sound_name ?? null,
      volume,
      severity: data.severity === 'critical' ? 'critical' : 'all',
      // Missing columns (SQL not upgraded yet) → 'same': warnings sound like
      // criticals, exactly as before there were two sounds.
      warningSoundKind: data.warning_sound_kind === 'upload' ? (data.warning_sound_url ? 'upload' : 'builtin')
        : data.warning_sound_kind === 'builtin' ? 'builtin' : 'same',
      warningBuiltinKey: data.warning_builtin_key || 'chime',
      warningSoundUrl: data.warning_sound_url ?? null,
      warningSoundName: data.warning_sound_name ?? null,
      warningVolume: typeof data.warning_volume === 'number' ? data.warning_volume : volume,
      // Missing column (SQL not upgraded yet) or an unknown value → the default.
      ringMode: data.ring_mode === 'once' ? 'once' : 'until_ack',
      minGapSeconds: Number.isFinite(data.min_gap_seconds) ? data.min_gap_seconds : 30,
    }
  } catch {
    return DEFAULT_ALARM_SETTINGS
  }
}

/** One sound, ready to play: what alarmSoundFor() hands the players below. */
export interface AlarmSound {
  kind: 'builtin' | 'upload'
  builtinKey: string    // also the fallback when an uploaded file won't play
  url: string | null
  volume: number
}

/** The sound for a breach of this severity. */
export function alarmSoundFor(s: GlobalAlarmSettings, severity: AlarmSeverity): AlarmSound {
  if (severity === 'warning' && s.warningSoundKind !== 'same') {
    const upload = s.warningSoundKind === 'upload' && !!s.warningSoundUrl
    return { kind: upload ? 'upload' : 'builtin', builtinKey: s.warningBuiltinKey, url: upload ? s.warningSoundUrl : null, volume: s.warningVolume }
  }
  const upload = s.soundKind === 'upload' && !!s.soundUrl
  return { kind: upload ? 'upload' : 'builtin', builtinKey: s.builtinKey, url: upload ? s.soundUrl : null, volume: s.volume }
}

/** 'critical' if any of these is critical — that's the sound that plays. */
export function topSeverity(items: { severity: AlarmSeverity }[]): AlarmSeverity {
  return items.some(i => i.severity === 'critical') ? 'critical' : 'warning'
}

// ── The rule ─────────────────────────────────────────────────────────────────
/** A change, with the severity of the breach it's about (picks the sound). */
export type AlarmChange = BreachChange & { severity: AlarmSeverity }
export interface AlarmEvent { accountId: string; changes: AlarmChange[] }

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
      // Every change comes from a row in `rows`; 'critical' if it somehow
      // can't be found, so a doubt rings the louder alarm, not none.
      const sevOf = (c: BreachChange): AlarmSeverity => (c.kind === 'kpi'
        ? rows.find(r => r.kind === 'kpi' && r.entity === c.entity && r.metric === c.metric)?.severity
        : rows.find(r => r.kind === 'agent' && r.entity === c.agent && r.metric === c.metric)?.severity) ?? 'critical'
      const tagged: AlarmChange[] = changes.map(c => ({ ...c, severity: sevOf(c) }))
      const ringing = severity === 'all' ? tagged : tagged.filter(c => c.severity === 'critical')
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

/** One change in words, e.g. "SLA (Team A) 85% → 74%" or "Jane breaching Lunch". */
export function describeChange(c: BreachChange): string {
  return c.kind === 'kpi'
    ? `${c.metric}${c.entity && c.entity !== 'Global' ? ` (${c.entity})` : ''} ${c.previous ? `${c.previous} → ` : ''}${c.value}`
    : `${c.agent} breaching ${c.metric}`
}

/** Short human summary for the bell's tooltip, e.g. "Flex — SLA 85% → 74%". */
export function describeEvent(e: AlarmEvent, name: (id: string) => string): string {
  const more = e.changes.length > 1 ? ` (+${e.changes.length - 1} more)` : ''
  return `${name(e.accountId)} — ${describeChange(e.changes[0])}${more}`
}

// ── Waiting for an acknowledgement ──────────────────────────────────────────
/** Settings → Alarm's "Preview critical / warning" buttons fire this. */
export const ALARM_PREVIEW_EVENT = 'wfm-alarm-preview'
export interface AlarmPreview { settings: GlobalAlarmSettings; severity: AlarmSeverity }
/** Account id used for the preview's sample line. */
export const PREVIEW_ACCOUNT = '__alarm_preview__'

/** One line on the Acknowledge prompt: one breach, however often it changed. */
export interface PendingAlarm {
  key: string
  accountId: string
  /** The latest change (and its latest severity). For a KPI, `previous` is
   *  the value from BEFORE the first change, so the line reads "85% → 70%"
   *  across several updates. */
  change: AlarmChange
  firstAt: number
  lastAt: number
}

/**
 * Add new events to the unacknowledged list. PURE (pass `now`). A breach
 * that's already listed is updated in place — an SLA sliding 74 → 72 → 70
 * while nobody's looked is one line, not three.
 */
export function mergePending(pending: PendingAlarm[], events: AlarmEvent[], now: number): PendingAlarm[] {
  const out = pending.slice()
  for (const e of events) {
    for (const c of e.changes) {
      const key = c.kind === 'kpi'
        ? `${e.accountId}|kpi|${c.entity}|${c.metric}`
        : `${e.accountId}|agent|${c.metric}|${c.agent}`
      const i = out.findIndex(p => p.key === key)
      if (i < 0) { out.push({ key, accountId: e.accountId, change: c, firstAt: now, lastAt: now }); continue }
      const was = out[i].change
      const change: AlarmChange = c.kind === 'kpi' && was.kind === 'kpi'
        ? { ...c, previous: was.previous ?? was.value }
        : c
      out[i] = { ...out[i], change, lastAt: now }
    }
  }
  return out
}

// ── Playing it ───────────────────────────────────────────────────────────────
// One preloaded <audio> per uploaded file (critical and warning can each have
// one), so a sound plays without a fetch delay.
const uploaded = new Map<string, HTMLAudioElement>()

function audioFor(url: string): HTMLAudioElement {
  let a = uploaded.get(url)
  if (!a) { a = new Audio(url); a.preload = 'auto'; uploaded.set(url, a) }
  return a
}

/** Preload every uploaded sound these settings use, and forget the rest. */
export function preloadAlarm(s: GlobalAlarmSettings): void {
  if (typeof window === 'undefined') return
  const urls = new Set((['critical', 'warning'] as const).map(sev => alarmSoundFor(s, sev).url).filter((u): u is string => !!u))
  for (const [url, a] of uploaded) if (!urls.has(url)) { a.pause(); uploaded.delete(url) }
  for (const url of urls) audioFor(url)
}

/**
 * 'blocked' = the browser wants a click/keypress on the page first.
 * 'broken'  = the uploaded file itself won't play (missing, unsupported…).
 */
export type PlayResult = 'played' | 'blocked' | 'broken'

async function playUploaded(sound: AlarmSound): Promise<PlayResult> {
  const a = audioFor(sound.url!)
  try {
    a.volume = Math.min(1, Math.max(0, sound.volume))
    a.currentTime = 0
    await a.play()
    return 'played'
  } catch (e) {
    return (e as DOMException)?.name === 'NotAllowedError' ? 'blocked' : 'broken'
  }
}

/** Play a sound ONCE (Settings → Alarm's "Test sound"). */
export async function playGlobalAlarm(sound: AlarmSound): Promise<PlayResult> {
  if (sound.kind === 'upload' && sound.url) return playUploaded(sound)
  return playAlarm(sound.builtinKey, sound.volume) ? 'played' : 'blocked'
}

/**
 * Ring ONCE for a real alarm (ringMode 'once'). Unlike playGlobalAlarm (which
 * "Test sound" uses to tell you a file is broken), a broken uploaded file falls
 * back to the built-in sound here — a real alarm must never be silent.
 */
export async function ringOnce(sound: AlarmSound): Promise<'played' | 'blocked'> {
  if (sound.kind === 'upload' && sound.url) {
    const r = await playUploaded(sound)
    if (r !== 'broken') return r
  }
  return playAlarm(sound.builtinKey, sound.volume) ? 'played' : 'blocked'
}

// ── Looping until acknowledged ──────────────────────────────────────────────
/** Built-in sounds are 0.4–1s long; replay on this beat. */
const BUILTIN_REPEAT_MS = 1800
/** Pause between plays of an uploaded file. */
const UPLOAD_PAUSE_MS = 600
/** While the browser blocks audio, retry this often — the first click on the page lets it through. */
const BLOCKED_RETRY_MS = 1000

// Each loop gets its own id; `current` is the one allowed to keep going. A
// plain on/off flag isn't enough: a restart (new sound saved mid-alarm) while
// the old loop is still awaiting play() would leave BOTH running.
let loopSeq = 0
let current = 0
let loopTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Ring over and over until stopAlarmLoop(). If the uploaded file can't play,
 * falls back to the built-in sound: a broken upload must never mean silence.
 * `onResult` reports each attempt, so the page can show "sound is blocked".
 */
export function startAlarmLoop(sound: AlarmSound, onResult?: (r: PlayResult) => void): void {
  stopAlarmLoop()
  const id = current = ++loopSeq
  const alive = () => current === id
  const again = (ms: number) => { if (alive()) loopTimer = setTimeout(tick, ms) }
  const tick = async () => {
    if (!alive()) return
    let r: PlayResult = 'broken'
    if (sound.kind === 'upload' && sound.url) r = await playUploaded(sound)
    if (!alive()) { if (current === 0) stopAlarmLoop(); return }   // acknowledged while play() was starting
    if (r === 'played') {
      // Next play once this one finishes.
      audioFor(sound.url!).onended = () => again(UPLOAD_PAUSE_MS)
    } else if (r === 'blocked') {
      again(BLOCKED_RETRY_MS)
    } else {
      r = playAlarm(sound.builtinKey, sound.volume) ? 'played' : 'blocked'
      again(r === 'played' ? BUILTIN_REPEAT_MS : BLOCKED_RETRY_MS)
    }
    onResult?.(r)
  }
  tick()
}

/** Stop ringing immediately, mid-sound included. */
export function stopAlarmLoop(): void {
  current = 0
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null }
  for (const a of uploaded.values()) { a.onended = null; a.pause(); try { a.currentTime = 0 } catch {} }
  stopAllSounds()
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
