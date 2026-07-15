// app/api/zoho/callback/route.ts
// Zoho redirects here after the human completes (or denies) consent at
// /api/zoho/authorize. Exchanges the returned code for tokens, then saves the
// refresh token straight into Supabase (wfm_cliq_oauth, via
// lib/supabaseAdmin.ts's service-role client, which bypasses that table's
// RLS lockdown) — no copy-paste into an env var, no redeploy needed. Mirrors
// how the old GAS tool's OAuth2 library silently persisted the refresh token
// into PropertiesService; this is the same idea using Supabase as the store.
//
// This route doesn't need to be visited again after a successful run —
// lib/zohoCliq.ts reads the stored token and refreshes its own access tokens
// from it going forward.

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const STATE_COOKIE   = 'zoho_oauth_state'

function htmlResponse(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag':  'noindex',
    },
  })
}

export async function GET(request: Request) {
  const url          = new URL(request.url)
  const code         = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const zohoError    = url.searchParams.get('error')

  const cookieState = request.headers
    .get('cookie')
    ?.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${STATE_COOKIE}=`))
    ?.split('=')[1]

  if (zohoError) {
    return htmlResponse(`<p>Zoho denied authorization: ${zohoError}</p>`, 400)
  }
  if (!code) {
    return htmlResponse('<p>Missing ?code from Zoho — did you navigate here directly instead of via /api/zoho/authorize?</p>', 400)
  }
  if (!returnedState || !cookieState || returnedState !== cookieState) {
    return htmlResponse('<p>State mismatch — possible CSRF, or this link expired/was already used. Start over at /api/zoho/authorize.</p>', 400)
  }

  const clientId     = process.env.ZOHO_CLIQ_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIQ_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return htmlResponse('<p>ZOHO_CLIQ_CLIENT_ID / ZOHO_CLIQ_CLIENT_SECRET are not set in this deployment\'s environment variables.</p>', 500)
  }

  const redirectUri = `${url.origin}/api/zoho/callback`

  const tokenRes = await fetch(ZOHO_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code,
    }),
  })

  const tokenData = await tokenRes.json()

  if (!tokenRes.ok || !tokenData.refresh_token) {
    console.error('[zoho/callback] Token exchange failed:', tokenData)
    return htmlResponse(
      `<p>Token exchange failed — check this route's Vercel function logs for details.</p>
       <pre>${JSON.stringify({ error: tokenData.error || 'unknown' })}</pre>`,
      502
    )
  }

  try {
    const { error: saveError } = await getSupabaseAdmin()
      .from('wfm_cliq_oauth')
      .upsert({ id: 'global', refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() })
    if (saveError) throw new Error(saveError.message)
  } catch (e: any) {
    console.error('[zoho/callback] Got a refresh token but failed to save it:', e.message)
    return htmlResponse(
      `<p><strong>Authorized with Zoho, but failed to save the token.</strong></p>
       <p>${e.message}</p>
       <p>Common cause: <code>sql/cliq_oauth_token.sql</code> hasn't been run yet, or
          <code>SUPABASE_SERVICE_ROLE_KEY</code> isn't set in this deployment's env vars.
          Fix that and visit <a href="/api/zoho/authorize">/api/zoho/authorize</a> again
          — re-authorizing is safe to repeat.</p>`,
      500
    )
  }

  const res = htmlResponse(`
    <p><strong>Success! Authorization complete.</strong></p>
    <p>You're all set — nothing else to do. This route doesn't need to be visited again.</p>
  `)
  res.cookies.delete(STATE_COOKIE)
  return res
}
