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
import { buildBreaches, collectRtaKpiSignals, type BreachRow } from '@/lib/breaches'
import { computeRtaKpiSignalDue } from '@/lib/rtaLogsChangeDetection'
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
  let reportAgentStatus = false
  try {
    const body = await req.json()
    accountId = body?.accountId
    sites = Array.isArray(body?.sites) ? body.sites.filter(Boolean) : []
    zohoAccountName = body?.zohoAccountName || undefined
    aiEnabled = !!body?.aiEnabled
    ds = body?.ds
    kpiThresholds = body?.kpiThresholds
    statusThresholds = body?.statusThresholds
    // Mirrors lib/cliqScan.ts's own scope — Agent Status is still a single
    // account-wide toggle; KPI Tile scope is now per-tile (GroupTile.
    // rtaReportMode, see collectRtaKpiSignals below) instead of one blanket
    // switch, so there's no equivalent single "reportKpi" flag anymore.
    reportAgentStatus = !!body?.reportAgentStatus
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
    const allBreaches = buildBreaches(accountId, accountData, {}, kpiThresholds || ({} as Thresholds), statusThresholds || ({} as StatusThresholds), ds)
    const agentBreaches = reportAgentStatus ? allBreaches.filter(b => b.kind === 'agent') : []
    // force=true (no stored state) mirrors exactly what a "Force Scan Now"
    // would currently classify — every breach_change-mode tile that's
    // CURRENTLY breaching, regardless of whether its value changed since
    // last time. Heartbeat-mode tiles aren't breaches, so they're excluded
    // here too, same as the real scan.
    const kpiSignals = collectRtaKpiSignals(ds, accountData, kpiThresholds || ({} as Thresholds))
    const kpiDue = computeRtaKpiSignalDue(kpiSignals, null, Date.now(), true)
    const kpiBreachRows: BreachRow[] = kpiDue.dueBreachChange.map(s => ({
      entity: s.entity, metric: s.metric, value: s.value, threshold: s.threshold,
      severity: (s.severity || 'warning') as 'warning' | 'critical', kind: 'kpi' as const,
    }))
    const breaches = [...kpiBreachRows, ...agentBreaches]
    if (breaches.length === 0) {
      throw new Error(`No active breaches right now within this account's reporting scope (no KPI tile currently breaching with an RTA Reporting mode set, Agent Status ${reportAgentStatus ? 'on' : 'off'}) — AI Categorization needs at least one to classify. Try again once something in scope is breaching, or test with AI Categorization off.`)
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
