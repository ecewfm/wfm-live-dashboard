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

import { getZohoAccessToken } from './zohoAuth'
import { getSupabaseAdmin } from './supabaseAdmin'
import { OWNER_NAME } from './zohoCreator'
import type { DataSourceConfig } from './types'
import { agentSourcesFor, normalizeAgentRow, mostRecentUpdatedAt } from './breaches'
import {
  ZOHO_AUX_SOURCES, ZOHO_AUX_TABLE, zohoCriteriaDate, parseSessionRow, parseBreakRow,
  normalizeName, dateInTz, addDays, computeCurrentAux, buildAccountStatusRows, parseExtraNames,
  pickAccountField, accountKeysFor, zohoPeopleOnAccount, zohoAccountsSeen, zohoTypesSeen, includeLoggedInOf,
  type ZohoSession, type ZohoBreak, type ZohoAgentStatusRow, type CurrentAux, type ZohoAuxConfig,
} from './zohoAuxShared'
import {
  ZOHO_CRM_MISMATCH_TABLE, ZOHO_MATCH_MAX_ZOHO_AGE_MIN, zohoCrmMatchActive, findZohoCrmMismatches, nextMismatchRows,
  type ZohoCrmMismatchRow, type ZohoNow, type ZohoCrmMatchInfo,
} from './zohoCrmMatch'

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
    const sessions = tl.rows.map(r => parseSessionRow(r, s, tlField)).filter(x => x.employee)
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
    l(`Zoho ${s.key} ${date}: ${sessions.length} time log(s), ${breaks.length} break/aux row(s).`)
    notes.push(`${s.key}: ${sessions.length} logs / ${breaks.length} breaks / account field ${tlField || blField || 'NONE'}`)
  }
  if (anyOk) await store.markSynced(date, nowIso, notes.join('; '))
  return anyOk
}

// ── The whole run ─────────────────────────────────────────────────────────────
export interface AuxSyncResult {
  log: string[]
  pulled: string[]
  // per enabled account: which Zoho account name(s) it was matched on, how many
  // people Zoho has on it, and how many of them (plus extra names) are on a
  // break/aux now, and logged in on none (shown as Logged In); and, with the
  // Zoho ↔ CRM check on, how many of its agents are out of sync
  accounts: { id: string; zohoAccounts: string[]; people: number; extraNames: number; onBreakOrAux: number; loggedIn: number; mismatches?: number }[]
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
  // Same for the Zoho ↔ CRM check (its rows are ignored while it's off anyway).
  // Only worth a log line when some account uses it — before then the table may
  // not even exist yet.
  const matching = enabled.filter(a => zohoCrmMatchActive(a.ds))
  try { await store.clearMismatchesExcept(matching.map(a => a.id)) } catch (e) {
    if (matching.length) l(`Zoho ↔ CRM: ${isMissingTable(e) ? `its table is missing — ${MISMATCH_TABLE_HINT}` : e instanceof Error ? e.message : String(e)}`)
  }
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
  const seen = zohoAccountsSeen(sessions, breaks)
  const displayNames = await store.accountNames()
  // How old the Zoho data behind `current` is — the Zoho ↔ CRM check pauses past ZOHO_MATCH_MAX_ZOHO_AGE_MIN.
  const zohoAgeMin = pulled.includes(today) ? 0 : age(today) / 60000
  const zohoNow = zohoNowOf(current)

  const accounts: AuxSyncResult['accounts'] = []
  for (const a of enabled) {
    try {
      const cfg = a.ds.zohoAux!
      // Matched on its "Zoho account(s) to use" setting, else its display name here (and id).
      const keys = accountKeysFor(a.id, displayNames[a.id], cfg)
      const asked = parseExtraNames(cfg.zohoAccounts)
      const label = (asked.length ? asked : [displayNames[a.id] || a.id]).map(n => `"${n}"`).join(' / ')
      const people = zohoPeopleOnAccount(sessions, breaks, keys)
      const extra = parseExtraNames(cfg.extraNames)
      const rows = buildAccountStatusRows(a.id, [...people.values(), ...extra], current, cfg, nowIso)
      await store.replaceAccountRows(a.id, rows)
      const loggedIn = rows.filter(r => r.category === 'login').length, onBreakOrAux = rows.length - loggedIn
      const entry: AuxSyncResult['accounts'][number] = { id: a.id, zohoAccounts: asked.length ? asked : [displayNames[a.id] || a.id], people: people.size, extraNames: extra.length, onBreakOrAux, loggedIn }
      accounts.push(entry)
      let line = `${a.id}: Zoho account ${label} — ${people.size} ${people.size === 1 ? 'person' : 'people'} in Zoho's logs${extra.length ? ` (+${extra.length} extra name(s))` : ''}, ${onBreakOrAux} on a break/aux now${includeLoggedInOf(cfg) ? `, ${loggedIn} logged in on none` : ''}`
      if (!people.size) {
        line += seen.length
          ? `. No one in Zoho's logs is on that account — if Zoho calls it something else, pick it under "Zoho account(s) to use" in Settings → Zoho Integrations. Zoho accounts seen: ${seen.slice(0, 40).map(x => x.name).join(', ')}${seen.length > 40 ? `, … (${seen.length} in all)` : ''}`
          : `. Zoho's cached logs carry no account at all yet (see the pull lines above).`
      }
      l(line)
      // Compared against EVERYONE's current Zoho status (`current`), not just the
      // rows this account shows — its include-toggles are about what Agent Status
      // lists, and a pair can name someone filed under another Zoho account.
      if (zohoCrmMatchActive(a.ds)) {
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
// it — what the "Zoho account(s) to use" picker suggests, and how the panel shows
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
// sql/zoho_crm_match.sql hasn't been run yet).
export async function getZohoCrmMatchInfo(
  accountId: string, cfg: Pick<ZohoAuxConfig, 'zohoAccounts' | 'extraNames'>, store: AuxStore = supabaseAuxStore(),
): Promise<ZohoCrmMatchInfo> {
  const now = Date.now()
  const today = dateInTz(now, PRIMARY_TZ), yesterday = addDays(today, -1)
  const [names, sync, cache] = await Promise.all([store.accountNames(), store.getSync([today]), store.readCache([yesterday, today])])
  const current = computeCurrentAux(cache.sessions, cache.breaks, now)
  const onAccount = zohoPeopleOnAccount(cache.sessions, cache.breaks, accountKeysFor(accountId, names[accountId], cfg as ZohoAuxConfig))
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
