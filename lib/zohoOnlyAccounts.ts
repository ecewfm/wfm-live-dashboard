// lib/zohoOnlyAccounts.ts
// SERVER ONLY. Settings → Accounts → "Add accounts from Zoho" (per the user,
// 2026-11-09): list every account on Zoho's schedule / in its Time Tracker logs
// today, show which ones WFM Live already has, and add the chosen ones as
// accounts run from Zoho alone — their KPI card from wfm_zoho_kpis and their
// Agent Status from Zoho Breaks & Aux (lib/zohoWorkforce.ts says how).
//
// Reads Zoho through the same caches and pulls as everything else (a date is
// pulled only when its cached copy is old, under the same lease), so scanning
// costs at most one pull of today's schedules and time logs.
//
// A new account is left out of the global breach alarm (wfm_alarm_settings.
// muted_accounts): dozens of accounts whose Attendance and Adherence move every
// minute would otherwise ring it all day. Settings → Alarm turns it on per
// account. Adding refuses until sql/zoho_only_accounts.sql has been run, so an
// account is never added without its tile table or without that switch.

import { getSupabaseAdmin } from './supabaseAdmin'
import { getZohoAccessToken } from './zohoAuth'
import {
  supabaseAuxStore, refreshZohoLogDates, ZOHO_AUX_PULL_MINUTES, PRIMARY_TZ, type FetchLike,
} from './zohoAux'
import { supabaseHourlyStore, refreshZohoSchedules, HourlyTableMissing, HOURLY_SQL_HINT } from './hourlyReportServer'
import { dateInTz, addDays, zohoAccountNamesOf, accountKeysFor, normalizeAccount, zohoTypesSeen } from './zohoAuxShared'
import {
  buildAccountScan, zohoOnlyDataSource, zohoOnlyStatusThresholds, zohoOnlyDashboardLayout, accountIdFor, ZOHO_KPI_TABLE,
  type ZohoAccountScanRow,
} from './zohoWorkforce'
import { DEFAULT_THRESHOLDS } from './utils'

export const ZOHO_ONLY_SQL_HINT = 'Run sql/zoho_only_accounts.sql once in Supabase (SQL Editor) first.'

export interface ZohoAccountScan {
  date: string                 // today, on Zoho's clock
  rows: ZohoAccountScanRow[]
  log: string[]
  /** sql/zoho_only_accounts.sql has been run — adding needs both. */
  ready: { kpiTable: boolean; alarmColumn: boolean }
}

/** Every WFM Live account (removed ones too) with the Zoho names it goes by, normalized. */
async function wfmAccounts(): Promise<{ id: string; displayName: string; active: boolean; keys: string[] }[]> {
  const db = getSupabaseAdmin()
  const [acc, set] = await Promise.all([
    db.from('wfm_accounts').select('id, display_name, active'),
    db.from('wfm_settings').select('id, data_source, rta_account_name'),
  ])
  if (acc.error) throw new Error(`reading the accounts: ${acc.error.message}`)
  if (set.error) throw new Error(`reading the account settings: ${set.error.message}`)
  const settings = new Map((set.data ?? []).map((r: any) => [r.id as string, r]))
  return (acc.data ?? []).map((a: any) => {
    const s: any = settings.get(a.id)
    const names = zohoAccountNamesOf(s?.data_source, s?.rta_account_name)
    return { id: a.id, displayName: a.display_name || a.id, active: a.active !== false, keys: accountKeysFor(a.id, a.display_name || a.id, names) }
  })
}

async function readiness(): Promise<ZohoAccountScan['ready']> {
  const db = getSupabaseAdmin()
  const [k, m] = await Promise.all([
    db.from(ZOHO_KPI_TABLE).select('id').limit(1),
    db.from('wfm_alarm_settings').select('muted_accounts').limit(1),
  ])
  return { kpiTable: !k.error, alarmColumn: !m.error }
}

export async function scanZohoAccounts(deps: { fetch?: FetchLike; now?: () => number } = {}): Promise<ZohoAccountScan> {
  const now = (deps.now ?? Date.now)()
  const f = deps.fetch ?? (fetch as any as FetchLike)
  const today = dateInTz(now, PRIMARY_TZ)
  const log: string[] = []
  const l = (m: string) => log.push(m)
  // One Zoho sign-in for both pulls, and none when both copies are fresh.
  let tokenP: Promise<string> | null = null
  const getToken = () => (tokenP ??= getZohoAccessToken())
  const auxStore = supabaseAuxStore(), hourlyStore = supabaseHourlyStore()

  await refreshZohoLogDates([[today, ZOHO_AUX_PULL_MINUTES]], { now, log: l }, { store: auxStore, getToken, fetch: f })
  let schedules: Awaited<ReturnType<typeof hourlyStore.readSchedules>> = []
  try {
    await refreshZohoSchedules([today], { now, log: l }, { store: hourlyStore, getToken, fetch: f })
    schedules = await hourlyStore.readSchedules([today], null)
  } catch (e) {
    if (!(e instanceof HourlyTableMissing)) throw e
    l(`Zoho schedules: their table is missing — ${HOURLY_SQL_HINT}. Listing from the time logs only.`)
  }
  const [{ sessions, breaks }, accounts, ready] = await Promise.all([auxStore.readCache([today]), wfmAccounts(), readiness()])
  const rows = buildAccountScan({ schedules, sessions, breaks, accounts })
  l(`${rows.length} Zoho account(s) on today's schedule or in today's logs; ${rows.filter(r => r.onLive).length} already on WFM Live.`)
  return { date: today, rows, log, ready }
}

export interface ZohoAddResult {
  added: { id: string; displayName: string; zohoName: string }[]
  skipped: { zohoName: string; why: string }[]
}

/** Adds each named Zoho account (as Zoho spells it, from a scan) as an account run from Zoho alone. */
export async function addZohoOnlyAccounts(zohoNames: string[], deps: { now?: () => number } = {}): Promise<ZohoAddResult> {
  const now = (deps.now ?? Date.now)()
  const db = getSupabaseAdmin()
  const ready = await readiness()
  if (!ready.kpiTable || !ready.alarmColumn) throw new Error(`Not set up yet — ${ZOHO_ONLY_SQL_HINT}`)

  // What's on Zoho today, from the caches the scan just filled (no Zoho call here).
  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const auxStore = supabaseAuxStore(), hourlyStore = supabaseHourlyStore()
  const [schedules, todayLogs, twoDays, accounts, ids] = await Promise.all([
    hourlyStore.readSchedules([today], null).catch(e => { if (e instanceof HourlyTableMissing) return []; throw e }),
    auxStore.readCache([today]),
    auxStore.readCache([yesterday, today], 'breaks'),
    wfmAccounts(),
    db.from('wfm_settings').select('id'),
  ])
  if (ids.error) throw new Error(`reading the account settings: ${ids.error.message}`)
  const scan = new Map(buildAccountScan({ schedules, sessions: todayLogs.sessions, breaks: todayLogs.breaks, accounts }).map(r => [r.norm, r]))
  const taken = new Set([...accounts.map(a => a.id), ...(ids.data ?? []).map((r: any) => r.id as string)])
  const statusTh = zohoOnlyStatusThresholds(zohoTypesSeen(twoDays.breaks).map(t => t.type))

  const result: ZohoAddResult = { added: [], skipped: [] }
  const settingsRows: Record<string, unknown>[] = [], accountRows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const nowIso = new Date(now).toISOString()
  for (const name of zohoNames) {
    const norm = normalizeAccount(name)
    const row = scan.get(norm)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    if (!row) { result.skipped.push({ zohoName: name, why: 'not on today\'s Zoho schedule or in today\'s logs' }); continue }
    if (row.onLive) { result.skipped.push({ zohoName: row.zohoName, why: `already on WFM Live as "${row.onLive.displayName}"` }); continue }
    const id = accountIdFor(row.zohoName, taken)
    taken.add(id)
    settingsRows.push({
      id, account_id: id, kpi_thresholds: DEFAULT_THRESHOLDS, status_thresholds: statusTh,
      data_source: zohoOnlyDataSource(row.zohoName), dashboard_layout: zohoOnlyDashboardLayout(), updated_at: nowIso,
    })
    accountRows.push({ id, display_name: row.zohoName, active: true, sort_order: Math.floor(now / 1000) + accountRows.length, created_at: nowIso })
    result.added.push({ id, displayName: row.zohoName, zohoName: row.zohoName })
  }
  if (!result.added.length) return result

  // Settings first, then out of the alarm, then the accounts themselves — so a
  // dashboard never sees one of them before both are in place.
  const s = await db.from('wfm_settings').upsert(settingsRows)
  if (s.error) throw new Error(`saving the new accounts' settings: ${s.error.message}`)
  const alarm = await db.from('wfm_alarm_settings').select('muted_accounts').eq('id', 'global').maybeSingle()
  if (alarm.error) throw new Error(`reading the alarm settings: ${alarm.error.message}`)
  if (alarm.data) {
    const muted = Array.isArray((alarm.data as any).muted_accounts) ? (alarm.data as any).muted_accounts as string[] : []
    const u = await db.from('wfm_alarm_settings')
      .update({ muted_accounts: [...new Set([...muted, ...result.added.map(a => a.id)])] }).eq('id', 'global')
    if (u.error) throw new Error(`leaving the new accounts out of the alarm: ${u.error.message}`)
  }
  const a = await db.from('wfm_accounts').insert(accountRows)
  if (a.error) throw new Error(`adding the accounts: ${a.error.message}`)
  return result
}
