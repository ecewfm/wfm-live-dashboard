// app/api/zoho/test-rta-log/route.ts
// Manual "Test Workforce RTA Logs" trigger — called from Settings > Zoho
// Integrations. Submits a real, clearly-tagged test record (no Zoho sandbox
// exists for this intake) so the user can confirm in Zoho itself that the
// payload format is accepted. No secret check: matches this app's existing
// security posture (see the other force-*/zoho routes in this same directory).
//
// Two modes, mirroring lib/cliqScan.ts's real scan exactly:
//   - AI Categorization OFF (default): one generic "[TEST] Manual
//     connectivity test" submission using the fixed category/sub-category.
//   - AI Categorization ON: computes this account's REAL current breaches
//     (same lib/breaches.ts buildBreaches() + lib/cliqScan.ts's
//     fetchAccountData() the live scan uses), runs them through
//     lib/geminiClassifier.ts, and submits ONE test per validated group —
//     per the user (2026-09-28), the same "many different Workforce RTA
//     Logs if there's more than one categorization" behavior the real scan
//     already has, so the Test button actually exercises AI-grouped
//     accounts the way they'll really behave, not the old single fixed
//     submission.

import { testAccountBreachRtaLog } from '@/lib/zohoWebappRequest'
import { getZohoAuthorizedAccountInfo } from '@/lib/zohoAuth'
import { classifyBreachesForRtaLog } from '@/lib/geminiClassifier'
import { loadZohoFieldOptions } from '@/lib/settings'
import { fetchAccountData } from '@/lib/cliqScan'
import { buildBreaches } from '@/lib/breaches'
import type { DataSourceConfig, Thresholds } from '@/lib/types'
import type { StatusThresholds } from '@/lib/utils'

export async function POST(req: Request) {
  let accountId: string | undefined
  let sites: string[] = []
  let zohoAccountName: string | undefined
  let aiEnabled = false
  let ds: DataSourceConfig | undefined
  let kpiThresholds: Thresholds | undefined
  let statusThresholds: StatusThresholds | undefined
  try {
    const body = await req.json()
    accountId = body?.accountId
    sites = Array.isArray(body?.sites) ? body.sites.filter(Boolean) : []
    zohoAccountName = body?.zohoAccountName || undefined
    aiEnabled = !!body?.aiEnabled
    ds = body?.ds
    kpiThresholds = body?.kpiThresholds
    statusThresholds = body?.statusThresholds
  } catch {
    // no body — accountId stays undefined, caught below
  }

  if (!accountId) {
    return Response.json({ error: 'accountId is required' }, { status: 400 })
  }

  // Identifies which Zoho account the stored token belongs to, so a
  // permission error (code 2899) can be diagnosed without guessing from
  // browser screenshots. Soft-fails to null (e.g. token minted before
  // AaaServer.profile.READ was added to the scope list).
  const authorizedAsPromise = getZohoAuthorizedAccountInfo().catch(() => null)

  if (!aiEnabled) {
    const result = await testAccountBreachRtaLog(zohoAccountName || accountId, sites).catch((e: any) => ({ __threw: true, message: e.message }))
    const authorizedAs = await authorizedAsPromise
    if (result && (result as any).__threw) {
      console.error('[zoho/test-rta-log] failed:', (result as any).message)
      return Response.json({ error: (result as any).message, authorizedAs }, { status: 500 })
    }
    return Response.json({ aiMode: false, ...result, authorizedAs })
  }

  // ── AI Categorization mode ──────────────────────────────────────────────
  try {
    if (!ds) throw new Error('Missing data source config — cannot compute live breaches for an AI-mode test')

    const accountData = await fetchAccountData(ds, accountId)
    const breaches = buildBreaches(accountId, accountData, {}, kpiThresholds || ({} as Thresholds), statusThresholds || ({} as StatusThresholds), ds)
    if (breaches.length === 0) {
      throw new Error('No active breaches right now for this account — AI Categorization needs at least one to classify. Try again once something is breaching, or test with AI Categorization off.')
    }

    const [categories, subCategories] = await Promise.all([
      loadZohoFieldOptions('Category'),
      loadZohoFieldOptions('Sub_Categories'),
    ])
    const groups = await classifyBreachesForRtaLog(accountId, breaches, categories, subCategories)

    const submissions = []
    for (const g of groups) {
      const result = await testAccountBreachRtaLog(zohoAccountName || accountId, sites, g.category, g.subCategory, g.remarks)
      submissions.push({ category: g.category, subCategory: g.subCategory, ...result })
    }

    const authorizedAs = await authorizedAsPromise
    return Response.json({ aiMode: true, submissions, authorizedAs })
  } catch (e: any) {
    console.error('[zoho/test-rta-log] AI mode failed:', e)
    const authorizedAs = await authorizedAsPromise
    return Response.json({ error: e.message, authorizedAs }, { status: 500 })
  }
}
