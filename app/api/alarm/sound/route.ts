// app/api/alarm/sound/route.ts
// Upload (POST) or remove (DELETE) the global alarm's custom sound file.
// Super users only. The file goes to the public `wfm-alarm-sounds` bucket
// (sql/global_alarm.sql) so every dashboard can play it from its URL.

import { requireRole, errorResponse, json, admin, AuthError } from '@/lib/authServer'

const BUCKET = 'wfm-alarm-sounds'
const MAX_BYTES = 2 * 1024 * 1024        // also enforced by the bucket itself
const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
}

const missingSetup = (msg: string) =>
  /bucket not found|does not exist|relation/i.test(msg)
    ? 'Alarm storage isn\'t set up yet — run sql/global_alarm.sql in Supabase first.'
    : msg

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser'])
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
    const { data: prev } = await db.from('wfm_alarm_settings').select('sound_path').eq('id', 'global').maybeSingle()

    // A fresh name every upload, so no browser or CDN can keep serving the
    // previous sound from cache.
    const path = `alarm-${Date.now()}.${ext}`
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, await file.arrayBuffer(), {
      contentType, cacheControl: '31536000', upsert: false,
    })
    if (upErr) throw new AuthError(500, missingSetup(`Upload failed: ${upErr.message}`))

    const url = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    const { error } = await db.from('wfm_alarm_settings').upsert({
      id: 'global', sound_kind: 'upload', sound_url: url, sound_path: path, sound_name: file.name,
      updated_at: new Date().toISOString(), updated_by: me.username,
    })
    if (error) {
      await db.storage.from(BUCKET).remove([path]).catch(() => {})   // don't orphan the file
      throw new AuthError(500, missingSetup(`Could not save: ${error.message}`))
    }

    // Only now that the new one is live, drop the old file.
    if (prev?.sound_path && prev.sound_path !== path) {
      await db.storage.from(BUCKET).remove([prev.sound_path]).catch(() => {})
    }
    return json({ ok: true, url, name: file.name })
  } catch (e) { return errorResponse(e) }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireRole(req, ['superuser'])
    const db = admin()
    const { data: prev } = await db.from('wfm_alarm_settings').select('sound_path').eq('id', 'global').maybeSingle()
    const { error } = await db.from('wfm_alarm_settings').upsert({
      id: 'global', sound_kind: 'builtin', sound_url: null, sound_path: null, sound_name: null,
      updated_at: new Date().toISOString(), updated_by: me.username,
    })
    if (error) throw new AuthError(500, missingSetup(`Could not save: ${error.message}`))
    if (prev?.sound_path) await db.storage.from(BUCKET).remove([prev.sound_path]).catch(() => {})
    return json({ ok: true })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
