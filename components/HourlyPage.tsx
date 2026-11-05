'use client'

// The Hourly page (super users and RTAs — per the user, 2026-11-05): one
// account's KPI tiles and its Zoho head count, hour by hour, for one day, like
// the interval sheets the RTAs keep by hand. Data from /api/hourly
// (lib/hourlyReportServer.ts); every count and number on it is worked out by
// lib/hourlyReport.ts. The KPI columns are the account's own KPI tiles — the
// same kpiCardGroups() its Overview card shows — read every minute by the
// webapp (the CRMs keep no history of their own). The head count is the Zoho
// Daily Schedules and ECE Time Tracker logs of the people whose account in Zoho
// is this account (Settings → Zoho Integrations → Zoho Account).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/authClient'
import { kpiCardGroups, type KpiCardGroup } from '@/lib/breaches'
import { DEFAULT_DATA_SOURCE, DEFAULT_THRESHOLDS } from '@/lib/utils'
import { addDays, dateInTz } from '@/lib/zohoAuxShared'
import type { DataSourceConfig, Thresholds } from '@/lib/types'
import {
  HOURLY_TIMEZONES, DEFAULT_HOURLY_TZ, ZOHO_CLOCK_TZ, KPI_MODES, isHourlyTz, clockIn,
  actualOf, attendanceOf, dayHeads, sessionEnd, toCsv,
  hourlyRows, trimHourlyRows, hourlyKpiCell, hourlyTotalKpi, attendanceTone, pctText,
  type KpiMode, type HourHeads, type HourlyPerson, type HourlyReport, type HourlyRow, type KpiHour, type CellTone,
} from '@/lib/hourlyReport'

const REFRESH_MS = 2 * 60 * 1000     // the KPI readings are every minute, Zoho every 5
const PULLING_RETRY_MS = 10 * 1000   // another request was pulling Zoho for this day
const LOOKAHEAD_DAYS = 7

const store = {
  get(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } },
  set(key: string, v: string) { try { localStorage.setItem(key, v) } catch { /* not remembered */ } },
}

const CELL_CLASS: Record<CellTone, string> = { ok: 'hr-ok', warn: 'hr-warn', bad: 'hr-bad', '': '' }
const ATT_CLASS: Record<CellTone, string> = { ok: '', warn: ' hr-att-warn', bad: ' hr-att-bad', '': '' }

export default function HourlyPage({ accounts, displayNames, account, onAccountChange, dataSources, kpiThresholds, onOpenSettings }: {
  accounts: string[]
  displayNames: Record<string, string>
  account: string
  onAccountChange: (id: string) => void
  dataSources: Record<string, DataSourceConfig>
  kpiThresholds: Record<string, Thresholds>
  /** Opens Settings (the Zoho Account setting lives there) — absent for roles that can't edit it. */
  onOpenSettings?: () => void
}) {
  const [tz, setTz] = useState(() => { const t = store.get('wfm_hourly_tz') || ''; return isHourlyTz(t) ? t : DEFAULT_HOURLY_TZ })
  const [mode, setMode] = useState<KpiMode>(() => { const m = store.get('wfm_hourly_mode'); return m === 'avg' || m === 'worst' ? m : 'last' })
  const [date, setDate] = useState(() => dateInTz(Date.now(), tz))
  const [allHours, setAllHours] = useState(false)
  const [report, setReport] = useState<HourlyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  const [hiddenVersion, setHiddenVersion] = useState(0)
  const gen = useRef(0)

  const today = dateInTz(now, tz)
  const isToday = date === today
  const name = (id: string) => displayNames[id] || id

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  useEffect(() => { store.set('wfm_hourly_tz', tz) }, [tz])
  useEffect(() => { store.set('wfm_hourly_mode', mode) }, [mode])
  // Hidden KPI groups, per account, remembered in this browser (re-read when a chip is toggled).
  const hidden = useMemo<Set<string>>(() => {
    void hiddenVersion
    try { return new Set(JSON.parse(store.get(`wfm_hourly_hidden_${account}`) || '[]')) } catch { return new Set() }
  }, [account, hiddenVersion])
  const toggleGroup = (id: string) => {
    const n = new Set(hidden)
    if (n.has(id)) n.delete(id); else n.add(id)
    store.set(`wfm_hourly_hidden_${account}`, JSON.stringify([...n]))
    setHiddenVersion(v => v + 1)
  }

  const load = useCallback(async (quiet = false) => {
    if (!account) return
    const g = ++gen.current
    if (!quiet) { setLoading(true); setOpen(new Set()) }
    try {
      const r = await apiFetch(`/api/hourly?${new URLSearchParams({ account, date, tz })}`) as HourlyReport
      if (gen.current !== g) return
      setReport(r); setError(null); setUpdatedAt(Date.now()); setNow(Date.now())
    } catch (e: any) {
      if (gen.current === g) setError(e?.message || 'Couldn\'t load the hourly report.')
    } finally {
      if (gen.current === g && !quiet) setLoading(false)
    }
  }, [account, date, tz])

  // A report for another account / day / zone is never shown (`fits` below), so no need to clear it first.
  useEffect(() => { load() }, [load])
  // Today keeps itself current; another request pulling Zoho for this day → ask again shortly.
  useEffect(() => {
    const wait = report?.pulling ? PULLING_RETRY_MS : isToday ? REFRESH_MS : 0
    if (!wait) return
    const t = setTimeout(() => { if (!document.hidden) load(true) }, wait)
    return () => clearTimeout(t)
  }, [report, isToday, load, updatedAt, error])

  const changeTz = (next: string) => {
    // "Today" stays today in the new zone; any other day stays that day.
    if (date === dateInTz(Date.now(), tz)) setDate(dateInTz(Date.now(), next))
    setTz(next)
  }

  // ── The columns: the account's KPI tiles, from its CURRENT settings ──
  const ds = dataSources[account] ?? DEFAULT_DATA_SOURCE
  const kpiTh = kpiThresholds[account] ?? DEFAULT_THRESHOLDS
  const groups: KpiCardGroup[] = useMemo(() => kpiCardGroups(ds, undefined, kpiTh).filter(g => g.tiles.length), [ds, kpiTh])
  const shownGroups = groups.filter(g => !hidden.has(g.id))

  // ── The rows ──
  const fits = report && report.accountId === account && report.date === date && report.tz === tz
  const people = useMemo(() => (fits ? report.people : []), [fits, report])
  const byName = useMemo(() => new Map(people.map(p => [p.name, p])), [people])
  const allRows: HourlyRow[] = useMemo(() => fits ? hourlyRows(report, tz, now) : [], [fits, report, tz, now])
  // Only the stretch of the day with something in it — unless "All 24 hours".
  const rows = useMemo(() => allHours ? allRows : trimHourlyRows(allRows), [allRows, allHours])
  const total = useMemo(() => dayHeads(allRows.map(r => r.heads)), [allRows])
  const anySchedule = people.some(p => p.shifts.length > 0)

  const cell = (h: KpiHour | undefined, g: KpiCardGroup, t: KpiCardGroup['tiles'][number]) => {
    const c = hourlyKpiCell(h, g.id, t, mode)
    return { text: c.text, cls: CELL_CLASS[c.tone] }
  }
  const totalKpi = (g: KpiCardGroup, t: KpiCardGroup['tiles'][number]) => hourlyTotalKpi(allRows, g.id, t, mode)

  const downloadCsv = () => {
    const tiles = shownGroups.flatMap(g => g.tiles.map(t => ({ g, t })))
    const head = ['Interval', 'Scheduled HC', 'Actual HC', 'Attendance %', ...tiles.map(({ g, t }) => `${g.name} — ${t.label}`)]
    const body = rows.map(r => [
      r.label, r.heads.scheduled.length, r.heads.started ? actualOf(r.heads) : '', pctText(attendanceOf(r.heads)),
      ...tiles.map(({ g, t }) => cell(r.kpi, g, t).text),
    ])
    const foot = ['TOTAL', total.scheduled, total.actual ?? '', pctText(total.attendance), ...tiles.map(({ g, t }) => totalKpi(g, t))]
    const blob = new Blob([toCsv([head, ...body, foot])], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `hourly-${account}-${date}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const toggleRow = (start: number) => setOpen(prev => { const n = new Set(prev); if (n.has(start)) n.delete(start); else n.add(start); return n })
  const tzLabel = HOURLY_TIMEZONES.find(t => t.tz === tz)?.label ?? tz
  const zohoDate = fits ? dateInTz((report.window.start + report.window.end) / 2, ZOHO_CLOCK_TZ) : ''
  const pulled = fits ? report.pulls[zohoDate] : undefined
  const at = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'not yet'
  const colCount = 4 + shownGroups.reduce((n, g) => n + g.tiles.length, 0)

  return (
    <div className="hr-page">
      <div className="ov-header">
        <div>
          <div className="ov-title">Hourly — {name(account)}</div>
          <div className="ov-sub">This account&apos;s KPI tiles and its Zoho head count, hour by hour. Click an hour to see who was scheduled and who was there.</div>
        </div>
        <div className="lg-refresh">
          {updatedAt && <span className="text-muted">Updated {new Date(updatedAt).toLocaleTimeString()}</span>}
          <button className="btn-icon" onClick={() => load()} title="Refresh"><i className={`bx bx-refresh${loading ? ' bx-spin' : ''}`} /></button>
        </div>
      </div>

      <div className="lg-filters hr-toolbar">
        <select className="lg-select" value={account} onChange={e => onAccountChange(e.target.value)} aria-label="Account">
          {accounts.map(id => <option key={id} value={id}>{name(id)}</option>)}
        </select>
        <div className="hr-date">
          <button className="lg-pg" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day" title="Previous day"><i className="bx bx-chevron-left" /></button>
          <input type="date" className="lg-select" value={date} max={addDays(today, LOOKAHEAD_DAYS)} aria-label="Day"
            onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDate(e.target.value) }} />
          <button className="lg-pg" onClick={() => setDate(addDays(date, 1))} disabled={date >= addDays(today, LOOKAHEAD_DAYS)} aria-label="Next day" title="Next day"><i className="bx bx-chevron-right" /></button>
          {!isToday && <button className="lg-pg hr-today" onClick={() => setDate(today)}>Today</button>}
        </div>
        <select className="lg-select" value={tz} onChange={e => changeTz(e.target.value)} aria-label="Time zone" title="Time zone the hours are in">
          {HOURLY_TIMEZONES.map(t => <option key={t.tz} value={t.tz}>{t.label}</option>)}
        </select>
        <div className="lg-seg" role="group" aria-label="KPI value">
          {KPI_MODES.map(m => <button key={m.key} className={mode === m.key ? 'on' : ''} title={m.hint} onClick={() => setMode(m.key)}>{m.label}</button>)}
        </div>
        <label className="hr-check"><input type="checkbox" checked={allHours} onChange={() => setAllHours(v => !v)} /> All 24 hours</label>
        <button className="lg-pg hr-csv" onClick={downloadCsv} disabled={!rows.length} title="Download this table as a CSV file"><i className="bx bx-download" /> CSV</button>
      </div>

      {groups.length > 1 && (
        <div className="hr-groups" aria-label="KPI groups shown">
          <span className="text-muted">KPI groups:</span>
          {groups.map(g => (
            <button key={g.id} className={`hr-chip${hidden.has(g.id) ? '' : ' on'}`} aria-pressed={!hidden.has(g.id)} onClick={() => toggleGroup(g.id)}>
              <i className={`bx ${hidden.has(g.id) ? 'bx-hide' : 'bx-show'}`} /> {g.name}
            </button>
          ))}
        </div>
      )}

      {fits && (
        <div className="hr-info">
          <span><i className="bx bx-buildings" /> Zoho account: <strong>{(report.matchedAccounts.length ? report.matchedAccounts : report.zohoAccounts).join(', ')}</strong>
            {!report.zohoAccountsFromSetting && <span className="text-muted"> (this account&apos;s name)</span>}</span>
          <span><i className="bx bx-group" /> {people.length} {people.length === 1 ? 'person' : 'people'} scheduled or logged in</span>
          <span><i className="bx bx-time-five" /> Hours in {tzLabel}</span>
          {pulled && <span className="text-muted">Zoho time logs {pulled.timeLogs === null && date > today ? '—' : `pulled ${at(pulled.timeLogs)}`} · schedules pulled {at(pulled.schedules)}</span>}
        </div>
      )}

      {fits && report.needsMigration.kpi && report.needsMigration.schedules ? (
        <div className="lg-banner"><i className="bx bx-info-circle" /> The Hourly page&apos;s tables aren&apos;t set up yet. Run <code>sql/hourly_report.sql</code> in the Supabase SQL editor — KPI readings start the minute after.</div>
      ) : fits && (report.needsMigration.kpi || report.needsMigration.schedules) ? (
        <div className="lg-banner"><i className="bx bx-info-circle" /> Part of <code>sql/hourly_report.sql</code> is missing ({report.needsMigration.kpi ? 'the KPI readings' : 'the Zoho schedules'}) — run it again in the Supabase SQL editor.</div>
      ) : null}
      {fits && report.pulling && <div className="lg-banner"><i className="bx bx-loader-alt bx-spin" /> Zoho is being pulled for this day by another request — this refreshes in a moment.</div>}
      {fits && !people.length && !report.pulling && (
        <div className="lg-banner">
          <i className="bx bx-info-circle" />
          <span>No one in Zoho&apos;s schedules or time logs is on <strong>{report.zohoAccounts.map(n => `“${n}”`).join(' / ')}</strong>{' '}for this day.
            If Zoho calls this account something else, set it under <strong>Settings → Zoho Integrations → Zoho Account</strong>
            {onOpenSettings && <> — <button className="hr-link" onClick={onOpenSettings}>open Settings</button></>}.</span>
        </div>
      )}
      {fits && people.length > 0 && !anySchedule && (
        <div className="lg-banner"><i className="bx bx-info-circle" /> No Zoho daily schedules found for this account on this day — Scheduled HC and Attendance are empty.</div>
      )}
      {fits && report.log.some(m => /NOT pulled|sign-in failed/i.test(m)) && (
        <div className="lg-banner bad"><i className="bx bx-error" /> <span>Zoho couldn&apos;t be read just now, so this may be out of date: {report.log.filter(m => /NOT pulled|sign-in failed/i.test(m)).join(' ')}</span></div>
      )}
      {error && <div className="lg-banner bad"><i className="bx bx-error" /> {error}</div>}

      <div className={`table-card lg-card${loading && fits ? ' lg-busy' : ''}`}>
        <div className="lg-table-wrap hr-wrap">
          <table className="dash-table hr-table">
            <thead>
              <tr>
                <th rowSpan={2} className="hr-int">Interval</th>
                <th colSpan={3} className="hr-gh hr-hc">Head count (Zoho)</th>
                {shownGroups.map(g => <th key={g.id} colSpan={g.tiles.length} className="hr-gh hr-gs">{g.name}</th>)}
              </tr>
              <tr>
                <th className="hr-hc" title="People whose Zoho daily schedule covers at least half of the hour">Scheduled HC</th>
                <th className="hr-hc" title="People logged in to the ECE Time Tracker for at least half of their scheduled time in the hour (half the hour if they weren't scheduled)">Actual HC</th>
                <th className="hr-hc" title="The scheduled people who were there, out of those due so far">Attendance %</th>
                {shownGroups.map(g => g.tiles.map((t, i) => <th key={`${g.id}:${t.key}`} className={i === 0 ? 'hr-gs' : ''}>{t.label}</th>))}
              </tr>
            </thead>
            <tbody>
              {!fits && loading && <tr><td colSpan={colCount} className="no-data">Loading…</td></tr>}
              {!fits && !loading && !error && <tr><td colSpan={colCount} className="no-data">Nothing to show.</td></tr>}
              {fits && rows.map(r => {
                const isOpen = open.has(r.start)
                const att = attendanceOf(r.heads)
                return (
                  <Fragment key={r.start}>
                    <tr className={`hr-row${r.now ? ' hr-now' : ''}${isOpen ? ' open' : ''}`} onClick={() => toggleRow(r.start)}>
                      <td className="hr-int">
                        <i className={`bx ${isOpen ? 'bx-chevron-down' : 'bx-chevron-right'} hr-chev`} />
                        {r.label}{r.now && <span className="hr-now-pill">now</span>}
                      </td>
                      <td className="hr-num">{anySchedule ? r.heads.scheduled.length : ''}</td>
                      <td className="hr-num">{r.heads.started ? actualOf(r.heads) : ''}</td>
                      <td className={`hr-num${ATT_CLASS[attendanceTone(att)]}`}>{pctText(att)}</td>
                      {shownGroups.map(g => g.tiles.map((t, i) => {
                        const c = cell(r.kpi, g, t)
                        return <td key={`${g.id}:${t.key}`} className={`hr-num ${c.cls}${i === 0 ? ' hr-gs' : ''}`}>{c.text}</td>
                      }))}
                    </tr>
                    {isOpen && (
                      <tr className="hr-detail-row">
                        <td colSpan={colCount}><HourDetail heads={r.heads} byName={byName} tz={tz} now={now} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
            {fits && rows.length > 0 && (
              <tfoot>
                <tr className="hr-total">
                  <td className="hr-int">TOTAL</td>
                  <td className="hr-num" title="Different people scheduled during the day">{anySchedule ? total.scheduled : ''}</td>
                  <td className="hr-num" title="Different people there during the day">{total.actual ?? ''}</td>
                  <td className="hr-num" title="Scheduled hours attended, out of the day's scheduled hours so far">{pctText(total.attendance)}</td>
                  {shownGroups.map(g => g.tiles.map((t, i) => (
                    <td key={`${g.id}:${t.key}`} className={`hr-num${i === 0 ? ' hr-gs' : ''}`}>{totalKpi(g, t)}</td>
                  )))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="hr-notes">
        <p><strong>Scheduled HC</strong> — people whose Zoho daily schedule covers at least half of the hour. <strong>Actual HC</strong> — people logged in to the ECE Time Tracker for at least half of their scheduled time in the hour (half the hour if they weren&apos;t scheduled — overtime, or in early). <strong>Attendance %</strong> — the scheduled people who were there, out of those due so far. <strong>TOTAL</strong> — different people across the day; attendance over all the day&apos;s scheduled hours.</p>
        <p><strong>KPI columns</strong> — this account&apos;s KPI tiles, read by the webapp every minute (the CRMs keep no history, so hours before the webapp started reading them are blank, and so is any minute the account&apos;s data was out of sync). <strong>End of hour</strong> is what the tile showed at the end of the hour — the TOTAL row, at the end of the day; <strong>Average</strong> averages the hour&apos;s readings; <strong>Worst</strong> is its worst reading by the tile&apos;s thresholds. Colours follow the tile&apos;s thresholds.</p>
      </div>
    </div>
  )
}

// Who was scheduled and who was there in one hour, with each person's shift and Time Tracker times.
function HourDetail({ heads, byName, tz, now }: { heads: HourHeads; byName: Map<string, HourlyPerson>; tz: string; now: number }) {
  const shiftText = (p?: HourlyPerson) => (p?.shifts ?? []).map(([s, e]) => `${clockIn(s, tz)}–${clockIn(e, tz)}`).join(', ')
  const sessionText = (p?: HourlyPerson) => (p?.sessions ?? []).map(s => {
    const end = s[1] === null ? (sessionEnd(s, now) < now ? ' (no logout)' : ' (still in)') : ` – ${clockIn(s[1], tz)}`
    return `in ${clockIn(s[0], tz)}${end}`
  }).join(', ')
  const list = (title: string, names: string[], cls: string, show: 'both' | 'shift' | 'session') => names.length > 0 && (
    <div className={`hr-list ${cls}`}>
      <div className="lg-block-title">{title} ({names.length})</div>
      <ul>
        {names.map(n => {
          const p = byName.get(n)
          const bits = [show !== 'session' && shiftText(p) && `shift ${shiftText(p)}`, show !== 'shift' && sessionText(p)].filter(Boolean)
          return <li key={n}><span>{n}</span>{bits.length > 0 && <span className="text-muted"> · {bits.join(' · ')}</span>}</li>
        })}
      </ul>
    </div>
  )
  const empty = !heads.scheduled.length && !heads.unscheduled.length
  return (
    <div className="hr-detail">
      {empty && <div className="text-muted">Nobody scheduled or logged in this hour.</div>}
      {!heads.started && list('Scheduled', heads.scheduled, '', 'shift')}
      {heads.started && list('Scheduled, not there', heads.absent, 'bad', 'both')}
      {heads.started && list('Scheduled and there', heads.present, 'ok', 'both')}
      {heads.started && list('Starting later this hour', heads.upcoming, '', 'both')}
      {heads.started && list('There, not scheduled this hour', heads.unscheduled, 'extra', 'both')}
    </div>
  )
}
