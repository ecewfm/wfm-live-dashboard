// lib/zohoWorkforce.ts
// Accounts with no CRM in WFM Live, run from Zoho alone (per the user,
// 2026-11-09 — the Hermes idea "WFM Live & REST Adherence Alert"): their KPI
// card is worked out from Zoho's Daily Schedules and the Time Tracker logs, and
// their Agent Status is the Zoho Breaks & Aux section plus who is scheduled but
// not logged in.
//
// The PURE half (no I/O): which shifts are "today", how one shift is judged
// (time attended, late, no-show, adherence), an account's tiles, who is
// scheduled right now but not logged in, and the settings a Zoho-only account
// is created with. Every minute, lib/zohoAux.ts (runZohoAuxSync) runs these and
// writes the tiles to wfm_zoho_kpis; scanning Zoho for accounts and adding them
// is lib/zohoOnlyAccounts.ts.
//
// Adherence follows vCORE's computeAdherence (its "Zoho Daily Schedules and
// Time Logs" reference, §11) as far as Zoho alone allows. Zoho's schedule has
// the shift, not vCORE's planned breaks, so:
//   - scheduled but not logged in (pieces over 60 s) is a violation — vCORE's V2;
//   - a break or lunch running past the allowance in its name ("15 Minute
//     Break") by more than 60 s: the part past the allowance is a violation —
//     vCORE's over-break line, standing in for its V1/V3, which need the plan;
//   - aux isn't judged — on many accounts it's the work itself (Earnin's and
//     Flex's people sit in Chat, Email, Phones, Special Task…), and without the
//     plan a planned one can't be told from an unplanned one.
// As in vCORE, adherence is only for people who worked; a no-show counts in
// Absenteeism instead. A shift whose day has a leave in the time log's Note
// ("[VL in Hours][8]" — vCORE's leave marker) and no login is leave, not a
// no-show: it's left out of every tile. vCORE also reads an approved-leaves
// report; this doesn't (one more Zoho pull), so a leave only in that report
// still counts as a no-show.

import {
  normalizeName, normalizeAccount, allowanceMinutesOf, breakCategory, zohoAccountsSeen, MAX_OPEN_SESSION_HOURS,
  ZOHO_MISSING_STATUS, ZOHO_LEFT_EARLY_STATUS,
  type ZohoSession, type ZohoBreak, type CurrentAux,
} from './zohoAuxShared'
import { pctText, type ScheduleCacheRow } from './hourlyReport'
import { DEFAULT_DATA_SOURCE, KPI_INFO_THRESHOLD, type StatusThresholds } from './utils'
import type { DataSourceConfig, DashboardLayout, KpiGroup, KpiUnit } from './types'

/** The tall table the tiles are written to — one row per account × tile, read by the card like any KPI table. */
export const ZOHO_KPI_TABLE = 'wfm_zoho_kpis'
export const ZOHO_KPI_GROUP_ID = 'zoho_workforce'
export const ZOHO_KPI_GROUP_NAME = 'Attendance & Adherence'

const HOUR_MS = 3600e3
/** vCORE: a violation piece counts when it's over 60 s; Late = logged in over 60 s after the start. */
const VIOLATION_MIN_MS = 60_000
/** A shift counts toward Absenteeism once it has been going this long with no login — before
 *  that the person is only late so far (they're in Not Logged In meanwhile). */
export const ABSENT_AFTER_MIN = 15
// A break may be stamped a moment before its session's own login (as in lib/zohoAuxShared.ts).
const START_TOLERANCE_MS = 2 * 60 * 1000

// ── Spans ─────────────────────────────────────────────────────────────────────
export type Span = [number, number]   // UTC ms, [start, end)

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const out: Span[] = []
  for (const [s, e] of sorted) {
    const prev = out[out.length - 1]
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e)
    else out.push([s, e])
  }
  return out
}

/** How much of [a, b) the (merged) spans cover. */
function covered(spans: Span[], a: number, b: number): number {
  let n = 0
  for (const [s, e] of spans) n += Math.max(0, Math.min(e, b) - Math.max(s, a))
  return n
}

/** The pieces of [a, b) the (merged) spans don't cover. */
function uncovered(spans: Span[], a: number, b: number): Span[] {
  const out: Span[] = []
  let at = a
  for (const [s, e] of spans) {
    if (e <= at) continue
    if (s >= b) break
    if (s > at) out.push([at, Math.min(s, b)])
    at = Math.max(at, e)
    if (at >= b) break
  }
  if (at < b) out.push([at, b])
  return out
}

/** A person's Time Tracker sessions as merged spans — an open one runs to now, a forgotten one
 *  stops MAX_OPEN_SESSION_HOURS after its login (the same rule as Zoho Breaks & Aux). */
export function sessionSpans(sessions: ZohoSession[], now: number): Span[] {
  const spans: Span[] = []
  for (const s of sessions) {
    const login = s.login ? Date.parse(s.login) : NaN
    if (!Number.isFinite(login) || login > now) continue
    const logout = s.logout ? Date.parse(s.logout) : NaN
    spans.push([login, Number.isFinite(logout) ? logout : Math.min(now, login + MAX_OPEN_SESSION_HOURS * HOUR_MS)])
  }
  return mergeSpans(spans)
}

/** Items grouped by person (normalized name). */
export function byPerson<T extends { employee: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const x of items) {
    const k = normalizeName(x.employee)
    if (!k) continue
    if (!out.has(k)) out.set(k, [])
    out.get(k)!.push(x)
  }
  return out
}

/** Leaves noted in the time logs, keyed `${normalized name}|${date}` → the leave ("VL", "SL", …). */
export function leavesOf(sessions: ZohoSession[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of sessions) if (s.leave && s.date) out.set(`${normalizeName(s.employee)}|${s.date}`, s.leave)
  return out
}

// ── Which shifts are "today" ──────────────────────────────────────────────────
export interface ScopedShift { employee: string; norm: string; start: number; end: number; date: string }

/**
 * The shifts the card counts: every one on today's Zoho schedule (by its own
 * schedule date, on Zoho's New York clock), plus yesterday's that are still
 * going — an overnight shift stays in until it ends. One per person per date.
 * `pick` chooses the rows: an account's (by its Zoho account) or some people's.
 */
export function scopedShifts(
  rows: ScheduleCacheRow[], today: string, yesterday: string, now: number,
  pick: (row: ScheduleCacheRow, personNorm: string) => boolean,
): ScopedShift[] {
  const seen = new Set<string>(), out: ScopedShift[] = []
  for (const row of rows) {
    const date = String(row.log_date).slice(0, 10)
    if (date !== today && date !== yesterday) continue
    for (const sh of row.payload ?? []) {
      const start = Date.parse(sh.start), end = Date.parse(sh.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
      if (date === yesterday && end <= now) continue
      const norm = normalizeName(sh.employee)
      if (!norm || !pick(row, norm)) continue
      const k = `${norm}|${date}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ employee: sh.employee, norm, start, end, date })
    }
  }
  return out
}

/** An account's shifts — schedule rows filed under one of its Zoho account keys (accountKeysFor). */
export function accountShifts(rows: ScheduleCacheRow[], keys: string[], today: string, yesterday: string, now: number): ScopedShift[] {
  const keySet = new Set(keys)
  return scopedShifts(rows, today, yesterday, now, row => keySet.has(row.account_norm))
}

// ── One shift ─────────────────────────────────────────────────────────────────
export interface ShiftJudgement {
  started: boolean
  dueMs: number          // scheduled time so far: from the start to now, or to the end once it's over
  attendedMs: number     // …of it logged in
  worked: boolean        // logged in at some point of it
  lateMs: number | null  // the first login after the start (0 = on time or early); null when not worked
  notLoggedInMs: number  // scheduled and not logged in — the pieces over 60 s (vCORE's V2)
  overBreakMs: number    // breaks / lunches past their named allowance by over 60 s
}

export function judgeShift(sh: { start: number; end: number }, spans: Span[], breaks: ZohoBreak[], now: number): ShiftJudgement {
  const started = now > sh.start
  const dueEnd = Math.min(sh.end, now)
  if (!started) return { started, dueMs: 0, attendedMs: 0, worked: false, lateMs: null, notLoggedInMs: 0, overBreakMs: 0 }
  const dueMs = dueEnd - sh.start
  const attendedMs = covered(spans, sh.start, dueEnd)
  const worked = attendedMs > 0
  const first = spans.find(([s, e]) => e > sh.start && s < dueEnd)
  const lateMs = worked && first ? Math.max(0, first[0] - sh.start) : null
  const notLoggedInMs = uncovered(spans, sh.start, dueEnd)
    .reduce((n, [s, e]) => n + (e - s > VIOLATION_MIN_MS ? e - s : 0), 0)

  let overBreakMs = 0
  for (const b of breaks) {
    if (breakCategory(b.type) !== 'break') continue
    const allowance = allowanceMinutesOf(b.type)
    const bs = b.start ? Date.parse(b.start) : NaN
    if (allowance === null || !Number.isFinite(bs)) continue
    // The session it was taken in — an open break runs to that session's end (now, while it's open).
    const session = spans.find(([s, e]) => bs >= s - START_TOLERANCE_MS && bs < e)
    if (!session) continue
    const endRaw = b.end ? Date.parse(b.end) : NaN
    const be = Math.min(Number.isFinite(endRaw) ? endRaw : session[1], session[1])
    const allowanceMs = allowance * 60_000
    if (be - bs <= allowanceMs + VIOLATION_MIN_MS) continue
    overBreakMs += Math.max(0, Math.min(be, dueEnd) - Math.max(bs + allowanceMs, sh.start))
  }
  return { started, dueMs, attendedMs, worked, lateMs, notLoggedInMs, overBreakMs }
}

/** A shift on leave: its day has a leave noted (leavesOf) and they haven't logged in during it. */
function onLeave(sh: ScopedShift, spans: Span[], leaves: Map<string, string> | undefined, now: number): boolean {
  return !!leaves?.has(`${sh.norm}|${sh.date}`) && covered(spans, sh.start, Math.max(sh.start, Math.min(sh.end, now))) === 0
}

// ── Scheduled right now, not logged in ────────────────────────────────────────
/**
 * Everyone on `shifts` who is scheduled right now and not logged in (not in
 * `current`): Not Logged In since the shift started when they haven't logged
 * in during it, else Logged Out Early since their last logout in it. Someone
 * on leave (leavesOf) isn't expected, so isn't listed. Shaped like
 * computeCurrentAux()'s entries (category 'off'), so they go through
 * buildAccountStatusRows() with everyone else.
 */
export function scheduledOffNow(
  shifts: ScopedShift[], sessionsByPerson: Map<string, ZohoSession[]>, current: Map<string, CurrentAux>, now: number,
  leaves?: Map<string, string>,
): Map<string, CurrentAux> {
  const out = new Map<string, CurrentAux>()
  const onNow = shifts.filter(s => s.start <= now && now < s.end).sort((a, b) => a.start - b.start)
  for (const sh of onNow) {
    if (current.has(sh.norm) || out.has(sh.norm)) continue
    const all = sessionSpans(sessionsByPerson.get(sh.norm) ?? [], now)
    if (onLeave(sh, all, leaves, now)) continue
    const spans = all.filter(([s, e]) => e > sh.start && s < now)
    const lastOut = spans.length ? Math.min(now, Math.max(...spans.map(([, e]) => e))) : null
    out.set(sh.norm, {
      employee: sh.employee, employeeNorm: sh.norm,
      type: lastOut === null ? ZOHO_MISSING_STATUS : ZOHO_LEFT_EARLY_STATUS, category: 'off',
      since: new Date(lastOut ?? sh.start).toISOString(), source: 'schedule',
    })
  }
  return out
}

// ── The account's tiles ───────────────────────────────────────────────────────
export interface ZohoKpiValues {
  scheduledNow: number      // shift on right now (not on leave)
  loggedIn: number          // logged in to the Time Tracker right now (working, in an aux, or on a break)
  onBreak: number           // …of them on a break or lunch (an aux is often the work itself, so not counted)
  notLoggedIn: number       // scheduled right now, not logged in
  attendance: number | null // scheduled time logged in ÷ scheduled time so far, %
  absenteeism: number | null// no-shows ÷ shifts going ABSENT_AFTER_MIN+ min, %
  adherence: number | null  // adherent time ÷ scheduled time so far, people who worked, %
  lateToday: number         // people who logged in over 60 s after their shift started
  shiftsToday: number       // incl. leave
  started: number
  noShows: number
  onLeave: number           // shifts on leave (leavesOf), left out of everything above
}

export function computeAccountKpis(input: {
  shifts: ScopedShift[]
  sessionsByPerson: Map<string, ZohoSession[]>
  breaksByPerson: Map<string, ZohoBreak[]>
  current: Map<string, CurrentAux>     // everyone logged in right now (computeCurrentAux)
  peopleOnAccount: Iterable<string>    // the account's people in Zoho's logs (normalized names)
  leaves?: Map<string, string>         // leavesOf()
  now: number
}): ZohoKpiValues {
  const { sessionsByPerson, breaksByPerson, current, now } = input
  const spansOf = new Map<string, Span[]>()
  const spans = (k: string) => spansOf.get(k) ?? spansOf.set(k, sessionSpans(sessionsByPerson.get(k) ?? [], now)).get(k)!
  const leave = input.shifts.filter(sh => onLeave(sh, spans(sh.norm), input.leaves, now))
  const shifts = input.shifts.filter(sh => !leave.includes(sh))
  const scheduledNow = new Set(shifts.filter(s => s.start <= now && now < s.end).map(s => s.norm))
  const everyone = new Set([...input.peopleOnAccount, ...input.shifts.map(s => s.norm)])
  let loggedIn = 0, onBreak = 0
  for (const k of everyone) {
    const c = current.get(k)
    if (!c || c.category === 'off') continue
    loggedIn++
    if (c.category === 'break') onBreak++
  }
  const notLoggedIn = [...scheduledNow].filter(k => { const c = current.get(k); return !c || c.category === 'off' }).length

  let due = 0, attended = 0, workedDue = 0, adherent = 0, judged = 0, noShows = 0, started = 0
  const late = new Set<string>()
  for (const sh of shifts) {
    const j = judgeShift(sh, spans(sh.norm), breaksByPerson.get(sh.norm) ?? [], now)
    if (!j.started) continue
    started++
    due += j.dueMs
    attended += j.attendedMs
    if (now - sh.start >= ABSENT_AFTER_MIN * 60_000) {
      judged++
      if (!j.worked) noShows++
    }
    if (j.worked) {
      workedDue += j.dueMs
      adherent += Math.max(0, j.dueMs - j.notLoggedInMs - j.overBreakMs)
      if ((j.lateMs ?? 0) > VIOLATION_MIN_MS) late.add(sh.norm)
    }
  }
  return {
    scheduledNow: scheduledNow.size, loggedIn, onBreak, notLoggedIn,
    attendance: due > 0 ? (attended / due) * 100 : null,
    absenteeism: judged > 0 ? (noShows / judged) * 100 : null,
    adherence: workedDue > 0 ? (adherent / workedDue) * 100 : null,
    lateToday: late.size, shiftsToday: input.shifts.length, started, noShows, onLeave: leave.length,
  }
}

// ── Tiles: what's written, and what the card binds ────────────────────────────
export interface ZohoKpiTileDef {
  key: string; label: string; unit: KpiUnit
  warn: number; crit: number; targ: number; direction: 'asc' | 'desc'
  value: (v: ZohoKpiValues) => number | null
}
// Counts are information (isInfoKpi in lib/utils.ts: thresholds out of reach,
// so they never breach, plain colour, no target). The percentages use vCORE's
// adherence colours: green at 95+, amber 85–95, red below; Absenteeism amber
// from 5%, red from 10%. All editable per account in Settings → KPI
// Thresholds like any tile.
const INFO = { warn: KPI_INFO_THRESHOLD, crit: KPI_INFO_THRESHOLD, targ: 0, direction: 'asc' as const }
export const ZOHO_KPI_TILES: ZohoKpiTileDef[] = [
  { key: 'scheduled_now',   label: 'Scheduled Now',   unit: 'count', ...INFO, value: v => v.scheduledNow },
  { key: 'logged_in',       label: 'Logged In',       unit: 'count', ...INFO, value: v => v.loggedIn },
  { key: 'on_break',        label: 'On Break',        unit: 'count', ...INFO, value: v => v.onBreak },
  { key: 'not_logged_in',   label: 'Not Logged In',   unit: 'count', ...INFO, value: v => v.notLoggedIn },
  { key: 'attendance_pct',  label: 'Attendance',      unit: 'percent', warn: 95, crit: 85, targ: 95, direction: 'desc', value: v => v.attendance },
  { key: 'absenteeism_pct', label: 'Absenteeism',     unit: 'percent', warn: 5,  crit: 10, targ: 5,  direction: 'asc',  value: v => v.absenteeism },
  { key: 'adherence_pct',   label: 'Adherence',       unit: 'percent', warn: 95, crit: 85, targ: 95, direction: 'desc', value: v => v.adherence },
  { key: 'late_today',      label: 'Late Today',      unit: 'count', ...INFO, value: v => v.lateToday },
]

export interface ZohoKpiRow {
  id: string; account_id: string; tile_key: string; label: string
  value: string; num: number | null; updated_at: string
}

/** The account's rows for wfm_zoho_kpis — "--" where there's nothing to measure yet (nobody due). */
export function zohoKpiRows(accountId: string, v: ZohoKpiValues, nowIso: string): ZohoKpiRow[] {
  return ZOHO_KPI_TILES.map(t => {
    const n = t.value(v)
    const num = n === null ? null : t.unit === 'percent' ? Math.round(n * 10) / 10 : n
    return {
      id: `${accountId}:${t.key}`, account_id: accountId, tile_key: t.key, label: t.label,
      value: num === null ? '--' : t.unit === 'percent' ? pctText(num) : String(num), num, updated_at: nowIso,
    }
  })
}

/** Does this account's card read wfm_zoho_kpis anywhere? (Raw JSONB on the server, hence the guards.) */
export function readsZohoKpis(ds: Partial<DataSourceConfig> | null | undefined): boolean {
  return (Array.isArray(ds?.groups) ? ds!.groups : []).some(g =>
    g?.source?.table === ZOHO_KPI_TABLE || (Array.isArray(g?.tiles) ? g.tiles : []).some(t => t?.source?.table === ZOHO_KPI_TABLE))
}

// ── A Zoho-only account's settings ────────────────────────────────────────────
/** The KPI group the card shows — each tile bound to its row of wfm_zoho_kpis. */
export function zohoKpiGroup(): KpiGroup {
  return {
    id: ZOHO_KPI_GROUP_ID, name: ZOHO_KPI_GROUP_NAME, cells: {},
    source: { table: ZOHO_KPI_TABLE, accountCol: 'account_id', rowKeyCol: 'tile_key', updatedAtCol: 'updated_at' },
    tiles: ZOHO_KPI_TILES.map(t => ({
      key: t.key, label: t.label, cell: { valueCol: 'value', matchCol: 'tile_key', matchVal: t.key },
      warn: t.warn, crit: t.crit, targ: t.targ, direction: t.direction, kpiUnit: t.unit,
    })),
  }
}

/** No CRM tables: the Zoho tiles, and Zoho Breaks & Aux with everything on — including scheduled but not logged in. */
export function zohoOnlyDataSource(zohoName: string): DataSourceConfig {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_DATA_SOURCE)),
    kpiTable: '', groups: [zohoKpiGroup()],
    agentTable: '', agentSources: [],
    zohoAux: { enabled: true, includeBreaks: true, includeAux: true, includeLoggedIn: true, includeNotLoggedIn: true },
    zohoAccounts: zohoName,
  }
}

/** The Dashboard page's panels to start with: the eight tiles need two rows of the KPI panel
 *  (defaultDashboardLayout in lib/utils.ts gives one — six tiles wide). Movable as on any account. */
export function zohoOnlyDashboardLayout(): DashboardLayout {
  return {
    [`kpi:${ZOHO_KPI_GROUP_ID}`]: { x: 0, y: 0, w: 1180, h: 262 },
    breach: { x: 0,   y: 278, w: 580, h: 420 },
    agents: { x: 600, y: 278, w: 580, h: 420 },
  }
}

/** Status Durations to start with: Not Logged In / Logged Out Early 5 / 15 min, and every break /
 *  lunch with an allowance in its name at that allowance / one minute past it (vCORE's over-break
 *  line — the same as Settings' "Fill break / lunch thresholds from their names"). */
export function zohoOnlyStatusThresholds(zohoTypes: string[]): StatusThresholds {
  const th: StatusThresholds = {
    [ZOHO_MISSING_STATUS]:    { warn: 5, crit: 15 },
    [ZOHO_LEFT_EARLY_STATUS]: { warn: 5, crit: 15 },
  }
  for (const t of zohoTypes) {
    const n = breakCategory(t) === 'break' ? allowanceMinutesOf(t) : null
    if (n !== null) th[t] = { warn: n, crit: n + 1 }
  }
  return th
}

// ── Scanning Zoho for accounts ────────────────────────────────────────────────
// Internal departments are on Zoho's schedules too. They're listed but left
// unticked — a guess by name; the list shows everything either way.
const INTERNAL = /^(it\b|finance\b|payroll\b|people experience\b|human resources\b|hr\b|recruit|maintenance\b|security\b|facilities\b|procurement\b|inventory\b|administrative\b|admin\b|health and safety\b|transportation\b|utility\b|programming\b|bench\b|floating\b)/i
export const looksInternal = (zohoName: string) => INTERNAL.test(zohoName.trim())

/** A new account's id from its Zoho name ("D&L Transport" → "d-and-l-transport"), not one of `taken`. */
export function accountIdFor(zohoName: string, taken: Set<string>): string {
  const base = zohoName.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'zoho-account'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

export interface ZohoAccountScanRow {
  zohoName: string                 // as Zoho spells it
  norm: string
  scheduledToday: number           // people on today's Zoho schedule
  inLogsToday: number              // people in today's Time Tracker logs
  onLive: { id: string; displayName: string } | null    // the WFM Live account that already covers it
  removed: { id: string; displayName: string } | null   // a removed WFM Live account with that name
  internal: boolean                // looks like an internal department (unticked by default)
}

/** Every Zoho account on today's schedule or in today's logs, and whether WFM Live already has it.
 *  `accounts[].keys` are each account's normalized Zoho names (accountKeysFor). */
export function buildAccountScan(input: {
  schedules: ScheduleCacheRow[]
  sessions: ZohoSession[]
  breaks: ZohoBreak[]
  accounts: { id: string; displayName: string; active: boolean; keys: string[] }[]
}): ZohoAccountScanRow[] {
  const rows = new Map<string, { zohoName: string; scheduled: Set<string>; logs: number }>()
  const entry = (name: string) => {
    const k = normalizeAccount(name)
    if (!k) return null
    if (!rows.has(k)) rows.set(k, { zohoName: name, scheduled: new Set(), logs: 0 })
    return rows.get(k)!
  }
  for (const r of input.schedules) {
    const e = entry(r.account)
    for (const sh of r.payload ?? []) e?.scheduled.add(normalizeName(sh.employee))
  }
  for (const a of zohoAccountsSeen(input.sessions, input.breaks)) { const e = entry(a.name); if (e) e.logs = a.people }

  const owner = (k: string, active: boolean) => {
    const a = input.accounts.find(x => x.active === active && x.keys.includes(k))
    return a ? { id: a.id, displayName: a.displayName } : null
  }
  return [...rows].map(([norm, e]) => ({
    zohoName: e.zohoName, norm, scheduledToday: e.scheduled.size, inLogsToday: e.logs,
    onLive: owner(norm, true), removed: owner(norm, false), internal: looksInternal(e.zohoName),
  })).sort((a, b) => (b.scheduledToday - a.scheduledToday) || (b.inLogsToday - a.inLogsToday) || a.zohoName.localeCompare(b.zohoName))
}
