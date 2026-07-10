// app/api/version/route.ts
// Tells connected clients which commit is CURRENTLY deployed, read fresh on
// every request (connection() forces this — see next.config.ts's comment).
// Dashboard.tsx polls this and compares it to the SHA baked into its own
// bundle at build time; a mismatch means a newer deployment has gone out
// since this tab loaded, so it reloads itself automatically.

import { connection } from 'next/server'

export async function GET() {
  await connection()
  return Response.json({ sha: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' })
}
