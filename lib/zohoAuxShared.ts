// lib/zohoAuxShared.ts
// Zoho breaks & aux → an account's "Zoho Breaks & Aux" agent section.
// The PURE half (no I/O, no server-only imports, safe anywhere): which Zoho
// reports/fields to read, how their timestamps and names are parsed, how a
// break/aux row is classified, and who is on a break/aux right now. The fetching
// and caching half is lib/zohoAux.ts (server only).
//
// Ported from Workforce R.E.S.T. vCORE's pipeline (its "Zoho breaks & aux →
// the Adherence timeline" technical reference, checked against vCORE's source
// on 2026-10-22) so both apps read the SAME Zoho data the same way: the same
// two Creator apps and reports, timestamps parsed in each SOURCE app's own
// timezone and kept as UTC, names matched with the same normalizeName(), and
// the same Break / Lunch / everything-else-is-aux rule.
//
// One deliberate improvement over vCORE (its doc's §10.1): every Zoho session
// for a person on a date is kept, not just the first one with a login.
//
// One deliberate DIFFERENCE (per the user, 2026-10-23): vCORE scopes people to
// an account by name, against the account's roster. Here an account shows the
// people whose ACCOUNT in Zoho is this account (see "Which account a Zoho
// person is on" below), under their Zoho name — CRM agent names (Gorgias's
// "Ayla S", Five9 logins…) rarely equal a Zoho full name, so name matching
// found almost nobody.

// ── Where the data lives ──────────────────────────────────────────────────────
export interface ZohoAuxSource {
  key: 'primary' | 'honduras'
  app: string          // Zoho Creator app link name (owner: ececonsultinggroup)
  tz: string           // the timezone this app's wall-clock timestamps are in
  timelog: { report: string; dateField: string; login: string; logout: string }
  breaks:  { report: string; dateField: string; type: string }
}

export const ZOHO_AUX_SOURCES: ZohoAuxSource[] = [
  {
    key: 'primary', app: 'ece-time-tracker', tz: 'America/New_York',
    timelog: { report: 'Time_Log_Records_RTA', dateField: 'T_Date', login: 'Log_In', logout: 'Log_Out' },
    breaks:  { report: 'View_Break_Logs_All',  dateField: 'B_Date', type: 'Type' },
  },
  {
    key: 'honduras', app: 'ece-time-tracker-honduras', tz: 'America/Tegucigalpa',
    timelog: { report: 'Time_Logs_Report', dateField: 'Shift_Date', login: 'Login', logout: 'Logout' },
    breaks:  { report: 'Breaks_Report',    dateField: 'Shift_Date', type: 'Break_Type' },
  },
]

/** The table each enabled account's "Zoho Breaks & Aux" agent section reads. */
export const ZOHO_AUX_TABLE = 'wfm_zoho_agent_status'
export const ZOHO_AUX_SECTION_LABEL = 'Zoho Breaks & Aux'

// ── Per-account settings (lives in wfm_settings.data_source.zohoAux) ──────────
export interface ZohoAuxConfig {
  enabled: boolean
  includeBreaks?: boolean   // breaks & lunch — default true
  includeAux?: boolean      // every other aux (Chat, Meeting, Training, …) — default true
  // This account's name in Zoho (the Account on its people's Zoho records),
  // one or more, one per line — only when it isn't the same as the account's
  // display name here. Blank = the display name (and the account id).
  zohoAccounts?: string
  // Extra Zoho names to show whatever their Zoho account is, one per line —
  // someone who works this account but is filed under another one in Zoho.
  extraNames?: string
}

export const includeBreaksOf = (c?: ZohoAuxConfig | null) => c?.includeBreaks !== false
export const includeAuxOf    = (c?: ZohoAuxConfig | null) => c?.includeAux !== false

export function parseExtraNames(text: string | undefined | null): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const raw of String(text ?? '').split(/[\n,;]+/)) {
    const name = raw.trim()
    const key = normalizeName(name)
    if (name && !seen.has(key)) { seen.add(key); out.push(name) }
  }
  return out
}

// ── Names, Zoho lookups, dates ────────────────────────────────────────────────
/** vCORE's own matching rule — exact after this, no fuzzy matching. */
export const normalizeName = (s: string | null | undefined) =>
  (s ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')

/** A Zoho lookup arrives as a string OR an object ({ display_value, ID } …). Never "[object Object]". */
export function zohoDisplay(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    for (const k of ['display_value', 'zc_display_value', 'Name', 'name', 'value']) {
      const r = (v as Record<string, unknown>)[k]
      if (r != null && typeof r !== 'object' && String(r).trim()) return String(r).trim()
    }
    return ''
  }
  return String(v).trim()
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-23" → "23-Oct-2026", Zoho's criteria date format. */
export function zohoCriteriaDate(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return `${String(d).padStart(2, '0')}-${MON[m - 1]}-${y}`
}

function tzOffsetMs(at: Date, timeZone: string): number {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)) p[x.type] = x.value
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at.getTime()
}

/**
 * Zoho wall-clock text ("20 Oct 2026 13:00:00", "20-Oct-2026 13:00", date-only)
 * in `tz` → UTC ISO. null for blank/unparseable (e.g. an End not filled in yet).
 */
export function parseZohoDate(s: unknown, tz: string): string | null {
  const m = String(s ?? '').trim().match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[\s-]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  const mon = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase())
  if (mon < 0) return null
  const guess = Date.UTC(+m[3], mon, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  // Two passes, so a wall clock right next to a DST change still lands on the right offset.
  let utc = guess - tzOffsetMs(new Date(guess), tz)
  utc = guess - tzOffsetMs(new Date(utc), tz)
  return new Date(utc).toISOString()
}

/** The calendar date (YYYY-MM-DD) it is in `tz` at `ms`. */
export function dateInTz(ms: number, tz: string): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value
  return `${p.year}-${p.month}-${p.day}`
}

export function addDays(dateISO: string, n: number): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// ── Classifying a break/aux row ───────────────────────────────────────────────
/** vCORE's classifyBreak: Lactation first (an entitlement), then Lunch/Meal, then Break; anything else is an aux. */
export function classifyBreak(type: string): string {
  if (/lactation/i.test(type)) return type
  if (/lunch|meal/i.test(type)) return 'Lunch'
  if (/break/i.test(type)) return 'Break'
  return type
}

/** Which of this account's two include-toggles a row falls under. */
export function breakCategory(type: string): 'break' | 'aux' {
  const c = classifyBreak(type)
  return c === 'Break' || c === 'Lunch' ? 'break' : 'aux'
}

/** The allowance a break/lunch type names, in minutes: "15 Minute Break" → 15,
 *  "1 Hour Lunch" → 60. null when the name has none ("Lunch", "Chat"). Used to
 *  suggest Status Durations thresholds: warning at the allowance, critical one
 *  minute past it — vCORE's over-break line (allowance + 1 min grace). */
export function allowanceMinutesOf(type: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(type)
  if (!m) return null
  const n = parseFloat(m[1]) * (/^h/i.test(m[2]) ? 60 : 1)
  return n > 0 ? Math.round(n) : null
}

/** Every Zoho break/aux type in the logs, most used first — what Status Durations lists. */
export function zohoTypesSeen(breaks: ZohoBreak[]): { type: string; category: 'break' | 'aux'; count: number }[] {
  const by = new Map<string, number>()
  for (const b of breaks) { const t = (b.type || '').trim(); if (t) by.set(t, (by.get(t) ?? 0) + 1) }
  return [...by.entries()].map(([type, count]) => ({ type, category: breakCategory(type), count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

// ── Which account a Zoho person is on ─────────────────────────────────────────
// vCORE never reads an account off these reports (its doc §6), so its doc names
// no field for it. The field is therefore FOUND on the rows at pull time: the
// first of these that has values, else whichever other field with "account" in
// its name has the most (a manager/lead field never counts). The pull's log says
// which one was used — or, if none, which fields the rows do have.
export const ZOHO_ACCOUNT_FIELDS = [
  'Account', 'x_Account', 'Employee.Account', 'Employee.x_Account', 'AccountHR', 'Employee.AccountHR',
  'Account_Name', 'Employee.Account_Name', 'Accounts', 'Employee.Accounts',
]

/** A Zoho account value — text, a lookup ({ display_value }), or a multi-lookup array — as names. */
export function zohoAccountValues(v: unknown): string[] {
  if (Array.isArray(v)) return [...new Set(v.flatMap(zohoAccountValues))]
  const s = zohoDisplay(v)
  return s ? [s] : []
}

export function pickAccountField(rows: Record<string, unknown>[]): string | null {
  const filled = (k: string) => rows.reduce((n, r) => n + (zohoAccountValues(r[k]).length ? 1 : 0), 0)
  for (const k of ZOHO_ACCOUNT_FIELDS) if (filled(k) > 0) return k
  const others = [...new Set(rows.slice(0, 100).flatMap(r => Object.keys(r)))]
    .filter(k => /account/i.test(k) && !/manager|leader|supervisor|owner|lead\b/i.test(k) && !ZOHO_ACCOUNT_FIELDS.includes(k))
  let best: string | null = null, bestN = 0
  for (const k of others) { const n = filled(k); if (n > bestN) { best = k; bestN = n } }
  return best
}

/** Account names compared ignoring case, spaces and punctuation ("Guardian Bikes" = "guardianbikes"). */
export const normalizeAccount = (s: string | null | undefined) => normalizeName(s).replace(/[^a-z0-9]/g, '')

/** The names this account goes by in Zoho, normalized: its "Zoho account(s) to use" setting when set,
 *  else its display name here and its id. */
export function accountKeysFor(accountId: string, displayName: string | undefined, cfg: ZohoAuxConfig | undefined): string[] {
  const set = parseExtraNames(cfg?.zohoAccounts)
  const names = set.length ? set : [displayName || '', accountId]
  return [...new Set(names.map(normalizeAccount).filter(Boolean))]
}

/** Everyone in Zoho's logs on one of `accountKeys`: normalized name → their Zoho name. */
export function zohoPeopleOnAccount(sessions: ZohoSession[], breaks: ZohoBreak[], accountKeys: string[]): Map<string, string> {
  const keys = new Set(accountKeys), out = new Map<string, string>()
  for (const x of [...sessions, ...breaks]) {
    if (!x.employee || !(x.accounts ?? []).some(a => keys.has(normalizeAccount(a)))) continue
    const k = normalizeName(x.employee)
    if (k && !out.has(k)) out.set(k, x.employee)
  }
  return out
}

/** Every Zoho account in the logs, with how many people are on it — for the Settings panel. */
export function zohoAccountsSeen(sessions: ZohoSession[], breaks: ZohoBreak[]): { name: string; people: number }[] {
  const by = new Map<string, { name: string; people: Set<string> }>()
  for (const x of [...sessions, ...breaks]) {
    for (const a of x.accounts ?? []) {
      const k = normalizeAccount(a)
      if (!k) continue
      if (!by.has(k)) by.set(k, { name: a, people: new Set() })
      by.get(k)!.people.add(normalizeName(x.employee))
    }
  }
  return [...by.values()].map(v => ({ name: v.name, people: v.people.size })).sort((a, b) => a.name.localeCompare(b.name))
}

// ── Parsed rows (what the cache holds) ────────────────────────────────────────
// `accounts`: the person's Zoho account(s) on that row — see above. Absent on
// rows cached before 2026-10-23 (they're re-pulled within minutes).
export interface ZohoSession { employee: string; login: string | null; logout: string | null; source: string; accounts?: string[] }
export interface ZohoBreak   { employee: string; start: string | null; end: string | null; type: string; source: string; accounts?: string[] }

export function parseSessionRow(r: Record<string, unknown>, s: ZohoAuxSource, accountField: string | null = null): ZohoSession {
  return {
    employee: zohoDisplay(r.Employee),
    login:  parseZohoDate(r[s.timelog.login], s.tz),
    logout: parseZohoDate(r[s.timelog.logout], s.tz),
    source: s.key,
    accounts: accountField ? zohoAccountValues(r[accountField]) : [],
  }
}

export function parseBreakRow(r: Record<string, unknown>, s: ZohoAuxSource, accountField: string | null = null): ZohoBreak {
  return {
    employee: zohoDisplay(r.Employee),
    start: parseZohoDate(r.Start, s.tz),
    end:   parseZohoDate(r.End, s.tz),
    type:  String(r[s.breaks.type] ?? '').trim() || 'Break',   // blank Type is a plain Break, as in vCORE
    source: s.key,
    accounts: accountField ? zohoAccountValues(r[accountField]) : [],
  }
}

// ── Who is on a break/aux RIGHT NOW ───────────────────────────────────────────
export interface CurrentAux {
  employee: string        // Zoho's own display name
  employeeNorm: string
  type: string            // the Zoho Type as logged ("15 Minute Break", "Chat", …)
  category: 'break' | 'aux'
  since: string           // UTC ISO — when this break/aux started
  source: string
}

// A session still open after this long is a forgotten logout, not a shift.
const MAX_OPEN_SESSION_HOURS = 18
// A break may be stamped a moment before its session's own login.
const START_TOLERANCE_MS = 2 * 60 * 1000

/**
 * Someone is on a break/aux only while they are LOGGED IN (a session with a
 * login and no logout) AND have a break/aux with no End that started inside
 * that session. Both conditions matter: Zoho holds hundreds of rows a week
 * whose End was never filled in, and without the session check every one of
 * those forgotten breaks would show as "on break" for days.
 * Pass the sessions/breaks of today AND yesterday so overnight shifts work.
 */
export function computeCurrentAux(sessions: ZohoSession[], breaks: ZohoBreak[], nowMs: number): Map<string, CurrentAux> {
  const openSince = new Map<string, number>()   // employeeNorm -> latest open-session login
  for (const s of sessions) {
    if (!s.login || s.logout) continue
    const login = Date.parse(s.login)
    if (!Number.isFinite(login) || login > nowMs || nowMs - login > MAX_OPEN_SESSION_HOURS * 3600e3) continue
    const k = normalizeName(s.employee)
    if (!k) continue
    if (!openSince.has(k) || login > (openSince.get(k) as number)) openSince.set(k, login)
  }

  const out = new Map<string, CurrentAux>()
  for (const b of breaks) {
    if (!b.start || b.end) continue
    const k = normalizeName(b.employee)
    const sessionStart = openSince.get(k)
    if (sessionStart === undefined) continue
    const start = Date.parse(b.start)
    if (!Number.isFinite(start) || start > nowMs || start < sessionStart - START_TOLERANCE_MS) continue
    const prev = out.get(k)
    if (prev && Date.parse(prev.since) >= start) continue   // the most recent open one wins
    out.set(k, { employee: b.employee, employeeNorm: k, type: b.type, category: breakCategory(b.type), since: b.start, source: b.source })
  }
  return out
}

// ── One account's rows ────────────────────────────────────────────────────────
export interface ZohoAgentStatusRow {
  id: string; account_id: string; agent_name: string; zoho_name: string
  status: string; category: string; since: string; source: string; updated_at: string
}

/**
 * The rows for one account: everyone in `names` (its people in Zoho, plus its
 * extra names) who is on a break/aux right now, of a kind this account shows —
 * listed under their ZOHO name (per the user, 2026-10-23: the Zoho name only).
 */
export function buildAccountStatusRows(
  accountId: string, names: string[], current: Map<string, CurrentAux>,
  cfg: ZohoAuxConfig, nowIso: string,
): ZohoAgentStatusRow[] {
  const wantBreaks = includeBreaksOf(cfg), wantAux = includeAuxOf(cfg)
  const seen = new Set<string>(), rows: ZohoAgentStatusRow[] = []
  for (const name of names) {
    const k = normalizeName(name)
    if (!k || seen.has(k)) continue
    seen.add(k)
    const c = current.get(k)
    if (!c) continue
    if (c.category === 'break' ? !wantBreaks : !wantAux) continue
    rows.push({
      id: `${accountId}:${k}`, account_id: accountId, agent_name: c.employee, zoho_name: c.employee,
      status: c.type, category: c.category, since: c.since, source: c.source, updated_at: nowIso,
    })
  }
  return rows
}
