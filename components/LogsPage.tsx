'use client'

// The Loggings page (super users) — every Zoho Cliq notification and Workforce
// RTA Log the webapp sent, or tried to, newest first, 20 to a page. One plain
// line each; click a row for what exactly went out. Rows come from /api/logs
// (lib/notificationLog.ts), which only answers super users. A page is fetched
// the first time it's opened and kept, so going back to it is instant; the
// kept pages are dropped when the filters change or new entries arrive.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/authClient'
import { KPI_MODES } from '@/lib/hourlyReport'

type Kind = 'cliq' | 'rta_log'
type Status = 'sent' | 'failed'
type Source = 'auto' | 'force' | 'test'
interface Item { entity: string; metric: string; value: string; threshold: string; severity: 'warning' | 'critical' | null; fields?: { label: string; value: string }[] }
interface LogRow {
  id: number
  created_at: string
  kind: Kind
  account_id: string
  status: Status
  source: Source
  summary: string
  breach_count: number | null
  error: string | null
  details: {
    channel?: string; testMode?: boolean; message?: string
    // The hourly report in Cliq (lib/hourlyCliq.ts) — a Cliq row with type 'hourly'.
    type?: 'hourly'; hourText?: string; kpiMode?: string
    mode?: 'ai' | 'plain' | 'heartbeat' | 'test'; zohoAccount?: string; sites?: string[]
    category?: string; subCategory?: string; remarks?: string
    items?: Item[]
  }
}
interface Counts { cliqSent: number; rtaSent: number; failed: number }

const PERIODS = [
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d',  label: 'Last 7 days',   ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: 'Last 30 days',  ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'Everything kept (90 days)', ms: 0 },
] as const
type PeriodKey = typeof PERIODS[number]['key']

const SOURCE_LABEL: Record<Source, string> = { auto: 'Automatic scan', force: 'Force Scan Now', test: 'Test button' }
const HOURLY_SOURCE_LABEL: Record<Source, string> = { auto: 'Every hour', force: 'Force Scan Now', test: 'Send the last hour now' }
const sourceLabel = (r: LogRow) => (r.details?.type === 'hourly' ? HOURLY_SOURCE_LABEL : SOURCE_LABEL)[r.source] || r.source
const MODE_LABEL: Record<string, string> = {
  ai: 'AI categorization (Gemini) — one log per category',
  plain: 'One combined report (fixed category)',
  heartbeat: 'Hourly readings (fixed category)',
  test: 'Test submission from Settings',
}
const REFRESH_MS = 60 * 1000
const PAGE_SIZE = 20
const PAGE_WINDOW = 5 // page numbers shown at once — the arrows reach the rest

function when(iso: string): { main: string; ago: string; full: string } {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  const main = today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`
  return { main, ago, full: d.toLocaleString() }
}

export default function LogsPage({ accounts, displayNames }: { accounts: string[]; displayNames: Record<string, string> }) {
  const [kind, setKind]       = useState<'all' | Kind>('all')
  const [status, setStatus]   = useState<'all' | Status>('all')
  const [account, setAccount] = useState('all')
  const [period, setPeriod]   = useState<PeriodKey>('7d')
  const [search, setSearch]   = useState('')
  const [query, setQuery]     = useState('') // the search once typing pauses — it runs on the server

  // Pages fetched for the current filters, by number (1 = newest). The ref is for
  // the callbacks, which must see a page kept a moment ago.
  const [pages, setPagesState] = useState<Record<number, LogRow[]>>({})
  const pagesRef = useRef<Record<number, LogRow[]>>({})
  const setPages = useCallback((p: Record<number, LogRow[]>) => { pagesRef.current = p; setPagesState(p) }, [])
  const [page, setPage]       = useState(1)
  const [total, setTotal]     = useState(0)
  const [counts, setCounts]   = useState<Counts | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState<number | null>(null) // a page on its way
  const [error, setError]     = useState<string | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)
  const [open, setOpen]       = useState<Set<number>>(new Set())
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // What the kept pages belong to: a generation (bumped when they're dropped, so
  // a late answer for the old ones is ignored), the period's cut-off, and page 1's
  // newest row id — later pages read only rows up to it, so they don't shift.
  const view = useRef<{ gen: number; since?: string; upTo: number | null }>({ gen: 0, upTo: null })
  const wanted = useRef(1)                 // the page last clicked — an earlier, slower one doesn't win
  const busy = useRef<number | null>(null) // mirrors `fetching` for the auto refresh
  const pageRef = useRef(1)
  const namesRef = useRef(displayNames)
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { namesRef.current = displayNames }, [displayNames])
  useEffect(() => { const t = setTimeout(() => setQuery(search.trim()), 350); return () => clearTimeout(t) }, [search])

  const url = useCallback((extra: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    if (kind !== 'all') p.set('kind', kind)
    if (status !== 'all') p.set('status', status)
    if (account !== 'all') p.set('account', account)
    if (view.current.since) p.set('since', view.current.since)
    if (query) {
      p.set('q', query)
      // The server only knows account ids, so name the accounts whose display name matches.
      const q = query.toLowerCase()
      const ids = Object.keys(namesRef.current).filter(id => (namesRef.current[id] || '').toLowerCase().includes(q))
      if (ids.length) p.set('names', ids.join(','))
    }
    p.set('limit', String(PAGE_SIZE))
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
    return `/api/logs?${p}`
  }, [kind, status, account, query])

  // Page 1 fresh, with the page count and the 24 h counts. `quiet` = the auto
  // refresh: the kept pages stay unless new entries arrived (they'd shift them).
  const loadFirst = useCallback(async (quiet = false) => {
    if (!quiet) {
      view.current = { gen: view.current.gen + 1, upTo: null }
      busy.current = null; setFetching(null)
      setLoading(true)
    }
    const ms = PERIODS.find(x => x.key === period)?.ms
    view.current.since = ms ? new Date(Date.now() - ms).toISOString() : undefined
    const gen = view.current.gen
    try {
      const r = await apiFetch(url({ first: 1 }))
      if (view.current.gen !== gen) return
      setNeedsMigration(!!r.needsMigration)
      setCounts(r.counts ?? null)
      setTotal(r.total ?? 0)
      const upTo = r.upTo ?? null
      if (!quiet || upTo !== view.current.upTo) {
        view.current = { ...view.current, gen: quiet ? gen + 1 : gen, upTo }
        setPages({ 1: r.rows ?? [] })
        wanted.current = 1
        setPage(1)
      }
      setError(null)
      setUpdatedAt(Date.now())
    } catch (e: any) {
      if (view.current.gen === gen) setError(e?.message || 'Couldn\'t load the log.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [url, period, setPages])

  useEffect(() => { loadFirst() }, [loadFirst])
  useEffect(() => {
    const t = setInterval(() => { if (pageRef.current === 1 && busy.current === null && !document.hidden) loadFirst(true) }, REFRESH_MS)
    return () => clearInterval(t)
  }, [loadFirst])

  const goTo = useCallback(async (n: number) => {
    wanted.current = n
    const show = () => {
      setPage(n)
      requestAnimationFrame(() => { const el = tableRef.current; if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' }) })
    }
    if (pagesRef.current[n]) { show(); return }
    const { gen, upTo } = view.current
    busy.current = n; setFetching(n)
    try {
      const r = await apiFetch(url({ page: n, upTo: upTo ?? undefined }))
      if (view.current.gen !== gen) return
      setPages({ ...pagesRef.current, [n]: r.rows ?? [] })
      if (wanted.current === n) { show(); setError(null) }
    } catch (e: any) {
      if (view.current.gen === gen && wanted.current === n) setError(e?.message || 'Couldn\'t load that page.')
    } finally {
      if (busy.current === n) { busy.current = null; setFetching(null) }
    }
  }, [url, setPages])

  const name = (id: string) => displayNames[id] || id
  const rows = pages[page] ?? []
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const offset = (page - 1) * PAGE_SIZE

  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  // Accounts in the log that aren't on this person's list (a removed account) still get a filter entry.
  const accountChoices = useMemo(() => {
    const seen = Object.values(pages).flat().map(r => r.account_id)
    return [...new Set([...accounts, ...seen, ...(account !== 'all' ? [account] : [])])].sort((a, b) => name(a).localeCompare(name(b)))
  }, [accounts, pages, account, displayNames]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lg-page">
      <div className="ov-header">
        <div>
          <div className="ov-title">Loggings</div>
          <div className="ov-sub">Every Zoho Cliq notification and Workforce RTA Log the webapp sent — or tried to — newest first. Click a row for what exactly went out.</div>
        </div>
        <div className="lg-refresh">
          {updatedAt && <span className="text-muted">Updated {new Date(updatedAt).toLocaleTimeString()}</span>}
          <button className="btn-icon" onClick={() => loadFirst()} title="Refresh — back to the newest"><i className={`bx bx-refresh${loading ? ' bx-spin' : ''}`} /></button>
        </div>
      </div>

      {counts && (
        <div className="lg-stats">
          <div className="lg-stat"><i className="bx bx-message-dots" /><div><div className="lg-stat-n">{counts.cliqSent}</div><div className="lg-stat-l">Cliq notifications sent</div></div></div>
          <div className="lg-stat"><i className="bx bx-file" /><div><div className="lg-stat-n">{counts.rtaSent}</div><div className="lg-stat-l">RTA Logs sent</div></div></div>
          <div className={`lg-stat${counts.failed ? ' bad' : ''}`}><i className="bx bx-error-circle" /><div><div className="lg-stat-n">{counts.failed}</div><div className="lg-stat-l">Failed</div></div></div>
          <div className="lg-stat-note">in the last 24 hours, all accounts</div>
        </div>
      )}

      <div className="lg-filters">
        <div className="lg-seg" role="group" aria-label="Type">
          {([['all', 'All'], ['cliq', 'Cliq'], ['rta_log', 'RTA Logs']] as const).map(([k, l]) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        <div className="lg-seg" role="group" aria-label="Result">
          {([['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed']] as const).map(([k, l]) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
          ))}
        </div>
        <select className="lg-select" value={account} onChange={e => setAccount(e.target.value)} aria-label="Account">
          <option value="all">All accounts</option>
          {accountChoices.map(id => <option key={id} value={id}>{name(id)}</option>)}
        </select>
        <select className="lg-select" value={period} onChange={e => setPeriod(e.target.value as PeriodKey)} aria-label="Period">
          {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <div className="lg-search">
          <i className="bx bx-search" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search every entry (account, breach, channel, error…)" />
        </div>
      </div>

      {needsMigration && (
        <div className="lg-banner">
          <i className="bx bx-info-circle" /> The log table isn&apos;t set up yet. Run <code>sql/notification_log.sql</code> in the Supabase SQL editor —
          logging starts with the next notification after that.
        </div>
      )}
      {error && <div className="lg-banner bad"><i className="bx bx-error" /> {error}</div>}

      <div className={`table-card lg-card${(loading && rows.length) || fetching !== null ? ' lg-busy' : ''}`} ref={tableRef}>
        <div className="lg-table-wrap">
          <table className="dash-table lg-table">
            <thead>
              <tr><th style={{ width: 26 }} /><th>When</th><th>Type</th><th>Account</th><th>What was sent</th><th>Result</th><th>Triggered by</th></tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && <tr><td colSpan={7} className="no-data">Loading…</td></tr>}
              {!loading && rows.length === 0 && !needsMigration && (
                <tr><td colSpan={7} className="no-data">
                  {query ? `Nothing matches “${query}” for these filters.` : 'Nothing logged for these filters. Rows appear as the scan sends Cliq notifications and RTA Logs (it runs every minute) — anything sent before this page existed isn\'t recorded.'}
                </td></tr>
              )}
              {rows.map(r => {
                const t = when(r.created_at)
                const isOpen = open.has(r.id)
                return (
                  <Fragment key={r.id}>
                  <tr className={`lg-row${isOpen ? ' open' : ''}${r.status === 'failed' ? ' failed' : ''}`} onClick={() => toggle(r.id)}>
                    <td><button className="lg-chev" aria-expanded={isOpen} aria-label={isOpen ? 'Hide details' : 'Show details'} onClick={e => { e.stopPropagation(); toggle(r.id) }}><i className={`bx ${isOpen ? 'bx-chevron-down' : 'bx-chevron-right'}`} /></button></td>
                    <td className="lg-when" title={t.full}><div>{t.main}</div><div className="lg-ago">{t.ago}</div></td>
                    <td>{r.kind !== 'cliq'
                      ? <span className="lg-type rta"><i className="bx bx-file" /> RTA Log</span>
                      : r.details?.type === 'hourly'
                        ? <span className="lg-type cliq"><i className="bx bx-table" /> Cliq · Hourly</span>
                        : <span className="lg-type cliq"><i className="bx bx-message-dots" /> Cliq</span>}</td>
                    <td className="lg-acc">{name(r.account_id)}</td>
                    <td className="lg-sum">{r.summary}</td>
                    <td>{r.status === 'sent'
                      ? <span className="lg-res ok"><i className="bx bx-check" /> Sent</span>
                      : <span className="lg-res bad"><i className="bx bx-x" /> Failed</span>}</td>
                    <td className="text-muted lg-src">{sourceLabel(r)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="lg-detail-row">
                      <td colSpan={7}><Details row={r} accountName={name(r.account_id)} /></td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {total > 0 && rows.length > 0 && (
        <div className="lg-pager-bar">
          <span className="text-muted">{offset + 1}–{offset + rows.length} of {total.toLocaleString()} {total === 1 ? 'entry' : 'entries'}</span>
          {pageCount > 1 && <Pager page={fetching ?? page} count={pageCount} loading={fetching} onGo={goTo} />}
        </div>
      )}
    </div>
  )
}

// Up to PAGE_WINDOW page numbers — the block holding the page (1–5, 6–10, …);
// the arrows step one page newer / older, onto the next block at its edge.
function Pager({ page, count, loading, onGo }: { page: number; count: number; loading: number | null; onGo: (n: number) => void }) {
  const start = Math.floor((page - 1) / PAGE_WINDOW) * PAGE_WINDOW + 1
  const nums = Array.from({ length: Math.min(PAGE_WINDOW, count - start + 1) }, (_, i) => start + i)
  return (
    <nav className="lg-pager" aria-label="Pages">
      <button className="lg-pg" onClick={() => onGo(page - 1)} disabled={page <= 1} aria-label="Newer page" title="Newer"><i className="bx bx-chevron-left" /></button>
      {nums.map(n => (
        <button key={n} className={`lg-pg${n === page ? ' on' : ''}`} onClick={() => { if (n !== page) onGo(n) }}
          aria-label={`Page ${n}`} aria-current={n === page ? 'page' : undefined}>
          {loading === n ? <i className="bx bx-loader-alt bx-spin" /> : n}
        </button>
      ))}
      <button className="lg-pg" onClick={() => onGo(page + 1)} disabled={page >= count} aria-label="Older page" title="Older"><i className="bx bx-chevron-right" /></button>
    </nav>
  )
}

function Details({ row, accountName }: { row: LogRow; accountName: string }) {
  const d = row.details || {}
  const items = d.items || []
  return (
    <div className="lg-detail">
      {row.status === 'failed' && row.error && (
        <div className="lg-error"><strong>Why it failed:</strong> {row.error}</div>
      )}
      <div className="lg-facts">
        <div><span>Account</span>{accountName}{accountName !== row.account_id ? ` (${row.account_id})` : ''}</div>
        {row.kind === 'cliq' ? <>
          <div><span>Channel</span>#{d.channel}</div>
          {d.type === 'hourly' && <>
            <div><span>Hourly report</span>{d.hourText || '—'}</div>
            <div><span>KPI value</span>{KPI_MODES.find(m => m.key === d.kpiMode)?.label || '—'}</div>
          </>}
          <div><span>Test mode</span>{d.testMode ? 'On — the message was marked [TEST]' : 'Off'}</div>
        </> : <>
          <div><span>Zoho account</span>{d.zohoAccount || '—'}</div>
          <div><span>Sites</span>{(d.sites || []).join(', ') || '—'}</div>
          <div><span>Category</span>{d.category ? `${d.category} / ${d.subCategory}` : '—'}</div>
          <div><span>How</span>{(d.mode && MODE_LABEL[d.mode]) || '—'}</div>
        </>}
        <div><span>Logged</span>{new Date(row.created_at).toLocaleString()}</div>
      </div>
      {items.length > 0 && (
        <div className="lg-block">
          <div className="lg-block-title">{row.kind === 'cliq' ? `Breaches in the message (${items.length})` : d.mode === 'ai' ? `Breaches classified this cycle (${items.length})` : `Items reported (${items.length})`}</div>
          <ul className="lg-items">
            {items.map((b, i) => (
              <li key={i}>
                {b.severity && <span className={b.severity === 'critical' ? 'badge-crit' : 'badge-warn'}>{b.severity === 'critical' ? 'Critical' : 'Warning'}</span>}
                <span><strong>{b.entity}</strong> — {b.metric}: {b.value}{b.threshold ? <span className="text-muted"> (threshold {b.threshold})</span> : null}
                  {(b.fields || []).map(f => <span key={f.label} className="text-muted"> · {f.label}: <span style={{ color: 'var(--text-main)' }}>{f.value}</span></span>)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.kind === 'cliq' && d.message && (
        <div className="lg-block"><div className="lg-block-title">Message sent to Cliq</div><pre className="lg-pre">{d.message}</pre></div>
      )}
      {row.kind === 'rta_log' && d.remarks && (
        <div className="lg-block"><div className="lg-block-title">Remarks sent to Zoho</div><pre className="lg-pre">{d.remarks}</pre></div>
      )}
    </div>
  )
}
