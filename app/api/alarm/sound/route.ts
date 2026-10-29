// app/api/alarm/sound/route.ts
// Upload (POST) or remove (DELETE) one of the global alarm's custom sound
// files. Super users only. The file goes to the public `wfm-alarm-sounds`
// bucket (sql/global_alarm.sql) so every dashboard can play it from its URL.
//
// `?slot=warning` is the WARNING breaches' own sound (warning_* columns);
// without it, the critical sound (the original sound_* columns).

import { requireRole, errorResponse, json, admin, AuthError } from '@/lib/authServer'

const BUCKET = 'wfm-alarm-sounds'
const MAX_BYTES = 2 * 1024 * 1024        // also enforced by the bucket itself
const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
}

const missingSetup = (msg: string) =>
  /warning_sound/i.test(msg)
    ? 'A separate warning sound needs the updated sql/global_alarm.sql — run it in Supabase first (it\'s safe to run again).'
    : /bucket not found|does not exist|relation/i.test(msg)
      ? 'Alarm storage isn\'t set up yet — run sql/global_alarm.sql in Supabase first.'
      : msg

/** The columns one slot's sound lives in. */
function slotOf(req: Request) {
  const warning = new URL(req.url).searchParams.get('slot') === 'warning'
  return warning
    ? { prefix: 'alarm-warning', kind: 'warning_sound_kind', url: 'warning_sound_url', path: 'warning_sound_path', name: 'warning_sound_name' }
    : { prefix: 'alarm', kind: 'sound_kind', url: 'sound_url', path: 'sound_path', name: 'sound_name' }
}

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser'])
    const slot = slotOf(req)
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new AuthError(400, 'No file was uploaded.')
    if (file.size === 0) throw new AuthError(400, 'That file is empty.')
    if (file.size > MAX_BYTES) throw new AuthError(400, `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 2 MB.`)
    // Some browsers send an empty or generic type for audio files — fall back
    // to the extension rather than rejecting a perfectly good MP3.
    const byName = /\.(mp3|wav|ogg|webm|m4a|aac)$/i.exec(file.name)?.[1]?.toLowerCase()
    const ext = EXT_BY_TYPE[file.type] ?? byName
    if (!ext) throw new AuthError(400, `"${file.name}" isn't a supported audio file. Use MP3, WAV, OGG or M4A.`)
    const contentType = EXT_BY_TYPE[file.type] ? file.type
      : ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac' } as Record<string, string>)[ext]

    const db = admin()
    const { data: prev, error: readErr } = await db.from('wfm_alarm_settings').select(slot.path).eq('id', 'global').maybeSingle()
    // Checked before uploading anything, so a missing column can't orphan a file.
    if (readErr) throw new AuthError(500, missingSetup(`Could not read the alarm settings: ${readErr.message}`))
    const prevPath = (prev as Record<string, string | null> | null)?.[slot.path] ?? null

    // A fresh name every upload, so no browser or CDN can keep serving the
    // previous sound from cache.
    const path = `${slot.prefix}-${Date.now()}.${ext}`
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, await file.arrayBuffer(), {
      contentType, cacheControl: '31536000', upsert: false,
    })
    if (upErr) throw new AuthError(500, missingSetup(`Upload failed: ${upErr.message}`))

    const url = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    const { error } = await db.from('wfm_alarm_settings').upsert({
      id: 'global', [slot.kind]: 'upload', [slot.url]: url, [slot.path]: path, [slot.name]: file.name,
      updated_at: new Date().toISOString(), updated_by: me.username,
    })
    if (error) {
      await db.storage.from(BUCKET).remove([path]).catch(() => {})   // don't orphan the file
      throw new AuthError(500, missingSetup(`Could not save: ${error.message}`))
    }

    // Only now that the new one is live, drop the old file.
    if (prevPath && prevPath !== path) {
      await db.storage.from(BUCKET).remove([prevPath]).catch(() => {})
    }
    return json({ ok: true, url, name: file.name })
  } catch (e) { return errorResponse(e) }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireRole(req, ['superuser'])
    const slot = slotOf(req)
    const db = admin()
    const { data: prev, error: readErr } = await db.from('wfm_alarm_settings').select(slot.path).eq('id', 'global').maybeSingle()
    if (readErr) throw new AuthError(500, missingSetup(`Could not read the alarm settings: ${readErr.message}`))
    const prevPath = (prev as Record<string, string | null> | null)?.[slot.path] ?? null
    // Back to a built-in sound (for warnings: their own built-in, not "same").
    const { error } = await db.from('wfm_alarm_settings').upsert({
      id: 'global', [slot.kind]: 'builtin', [slot.url]: null, [slot.path]: null, [slot.name]: null,
      updated_at: new Date().toISOString(), updated_by: me.username,
    })
    if (error) throw new AuthError(500, missingSetup(`Could not save: ${error.message}`))
    if (prevPath) await db.storage.from(BUCKET).remove([prevPath]).catch(() => {})
    return json({ ok: true })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
