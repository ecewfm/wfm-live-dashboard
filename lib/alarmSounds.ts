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

function tone(c: AudioContext, freq: number, startOffset: number, dur: number, type: OscillatorType = 'sine', gain = 0.15) {
  const osc = c.createOscillator()
  const g   = c.createGain()
  osc.type = type
  const startAt = c.currentTime + startOffset
  osc.frequency.setValueAtTime(freq, startAt)
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(gain, startAt + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(startAt)
  osc.stop(startAt + dur + 0.05)
}

export function playAlarm(key: string | undefined | null) {
  const c = getCtx()
  if (!c || !key || key === 'none') return

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
      g.gain.setValueAtTime(0.12, now)
      osc.frequency.setValueAtTime(440, now)
      osc.frequency.linearRampToValueAtTime(880, now + 0.4)
      osc.frequency.linearRampToValueAtTime(440, now + 0.8)
      g.gain.setValueAtTime(0.12, now + 0.8)
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
}
