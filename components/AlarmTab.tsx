'use client'

// components/AlarmTab.tsx
// Settings → Alarm (super users only): the ONE breach alarm used by every
// account. Rules live in lib/globalAlarm.ts; saving goes through
// app/api/alarm (settings) and app/api/alarm/sound (the uploaded file), both
// of which re-check that the caller is a super user.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/authClient'
import { ALARM_SOUNDS } from '@/lib/alarmSounds'
import { loadAlarmSettings, playGlobalAlarm, DEFAULT_ALARM_SETTINGS, type GlobalAlarmSettings } from '@/lib/globalAlarm'

const BUILTINS = ALARM_SOUNDS.filter(s => s.key !== 'none')

export default function AlarmTab() {
  const [saved, setSaved] = useState<GlobalAlarmSettings>(DEFAULT_ALARM_SETTINGS)
  const [draft, setDraft] = useState<GlobalAlarmSettings>(DEFAULT_ALARM_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [setupMissing, setSetupMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // keepDraft: after an upload/remove, refresh only the SOUND fields of the
  // draft, so other unsaved edits (on/off, volume…) aren't thrown away.
  const load = useCallback(async (keepDraft = false) => {
    if (!keepDraft) setLoading(true)
    // A direct check, because loadAlarmSettings() deliberately hides errors
    // (dashboards just treat a missing table as "alarm off").
    const { error: e } = await supabase.from('wfm_alarm_settings').select('id').limit(1)
    setSetupMissing(!!e)
    const s = await loadAlarmSettings()
    setSaved(s)
    setDraft(d => keepDraft ? { ...d, soundKind: s.soundKind, soundUrl: s.soundUrl, soundName: s.soundName } : s)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.') }
    finally { setBusy(false) }
  }

  const save = () => run(async () => {
    await apiFetch('/api/alarm', {
      method: 'POST',
      body: JSON.stringify({
        enabled: draft.enabled, soundKind: draft.soundKind, builtinKey: draft.builtinKey,
        volume: draft.volume, severity: draft.severity, minGapSeconds: draft.minGapSeconds,
      }),
    })
    await load()
    setNotice(draft.enabled
      ? 'Saved. Every open dashboard picks this up within about two minutes (or straight away on reload).'
      : 'Saved. The alarm is off for every account.')
  })

  const upload = (file: File) => run(async () => {
    const fd = new FormData()
    fd.append('file', file)
    const r = await apiFetch('/api/alarm/sound', { method: 'POST', body: fd })
    await load(true)
    setNotice(`Uploaded "${r.name}". It's now the alarm sound.`)
  })

  const removeUpload = () => run(async () => {
    await apiFetch('/api/alarm/sound', { method: 'DELETE' })
    await load(true)
    setNotice('Uploaded sound removed — using the built-in sound.')
  })

  const test = async () => {
    setError(null)
    const r = await playGlobalAlarm({ ...draft, enabled: true })
    if (r === 'blocked') setError('The browser blocked the sound. Click anywhere on the page once, then try again.')
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  if (loading) return <p className="sm-desc">Loading…</p>

  return (
    <div>
      <div className="sm-section-title">GLOBAL BREACH ALARM</div>
      <p className="sm-desc">
        One alarm sound for every account. It plays on every signed-in dashboard, for the accounts that person can see.
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

      {/* ── Sound ───────────────────────────────────────────────────────── */}
      <div className="ds-mini-label">Sound</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '6px 0 18px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="radio" name="alarm-kind" checked={draft.soundKind === 'builtin'}
                 onChange={() => setDraft({ ...draft, soundKind: 'builtin' })} />
          Built-in
          <select className="ds-select" value={draft.builtinKey} disabled={draft.soundKind !== 'builtin'}
                  onChange={e => setDraft({ ...draft, builtinKey: e.target.value })}>
            {BUILTINS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
          <input type="radio" name="alarm-kind" checked={draft.soundKind === 'upload'} disabled={!saved.soundUrl}
                 onChange={() => setDraft({ ...draft, soundKind: 'upload' })} />
          Uploaded file
          {saved.soundUrl
            ? <span className="sm-metric-sub">{saved.soundName || 'custom sound'}</span>
            : <span className="sm-metric-sub">none uploaded yet</span>}
          <button type="button" className="sm-btn-cancel" style={{ padding: '4px 10px', fontSize: 12 }}
                  disabled={busy || setupMissing} onClick={() => fileRef.current?.click()}>
            <i className="bx bx-upload" /> {saved.soundUrl ? 'Replace' : 'Upload'}…
          </button>
          {saved.soundUrl && (
            <button type="button" className="sm-btn-cancel" style={{ padding: '4px 10px', fontSize: 12 }}
                    disabled={busy} onClick={removeUpload}>
              <i className="bx bx-trash" /> Remove
            </button>
          )}
          <input ref={fileRef} type="file" hidden
                 accept="audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4,audio/aac,.mp3,.wav,.ogg,.m4a,.aac,.webm"
                 onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
        </label>
        <span className="sm-desc" style={{ margin: 0 }}>MP3, WAV, OGG or M4A, up to 2 MB. Short sounds (1–3 seconds) work best.</span>
      </div>

      {/* ── Volume + test ───────────────────────────────────────────────── */}
      <div className="ds-mini-label">Volume — {Math.round(draft.volume * 100)}%</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 18px' }}>
        <input type="range" min={0} max={100} step={5} value={Math.round(draft.volume * 100)}
               style={{ flex: 1, maxWidth: 260 }}
               onChange={e => setDraft({ ...draft, volume: Number(e.target.value) / 100 })} />
        <button type="button" className="sm-btn-cancel" style={{ padding: '5px 12px', fontSize: 12 }} onClick={test}>
          <i className="bx bx-play" /> Test sound
        </button>
      </div>

      {/* ── When ────────────────────────────────────────────────────────── */}
      <div className="ds-mini-label">Ring for</div>
      <div style={{ display: 'flex', gap: 16, margin: '6px 0 18px', fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="radio" name="alarm-sev" checked={draft.severity === 'all'}
                 onChange={() => setDraft({ ...draft, severity: 'all' })} />
          Warning and critical breaches
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="radio" name="alarm-sev" checked={draft.severity === 'critical'}
                 onChange={() => setDraft({ ...draft, severity: 'critical' })} />
          Critical only
        </label>
      </div>

      <div className="ds-mini-label">Minimum gap between alarms</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 18px', fontSize: 13 }}>
        <input className="sm-input" type="number" min={0} max={3600} step={5} style={{ width: 90 }}
               value={draft.minGapSeconds}
               onChange={e => setDraft({ ...draft, minGapSeconds: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) })} />
        seconds
      </div>

      <div className="auth-note" style={{ marginBottom: 16 }}>
        <strong>When it rings</strong>
        <ul style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
          <li><b>KPI breaches</b> — when the value <i>changes</i> while still breaching (SLA 85% → 74% rings; staying at 85% doesn&apos;t).</li>
          <li><b>Agent status</b> — when a <i>new</i> agent starts breaching, or a new aux/status starts breaching. An agent&apos;s time climbing doesn&apos;t ring.</li>
          <li>Opening or reloading the dashboard is silent — breaches already on screen become the starting point.</li>
          <li>Never on stale data (&ldquo;DATA NOT IN SYNC&rdquo;), and never more often than the minimum gap above.</li>
          <li>Each screen can mute itself with the bell in the top bar. While this alarm is on, the old per-account alarm sounds stay quiet.</li>
        </ul>
        <p style={{ margin: '8px 0 0' }} className="sm-metric-sub">
          Note: KPIs whose value is a running time (e.g. longest wait) change on every refresh while breaching, so they ring each refresh — the minimum gap keeps that in check.
        </p>
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
