// app/api/zoho/authorize/route.ts
// One-time Zoho Cliq OAuth kickoff — visit this route once (in a browser,
// signed into whichever Zoho/Cliq account should post the breach alerts) to
// mint a refresh token, then add it as ZOHO_CLIQ_REFRESH_TOKEN in this
// project's Vercel env vars. Not used on any recurring basis — the Cron job
// (app/api/cliq/scan, via lib/zohoCliq.ts) mints its own access tokens from
// that stored refresh token from then on.
//
// Requires these Vercel env vars (server-side only, NOT NEXT_PUBLIC_):
//   ZOHO_CLIQ_CLIENT_ID, ZOHO_CLIQ_CLIENT_SECRET
// Must match a "Server-based Applications" client in https://api-console.zoho.com
// with this route's own /api/zoho/callback URL registered as an authorized
// redirect URI.

import { NextResponse } from 'next/server'

const ZOHO_AUTH_URL = 'https://accounts.zoho.com/oauth/v2/auth'
const CLIQ_SCOPE     = 'ZohoCliq.Webhooks.CREATE,ZohoCliq.channels.read'
const STATE_COOKIE   = 'zoho_oauth_state'

export async function GET(request: Request) {
  const clientId = process.env.ZOHO_CLIQ_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { error: 'ZOHO_CLIQ_CLIENT_ID is not set in this deployment\'s environment variables.' },
      { status: 500 }
    )
  }

  const origin      = new URL(request.url).origin
  const redirectUri = `${origin}/api/zoho/callback`

  // CSRF/replay guard — verified against this same cookie in the callback.
  const state = crypto.randomUUID()

  const authUrl = new URL(ZOHO_AUTH_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('scope', CLIQ_SCOPE)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('access_type', 'offline')   // required to get a refresh_token back
  authUrl.searchParams.set('prompt', 'consent')          // forces the consent screen even if previously authorized
  authUrl.searchParams.set('state', state)

  const res = NextResponse.redirect(authUrl.toString())
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/api/zoho',
  })
  return res
}
