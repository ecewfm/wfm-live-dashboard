'use client'

// components/AlarmTab.tsx
// Settings → Alarm (super users only): the ONE breach alarm used by every
// account — with its own sound for critical breaches and for warnings (per the
// user, 2026-10-26). Rules live in lib/globalAlarm.ts; saving goes through
// app/api/alarm (settings) and app/api/alarm/sound (the uploaded files, one
// per severity), both of which re-check that the caller is a super user.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/authClient'
import { ALARM_SOUNDS } from '@/lib/alarmSounds'
import {
  loadAlarmSettings, playGlobalAlarm, alarmSoundFor, DEFAULT_ALARM_SETTINGS, ALARM_PREVIEW_EVENT,
  type GlobalAlarmSettings, type AlarmSeverity, type AlarmPreview,
} from '@/lib/globalAlarm'

const BUILTINS = ALARM_SOUNDS.filter(s => s.key !== 'none')

/** One severity's sound fields in the settings — critical uses the original ones. */
const SOUND_FIELDS = {
  critical: ['soundKind', 'soundUrl', 'soundName'],
  warning:  ['warningSoundKind', 'warningSoundUrl', 'warningSoundName'],
} as const

export default function AlarmTab() {
  const [saved, setSaved] = useState<GlobalAlarmSettings>(DEFAULT_ALARM_SETTINGS)
  const [draft, setDraft] = useState<GlobalAlarmSettings>(DEFAULT_ALARM_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [setupMissing, setSetupMissing] = useState(false)
  // Table exists but predates a newer column (SQL not re-run yet).
  const [ringModeMissing, setRingModeMissing] = useState(false)
  const [warningMissing, setWarningMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // keepDraftExcept: after an upload/remove, refresh only THAT severity's
  // sound fields in the draft, so other unsaved edits aren't thrown away.
  const load = useCallback(async (keepDraftExcept?: AlarmSeverity) => {
    if (!keepDraftExcept) setLoading(true)
    // A direct check, because loadAlarmSettings() deliberately hides errors
    // (dashboards just treat a missing table as "alarm off").
    const { error: e } = await supabase.from('wfm_alarm_settings').select('id').limit(1)
    setSetupMissing(!!e)
    // Separate probes for the newer columns, so an older table still works.
    const probe = async (col: string) => e ? false : !!(await supabase.from('wfm_alarm_settings').select(col).limit(1)).error
    setRingModeMissing(await probe('ring_mode'))
    setWarningMissing(await probe('warning_sound_kind'))
    const s = await loadAlarmSettings()
    setSaved(s)
    setDraft(d => {
      if (!keepDraftExcept) return s
      const next = { ...d }
      for (const f of SOUND_FIELDS[keepDraftExcept]) (next as Record<string, unknown>)[f] = s[f]
      return next
    })
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.') }
    finally { setBusy(false) }
  }

  const save = () => run(async () => {
    const r = await apiFetch('/api/alarm', {
      method: 'POST',
      body: JSON.stringify({
        enabled: draft.enabled, soundKind: draft.soundKind, builtinKey: draft.builtinKey,
        volume: draft.volume, severity: draft.severity, minGapSeconds: draft.minGapSeconds,
        // Not sent while their columns are missing — the save would be rejected over them.
        ...(ringModeMissing ? {} : { ringMode: draft.ringMode }),
        ...(warningMissing ? {} : {
          warningSoundKind: draft.warningSoundKind, warningBuiltinKey: draft.warningBuiltinKey, warningVolume: draft.warningVolume,
        }),
      }),
    })
    await load()
    if (r?.needsMigration) {
      setError('Saved, except the newer settings: the database needs the updated sql/global_alarm.sql first. Run it in the Supabase SQL editor, then save again.')
    } else {
      setNotice(draft.enabled
        ? 'Saved. Every open dashboard picks this up within about two minutes (or straight away on reload).'
        : 'Saved. The alarm is off for every account.')
    }
  })

  const slotQuery = (slot: AlarmSeverity) => slot === 'warning' ? '?slot=warning' : ''

  const upload = (slot: AlarmSeverity, file: File) => run(async () => {
    const fd = new FormData()
    fd.append('file', file)
    const r = await apiFetch(`/api/alarm/sound${slotQuery(slot)}`, { method: 'POST', body: fd })
    await load(slot)
    setNotice(`Uploaded "${r.name}". It's now the ${slot} breach sound.`)
  })

  const removeUpload = (slot: AlarmSeverity) => run(async () => {
    await apiFetch(`/api/alarm/sound${slotQuery(slot)}`, { method: 'DELETE' })
    await load(slot)
    setNotice(`Uploaded ${slot} sound removed — using a built-in sound.`)
  })

  const test = async (slot: AlarmSeverity) => {
    setError(null)
    const r = await playGlobalAlarm(alarmSoundFor(draft, slot))
    if (r === 'blocked') setError('The browser blocked the sound. Click anywhere on the page once, then try again.')
    if (r === 'broken')  setError('That file couldn\'t be played. Try another MP3 or WAV, or use a built-in sound. (If this happens during a real alarm, the built-in sound plays instead.)')
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  // The real prompt + looping sound, on this screen, with the SAVED settings.
  const preview = (severity: AlarmSeverity) => {
    setError(null); setNotice(null)
    window.dispatchEvent(new CustomEvent<AlarmPreview>(ALARM_PREVIEW_EVENT, { detail: { settings: saved, severity } }))
  }
  const previewBlockedWhy = !saved.enabled ? 'Turn the alarm on and save first.' : dirty ? 'Save your changes first.' : null
  const keepRinging = draft.ringMode === 'until_ack'
  const warningsRing = draft.severity === 'all'

  if (loading) return <p className="sm-desc">Loading…</p>

  return (
    <div>
      <div className="sm-section-title">GLOBAL BREACH ALARM</div>
      <p className="sm-desc">
        One alarm for every account, with its own sound for critical breaches and for warnings. It plays on every signed-in dashboard, for the accounts that person can see.
      </p>

      {setupMissing && (
        <div className="auth-note auth-note-err" style={{ marginBottom: 12 }}>
          The alarm isn&apos;t set up in the database yet. Run <code>sql/global_alarm.sql</code> in the Supabase SQL editor, then reopen this tab.
        </div>
      )}
      {error  && <div className="auth-note auth-note-err" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="auth-note auth-note-ok"  style={{ marginBottom: 12 }}>{notice}</div>}

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 18px', fontSize: 13, fontWeight: 600 }}>
        <span className="sm-toggle">
          <input type="checkbox" checked={draft.enabled} disabled={setupMissing}
                 onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
          <span className="sm-toggle-track" />
        </span>
        Alarm {draft.enabled ? 'on' : 'off'} for all accounts
      </label>

      {/* ── Critical breaches ───────────────────────────────────────────── */}
      <div className="alarm-sev-block crit">
        <div className="alarm-sev-head"><span className="badge-crit">Critical</span> breaches</div>
        <SoundChoice slot="critical" draft={draft} saved={saved} setDraft={setDraft} busy={busy} disabled={setupMissing}
                     onUpload={f => upload('critical', f)} onRemove={() => removeUpload('critical')} />
        <VolumeRow label="Volume" value={draft.volume} onChange={v => setDraft(d => ({ ...d, volume: v }))} onTest={() => test('critical')} />
      </div>

      {/* ── Warning breaches ────────────────────────────────────────────── */}
      <div className="alarm-sev-block warn">
        <div className="alarm-sev-head"><span className="badge-warn">Warning</span> breaches</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 10px', fontSize: 13, fontWeight: 600 }}>
          <span className="sm-toggle">
            <input type="checkbox" checked={warningsRing} disabled={setupMissing}
                   onChange={e => setDraft({ ...draft, severity: e.target.checked ? 'all' : 'critical' })} />
            <span className="sm-toggle-track" />
          </span>
          Ring for warning breaches too
        </label>
        {!warningsRing ? (
          <p className="sm-desc" style={{ margin: 0 }}>Off — only critical breaches ring.</p>
        ) : (
          <>
            <SoundChoice slot="warning" draft={draft} saved={saved} setDraft={setDraft} busy={busy}
                         disabled={setupMissing} sameOnly={warningMissing}
                         onUpload={f => upload('warning', f)} onRemove={() => removeUpload('warning')} />
            {warningMissing && !setupMissing && (
              <div className="auth-note auth-note-err" style={{ margin: '0 0 12px' }}>
                A separate warning sound needs a small database update. Run the updated <code>sql/global_alarm.sql</code> in the Supabase SQL editor (it&apos;s safe to run again), then reopen this tab. Until then warnings use the critical sound.
              </div>
            )}
            {draft.warningSoundKind === 'same' || warningMissing
              ? <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 4px' }}>
                  <span className="sm-metric-sub">Same sound and volume as critical breaches.</span>
                  <button type="button" className="sm-btn-cancel" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => test('warning')}>
                    <i className="bx bx-play" /> Test sound
                  </button>
                </div>
              : <VolumeRow label="Volume" value={draft.warningVolume} onChange={v => setDraft(d => ({ ...d, warningVolume: v }))} onTest={() => test('warning')} />}
          </>
        )}
      </div>

      {/* ── How it rings ────────────────────────────────────────────────── */}
      <div className="ds-mini-label">How it rings</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 4px', fontSize: 13, fontWeight: 600 }}>
        <span className="sm-toggle">
          <input type="checkbox" checked={keepRinging} disabled={setupMissing || ringModeMissing}
                 onChange={e => setDraft({ ...draft, ringMode: e.target.checked ? 'until_ack' : 'once' })} />
          <span className="sm-toggle-track" />
        </span>
        Keep ringing until acknowledged
      </label>
      <p className="sm-desc" style={{ margin: '0 0 18px' }}>
        {keepRinging
          ? 'On — a prompt lists what changed and the sound repeats until someone presses Acknowledge on that screen.'
          : 'Off — the sound plays once for each change, then stops. Nothing to acknowledge.'}
      </p>
      {ringModeMissing && !setupMissing && (
        <div className="auth-note auth-note-err" style={{ margin: '-6px 0 16px' }}>
          This choice needs a small database update. Run the updated <code>sql/global_alarm.sql</code> in the Supabase SQL editor (it&apos;s safe to run again), then reopen this tab. Until then the alarm keeps ringing until acknowledged.
        </div>
      )}

      <div className="ds-mini-label">{keepRinging ? 'Quiet time after acknowledging' : 'Minimum gap between alarms'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', fontSize: 13 }}>
        <input className="sm-input" type="number" min={0} max={3600} step={5} style={{ width: 90 }}
               value={draft.minGapSeconds}
               onChange={e => setDraft({ ...draft, minGapSeconds: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) })} />
        seconds
      </div>
      <p className="sm-desc" style={{ margin: '0 0 18px' }}>
        {keepRinging
          ? 'After someone acknowledges, that screen won’t ring again for this long. New changes still show on the prompt straight away, and start ringing when the quiet time ends.'
          : 'However many changes happen, a screen rings at most once in this time.'}
      </p>

      <div className="auth-note" style={{ marginBottom: 16 }}>
        <strong>When it rings</strong>
        <ul style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
          <li><b>KPI breaches</b> — when the value <i>changes</i> while still breaching (SLA 85% → 74% rings; staying at 85% doesn&apos;t).</li>
          <li><b>Agent status</b> — when a <i>new</i> agent starts breaching, or a new aux/status starts breaching. An agent&apos;s time climbing doesn&apos;t ring.</li>
          <li><b>Which sound</b> — a critical breach plays the critical sound, a warning the warning sound. When both are waiting, the critical sound plays; a breach that turns from warning to critical switches to the critical sound.</li>
          {keepRinging
            ? <li><b>It keeps ringing until acknowledged.</b> A prompt lists what changed; it rings over and over until someone presses <b>Acknowledge</b> (or the bell) on that screen. Each screen acknowledges for itself. Further changes join the same prompt.</li>
            : <li><b>It rings once per change.</b> One ring, then silence until the next change — and never more often than the minimum gap above.</li>}
          <li>Opening or reloading the dashboard is silent — breaches already on screen become the starting point.</li>
          <li>Never on stale data (&ldquo;DATA NOT IN SYNC&rdquo;).</li>
          <li>Each screen can mute itself with the bell in the top bar. While this alarm is on, the old per-account alarm sounds stay quiet.</li>
        </ul>
        <p style={{ margin: '8px 0 0' }} className="sm-metric-sub">
          {keepRinging
            ? 'Note: KPIs whose value is a running time (e.g. longest wait) change on every refresh while breaching, so they come back after each acknowledgement once the quiet time is over. Raise the quiet time if that’s too often.'
            : 'Note: KPIs whose value is a running time (e.g. longest wait) change on every refresh while breaching, so they ring each refresh — the minimum gap keeps that in check.'}
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button" className="sm-btn-cancel" style={{ padding: '6px 12px', fontSize: 12 }}
                disabled={!!previewBlockedWhy || busy} onClick={() => preview('critical')}>
          <i className="bx bx-alarm" /> Preview critical
        </button>
        <button type="button" className="sm-btn-cancel" style={{ padding: '6px 12px', fontSize: 12 }}
                disabled={!!previewBlockedWhy || busy || saved.severity !== 'all'} onClick={() => preview('warning')}
                title={saved.severity !== 'all' ? 'Warnings don’t ring (saved setting)' : undefined}>
          <i className="bx bx-alarm" /> Preview warning
        </button>
        <span className="sm-metric-sub">
          {previewBlockedWhy ?? (saved.ringMode === 'until_ack'
            ? 'Shows the real prompt on this screen and rings until you press Acknowledge.'
            : 'Plays the sound once, like a real alarm.')}
        </span>
      </div>

      <button className="sm-btn-save" disabled={busy || !dirty || setupMissing} onClick={save}>
        {busy ? 'Saving…' : 'Save alarm settings'}
      </button>
      {dirty && (
        <button className="sm-btn-cancel" disabled={busy} onClick={() => setDraft(saved)} style={{ marginLeft: 8 }}>
          Discard changes
        </button>
      )}
    </div>
  )
}

// ── One severity's sound: built-in / uploaded file (/ same as critical) ─────
function SoundChoice({ slot, draft, saved, setDraft, busy, disabled, sameOnly, onUpload, onRemove }: {
  slot: AlarmSeverity
  draft: GlobalAlarmSettings
  saved: GlobalAlarmSettings
  setDraft: Dispatch<SetStateAction<GlobalAlarmSettings>>
  busy: boolean
  disabled: boolean
  /** Warning only, while its columns aren't migrated: just "same as critical". */
  sameOnly?: boolean
  onUpload: (f: File) => void
  onRemove: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const w = slot === 'warning'
  const kind = w ? (sameOnly ? 'same' : draft.warningSoundKind) : draft.soundKind
  const builtinKey = w ? draft.warningBuiltinKey : draft.builtinKey
  const uploadedUrl = w ? saved.warningSoundUrl : saved.soundUrl
  const uploadedName = w ? saved.warningSoundName : saved.soundName
  const setKind = (k: 'same' | 'builtin' | 'upload') =>
    setDraft(d => w ? { ...d, warningSoundKind: k } : { ...d, soundKind: k === 'upload' ? 'upload' : 'builtin' })
  const setBuiltin = (key: string) => setDraft(d => w ? { ...d, warningBuiltinKey: key } : { ...d, builtinKey: key })
  const name = `alarm-kind-${slot}`
  const locked = disabled || !!sameOnly

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '6px 0 14px' }}>
      {w && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="radio" name={name} checked={kind === 'same'} disabled={disabled} onChange={() => setKind('same')} />
          Same sound as critical breaches
        </label>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="radio" name={name} checked={kind === 'builtin'} disabled={locked} onChange={() => setKind('builtin')} />
        <span style={{ whiteSpace: 'nowrap' }}>Built-in</span>
        <select className="ds-select" value={builtinKey} disabled={locked || kind !== 'builtin'}
                style={{ width: 'auto', minWidth: 180 }}
                onChange={e => setBuiltin(e.target.value)}>
          {BUILTINS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
        <input type="radio" name={name} checked={kind === 'upload'} disabled={locked || !uploadedUrl} onChange={() => setKind('upload')} />
        Uploaded file
        {uploadedUrl
          ? <span className="sm-metric-sub">{uploadedName || 'custom sound'}</span>
          : <span className="sm-metric-sub">none uploaded yet</span>}
        <button type="button" className="sm-btn-cancel" style={{ padding: '4px 10px', fontSize: 12 }}
                disabled={busy || locked} onClick={() => fileRef.current?.click()}>
          <i className="bx bx-upload" /> {uploadedUrl ? 'Replace' : 'Upload'}…
        </button>
        {uploadedUrl && (
          <button type="button" className="sm-btn-cancel" style={{ padding: '4px 10px', fontSize: 12 }}
                  disabled={busy || locked} onClick={onRemove}>
            <i className="bx bx-trash" /> Remove
          </button>
        )}
        <input ref={fileRef} type="file" hidden
               accept="audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4,audio/aac,.mp3,.wav,.ogg,.m4a,.aac,.webm"
               onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />
      </label>
      {!w && <span className="sm-desc" style={{ margin: 0 }}>MP3, WAV, OGG or M4A, up to 2 MB. Short sounds (1–3 seconds) work best.</span>}
    </div>
  )
}

function VolumeRow({ label, value, onChange, onTest }: {
  label: string; value: number; onChange: (v: number) => void; onTest: () => void
}) {
  return (
    <>
      <div className="ds-mini-label">{label} — {Math.round(value * 100)}%</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 4px' }}>
        <input type="range" min={0} max={100} step={5} value={Math.round(value * 100)}
               style={{ flex: 1, maxWidth: 260 }}
               onChange={e => onChange(Number(e.target.value) / 100)} />
        <button type="button" className="sm-btn-cancel" style={{ padding: '5px 12px', fontSize: 12 }} onClick={onTest}>
          <i className="bx bx-play" /> Test sound
        </button>
      </div>
    </>
  )
}
