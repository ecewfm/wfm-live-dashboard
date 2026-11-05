// lib/hourlyReport.ts
// The Hourly page (components/HourlyPage.tsx — per the user, 2026-11-05): one
// account's KPI tiles and its Zoho head count, hour by hour, for one day — like
// the interval sheets the RTAs keep by hand.
//
// The PURE half (no I/O, safe in the browser and on the server):
//   - a day's hours in a chosen time zone, and the Zoho dates that can reach it;
//   - Zoho's Daily Schedules reports → shifts (pulled and cached by
//     lib/hourlyReportServer.ts, the same way vCORE reads them — its "Zoho Daily
//     Schedules and Time Logs" reference, 2026-11-05);
//   - who counts in each hour: Scheduled HC, Actual HC, Attendance %;
//   - one hour's KPI readings → the number shown (end of hour / average / worst).
// The fetching, caching and the minute-by-minute KPI readings are
// lib/hourlyReportServer.ts.

import {
  parseZohoDate, zohoCriteriaDate, zohoDisplay, normalizeName, normalizeAccount, addDays, dateInTz,
  zohoAccountValues, MAX_OPEN_SESSION_HOURS,
} from './zohoAuxShared'
import { extractKpiValue } from './utils'
import type { KpiUnit, HourlyCliqConfig } from './types'

// ── Time zones the page can show ──────────────────────────────────────────────
// Whole-hour offsets only: the KPI readings are kept per UTC hour, which then
// lines up with the shown hours in every one of these.
export const HOURLY_TIMEZONES: { tz: string; label: string }[] = [
  { tz: 'America/New_York',    label: 'Eastern (ET)' },
  { tz: 'America/Chicago',     label: 'Central (CT)' },
  { tz: 'America/Denver',      label: 'Mountain (MT)' },
  { tz: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { tz: 'America/Tegucigalpa', label: 'Honduras (CST)' },
  { tz: 'Asia/Manila',         label: 'Manila (PHT)' },
]
// Zoho's own clock — the primary Time Tracker app and its schedules are on it.
export const DEFAULT_HOURLY_TZ = 'America/New_York'
export const ZOHO_CLOCK_TZ = 'America/New_York'
export const isHourlyTz = (tz: string) => HOURLY_TIMEZONES.some(t => t.tz === tz)

const HOUR_MS = 3600e3

export interface DayWindow { start: number; end: number }   // UTC ms, [start, end)

/** Midnight to midnight of `dateISO` in `tz` — 23 or 25 hours on a daylight-saving change. */
export function dayWindow(dateISO: string, tz: string): DayWindow {
  const at = (d: string) => Date.parse(parseZohoDate(`${zohoCriteriaDate(d)} 00:00`, tz) as string)
  return { start: at(dateISO), end: at(addDays(dateISO, 1)) }
}

export interface HourSlot { start: number; end: number; label: string }

/** The window's hours, each labelled by its wall-clock start in `tz` ("8:00", "13:00"). */
export function hoursOf(win: DayWindow, tz: string): HourSlot[] {
  const out: HourSlot[] = []
  for (let t = win.start; t < win.end; t += HOUR_MS) out.push({ start: t, end: Math.min(t + HOUR_MS, win.end), label: clockIn(t, tz) })
  return out
}

/** "9:05" — a 24-hour wall-clock time in `tz`. */
export function clockIn(ms: number, tz: string): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value
  return `${Number(p.hour) % 24}:${p.minute}`
}

/** The Zoho dates (on Zoho's New York clock) whose shifts or time logs can reach into the window:
 *  the day before its first date — an overnight shift started then — through its last. */
export function zohoDatesFor(win: DayWindow): string[] {
  const out: string[] = []
  const last = dateInTz(win.end - 1, ZOHO_CLOCK_TZ)
  for (let d = addDays(dateInTz(win.start, ZOHO_CLOCK_TZ), -1); d <= last; d = addDays(d, 1)) out.push(d)
  return out
}

// ── Zoho's Daily Schedules reports ────────────────────────────────────────────
// Field names as vCORE reads them (its reference §2, Appendix A). The primary
// report is one calendar date; Honduras keeps a WEEKLY template, so every
// Wednesday reads the same `Day == "Wednesday"` rows. Times are wall clock in
// the app's own zone. The account comes off each row the same way as for the
// time logs (pickAccountField: primary "Account", Honduras "Employee.Account").
export interface ZohoScheduleSource {
  key: 'primary' | 'honduras'
  app: string
  report: string
  tz: string
  criteria: (dateISO: string) => string
  start: string; end: string; whpd: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export function weekdayName(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export const ZOHO_SCHEDULE_SOURCES: ZohoScheduleSource[] = [
  {
    key: 'primary', app: 'ece-time-tracker', report: 'All_Daily_Schedules_View_Only', tz: 'America/New_York',
    criteria: d => `(S_Date == "${zohoCriteriaDate(d)}")`, start: 'Schedule_Start', end: 'Schedule_End', whpd: 'WHPD',
  },
  {
    key: 'honduras', app: 'ece-time-tracker-honduras', report: 'Schedules_Report', tz: 'America/Tegucigalpa',
    criteria: d => `(Day == "${weekdayName(d)}")`, start: 'Schedule_Start', end: 'Schedule_End', whpd: 'Working_Hours',
  },
]

/** A Zoho time of day — "08:00", "8:00 AM", "20:00:00", or a date-time — as [hour, minute]; 24:00 is midnight. vCORE's toHM. */
export function toHM(v: unknown): [number, number] | null {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(zohoDisplay(v))
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  if (m[3]) {
    const pm = /p/i.test(m[3])
    if (h < 1 || h > 12) return null
    h = h === 12 ? (pm ? 12 : 0) : pm ? h + 12 : h
  }
  if (h === 24 && min === 0) h = 0
  if (h > 23 || min > 59) return null
  return [h, min]
}

/** One scheduled shift, as cached (UTC ISO). */
export interface ZohoShift { employee: string; start: string; end: string; source: string }

/** A schedule row → its shift, or null: no name, or a rest day (WHPD 0, a start or end missing, start = end). */
export function parseScheduleRow(r: Record<string, unknown>, s: ZohoScheduleSource, dateISO: string): ZohoShift | null {
  const employee = zohoDisplay(r.Employee)
  if (!employee) return null
  const whpd = zohoDisplay(r[s.whpd])
  if (whpd !== '' && Number(whpd) === 0) return null
  const a = toHM(r[s.start]), b = toHM(r[s.end])
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return null
  const at = ([h, m]: [number, number], day: string) => parseZohoDate(`${zohoCriteriaDate(day)} ${h}:${String(m).padStart(2, '0')}`, s.tz) as string
  const start = at(a, dateISO)
  let end = at(b, dateISO)
  // An end at or before the start is an overnight shift — it ends on the next day's wall clock.
  if (Date.parse(end) <= Date.parse(start)) end = at(b, addDays(dateISO, 1))
  return { employee, start, end, source: s.key }
}

/** What the schedule cache holds: one row per date × source × Zoho account. */
export interface ScheduleCacheRow { log_date: string; source: string; account_norm: string; account: string; payload: ZohoShift[] }

/**
 * A source's parsed rows for one date → cache rows grouped by account. One shift
 * per person: when Zoho has two rows for someone, the LAST one wins (as in vCORE).
 * Someone on several accounts (a multi-account lookup) is under each of them.
 */
export function groupShiftsByAccount(
  date: string, source: string, rows: { shift: ZohoShift | null; accounts: string[] }[],
): { rows: ScheduleCacheRow[]; shifts: number; rest: number; noAccount: number } {
  const last = new Map<string, { shift: ZohoShift | null; accounts: string[] }>()
  for (const r of rows) {
    const k = normalizeName(r.shift?.employee)
    if (k) last.set(k, r)
  }
  const groups = new Map<string, ScheduleCacheRow>()
  let shifts = 0, noAccount = 0
  for (const { shift, accounts } of last.values()) {
    if (!shift) continue
    shifts++
    if (!accounts.length) { noAccount++; continue }
    for (const a of accounts) {
      const key = normalizeAccount(a)
      if (!key) continue
      if (!groups.has(key)) groups.set(key, { log_date: date, source, account_norm: key, account: a, payload: [] })
      groups.get(key)!.payload.push(shift)
    }
  }
  return { rows: [...groups.values()], shifts, rest: rows.length - shifts, noAccount }
}

/** A schedule row's account(s), read from the field pickAccountField chose for that report. */
export const scheduleRowAccounts = (r: Record<string, unknown>, field: string | null) => field ? zohoAccountValues(r[field]) : []

// ── Head count ────────────────────────────────────────────────────────────────
// One person on the account for the day: their shifts and their Time Tracker
// sessions (UTC ms; a session's logout is null while they're still logged in).
export interface HourlyPerson { name: string; shifts: [number, number][]; sessions: [number, number | null][] }

// Someone counts in an hour when they're there for at least this share of it:
// scheduled for half the hour → Scheduled HC; logged in for half of the time
// they were scheduled in it — half the hour if they weren't — → Actual HC. Clean
// whole heads: a login at 8:55 for a 9:00 shift doesn't make 8:00 one more, and
// a logout at 18:05 doesn't add one to 18:00.
export const HC_SHARE = 0.5

/** A session's end for counting: its logout, or now while open — but a forgotten logout stops
 *  MAX_OPEN_SESSION_HOURS after the login (the same rule as Zoho Breaks & Aux). */
export function sessionEnd([login, logout]: [number, number | null], now: number): number {
  return logout ?? Math.min(now, login + MAX_OPEN_SESSION_HOURS * HOUR_MS)
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [s, e] of sorted) {
    const prev = out[out.length - 1]
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e)
    else out.push([s, e])
  }
  return out
}

/** How much of [a, b) the spans cover (spans already merged). */
function covered(spans: [number, number][], a: number, b: number): number {
  let n = 0
  for (const [s, e] of spans) n += Math.max(0, Math.min(e, b) - Math.max(s, a))
  return n
}

/** How much of [a, b) both span lists cover — logged in during scheduled time. */
function coveredBoth(x: [number, number][], y: [number, number][], a: number, b: number): number {
  let n = 0
  for (const [s1, e1] of x) for (const [s2, e2] of y) n += Math.max(0, Math.min(e1, e2, b) - Math.max(s1, s2, a))
  return n
}

export interface HourHeads {
  /** The hour has started — Actual HC and Attendance only mean something then. */
  started: boolean
  scheduled: string[]     // scheduled for at least half the hour
  present: string[]       // …and there for at least half of their time so far
  absent: string[]        // …and not (only people already due)
  upcoming: string[]      // …not due yet (this hour, their shift starts later in it)
  unscheduled: string[]   // there, not scheduled this hour (overtime, early, a rest day)
}

export function headsForHour(people: HourlyPerson[], h0: number, h1: number, now: number): HourHeads {
  const started = h0 < now
  const judgedEnd = Math.min(h1, now)
  const out: HourHeads = { started, scheduled: [], present: [], absent: [], upcoming: [], unscheduled: [] }
  for (const p of people) {
    const shifts = mergeSpans(p.shifts)
    const isScheduled = covered(shifts, h0, h1) >= (h1 - h0) * HC_SHARE
    if (isScheduled) out.scheduled.push(p.name)
    if (!started) continue
    const sessions = mergeSpans(p.sessions.map(s => [s[0], sessionEnd(s, now)] as [number, number]))
    if (isScheduled) {
      const due = covered(shifts, h0, judgedEnd)
      if (due <= 0) { out.upcoming.push(p.name); continue }
      if (coveredBoth(shifts, sessions, h0, judgedEnd) >= due * HC_SHARE) out.present.push(p.name)
      else out.absent.push(p.name)
    } else {
      const there = covered(sessions, h0, judgedEnd)
      if (there > 0 && there >= (judgedEnd - h0) * HC_SHARE) out.unscheduled.push(p.name)
    }
  }
  for (const k of ['scheduled', 'present', 'absent', 'upcoming', 'unscheduled'] as const) out[k].sort((a, b) => a.localeCompare(b))
  return out
}

/** Actual HC — everyone there: the scheduled ones and the rest. */
export const actualOf = (h: HourHeads) => h.present.length + h.unscheduled.length
/** Attendance % — the scheduled people (due so far) who were there. null when nobody was due. */
export function attendanceOf(h: HourHeads): number | null {
  const due = h.present.length + h.absent.length
  return due ? (h.present.length / due) * 100 : null
}

/** The TOTAL row: distinct people scheduled / there during the day, and attendance over all the
 *  day's hours (scheduled hours attended ÷ scheduled hours due — so half a day missed shows). */
export function dayHeads(hours: HourHeads[]): { scheduled: number; actual: number | null; attendance: number | null } {
  const scheduled = new Set<string>(), actual = new Set<string>()
  let present = 0, due = 0
  for (const h of hours) {
    h.scheduled.forEach(n => scheduled.add(n))
    h.present.forEach(n => actual.add(n))
    h.unscheduled.forEach(n => actual.add(n))
    present += h.present.length
    due += h.present.length + h.absent.length
  }
  return { scheduled: scheduled.size, actual: hours.some(h => h.started) ? actual.size : null, attendance: due ? (present / due) * 100 : null }
}

// ── KPI readings, per hour ────────────────────────────────────────────────────
// Every minute, lib/hourlyReportServer.ts reads each account's KPI tiles (the
// same kpiCardGroups() the Overview card shows) and folds the reading into the
// current hour's record for that tile. The CRMs only ever give live numbers —
// most of them "today so far" or "right now" — so this is the only history.
export interface KpiTileHour {
  last: string            // the hour's last reading, exactly as the tile showed it
  lastNum: number | null  // …as a number (extractKpiValue, the tile's unit); null if it isn't one
  min: number | null      // lowest / highest numeric reading
  max: number | null
  sum: number             // sum and count of the numeric readings — the average
  n: number
  pct: boolean            // the readings carried a "%" — an average or worst is shown with one too
  at: string              // when the last reading was taken (UTC ISO)
}
export type KpiHour = Record<string, KpiTileHour>     // keyed by kpiTileKey(group, tile)
export const kpiTileKey = (groupId: string, tileKey: string) => `${groupId}:${tileKey}`

/** UTC ISO of the top of the hour `ms` is in. */
export const hourStartIso = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString()

/**
 * Fold one reading into a tile's record for the hour. An empty tile ("", "--")
 * adds nothing. A second reading in the same minute (an overlapping run) only
 * replaces the last one — it isn't counted again. A duration of 0 ("00:00") is
 * the CRM having no data yet, not a measurement, so it isn't in the numbers.
 */
export function addKpiReading(prev: KpiTileHour | undefined, raw: string, unit: KpiUnit | undefined, atIso: string): KpiTileHour | undefined {
  const value = String(raw ?? '').trim()
  if (!value || value === '--' || value === '-') return prev
  const num = extractKpiValue(value, unit).num
  const numeric = Number.isFinite(num) && !(unit === 'duration' && num <= 0) ? num : null
  const pct = value.includes('%')
  if (prev && prev.at.slice(0, 16) === atIso.slice(0, 16)) {
    return { ...prev, last: value, lastNum: numeric, at: atIso }
  }
  const base: KpiTileHour = prev ?? { last: value, lastNum: null, min: null, max: null, sum: 0, n: 0, pct: false, at: atIso }
  return {
    last: value, lastNum: numeric, at: atIso, pct: base.pct || pct,
    min: numeric === null ? base.min : base.min === null ? numeric : Math.min(base.min, numeric),
    max: numeric === null ? base.max : base.max === null ? numeric : Math.max(base.max, numeric),
    sum: base.sum + (numeric ?? 0), n: base.n + (numeric === null ? 0 : 1),
  }
}

/** Several hours of one tile as one — the TOTAL row. */
export function mergeKpiHours(hours: (KpiTileHour | undefined)[]): KpiTileHour | undefined {
  let out: KpiTileHour | undefined
  for (const h of hours) {
    if (!h) continue
    if (!out) { out = { ...h }; continue }
    const later = h.at > out.at
    out = {
      last: later ? h.last : out.last, lastNum: later ? h.lastNum : out.lastNum, at: later ? h.at : out.at,
      pct: out.pct || h.pct,
      min: h.min === null ? out.min : out.min === null ? h.min : Math.min(out.min, h.min),
      max: h.max === null ? out.max : out.max === null ? h.max : Math.max(out.max, h.max),
      sum: out.sum + h.sum, n: out.n + h.n,
    }
  }
  return out
}

export type KpiMode = 'last' | 'avg' | 'worst'
export const KPI_MODES: { key: KpiMode; label: string; hint: string }[] = [
  { key: 'last',  label: 'End of hour', hint: 'What the tile showed at the end of the hour (the TOTAL row: at the end of the day)' },
  { key: 'avg',   label: 'Average',     hint: 'The average of the hour\'s readings (taken every minute)' },
  { key: 'worst', label: 'Worst',       hint: 'The worst reading in the hour, by the tile\'s thresholds — the lowest where low is bad, else the highest' },
]

/** A number as a tile shows it: "1:55" for a duration (minutes), "12" / "4.5" for a count, "85.3%" for a percent. */
export function formatKpiNumber(num: number, unit: KpiUnit | undefined, pct: boolean): string {
  if (unit === 'duration') {
    const secs = Math.round(num * 60)
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  }
  const text = Number.isInteger(num) ? String(num) : num.toFixed(1).replace(/\.0$/, '')
  return unit !== 'count' && pct ? `${text}%` : text
}

/** What one cell shows for a tile's record in `mode`, and the number its colour comes from. A tile
 *  that never read as a number (text) shows its last reading in every mode. */
export function kpiCellValue(
  h: KpiTileHour | undefined, mode: KpiMode, tile: { unit: KpiUnit | undefined; lowIsBad: boolean },
): { text: string; num: number | null } | null {
  if (!h) return null
  if (mode === 'last' || !h.n) return { text: h.last, num: h.lastNum }
  const num = mode === 'avg' ? h.sum / h.n : (tile.lowIsBad ? h.min : h.max) as number
  return { text: formatKpiNumber(num, tile.unit, h.pct), num }
}

// ── The table ─────────────────────────────────────────────────────────────────
// The Hourly page and the hourly report in Cliq (lib/hourlyCliq.ts) both build
// their rows and cells with these, so the picture in Cliq can't drift from the page.

/** A KPI tile as the table needs it — a KpiCardTile (lib/breaches.ts) fits. */
export interface HourlyTile { key: string; label: string; unit: KpiUnit | undefined; lowIsBad: boolean; colorOf: (num: number) => string }

export interface HourlyRow { start: number; end: number; label: string; now: boolean; heads: HourHeads; kpi: KpiHour | undefined }

/** Every hour of the report's day: who counts in it, and its KPI readings. */
export function hourlyRows(report: Pick<HourlyReport, 'window' | 'people' | 'kpiHours'>, tz: string, now: number): HourlyRow[] {
  const kpiByHour = new Map(report.kpiHours.map(h => [Date.parse(h.hour), h.tiles]))
  return hoursOf(report.window, tz).map(h => ({
    ...h, now: h.start <= now && now < h.end, heads: headsForHour(report.people, h.start, h.end, now), kpi: kpiByHour.get(h.start),
  }))
}

/** Anything in the hour — someone scheduled or there, or a KPI reading. */
export const rowHasData = (r: HourlyRow) => r.heads.scheduled.length > 0 || actualOf(r.heads) > 0 || (!!r.kpi && Object.keys(r.kpi).length > 0)

/** Only the stretch of the day with something in it (every hour when none has). */
export function trimHourlyRows(rows: HourlyRow[]): HourlyRow[] {
  const first = rows.findIndex(rowHasData)
  if (first < 0) return rows
  let last = rows.length - 1
  while (last > first && !rowHasData(rows[last])) last--
  return rows.slice(first, last + 1)
}

export type CellTone = 'ok' | 'warn' | 'bad' | ''
const TONE_OF: Record<string, CellTone> = { 'text-success': 'ok', 'text-warning': 'warn', 'text-danger': 'bad' }

/** One KPI cell: its text in `mode`, toned by the tile's thresholds. */
export function hourlyKpiCell(kpi: KpiHour | undefined, groupId: string, tile: HourlyTile, mode: KpiMode): { text: string; tone: CellTone } {
  const v = kpiCellValue(kpi?.[kpiTileKey(groupId, tile.key)], mode, tile)
  if (!v) return { text: '', tone: '' }
  return { text: v.text, tone: v.num === null ? '' : TONE_OF[tile.colorOf(v.num)] ?? '' }
}

/** The TOTAL row's KPI cell — every hour in `rows` as one. Not toned. */
export function hourlyTotalKpi(rows: HourlyRow[], groupId: string, tile: HourlyTile, mode: KpiMode): string {
  return kpiCellValue(mergeKpiHours(rows.map(r => r.kpi?.[kpiTileKey(groupId, tile.key)])), mode, tile)?.text ?? ''
}

// Attendance has no thresholds of its own — the same lines vCORE colours adherence by.
export const attendanceTone = (n: number | null): CellTone => n === null ? '' : n < 85 ? 'bad' : n < 95 ? 'warn' : ''
/** "92%", "91.7%"; '' for none. */
export const pctText = (n: number | null) => n === null ? '' : `${Number.isInteger(Math.round(n * 10) / 10) ? Math.round(n) : n.toFixed(1)}%`
/** "ET", "PHT" — the short name in the zone's label. */
export const tzShortLabel = (tz: string) => /\(([^)]+)\)/.exec(HOURLY_TIMEZONES.find(t => t.tz === tz)?.label ?? '')?.[1] ?? tz

/** An account's hourly-report-in-Cliq setting, defaults filled in. */
export function hourlyCliqOf(ds: { hourlyCliq?: HourlyCliqConfig } | null | undefined): Required<HourlyCliqConfig> {
  const c = ds?.hourlyCliq
  return {
    enabled: !!c?.enabled,
    tz: c?.tz && isHourlyTz(c.tz) ? c.tz : DEFAULT_HOURLY_TZ,
    mode: c?.mode === 'avg' || c?.mode === 'worst' ? c.mode : 'last',
    hiddenGroups: Array.isArray(c?.hiddenGroups) ? c.hiddenGroups : [],
  }
}

// ── What /api/hourly returns (getHourlyReport, lib/hourlyReportServer.ts) ─────
export interface HourlyReport {
  accountId: string
  displayName: string
  date: string
  tz: string
  window: DayWindow
  now: number
  /** What the account is matched on in Zoho: its Zoho Account setting, else its display name. */
  zohoAccounts: string[]
  zohoAccountsFromSetting: boolean
  /** The Zoho accounts that actually matched (as Zoho spells them). */
  matchedAccounts: string[]
  people: HourlyPerson[]
  kpiHours: { hour: string; tiles: KpiHour }[]
  /** Per Zoho date: when its time logs / schedules were last pulled (null = never). */
  pulls: Record<string, { timeLogs: string | null; schedules: string | null }>
  /** Another request was pulling a date this needs — the page asks again shortly. */
  pulling: boolean
  log: string[]
  needsMigration: { kpi: boolean; schedules: boolean }
}

// ── CSV ───────────────────────────────────────────────────────────────────────
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map(r => r.map(cell).join(',')).join('\r\n')
}
