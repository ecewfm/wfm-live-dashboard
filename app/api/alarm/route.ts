// app/api/alarm/route.ts
// Save the global breach-alarm settings (Settings → Alarm). Super users only.
//
// Reads don't come through here: every dashboard reads wfm_alarm_settings
// directly (its RLS allows SELECT). Writes MUST come through here — the table
// has no write policy, and this route checks the caller's role on its first
// line before touching it with the service-role key.

import { requireRole, errorResponse, json, admin, AuthError } from '@/lib/authServer'
import { ALARM_SOUNDS } from '@/lib/alarmSounds'

const BUILTIN_KEYS: string[] = ALARM_SOUNDS.map(s => s.key).filter(k => k !== 'none')

// Columns added after the table was first created (sql/global_alarm.sql's
// upgrade section), as the groups they were added in. PostgREST rejects a
// whole upsert over one unknown column, so when the table predates a group
// (SQL not re-run yet), that group is dropped and the rest still saves.
const NEWER_COLUMN_GROUPS: string[][] = [
  ['ring_mode'],
  ['warning_sound_kind', 'warning_builtin_key', 'warning_volume'],
]

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser'])
    const b = await req.json().catch(() => ({}))

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: me.username }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled
    if (b.builtinKey !== undefined) {
      if (!BUILTIN_KEYS.includes(b.builtinKey)) throw new AuthError(400, `Unknown built-in sound "${b.builtinKey}".`)
      patch.builtin_key = b.builtinKey
    }
    if (b.soundKind !== undefined) {
      if (b.soundKind !== 'builtin' && b.soundKind !== 'upload') throw new AuthError(400, 'soundKind must be builtin or upload.')
      patch.sound_kind = b.soundKind
    }
    if (b.volume !== undefined) {
      const v = Number(b.volume)
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new AuthError(400, 'Volume must be between 0 and 1.')
      patch.volume = v
    }
    if (b.severity !== undefined) {
      if (b.severity !== 'all' && b.severity !== 'critical') throw new AuthError(400, 'severity must be all or critical.')
      patch.severity = b.severity
    }
    if (b.ringMode !== undefined) {
      if (b.ringMode !== 'once' && b.ringMode !== 'until_ack') throw new AuthError(400, 'ringMode must be once or until_ack.')
      patch.ring_mode = b.ringMode
    }
    if (b.minGapSeconds !== undefined) {
      const g = Math.round(Number(b.minGapSeconds))
      if (!Number.isFinite(g) || g < 0 || g > 3600) throw new AuthError(400, 'Minimum gap must be 0–3600 seconds.')
      patch.min_gap_seconds = g
    }
    // The warning breaches' own sound ('same' = use the critical sound).
    if (b.warningSoundKind !== undefined) {
      if (!['same', 'builtin', 'upload'].includes(b.warningSoundKind)) throw new AuthError(400, 'warningSoundKind must be same, builtin or upload.')
      patch.warning_sound_kind = b.warningSoundKind
    }
    if (b.warningBuiltinKey !== undefined) {
      if (!BUILTIN_KEYS.includes(b.warningBuiltinKey)) throw new AuthError(400, `Unknown built-in sound "${b.warningBuiltinKey}".`)
      patch.warning_builtin_key = b.warningBuiltinKey
    }
    if (b.warningVolume !== undefined) {
      const v = Number(b.warningVolume)
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new AuthError(400, 'Warning volume must be between 0 and 1.')
      patch.warning_volume = v
    }

    const db = admin()
    // Can't select "upload" without a file actually uploaded.
    if (patch.sound_kind === 'upload') {
      const { data } = await db.from('wfm_alarm_settings').select('sound_url').eq('id', 'global').maybeSingle()
      if (!data?.sound_url) throw new AuthError(400, 'Upload a sound file first.')
    }
    if (patch.warning_sound_kind === 'upload') {
      const { data } = await db.from('wfm_alarm_settings').select('warning_sound_url').eq('id', 'global').maybeSingle()
      if (!data?.warning_sound_url) throw new AuthError(400, 'Upload a warning sound file first.')
    }

    let { error } = await db.from('wfm_alarm_settings').upsert({ id: 'global', ...patch })

    // Table older than some of these columns: save everything else and say
    // so, instead of making every alarm setting unsaveable until the SQL is
    // run (see NEWER_COLUMN_GROUPS).
    let needsMigration = false
    for (let tries = 0; error && tries < NEWER_COLUMN_GROUPS.length; tries++) {
      const msg = error.message   // names one missing column at a time, in no set order
      const group = NEWER_COLUMN_GROUPS.find(g => g.some(c => c in patch && new RegExp(c, 'i').test(msg)))
      if (!group) break
      for (const c of group) delete patch[c]
      needsMigration = true
      ;({ error } = await db.from('wfm_alarm_settings').upsert({ id: 'global', ...patch }))
    }
    if (error) {
      throw new AuthError(500, /does not exist|relation/i.test(error.message)
        ? 'The alarm settings table is missing — run sql/global_alarm.sql in Supabase first.'
        : `Could not save: ${error.message}`)
    }
    return json({ ok: true, ...(needsMigration ? { needsMigration: true } : {}) })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
