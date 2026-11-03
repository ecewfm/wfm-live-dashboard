// lib/zohoCliq.ts
// Server-side only — talks to the Zoho Cliq message API. Never import this
// from a 'use client' component; token minting (lib/zohoAuth.ts) reads a
// server-only env var (ZOHO_CLIQ_CLIENT_SECRET) that must never reach the
// browser bundle.
//
// The one-time authorization handshake (app/api/zoho/authorize + callback)
// is what produces the refresh token in the first place — the callback route
// saves it straight into Supabase (wfm_cliq_oauth, via lib/supabaseAdmin.ts),
// so there's no manual copy-paste step, same as the GAS predecessor's OAuth2
// library silently persisting it into PropertiesService.

import { getZohoAccessToken } from './zohoAuth'

const CLIQ_MESSAGE_URL = (channel: string) =>
  `https://cliq.zoho.com/api/v2/channelsbyname/${encodeURIComponent(channel)}/message`
const CLIQ_FILES_URL = (channel: string) =>
  `https://cliq.zoho.com/api/v2/channelsbyname/${encodeURIComponent(channel)}/files`

// Zoho returns 204 No Content on success — guard against an empty body.
async function checkCliqResponse(res: Response, what: string): Promise<void> {
  const text = await res.text()
  let body: any
  try { body = text.trim() ? JSON.parse(text) : { success: true, status: res.status } }
  catch { body = { status: res.status, body: text.slice(0, 300) } }
  const isApiError = !res.ok || body.error || body.status === 'failure' ||
    (body.code && String(body.code).toLowerCase() !== 'null' && String(body.code) !== '')
  if (isApiError) throw new Error(`${what} failed: ${JSON.stringify(body)}`)
}

export async function sendCliqChannelMessage(channel: string, message: string): Promise<void> {
  const token = await getZohoAccessToken()
  const res = await fetch(CLIQ_MESSAGE_URL(channel), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })
  await checkCliqResponse(res, 'Cliq send')
}

// Posts one file to the channel as its own message (Cliq's "Share files to a
// channel", scope ZohoCliq.Webhooks.CREATE — already granted for messages).
// Used for the card picture lib/cliqCardImage.tsx draws: the bytes go straight
// from memory into the upload, nothing is written anywhere on our side.
// Zoho's docs name the form field `files` in the parameter list but `file` in
// their own request example, so `file` is tried first and a 400 retries once
// with `files`. Cliq allows 20 uploads a minute per user.
export async function sendCliqChannelFile(channel: string, data: Uint8Array, fileName: string, contentType: string): Promise<void> {
  const token = await getZohoAccessToken()
  const upload = (field: string) => {
    const form = new FormData()
    form.append(field, new Blob([data as BlobPart], { type: contentType }), fileName)
    return fetch(CLIQ_FILES_URL(channel), { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form })
  }
  let res = await upload('file')
  if (res.status === 400) res = await upload('files')
  await checkCliqResponse(res, 'Cliq file upload')
}
