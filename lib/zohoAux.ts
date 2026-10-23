// lib/zohoAux.ts
// SERVER ONLY. Pulls Zoho break/aux logs and time logs, caches them, and keeps
// each enabled account's "Zoho Breaks & Aux" agent section (wfm_zoho_agent_status)
// up to date. The pure rules (fields, parsing, matching, "on a break right now")
// are in lib/zohoAuxShared.ts.
//
// Same shape as Workforce R.E.S.T. vCORE's pipeline (see that file's header):
//   - pulls are ORGANISATION-WIDE, one date per pull, never per account or per
//     page view — accounts are scoped afterwards, by name;
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

import { getZohoAccessToken } from './zohoAuth'
import { getSupabaseAdmin } from './supabaseAdmin'
import { supabase } from './supabase'
import { OWNER_NAME } from './zohoCreator'
import { agentSourcesFor } from './breaches'
import type { DataSourceConfig } from './types'
import {
  ZOHO_AUX_SOURCES, ZOHO_AUX_TABLE, zohoCriteriaDate, parseSessionRow, parseBreakRow,
  normalizeName, dateInTz, addDays, computeCurrentAux, buildAccountStatusRows, parseExtraNames,
  type ZohoSession, type ZohoBreak, type ZohoAgentStatusRow,
} from './zohoAuxShared'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'
export const ZOHO_AUX_CACHE_TABLE = 'wfm_zoho_activity'
export const ZOHO_AUX_SYNC_TABLE  = 'wfm_zoho_sync'

// How often TODAY is re-pulled. Default 5 min, the same as vCORE: Zoho's API
// allowance is shared by the whole organisation, and a too-tight interval here
// would eat into what vCORE needs. 2–10 via ZOHO_AUX_PULL_MINUTES.
export const ZOHO_AUX_PULL_MINUTES = Math.min(10, Math.max(2, Number(process.env.ZOHO_AUX_PULL_MINUTES) || 5))
const YESTERDAY_PULL_MINUTES = 30
const PULL_LEASE_MS = 2 * 60 * 1000   // another run's pull counts as in progress for this long
const MAX_PAGES = 50
const PRIMARY_TZ = 'America/New_York'

// ── Zoho ──────────────────────────────────────────────────────────────────────
export type Fetched = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }
type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; headers: { get(name: string): string | null } }>

/** Every row of one report for ONE date (all pages). Zoho's "no records" is an empty result, not an error. */
export async function fetchReportForDate(
  token: string, app: string, report: string, dateField: string, dateISO: string, f: FetchLike = fetch as any,
): Promise<Fetched> {
  const criteria = `(${dateField} == "${zohoCriteriaDate(dateISO)}")`
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
interface SyncRow { log_date: string; refreshed_at: string | null; started_at: string | null }

export interface AuxStore {
  loadAccounts(): Promise<{ id: string; ds: DataSourceConfig }[]>
  getSync(dates: string[]): Promise<Record<string, SyncRow>>
  markStarted(date: string, at: string): Promise<void>
  markSynced(date: string, at: string, note: string): Promise<void>
  writeCache(date: string, source: string, rows: CacheRow[]): Promise<void>
  readCache(dates: string[]): Promise<{ sessions: ZohoSession[]; breaks: ZohoBreak[] }>
  rosterNames(ds: DataSourceConfig, accountId: string): Promise<string[]>
  replaceAccountRows(accountId: string, rows: ZohoAgentStatusRow[]): Promise<void>
  clearAccountsExcept(keepIds: string[]): Promise<void>
}

export function supabaseAuxStore(): AuxStore {
  const db = getSupabaseAdmin()
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    return r.data
  }
  return {
    async loadAccounts() {
      const rows = must(await db.from('wfm_settings').select('id, data_source'), 'reading account settings') as any[]
      return (rows ?? []).map(r => ({ id: r.id as string, ds: r.data_source as DataSourceConfig }))
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
    async readCache(dates) {
      const sessions: ZohoSession[] = [], breaks: ZohoBreak[] = []
      for (let from = 0; ; from += 1000) {
        const page = must(await db.from(ZOHO_AUX_CACHE_TABLE).select('kind, payload')
          .in('log_date', dates).order('log_date').order('employee_norm').order('kind').order('source')
          .range(from, from + 999), 'reading the Zoho cache') as { kind: string; payload: any[] }[]
        for (const r of page ?? []) {
          if (r.kind === 'sessions') sessions.push(...(r.payload ?? []))
          else if (r.kind === 'breaks') breaks.push(...(r.payload ?? []))
        }
        if (!page || page.length < 1000) break
      }
      return { sessions, breaks }
    },
    async rosterNames(ds, accountId) {
      const names: string[] = []
      for (const src of agentSourcesFor(ds, { includeZohoAux: false })) {
        if (!src.table || !src.nameCol) continue
        const r = await supabase.from(src.table as any).select(src.nameCol).eq(src.accountCol || 'account_id', accountId)
        for (const row of (r.data as any[]) ?? []) { const n = row?.[src.nameCol]; if (n) names.push(String(n)) }
      }
      return names
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
  }
}

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
    const sessions = tl.rows.map(r => parseSessionRow(r, s)).filter(x => x.employee)
    const breaks = bl.rows.map(r => parseBreakRow(r, s)).filter(x => x.employee)
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
    l(`Zoho ${s.key} ${date}: ${sessions.length} time log(s), ${breaks.length} break/aux row(s).`)
    notes.push(`${s.key}: ${sessions.length} logs / ${breaks.length} breaks`)
  }
  if (anyOk) await store.markSynced(date, nowIso, notes.join('; '))
  return anyOk
}

// ── The whole run ─────────────────────────────────────────────────────────────
export interface AuxSyncResult {
  log: string[]
  pulled: string[]
  accounts: { id: string; onBreakOrAux: number; roster: number; foundInZoho: number; notFoundSample: string[] }[]
}

export async function runZohoAuxSync(
  opts: { force?: boolean } = {},
  deps: { store?: AuxStore; getToken?: () => Promise<string>; fetch?: FetchLike; now?: () => number } = {},
): Promise<AuxSyncResult> {
  const store = deps.store ?? supabaseAuxStore()
  const getToken = deps.getToken ?? getZohoAccessToken
  const f = deps.fetch ?? (fetch as any as FetchLike)
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const log: string[] = []
  const l = (m: string) => log.push(m)

  const enabled = (await store.loadAccounts()).filter(a => a.ds?.zohoAux?.enabled)
  // An account that turned this off stops showing it at once anyway (the
  // dashboard only adds the section while it's on); clear its rows too.
  await store.clearAccountsExcept(enabled.map(a => a.id))
  if (enabled.length === 0) {
    l('No account has Zoho Breaks & Aux turned on — nothing pulled from Zoho.')
    return { log, pulled: [], accounts: [] }
  }

  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const sync = await store.getSync([today, yesterday])
  const age = (d: string) => { const t = sync[d]?.refreshed_at; return t ? now - Date.parse(t) : Infinity }
  const inProgress = (d: string) => {
    const st = sync[d]?.started_at, rf = sync[d]?.refreshed_at
    return !!st && (!rf || Date.parse(st) > Date.parse(rf)) && now - Date.parse(st) < PULL_LEASE_MS
  }

  const pulled: string[] = []
  let token: string | null = null
  for (const [date, minutes] of [[today, ZOHO_AUX_PULL_MINUTES], [yesterday, YESTERDAY_PULL_MINUTES]] as const) {
    const due = opts.force || age(date) >= minutes * 60_000 - 20_000
    if (!due) continue
    if (!opts.force && inProgress(date)) { l(`Zoho ${date}: another run is pulling it right now — using the cached copy.`); continue }
    if (!token) {
      try { token = await getToken() } catch (e) {
        l(`Zoho sign-in failed — ${e instanceof Error ? e.message : String(e)}. Using the cached copy.`)
        break
      }
    }
    await store.markStarted(date, nowIso)
    if (await pullDate(date, token, store, f, nowIso, l)) pulled.push(date)
  }
  if (!pulled.length && !log.length) l(`Using the cached Zoho copy (today's was pulled ${Math.round(age(today) / 60000)} min ago; it refreshes every ${ZOHO_AUX_PULL_MINUTES} min).`)

  const { sessions, breaks } = await store.readCache([yesterday, today])
  const current = computeCurrentAux(sessions, breaks, now)
  const inZoho = new Set(sessions.map(s => normalizeName(s.employee)))

  const accounts: AuxSyncResult['accounts'] = []
  for (const a of enabled) {
    try {
      const roster = [...await store.rosterNames(a.ds, a.id), ...parseExtraNames(a.ds.zohoAux?.extraNames)]
      const uniq = [...new Map(roster.map(n => [normalizeName(n), n.trim()])).values()].filter(Boolean)
      const rows = buildAccountStatusRows(a.id, uniq, current, a.ds.zohoAux!, nowIso)
      await store.replaceAccountRows(a.id, rows)
      const found = uniq.filter(n => inZoho.has(normalizeName(n)))
      const notFound = uniq.filter(n => !inZoho.has(normalizeName(n)))
      accounts.push({ id: a.id, onBreakOrAux: rows.length, roster: uniq.length, foundInZoho: found.length, notFoundSample: notFound.slice(0, 8) })
      l(`${a.id}: ${rows.length} on a Zoho break/aux now · ${found.length} of ${uniq.length} agent name(s) found in Zoho's logs` +
        (notFound.length ? ` — not found: ${notFound.slice(0, 8).join(', ')}${notFound.length > 8 ? ', …' : ''}` : ''))
    } catch (e) {
      l(`${a.id}: could not update — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { log, pulled, accounts }
}

// ── For the Settings panel ────────────────────────────────────────────────────
export async function getZohoAuxStatus(): Promise<{ pullMinutes: number; today: string; lastPull: string | null; note: string | null }> {
  const today = dateInTz(Date.now(), PRIMARY_TZ)
  const r = await getSupabaseAdmin().from(ZOHO_AUX_SYNC_TABLE).select('refreshed_at, note').eq('log_date', today).maybeSingle()
  return { pullMinutes: ZOHO_AUX_PULL_MINUTES, today, lastPull: (r.data as any)?.refreshed_at ?? null, note: (r.data as any)?.note ?? null }
}
