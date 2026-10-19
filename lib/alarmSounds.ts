// lib/alarmSounds.ts
// Per-account breach alarm sounds for the Overview page. Synthesized with the
// Web Audio API (a few oscillators per sound) instead of shipping audio
// files — keeps this dependency-free and lets every sound be generated on
// the fly, no assets to host/version.

export const ALARM_SOUNDS = [
  { key: 'none',  label: 'None (silent)' },
  { key: 'beep',  label: 'Classic Beep' },
  { key: 'siren', label: 'Siren' },
  { key: 'chime', label: 'Digital Chime' },
  { key: 'pulse', label: 'Alert Pulse' },
  { key: 'bell',  label: 'Bell' },
] as const

export type AlarmSoundKey = typeof ALARM_SOUNDS[number]['key']

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as any).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  // Browsers start an AudioContext suspended until a user gesture — resume()
  // is a no-op if it's already running, so safe to call every time.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// Master volume for the sound currently being played (0–1). The per-sound
// gains below were tuned at 1; this scales them for the global alarm's
// volume setting.
let vol = 1

function tone(c: AudioContext, freq: number, startOffset: number, dur: number, type: OscillatorType = 'sine', gain = 0.15) {
  const osc = c.createOscillator()
  const g   = c.createGain()
  osc.type = type
  const startAt = c.currentTime + startOffset
  osc.frequency.setValueAtTime(freq, startAt)
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(Math.max(0.0002, gain * vol), startAt + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(startAt)
  osc.stop(startAt + dur + 0.05)
}

/**
 * Will the browser actually play sound right now?
 *
 * Asks the audio engine itself rather than guessing from "has the user
 * clicked yet" (navigator.userActivation) — the two genuinely disagree:
 * Chrome can block audio on a page that has had activation, and allow it on
 * one that hasn't (media-engagement score, policy flags). An AudioContext is
 * created 'suspended' when sound is blocked and 'running' when it isn't, so
 * its state is the real answer.
 */
export function audioAllowed(): boolean {
  const c = getCtx()
  return !!c && c.state === 'running'
}

/** Call from a click/keypress handler: that gesture is what unblocks audio. */
export function unlockAudio(): void {
  getCtx()?.resume().catch(() => {})
}

/** Run `cb` whenever audio becomes blocked/unblocked. Returns an unsubscribe. */
export function onAudioStateChange(cb: () => void): () => void {
  const c = getCtx()
  if (!c) return () => {}
  c.addEventListener('statechange', cb)
  return () => c.removeEventListener('statechange', cb)
}

/**
 * Play a built-in sound. Returns false when the browser is still blocking
 * audio (no click/keypress on the page yet) — the sound is silently dropped
 * in that case, so callers can surface "click to enable sound" instead of
 * assuming it rang.
 */
export function playAlarm(key: string | undefined | null, volume = 1): boolean {
  if (!key || key === 'none') return true
  const c = getCtx()
  if (!c) return false
  if (c.state !== 'running') {
    // Inside a click/keypress (a "Test sound" button) the context can still be
    // mid-resume — schedule anyway: the tones wait on its frozen clock and
    // play the moment it starts. Outside a gesture it's genuinely blocked, so
    // drop the sound rather than queue it — otherwise every alarm missed while
    // blocked would blare at once on the next click.
    if (!(navigator as any).userActivation?.isActive) return false
    c.resume().catch(() => {})
  }
  vol = Math.min(1, Math.max(0, volume))

  switch (key) {
    case 'beep':
      tone(c, 880, 0,    0.15, 'sine', 0.16)
      tone(c, 880, 0.22, 0.15, 'sine', 0.16)
      break

    case 'siren': {
      const osc = c.createOscillator()
      const g   = c.createGain()
      osc.type = 'sawtooth'
      const now = c.currentTime
      g.gain.setValueAtTime(Math.max(0.0002, 0.12 * vol), now)
      osc.frequency.setValueAtTime(440, now)
      osc.frequency.linearRampToValueAtTime(880, now + 0.4)
      osc.frequency.linearRampToValueAtTime(440, now + 0.8)
      g.gain.setValueAtTime(Math.max(0.0002, 0.12 * vol), now + 0.8)
      g.gain.linearRampToValueAtTime(0.0001, now + 0.95)
      osc.connect(g)
      g.connect(c.destination)
      osc.start(now)
      osc.stop(now + 1)
      break
    }

    case 'chime':
      tone(c, 1046.5, 0,    0.3, 'sine', 0.13)
      tone(c, 1318.5, 0.12, 0.3, 'sine', 0.13)
      tone(c, 1568,   0.24, 0.45, 'sine', 0.13)
      break

    case 'pulse':
      tone(c, 660, 0,    0.1, 'square', 0.1)
      tone(c, 660, 0.15, 0.1, 'square', 0.1)
      tone(c, 660, 0.3,  0.1, 'square', 0.1)
      break

    case 'bell':
      tone(c, 987.8,  0, 0.6, 'triangle', 0.14)
      tone(c, 1975.5, 0, 0.6, 'triangle', 0.05)
      break

    default:
      tone(c, 880, 0, 0.15)
  }
  return true
}
