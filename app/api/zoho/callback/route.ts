// app/api/zoho/callback/route.ts
// Zoho redirects here after the human completes (or denies) consent at
// /api/zoho/authorize. Exchanges the returned code for tokens, then logs the
// refresh token to THIS REQUEST's server-side function logs only (Vercel
// dashboard → Deployments → Functions → this route's invocation) — never
// rendered in the HTML response, so it's not sitting in the browser's
// response body even for the one person who completes this flow.
//
// After this runs once, copy the refresh token from the function log into
// the wfm-live-scraper process's .env as ZOHO_CLIQ_REFRESH_TOKEN. This route
// is never used again after that — the scraper refreshes its own access
// tokens directly against Zoho from then on.

import { NextResponse } from 'next/server'

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

  // Server-side log ONLY — never put this in the HTML response.
  console.log('[zoho/callback] Authorization complete. Refresh token (copy into the scraper\'s .env as ZOHO_CLIQ_REFRESH_TOKEN):', tokenData.refresh_token)

  const res = htmlResponse(`
    <p><strong>Authorization complete.</strong></p>
    <p>The refresh token was NOT shown here — it's in this request's server-side
       function log instead (Vercel dashboard → your project → Deployments →
       this deployment → Functions → find the <code>/api/zoho/callback</code>
       invocation for this request → view logs).</p>
    <p>Copy that refresh token into the <code>wfm-live-scraper</code> process's
       <code>.env</code> as <code>ZOHO_CLIQ_REFRESH_TOKEN</code>, then you're done —
       this route doesn't need to be visited again.</p>
  `)
  res.cookies.delete(STATE_COOKIE)
  return res
}
