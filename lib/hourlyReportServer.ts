// lib/hourlyReportServer.ts
// SERVER ONLY. Everything the Hourly page (components/HourlyPage.tsx) needs from
// the server; the pure rules are lib/hourlyReport.ts.
//
//   1. KPI readings, every minute (runKpiHourlySnapshot — Vercel Cron,
//      app/api/kpi/hourly-snapshot). The CRMs only give live numbers, so this
//      is the only history there is: each account's KPI tiles — the same
//      kpiCardGroups() its Overview card shows — folded into the current hour's
//      record in wfm_kpi_hourly. Stale data (the scraper down, same 5 minutes as
//      "DATA NOT IN SYNC") isn't recorded. Kept KPI_KEEP_DAYS.
//   2. Zoho's Daily Schedules, pulled when the page asks for a date whose cached
//      copy is old (refreshZohoSchedules) — org-wide, one date per pull, like the
//      time logs — and cached per date × source × Zoho account in
//      wfm_zoho_schedules. No cron: a date nobody looks at is never pulled
//      (vCORE works the same way).
//   3. The page's data for one account and day (getHourlyReport): its people in
//      Zoho — scheduled shifts and Time Tracker sessions — and its KPI hours. The
//      time logs are the cache Zoho Breaks & Aux already keeps (lib/zohoAux.ts);
//      a date it hasn't pulled (an older day, or none of the accounts has Breaks
//      & Aux on) is pulled here through the SAME refreshZohoLogDates(), so a date
//      is never pulled twice at once.
// People are on an account by their ACCOUNT in Zoho — the account's "Zoho
// Account" setting (Settings → Zoho Integrations), else its display name — the
// same matching as Zoho Breaks & Aux.

import { supabase } from './supabase'
import { getSupabaseAdmin } from './supabaseAdmin'
import { getZohoAccessToken } from './zohoAuth'
import { kpiCardGroups, freshestAcrossSources, fetchKpiData, supabaseTableFetcher } from './breaches'
import { migrateDataSource, mergeKpiThresholds } from './utils'
import type { AccountData, DataSourceConfig } from './types'
import {
  supabaseAuxStore, refreshZohoLogDates, fetchReport, isDue, isInProgress,
  ZOHO_AUX_PULL_MINUTES, YESTERDAY_PULL_MINUTES, PRIMARY_TZ,
  type AuxStore, type SyncRow, type WantedDate, type Fetched, type FetchLike,
} from './zohoAux'
import {
  normalizeName, normalizeAccount, dateInTz, addDays, parseZohoDate, zohoCriteriaDate, pickAccountField,
  zohoAccountNamesOf, accountKeysFor,
} from './zohoAuxShared'
import {
  dayWindow, zohoDatesFor, parseScheduleRow, groupShiftsByAccount, scheduleRowAccounts, sessionEnd,
  addKpiReading, hourStartIso, kpiTileKey, ZOHO_SCHEDULE_SOURCES,
  type HourlyPerson, type HourlyReport, type KpiHour, type ScheduleCacheRow,
} from './hourlyReport'

export const KPI_HOURLY_TABLE = 'wfm_kpi_hourly'
export const SCHEDULE_TABLE = 'wfm_zoho_schedules'
export const SCHEDULE_SYNC_TABLE = 'wfm_zoho_schedule_sync'
export const HOURLY_SQL_HINT = 'run sql/hourly_report.sql once in Supabase (SQL Editor)'
const KPI_KEEP_DAYS = 120
const STALE_MS = 5 * 60 * 1000          // the dashboard's "DATA NOT IN SYNC" (isDataStale)
const SCHEDULE_PULL_MINUTES = 30        // today and later — a schedule rarely changes within the half hour

/** The account's KPI rows — the same fetch as the breach scan (fetchKpiData), on the same client. */
async function fetchAccountKpi(ds: DataSourceConfig, accountId: string): Promise<AccountData> {
  return { kpi: null, ...(await fetchKpiData(ds, accountId, supabaseTableFetcher(supabase))), agents: [], status: null, calls: [] }
}

/** A table from sql/hourly_report.sql that hasn't been created yet. */
export class HourlyTableMissing extends Error {}
const missing = (e: { code?: string; message: string }) => e.code === 'PGRST205' || e.code === '42P01' || /does not exist|could not find the table|schema cache/i.test(e.message)

// ── Storage (one small interface, so it's testable without Supabase) ─────────
export interface HourlyStore {
  loadAllSettings(): Promise<{ id: string; ds: unknown; kpi: unknown }[]>
  loadAccount(accountId: string): Promise<{ ds: DataSourceConfig; rtaAccountName: string | null; displayName: string } | null>
  readKpiHour(hourIso: string): Promise<{ account_id: string; tiles: KpiHour }[]>
  writeKpiHours(rows: { account_id: string; hour_start: string; tiles: KpiHour; updated_at: string }[]): Promise<void>
  readKpiRange(accountId: string, fromIso: string, toIso: string): Promise<{ hour_start: string; tiles: KpiHour }[]>
  pruneKpi(beforeIso: string): Promise<void>
  getScheduleSync(dates: string[]): Promise<Record<string, SyncRow>>
  markScheduleStarted(date: string, at: string): Promise<void>
  markScheduleSynced(date: string, at: string, note: string): Promise<void>
  writeSchedules(date: string, source: string, rows: ScheduleCacheRow[]): Promise<void>
  readSchedules(dates: string[], accountNorms: string[]): Promise<ScheduleCacheRow[]>
}

export function supabaseHourlyStore(): HourlyStore {
  const db = getSupabaseAdmin()
  const must = <T>(r: { data: T; error: { code?: string; message: string } | null }, what: string): T => {
    if (r.error) throw missing(r.error) ? new HourlyTableMissing(`${what}: ${r.error.message}`) : new Error(`${what}: ${r.error.message}`)
    return r.data
  }
  return {
    async loadAllSettings() {
      const rows = must(await db.from('wfm_settings').select('id, data_source, kpi_thresholds'), 'reading account settings') as any[]
      return (rows ?? []).map(r => ({ id: r.id as string, ds: r.data_source, kpi: r.kpi_thresholds }))
    },
    async loadAccount(accountId) {
      let res = await db.from('wfm_settings').select('data_source, rta_account_name').eq('id', accountId).maybeSingle()
      if (res.error) res = await db.from('wfm_settings').select('data_source').eq('id', accountId).maybeSingle() as typeof res
      const row = must(res, 'reading the account\'s settings') as any
      if (!row) return null
      const name = await db.from('wfm_accounts').select('display_name').eq('id', accountId).maybeSingle()
      return { ds: migrateDataSource(row.data_source), rtaAccountName: row.rta_account_name ?? null, displayName: (name.data as any)?.display_name || accountId }
    },
    async readKpiHour(hourIso) {
      return (must(await db.from(KPI_HOURLY_TABLE).select('account_id, tiles').eq('hour_start', hourIso), 'reading this hour\'s KPI readings') ?? []) as any[]
    },
    async writeKpiHours(rows) {
      must(await db.from(KPI_HOURLY_TABLE).upsert(rows, { onConflict: 'account_id,hour_start' }), 'saving the KPI readings')
    },
    async readKpiRange(accountId, fromIso, toIso) {
      return (must(await db.from(KPI_HOURLY_TABLE).select('hour_start, tiles').eq('account_id', accountId)
        .gte('hour_start', fromIso).lt('hour_start', toIso).order('hour_start'), 'reading the KPI readings') ?? []) as any[]
    },
    async pruneKpi(beforeIso) {
      must(await db.from(KPI_HOURLY_TABLE).delete().lt('hour_start', beforeIso), 'pruning old KPI readings')
    },
    async getScheduleSync(dates) {
      const rows = must(await db.from(SCHEDULE_SYNC_TABLE).select('log_date, refreshed_at, started_at').in('log_date', dates), 'reading the Zoho schedule sync state') as SyncRow[]
      return Object.fromEntries((rows ?? []).map(r => [r.log_date, r]))
    },
    async markScheduleStarted(date, at) {
      must(await db.from(SCHEDULE_SYNC_TABLE).upsert({ log_date: date, started_at: at }, { onConflict: 'log_date' }), 'marking the schedule pull started')
    },
    async markScheduleSynced(date, at, note) {
      must(await db.from(SCHEDULE_SYNC_TABLE).upsert({ log_date: date, refreshed_at: at, note }, { onConflict: 'log_date' }), 'stamping the schedule pull')
    },
    async writeSchedules(date, source, rows) {
      must(await db.from(SCHEDULE_TABLE).delete().eq('log_date', date).eq('source', source), 'clearing the cached schedules')
      for (let i = 0; i < rows.length; i += 200) {
        must(await db.from(SCHEDULE_TABLE).insert(rows.slice(i, i + 200)), 'caching the Zoho schedules')
      }
    },
    async readSchedules(dates, accountNorms) {
      if (!accountNorms.length) return []
      return (must(await db.from(SCHEDULE_TABLE).select('log_date, source, account_norm, account, payload')
        .in('log_date', dates).in('account_norm', accountNorms), 'reading the Zoho schedules') ?? []) as ScheduleCacheRow[]
    },
  }
}

// ── 1. KPI readings, every minute ─────────────────────────────────────────────
export interface KpiSnapshotResult { log: string[]; recorded: number; skipped: number }

export async function runKpiHourlySnapshot(deps: {
  store?: HourlyStore; fetchKpi?: (ds: DataSourceConfig, accountId: string) => Promise<AccountData>; now?: () => number
} = {}): Promise<KpiSnapshotResult> {
  const store = deps.store ?? supabaseHourlyStore()
  const fetchKpi = deps.fetchKpi ?? fetchAccountKpi
  const now = (deps.now ?? Date.now)()
  const atIso = new Date(now).toISOString(), hour = hourStartIso(now)
  const log: string[] = []

  const accounts = (await store.loadAllSettings()).filter(a => a.ds)
  const existing = new Map((await store.readKpiHour(hour)).map(r => [r.account_id, r.tiles ?? {}]))
  const results = await Promise.all(accounts.map(async a => {
    try {
      const ds = migrateDataSource(a.ds)
      const data = await fetchKpi(ds, a.id)
      const rows = (data.kpiRows?.length ?? 0) + Object.values(data.kpiRowsBySource ?? {}).reduce((n, r) => n + r.length, 0)
      if (!rows) return { id: a.id, skip: 'no KPI rows' }
      const fresh = freshestAcrossSources(ds, data)
      if (fresh && now - Date.parse(fresh) > STALE_MS) return { id: a.id, skip: `its data is ${Math.round((now - Date.parse(fresh)) / 60000)} min old — not recorded` }
      const tiles: KpiHour = { ...(existing.get(a.id) ?? {}) }
      let read = 0
      for (const g of kpiCardGroups(ds, data, mergeKpiThresholds(a.kpi))) {
        for (const t of g.tiles) {
          const key = kpiTileKey(g.id, t.key)
          const next = addKpiReading(tiles[key], t.value, t.unit, atIso)
          if (next && next !== tiles[key]) { tiles[key] = next; read++ }
        }
      }
      if (!read) return { id: a.id, skip: 'no tile had a value' }
      return { id: a.id, read, row: { account_id: a.id, hour_start: hour, tiles, updated_at: atIso } }
    } catch (e) {
      return { id: a.id, skip: `failed — ${e instanceof Error ? e.message : String(e)}` }
    }
  }))

  const rows = results.flatMap(r => ('row' in r && r.row ? [r.row] : []))
  if (rows.length) await store.writeKpiHours(rows)
  for (const r of results) log.push('row' in r ? `${r.id}: ${r.read} tile reading(s) recorded for ${hour}.` : `${r.id}: skipped — ${r.skip}.`)
  // Old hours, once an hour.
  if (new Date(now).getUTCMinutes() === 7) {
    await store.pruneKpi(new Date(now - KPI_KEEP_DAYS * 86400e3).toISOString()).catch(e => log.push(`Pruning failed — ${e instanceof Error ? e.message : String(e)}`))
  }
  return { log, recorded: rows.length, skipped: results.length - rows.length }
}

// ── 2. Zoho's Daily Schedules ─────────────────────────────────────────────────
// A past day is complete once the day after it is over (its overnight shifts are
// done) — a copy pulled before then is pulled once more.
const completeAfter = (date: string) => Date.parse(parseZohoDate(`${zohoCriteriaDate(addDays(date, 2))} 00:00`, PRIMARY_TZ) as string)

async function pullScheduleDate(date: string, token: string, store: HourlyStore, f: FetchLike, nowIso: string, l: (m: string) => void): Promise<boolean> {
  let anyOk = false
  const notes: string[] = []
  for (const s of ZOHO_SCHEDULE_SOURCES.filter(x => x.key !== 'honduras' || process.env.ZOHO_HONDURAS_ENABLED !== 'false')) {
    const res: Fetched = await fetchReport(token, s.app, s.report, s.criteria(date), f)
    if (!res.ok) {
      l(`Zoho schedules ${s.key} ${date}: NOT pulled — ${s.report}: ${res.error}. Keeping the last good copy.`)
      notes.push(`${s.key} failed`)
      continue
    }
    anyOk = true
    const field = pickAccountField(res.rows)
    const g = groupShiftsByAccount(date, s.key, res.rows.map(r => ({ shift: parseScheduleRow(r, s, date), accounts: scheduleRowAccounts(r, field) })))
    // An ok-but-EMPTY pull is a no-op, never a wipe of a cached date.
    if (g.rows.length) await store.writeSchedules(date, s.key, g.rows)
    l(`Zoho schedules ${s.key} ${date}: ${g.shifts} shift(s), ${g.rest} rest day / blank row(s), ${g.rows.length} account(s)` +
      (field ? ` — account from ${s.report}.${field}` : res.rows.length ? ` — NO account field found on ${s.report}; fields: ${[...new Set(res.rows.slice(0, 20).flatMap(r => Object.keys(r)))].join(', ')}` : '') +
      (g.noAccount ? `, ${g.noAccount} shift(s) with no account` : '') + '.')
    notes.push(`${s.key}: ${g.shifts} shifts / ${g.rows.length} accounts / account field ${field || 'NONE'}`)
  }
  if (anyOk) await store.markScheduleSynced(date, nowIso, notes.join('; '))
  return anyOk
}

/** Pull the schedule dates that are due — today and later every SCHEDULE_PULL_MINUTES, yesterday
 *  every 6 hours, an older day only if never pulled (or pulled before it was over). */
export async function refreshZohoSchedules(
  dates: string[], opts: { now: number; log: (m: string) => void },
  deps: { store: HourlyStore; getToken: () => Promise<string>; fetch: FetchLike },
): Promise<{ sync: Record<string, SyncRow>; pulled: string[]; busy: string[] }> {
  const { now, log: l } = opts
  const nowIso = new Date(now).toISOString()
  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const sync = await deps.store.getScheduleSync(dates)
  const pulled: string[] = [], busy: string[] = []
  let token: string | null = null
  for (const date of dates) {
    const w: WantedDate = date >= today ? [date, SCHEDULE_PULL_MINUTES] : date === yesterday ? [date, 360] : [date, Infinity, completeAfter(date)]
    if (!isDue(sync, w, now)) continue
    if (isInProgress(sync, date, now)) { busy.push(date); l(`Zoho schedules ${date}: another request is pulling them right now — using the cached copy.`); continue }
    if (!token) {
      try { token = await deps.getToken() } catch (e) {
        l(`Zoho sign-in failed — ${e instanceof Error ? e.message : String(e)}. Using the cached schedules.`)
        break
      }
    }
    await deps.store.markScheduleStarted(date, nowIso)
    if (await pullScheduleDate(date, token, deps.store, deps.fetch, nowIso, l)) pulled.push(date)
  }
  return { sync, pulled, busy }
}

// ── 3. The page's data (HourlyReport, lib/hourlyReport.ts) ────────────────────
export async function getHourlyReport(
  accountId: string, date: string, tz: string,
  deps: { store?: HourlyStore; auxStore?: AuxStore; getToken?: () => Promise<string>; fetch?: FetchLike; now?: () => number } = {},
): Promise<HourlyReport> {
  const store = deps.store ?? supabaseHourlyStore()
  const auxStore = deps.auxStore ?? supabaseAuxStore()
  const f = deps.fetch ?? (fetch as any as FetchLike)
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  // One Zoho sign-in for both pulls.
  let tokenP: Promise<string> | null = null
  const getToken = () => (tokenP ??= (deps.getToken ?? getZohoAccessToken)())
  const log: string[] = []
  const l = (m: string) => log.push(m)

  const acc = await store.loadAccount(accountId)
  if (!acc) throw new Error(`No settings for account "${accountId}".`)
  const names = zohoAccountNamesOf(acc.ds, acc.rtaAccountName)
  const keys = accountKeysFor(accountId, acc.displayName, names)
  const keySet = new Set(keys)

  const win = dayWindow(date, tz)
  const zDates = zohoDatesFor(win)
  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const logDates = zDates.filter(d => d <= today)
  const needsMigration = { kpi: false, schedules: false }

  // Time logs — the Breaks & Aux cache, pulled here when it hasn't got a date (or it's old).
  const wanted: WantedDate[] = logDates.map(d =>
    d === today ? [d, ZOHO_AUX_PULL_MINUTES] : d === yesterday ? [d, YESTERDAY_PULL_MINUTES] : [d, Infinity, completeAfter(d)])
  const logs = logDates.length
    ? await refreshZohoLogDates(wanted, { now, log: l }, { store: auxStore, getToken, fetch: f })
    : { sync: {}, pulled: [], busy: [] }
  const { sessions } = logDates.length ? await auxStore.readCache(logDates, 'sessions') : { sessions: [] }

  // Schedules — their own cache (sql/hourly_report.sql).
  let sched = { sync: {} as Record<string, SyncRow>, pulled: [] as string[], busy: [] as string[] }
  let scheduleRows: ScheduleCacheRow[] = []
  try {
    sched = await refreshZohoSchedules(zDates, { now, log: l }, { store, getToken, fetch: f })
    scheduleRows = await store.readSchedules(zDates, keys)
  } catch (e) {
    if (!(e instanceof HourlyTableMissing)) throw e
    needsMigration.schedules = true
    l(`Zoho schedules: their table is missing — ${HOURLY_SQL_HINT}.`)
  }

  // Everyone on the account, by name: their shifts and their sessions.
  const byPerson = new Map<string, HourlyPerson>()
  const matched = new Map<string, string>()
  const person = (name: string) => {
    const k = normalizeName(name)
    if (!byPerson.has(k)) byPerson.set(k, { name, shifts: [], sessions: [] })
    return byPerson.get(k)!
  }
  for (const s of sessions) {
    if (!s.login || !s.employee) continue
    const on = (s.accounts ?? []).filter(a => keySet.has(normalizeAccount(a)))
    if (!on.length) continue
    on.forEach(a => matched.set(normalizeAccount(a), a))
    person(s.employee).sessions.push([Date.parse(s.login), s.logout ? Date.parse(s.logout) : null])
  }
  for (const row of scheduleRows) {
    matched.set(row.account_norm, row.account)
    for (const sh of row.payload ?? []) person(sh.employee).shifts.push([Date.parse(sh.start), Date.parse(sh.end)])
  }
  const touches = (s: number, e: number) => e > win.start && s < win.end
  const people = [...byPerson.values()]
    .map(p => ({ ...p, shifts: p.shifts.filter(([s, e]) => touches(s, e)), sessions: p.sessions.filter(x => touches(x[0], sessionEnd(x, now))) }))
    .filter(p => p.shifts.length || p.sessions.length)
    .sort((a, b) => a.name.localeCompare(b.name))

  let kpiHours: HourlyReport['kpiHours'] = []
  try {
    kpiHours = (await store.readKpiRange(accountId, new Date(win.start).toISOString(), new Date(win.end).toISOString()))
      .map(r => ({ hour: new Date(r.hour_start).toISOString(), tiles: r.tiles ?? {} }))
  } catch (e) {
    if (!(e instanceof HourlyTableMissing)) throw e
    needsMigration.kpi = true
  }

  const stamp = (pulled: string[], sync: Record<string, SyncRow>, d: string) => pulled.includes(d) ? nowIso : sync[d]?.refreshed_at ?? null
  const pulls: HourlyReport['pulls'] = {}
  for (const d of zDates) {
    pulls[d] = { timeLogs: d <= today ? stamp(logs.pulled, logs.sync, d) : null, schedules: needsMigration.schedules ? null : stamp(sched.pulled, sched.sync, d) }
  }
  const pulling = [...logs.busy.filter(d => !logs.sync[d]?.refreshed_at), ...sched.busy.filter(d => !sched.sync[d]?.refreshed_at)].length > 0

  return {
    accountId, displayName: acc.displayName, date, tz, window: win, now,
    zohoAccounts: names.length ? names : [acc.displayName], zohoAccountsFromSetting: names.length > 0,
    matchedAccounts: [...matched.values()].sort((a, b) => a.localeCompare(b)),
    people, kpiHours, pulls, pulling, log, needsMigration,
  }
}
