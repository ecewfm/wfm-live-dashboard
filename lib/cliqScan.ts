// lib/cliqScan.ts
// Orchestrates one breach scan across every account — the Vercel Cron job
// (app/api/cliq/scan/route.ts) and the manual "Force Scan Now" button
// (app/api/cliq/force-scan/route.ts) both call runCliqScan(), just with a
// different forceSend flag. Reuses the SAME breach algorithm the live
// Dashboard/Overview pages use (lib/breaches.ts) against the SAME wfm_settings
// config the Settings modal edits — there is only one implementation of
// "what counts as a breach", never a second copy to drift out of sync.
//
// Two independent per-account outputs can fire off the same detected
// breaches: a Zoho Cliq channel message (gated by the global Cliq
// enable toggle + a per-account channel), and a Zoho Creator "Workforce
// Logs" record (gated ONLY by a per-account toggle — no separate global
// switch was asked for). An account can have either, both, or neither.
//
// Migrated from an older Google Apps Script tool's CliqNotifier.gs (per-
// account cooldown, staleness suppression, [TEST]-prefixed messages) — same
// behavior, just running as a Vercel Cron job instead of an Apps Script
// time trigger.

import { supabase } from './supabase'
import { buildBreaches, mostRecentUpdatedAt, type BreachRow } from './breaches'
import { isDataStale } from './utils'
import { sendCliqChannelMessage } from './zohoCliq'
import { createWorkforceLogRecord } from './zohoCreator'
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
// UNIONED (additive, not either/or), each normalized to the same
// _name/_status/_duration/_durationSecs/_agentGroup shape. ───────────────────
async function fetchAgentSource(src: AgentSource, accountId: string): Promise<any[]> {
  if (!src.table) return []
  const accountCol = src.accountCol || 'account_id'
  const { data, error } = await supabase.from(src.table as any).select('*').eq(accountCol, accountId)
  if (error || !data) return []
  return (data as any[]).map(r => ({
    ...r,
    _agentGroup:   src.groupByCol ? String(r[src.groupByCol] ?? '') : src.label,
    _name:         String(r[src.nameCol] ?? ''),
    _status:       String(r[src.statusCol] ?? ''),
    _duration:     String(r[src.durationCol] ?? ''),
    _durationSecs: src.durationSecsCol ? String(r[src.durationSecsCol] ?? '') : '',
  }))
}

async function fetchAccountData(ds: DataSourceConfig, accountId: string): Promise<AccountData> {
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
    })
  }
  if (ds.agentSources) agentSourcesToFetch.push(...ds.agentSources)
  const agentLists = await Promise.all(agentSourcesToFetch.map(src => fetchAgentSource(src, accountId)))

  return { kpi: null, kpiRows, agents: agentLists.flat(), status: null, calls: [] }
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

  const { data: accounts, error: accountsErr } = await supabase
    .from('wfm_settings')
    .select(`
      id, data_source, kpi_thresholds, status_thresholds, cliq_channel, cliq_last_sent_at,
      wf_logs_enabled, wf_logs_last_sent_at,
      zoho_account_name, zoho_account_id,
      zoho_category_text, zoho_category_id,
      zoho_subcategory_text, zoho_subcategory_id,
      zoho_site_text, zoho_site_id
    `)

  if (accountsErr) {
    l(`Failed to load accounts: ${accountsErr.message}`)
    return { accountsScanned: 0, sent: 0, skipped: 0, log }
  }

  const qualifying = ((accounts as any[]) ?? []).filter((a): a is AccountSettingsRow => {
    if (!a.data_source) return false
    const wantsCliq   = globalSettings.enabled && !!a.cliq_channel
    const wantsWfLogs = !!a.wf_logs_enabled && !!(a.zoho_account_id || a.zoho_account_name)
    return wantsCliq || wantsWfLogs
  })
  l(`${(accounts ?? []).length} account(s) total, ${qualifying.length} qualifying (Cliq and/or Workforce Logs).`)

  for (const acc of qualifying) {
    try {
      const didSend = await processAccount(acc, globalSettings, forceSend, l)
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
  l: (msg: string) => void
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
  if (breaches.length === 0) return false

  let didAnything = false
  const updates: Record<string, any> = {}

  // ── Zoho Cliq channel alert ──────────────────────────────────────────────
  if (globalSettings.enabled && acc.cliq_channel) {
    const lastSent = acc.cliq_last_sent_at ? new Date(acc.cliq_last_sent_at).getTime() : 0
    if (forceSend || Date.now() - lastSent >= cooldownMs) {
      try {
        const message = formatMessage(accountId, breaches, globalSettings.testMode)
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
