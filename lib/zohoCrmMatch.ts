// lib/zohoCrmMatch.ts
// Zoho ↔ CRM status match (Settings → Zoho ↔ CRM, per the user 2026-11-04): an
// agent whose CRM status doesn't mean the same as their Zoho Time Tracker status
// (e.g. "Management" in the CRM while on a Zoho "15 Minute Break") is a breach.
// Names and status titles differ between the two systems ("John C." vs "John
// Cane", "Taking a Break" vs "15 Minute Break"), so both are matched by hand in
// Settings: which Zoho person is which CRM agent (`pairs`), and which CRM values
// mean the same as each Zoho status (`sameAs`).
//
// The PURE half (no I/O — safe in the browser and on the server). Who is
// mismatched is worked out every minute by the Zoho sync (lib/zohoAux.ts), which
// already has everyone's current Zoho status, and stored with WHEN it started
// (wfm_zoho_crm_mismatch, sql/zoho_crm_match.sql) — the CRM rows of the accounts
// using Zoho today (Gorgias: "Online"/"Offline" + a ticket count) carry no time
// in status, so a mismatch can only be timed by remembering when it was first
// seen. lib/breaches.ts's buildBreaches() then turns those rows into Warning /
// Critical breaches with this account's minutes — the ONE place that decides,
// for the dashboard and the Cliq scan alike.

import { normalizeName, includeLoggedInOf } from './zohoAuxShared'
import type { DataSourceConfig } from './types'

// ── Per-account settings (lives in wfm_settings.data_source.zohoCrmMatch) ────────
export interface ZohoCrmPair { zoho: string; crm: string }

export interface ZohoCrmMatchConfig {
  enabled: boolean
  // What the CRM side is compared on: unset/'' = each agent's status (the Agent
  // Status column); else an AgentExtraColumn key — e.g. Gorgias's availability
  // column, which is where "Lunch break" / "15 minute break" show.
  crmField?: string
  // Which Zoho person is which CRM agent (by name, case and spacing ignored).
  // One Zoho person per CRM agent; a Zoho person may be paired with several
  // CRM agents (two CRM logins).
  pairs: ZohoCrmPair[]
  // Zoho status ("Logged In", a Zoho type, or ZOHO_NOT_LOGGED_IN_STATUS) → the
  // CRM values that mean the same. A Zoho status with none ticked isn't checked.
  sameAs: Record<string, string[]>
  // Also check paired agents who are on the CRM but not logged in to Zoho, as
  // the Zoho status ZOHO_NOT_LOGGED_IN_STATUS. Default off (per the user).
  checkNotInZoho?: boolean
  warnMins?: number     // default 5
  critMins?: number     // default 10
  sendToCliq?: boolean  // default off (per the user)
}

export const ZOHO_NOT_LOGGED_IN_STATUS = 'Not logged in to Zoho'
export const ZOHO_CRM_MISMATCH_TABLE = 'wfm_zoho_crm_mismatch'
/** The breach's Metric — constant, so RTA Logs / the alarm group every mismatch as one breach type. */
export const ZOHO_CRM_MISMATCH_METRIC = 'Zoho / CRM Mismatch'
export const DEFAULT_MISMATCH_WARN_MINS = 5
export const DEFAULT_MISMATCH_CRIT_MINS = 10
/** Zoho data older than this pauses the check (Zoho is pulled every 5 min): otherwise a broken pull would flag everyone. */
export const ZOHO_MATCH_MAX_ZOHO_AGE_MIN = 15
/** A stored mismatch the sync hasn't re-confirmed for this long is ignored (it runs every minute). */
export const MISMATCH_ROW_MAX_AGE_MS = 5 * 60 * 1000

export function emptyZohoCrmMatch(): ZohoCrmMatchConfig {
  return { enabled: false, pairs: [], sameAs: {}, checkNotInZoho: false, warnMins: DEFAULT_MISMATCH_WARN_MINS, critMins: DEFAULT_MISMATCH_CRIT_MINS, sendToCliq: false }
}

/** The tab is usable only while the account has Zoho Breaks & Aux on WITH its time log ("Logged In") — per the user. */
export function zohoCrmMatchAvailable(ds: DataSourceConfig | null | undefined): boolean {
  return !!ds?.zohoAux?.enabled && includeLoggedInOf(ds.zohoAux)
}

/** The check runs (and its rows become breaches) only while available, switched on, and with at least one pair. */
export function zohoCrmMatchActive(ds: DataSourceConfig | null | undefined): boolean {
  const c = ds?.zohoCrmMatch
  return zohoCrmMatchAvailable(ds) && !!c?.enabled && (c.pairs?.length ?? 0) > 0
}

const minsOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
export const mismatchWarnMins = (c?: ZohoCrmMatchConfig | null) => minsOr(c?.warnMins, DEFAULT_MISMATCH_WARN_MINS)
export const mismatchCritMins = (c?: ZohoCrmMatchConfig | null) => minsOr(c?.critMins, DEFAULT_MISMATCH_CRIT_MINS)

/** Status values compared ignoring case and spacing ("Taking a break" = "Taking a Break"). */
export const statusKey = (s: unknown) => String(s ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')

/** One normalized agent row's CRM value for the comparison (normalizeAgentRow's _status / _extra_<key>). */
export function crmValueOf(agent: Record<string, any>, cfg: Pick<ZohoCrmMatchConfig, 'crmField'> | null | undefined): string {
  return String((cfg?.crmField ? agent[`_extra_${cfg.crmField}`] : agent._status) ?? '').trim()
}

// ── Who is mismatched right now ─────────────────────────────────────────────────
/** Everyone's current Zoho status, by normalizeName(their Zoho name). Absent = not logged in to Zoho. */
export type ZohoNow = Map<string, { name: string; status: string }>

export interface ZohoCrmMismatch {
  crmName: string
  zohoName: string
  crmStatus: string     // several CRM rows for the same agent (two sections) are joined with " / "
  zohoStatus: string
  crmGroup: string
}

/**
 * Every paired agent whose CRM value isn't one of the values ticked for their
 * current Zoho status. Not checked: an agent not on the CRM tables right now (or
 * with a blank value), a Zoho status with nothing ticked, and — unless
 * checkNotInZoho — someone not logged in to Zoho. An agent on several CRM rows
 * is fine if ANY of them matches.
 */
export function findZohoCrmMismatches(cfg: ZohoCrmMatchConfig, crmAgents: Record<string, any>[], zohoNow: ZohoNow): ZohoCrmMismatch[] {
  const byCrm = new Map<string, Record<string, any>[]>()
  for (const a of crmAgents) {
    const k = normalizeName(a._name)
    if (!k) continue
    const list = byCrm.get(k)
    if (list) list.push(a); else byCrm.set(k, [a])
  }
  const sameAs = new Map(Object.entries(cfg.sameAs ?? {}).map(([z, list]) => [statusKey(z), new Set((list ?? []).map(statusKey))]))

  const out: ZohoCrmMismatch[] = []
  const done = new Set<string>()
  for (const p of cfg.pairs ?? []) {
    const ck = normalizeName(p.crm), zk = normalizeName(p.zoho)
    if (!ck || !zk || done.has(ck)) continue
    done.add(ck)   // one Zoho person per CRM agent — the first pair wins
    const rows = (byCrm.get(ck) ?? []).filter(a => crmValueOf(a, cfg) !== '')
    if (!rows.length) continue
    const z = zohoNow.get(zk)
    const zohoStatus = z ? z.status : cfg.checkNotInZoho ? ZOHO_NOT_LOGGED_IN_STATUS : ''
    if (!zohoStatus) continue
    const allowed = sameAs.get(statusKey(zohoStatus))
    if (!allowed || allowed.size === 0) continue
    if (rows.some(a => allowed.has(statusKey(crmValueOf(a, cfg))))) continue
    out.push({
      crmName: String(rows[0]._name ?? '').trim(),
      zohoName: z?.name || p.zoho.trim(),
      crmStatus: [...new Set(rows.map(a => crmValueOf(a, cfg)))].join(' / '),
      zohoStatus,
      crmGroup: String(rows[0]._agentGroup ?? ''),
    })
  }
  return out
}

// ── What the sync stores (wfm_zoho_crm_mismatch) ────────────────────────────────
export interface ZohoCrmMismatchRow {
  id: string            // "{account_id}:{normalized CRM name}"
  account_id: string
  crm_name: string
  zoho_name: string
  crm_status: string
  zoho_status: string
  crm_group: string
  since: string         // when this agent was first seen out of sync (kept while they stay out of sync)
  checked_at: string    // the last sync that confirmed it
}

export const mismatchRowId = (accountId: string, crmName: string) => `${accountId}:${normalizeName(crmName)}`

/**
 * The rows to store after one check: `since` is kept for an agent who was
 * already out of sync at the last check (even if one side's status changed in
 * between — they've been out of sync all along), and starts now for anyone new
 * or whose previous row is older than MISMATCH_ROW_MAX_AGE_MS (the check was
 * paused or not running, so "all along" isn't known).
 */
export function nextMismatchRows(accountId: string, found: ZohoCrmMismatch[], existing: ZohoCrmMismatchRow[], nowIso: string): ZohoCrmMismatchRow[] {
  const prev = new Map(existing.map(r => [r.id, r]))
  const now = Date.parse(nowIso)
  const rows = new Map<string, ZohoCrmMismatchRow>()
  for (const m of found) {
    const id = mismatchRowId(accountId, m.crmName)
    if (rows.has(id)) continue
    const old = prev.get(id)
    const ongoing = !!old && now - Date.parse(old.checked_at) <= MISMATCH_ROW_MAX_AGE_MS && Date.parse(old.since) <= now
    rows.set(id, {
      id, account_id: accountId, crm_name: m.crmName, zoho_name: m.zohoName,
      crm_status: m.crmStatus, zoho_status: m.zohoStatus, crm_group: m.crmGroup,
      since: ongoing ? old!.since : nowIso, checked_at: nowIso,
    })
  }
  return [...rows.values()]
}

/** What Settings → Zoho ↔ CRM gets from /api/zoho/crm-match (lib/zohoAux.ts's getZohoCrmMatchInfo). */
export interface ZohoCrmMatchInfo {
  pullMinutes: number
  lastPull: string | null
  /** The account's Zoho people (+ extra names), with their Zoho status now — null = not logged in. */
  people: { name: string; status: string | null; since: string | null }[]
  /** Zoho types this account's people used in the last two days, most used first. */
  accountTypes: string[]
  /** Every Zoho type in the last two days, organisation-wide. */
  zohoTypes: { type: string; category: 'break' | 'aux'; count: number }[]
  /** What the check last stored for the account; null when its table doesn't exist yet. */
  mismatches: ZohoCrmMismatchRow[] | null
  needsMigration: boolean
}

/** A stored row the sync confirmed recently enough to trust. */
export function mismatchRowFresh(r: Pick<ZohoCrmMismatchRow, 'checked_at' | 'since'>, nowMs: number): boolean {
  const checked = Date.parse(r.checked_at), since = Date.parse(r.since)
  return Number.isFinite(checked) && Number.isFinite(since) && nowMs - checked <= MISMATCH_ROW_MAX_AGE_MS
}

// ── Suggested name pairs ────────────────────────────────────────────────────────
// CRM names are usually a short form of the Zoho full name: "Jade D" for "Jade
// Juben Enojo Dagooc", "Ann Basilio" for "Kenneth Ann Leonor Basilio", "John C."
// for "John Cane". Only SUGGESTED — Settings shows them to accept or ignore.
const nameTokens = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

/** How well the shorter name `s` fits inside `l` (0 = not at all): its last word is
 *  l's last word (the surname, or its initial), its other words appear in order
 *  among l's other words (an initial counts), and at least one is a whole word. */
function fits(s: string[], l: string[]): number {
  if (!s.length || s.length > l.length) return 0
  const tok = (x: string, y: string) => (x.length === 1 ? y.startsWith(x) : x === y)
  if (s.length === 1) return s[0].length > 1 && s[0] === l[0] ? 1 : 0   // a first name alone: weak
  if (!tok(s[s.length - 1], l[l.length - 1])) return 0
  let j = 0
  for (let i = 0; i < s.length - 1; i++) {
    while (j < l.length - 1 && !tok(s[i], l[j])) j++
    if (j >= l.length - 1) return 0
    j++
  }
  const whole = s.filter(t => t.length > 1).length
  return whole ? 1 + whole : 0
}

export function nameMatchScore(crm: string, zoho: string): number {
  const c = nameTokens(crm), z = nameTokens(zoho)
  if (!c.length || !z.length) return 0
  if (c.join(' ') === z.join(' ')) return 100
  return Math.max(fits(c, z), fits(z, c))
}

/** One suggestion per CRM agent not paired yet: the Zoho person (not paired yet)
 *  who fits it best — only when that's the only best fit both ways round. */
export function suggestZohoCrmPairs(zohoNames: string[], crmNames: string[], pairs: ZohoCrmPair[]): ZohoCrmPair[] {
  const pairedCrm = new Set(pairs.map(p => normalizeName(p.crm)))
  const pairedZoho = new Set(pairs.map(p => normalizeName(p.zoho)))
  const uniq = (names: string[], taken: Set<string>) =>
    [...new Map(names.map(n => [normalizeName(n), n.trim()] as const).filter(([k]) => k && !taken.has(k))).values()]
  const zs = uniq(zohoNames, pairedZoho), cs = uniq(crmNames, pairedCrm)
  const score = cs.map(c => zs.map(z => nameMatchScore(c, z)))
  const out: ZohoCrmPair[] = []
  cs.forEach((c, i) => {
    const best = Math.max(0, ...score[i])
    if (!best) return
    const js = score[i].flatMap((s, j) => (s === best ? [j] : []))
    if (js.length !== 1) return
    const j = js[0]
    const others = cs.map((_, k) => score[k][j])
    if (others.filter(s => s === best).length !== 1 || Math.max(...others) !== best) return
    out.push({ zoho: zs[j], crm: c })
  })
  return out
}
