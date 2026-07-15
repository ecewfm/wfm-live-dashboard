// lib/zohoCliq.ts
// Server-side only — talks to Zoho's OAuth token endpoint and the Cliq
// message API directly. Never import this from a 'use client' component;
// it reads server-only env vars (ZOHO_CLIQ_CLIENT_SECRET, ZOHO_CLIQ_REFRESH_TOKEN)
// that must never reach the browser bundle.
//
// The one-time authorization handshake (app/api/zoho/authorize + callback)
// is what produces ZOHO_CLIQ_REFRESH_TOKEN in the first place — see those
// routes for that flow. Everything here just mints access tokens from that
// already-issued refresh token, same as the GAS predecessor's OAuth2 library
// did automatically.

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const CLIQ_MESSAGE_URL = (channel: string) =>
  `https://cliq.zoho.com/api/v2/channelsbyname/${encodeURIComponent(channel)}/message`

// Module-level cache — persists for the life of this single request AND,
// opportunistically, across requests on a warm serverless instance (not
// guaranteed, but harmless to rely on as a "nice to have": worst case is one
// extra token mint on a cold start, not a correctness issue).
let _accessToken: string | null = null
let _accessTokenExpiresAt = 0

export async function getZohoAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _accessTokenExpiresAt - 60000) return _accessToken

  const clientId     = process.env.ZOHO_CLIQ_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIQ_CLIENT_SECRET
  const refreshToken  = process.env.ZOHO_CLIQ_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('ZOHO_CLIQ_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN not fully configured in this deployment\'s env vars.')
  }

  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`)
  }

  _accessToken = data.access_token
  _accessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000
  return _accessToken as string
}

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
