'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import SettingsModal from './SettingsModal'
import type { AccountData, AgentState, KpiSnapshot, UserStatusCounts, ActiveCall, Thresholds } from '@/lib/types'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS,
  calcAbandonRate, extractPercent, formatTime, formatSeconds,
  isDataStale, parseDurationToSeconds,
  getKpiColorClass, getStatusPillClass,
  loadKpiThresholds, saveKpiThresholds,
  loadStatusThresholds, saveStatusThresholds,
  type StatusThresholds
} from '@/lib/utils'

type Page = 'dashboard' | 'overview'

interface BreachRow {
  entity: string
  metric: string
  value: string
  threshold: string
  severity: 'warning' | 'critical'
}

// ── Pure breach builder — accepts thresholds as params ────────────────────────
function buildBreachesForAccount(
  accId: string,
  accountData: AccountData | undefined,
  agentTimers: Record<string, number>,
  kpiTh: Thresholds,
  statusTh: StatusThresholds
): BreachRow[] {
  if (!accountData) return []
  const rows: BreachRow[] = []
  const kpi = accountData.kpi

  if (kpi) {
    const slaNum  = extractPercent(kpi.sla)
    const waitNum = parseInt(kpi.calls_waiting ?? '0')
    const ahtSecs = parseDurationToSeconds(kpi.time_to_answer)
    const ahtMins = Math.round(ahtSecs / 60)
    const abnStr  = calcAbandonRate(kpi)
    const abnNum  = extractPercent(abnStr)

    const checkKpi = (num: number, th: Thresholds[keyof Thresholds], entity: string, metric: string, value: string, thLabel: string) => {
      if (isNaN(num)) return
      const isBad = th.direction === 'desc' ? (n: number) => n <= th.crit : (n: number) => n >= th.crit
      const isWarn = th.direction === 'desc' ? (n: number) => n <= th.warn : (n: number) => n >= th.warn
      if (isBad(num))       rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical' })
      else if (isWarn(num)) rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning' })
    }

    checkKpi(slaNum,  kpiTh.sla,  'Global KPI', 'SLA',          (kpi.sla ?? '').replace(/\s+/g,''),  `≥${kpiTh.sla.targ}%`)
    if (!isNaN(waitNum) && waitNum >= 0) checkKpi(waitNum, kpiTh.wait, 'Queue', 'Queue depth', String(waitNum), String(kpiTh.wait.targ))
    if (!isNaN(ahtMins) && ahtMins > 0) checkKpi(ahtMins, kpiTh.aht, 'Global KPI', 'ASA', kpi.time_to_answer ?? '', `<${kpiTh.aht.targ}m`)
    if (!isNaN(abnNum)  && abnNum > 0)  checkKpi(abnNum,  kpiTh.abn, 'Global KPI', 'Abandon Rate', abnStr, `<${kpiTh.abn.targ}%`)
  }

  accountData.agents.forEach(a => {
    const st   = a.status ?? ''
    const thSt = statusTh[st]
    if (!thSt || thSt.crit >= 999) return
    const key  = `${accId}:${a.agent_name}`
    const secs = agentTimers[key] ?? parseDurationToSeconds(a.duration)
    const mins = secs / 60
    if (mins >= thSt.crit)      rows.push({ entity: a.agent_name, metric: `${st} Duration`, value: formatSeconds(secs), threshold: `${thSt.crit}m`, severity: 'critical' })
    else if (mins >= thSt.warn) rows.push({ entity: a.agent_name, metric: `${st} Duration`, value: formatSeconds(secs), threshold: `${thSt.warn}m`, severity: 'warning'  })
  })

  return rows
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [isDark, setIsDark]                 = useState(false)
  const [currentPage, setCurrentPage]       = useState<Page>('overview')
  const [accounts, setAccounts]             = useState<string[]>([])
  const [currentAccount, setCurrentAccount] = useState<string>('')
  const [data, setData]                     = useState<Record<string, AccountData>>({})
  const [alertAcked, setAlertAcked]         = useState(false)
  const [syncing, setSyncing]               = useState(false)
  const [agentTimers, setAgentTimers]       = useState<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen]     = useState(false)
  const [mounted, setMounted]               = useState(false)

  // Per-account thresholds
  const [kpiThresholds, setKpiThresholds]       = useState<Record<string, Thresholds>>({})
  const [statusThresholds, setStatusThresholds] = useState<Record<string, StatusThresholds>>({})

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Mark client-mounted (for portal) ──────────────────────────────────────
  useEffect(() => { setMounted(true) }, [])

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('wfm_theme')
    if (saved === 'dark') setIsDark(true)
  }, [])

  const toggleTheme = () => {
    setIsDark(d => { localStorage.setItem('wfm_theme', !d ? 'dark' : 'light'); return !d })
  }

  // ── Fetch one account ──────────────────────────────────────────────────────
  const fetchAccount = useCallback(async (accId: string) => {
    setData(prev => ({ ...prev, [accId]: { ...(prev[accId] ?? { kpi: null, agents: [], status: null, calls: [] }), syncing: true } }))
    const [kpiRes, agentsRes, statusRes, callsRes] = await Promise.all([
      supabase.from('wfm_kpi_snapshots').select('*').eq('account_id', accId).single(),
      supabase.from('wfm_agent_states').select('*').eq('account_id', accId).order('status').order('agent_name'),
      supabase.from('wfm_user_status_counts').select('*').eq('account_id', accId).single(),
      supabase.from('wfm_active_calls').select('*').eq('account_id', accId).order('updated_at', { ascending: false }),
    ])
    setData(prev => ({
      ...prev,
      [accId]: {
        kpi:    kpiRes.data    as KpiSnapshot     | null,
        agents: (agentsRes.data as AgentState[]   ) ?? [],
        status: statusRes.data as UserStatusCounts | null,
        calls:  (callsRes.data  as ActiveCall[]   ) ?? [],
        syncing: false,
      }
    }))
    const agents = (agentsRes.data as AgentState[]) ?? []
    setAgentTimers(prev => {
      const next = { ...prev }
      agents.forEach(a => { next[`${accId}:${a.agent_name}`] = parseDurationToSeconds(a.duration) })
      return next
    })
  }, [])

  // ── Initial load — also loads thresholds from localStorage ─────────────────
  useEffect(() => {
    async function init() {
      setSyncing(true)
      const { data: rows } = await supabase.from('wfm_kpi_snapshots').select('account_id').order('account_id')
      const ids: string[] = rows ? [...new Set((rows as { account_id: string }[]).map(r => r.account_id))] : []
      setAccounts(ids)

      // Load per-account thresholds from localStorage
      const kpiMap: Record<string, Thresholds>        = {}
      const statusMap: Record<string, StatusThresholds> = {}
      ids.forEach(id => {
        kpiMap[id]    = loadKpiThresholds(id)
        statusMap[id] = loadStatusThresholds(id)
      })
      setKpiThresholds(kpiMap)
      setStatusThresholds(statusMap)

      const savedAcc = localStorage.getItem('wfm_current_account')
      const first = savedAcc && ids.includes(savedAcc) ? savedAcc : (ids[0] ?? '')
      setCurrentAccount(first)
      await Promise.all(ids.map(fetchAccount))
      setSyncing(false)
    }
    init()
  }, [fetchAccount])

  // ── Realtime ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const refetch = (id: string | undefined) => { if (id) fetchAccount(id) }
    const ch = supabase.channel('wfm-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_kpi_snapshots' },      p => refetch((p.new as KpiSnapshot)?.account_id      ?? (p.old as KpiSnapshot)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_agent_states' },       p => refetch((p.new as AgentState)?.account_id       ?? (p.old as AgentState)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_user_status_counts' }, p => refetch((p.new as UserStatusCounts)?.account_id  ?? (p.old as UserStatusCounts)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_active_calls' },       p => refetch((p.new as ActiveCall)?.account_id        ?? (p.old as ActiveCall)?.account_id))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [fetchAccount])

  // ── Live agent timers ──────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setAgentTimers(prev => {
        const next: Record<string, number> = {}
        for (const k in prev) next[k] = (prev[k] ?? 0) + 1
        return next
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  // ── All breaches — uses per-account thresholds ────────────────────────────
  const allBreaches = useMemo(() => {
    const map: Record<string, BreachRow[]> = {}
    accounts.forEach(id => {
      const kpiTh    = kpiThresholds[id]    ?? DEFAULT_THRESHOLDS
      const statusTh = statusThresholds[id] ?? DEFAULT_STATUS_THRESHOLDS
      map[id] = buildBreachesForAccount(id, data[id], agentTimers, kpiTh, statusTh)
    })
    return map
  }, [accounts, data, agentTimers, kpiThresholds, statusThresholds])

  // ── Save settings for current account ─────────────────────────────────────
  const handleSaveSettings = (kpi: Thresholds, status: StatusThresholds) => {
    saveKpiThresholds(currentAccount, kpi)
    saveStatusThresholds(currentAccount, status)
    setKpiThresholds(prev => ({ ...prev, [currentAccount]: kpi }))
    setStatusThresholds(prev => ({ ...prev, [currentAccount]: status }))
  }

  const currentData = data[currentAccount]
  const breaches    = allBreaches[currentAccount] ?? []
  const stale       = isDataStale(currentData?.kpi?.updated_at)

  const switchAccount = (id: string) => {
    setCurrentAccount(id); localStorage.setItem('wfm_current_account', id); setAlertAcked(false)
  }
  const navigate = (page: Page) => { setCurrentPage(page); setAlertAcked(false) }

  return (
    <div id="layout-wrapper" className={isDark ? 'dark' : ''}>

      {/* Settings Modal — rendered via portal at document.body to escape overflow:hidden */}
      {settingsOpen && mounted && currentAccount && (
        <SettingsModal
          accountId={currentAccount}
          kpiThresholds={kpiThresholds[currentAccount] ?? DEFAULT_THRESHOLDS}
          statusThresholds={statusThresholds[currentAccount] ?? DEFAULT_STATUS_THRESHOLDS}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-brand"><i className="bx bx-pulse" /> WFM Live v2</div>
        <div className="sidebar-section">
          <label>Active Account</label>
          <select value={currentAccount} onChange={e => switchAccount(e.target.value)}>
            {accounts.length === 0 && <option>Loading...</option>}
            {accounts.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
        <div className="sidebar-menu">
          <div className="menu-label">Menu</div>
          <div className={`menu-item${currentPage === 'overview'  ? ' active' : ''}`} onClick={() => navigate('overview')}>
            <i className="bx bx-grid-alt" /> Overview
          </div>
          <div className={`menu-item${currentPage === 'dashboard' ? ' active' : ''}`} onClick={() => navigate('dashboard')}>
            <i className="bx bx-home-circle" /> Dashboard
          </div>
          <div className="menu-item" onClick={() => setSettingsOpen(true)}>
            <i className="bx bx-cog" /> Settings
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="main-content">
        <div className="topbar">
          <div className="topbar-left">
            <div className={`sync-dot${syncing ? ' syncing' : stale ? ' stale' : ''}`} title={stale ? 'Data stale' : syncing ? 'Syncing…' : 'Live'} />
            <div>
              <div className="topbar-title">
                {currentPage === 'dashboard'
                  ? `${currentAccount ? currentAccount.toUpperCase() : '—'} — Real-Time Dashboard`
                  : 'All Accounts Overview'}
              </div>
              <div className="topbar-sub">
                {currentPage === 'dashboard' && currentData?.kpi
                  ? `Last updated: ${formatTime(currentData.kpi.updated_at)}${stale ? ' ⚠ Data may be stale' : ''}`
                  : 'Live'}
              </div>
            </div>
          </div>
          <div className="topbar-right">
            <button className="btn-icon" onClick={() => setSettingsOpen(true)} title="Settings">
              <i className="bx bx-cog" />
            </button>
            <button className="btn-icon" onClick={toggleTheme} title="Toggle theme">
              <i className={`bx ${isDark ? 'bx-sun' : 'bx-moon'}`} />
            </button>
            <button className="btn-icon" onClick={() => accounts.forEach(fetchAccount)} title="Refresh all">
              <i className="bx bx-refresh" />
            </button>
          </div>
        </div>

        <div className="page-content">
          {currentPage === 'dashboard' && (
            <DashboardPage
              accountId={currentAccount}
              accountData={currentData}
              breaches={breaches}
              alertAcked={alertAcked}
              onAck={() => setAlertAcked(true)}
              agentTimers={agentTimers}
              kpiTh={kpiThresholds[currentAccount] ?? DEFAULT_THRESHOLDS}
            />
          )}
          {currentPage === 'overview' && (
            <OverviewPage
              accounts={accounts}
              data={data}
              agentTimers={agentTimers}
              allBreaches={allBreaches}
              kpiThresholds={kpiThresholds}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function DashboardPage({ accountId, accountData, breaches, alertAcked, onAck, agentTimers, kpiTh }: {
  accountId: string; accountData: AccountData | undefined; breaches: BreachRow[]
  alertAcked: boolean; onAck: () => void; agentTimers: Record<string, number>
  kpiTh: Thresholds
}) {
  if (!accountData && !accountId) return <div className="no-data">No accounts found. Check that the scraper is running.</div>

  const kpi     = accountData?.kpi
  const agents  = accountData?.agents ?? []
  const hasCrit = breaches.some(b => b.severity === 'critical')

  return (
    <>
      {breaches.length > 0 && !alertAcked && (
        <div className={`alert-banner ${hasCrit ? 'critical' : 'warning'}`}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1 }}>
            <i className={`bx ${hasCrit ? 'bx-error-circle' : 'bx-error'}`} style={{ fontSize: 20, marginTop: 1 }} />
            <ul>
              {breaches.slice(0, 5).map((b, i) => (
                <li key={i}><strong>{b.entity}</strong> — {b.metric}: <strong>{b.value}</strong> (threshold: {b.threshold})</li>
              ))}
              {breaches.length > 5 && <li>…and {breaches.length - 5} more</li>}
            </ul>
          </div>
          <button className="btn-ack" onClick={onAck}>Acknowledge</button>
        </div>
      )}

      <div className="kpi-section-title">Global Metrics</div>
      <div className="kpi-grid">
        <KpiTile label="SLA"           value={(kpi?.sla ?? 'N/A').replace(/\s+/g,'')} numValue={extractPercent(kpi?.sla)}                                    target={`Target: ≥${kpiTh.sla.targ}%`}   th={kpiTh.sla}  showBar />
        <KpiTile label="Calls Waiting" value={kpi?.calls_waiting ?? '0'}              numValue={parseInt(kpi?.calls_waiting ?? '0')}                          target="Calls in queue"                    th={kpiTh.wait} />
        <KpiTile label="ASA"           value={kpi?.time_to_answer ?? 'N/A'}           numValue={Math.round(parseDurationToSeconds(kpi?.time_to_answer) / 60)} target={`Target: <${kpiTh.aht.targ}m`}   th={kpiTh.aht}  />
        <KpiTile label="Abandon Rate"  value={calcAbandonRate(kpi ?? null)}           numValue={extractPercent(calcAbandonRate(kpi ?? null))}                  target={`Target: <${kpiTh.abn.targ}%`}   th={kpiTh.abn}  />
        {kpi?.total_calls     && <KpiTile label="Total Calls" value={kpi.total_calls}      numValue={NaN} target="Today"        th={kpiTh.sla} plain />}
        {kpi?.available_users && <KpiTile label="Available"   value={kpi.available_users}   numValue={NaN} target="Agents ready" th={kpiTh.sla} plain />}
      </div>

      <div className="tables-row">
        <div className="table-card">
          <div className="table-card-header red"><i className="bx bx-error-circle" style={{ marginRight: 6, fontSize: 15 }} />Breach / Anomalies</div>
          <div className="table-card-body">
            <table className="dash-table">
              <thead><tr><th>Queue / Agent</th><th>Metric</th><th>Value</th><th>Threshold</th></tr></thead>
              <tbody>
                {breaches.length === 0
                  ? <tr><td colSpan={4} className="no-data">No breaches detected</td></tr>
                  : breaches.map((b, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{b.entity}</td>
                      <td>{b.metric}</td>
                      <td><span className={b.severity === 'critical' ? 'badge-crit' : 'badge-warn'}>{b.value}</span></td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{b.threshold}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>

        <div className="table-card">
          <div className="table-card-header green"><i className="bx bx-user-check" style={{ marginRight: 6, fontSize: 15 }} />Agent Status</div>
          <div className="table-card-body">
            <table className="dash-table">
              <thead><tr><th>Agent</th><th>Status</th><th>Duration</th></tr></thead>
              <tbody>
                {agents.length === 0
                  ? <tr><td colSpan={3} className="no-data">No agent data</td></tr>
                  : agents.map(a => {
                    const key  = `${accountId}:${a.agent_name}`
                    const secs = agentTimers[key] ?? parseDurationToSeconds(a.duration)
                    return (
                      <tr key={a.id}>
                        <td style={{ fontWeight: 600 }}>{a.agent_name}</td>
                        <td><span className={getStatusPillClass(a.status)}>{a.status ?? '—'}</span></td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatSeconds(secs)}</td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

// ── KPI Tile ───────────────────────────────────────────────────────────────────
function KpiTile({ label, value, numValue, target, th, showBar, plain }: {
  label: string; value: string; numValue: number; target: string
  th: { warn: number; crit: number; direction: 'asc' | 'desc' }; showBar?: boolean; plain?: boolean
}) {
  const colorClass = plain ? 'text-main' : getKpiColorClass(numValue, th)
  const barWidth = showBar && !isNaN(numValue) ? Math.min(100, Math.max(0, numValue)) : 0
  const barColor = colorClass === 'text-success' ? 'var(--success)' : colorClass === 'text-warning' ? 'var(--warning)' : 'var(--danger)'
  return (
    <div className="kpi-tile">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${colorClass}`}>{value}</div>
      {showBar && <div className="kpi-bar"><div className="kpi-bar-fill" style={{ width: `${barWidth}%`, background: barColor }} /></div>}
      <div className="kpi-target">{target}</div>
    </div>
  )
}

// ── Overview Page ──────────────────────────────────────────────────────────────
function OverviewPage({ accounts, data, agentTimers, allBreaches, kpiThresholds }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>
}) {
  return (
    <>
      <div className="ov-header">
        <div>
          <div className="ov-title">All Accounts Overview</div>
          <div className="ov-sub">Real-time summary across all configured accounts</div>
        </div>
      </div>
      <OverviewMasonry accounts={accounts} data={data} agentTimers={agentTimers} allBreaches={allBreaches} kpiThresholds={kpiThresholds} />
    </>
  )
}

// ── Overview Masonry ───────────────────────────────────────────────────────────
function OverviewMasonry({ accounts, data, agentTimers, allBreaches, kpiThresholds }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>
}) {
  const [layout, setLayout] = useState<{ top: number; left: number; width: number }[]>([])
  const [gridH, setGridH]   = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs     = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    function recalc() {
      const grid = containerRef.current
      if (!grid) return
      const gap = 20; const minW = 520
      const gridW = grid.offsetWidth
      const numCols = Math.max(1, Math.floor((gridW + gap) / (minW + gap)))
      const colW = (gridW + gap) / numCols - gap
      const colHeights = Array(numCols).fill(0)
      const positions: { top: number; left: number; width: number }[] = []
      cardRefs.current.forEach(card => {
        if (!card) { positions.push({ top: 0, left: 0, width: colW }); return }
        card.style.width = `${colW}px`
        const minH = Math.min(...colHeights); const col = colHeights.indexOf(minH)
        positions.push({ top: minH, left: col * (colW + gap), width: colW })
        colHeights[col] += card.offsetHeight + gap
      })
      setLayout(positions)
      setGridH(Math.max(...colHeights, 0) - gap)
    }
    const t = setTimeout(recalc, 60)
    window.addEventListener('resize', recalc)
    return () => { clearTimeout(t); window.removeEventListener('resize', recalc) }
  }, [accounts, data, allBreaches])

  return (
    <div ref={containerRef} className="ov-grid" style={{ height: gridH }}>
      {accounts.map((accId, i) => (
        <div
          key={accId}
          ref={el => { cardRefs.current[i] = el }}
          className="ov-card"
          style={layout[i] ? { top: layout[i].top, left: layout[i].left, width: layout[i].width } : { visibility: 'hidden' }}
        >
          <OverviewCard
            accId={accId}
            accountData={data[accId]}
            agentTimers={agentTimers}
            breaches={allBreaches[accId] ?? []}
            kpiTh={kpiThresholds[accId] ?? DEFAULT_THRESHOLDS}
          />
        </div>
      ))}
    </div>
  )
}

// ── Overview Card ─────────────────────────────────────────────────────────────
function OverviewCard({ accId, accountData, agentTimers, breaches, kpiTh }: {
  accId: string; accountData: AccountData | undefined
  agentTimers: Record<string, number>; breaches: BreachRow[]
  kpiTh: Thresholds
}) {
  const kpi    = accountData?.kpi
  const status = accountData?.status
  const agents = accountData?.agents ?? []
  const stale  = isDataStale(kpi?.updated_at)
  const hasCrit = breaches.some(b => b.severity === 'critical')

  const slaNum  = extractPercent(kpi?.sla)
  const waitNum = parseInt(kpi?.calls_waiting ?? '0')
  const ahtSecs = parseDurationToSeconds(kpi?.time_to_answer)
  const ahtMins = Math.round(ahtSecs / 60)
  const abnStr  = calcAbandonRate(kpi ?? null)
  const abnNum  = extractPercent(abnStr)

  return (
    <>
      <div className="overview-card-header">
        <div className="overview-card-title">
          <i className="bx bx-buildings" />
          <span>{accId}</span>
        </div>
        <div className="overview-card-header-right">
          {breaches.length > 0 && (
            <i
              className="bx bxs-alarm ov-siren-icon"
              style={{ color: hasCrit ? 'var(--danger)' : 'var(--warning)', animation: 'ov-siren-pulse 1s infinite' }}
              title="Active breach detected"
            />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="ov-live-dot" />
            <span className="ov-live-text">Live</span>
          </div>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        {stale && (
          <div className="stale-overlay">
            <div className="stale-stamp">
              <div className="stale-stamp-icon"><i className="bx bx-error-circle" /></div>
              <div className="stale-stamp-title">DATA NOT IN SYNC</div>
              <div className="stale-stamp-sub">Not updated in 3+ minutes</div>
            </div>
          </div>
        )}
        <div className="ov-section-label">Global</div>
        <div className="ov-kpi-tiles">
          <OvKpiTile label="SLA %"    value={(kpi?.sla ?? '—').replace(/\s+/g,'')} sublabel={`Target ${kpiTh.sla.targ}%`}  colorClass={getKpiColorClass(slaNum,  kpiTh.sla)}  />
          <OvKpiTile label="Awaiting" value={kpi?.calls_waiting ?? '0'}            sublabel="Calls/Chats"                  colorClass={getKpiColorClass(waitNum, kpiTh.wait)} />
          <OvKpiTile label="ASA"      value={kpi?.time_to_answer ?? '—'}           sublabel="Handle time"                  colorClass={getKpiColorClass(ahtMins, kpiTh.aht)}  />
          <OvKpiTile label="ABN %"    value={abnStr}                               sublabel={`Target <${kpiTh.abn.targ}%`} colorClass={getKpiColorClass(abnNum,  kpiTh.abn)}  />
        </div>
      </div>

      <div className="ov-breach-section">
        <div className="ov-breach-header">
          <i className="bx bx-error-circle" />
          Breach / Anomalies
        </div>
        <table className="ov-breach-table">
          <thead><tr><th>Queue/Agent</th><th>Metric</th><th>Value</th><th>Threshold</th><th>Status</th></tr></thead>
          <tbody>
            {breaches.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--success)', fontSize: 12, padding: 14 }}>
                  <i className="bx bx-check-circle" style={{ marginRight: 5, verticalAlign: 'middle' }} />
                  No breaches detected
                </td>
              </tr>
            ) : breaches.map((b, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{b.entity}</td>
                <td>{b.metric}</td>
                <td><span className={`ov-breach-value ${b.severity}`}>{b.value}</span></td>
                <td><span style={{ color: 'var(--text-muted)' }}>{b.threshold}</span></td>
                <td><span className={`ov-status-badge ${b.severity}`}>{b.severity === 'critical' ? 'Critical' : 'Warning'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overview-card-footer">
        <i className="bx bx-time-five" />
        Updated: {kpi ? formatTime(kpi.updated_at) : 'Waiting for data...'}
        {stale && <span style={{ color: 'var(--danger)', marginLeft: 6, fontWeight: 600 }}>⚠ Stale</span>}
      </div>
    </>
  )
}

function OvKpiTile({ label, value, sublabel, colorClass }: {
  label: string; value: string; sublabel: string; colorClass: string
}) {
  return (
    <div className="ov-kpi-tile">
      <div className="ov-kpi-tile-label">{label}</div>
      <div className={`ov-kpi-tile-value ${colorClass}`}>{value}</div>
      <div className="ov-kpi-tile-sublabel">{sublabel}</div>
    </div>
  )
}
