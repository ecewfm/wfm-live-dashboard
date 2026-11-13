// lib/hourlyCliq.ts
// SERVER ONLY. The hourly report in Cliq (per the user, 2026-11-05): a couple of
// minutes after every hour, each account with "Send the hourly report to Cliq"
// on (Settings → Zoho Integrations — DataSourceConfig.hourlyCliq) gets, in its
// Cliq channel:
//   1. a message with the hour that just ended — Scheduled HC, Actual HC,
//      Attendance % and every KPI tile — plus the day so far;
//   2. right under it, a picture of the day's hourly table up to that hour
//      (lib/hourlyCliqImage.tsx) — or, with "One picture per KPI group" on
//      (HourlyCliqConfig.picturePerGroup, per the user 2026-11-13), one picture
//      per KPI group, each with the hours and head count, in the card's order.
// The numbers are the Hourly page's: the same report (getHourlyReport) and the
// same row / cell functions (lib/hourlyReport.ts). Same channel, global "Enable
// Cliq Notifications" and Test Mode as the breach alerts. Every message is in
// the Loggings tab (kind cliq, details.type 'hourly'); the pictures aren't.
//
// The cron (/api/cliq/hourly-report) runs every minute, and from SEND_FROM_MIN to
// SEND_UNTIL_MIN minutes past the hour sends the accounts that are due, about
// HOURLY_UPLOADS_PER_RUN pictures a minute: Cliq allows 20 uploads a minute, and
// the breach scan may post up to 15 pictures in the same minute. wfm_hourly_cliq_sent
// (sql/hourly_report.sql) holds one row per account per hour, written BEFORE
// sending, so an hour's report never goes out twice; a failed one is tried again
// (MAX_TRIES in all). "Send the last hour now" in Settings (sendHourlyReportNow)
// skips all of that — it's a one-off, and doesn't count as the hour's report.

import { supabase } from './supabase'
import { getSupabaseAdmin } from './supabaseAdmin'
import { kpiCardGroups } from './breaches'
import { migrateDataSource, mergeKpiThresholds } from './utils'
import { sendCliqChannelMessage, sendCliqChannelFile } from './zohoCliq'
import { recordNotification, hourlySummary, type NotificationEntry, type NotificationSource } from './notificationLog'
import { getHourlyReport, isTableMissing, HourlyTableMissing, HOURLY_SQL_HINT } from './hourlyReportServer'
import { renderHourlyTablePng, type HourlyImageInput } from './hourlyCliqImage'
import { dateInTz } from './zohoAuxShared'
import {
  hourlyRows, trimHourlyRows, rowHasData, hourlyKpiCell, hourlyTotalKpi, hourlyCliqOf, attendanceTone, pctText, tzShortLabel,
  actualOf, attendanceOf, dayHeads, clockIn, KPI_MODES,
  type HourlyReport, type HourlyRow,
} from './hourlyReport'
import type { DataSourceConfig, HourlyCliqConfig, Thresholds } from './types'

export const HOURLY_CLIQ_TABLE = 'wfm_hourly_cliq_sent'
const HOUR_MS = 3600e3
export const SEND_FROM_MIN = 2         // the hour's last KPI reading (:59) is in by then
export const SEND_UNTIL_MIN = 30       // a report this late isn't worth sending any more
// Pictures a minute: 15 breach pictures + 4 stays under Cliq's 20 uploads a minute. An
// account with a picture per KPI group counts each one; an account with more pictures
// than this still goes, on its own minute.
export const HOURLY_UPLOADS_PER_RUN = 4
export const MAX_TRIES = 3
const RETRY_AFTER_MS = 2 * 60e3
// A claim still 'sending' this long after it was taken belongs to a run that was cut
// off (the route's maxDuration is 300 s) — retried like a failed one. Pictures are drawn
// before anything is sent, so a run cut off while drawing has posted nothing.
export const STUCK_AFTER_MS = 6 * 60e3
const KEEP_DAYS = 30

export interface HourlyCliqAccount { id: string; ds: DataSourceConfig; kpi: Thresholds; channel: string | null }
export interface HourlyCliqClaim { account_id: string; status: 'sending' | 'sent' | 'failed' | 'skipped'; attempts: number; updated_at: string }
type Outcome = 'sent' | 'failed' | 'skipped'

// ── Storage (an interface, so it's testable without Supabase) ────────────────
export interface HourlyCliqStore {
  loadGlobal(): Promise<{ enabled: boolean; testMode: boolean }>
  loadAccounts(): Promise<HourlyCliqAccount[]>
  readClaims(hourIso: string): Promise<HourlyCliqClaim[]>
  /** Takes the account's report for the hour — false if another run already has it. */
  claim(accountId: string, hourIso: string, prev: HourlyCliqClaim | undefined, atIso: string): Promise<boolean>
  finish(accountId: string, hourIso: string, status: Outcome, note: string, atIso: string): Promise<void>
  prune(beforeIso: string): Promise<void>
}

export function supabaseHourlyCliqStore(): HourlyCliqStore {
  const db = () => getSupabaseAdmin()
  const check = (error: { code?: string; message: string } | null, what: string) => {
    if (error) throw isTableMissing(error) ? new HourlyTableMissing(`${what}: ${error.message}`) : new Error(`${what}: ${error.message}`)
  }
  return {
    // The breach scan reads these two with the same (anon) client — lib/cliqScan.ts.
    async loadGlobal() {
      const { data } = await supabase.from('wfm_cliq_settings').select('enabled, test_mode').eq('id', 'global').maybeSingle()
      const row = data as { enabled?: boolean; test_mode?: boolean } | null
      return { enabled: !!row?.enabled, testMode: row?.test_mode !== false }
    },
    async loadAccounts() {
      const { data, error } = await supabase.from('wfm_settings').select('id, data_source, kpi_thresholds, cliq_channel')
      if (error) throw new Error(`reading the accounts: ${error.message}`)
      const rows = (data ?? []) as { id: string; data_source: unknown; kpi_thresholds: unknown; cliq_channel: string | null }[]
      return rows.filter(r => r.data_source).map(r => ({
        id: r.id, ds: migrateDataSource(r.data_source), kpi: mergeKpiThresholds(r.kpi_thresholds),
        channel: r.cliq_channel?.trim() || null,
      }))
    },
    async readClaims(hourIso) {
      const { data, error } = await db().from(HOURLY_CLIQ_TABLE).select('account_id, status, attempts, updated_at').eq('hour_start', hourIso)
      check(error, 'reading the hourly reports sent')
      return (data ?? []) as HourlyCliqClaim[]
    },
    async claim(accountId, hourIso, prev, atIso) {
      if (!prev) {
        const { error } = await db().from(HOURLY_CLIQ_TABLE).insert({ account_id: accountId, hour_start: hourIso, status: 'sending', attempts: 1, updated_at: atIso })
        if (error?.code === '23505') return false
        check(error, 'claiming the hourly report')
        return true
      }
      // A retry (a failed claim, or one stuck 'sending'): only while the row is still the one this run saw.
      const { data, error } = await db().from(HOURLY_CLIQ_TABLE)
        .update({ status: 'sending', attempts: prev.attempts + 1, updated_at: atIso })
        .eq('account_id', accountId).eq('hour_start', hourIso).eq('status', prev.status).eq('attempts', prev.attempts)
        .select('account_id')
      check(error, 'claiming the hourly report')
      return (data ?? []).length > 0
    },
    async finish(accountId, hourIso, status, note, atIso) {
      const { error } = await db().from(HOURLY_CLIQ_TABLE).update({ status, note: note.slice(0, 1000), updated_at: atIso })
        .eq('account_id', accountId).eq('hour_start', hourIso)
      check(error, 'saving the hourly report\'s result')
    },
    async prune(beforeIso) {
      const { error } = await db().from(HOURLY_CLIQ_TABLE).delete().lt('hour_start', beforeIso)
      check(error, 'pruning old hourly report rows')
    },
  }
}

export interface HourlyCliqDeps {
  store?: HourlyCliqStore
  getReport?: (accountId: string, date: string, tz: string) => Promise<HourlyReport>
  sendMessage?: (channel: string, text: string) => Promise<void>
  sendFile?: (channel: string, data: Uint8Array, fileName: string, contentType: string) => Promise<void>
  render?: (input: HourlyImageInput) => Promise<Uint8Array>
  record?: (e: NotificationEntry) => Promise<void>
  now?: () => number
}

function withDefaults(d: HourlyCliqDeps): Required<HourlyCliqDeps> {
  const now = d.now ?? Date.now
  return {
    store: d.store ?? supabaseHourlyCliqStore(),
    getReport: d.getReport ?? ((id, date, tz) => getHourlyReport(id, date, tz, { now })),
    sendMessage: d.sendMessage ?? sendCliqChannelMessage,
    sendFile: d.sendFile ?? sendCliqChannelFile,
    render: d.render ?? renderHourlyTablePng,
    record: d.record ?? recordNotification,
    now,
  }
}

const errText = (e: unknown) => e instanceof Error ? e.message : String(e)

// ── One account's report for one hour ─────────────────────────────────────────
export interface HourlyPicture {
  image: HourlyImageInput
  fileName: string
  label: string           // "hourly table", or the KPI group's name
}
export interface BuiltHourlyReport {
  hourText: string        // "10:00–11:00 ET"
  message: string
  summaryParts: string[]  // the Loggings line
  pictures: HourlyPicture[]  // posted under the message, in this order
}

/** The KPI groups in the report: the card's groups that have tiles, less the hidden ones.
 *  Trimmed: some saved group names / tile labels end in a space ("OOM "). */
function reportGroups(a: HourlyCliqAccount, cfg: Required<HourlyCliqConfig>) {
  const hidden = new Set(cfg.hiddenGroups)
  return kpiCardGroups(a.ds, undefined, a.kpi).filter(g => g.tiles.length && !hidden.has(g.id))
    .map(g => ({ ...g, name: g.name.trim(), tiles: g.tiles.map(t => ({ ...t, label: t.label.trim() })) }))
}

/** How many pictures the account's report posts: one per KPI group in it when that's on, else one. */
export function hourlyPictureCount(a: HourlyCliqAccount): number {
  const cfg = hourlyCliqOf(a.ds)
  return cfg.picturePerGroup ? Math.max(1, reportGroups(a, cfg).length) : 1
}

/** "Service Recovery & Escalations" → "service-recovery-escalations", for a file name. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group'

/** The message and picture for the hour starting at `hourStart` — null when nothing happened in it
 *  (nobody scheduled or logged in, no KPI reading). */
export async function buildHourlyCliqReport(
  a: HourlyCliqAccount, hourStart: number, testMode: boolean, deps: HourlyCliqDeps = {},
): Promise<BuiltHourlyReport | null> {
  const d = withDefaults(deps)
  const cfg = hourlyCliqOf(a.ds)
  const tz = cfg.tz
  const hourEnd = hourStart + HOUR_MS
  const date = dateInTz(hourStart, tz)
  const report = await d.getReport(a.id, date, tz)

  // The day up to the end of the reported hour — the hour now under way isn't in it.
  const upTo = hourlyRows(report, tz, d.now()).filter(r => r.start < hourEnd)
  const row = upTo.find(r => r.start === hourStart)
  if (!row || !rowHasData(row)) return null
  const shown = trimHourlyRows(upTo)

  const groups = reportGroups(a, cfg)
  const anySchedule = report.people.some(p => p.shifts.length > 0)
  const day = dayHeads(upTo.map(r => r.heads))
  const zone = tzShortLabel(tz)
  const modeLabel = KPI_MODES.find(m => m.key === cfg.mode)?.label ?? 'End of hour'
  const hourText = `${clockIn(hourStart, tz)}–${clockIn(hourEnd, tz)} ${zone}`
  const dayText = `${shown[0].label}–${clockIn(hourEnd, tz)} ${zone}`
  const dateLabel = new Date(hourStart).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
  const name = report.displayName || a.id

  const scheduled = (r: HourlyRow) => anySchedule ? String(r.heads.scheduled.length) : ''
  const att = attendanceOf(row.heads)
  const hc = [
    `Scheduled ${anySchedule ? row.heads.scheduled.length : '—'}`,
    `Actual ${actualOf(row.heads)}`,
    `Attendance ${pctText(att) || '—'}`,
  ]

  const lines = [
    `${testMode ? '[TEST] ' : ''}📊 WFM HOURLY REPORT — ${name.toUpperCase()}`,
    `Account: ${name}${name !== a.id ? ` (${a.id})` : ''}`,
    `Hour: ${hourText} · ${dateLabel}`,
    '',
    `👥 Head count (Zoho): ${hc.join(' · ')}`,
  ]
  if (!anySchedule) lines.push('No Zoho daily schedules for this account on this day.')
  const kpiParts: string[] = []
  if (groups.length) {
    lines.push('', `📈 KPIs (${modeLabel.toLowerCase()}):`)
    let anyReading = false
    for (const g of groups) {
      const cells = g.tiles.map(t => {
        const c = hourlyKpiCell(row.kpi, g.id, t, cfg.mode)
        // The Loggings line names the group too when there are several ("Team One SLA %: 87.5%").
        if (c.text) { anyReading = true; kpiParts.push(`${groups.length > 1 ? `${g.name} ` : ''}${t.label}: ${c.text}`) }
        return `${t.label}: ${c.text || '—'}${c.tone === 'bad' ? ' 🔴' : c.tone === 'warn' ? ' 🟡' : ''}`
      })
      lines.push(`• ${g.name} — ${cells.join(' · ')}`)
    }
    if (!anyReading) lines.push('No KPI readings this hour — the account\'s data was out of sync.')
  }
  lines.push('', `📅 Day so far (${dayText}): Scheduled ${anySchedule ? day.scheduled : '—'} · Actual ${day.actual ?? '—'} · Attendance ${pctText(day.attendance) || '—'}`)
  if (testMode) lines.push('', '⚠️ This is a TEST message. Disable Test Mode in Settings > Zoho Integrations when ready.')

  // A picture of the table with `gs`'s KPI columns — every picture has the hours and the head count.
  const tableOf = (gs: typeof groups, part?: HourlyImageInput['part']): HourlyImageInput => {
    const tiles = gs.flatMap(g => g.tiles.map(t => ({ g, t })))
    return {
      accountId: a.id, displayName: name, dateLabel, tzLabel: zone, modeLabel, testMode, part,
      groups: gs.map(g => ({ id: g.id, name: g.name, tiles: g.tiles.map(t => ({ key: t.key, label: t.label })) })),
      rows: shown.map(r => {
        const n = attendanceOf(r.heads)
        return {
          label: r.label, highlight: r.start === hourStart,
          scheduled: scheduled(r), actual: r.heads.started ? String(actualOf(r.heads)) : '', attendance: pctText(n), attTone: attendanceTone(n),
          kpi: tiles.map(({ g, t }) => hourlyKpiCell(r.kpi, g.id, t, cfg.mode)),
        }
      }),
      total: {
        scheduled: anySchedule ? String(day.scheduled) : '', actual: day.actual === null ? '' : String(day.actual), attendance: pctText(day.attendance),
        kpi: tiles.map(({ g, t }) => hourlyTotalKpi(upTo, g.id, t, cfg.mode)),
      },
      footNote: `TOTAL = the day so far, ${dayText}. Scheduled HC: scheduled for at least half the hour · Actual HC: logged in for at least half of it.`,
    }
  }
  const fileBase = `${a.id}-hourly-${date}-${clockIn(hourStart, tz).replace(':', '')}`
  // One picture per group only when there are several — one group is one picture either way.
  const pictures: HourlyPicture[] = cfg.picturePerGroup && groups.length > 1
    ? groups.map((g, i) => ({
      image: tableOf([g], { name: g.name, index: i + 1, count: groups.length }),
      fileName: `${fileBase}-${i + 1}-${slug(g.name)}.png`,
      label: g.name,
    }))
    : [{ image: tableOf(groups), fileName: `${fileBase}.png`, label: 'hourly table' }]
  return { hourText, message: lines.join('\n'), summaryParts: [...hc, ...kpiParts], pictures }
}

/** Build and send one account's report for one hour: the message, then the picture under it. */
export async function sendHourlyCliqReport(
  a: HourlyCliqAccount, hourStart: number, opts: { testMode: boolean; source: NotificationSource },
  deps: HourlyCliqDeps, l: (m: string) => void,
): Promise<{ status: Outcome; note: string }> {
  const d = withDefaults(deps)
  const channel = a.channel as string
  const cfg = hourlyCliqOf(a.ds)
  const built = await buildHourlyCliqReport(a, hourStart, opts.testMode, d)
  const hourLabel = `${clockIn(hourStart, cfg.tz)}–${clockIn(hourStart + HOUR_MS, cfg.tz)} ${tzShortLabel(cfg.tz)}`
  if (!built) {
    l(`${a.id}: nothing in ${hourLabel} — nobody scheduled or logged in, and no KPI readings. Not sent.`)
    return { status: 'skipped', note: 'nothing in the hour' }
  }
  const log = (status: 'sent' | 'failed', error?: string) => d.record({
    kind: 'cliq', accountId: a.id, status, source: opts.source, error: error ?? null, breachCount: null,
    summary: hourlySummary(channel, built.hourText, built.summaryParts),
    details: {
      type: 'hourly', channel, testMode: opts.testMode, message: built.message,
      hour: new Date(hourStart).toISOString(), hourText: built.hourText, tz: cfg.tz, kpiMode: cfg.mode,
      pictures: built.pictures.length,
    },
  })
  // Every picture is drawn BEFORE anything is sent. Drawing is the slow part (seconds a
  // picture), and Ashley Digital's 3 group pictures drawn between uploads ran past the
  // send's time limit after picture 2 (2026-11-13) — the third never went. Drawn first,
  // a send cut off by the limit has posted nothing, and the uploads go out back to back.
  // A picture that fails is a log line and a note, not a failed report — the rest still go.
  const many = built.pictures.length > 1
  const which = (i: number, p: HourlyPicture) => many ? `picture ${i + 1} of ${built.pictures.length} (${p.label})` : 'hourly table picture'
  const missed: string[] = []
  const drawn: (Uint8Array | null)[] = []
  for (const [i, p] of built.pictures.entries()) {
    try {
      drawn.push(await d.render(p.image))
    } catch (e) {
      drawn.push(null)
      l(`${a.id}: ${which(i, p)} not drawn — ${errText(e)}`)
      missed.push(`${many ? which(i, p) : 'picture'} not drawn — ${errText(e)}`)
    }
  }
  try {
    await d.sendMessage(channel, built.message)
  } catch (e) {
    l(`${a.id}: hourly report for ${built.hourText} NOT sent to Cliq #${channel} — ${errText(e)}`)
    await log('failed', errText(e))
    return { status: 'failed', note: errText(e) }
  }
  l(`${a.id}: hourly report for ${built.hourText} sent to Cliq #${channel}.`)
  await log('sent')
  // The pictures only once the message went through, one after another so they land in order.
  for (const [i, p] of built.pictures.entries()) {
    const png = drawn[i]
    if (!png) continue
    try {
      await d.sendFile(channel, png, p.fileName, 'image/png')
      l(`${a.id}: ${which(i, p)} posted.`)
    } catch (e) {
      l(`${a.id}: ${which(i, p)} not posted — ${errText(e)}`)
      missed.push(`${many ? which(i, p) : 'picture'} not posted — ${errText(e)}`)
    }
  }
  return { status: 'sent', note: missed.join('; ') }
}

// ── The cron: every account that's due, a few at a time ──────────────────────
export interface HourlyCliqRunResult { log: string[]; sent: number; skipped: number; failed: number }

export async function runHourlyCliqReports(deps: HourlyCliqDeps = {}): Promise<HourlyCliqRunResult> {
  const d = withDefaults(deps)
  const now = d.now()
  const out: HourlyCliqRunResult = { log: [], sent: 0, skipped: 0, failed: 0 }
  const l = (m: string) => out.log.push(m)
  const hourEnd = Math.floor(now / HOUR_MS) * HOUR_MS
  const hourStart = hourEnd - HOUR_MS
  const hourIso = new Date(hourStart).toISOString()
  const mins = (now - hourEnd) / 60e3
  if (mins < SEND_FROM_MIN || mins >= SEND_UNTIL_MIN) {
    l(`Hourly reports go out ${SEND_FROM_MIN}–${SEND_UNTIL_MIN} minutes past the hour — nothing to do now.`)
    return out
  }

  const global = await d.store.loadGlobal()
  if (!global.enabled) { l('Cliq notifications are off (Settings → Zoho Integrations) — no hourly reports.'); return out }
  const accounts = (await d.store.loadAccounts()).filter(a => a.channel && hourlyCliqOf(a.ds).enabled)
  if (!accounts.length) { l('No account has the hourly report on.'); return out }

  let claims: Map<string, HourlyCliqClaim>
  try {
    claims = new Map((await d.store.readClaims(hourIso)).map(c => [c.account_id, c]))
  } catch (e) {
    if (e instanceof HourlyTableMissing) { l(`The hourly reports' table is missing — ${HOURLY_SQL_HINT}. Nothing sent.`); return out }
    throw e
  }
  if (new Date(now).getUTCMinutes() === 20) {
    await d.store.prune(new Date(now - KEEP_DAYS * 86400e3).toISOString()).catch(e => l(`Pruning old rows failed — ${errText(e)}`))
  }

  const due = accounts.filter(a => {
    const c = claims.get(a.id)
    return !c || (c.attempts < MAX_TRIES && (
      (c.status === 'failed' && now - Date.parse(c.updated_at) >= RETRY_AFTER_MS) ||
      (c.status === 'sending' && now - Date.parse(c.updated_at) >= STUCK_AFTER_MS)))
  })
  if (!due.length) { l(`Every account's report for ${hourIso} is done.`); return out }
  // This minute's share: due accounts in order while their pictures fit HOURLY_UPLOADS_PER_RUN —
  // always at least one, so an account with more pictures than that isn't stuck.
  const batch: HourlyCliqAccount[] = []
  let uploads = 0
  for (const a of due) {
    const n = hourlyPictureCount(a)
    if (batch.length && uploads + n > HOURLY_UPLOADS_PER_RUN) break
    batch.push(a)
    uploads += n
  }
  if (due.length > batch.length) l(`${due.length - batch.length} more account(s) next minute — Cliq allows 20 uploads a minute.`)

  // One at a time: they share the Zoho caches, and the uploads stay spread out.
  for (const a of batch) {
    const at = () => new Date(d.now()).toISOString()
    try {
      if (!(await d.store.claim(a.id, hourIso, claims.get(a.id), at()))) { l(`${a.id}: another run is sending it.`); continue }
    } catch (e) {
      l(`${a.id}: couldn't claim the report — ${errText(e)}`)
      continue
    }
    let result: { status: Outcome; note: string }
    try {
      result = await sendHourlyCliqReport(a, hourStart, { testMode: global.testMode, source: 'auto' }, d, l)
    } catch (e) {
      l(`${a.id}: hourly report failed — ${errText(e)}`)
      result = { status: 'failed', note: errText(e) }
    }
    out[result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped']++
    await d.store.finish(a.id, hourIso, result.status, result.note, at())
      .catch(e => l(`${a.id}: couldn't save the result — ${errText(e)}`))
  }
  return out
}

// ── Settings → "Send the last hour now" ───────────────────────────────────────
/** The hour that just ended, sent right away with the given channel and settings (saved or not). */
export async function sendHourlyReportNow(
  accountId: string, override: { channel: string; config: Partial<HourlyCliqConfig> }, deps: HourlyCliqDeps = {},
): Promise<{ status: Outcome; note: string; log: string[] }> {
  const d = withDefaults(deps)
  const log: string[] = []
  const [global, accounts] = await Promise.all([d.store.loadGlobal(), d.store.loadAccounts()])
  const acc = accounts.find(a => a.id === accountId)
  if (!acc) throw new Error(`No settings for account "${accountId}".`)
  const a: HourlyCliqAccount = { ...acc, channel: override.channel, ds: { ...acc.ds, hourlyCliq: { ...override.config, enabled: true } } }
  const hourStart = Math.floor(d.now() / HOUR_MS) * HOUR_MS - HOUR_MS
  const r = await sendHourlyCliqReport(a, hourStart, { testMode: global.testMode, source: 'test' }, d, m => log.push(m))
  return { ...r, log }
}
