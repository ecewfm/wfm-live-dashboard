// lib/cliqScan.ts
// Orchestrates one Zoho Cliq breach scan across every account — the Vercel
// Cron job (app/api/cliq/scan/route.ts) and the manual "Force Scan Now"
// button (app/api/cliq/force-scan/route.ts) both call runCliqScan(), just
// with a different forceSend flag. Reuses the SAME breach algorithm the live
// Dashboard/Overview pages use (lib/breaches.ts) against the SAME wfm_settings
// config the Settings modal edits — there is only one implementation of
// "what counts as a breach", never a second copy to drift out of sync.
//
// Migrated from an older Google Apps Script tool's CliqNotifier.gs (per-
// account cooldown, staleness suppression, [TEST]-prefixed messages) — same
// behavior, just running as a Vercel Cron job instead of an Apps Script
// time trigger.

import { supabase } from './supabase'
import { buildBreaches, mostRecentUpdatedAt } from './breaches'
import { isDataStale } from './utils'
import { sendCliqChannelMessage } from './zohoCliq'
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
    lines.push('⚠️ This is a TEST message. Disable Test Mode in Settings > Cliq Alerts when ready.')
  }
  return lines.join('\n')
}

interface AccountSettingsRow {
  id: string
  data_source: DataSourceConfig | null
  kpi_thresholds: Thresholds | null
  status_thresholds: StatusThresholds | null
  cliq_channel: string | null
  cliq_last_sent_at: string | null
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
    enabled: !!globalRow?.enabled,
    testMode: (globalRow as any)?.test_mode !== false,
    frequencyMinutes: (globalRow as any)?.frequency_minutes || 5,
  }

  if (!globalSettings.enabled) {
    l('Cliq notifications disabled globally — nothing to do.')
    return { accountsScanned: 0, sent: 0, skipped: 0, log }
  }

  const { data: accounts, error: accountsErr } = await supabase
    .from('wfm_settings')
    .select('id, data_source, kpi_thresholds, status_thresholds, cliq_channel, cliq_last_sent_at')

  if (accountsErr) {
    l(`Failed to load accounts: ${accountsErr.message}`)
    return { accountsScanned: 0, sent: 0, skipped: 0, log }
  }

  const qualifying = ((accounts as any[]) ?? []).filter(
    (a): a is AccountSettingsRow => !!a.cliq_channel && !!a.data_source
  )
  l(`${(accounts ?? []).length} account(s) total, ${qualifying.length} with a Cliq channel configured.`)

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

  if (!forceSend) {
    const lastSent = acc.cliq_last_sent_at ? new Date(acc.cliq_last_sent_at).getTime() : 0
    const cooldownMs = globalSettings.frequencyMinutes * 60 * 1000
    if (Date.now() - lastSent < cooldownMs) {
      l(`${accountId}: within cooldown (${globalSettings.frequencyMinutes}m) — skipping.`)
      return false
    }
  }

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

  const message = formatMessage(accountId, breaches, globalSettings.testMode)
  await sendCliqChannelMessage(acc.cliq_channel as string, message)
  l(`${accountId}: sent to #${acc.cliq_channel}.`)

  // Cooldown only advances on a CONFIRMED send — a failed Cliq API call
  // (thrown above) must not silently eat the cooldown window.
  await supabase.from('wfm_settings').upsert({
    id: accountId, account_id: accountId, cliq_last_sent_at: new Date().toISOString(),
  })

  return true
}
