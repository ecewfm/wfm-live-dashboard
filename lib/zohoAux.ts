// lib/zohoAux.ts
// SERVER ONLY. Pulls Zoho break/aux logs and time logs, caches them, and keeps
// each enabled account's "Zoho Breaks & Aux" agent section (wfm_zoho_agent_status)
// up to date — who is on a break/aux, and (from the time logs) who is logged in
// on none. The pure rules (fields, parsing, matching, "what are they doing right
// now") are in lib/zohoAuxShared.ts.
//
// Same shape as Workforce R.E.S.T. vCORE's pipeline (see that file's header):
//   - pulls are ORGANISATION-WIDE, one date per pull, never per account or per
//     page view — accounts are scoped afterwards, by each person's ACCOUNT in
//     Zoho (unlike vCORE, which goes by name — see lib/zohoAuxShared.ts);
//   - the parsed result is cached (wfm_zoho_activity) so yesterday's data — for
//     overnight shifts — is pulled every 30 min, not every few minutes;
//   - a failed pull keeps the last good copy, and an ok-but-empty pull never
//     wipes a populated date.
// Uses this app's own Zoho connection (lib/zohoAuth.ts — the same self-client and
// refresh token as Cliq/Workforce Logs; its ZohoCreator.report.READ scope covers
// these reports) and Creator's v2.1 API with record_cursor paging, the same call
// lib/zohoFieldScan.ts already makes.
//
// Runs from app/api/zoho/aux-sync (Vercel Cron, every minute — a pull only
// happens when today's copy is older than the pull interval, and nothing at all
// is pulled while no account has the feature on) and app/api/zoho/aux-sync-now
// (the "Pull Zoho now" button in Settings → Zoho Integrations).
//
// Each run also does the Zoho ↔ CRM check (Settings → Zoho ↔ CRM,
// lib/zohoCrmMatch.ts) for the accounts that have it on: everyone's current Zoho
// status is right here, so this is where who-is-out-of-sync is worked out and
// stored with when it started (wfm_zoho_crm_mismatch).
//
// And it runs the accounts with no CRM, worked out from Zoho alone
// (lib/zohoWorkforce.ts, per the user 2026-11-09): every account whose card
// reads wfm_zoho_kpis gets its Attendance / Absenteeism / Adherence tiles
// written there, and an account with "scheduled but not logged in" on gets
// those people in its Zoho Breaks & Aux section. Both need Zoho's Daily
// Schedules, so those are pulled here too while any account uses them (today
// every 30 min, yesterday every 6 h — lib/hourlyReportServer.ts's rules).

import { getZohoAccessToken } from './zohoAuth'
import { getSupabaseAdmin } from './supabaseAdmin'
import { OWNER_NAME } from './zohoCreator'
import type { DataSourceConfig } from './types'
import { agentSourcesFor, normalizeAgentRow, mostRecentUpdatedAt } from './breaches'
import {
  ZOHO_AUX_SOURCES, ZOHO_AUX_TABLE, zohoCriteriaDate, parseSessionRow, parseBreakRow,
  normalizeName, dateInTz, addDays, computeCurrentAux, buildAccountStatusRows, parseExtraNames,
  pickAccountField, accountKeysFor, zohoAccountNamesOf, zohoPeopleOnAccount, zohoAccountsSeen, zohoTypesSeen, includeLoggedInOf,
  includeNotLoggedInOf,
  type ZohoSession, type ZohoBreak, type ZohoAgentStatusRow, type CurrentAux,
} from './zohoAuxShared'
import {
  ZOHO_CRM_MISMATCH_TABLE, ZOHO_MATCH_MAX_ZOHO_AGE_MIN, zohoCrmMatchActive, findZohoCrmMismatches, nextMismatchRows,
  type ZohoCrmMismatchRow, type ZohoNow, type ZohoCrmMatchInfo,
} from './zohoCrmMatch'
import {
  ZOHO_KPI_TABLE, readsZohoKpis, accountShifts, scopedShifts, scheduledOffNow, computeAccountKpis, zohoKpiRows, byPerson, leavesOf,
  type ZohoKpiRow, type ZohoKpiValues,
} from './zohoWorkforce'
import type { ScheduleCacheRow } from './hourlyReport'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'
export const ZOHO_AUX_CACHE_TABLE = 'wfm_zoho_activity'
export const ZOHO_AUX_SYNC_TABLE  = 'wfm_zoho_sync'

// How often TODAY is re-pulled. Default 5 min, the same as vCORE: Zoho's API
// allowance is shared by the whole organisation, and a too-tight interval here
// would eat into what vCORE needs. 2–10 via ZOHO_AUX_PULL_MINUTES.
export const ZOHO_AUX_PULL_MINUTES = Math.min(10, Math.max(2, Number(process.env.ZOHO_AUX_PULL_MINUTES) || 5))
export const YESTERDAY_PULL_MINUTES = 30
export const PULL_LEASE_MS = 2 * 60 * 1000   // another run's pull counts as in progress for this long
const MAX_PAGES = 50
export const PRIMARY_TZ = 'America/New_York'

// ── Zoho ──────────────────────────────────────────────────────────────────────
export type Fetched = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; headers: { get(name: string): string | null } }>

/** Every row of one report for ONE date (all pages). Zoho's "no records" is an empty result, not an error. */
export function fetchReportForDate(
  token: string, app: string, report: string, dateField: string, dateISO: string, f: FetchLike = fetch as any,
): Promise<Fetched> {
  return fetchReport(token, app, report, `(${dateField} == "${zohoCriteriaDate(dateISO)}")`, f)
}

/** Every row of one report matching `criteria` (all pages) — e.g. the Honduras schedules' `(Day == "Wednesday")`. */
export async function fetchReport(
  token: string, app: string, report: string, criteria: string, f: FetchLike = fetch as any,
): Promise<Fetched> {
  const url = `${CREATOR_API_BASE}/data/${OWNER_NAME}/${app}/report/${report}?criteria=${encodeURIComponent(criteria)}&max_records=1000`
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` }
    if (cursor) headers.record_cursor = cursor
    let res: Awaited<ReturnType<FetchLike>> | null = null
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try { res = await f(url, { headers }) } catch (e) {
        if (attempt === 1) return { ok: false, error: `network error: ${e instanceof Error ? e.message : String(e)}` }
        await new Promise(r => setTimeout(r, 400))
      }
    }
    const body: any = await res!.json().catch(() => ({}))
    // 3100 = "No records found", 3001 = "no more records" — HTTP 404 or 200, both empty.
    if (body?.code === 3100 || body?.code === 3001) break
    if (!res!.ok || !Array.isArray(body?.data)) {
      return { ok: false, error: `HTTP ${res!.status}${body?.code ? ` (Zoho code ${body.code})` : ''}${body?.message ? `: ${String(body.message).slice(0, 160)}` : ''}` }
    }
    rows.push(...body.data)
    cursor = res!.headers.get('record_cursor')
    if (!cursor) break
  }
  return { ok: true, rows }
}

// ── Storage (one small interface, so the whole run is testable) ───────────────
export interface CacheRow { log_date: string; kind: 'sessions' | 'breaks'; employee_norm: string; source: string; payload: unknown[] }
export interface SyncRow { log_date: string; refreshed_at: string | null; started_at: string | null }

export interface AuxStore {
  /** Every account's data_source, and its older RTA Logs "Zoho Account Name" (read by zohoAccountNamesOf until the Zoho Account setting is saved). */
  loadAccounts(): Promise<{ id: string; ds: DataSourceConfig; rtaAccountName?: string | null }[]>
  getSync(dates: string[]): Promise<Record<string, SyncRow>>
  markStarted(date: string, at: string): Promise<void>
  markSynced(date: string, at: string, note: string): Promise<void>
  writeCache(date: string, source: string, rows: CacheRow[]): Promise<void>
  /** `kind` = only that kind (the Hourly page needs only the time logs). */
  readCache(dates: string[], kind?: CacheRow['kind']): Promise<{ sessions: ZohoSession[]; breaks: ZohoBreak[] }>
  /** account id → its display name here (what its Zoho account is matched against). */
  accountNames(): Promise<Record<string, string>>
  replaceAccountRows(accountId: string, rows: ZohoAgentStatusRow[]): Promise<void>
  clearAccountsExcept(keepIds: string[]): Promise<void>
  // ── The Zoho ↔ CRM check ──
  /** The account's CRM agent rows, normalized (normalizeAgentRow) — its agent sources minus the Zoho section. */
  crmAgents(accountId: string, ds: DataSourceConfig): Promise<Record<string, any>[]>
  readMismatches(accountId: string): Promise<ZohoCrmMismatchRow[]>
  replaceMismatches(accountId: string, rows: ZohoCrmMismatchRow[]): Promise<void>
  clearMismatchesExcept(keepIds: string[]): Promise<void>
  // ── Accounts run from Zoho (lib/zohoWorkforce.ts) ──
  replaceKpiRows(accountId: string, rows: ZohoKpiRow[]): Promise<void>
  clearKpisExcept(keepIds: string[]): Promise<void>
}

export function supabaseAuxStore(): AuxStore {
  const db = getSupabaseAdmin()
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    return r.data
  }
  return {
    async loadAccounts() {
      // rta_account_name only matters while an account's Zoho Account setting is unsaved — if
      // the column is ever missing, read without it rather than fail every account.
      let res = await db.from('wfm_settings').select('id, data_source, rta_account_name')
      if (res.error) res = await db.from('wfm_settings').select('id, data_source') as typeof res
      const rows = must(res, 'reading account settings') as any[]
      return (rows ?? []).map(r => ({ id: r.id as string, ds: r.data_source as DataSourceConfig, rtaAccountName: r.rta_account_name ?? null }))
    },
    async getSync(dates) {
      const rows = must(await db.from(ZOHO_AUX_SYNC_TABLE).select('log_date, refreshed_at, started_at').in('log_date', dates), 'reading Zoho sync state') as SyncRow[]
      return Object.fromEntries((rows ?? []).map(r => [r.log_date, r]))
    },
    async markStarted(date, at) {
      must(await db.from(ZOHO_AUX_SYNC_TABLE).upsert({ log_date: date, started_at: at }, { onConflict: 'log_date' }), 'marking the pull started')
    },
    async markSynced(date, at, note) {
      must(await db.from(ZOHO_AUX_SYNC_TABLE).upsert({ log_date: date, refreshed_at: at, note }, { onConflict: 'log_date' }), 'stamping the pull')
    },
    async writeCache(date, source, rows) {
      must(await db.from(ZOHO_AUX_CACHE_TABLE).delete().eq('log_date', date).eq('source', source), 'clearing the cached date')
      for (let i = 0; i < rows.length; i += 500) {
        must(await db.from(ZOHO_AUX_CACHE_TABLE).insert(rows.slice(i, i + 500)), 'caching Zoho rows')
      }
    },
    async readCache(dates, kind) {
      const sessions: ZohoSession[] = [], breaks: ZohoBreak[] = []
      // A stable order, so 1,000-row pages never skip or repeat a row. The pages are
      // read in parallel once the count is known (~5,000 rows for two days of time logs).
      const query = () => {
        const q = db.from(ZOHO_AUX_CACHE_TABLE).select('kind, payload', { count: 'exact' }).in('log_date', dates)
        return (kind ? q.eq('kind', kind) : q).order('log_date').order('employee_norm').order('kind').order('source')
      }
      type Page = { kind: string; payload: any[] }[]
      const first = await query().range(0, 999)
      const pages = [must(first, 'reading the Zoho cache') as Page]
      if (pages[0]?.length === 1000) {
        if (typeof first.count === 'number') {
          const rest = await Promise.all(Array.from({ length: Math.ceil(first.count / 1000) - 1 }, (_, i) =>
            query().range((i + 1) * 1000, (i + 2) * 1000 - 1)))
          for (const r of rest) pages.push(must(r, 'reading the Zoho cache') as Page)
        } else {
          for (let from = 1000; ; from += 1000) {
            const page = must(await query().range(from, from + 999), 'reading the Zoho cache') as Page
            pages.push(page)
            if (!page || page.length < 1000) break
          }
        }
      }
      for (const page of pages) for (const r of page ?? []) {
        if (r.kind === 'sessions') sessions.push(...(r.payload ?? []))
        else if (r.kind === 'breaks') breaks.push(...(r.payload ?? []))
      }
      return { sessions, breaks }
    },
    async accountNames() {
      const rows = must(await db.from('wfm_accounts').select('id, display_name'), 'reading account names') as { id: string; display_name: string | null }[]
      return Object.fromEntries((rows ?? []).map(r => [r.id, r.display_name || r.id]))
    },
    async replaceAccountRows(accountId, rows) {
      if (rows.length) must(await db.from(ZOHO_AUX_TABLE).upsert(rows, { onConflict: 'id' }), 'writing Zoho Breaks & Aux rows')
      const existing = must(await db.from(ZOHO_AUX_TABLE).select('id').eq('account_id', accountId), 'reading Zoho Breaks & Aux rows') as { id: string }[]
      const keep = new Set(rows.map(r => r.id))
      const stale = (existing ?? []).map(r => r.id).filter(id => !keep.has(id))
      if (stale.length) must(await db.from(ZOHO_AUX_TABLE).delete().in('id', stale), 'removing finished breaks')
    },
    async clearAccountsExcept(keepIds) {
      const existing = must(await db.from(ZOHO_AUX_TABLE).select('account_id'), 'reading Zoho Breaks & Aux accounts') as { account_id: string }[]
      const stale = [...new Set((existing ?? []).map(r => r.account_id))].filter(id => !keepIds.includes(id))
      if (stale.length) must(await db.from(ZOHO_AUX_TABLE).delete().in('account_id', stale), 'clearing accounts that turned Zoho off')
    },
    async crmAgents(accountId, ds) {
      const lists = await Promise.all(agentSourcesFor(ds, { includeZohoAux: false }).map(async src => {
        if (!src.table) return []
        const rows = must(await db.from(src.table).select('*').eq(src.accountCol || 'account_id', accountId), `reading ${src.table}`) as Record<string, any>[]
        return (rows ?? []).map(r => normalizeAgentRow(r, src))
      }))
      return lists.flat()
    },
    async readMismatches(accountId) {
      return (must(await db.from(ZOHO_CRM_MISMATCH_TABLE).select('*').eq('account_id', accountId), 'reading Zoho / CRM mismatches') ?? []) as ZohoCrmMismatchRow[]
    },
    async replaceMismatches(accountId, rows) {
      if (rows.length) must(await db.from(ZOHO_CRM_MISMATCH_TABLE).upsert(rows, { onConflict: 'id' }), 'writing Zoho / CRM mismatches')
      const existing = must(await db.from(ZOHO_CRM_MISMATCH_TABLE).select('id').eq('account_id', accountId), 'reading Zoho / CRM mismatches') as { id: string }[]
      const keep = new Set(rows.map(r => r.id))
      const stale = (existing ?? []).map(r => r.id).filter(id => !keep.has(id))
      if (stale.length) must(await db.from(ZOHO_CRM_MISMATCH_TABLE).delete().in('id', stale), 'removing resolved Zoho / CRM mismatches')
    },
    async clearMismatchesExcept(keepIds) {
      const existing = must(await db.from(ZOHO_CRM_MISMATCH_TABLE).select('account_id'), 'reading Zoho / CRM mismatch accounts') as { account_id: string }[]
      const stale = [...new Set((existing ?? []).map(r => r.account_id))].filter(id => !keepIds.includes(id))
      if (stale.length) must(await db.from(ZOHO_CRM_MISMATCH_TABLE).delete().in('account_id', stale), 'clearing accounts that turned the Zoho / CRM check off')
    },
    async replaceKpiRows(accountId, rows) {
      if (rows.length) must(await db.from(ZOHO_KPI_TABLE).upsert(rows, { onConflict: 'id' }), 'writing the Zoho KPI tiles')
      const existing = must(await db.from(ZOHO_KPI_TABLE).select('id').eq('account_id', accountId), 'reading the Zoho KPI tiles') as { id: string }[]
      const keep = new Set(rows.map(r => r.id))
      const stale = (existing ?? []).map(r => r.id).filter(id => !keep.has(id))
      if (stale.length) must(await db.from(ZOHO_KPI_TABLE).delete().in('id', stale), 'removing old Zoho KPI tiles')
    },
    async clearKpisExcept(keepIds) {
      const existing = must(await db.from(ZOHO_KPI_TABLE).select('account_id'), 'reading the Zoho KPI accounts') as { account_id: string }[]
      const stale = [...new Set((existing ?? []).map(r => r.account_id))].filter(id => !keepIds.includes(id))
      if (stale.length) must(await db.from(ZOHO_KPI_TABLE).delete().in('account_id', stale), 'clearing accounts that stopped reading the Zoho KPI tiles')
    },
  }
}

// ── The Zoho ↔ CRM check, for one account ─────────────────────────────────────
// Paused — the account's stored mismatches cleared, so nothing breaches — while
// Zoho's data for today is too old (a broken pull would otherwise make everyone
// look out of sync) or the CRM rows are stale (the scraper is down: frozen
// statuses against a live Zoho). Returns its log line.
const MISMATCH_TABLE_HINT = 'run sql/zoho_crm_match.sql once in Supabase (SQL Editor) to create it'
const CRM_STALE_MS = 5 * 60 * 1000

export function zohoNowOf(current: Map<string, CurrentAux>): ZohoNow {
  return new Map([...current].map(([k, c]) => [k, { name: c.employee, status: c.type }]))
}

async function checkZohoCrm(
  a: { id: string; ds: DataSourceConfig }, zohoNow: ZohoNow, zohoAgeMin: number, store: AuxStore, nowIso: string,
): Promise<{ line: string; mismatches: number }> {
  const cfg = a.ds.zohoCrmMatch!
  const pause = async (why: string) => {
    await store.replaceMismatches(a.id, [])
    return { line: `${a.id}: Zoho ↔ CRM check paused — ${why}.`, mismatches: 0 }
  }
  if (!(zohoAgeMin <= ZOHO_MATCH_MAX_ZOHO_AGE_MIN)) {
    return pause(Number.isFinite(zohoAgeMin) ? `Zoho's data is ${Math.round(zohoAgeMin)} min old` : 'Zoho hasn\'t been pulled today yet')
  }
  const crm = await store.crmAgents(a.id, a.ds)
  if (!crm.length) return pause('no agents on the CRM tables')
  // Same 5 minutes as the dashboard's "DATA NOT IN SYNC" (isDataStale), on this run's clock.
  const crmUpdated = mostRecentUpdatedAt(crm, 'updated_at')
  if (crmUpdated && Date.parse(nowIso) - Date.parse(crmUpdated) > CRM_STALE_MS) {
    return pause(`the CRM agent data is ${Math.round((Date.parse(nowIso) - Date.parse(crmUpdated)) / 60000)} min old`)
  }

  const found = findZohoCrmMismatches(cfg, crm, zohoNow)
  const rows = nextMismatchRows(a.id, found, await store.readMismatches(a.id), nowIso)
  await store.replaceMismatches(a.id, rows)
  const list = found.slice(0, 8).map(m => `${m.crmName} (CRM ${m.crmStatus} / Zoho ${m.zohoStatus})`).join(', ')
  return {
    line: `${a.id}: Zoho ↔ CRM — ${cfg.pairs.length} pair(s), ${found.length} out of sync now${found.length ? `: ${list}${found.length > 8 ? ', …' : ''}` : ''}.`,
    mismatches: found.length,
  }
}

const isMissingTable = (e: unknown) => /wfm_zoho_crm_mismatch|PGRST205|does not exist|schema cache/i.test(e instanceof Error ? e.message : String(e))
const KPI_TABLE_HINT = 'run sql/zoho_only_accounts.sql once in Supabase (SQL Editor) to create it'
const isKpiTableMissing = (e: unknown) => /wfm_zoho_kpis|PGRST205|does not exist|schema cache/i.test(e instanceof Error ? e.message : String(e))
const pctOf = (n: number | null) => n === null ? '--' : `${Math.round(n * 10) / 10}%`

/** Every account's cached shifts for `dates`, the due ones pulled first — loadZohoSchedules() in lib/hourlyReportServer.ts. */
export type ScheduleLoader = (dates: string[], opts: { now: number; log: (m: string) => void },
  deps: { getToken: () => Promise<string>; fetch: FetchLike }) => Promise<ScheduleCacheRow[]>
// Imported when first used: lib/hourlyReportServer.ts imports this file.
const defaultScheduleLoader: ScheduleLoader = async (dates, opts, deps) =>
  (await import('./hourlyReportServer')).loadZohoSchedules(dates, opts, deps)

// ── One date, both Zoho apps ──────────────────────────────────────────────────
async function pullDate(date: string, token: string, store: AuxStore, f: FetchLike, nowIso: string, l: (m: string) => void): Promise<boolean> {
  let anyOk = false
  const notes: string[] = []
  const sources = ZOHO_AUX_SOURCES.filter(s => s.key !== 'honduras' || process.env.ZOHO_HONDURAS_ENABLED !== 'false')
  for (const s of sources) {
    const [tl, bl] = await Promise.all([
      fetchReportForDate(token, s.app, s.timelog.report, s.timelog.dateField, date, f),
      fetchReportForDate(token, s.app, s.breaks.report, s.breaks.dateField, date, f),
    ])
    if (!tl.ok || !bl.ok) {
      const failed = !tl.ok ? { report: s.timelog.report, r: tl } : { report: s.breaks.report, r: bl }
      const why = `${failed.report}: ${'error' in failed.r ? failed.r.error : 'unknown error'}`
      l(`Zoho ${s.key} ${date}: NOT pulled — ${why}. Keeping the last good copy.`)
      notes.push(`${s.key} failed`)
      continue
    }
    anyOk = true
    // Which field holds each person's account — see pickAccountField(). Break
    // rows that don't carry it take it from the same person's time log.
    const tlField = pickAccountField(tl.rows), blField = pickAccountField(bl.rows)
    const sessions = tl.rows.map(r => parseSessionRow(r, s, tlField, date)).filter(x => x.employee)
    const breaks = bl.rows.map(r => parseBreakRow(r, s, blField)).filter(x => x.employee)
    const accountOf = new Map<string, string[]>()
    for (const x of sessions) if (x.accounts?.length) accountOf.set(normalizeName(x.employee), x.accounts)
    for (const b of breaks) if (!b.accounts?.length) b.accounts = accountOf.get(normalizeName(b.employee)) ?? []
    const accountsFound = zohoAccountsSeen(sessions, breaks).length
    if (tlField || blField) {
      l(`Zoho ${s.key} ${date}: each person's account read from ${[tlField && `${s.timelog.report}.${tlField}`, blField && `${s.breaks.report}.${blField}`].filter(Boolean).join(' and ')} — ${accountsFound} account(s).`)
    } else if (tl.rows.length) {
      const fields = [...new Set(tl.rows.slice(0, 20).flatMap(r => Object.keys(r)))]
      l(`Zoho ${s.key} ${date}: NO account field found on ${s.timelog.report} or ${s.breaks.report}, so its people can't be matched to an account. Fields on ${s.timelog.report}: ${fields.join(', ')}`)
    }
    const grouped = new Map<string, CacheRow>()
    const add = (kind: CacheRow['kind'], employee: string, item: unknown) => {
      const k = `${kind}|${normalizeName(employee)}`
      if (!grouped.has(k)) grouped.set(k, { log_date: date, kind, employee_norm: normalizeName(employee), source: s.key, payload: [] })
      grouped.get(k)!.payload.push(item)
    }
    sessions.forEach(x => add('sessions', x.employee, x))
    breaks.forEach(x => add('breaks', x.employee, x))
    // An ok-but-EMPTY pull is a no-op, never a wipe of a populated date.
    if (grouped.size) await store.writeCache(date, s.key, [...grouped.values()])
    // Leave notes ("[VL in Hours][8]") — counted here, so a pull shows whether Zoho's Note field reads as vCORE describes.
    const leaves = sessions.filter(x => x.leave).length
    l(`Zoho ${s.key} ${date}: ${sessions.length} time log(s), ${breaks.length} break/aux row(s), ${leaves} leave note(s).`)
    notes.push(`${s.key}: ${sessions.length} logs / ${breaks.length} breaks / ${leaves} leaves / account field ${tlField || blField || 'NONE'}`)
  }
  if (anyOk) await store.markSynced(date, nowIso, notes.join('; '))
  return anyOk
}

// ── Pull the dates that are due ───────────────────────────────────────────────
// Each [date, minutes, completeAfter?] is pulled when its cached copy is older
// than that many minutes (minutes = Infinity: only if it was never pulled), or
// was pulled before `completeAfter` (ms) — a past day pulled while it was still
// going on — unless another run started pulling it within PULL_LEASE_MS.
// `force` pulls every one. Shared by the cron below (today and yesterday) and
// the Hourly page (lib/hourlyReportServer.ts), which needs whichever dates it is
// showing — so a date is never pulled by both at once. Returns the dates' sync
// stamps from BEFORE this call, what it pulled, and what another run was pulling.
export type WantedDate = readonly [date: string, minutes: number, completeAfter?: number]

export const syncAgeMs = (sync: Record<string, SyncRow>, date: string, now: number) => {
  const t = sync[date]?.refreshed_at
  return t ? now - Date.parse(t) : Infinity
}

export function isDue(sync: Record<string, SyncRow>, [date, minutes, completeAfter]: WantedDate, now: number): boolean {
  const rf = sync[date]?.refreshed_at
  if (completeAfter !== undefined && rf && Date.parse(rf) < completeAfter && now >= completeAfter) return true
  return syncAgeMs(sync, date, now) >= minutes * 60_000 - 20_000
}

export function isInProgress(sync: Record<string, SyncRow>, date: string, now: number): boolean {
  const st = sync[date]?.started_at, rf = sync[date]?.refreshed_at
  return !!st && (!rf || Date.parse(st) > Date.parse(rf)) && now - Date.parse(st) < PULL_LEASE_MS
}

export async function refreshZohoLogDates(
  wanted: WantedDate[], opts: { force?: boolean; now: number; log: (m: string) => void },
  deps: { store: AuxStore; getToken: () => Promise<string>; fetch: FetchLike },
): Promise<{ sync: Record<string, SyncRow>; pulled: string[]; busy: string[] }> {
  const { now, log: l } = opts
  const nowIso = new Date(now).toISOString()
  const sync = await deps.store.getSync(wanted.map(w => w[0]))
  const pulled: string[] = [], busy: string[] = []
  let token: string | null = null
  for (const w of wanted) {
    const date = w[0]
    if (!opts.force && !isDue(sync, w, now)) continue
    if (!opts.force && isInProgress(sync, date, now)) { busy.push(date); l(`Zoho ${date}: another run is pulling it right now — using the cached copy.`); continue }
    if (!token) {
      try { token = await deps.getToken() } catch (e) {
        l(`Zoho sign-in failed — ${e instanceof Error ? e.message : String(e)}. Using the cached copy.`)
        break
      }
    }
    await deps.store.markStarted(date, nowIso)
    if (await pullDate(date, token, deps.store, deps.fetch, nowIso, l)) pulled.push(date)
  }
  return { sync, pulled, busy }
}

// ── The whole run ─────────────────────────────────────────────────────────────
export interface AuxSyncResult {
  log: string[]
  pulled: string[]
  // per account using Zoho: which Zoho account name(s) it was matched on, how
  // many people Zoho has on it, and how many of them (plus extra names) are on
  // a break/aux now, and logged in on none (shown as Logged In); scheduled but
  // not logged in (with that on); with the Zoho ↔ CRM check on, how many of its
  // agents are out of sync; and the Zoho KPI tiles, for an account that reads them
  accounts: {
    id: string; zohoAccounts: string[]; people: number; extraNames: number; onBreakOrAux: number; loggedIn: number
    notLoggedIn?: number; mismatches?: number; kpis?: ZohoKpiValues
  }[]
}

export async function runZohoAuxSync(
  opts: { force?: boolean } = {},
  deps: { store?: AuxStore; getToken?: () => Promise<string>; fetch?: FetchLike; now?: () => number; schedules?: ScheduleLoader } = {},
): Promise<AuxSyncResult> {
  const store = deps.store ?? supabaseAuxStore()
  const getToken = deps.getToken ?? getZohoAccessToken
  const f = deps.fetch ?? (fetch as any as FetchLike)
  const loadSchedules = deps.schedules ?? defaultScheduleLoader
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const log: string[] = []
  const l = (m: string) => log.push(m)

  const all = await store.loadAccounts()
  // Zoho Breaks & Aux on (the agent section), and/or a card reading the Zoho KPI tiles.
  const auxOn = all.filter(a => a.ds?.zohoAux?.enabled)
  const kpiOn = all.filter(a => readsZohoKpis(a.ds))
  const using = all.filter(a => a.ds?.zohoAux?.enabled || readsZohoKpis(a.ds))
  // An account that turned this off stops showing it at once anyway (the
  // dashboard only adds the section while it's on); clear its rows too.
  await store.clearAccountsExcept(auxOn.map(a => a.id))
  // Same for the Zoho ↔ CRM check (its rows are ignored while it's off anyway).
  // Only worth a log line when some account uses it — before then the table may
  // not even exist yet.
  const matching = auxOn.filter(a => zohoCrmMatchActive(a.ds))
  try { await store.clearMismatchesExcept(matching.map(a => a.id)) } catch (e) {
    if (matching.length) l(`Zoho ↔ CRM: ${isMissingTable(e) ? `its table is missing — ${MISMATCH_TABLE_HINT}` : e instanceof Error ? e.message : String(e)}`)
  }
  // And the Zoho KPI tiles — same reasoning.
  try { await store.clearKpisExcept(kpiOn.map(a => a.id)) } catch (e) {
    if (kpiOn.length) l(`Zoho KPI tiles: ${isKpiTableMissing(e) ? `their table is missing — ${KPI_TABLE_HINT}` : e instanceof Error ? e.message : String(e)}`)
  }
  if (using.length === 0) {
    l('No account has Zoho Breaks & Aux turned on — nothing pulled from Zoho.')
    return { log, pulled: [], accounts: [] }
  }

  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const { sync, pulled } = await refreshZohoLogDates(
    [[today, ZOHO_AUX_PULL_MINUTES], [yesterday, YESTERDAY_PULL_MINUTES]],
    { force: opts.force, now, log: l }, { store, getToken, fetch: f },
  )
  const age = (d: string) => syncAgeMs(sync, d, now)
  if (!pulled.length && !log.length) l(`Using the cached Zoho copy (today's was pulled ${Math.round(age(today) / 60000)} min ago; it refreshes every ${ZOHO_AUX_PULL_MINUTES} min).`)

  const { sessions, breaks } = await store.readCache([yesterday, today])
  const current = computeCurrentAux(sessions, breaks, now)
  const seen = zohoAccountsSeen(sessions, breaks)
  const displayNames = await store.accountNames()
  // How old the Zoho data behind `current` is — the Zoho ↔ CRM check pauses past ZOHO_MATCH_MAX_ZOHO_AGE_MIN,
  // and the Zoho KPI tiles stop being written (so the card shows DATA NOT IN SYNC rather than old numbers).
  const zohoAgeMin = pulled.includes(today) ? 0 : age(today) / 60000
  const zohoFresh = zohoAgeMin <= ZOHO_MATCH_MAX_ZOHO_AGE_MIN
  const zohoNow = zohoNowOf(current)

  // Zoho's Daily Schedules — only while an account needs them (its KPI tiles, or scheduled but not logged in).
  let schedules: ScheduleCacheRow[] | null = null
  if (kpiOn.length || auxOn.some(a => includeNotLoggedInOf(a.ds.zohoAux))) {
    try {
      schedules = await loadSchedules([yesterday, today], { now, log: l }, { getToken, fetch: f })
    } catch (e) {
      l(`Zoho schedules: could not be read — ${/PGRST205|does not exist|schema cache|HourlyTableMissing/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))
        ? 'their table is missing, run sql/hourly_report.sql once in Supabase' : e instanceof Error ? e.message : String(e)}. Skipping the KPI tiles and "not logged in" this run.`)
    }
  }
  const sessionsByPerson = byPerson(sessions)
  const breaksByPerson = byPerson(breaks)
  const leaves = leavesOf(sessions)

  const accounts: AuxSyncResult['accounts'] = []
  for (const a of using) {
    try {
      const cfg = a.ds.zohoAux ?? { enabled: false }
      // Matched on its Zoho Account setting, else its display name here (and id).
      const asked = zohoAccountNamesOf(a.ds, a.rtaAccountName)
      const keys = accountKeysFor(a.id, displayNames[a.id], asked)
      const label = (asked.length ? asked : [displayNames[a.id] || a.id]).map(n => `"${n}"`).join(' / ')
      const people = zohoPeopleOnAccount(sessions, breaks, keys)
      const extra = parseExtraNames(cfg.extraNames)
      const shifts = schedules ? accountShifts(schedules, keys, today, yesterday, now) : []
      const entry: AuxSyncResult['accounts'][number] = {
        id: a.id, zohoAccounts: asked.length ? asked : [displayNames[a.id] || a.id], people: people.size, extraNames: extra.length, onBreakOrAux: 0, loggedIn: 0,
      }
      accounts.push(entry)
      const parts: string[] = []

      if (cfg.enabled) {
        // Scheduled right now but not logged in: the account's shifts, and its extra names' wherever they're filed.
        let shown: Map<string, CurrentAux> = current
        let scheduledNames: string[] = []
        if (includeNotLoggedInOf(cfg) && schedules) {
          const extraSet = new Set(extra.map(normalizeName))
          const theirShifts = [...shifts, ...(extraSet.size ? scopedShifts(schedules, today, yesterday, now, (_r, k) => extraSet.has(k)) : [])]
          shown = new Map([...scheduledOffNow(theirShifts, sessionsByPerson, current, now, leaves), ...current])
          scheduledNames = theirShifts.map(s => s.employee)
        }
        const rows = buildAccountStatusRows(a.id, [...people.values(), ...extra, ...scheduledNames], shown, cfg, nowIso)
        await store.replaceAccountRows(a.id, rows)
        entry.loggedIn = rows.filter(r => r.category === 'login').length
        entry.notLoggedIn = rows.filter(r => r.category === 'off').length
        entry.onBreakOrAux = rows.length - entry.loggedIn - entry.notLoggedIn
        parts.push(`${entry.onBreakOrAux} on a break/aux now`)
        if (includeLoggedInOf(cfg)) parts.push(`${entry.loggedIn} logged in on none`)
        if (includeNotLoggedInOf(cfg)) parts.push(schedules ? `${entry.notLoggedIn} scheduled but not logged in` : 'scheduled-but-not-logged-in skipped (no schedules)')
      }

      if (readsZohoKpis(a.ds)) {
        if (!schedules) parts.push('KPI tiles not updated (no schedules)')
        else if (!zohoFresh) parts.push(`KPI tiles not updated — Zoho's data is ${Number.isFinite(zohoAgeMin) ? `${Math.round(zohoAgeMin)} min old` : 'not pulled today yet'}`)
        else {
          const v = computeAccountKpis({ shifts, sessionsByPerson, breaksByPerson, current, peopleOnAccount: people.keys(), leaves, now })
          entry.kpis = v
          try {
            await store.replaceKpiRows(a.id, zohoKpiRows(a.id, v, nowIso))
            parts.push(`KPIs: ${v.shiftsToday} shift(s) today${v.onLeave ? ` (${v.onLeave} on leave)` : ''}, ${v.scheduledNow} scheduled now, ${v.loggedIn} logged in, ${v.notLoggedIn} not logged in, attendance ${pctOf(v.attendance)}, absenteeism ${pctOf(v.absenteeism)} (${v.noShows} no-show), adherence ${pctOf(v.adherence)}, ${v.lateToday} late`)
          } catch (e) {
            parts.push(`KPI tiles NOT written — ${isKpiTableMissing(e) ? `their table is missing, ${KPI_TABLE_HINT}` : e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      let line = `${a.id}: Zoho account ${label} — ${people.size} ${people.size === 1 ? 'person' : 'people'} in Zoho's logs${extra.length ? ` (+${extra.length} extra name(s))` : ''}${schedules ? `, ${new Set(shifts.map(s => s.norm)).size} on its schedule today` : ''}${parts.length ? `, ${parts.join(', ')}` : ''}`
      if (!people.size && !shifts.length) {
        line += seen.length
          ? `. No one in Zoho's logs is on that account — if Zoho calls it something else, pick it under "Zoho Account" in Settings → Zoho Integrations. Zoho accounts seen: ${seen.slice(0, 40).map(x => x.name).join(', ')}${seen.length > 40 ? `, … (${seen.length} in all)` : ''}`
          : `. Zoho's cached logs carry no account at all yet (see the pull lines above).`
      }
      l(line)
      // Compared against EVERYONE's current Zoho status (`current`), not just the
      // rows this account shows — its include-toggles are about what Agent Status
      // lists, and a pair can name someone filed under another Zoho account.
      if (cfg.enabled && zohoCrmMatchActive(a.ds)) {
        try {
          const r = await checkZohoCrm(a, zohoNow, zohoAgeMin, store, nowIso)
          entry.mismatches = r.mismatches
          l(r.line)
        } catch (e) {
          l(`${a.id}: Zoho ↔ CRM check failed — ${isMissingTable(e) ? `its table is missing, ${MISMATCH_TABLE_HINT}` : e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      l(`${a.id}: could not update — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { log, pulled, accounts }
}

// ── For the Settings panel ────────────────────────────────────────────────────
// `zohoAccounts`: every account in today's Zoho logs and how many people are on
// it — what the "Zoho Account" picker suggests, and how the panel shows
// whether this account's name matches one. `zohoTypes`: every break/aux type in
// the last two days of Zoho logs (organisation-wide), so Settings → Status
// Durations can list them all — and their thresholds be set — before anyone
// on this account has actually been in them.
export async function getZohoAuxStatus(store: AuxStore = supabaseAuxStore()): Promise<{
  pullMinutes: number; today: string; lastPull: string | null; note: string | null
  zohoAccounts: { name: string; people: number }[]
  zohoTypes: { type: string; category: 'break' | 'aux'; count: number }[]
}> {
  const today = dateInTz(Date.now(), PRIMARY_TZ)
  const r = await getSupabaseAdmin().from(ZOHO_AUX_SYNC_TABLE).select('refreshed_at, note').eq('log_date', today).maybeSingle()
  const { sessions, breaks } = await store.readCache([today])
  const yesterday = await store.readCache([addDays(today, -1)])
  return {
    pullMinutes: ZOHO_AUX_PULL_MINUTES, today, lastPull: (r.data as any)?.refreshed_at ?? null, note: (r.data as any)?.note ?? null,
    zohoAccounts: zohoAccountsSeen(sessions, breaks),
    zohoTypes: zohoTypesSeen([...breaks, ...yesterday.breaks]),
  }
}

// ── For Settings → Zoho ↔ CRM ─────────────────────────────────────────────────
// Everyone this account can be paired with — its people in the last two days of
// Zoho logs plus its extra names (both as the modal has them, saved or not) —
// with their Zoho status right now (null = not logged in); the Zoho types its
// people used in those two days, and the whole organisation's; and what the
// check last stored for the account (null + needsMigration when
// sql/zoho_crm_match.sql hasn't been run yet). `zohoAccounts` is the modal's
// Zoho Account setting (zohoAccountsTextOf), one per line.
export async function getZohoCrmMatchInfo(
  accountId: string, cfg: { zohoAccounts?: string; extraNames?: string }, store: AuxStore = supabaseAuxStore(),
): Promise<ZohoCrmMatchInfo> {
  const now = Date.now()
  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const [names, sync, cache] = await Promise.all([store.accountNames(), store.getSync([today]), store.readCache([yesterday, today])])
  const current = computeCurrentAux(cache.sessions, cache.breaks, now)
  const onAccount = zohoPeopleOnAccount(cache.sessions, cache.breaks, accountKeysFor(accountId, names[accountId], parseExtraNames(cfg.zohoAccounts)))
  const all = new Map(onAccount)
  for (const n of parseExtraNames(cfg.extraNames)) if (!all.has(normalizeName(n))) all.set(normalizeName(n), n)
  const people = [...all].map(([k, name]) => {
    const c = current.get(k)
    return { name: c?.employee || name, status: c?.type ?? null, since: c?.since ?? null }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const mine = new Set(all.keys())

  let mismatches: ZohoCrmMismatchRow[] | null = null, needsMigration = false
  try { mismatches = await store.readMismatches(accountId) } catch (e) {
    if (!isMissingTable(e)) throw e
    needsMigration = true
  }
  return {
    pullMinutes: ZOHO_AUX_PULL_MINUTES, lastPull: sync[today]?.refreshed_at ?? null, people,
    accountTypes: zohoTypesSeen(cache.breaks.filter(b => mine.has(normalizeName(b.employee)))).map(t => t.type),
    zohoTypes: zohoTypesSeen(cache.breaks),
    mismatches, needsMigration,
  }
}
