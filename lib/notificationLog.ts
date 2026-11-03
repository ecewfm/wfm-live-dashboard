// lib/notificationLog.ts
// SERVER ONLY. The record behind the Loggings page: every Zoho Cliq message
// and every Workforce RTA Logs submission this app makes, sent or failed, as
// one plain-English line plus the detail (sql/notification_log.sql).
//
// Writes go through the service-role client because the table is RLS-locked
// (it holds every account's breach details). A write that fails — table not
// migrated yet, Supabase down — is logged to the server console and dropped:
// a log row must never stop a notification from going out.

import { getSupabaseAdmin } from './supabaseAdmin'
import { breachExtraFields, type BreachRow, type RtaKpiSignal } from './breaches'

export type NotificationKind = 'cliq' | 'rta_log'
export type NotificationStatus = 'sent' | 'failed'
/** auto = the every-minute scan; force = "Force Scan Now"; test = a Settings test button. */
export type NotificationSource = 'auto' | 'force' | 'test'

export interface NotificationEntry {
  kind: NotificationKind
  accountId: string
  status: NotificationStatus
  source: NotificationSource
  summary: string
  breachCount?: number | null
  error?: string | null
  details?: Record<string, unknown>
}

export interface NotificationLogRow {
  id: number
  created_at: string
  kind: NotificationKind
  account_id: string
  status: NotificationStatus
  source: NotificationSource
  summary: string
  breach_count: number | null
  error: string | null
  details: Record<string, any>
}

const TABLE = 'wfm_notification_log'
export const LOG_RETENTION_DAYS = 90

// One console warning per distinct error per server instance — the cause (an
// unmigrated table) doesn't change from one send to the next.
const warned = new Set<string>()
function warnOnce(msg: string) {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(`[notificationLog] ${msg}`)
}

export async function recordNotification(e: NotificationEntry): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from(TABLE).insert({
      kind: e.kind,
      account_id: e.accountId,
      status: e.status,
      source: e.source,
      summary: e.summary.slice(0, 1000),
      breach_count: e.breachCount ?? null,
      error: e.error ? e.error.slice(0, 2000) : null,
      details: e.details ?? {},
    })
    if (error) throw new Error(error.message)
  } catch (err: any) {
    warnOnce(`couldn't write the Loggings row (has sql/notification_log.sql been run?) — ${err?.message || err}`)
  }
}

// Deletes rows older than LOG_RETENTION_DAYS — at most once an hour per
// server instance, called at the end of every scan.
let lastPruneAt = 0
export async function pruneNotificationLog(): Promise<void> {
  if (Date.now() - lastPruneAt < 60 * 60 * 1000) return
  lastPruneAt = Date.now()
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await getSupabaseAdmin().from(TABLE).delete().lt('created_at', cutoff)
    if (error) throw new Error(error.message)
  } catch (err: any) {
    warnOnce(`couldn't prune old Loggings rows — ${err?.message || err}`)
  }
}

// ── The plain-English bits ──────────────────────────────────────────────────
type BreachLike = Pick<BreachRow, 'entity' | 'metric' | 'value' | 'threshold'> & {
  severity?: BreachRow['severity'] | null; kind?: BreachRow['kind']; extras?: BreachRow['extras']
}

/** "Email SLA — Open tickets: 46 (critical) · Ayla S — Lunch Duration: 45m · +2 more" */
export function briefBreaches(rows: BreachLike[], max = 3): string {
  const one = (b: BreachLike) => `${b.entity} — ${b.metric}: ${b.value}${b.severity === 'critical' ? ' (critical)' : ''}`
  const shown = rows.slice(0, max).map(one)
  if (rows.length > max) shown.push(`+${rows.length - max} more`)
  return shown.join(' · ')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(ch|sh|s|x)$/.test(word) ? 'es' : 's'}`

export function cliqSummary(channel: string, breaches: BreachRow[]): string {
  return `#${channel} — ${plural(breaches.length, 'breach')}: ${briefBreaches(breaches)}`
}

export function rtaSummary(category: string, subCategory: string, what: string): string {
  return `${category} / ${subCategory} — ${what}`
}

/** A heartbeat reading in the same shape: "Email SLA — SLA %: 91% (current value)". */
export const signalAsRow = (s: RtaKpiSignal): BreachLike => ({
  entity: s.entity, metric: s.metric, value: s.severity ? s.value : `${s.value} (current value)`, threshold: s.threshold, severity: s.severity,
})

/** An RTA Log's contents: "3 items: <breaches and readings>". */
export function briefRta(breaches: BreachRow[], readings: RtaKpiSignal[], max = 3): string {
  const rows = [...breaches, ...readings.map(signalAsRow)]
  return `${plural(rows.length, 'item')}: ${briefBreaches(rows, max)}`
}

/** The first sentence of an AI-written remark, for the one-line view. */
export function firstSentence(text: string, max = 180): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const cut = t.match(/^(.+?[.!?])(\s|$)/)?.[1] || t
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut
}

/** What each breach was, for the detail view (capped — a long agent list is rare but possible).
 *  `cols` = the Breach / Anomalies columns the Cliq message carried (breachTableExtraCols). */
export function breachDetails(rows: BreachLike[], cols: { key: string; label: string }[] = []) {
  return rows.slice(0, 60).map(b => {
    const fields = breachExtraFields(b, cols)
    return { entity: b.entity, metric: b.metric, value: b.value, threshold: b.threshold, severity: b.severity ?? null, ...(fields.length ? { fields } : {}) }
  })
}

// ── Reading (the /api/logs route) ───────────────────────────────────────────
export interface LogQuery {
  kind?: NotificationKind
  accountId?: string
  status?: NotificationStatus
  sinceIso?: string
  /** Matched against the summary, account id, error, Cliq channel and category / sub-category. */
  search?: string
  /** Accounts whose display name matched `search` — display names live in the browser, not here. */
  searchAccountIds?: string[]
  /** The newest row id of the view's first page: later pages read only rows up to
   *  it, so entries logged meanwhile don't shift them. */
  upToId?: number
  offset: number
  limit: number
  /** Also count every matching row (the page count) — the first page of a view. */
  withTotal?: boolean
}

export class LogTableMissing extends Error {}
const isMissingTable = (msg: string) => /does not exist|could not find the table|schema cache/i.test(msg)

const SEARCH_COLUMNS = ['summary', 'account_id', 'error', 'details->>channel', 'details->>category', 'details->>subCategory']
// PostgREST or-filter value, quoted so commas / brackets in a search can't break it.
const pgQuote = (s: string) => `"${s.replace(/[\\"]/g, m => `\\${m}`)}"`

export async function listNotifications(q: LogQuery): Promise<{ rows: NotificationLogRow[]; total: number | null }> {
  let query = getSupabaseAdmin().from(TABLE)
    .select('id, created_at, kind, account_id, status, source, summary, breach_count, error, details', q.withTotal ? { count: 'exact' } : undefined)
    .order('id', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1)
  if (q.kind) query = query.eq('kind', q.kind)
  if (q.accountId) query = query.eq('account_id', q.accountId)
  if (q.status) query = query.eq('status', q.status)
  if (q.sinceIso) query = query.gte('created_at', q.sinceIso)
  if (q.upToId) query = query.lte('id', q.upToId)
  if (q.search) {
    const like = pgQuote(`%${q.search}%`)
    const ors = SEARCH_COLUMNS.map(c => `${c}.ilike.${like}`)
    if (q.searchAccountIds?.length) ors.push(`account_id.in.(${q.searchAccountIds.map(pgQuote).join(',')})`)
    query = query.or(ors.join(','))
  }
  const { data, error, count } = await query
  // PGRST103 = a page past the end (the rows it counted have since been pruned).
  if (error?.code === 'PGRST103') return { rows: [], total: null }
  if (error) throw isMissingTable(error.message) ? new LogTableMissing(error.message) : new Error(error.message)
  return { rows: (data ?? []) as NotificationLogRow[], total: q.withTotal ? count ?? 0 : null }
}

/** The Loggings page's "last 24 hours" counts, across every account. */
export async function notificationCounts(sinceIso: string): Promise<{ cliqSent: number; rtaSent: number; failed: number }> {
  const count = async (apply: (b: any) => any) => {
    const { count: n, error } = await apply(getSupabaseAdmin().from(TABLE).select('id', { count: 'exact', head: true }).gte('created_at', sinceIso))
    if (error) throw isMissingTable(error.message) ? new LogTableMissing(error.message) : new Error(error.message)
    return n ?? 0
  }
  const [cliqSent, rtaSent, failed] = await Promise.all([
    count(b => b.eq('kind', 'cliq').eq('status', 'sent')),
    count(b => b.eq('kind', 'rta_log').eq('status', 'sent')),
    count(b => b.eq('status', 'failed')),
  ])
  return { cliqSent, rtaSent, failed }
}
