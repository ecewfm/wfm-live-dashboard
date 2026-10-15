// lib/cliqScan.ts
// Orchestrates one breach scan across every account — the Vercel Cron job
// (app/api/cliq/scan/route.ts) and the manual "Force Scan Now" button
// (app/api/cliq/force-scan/route.ts) both call runCliqScan(), just with a
// different forceSend flag. Reuses the SAME breach algorithm the live
// Dashboard/Overview pages use (lib/breaches.ts) against the SAME wfm_settings
// config the Settings modal edits — there is only one implementation of
// "what counts as a breach", never a second copy to drift out of sync.
//
// Three independent per-account outputs can fire off the same detected
// breaches: a Zoho Cliq channel message (gated by the global Cliq
// enable toggle + a per-account channel), a Zoho Creator "Workforce
// Logs" record (gated ONLY by a per-account toggle — no separate global
// switch was asked for), and a "Workforce RTA Logs" webapp-request
// submission (lib/zohoWebappRequest.ts — a DIFFERENT Zoho intake/form from
// Workforce Logs, also gated only by its own per-account toggle). An
// account can have any combination of the three, or none.
//
// Migrated from an older Google Apps Script tool's CliqNotifier.gs (per-
// account cooldown, staleness suppression, [TEST]-prefixed messages) — same
// behavior, just running as a Vercel Cron job instead of an Apps Script
// time trigger.

import { supabase } from './supabase'
import { buildBreaches, mostRecentUpdatedAt, normalizeAgentRow, collectKpiGroupSourceQueries, collectRtaKpiSignals, type BreachRow, type RtaKpiSignal } from './breaches'
import { isDataStale } from './utils'
import { sendCliqChannelMessage } from './zohoCliq'
import { createWorkforceLogRecord } from './zohoCreator'
import { createAccountBreachRtaLog } from './zohoWebappRequest'
import { classifyBreachesForRtaLog } from './geminiClassifier'
import { loadZohoFieldOptions, type ZohoFieldOption } from './settings'
import { computeRtaLogsChangeSignal, computeRtaKpiSignalDue, isAgentStatusHeartbeatDue, EMPTY_RTA_LOGS_STATE, type RtaLogsState } from './rtaLogsChangeDetection'
import type { AccountData, AgentSource, DataSourceConfig, Thresholds } from './types'
import type { StatusThresholds } from './utils'

export interface ScanResult {
  accountsScanned: number
  sent: number
  skipped: number
  log: string[]
}

// ── Agent row fetch + normalization — mirrors Dashboard.tsx's fetchAgentSource
// exactly: legacy agentTable (if set) PLUS every agentSources[] entry are
// UNIONED (additive, not either/or), each normalized via the SAME
// normalizeAgentRow() Dashboard.tsx now also uses — see that function's
// comment in lib/breaches.ts for why this must never fork again. ───────────
async function fetchAgentSource(src: AgentSource, accountId: string): Promise<any[]> {
  if (!src.table) return []
  const accountCol = src.accountCol || 'account_id'
  const { data, error } = await supabase.from(src.table as any).select('*').eq(accountCol, accountId)
  if (error || !data) return []
  return (data as any[]).map(r => normalizeAgentRow(r, src))
}

// Exported so app/api/zoho/test-rta-log/route.ts can compute an account's
// CURRENT real breaches when testing with AI Categorization on — the test
// button needs actual breach data to classify against, unlike the plain
// non-AI test (a single generic "[TEST] Manual connectivity test" message).
export async function fetchAccountData(ds: DataSourceConfig, accountId: string): Promise<AccountData> {
  const kpiRows = ds.kpiTable
    ? ((await supabase.from(ds.kpiTable as any).select('*').eq(ds.kpiAccountCol || 'account_id', accountId)).data as any[] ?? [])
    : []

  const agentSourcesToFetch: AgentSource[] = []
  if (ds.agentTable) {
    agentSourcesToFetch.push({
      id: 'legacy', label: ds.agentTable, groupByCol: '',
      table: ds.agentTable, accountCol: ds.agentAccountCol,
      nameCol: ds.agentNameCol, statusCol: ds.agentStatusCol,
      durationCol: ds.agentDurationCol, durationSecsCol: ds.agentDurationSecs,
      extraCols: ds.agentExtraColsMap || {},
      extraDurationCols: ds.agentExtraDurationColsMap || {},
      extraMetricCols: ds.agentExtraMetricColsMap || {},
    })
  }
  if (ds.agentSources) agentSourcesToFetch.push(...ds.agentSources)
  const agentLists = await Promise.all(agentSourcesToFetch.map(src => fetchAgentSource(src, accountId)))

  // Per-group KPI sources — mirrors components/Dashboard.tsx's own fetch
  // exactly (same shared collectKpiGroupSourceQueries() so this can't drift
  // out of sync the way agent-row normalization once did, see
  // normalizeAgentRow's comment above) — any KpiGroup with its own `source`
  // reads from ITS OWN table instead of ds.kpiTable, so Cliq/Workforce Logs/
  // RTA Logs breach-check this scan runs sees exactly the same data the
  // live Dashboard/Overview pages show.
  const kpiGroupQueries = collectKpiGroupSourceQueries(ds)
  const kpiGroupResults = await Promise.all(
    kpiGroupQueries.map(q => supabase.from(q.table as any).select('*').eq(q.accountCol, accountId).then(r => (r.data as any[]) ?? []))
  )
  const kpiRowsByGroup: Record<string, any[]> = {}
  kpiGroupQueries.forEach((q, i) => { q.groupIds.forEach(gid => { kpiRowsByGroup[gid] = kpiGroupResults[i] }) })

  return { kpi: null, kpiRows, kpiRowsByGroup, agents: agentLists.flat(), status: null, calls: [] }
}

// ── Message formatting — mirrors the old GAS tool's format ──────────────────
function formatMessage(accountId: string, breaches: ReturnType<typeof buildBreaches>, testMode: boolean): string {
  const prefix = testMode ? '[TEST] ' : ''
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const lines = [
    `${prefix}🚨 WFM BREACH ALERT — ${accountId.toUpperCase()}`,
    `Account: ${accountId}`,
    `Time: ${ts}`,
    '',
    `Active Breaches (${breaches.length}):`,
  ]
  breaches.forEach((b, i) => {
    const icon = b.severity === 'critical' ? '🔴' : '🟡'
    lines.push(`${icon} ${i + 1}. ${b.entity} — ${b.metric}: ${b.value} (threshold ${b.threshold})`)
  })
  if (testMode) {
    lines.push('')
    lines.push('⚠️ This is a TEST message. Disable Test Mode in Settings > Zoho Integrations when ready.')
  }
  return lines.join('\n')
}

// ── Workforce Log "Remarks" formatting — plain text, no markdown/emoji since
// this lands in a Zoho Creator text field, not a chat message. ─────────────
function formatWorkforceLogRemarks(accountId: string, breaches: BreachRow[]): string {
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const parts = breaches.map(b => `${b.entity} - ${b.metric}: ${b.value} (threshold ${b.threshold})`)
  return `Automated WFM Live breach detection for ${accountId} at ${ts}. ${parts.join('; ')}`
}

// ── RTA Logs remarks — a SEPARATE formatter from the one above, used only by
// the "Workforce RTA Logs" webapp-request path below. Per the user
// (2026-10-14), a cycle with more than one KPI due to report (whether via
// 'breach_change' or 'heartbeat' mode, see GroupTile.rtaReportMode) must
// still produce exactly ONE submission describing all of them, never one
// submission per KPI — breachRows (actual breaches: breach_change-due KPI
// tiles + any due agent breaches) and heartbeatSignals (current-value
// readings, breaching or not) are merged into one timestamped message.
function formatRtaLogsRemarks(accountId: string, breachRows: BreachRow[], heartbeatSignals: RtaKpiSignal[]): string {
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const parts: string[] = []
  breachRows.forEach(b => parts.push(`${b.entity} - ${b.metric}: ${b.value} (threshold ${b.threshold})`))
  heartbeatSignals.forEach(s => parts.push(
    `${s.entity} - ${s.metric}: ${s.value}${s.severity ? ` [breaching, threshold ${s.threshold}]` : ' [current value]'}`
  ))
  return `Automated WFM Live RTA report for ${accountId} at ${ts}. ${parts.join('; ')}`
}

// ── Merge this cycle's RTA Logs bookkeeping into one next-state object ──────
// `kpiBreachChangeCleared` (healed tiles) is ALWAYS applied, independent of
// whether anything actually sent this cycle — it's pure bookkeeping, not a
// Zoho confirmation. `agent`/`kpiHeartbeatAdvance`/`kpiBreachChangeAdvance`
// are each passed in ONLY when their own corresponding send actually
// succeeded this cycle (same "advance only on confirmed send" discipline as
// every other cooldown/baseline in this file).
function mergeRtaState(base: RtaLogsState, patch: {
  agent?: Record<string, string[]>
  agentHeartbeatAdvance?: string
  kpiHeartbeatAdvance?: Record<string, string>
  kpiBreachChangeAdvance?: Record<string, string>
  kpiBreachChangeCleared: string[]
}): RtaLogsState {
  const kpiBreachChange = { ...(base.kpiBreachChange || {}) }
  patch.kpiBreachChangeCleared.forEach(k => delete kpiBreachChange[k])
  Object.assign(kpiBreachChange, patch.kpiBreachChangeAdvance || {})
  const kpiHeartbeat = { ...(base.kpiHeartbeat || {}), ...(patch.kpiHeartbeatAdvance || {}) }
  return {
    kpi: base.kpi || {}, agent: patch.agent || base.agent || {}, kpiHeartbeat, kpiBreachChange,
    agentHeartbeat: patch.agentHeartbeatAdvance || base.agentHeartbeat,
  }
}

interface AccountSettingsRow {
  id: string
  data_source: DataSourceConfig | null
  kpi_thresholds: Thresholds | null
  status_thresholds: StatusThresholds | null
  cliq_channel: string | null
  cliq_last_sent_at: string | null
  wf_logs_enabled: boolean | null
  zoho_account_name: string | null
  zoho_account_id: string | null
  zoho_category_text: string | null
  zoho_category_id: string | null
  zoho_subcategory_text: string | null
  zoho_subcategory_id: string | null
  zoho_site_text: string | null
  zoho_site_id: string | null
  wf_logs_last_sent_at: string | null
  rta_logs_enabled: boolean | null
  rta_logs_last_sent_at: string | null
  rta_sites: string | null
  rta_account_name: string | null
  rta_ai_categorization_enabled: boolean | null
  rta_logs_state: RtaLogsState | null
  rta_report_kpi: boolean | null
  rta_report_agent_status: boolean | null
}

export async function runCliqScan(opts: { forceSend?: boolean } = {}): Promise<ScanResult> {
  const forceSend = !!opts.forceSend
  const log: string[] = []
  const l = (msg: string) => log.push(msg)
  let sent = 0, skipped = 0

  const { data: globalRow } = await supabase
    .from('wfm_cliq_settings')
    .select('enabled, test_mode, frequency_minutes')
    .eq('id', 'global')
    .maybeSingle()

  const globalSettings = {
    // Cliq-specific global kill switch — Workforce Logs reporting has no
    // equivalent global toggle, only the per-account one, so it is NOT
    // gated on this flag below.
    enabled: !!globalRow?.enabled,
    testMode: (globalRow as any)?.test_mode !== false,
    frequencyMinutes: (globalRow as any)?.frequency_minutes || 5,
  }

  // A FULL select failing on ANY one unknown column would break Cliq +
  // Workforce Logs + RTA Logs for EVERY account at once (PostgREST rejects
  // the whole select) — CONFIRMED this exact failure mode already silently
  // broke Settings' own load/save for months (see lib/settings.ts's
  // SELECT_TIERS/UPSERT_TIERS, fixed 2026-09-28) before anyone noticed, so
  // these fallback tiers are cheap insurance against the newest columns not
  // being migrated yet breaking the ENTIRE scan instead of just their own
  // feature. Tried in order, isolating the newest/least-certain columns
  // first (rta_report_kpi/rta_report_agent_status, sql/rta_logs_breach_scope.sql,
  // then rta_logs_state, sql/rta_logs_change_detection.sql).
  const ACCOUNTS_SELECT = `
      id, data_source, kpi_thresholds, status_thresholds, cliq_channel, cliq_last_sent_at,
      wf_logs_enabled, wf_logs_last_sent_at,
      rta_logs_enabled, rta_logs_last_sent_at, rta_sites, rta_account_name,
      rta_ai_categorization_enabled, rta_logs_state,
      rta_report_kpi, rta_report_agent_status,
      zoho_account_name, zoho_account_id,
      zoho_category_text, zoho_category_id,
      zoho_subcategory_text, zoho_subcategory_id,
      zoho_site_text, zoho_site_id
  `
  const ACCOUNTS_SELECT_TIERS = [
    ACCOUNTS_SELECT,
    ACCOUNTS_SELECT.replace(/,?\s*rta_report_kpi,\s*rta_report_agent_status/, ''),
    ACCOUNTS_SELECT
      .replace(/,?\s*rta_report_kpi,\s*rta_report_agent_status/, '')
      .replace(/,?\s*rta_logs_state/, ''),
  ]
  let accounts: any[] | null = null
  let accountsErr: { message: string } | null = null
  for (const cols of ACCOUNTS_SELECT_TIERS) {
    const res = await supabase.from('wfm_settings').select(cols)
    if (!res.error) { accounts = res.data; accountsErr = null; break }
    accounts = res.data
    accountsErr = res.error
  }

  if (accountsErr) {
    l(`Failed to load accounts: ${accountsErr.message}`)
    return { accountsScanned: 0, sent: 0, skipped: 0, log }
  }

  const qualifying = ((accounts as any[]) ?? []).filter((a): a is AccountSettingsRow => {
    if (!a.data_source) return false
    const wantsCliq    = globalSettings.enabled && !!a.cliq_channel
    const wantsWfLogs  = !!a.wf_logs_enabled && !!(a.zoho_account_id || a.zoho_account_name)
    const wantsRtaLogs = !!a.rta_logs_enabled
    return wantsCliq || wantsWfLogs || wantsRtaLogs
  })
  l(`${(accounts ?? []).length} account(s) total, ${qualifying.length} qualifying (Cliq and/or Workforce Logs and/or RTA Logs).`)

  // Category/Sub-Category options for AI-based RTA Logs grouping
  // (lib/geminiClassifier.ts) — fetched ONCE per scan, not per account, and
  // only when at least one qualifying account actually opted in, since this
  // is a Supabase read every other account has no use for.
  const wantsAiCategorization = qualifying.some(a => !!a.rta_ai_categorization_enabled)
  const [categoryOptions, subCategoryOptions] = wantsAiCategorization
    ? await Promise.all([loadZohoFieldOptions('Category'), loadZohoFieldOptions('Sub_Categories')])
    : [[], []]

  for (const acc of qualifying) {
    try {
      const didSend = await processAccount(acc, globalSettings, forceSend, l, categoryOptions, subCategoryOptions)
      if (didSend) sent++; else skipped++
    } catch (e: any) {
      // Per-account try/catch — one account's failure must not skip everyone else.
      l(`${acc.id}: scan failed — ${e.message}`)
      skipped++
    }
  }

  l(`Done. ${sent} sent, ${skipped} skipped.`)
  return { accountsScanned: qualifying.length, sent, skipped, log }
}

async function processAccount(
  acc: AccountSettingsRow,
  globalSettings: { enabled: boolean; testMode: boolean; frequencyMinutes: number },
  forceSend: boolean,
  l: (msg: string) => void,
  categoryOptions: ZohoFieldOption[],
  subCategoryOptions: ZohoFieldOption[]
): Promise<boolean> {
  const accountId = acc.id
  const ds = acc.data_source as DataSourceConfig
  const kpiTh = (acc.kpi_thresholds || {}) as Thresholds
  const statusTh = (acc.status_thresholds || {}) as StatusThresholds
  const cooldownMs = globalSettings.frequencyMinutes * 60 * 1000

  const accountData = await fetchAccountData(ds, accountId)

  // Staleness suppression — mirrors the dashboard's own "DATA NOT IN SYNC"
  // overlay (5 min, lib/utils.ts's isDataStale). Applies even on a forced
  // scan: stale data can't reliably trigger an alert regardless of how the
  // scan was triggered.
  const freshest = mostRecentUpdatedAt(accountData.kpiRows, ds.kpiUpdatedAt)
  if (isDataStale(freshest)) {
    l(`${accountId}: DATA NOT IN SYNC (freshest=${freshest || 'none'}) — suppressing.`)
    return false
  }

  const breaches = buildBreaches(accountId, accountData, {}, kpiTh, statusTh, ds)
  l(`${accountId}: ${breaches.length} breach(es).`)

  let didAnything = false
  const updates: Record<string, any> = {}

  // ── "Workforce RTA Logs" webapp-request submission ──────────────────────
  // Runs BEFORE the "nothing else breaching → bail" check below, since a
  // 'heartbeat'-mode KPI tile (see GroupTile.rtaReportMode) reports on its
  // own 60-minute timer regardless of whether anything else in the account
  // is currently breaching — Cliq/Workforce Logs below have nothing to say
  // when nothing is breaching, but RTA Logs might still have a heartbeat due.
  //
  // A DIFFERENT Zoho intake from Workforce Logs below (lib/zohoWebappRequest.ts)
  // — no Zoho lookup ID needed (an optional plain-text name override
  // instead, see rta_account_name below), so this only needs its own toggle
  // to qualify (no hasAccountLink requirement).
  //
  // Deliberately NOT time-cooldown-gated like Cliq/Workforce Logs below —
  // per the user (2026-09-28), this reports whenever something actually
  // CHANGED (a KPI's value moved while still breaching, or a new agent
  // joined an already-breaching status/duration type) and stays quiet
  // otherwise, even indefinitely, rather than re-alerting on a timer for an
  // unchanged number — PLUS (2026-10-14) a per-tile 'heartbeat' mode that IS
  // a fixed timer, independent of breach status. See
  // lib/rtaLogsChangeDetection.ts for the exact rules.
  if (acc.rta_logs_enabled) {
    // Agent Status is a GROUP-level pair of independent flags (not per-
    // status, unlike KPIs) — rta_report_agent_status (existing DB column)
    // gates the "report when a NEW agent joins a breach type" behavior
    // unchanged; ds.rtaReportAgentStatusHeartbeat (new 2026-10-14) adds a
    // second, timer-based mode: every 60 minutes, if at least one agent is
    // currently breaching ANYWHERE, bulk-report the full current list
    // regardless of whether it changed. Both can be on at once.
    //
    // KPI Tile scope used to be a SAME-SHAPE account-wide on/off
    // (`rta_report_kpi`) — replaced 2026-10-14 by two PER-TILE, INDEPENDENT
    // checkboxes (RtaReportFlags.rtaReportHeartbeat/rtaReportBreachChange —
    // both can be on at once: a tile then reports at least every 60 minutes
    // AND additionally whenever it changes while breaching). `rta_report_kpi`
    // itself is left alone in the DB (harmless unused column) rather than
    // migrated away.
    const reportAgentStatusChange = !!acc.rta_report_agent_status
    const reportAgentStatusHeartbeat = !!ds.rtaReportAgentStatusHeartbeat
    const rtaBreaches = breaches.filter(b => b.kind === 'agent' && (reportAgentStatusChange || reportAgentStatusHeartbeat))
    const rtaKpiSignals = collectRtaKpiSignals(ds, accountData, kpiTh)

    const baseRtaState: RtaLogsState = acc.rta_logs_state || EMPTY_RTA_LOGS_STATE
    const kpiDue = computeRtaKpiSignalDue(rtaKpiSignals, baseRtaState, Date.now(), forceSend)
    const agentChange = computeRtaLogsChangeSignal(rtaBreaches, baseRtaState)
    const agentChangeDue = reportAgentStatusChange && (forceSend || agentChange.shouldSend)
    const agentHeartbeatDue = reportAgentStatusHeartbeat && rtaBreaches.length > 0
      && isAgentStatusHeartbeatDue(baseRtaState, Date.now(), forceSend)
    const agentDue = agentChangeDue || agentHeartbeatDue

    if (kpiDue.dueHealthy.length === 0 && kpiDue.dueBreaching.length === 0 && !agentDue) {
      l(`${accountId}: RTA Logs — nothing due this cycle (no per-KPI heartbeat/breach-change due` +
        `${(reportAgentStatusChange || reportAgentStatusHeartbeat) ? ', no new/heartbeat-due agent breach' : ', Agent Status reporting off'}) — skipping.`)
    } else {
      // Zoho's own processing script requires at least one site for an
      // "Account Wide" submission (confirmed live via its Function_Notes
      // validation feedback) — an account can span MORE THAN ONE site
      // (e.g. both Manila and Dumaguete), which the single-value Workforce
      // Logs Site lookup can't represent, so this is its own comma-separated
      // field (wfm_settings.rta_sites) rather than reusing that one.
      const sites = (acc.rta_sites || '').split(',').map(s => s.trim()).filter(Boolean)
      if (sites.length === 0) {
        l(`${accountId}: RTA Log webapp request skipped — no Site(s) configured (Zoho requires at least one for Account Wide submissions). Set it under Workforce RTA Logs in Settings.`)
      } else {
        // Zoho's own script resolves "accounts" against its HR/Accounts
        // master by NAME (confirmed live 2026-09-25: it rejected our raw
        // internal id "guardianbikes" — "No valid Account was resolved
        // from HR" — since Zoho's own record is named "Guardian Bikes")
        // — send the configured override when this account's id doesn't
        // match its real Zoho display name.
        const zohoAccountName = acc.rta_account_name || accountId

        // Due AND currently-breaching KPI tiles + any due agent breaches are
        // genuine breaches; due-but-healthy tiles (only possible via the
        // heartbeat flag) report a current value regardless of breach
        // status, so they're kept separate and never run through AI
        // categorization (there's no "breach type" to classify for a
        // healthy reading).
        const breachRowsForAi: BreachRow[] = [
          ...kpiDue.dueBreaching.map(s => ({
            entity: s.entity, metric: s.metric, value: s.value, threshold: s.threshold,
            severity: (s.severity || 'warning') as 'warning' | 'critical', kind: 'kpi' as const,
          })),
          ...(agentDue ? rtaBreaches : []),
        ]

        let agentAdvanced = false
        let agentHeartbeatAdvanced = false
        let kpiBreachChangeAdvance: Record<string, string> = {}
        let kpiHeartbeatAdvance: Record<string, string> = {}
        // Whenever we send anything this cycle (for ANY reason), each
        // enabled agent-status mode independently refreshes ITS OWN
        // baseline, same "advance on any confirmed send" discipline as the
        // KPI side — avoids e.g. a change-triggered send leaving the
        // heartbeat timer stale so it immediately re-fires a moment later.
        const wantsAgentChangeAdvance    = agentDue && reportAgentStatusChange
        const wantsAgentHeartbeatAdvance = agentDue && reportAgentStatusHeartbeat && rtaBreaches.length > 0

        if (acc.rta_ai_categorization_enabled) {
          // AI-based per-breach-type grouping (lib/geminiClassifier.ts) —
          // opt-in per account (2026-09-28). Deliberately NOT falling back
          // to the fixed category on failure (bad/exhausted keys, or no
          // pick matching a real Zoho category) — skip this cycle entirely
          // and retry next time, per the user's explicit choice, rather
          // than send a mismatched/generic category just to force something
          // through.
          if (breachRowsForAi.length > 0) {
            try {
              const groups = await classifyBreachesForRtaLog(accountId, breachRowsForAi, categoryOptions, subCategoryOptions)
              let anySent = false
              for (const g of groups) {
                try {
                  await createAccountBreachRtaLog(zohoAccountName, g.remarks, sites, g.category, g.subCategory)
                  l(`${accountId}: RTA Log webapp request submitted (AI-grouped: "${g.category} / ${g.subCategory}").`)
                  anySent = true
                } catch (e: any) {
                  l(`${accountId}: RTA Log webapp request failed for AI group "${g.category} / ${g.subCategory}" — ${e.message}`)
                }
              }
              if (anySent) {
                updates.rta_logs_last_sent_at = new Date().toISOString()
                agentAdvanced = wantsAgentChangeAdvance
                agentHeartbeatAdvanced = wantsAgentHeartbeatAdvance
                kpiBreachChangeAdvance = kpiDue.breachChangeAdvance
                didAnything = true
              }
            } catch (e: any) {
              l(`${accountId}: AI categorization failed, skipping RTA Logs this cycle (will retry next cycle) — ${e.message}`)
            }
          }
          // Due-but-healthy readings aren't breaches — always a separate
          // plain (fixed-category) submission, independent of AI mode/success.
          if (kpiDue.dueHealthy.length > 0) {
            try {
              const remarks = formatRtaLogsRemarks(accountId, [], kpiDue.dueHealthy)
              await createAccountBreachRtaLog(zohoAccountName, remarks, sites)
              l(`${accountId}: RTA Log webapp request submitted (heartbeat readings).`)
              updates.rta_logs_last_sent_at = new Date().toISOString()
              kpiHeartbeatAdvance = kpiDue.heartbeatAdvance
              didAnything = true
            } catch (e: any) {
              l(`${accountId}: RTA Log webapp request failed (heartbeat readings) — ${e.message}`)
            }
          }
        } else {
          // Plain path — ONE combined submission per cycle covering every
          // KPI tile due this cycle (whichever mode) plus any due agent
          // breaches, never one submission per KPI.
          try {
            const remarks = formatRtaLogsRemarks(accountId, breachRowsForAi, kpiDue.dueHealthy)
            await createAccountBreachRtaLog(zohoAccountName, remarks, sites)
            l(`${accountId}: RTA Log webapp request submitted.`)
            updates.rta_logs_last_sent_at = new Date().toISOString()
            agentAdvanced = wantsAgentChangeAdvance
            agentHeartbeatAdvanced = wantsAgentHeartbeatAdvance
            kpiBreachChangeAdvance = kpiDue.breachChangeAdvance
            kpiHeartbeatAdvance = kpiDue.heartbeatAdvance
            didAnything = true
          } catch (e: any) {
            l(`${accountId}: RTA Log webapp request failed — ${e.message}`)
          }
        }

        updates.rta_logs_state = mergeRtaState(baseRtaState, {
          agent: agentAdvanced ? agentChange.currentSnapshot.agent : undefined,
          agentHeartbeatAdvance: agentHeartbeatAdvanced ? new Date().toISOString() : undefined,
          kpiHeartbeatAdvance,
          kpiBreachChangeAdvance,
          kpiBreachChangeCleared: kpiDue.clearedBreachChangeKeys,
        })
      }
    }

    // Healed tiles' baselines still need clearing even when nothing sent
    // this cycle (e.g. only a now-healthy breach_change tile changed, with
    // no heartbeat/agent activity) — pure bookkeeping, not a Zoho call.
    if (!updates.rta_logs_state && kpiDue.clearedBreachChangeKeys.length > 0) {
      updates.rta_logs_state = mergeRtaState(baseRtaState, { kpiBreachChangeCleared: kpiDue.clearedBreachChangeKeys })
    }
  }

  if (breaches.length === 0) {
    // Nothing for Cliq/Workforce Logs to report — RTA Logs (if enabled) was
    // already handled above, independent of this check.
    if (Object.keys(updates).length > 0) {
      await supabase.from('wfm_settings').upsert({ id: accountId, account_id: accountId, ...updates })
    }
    return didAnything
  }

  // ── Zoho Cliq channel alert ──────────────────────────────────────────────
  if (globalSettings.enabled && acc.cliq_channel) {
    // Per the user (2026-10-15): not every breach should go to Cliq — each
    // status on the Status Durations tab has its own "Send to Cliq" toggle
    // (StatusThresholds.sendToCliq), and each KPI (Thresholds/GroupTile/
    // ExtraTile.sendToCliq, lib/types.ts) now has the SAME toggle on the KPI
    // Thresholds tab — both default OFF, opt-in, deliberately NOT preserving
    // old "send everything" behavior. The other two agent-breach kinds
    // (static-duration-threshold, text-trigger — neither has a `status`, see
    // BreachRow) are untouched by this filter; it's specifically for named-
    // status duration breaches and KPI breaches. This is Cliq-ONLY —
    // Workforce Logs/RTA Logs keep using the full/unfiltered `breaches` as
    // before.
    const cliqBreaches = breaches.filter(b =>
      b.kind === 'agent' ? (!b.status || statusTh[b.status]?.sendToCliq) : !!b.sendToCliq
    )
    if (cliqBreaches.length === 0) {
      l(`${accountId}: Cliq — no breach has "Send to Cliq" on — skipping.`)
    } else {
      const lastSent = acc.cliq_last_sent_at ? new Date(acc.cliq_last_sent_at).getTime() : 0
      if (forceSend || Date.now() - lastSent >= cooldownMs) {
        try {
          const message = formatMessage(accountId, cliqBreaches, globalSettings.testMode)
          await sendCliqChannelMessage(acc.cliq_channel, message)
          l(`${accountId}: sent to Cliq #${acc.cliq_channel}.`)
          // Cooldown only advances on a CONFIRMED send — a failed Cliq API call
          // (thrown above) must not silently eat the cooldown window.
          updates.cliq_last_sent_at = new Date().toISOString()
          didAnything = true
        } catch (e: any) {
          l(`${accountId}: Cliq send failed — ${e.message}`)
        }
      } else {
        l(`${accountId}: Cliq within cooldown (${globalSettings.frequencyMinutes}m) — skipping.`)
      }
    }
  }

  // ── Zoho Creator Workforce Logs record ───────────────────────────────────
  const hasAccountLink = !!(acc.zoho_account_id || acc.zoho_account_name)
  if (acc.wf_logs_enabled && hasAccountLink) {
    const lastSent = acc.wf_logs_last_sent_at ? new Date(acc.wf_logs_last_sent_at).getTime() : 0
    if (forceSend || Date.now() - lastSent >= cooldownMs) {
      try {
        const remarks = formatWorkforceLogRemarks(accountId, breaches)
        await createWorkforceLogRecord({
          account:     { id: acc.zoho_account_id     || '', text: acc.zoho_account_name    || '' },
          category:    { id: acc.zoho_category_id    || '', text: acc.zoho_category_text    || '' },
          subCategory: { id: acc.zoho_subcategory_id || '', text: acc.zoho_subcategory_text || '' },
          site:        { id: acc.zoho_site_id        || '', text: acc.zoho_site_text        || '' },
          remarks,
        })
        l(`${accountId}: Workforce Log record created (Zoho account "${acc.zoho_account_name || acc.zoho_account_id}").`)
        updates.wf_logs_last_sent_at = new Date().toISOString()
        didAnything = true
      } catch (e: any) {
        l(`${accountId}: Workforce Log record failed — ${e.message}`)
      }
    } else {
      l(`${accountId}: Workforce Logs within cooldown (${globalSettings.frequencyMinutes}m) — skipping.`)
    }
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from('wfm_settings').upsert({ id: accountId, account_id: accountId, ...updates })
  }

  return didAnything
}
