// lib/zohoAuth.ts
// Server-side only — mints Zoho access tokens from the single stored refresh
// token (wfm_cliq_oauth, saved by app/api/zoho/callback). Shared by every
// Zoho product this app talks to (Cliq messaging, Creator records, etc.) —
// they're all scopes on the SAME self-client, so there's only ever one
// refresh token to manage, not one per product. Never import this from a
// 'use client' component; it reads server-only env vars.

import { getSupabaseAdmin } from './supabaseAdmin'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

// Module-level cache — persists for the life of this single request AND,
// opportunistically, across requests on a warm serverless instance (not
// guaranteed, but harmless to rely on as a "nice to have": worst case is one
// extra token mint on a cold start, not a correctness issue).
let _accessToken: string | null = null
let _accessTokenExpiresAt = 0

async function getStoredRefreshToken(): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from('wfm_cliq_oauth')
    .select('refresh_token')
    .eq('id', 'global')
    .maybeSingle()
  if (error || !data?.refresh_token) {
    throw new Error('No Zoho refresh token stored yet — visit /api/zoho/authorize once to authorize.')
  }
  return data.refresh_token as string
}

export async function getZohoAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _accessTokenExpiresAt - 60000) return _accessToken

  const clientId     = process.env.ZOHO_CLIQ_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIQ_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('ZOHO_CLIQ_CLIENT_ID/CLIENT_SECRET not set in this deployment\'s env vars.')
  }
  const refreshToken = await getStoredRefreshToken()

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
