'use client'

// The Loggings page (super users) — every Zoho Cliq notification and Workforce
// RTA Log the webapp sent, or tried to, newest first. One plain line each;
// click a row for what exactly went out. Rows come from /api/logs
// (lib/notificationLog.ts), which only answers super users.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/authClient'

type Kind = 'cliq' | 'rta_log'
type Status = 'sent' | 'failed'
type Source = 'auto' | 'force' | 'test'
interface Item { entity: string; metric: string; value: string; threshold: string; severity: 'warning' | 'critical' | null }
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
const MODE_LABEL: Record<string, string> = {
  ai: 'AI categorization (Gemini) — one log per category',
  plain: 'One combined report (fixed category)',
  heartbeat: 'Hourly readings (fixed category)',
  test: 'Test submission from Settings',
}
const REFRESH_MS = 60 * 1000
const PAGE_SIZE = 100

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

  const [rows, setRows]       = useState<LogRow[]>([])
  const [counts, setCounts]   = useState<Counts | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)
  const [open, setOpen]       = useState<Set<number>>(new Set())
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  // Older pages loaded by hand — the auto refresh (first page only) would drop them.
  const paged = useRef(false)

  const url = useCallback((before?: number) => {
    const p = new URLSearchParams()
    if (kind !== 'all') p.set('kind', kind)
    if (status !== 'all') p.set('status', status)
    if (account !== 'all') p.set('account', account)
    const ms = PERIODS.find(x => x.key === period)?.ms
    if (ms) p.set('since', new Date(Date.now() - ms).toISOString())
    if (before) p.set('before', String(before))
    p.set('limit', String(PAGE_SIZE))
    return `/api/logs?${p}`
  }, [kind, status, account, period])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const r = await apiFetch(url())
      setNeedsMigration(!!r.needsMigration)
      setRows(r.rows ?? [])
      setHasMore(!!r.hasMore)
      setCounts(r.counts ?? null)
      setError(null)
      setUpdatedAt(Date.now())
      paged.current = false
    } catch (e: any) {
      setError(e?.message || 'Couldn\'t load the log.')
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => { if (!paged.current && !document.hidden) load(true) }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const loadMore = async () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const r = await apiFetch(url(last.id))
      setRows(prev => [...prev, ...(r.rows ?? [])])
      setHasMore(!!r.hasMore)
      paged.current = true
    } catch (e: any) {
      setError(e?.message || 'Couldn\'t load older rows.')
    } finally {
      setLoadingMore(false)
    }
  }

  const name = (id: string) => displayNames[id] || id
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => [r.summary, r.account_id, name(r.account_id), r.error || '', r.details?.channel || '', r.details?.category || '', r.details?.subCategory || '']
      .some(s => s.toLowerCase().includes(q)))
  }, [rows, search, displayNames]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  // Accounts in the log that aren't on this person's list (a removed account) still get a filter entry.
  const accountChoices = useMemo(() => [...new Set([...accounts, ...rows.map(r => r.account_id)])].sort((a, b) => name(a).localeCompare(name(b))),
    [accounts, rows, displayNames]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lg-page">
      <div className="ov-header">
        <div>
          <div className="ov-title">Loggings</div>
          <div className="ov-sub">Every Zoho Cliq notification and Workforce RTA Log the webapp sent — or tried to — newest first. Click a row for what exactly went out.</div>
        </div>
        <div className="lg-refresh">
          {updatedAt && <span className="text-muted">Updated {new Date(updatedAt).toLocaleTimeString()}</span>}
          <button className="btn-icon" onClick={() => load()} title="Refresh now"><i className={`bx bx-refresh${loading ? ' bx-spin' : ''}`} /></button>
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
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search these rows (breach, channel, error…)" />
        </div>
      </div>

      {needsMigration && (
        <div className="lg-banner">
          <i className="bx bx-info-circle" /> The log table isn&apos;t set up yet. Run <code>sql/notification_log.sql</code> in the Supabase SQL editor —
          logging starts with the next notification after that.
        </div>
      )}
      {error && <div className="lg-banner bad"><i className="bx bx-error" /> {error}</div>}

      <div className="table-card">
        <div className="lg-table-wrap">
          <table className="dash-table lg-table">
            <thead>
              <tr><th style={{ width: 26 }} /><th>When</th><th>Type</th><th>Account</th><th>What was sent</th><th>Result</th><th>Triggered by</th></tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && <tr><td colSpan={7} className="no-data">Loading…</td></tr>}
              {!loading && shown.length === 0 && !needsMigration && (
                <tr><td colSpan={7} className="no-data">
                  {rows.length ? 'No row matches that search.' : 'Nothing logged for these filters. Rows appear as the scan sends Cliq notifications and RTA Logs (it runs every minute) — anything sent before this page existed isn\'t recorded.'}
                </td></tr>
              )}
              {shown.map(r => {
                const t = when(r.created_at)
                const isOpen = open.has(r.id)
                return (
                  <Fragment key={r.id}>
                  <tr className={`lg-row${isOpen ? ' open' : ''}${r.status === 'failed' ? ' failed' : ''}`} onClick={() => toggle(r.id)}>
                    <td><button className="lg-chev" aria-expanded={isOpen} aria-label={isOpen ? 'Hide details' : 'Show details'} onClick={e => { e.stopPropagation(); toggle(r.id) }}><i className={`bx ${isOpen ? 'bx-chevron-down' : 'bx-chevron-right'}`} /></button></td>
                    <td title={t.full}><div>{t.main}</div><div className="lg-ago">{t.ago}</div></td>
                    <td>{r.kind === 'cliq'
                      ? <span className="lg-type cliq"><i className="bx bx-message-dots" /> Cliq</span>
                      : <span className="lg-type rta"><i className="bx bx-file" /> RTA Log</span>}</td>
                    <td className="lg-acc">{name(r.account_id)}</td>
                    <td className="lg-sum">{r.summary}</td>
                    <td>{r.status === 'sent'
                      ? <span className="lg-res ok"><i className="bx bx-check" /> Sent</span>
                      : <span className="lg-res bad"><i className="bx bx-x" /> Failed</span>}</td>
                    <td className="text-muted">{SOURCE_LABEL[r.source] || r.source}</td>
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
      {hasMore && (
        <div className="lg-more">
          <button className="lg-more-btn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older'}</button>
        </div>
      )}
    </div>
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
                <span><strong>{b.entity}</strong> — {b.metric}: {b.value}{b.threshold ? <span className="text-muted"> (threshold {b.threshold})</span> : null}</span>
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
