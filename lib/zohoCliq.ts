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

export async function sendCliqChannelMessage(channel: string, message: string): Promise<void> {
  const token = await getZohoAccessToken()
  const res = await fetch(CLIQ_MESSAGE_URL(channel), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })

  // Zoho returns 204 No Content on success — guard against an empty body.
  const text = await res.text()
  const body: any = text.trim() ? JSON.parse(text) : { success: true, status: res.status }
  const isApiError = !res.ok || body.error || body.status === 'failure' ||
    (body.code && String(body.code).toLowerCase() !== 'null' && String(body.code) !== '')
  if (isApiError) throw new Error(`Cliq send failed: ${JSON.stringify(body)}`)
}
