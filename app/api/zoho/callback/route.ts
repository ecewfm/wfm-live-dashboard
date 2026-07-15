// app/api/zoho/callback/route.ts
// Zoho redirects here after the human completes (or denies) consent at
// /api/zoho/authorize. Exchanges the returned code for tokens, then shows the
// refresh token once on this page (Cache-Control: no-store, noindex — not
// cached or crawlable) so it can be copied straight into Vercel's env vars
// without hunting through Function Logs. Also still logged server-side as a
// fallback in case the page is closed before it's copied.
//
// After this runs once, add the refresh token to THIS project's Vercel env
// vars as ZOHO_CLIQ_REFRESH_TOKEN, then redeploy so the Cron job
// (app/api/cliq/scan) picks it up. This route doesn't need to be visited
// again after that — lib/zohoCliq.ts refreshes its own access tokens from
// the stored refresh token from then on.

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

  // Also logged server-side as a fallback (e.g. if this page gets closed
  // before the token is copied) — but the page itself is now the primary way
  // to grab it, see below.
  console.log('[zoho/callback] Authorization complete for refresh token ending in:', tokenData.refresh_token.slice(-6))

  const token = String(tokenData.refresh_token)
  const res = htmlResponse(`
    <p><strong>Authorization complete.</strong></p>
    <p>Add this as <code>ZOHO_CLIQ_REFRESH_TOKEN</code> in this project's Vercel
       Environment Variables, then redeploy so the Cron job picks it up. This
       page won't show it again — copy it now. This route doesn't need to be
       visited again after that.</p>
    <div style="display:flex; gap:8px; align-items:center; margin-top:12px;">
      <input id="tok" type="text" readonly value="${token}"
        style="flex:1; font-family:monospace; font-size:13px; padding:8px; border:1px solid #ccc; border-radius:4px;" />
      <button onclick="
        navigator.clipboard.writeText(document.getElementById('tok').value);
        this.textContent='Copied!';
        setTimeout(() => this.textContent='Copy', 1500);
      " style="padding:8px 14px; border-radius:4px; border:1px solid #888; cursor:pointer; background:#f0f0f0;">Copy</button>
    </div>
    <p style="margin-top:16px; color:#a00;">⚠️ Treat this like a password — don't screenshot or share this page.</p>
  `)
  res.cookies.delete(STATE_COOKIE)
  return res
}
