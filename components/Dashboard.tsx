'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import SettingsModal from './SettingsModal'
import type { AccountData, Thresholds, DataSourceConfig, KpiGroup, AgentSource } from '@/lib/types'
import { loadSettings, saveSettings, loadAllSettings, loadAccounts, seedAccountsIfEmpty, addAccount, type AccountConfig } from '@/lib/settings'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  extractPercent, formatTime, formatSeconds, isDataStale, parseDurationToSeconds,
  getKpiColorClass, getStatusPillClass, resolveCell, getExtraTileColorClass,
  loadKpiThresholds, saveKpiThresholds,
  loadStatusThresholds, saveStatusThresholds,
  loadDataSource, saveDataSource,
  type StatusThresholds
} from '@/lib/utils'

type Page = 'dashboard' | 'overview'

interface BreachRow {
  entity: string; metric: string; value: string; threshold: string
  severity: 'warning' | 'critical'
}

// ── Read a value from a row using the configured column name ──────────────────
function col(row: Record<string, any> | null, colName: string): string {
  if (!row || !colName) return ''
  return String(row[colName] ?? '')
}

// ── Freshest updated_at across all of an account's KPI rows ───────────────────
// Rows are fetched with no guaranteed order, and an orphaned row from a LOB the
// scraper no longer reports (never re-written, so it stays frozen at whatever
// time it last succeeded) can otherwise get picked arbitrarily and make the
// whole card look stale even though the LOBs actually shown are live. Using the
// MAX across all rows reflects whether the account is actually being scraped.
function mostRecentUpdatedAt(rows: Record<string, any>[], colName: string): string | undefined {
  let best: string | undefined
  for (const row of rows) {
    const v = row?.[colName]
    if (!v) continue
    if (!best || new Date(v).getTime() > new Date(best).getTime()) best = v
  }
  return best
}

// ── Fetch one agent source (a table + its column mapping) and normalize its
// rows to _name/_status/_duration/_durationSecs/_agentGroup. Used for both the
// legacy single-table config (one synthetic AgentSource built from it) and
// the new multi-source array, so every downstream consumer reads the same
// shape regardless of how many tables/groups an account is configured with.
async function fetchAgentSource(src: AgentSource, accId: string): Promise<any[]> {
  if (!src.table) return []
  const accountCol = src.accountCol || 'account_id'

  let res: any = await supabase.from(src.table as any).select('*').eq(accountCol, accId)
    .order(src.statusCol || 'id').order(src.nameCol || 'id')
  if (res.error) {
    // Column names in order() might be wrong — retry without ordering
    console.warn(`[${accId}] agent order() failed on ${src.table} (${res.error.message}) — retrying without order`)
    res = await supabase.from(src.table as any).select('*').eq(accountCol, accId)
  }

  const rows = (res.data as any[]) ?? []
  return rows.map(r => ({
    ...r,
    _agentGroup:   src.groupByCol ? String(r[src.groupByCol] ?? '') : src.label,
    _name:         String(r[src.nameCol]     ?? ''),
    _status:       String(r[src.statusCol]   ?? ''),
    _duration:     String(r[src.durationCol] ?? ''),
    _durationSecs: src.durationSecsCol ? String(r[src.durationSecsCol] ?? '') : '',
  }))
}

// ── Build breaches for one account ────────────────────────────────────────────
function buildBreaches(
  accountId: string, accountData: AccountData | undefined,
  agentTimers: Record<string, number>, kpiTh: Thresholds,
  statusTh: StatusThresholds, ds: DataSourceConfig
): BreachRow[] {
  if (!accountData) return []
  const rows: BreachRow[] = []
  const kpiRows = accountData.kpiRows ?? []

  const checkKpi = (
    num: number, th: { warn: number; crit: number; direction: 'asc' | 'desc' },
    entity: string, metric: string, value: string, thLabel: string
  ) => {
    if (isNaN(num)) return
    const isCrit = th.direction === 'desc' ? num <= th.crit : num >= th.crit
    const isWarn = th.direction === 'desc' ? num <= th.warn : num >= th.warn
    if (isCrit)       rows.push({ entity, metric, value, threshold: thLabel, severity: 'critical' })
    else if (isWarn)  rows.push({ entity, metric, value, threshold: thLabel, severity: 'warning'  })
  }

  // KPI breaches — one pass per manually-defined group
  ;(ds.groups ?? []).forEach(group => {
    const g       = group.name || 'KPI'
    const rc      = (b: any) => resolveCell(kpiRows, b, ds.kpiGroupCol, group.groupVal)
    const slaRaw  = rc(group.cells.sla)
    const waitRaw = rc(group.cells.wait)
    const ahtRaw  = rc(group.cells.aht)
    const abnRaw  = rc(group.cells.abn)

    if (group.cells.sla)  checkKpi(extractPercent(slaRaw), kpiTh.sla, g, ds.kpiLabels.sla, slaRaw.replace(/\s+/g,''), `≥${kpiTh.sla.targ}%`)
    if (group.cells.wait) { const n = parseInt(waitRaw || '0'); checkKpi(n, kpiTh.wait, g, ds.kpiLabels.wait, String(n), String(kpiTh.wait.targ)) }
    if (group.cells.aht)  { const m = Math.round(parseDurationToSeconds(ahtRaw) / 60); if (m > 0) checkKpi(m, kpiTh.aht, g, ds.kpiLabels.aht, ahtRaw, `<${kpiTh.aht.targ}m`) }
    if (group.cells.abn)  checkKpi(extractPercent(abnRaw), kpiTh.abn, g, ds.kpiLabels.abn, abnRaw.replace(/\s+/g,''), `<${kpiTh.abn.targ}%`)

    // Extra custom tiles carry their own thresholds
    ;(ds.extraTiles ?? []).forEach(t => {
      if (!group.cells[t.key]) return
      const raw = rc(group.cells[t.key])
      const num = extractPercent(raw)
      if (isNaN(num)) return
      const dir: 'asc' | 'desc' = t.higherIsBetter ? 'desc' : 'asc'
      checkKpi(num, { warn: t.warn, crit: t.crit, direction: dir }, g, t.label, raw, String(t.targ))
    })
  })

  // Agent status breaches — agents are pre-normalized in fetchAccount to
  // _name/_status/_duration regardless of single-table vs agentSources.
  accountData.agents.forEach(a => {
    const status = String(a._status ?? '')
    const thSt   = statusTh[status]
    if (!thSt || thSt.crit >= 999) return
    const name  = String(a._name ?? '')
    const key   = `${accountId}:${name}`
    const secs  = agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
    const mins  = secs / 60
    const dur   = formatSeconds(secs)
    if (mins >= thSt.crit)       rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.crit}m`, severity: 'critical' })
    else if (mins >= thSt.warn)  rows.push({ entity: name, metric: `${status} Duration`, value: dur, threshold: `${thSt.warn}m`, severity: 'warning'  })
  })

  return rows
}

// ── Main Dashboard component ──────────────────────────────────────────────────
export default function Dashboard() {
  const [isDark, setIsDark]                 = useState(false)
  const [currentPage, setCurrentPage]       = useState<Page>('overview')
  const [accounts, setAccounts]             = useState<string[]>([])
  const [currentAccount, setCurrentAccount] = useState('')
  const [data, setData]                     = useState<Record<string, AccountData>>({})
  const [alertAcked, setAlertAcked]         = useState(false)
  const [agentTimers, setAgentTimers]       = useState<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen]     = useState(false)
  const [mounted, setMounted]               = useState(false)

  const [kpiThresholds, setKpiThresholds]       = useState<Record<string, Thresholds>>({})
  const [statusThresholds, setStatusThresholds] = useState<Record<string, StatusThresholds>>({})
  const [dataSources, setDataSources]           = useState<Record<string, DataSourceConfig>>({})
  const [displayNames, setDisplayNames]         = useState<Record<string, string>>({})

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const saved = localStorage.getItem('wfm_theme')
    if (saved === 'dark') setIsDark(true)
  }, [])

  // Sync dark class to <html> so portals (SettingsModal) inherit dark-mode styles
  useEffect(() => { document.documentElement.classList.toggle('dark', isDark) }, [isDark])

  const toggleTheme = () => {
    setIsDark(d => { localStorage.setItem('wfm_theme', !d ? 'dark' : 'light'); return !d })
  }

  // ── Fetch account using its configured data source ─────────────────────────
  const fetchAccount = useCallback(async (accId: string, ds?: DataSourceConfig) => {
    const src = ds ?? loadDataSource(accId)
    setData(prev => ({
      ...prev,
      [accId]: { ...(prev[accId] ?? { kpi: null, kpiRows: [], agents: [], status: null, calls: [] }), syncing: true }
    }))

    try {
      // KPI fetch — always a list of rows for the account; cell bindings resolve
      // specific values out of it (handles both wide single-row and tall tables).
      const kpiRes = src.kpiTable
        ? await supabase.from(src.kpiTable as any).select('*').eq(src.kpiAccountCol, accId)
        : { data: [] as any[] }

      // Agent fetch — either multiple sources (src.agentSources, merged and
      // tagged with a group) or the legacy single table. Either way, every
      // row comes out normalized to _name/_status/_duration/_durationSecs/
      // _agentGroup so downstream code (breaches, timers, rendering) never
      // has to branch on which path produced it.
      const agents: any[] = src.agentSources && src.agentSources.length > 0
        ? (await Promise.all(src.agentSources.map(as_ => fetchAgentSource(as_, accId)))).flat()
        : await fetchAgentSource({
            id: 'legacy', label: '', groupByCol: '',
            table: src.agentTable, accountCol: src.agentAccountCol,
            nameCol: src.agentNameCol, statusCol: src.agentStatusCol,
            durationCol: src.agentDurationCol, durationSecsCol: src.agentDurationSecs,
          }, accId)

      const kpiRows = (kpiRes.data as any[]) ?? []

      setData(prev => ({
        ...prev,
        [accId]: {
          kpi:     kpiRows[0] ?? null,
          kpiRows: kpiRows,
          agents:  agents,
          status:  null,
          calls:   [],
          syncing: false
        }
      }))

      // Update agent timers
      setAgentTimers(prev => {
        const next = { ...prev }
        agents.forEach(a => {
          const key  = `${accId}:${String(a._name ?? '')}`
          const secs = a._durationSecs
            ? (parseInt(String(a._durationSecs)) || 0)
            : parseDurationToSeconds(String(a._duration ?? ''))
          next[key] = secs
        })
        return next
      })
    } catch (err) {
      console.error(`[${accId}] fetch error:`, err)
      setData(prev => ({
        ...prev,
        [accId]: { ...(prev[accId] ?? { kpi: null, kpiRows: [], agents: [], status: null, calls: [] }), syncing: false }
      }))
    }
  }, [])

  // ── Discover accounts from all known tables ────────────────────────────────
  useEffect(() => {
    async function init() {
      // Load accounts from wfm_accounts table (user-managed)
      const accountConfigs = await loadAccounts()
      const ids = accountConfigs.map(a => a.id)
      // Store display names for use in UI
      const nameMap: Record<string, string> = {}
      accountConfigs.forEach(a => { nameMap[a.id] = a.display_name || a.id })
      setDisplayNames(nameMap)

      // Seed wfm_accounts if it's empty (first run — auto-populate from existing data)
      if (accountConfigs.length === 0) {
        const [r1, r2] = await Promise.all([
          supabase.from('wfm_kpi_snapshots').select('account_id'),
          supabase.from('talkdesk_lob_kpis').select('account_id'),
        ])
        const discovered = new Set<string>()
        ;(r1.data ?? []).forEach((r: any) => discovered.add(r.account_id))
        ;(r2.data ?? []).forEach((r: any) => discovered.add(r.account_id))
        if (discovered.size > 0) {
          await seedAccountsIfEmpty([...discovered])
          const seeded = await loadAccounts()
          ids.push(...seeded.map(a => a.id))
        }
      }

      setAccounts(ids)

      // Load per-account settings from Supabase (shared) with localStorage fallback
      const allSettings = await loadAllSettings(ids)
      const kpiMap: Record<string, Thresholds>          = {}
      const statusMap: Record<string, StatusThresholds> = {}
      const dsMap: Record<string, DataSourceConfig>     = {}
      ids.forEach(id => {
        kpiMap[id]    = allSettings[id].kpi
        statusMap[id] = allSettings[id].status
        dsMap[id]     = allSettings[id].ds
      })
      setKpiThresholds(kpiMap)
      setStatusThresholds(statusMap)
      setDataSources(dsMap)

      const savedAcc = localStorage.getItem('wfm_current_account')
      const first = savedAcc && ids.includes(savedAcc) ? savedAcc : (ids[0] ?? '')
      setCurrentAccount(first)

      // Fetch all accounts
      await Promise.all(ids.map(id => fetchAccount(id, dsMap[id])))
    }
    init()
  }, [fetchAccount])

  // ── Realtime — re-fetch on any change ─────────────────────────────────────
  useEffect(() => {
    const refetch = (table: string, accId: string | undefined) => {
      if (accId) {
        const ds = dataSources[accId]
        fetchAccount(accId, ds)
      }
    }
    const ch = supabase.channel('wfm-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_kpi_snapshots' },
          p => refetch('wfm_kpi_snapshots', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_agent_states' },
          p => refetch('wfm_agent_states', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'talkdesk_lob_kpis' },
          p => refetch('talkdesk_lob_kpis', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'talkdesk_agent_states' },
          p => refetch('talkdesk_agent_states', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'five9_kpis' },
          p => refetch('five9_kpis', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'five9_agent_states' },
          p => refetch('five9_agent_states', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'uniters_kpis' },
          p => refetch('uniters_kpis', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'uniters_agent_states' },
          p => refetch('uniters_agent_states', (p.new as any)?.account_id ?? (p.old as any)?.account_id))
      // Reload settings when another user saves them
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_accounts' }, async () => {
        const configs = await loadAccounts()
        setAccounts(configs.map(a => a.id))
        const nameMap: Record<string, string> = {}
        configs.forEach(a => { nameMap[a.id] = a.display_name || a.id })
        setDisplayNames(nameMap)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wfm_settings' }, async p => {
        const accId = (p.new as any)?.account_id ?? (p.old as any)?.account_id
        if (!accId) return
        const settings = await loadSettings(accId)
        setKpiThresholds(prev => ({ ...prev, [accId]: settings.kpi }))
        setStatusThresholds(prev => ({ ...prev, [accId]: settings.status }))
        setDataSources(prev => ({ ...prev, [accId]: settings.ds }))
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [fetchAccount, dataSources])

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

  // ── Polling fallback — re-fetch every 60s in case Realtime misses events ──
  // Realtime can miss events occasionally; this ensures data never goes stale
  useEffect(() => {
    if (accounts.length === 0) return
    const poll = setInterval(() => {
      accounts.forEach(id => fetchAccount(id, dataSources[id]))
    }, 60_000)
    return () => clearInterval(poll)
  }, [accounts, fetchAccount, dataSources])

  // ── All breaches ───────────────────────────────────────────────────────────
  const allBreaches = useMemo(() => {
    const map: Record<string, BreachRow[]> = {}
    accounts.forEach(id => {
      map[id] = buildBreaches(
        id, data[id], agentTimers,
        kpiThresholds[id] ?? DEFAULT_THRESHOLDS,
        statusThresholds[id] ?? DEFAULT_STATUS_THRESHOLDS,
        dataSources[id] ?? DEFAULT_DATA_SOURCE
      )
    })
    return map
  }, [accounts, data, agentTimers, kpiThresholds, statusThresholds, dataSources])

  // ── Save settings — writes to Supabase so all browsers sync ────────────────
  const handleSaveSettings = async (kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig) => {
    // Update local state immediately (instant UI feedback)
    setKpiThresholds(prev => ({ ...prev, [currentAccount]: kpi }))
    setStatusThresholds(prev => ({ ...prev, [currentAccount]: status }))
    setDataSources(prev => ({ ...prev, [currentAccount]: ds }))
    // Re-fetch with new data source
    fetchAccount(currentAccount, ds)
    // Persist to Supabase (shared) + localStorage (cache)
    await saveSettings(currentAccount, kpi, status, ds)
  }

  const switchAccount = (id: string) => {
    setCurrentAccount(id); localStorage.setItem('wfm_current_account', id); setAlertAcked(false)
  }
  const navigate = (page: Page) => { setCurrentPage(page); setAlertAcked(false) }

  const currentData = data[currentAccount]
  const currentDs   = dataSources[currentAccount] ?? DEFAULT_DATA_SOURCE
  const breaches    = allBreaches[currentAccount] ?? []
  const currentFreshest = currentData?.kpiRows?.length
    ? mostRecentUpdatedAt(currentData.kpiRows, currentDs.kpiUpdatedAt)
    : (currentData?.kpi ? col(currentData.kpi, currentDs.kpiUpdatedAt) : undefined)
  const stale       = isDataStale(currentFreshest)

  return (
    <div id="layout-wrapper" className={isDark ? 'dark' : ''}>

      {settingsOpen && mounted && (
        <SettingsModal
          isDark={isDark}
          accountId={currentAccount || accounts[0] || ''}
          accounts={accounts.map(id => ({ id, display_name: id, active: true, sort_order: 0 }))}
          kpiThresholds={kpiThresholds[currentAccount] ?? DEFAULT_THRESHOLDS}
          statusThresholds={statusThresholds[currentAccount] ?? DEFAULT_STATUS_THRESHOLDS}
          dataSource={dataSources[currentAccount] ?? DEFAULT_DATA_SOURCE}
          onSave={handleSaveSettings}
          onAccountsChange={async () => {
            const configs = await loadAccounts()
            const ids = configs.map(a => a.id)
            setAccounts(ids)
            // Load settings for any new accounts
            const newIds = ids.filter(id => !kpiThresholds[id])
            if (newIds.length > 0) {
              const map = await Promise.all(newIds.map(id => loadSettings(id)))
              setKpiThresholds(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].kpi }); return n })
              setStatusThresholds(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].status }); return n })
              setDataSources(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].ds }); return n })
            }
          }}
          onConfigureAccount={id => { switchAccount(id) }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-brand"><i className="bx bx-pulse" /> WFM Live</div>
        <div className="sidebar-section">
          <label>Active Account</label>
          <select value={currentAccount} onChange={e => switchAccount(e.target.value)}>
            {accounts.length === 0 && <option>Loading...</option>}
            {accounts.map(id => <option key={id} value={id}>{displayNames[id] || id}</option>)}
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
            <div className={`sync-dot${stale ? ' stale' : ' live'}`} />
            <div>
              <div className="topbar-title">
                {currentPage === 'dashboard'
                  ? `${currentAccount ? currentAccount.toUpperCase() : '—'} — Real-Time Dashboard`
                  : 'All Accounts Overview'}
              </div>
              <div className="topbar-sub">{stale ? '⚠ Data may be stale' : 'Live'}</div>
            </div>
          </div>
          <div className="topbar-right">
            <button className="btn-icon" onClick={() => setSettingsOpen(true)} title="Settings">
              <i className="bx bx-cog" />
            </button>
            <button className="btn-icon" onClick={toggleTheme} title="Toggle theme">
              <i className={`bx ${isDark ? 'bx-sun' : 'bx-moon'}`} />
            </button>
            <button className="btn-icon" onClick={() => accounts.forEach(id => fetchAccount(id, dataSources[id]))} title="Refresh">
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
              ds={currentDs}
            />
          )}
          {currentPage === 'overview' && (
            <OverviewPage
              accounts={accounts}
              data={data}
              agentTimers={agentTimers}
              allBreaches={allBreaches}
              kpiThresholds={kpiThresholds}
              dataSources={dataSources}
              displayNames={displayNames}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function DashboardPage({ accountId, accountData, breaches, alertAcked, onAck, agentTimers, kpiTh, ds }: {
  accountId: string; accountData: AccountData | undefined; breaches: BreachRow[]
  alertAcked: boolean; onAck: () => void; agentTimers: Record<string, number>
  kpiTh: Thresholds; ds: DataSourceConfig
}) {
  const agents  = accountData?.agents ?? []
  const hasCrit = breaches.some(b => b.severity === 'critical')
  const kpiRows = accountData?.kpiRows ?? []
  const groups  = ds.groups ?? []

  // Group agents by _agentGroup (set in fetchAccount from either a
  // multi-source label or a groupByCol value). Accounts with a single
  // ungrouped source — i.e. every existing account before this feature
  // existed — collapse to one group named '', which renders flat with no
  // header row, so there's no visual change unless grouping is configured.
  const agentGroups = useMemo(() => {
    const map = new Map<string, any[]>()
    agents.forEach(a => {
      const g = a._agentGroup || ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(a)
    })
    return map
  }, [agents])
  const showAgentGroupHeaders = agentGroups.size > 1

  return (
    <>
      {breaches.length > 0 && !alertAcked && (
        <div className={`alert-banner ${hasCrit ? 'critical' : 'warning'}`}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1 }}>
            <i className={`bx ${hasCrit ? 'bx-error-circle' : 'bx-error'}`} style={{ fontSize: 20 }} />
            <ul>
              {breaches.slice(0, 5).map((b, i) => (
                <li key={i}><strong>{b.entity}</strong> — {b.metric}: <strong>{b.value}</strong> ({b.threshold})</li>
              ))}
              {breaches.length > 5 && <li>…and {breaches.length - 5} more</li>}
            </ul>
          </div>
          <button className="btn-ack" onClick={onAck}>Acknowledge</button>
        </div>
      )}

      {/* KPI tiles — one set per manually-defined group */}
      {groups.map(group => (
        <div key={group.id} style={{ marginBottom: 16 }}>
          <div className="kpi-section-title">{group.name || 'Metrics'}</div>
          <KpiGrid group={group} rows={kpiRows} kpiTh={kpiTh} ds={ds} />
        </div>
      ))}

      <div className="tables-row">
        <div className="table-card">
          <div className="table-card-header red"><i className="bx bx-error-circle" style={{ marginRight: 6 }} />Breach / Anomalies</div>
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
          <div className="table-card-header green"><i className="bx bx-user-check" style={{ marginRight: 6 }} />Agent Status</div>
          <div className="table-card-body">
            <table className="dash-table">
              <thead><tr><th>Agent</th><th>Status</th><th>Duration</th></tr></thead>
              <tbody>
                {agents.length === 0
                  ? <tr><td colSpan={3} className="no-data">No agent data</td></tr>
                  : Array.from(agentGroups.entries()).flatMap(([groupName, groupAgents]) => {
                    const rows = groupAgents.map((a, i) => {
                      const name = String(a._name ?? '')
                      const key  = `${accountId}:${name}`
                      const secs = agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
                      return (
                        <tr key={`${groupName}-${i}`}>
                          <td style={{ fontWeight: 600 }}>{name}</td>
                          <td><span className={getStatusPillClass(String(a._status ?? ''))}>{String(a._status || '—')}</span></td>
                          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatSeconds(secs)}</td>
                        </tr>
                      )
                    })
                    if (!showAgentGroupHeaders || !groupName) return rows
                    return [
                      <tr key={`${groupName}-hdr`}>
                        <td colSpan={3} style={{
                          background: 'var(--bg-secondary, rgba(127,127,127,.08))', fontWeight: 700,
                          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px',
                          color: 'var(--text-muted)', padding: '6px 12px',
                        }}>{groupName}</td>
                      </tr>,
                      ...rows,
                    ]
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

// ── KPI Grid — renders one group's cell-bound tiles ───────────────────────────
function KpiGrid({ group, rows, kpiTh, ds }: {
  group: KpiGroup; rows: Record<string, any>[]; kpiTh: Thresholds; ds: DataSourceConfig
}) {
  const rc = (b: any) => resolveCell(rows, b, ds.kpiGroupCol, group.groupVal)
  const slaVal = rc(group.cells.sla).replace(/\s+/g,'')
  const waitVal = rc(group.cells.wait)
  const ahtVal  = rc(group.cells.aht)
  const abnVal  = rc(group.cells.abn)

  return (
    <div className="kpi-grid">
      <KpiTile label={ds.kpiLabels.sla}  value={slaVal || '--'}  numValue={extractPercent(slaVal)}                        target={`Target ≥${kpiTh.sla.targ}%`}  th={kpiTh.sla}  showBar />
      <KpiTile label={ds.kpiLabels.wait} value={waitVal || '--'} numValue={parseInt(waitVal)}                            target="Calls in queue"                th={kpiTh.wait} />
      <KpiTile label={ds.kpiLabels.aht}  value={ahtVal || '--'}  numValue={Math.round(parseDurationToSeconds(ahtVal)/60)} target={`Target <${kpiTh.aht.targ}m`}  th={kpiTh.aht}  />
      <KpiTile label={ds.kpiLabels.abn}  value={abnVal || '--'}  numValue={extractPercent(abnVal)}                        target={`Target <${kpiTh.abn.targ}%`} th={kpiTh.abn}  />
      {(ds.extraTiles ?? []).map(t => {
        const raw = rc(group.cells[t.key])
        return (
          <KpiTile key={t.key} label={t.label} value={raw || '--'} numValue={NaN}
            target={`Target ${t.targ}`} th={kpiTh.sla}
            colorOverride={getExtraTileColorClass(extractPercent(raw), t)} />
        )
      })}
    </div>
  )
}

function KpiTile({ label, value, numValue, target, th, showBar, plain, colorOverride }: {
  label: string; value: string; numValue: number; target: string
  th: { warn: number; crit: number; direction: 'asc' | 'desc' }; showBar?: boolean; plain?: boolean
  colorOverride?: string
}) {
  const colorClass = colorOverride ?? (plain ? 'text-main' : getKpiColorClass(numValue, th))
  const barW = showBar && !isNaN(numValue) ? Math.min(100, Math.max(0, numValue)) : 0
  const barColor = colorClass === 'text-success' ? 'var(--success)' : colorClass === 'text-warning' ? 'var(--warning)' : 'var(--danger)'
  return (
    <div className="kpi-tile">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${colorClass}`}>{value}</div>
      {showBar && <div className="kpi-bar"><div className="kpi-bar-fill" style={{ width: `${barW}%`, background: barColor }} /></div>}
      <div className="kpi-target">{target}</div>
    </div>
  )
}

// ── Overview Page ──────────────────────────────────────────────────────────────
function OverviewPage({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
}) {
  return (
    <>
      <div className="ov-header">
        <div>
          <div className="ov-title">All Accounts Overview</div>
          <div className="ov-sub">Real-time summary across all configured accounts</div>
        </div>
      </div>
      <OverviewMasonry
        accounts={accounts} data={data} agentTimers={agentTimers}
        allBreaches={allBreaches} kpiThresholds={kpiThresholds} dataSources={dataSources}
        displayNames={displayNames}
      />
    </>
  )
}

function OverviewMasonry({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
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
        const minH = Math.min(...colHeights); const cIdx = colHeights.indexOf(minH)
        positions.push({ top: minH, left: cIdx * (colW + gap), width: colW })
        colHeights[cIdx] += card.offsetHeight + gap
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
            displayName={displayNames[accId] || accId}
            accountData={data[accId]}
            agentTimers={agentTimers}
            breaches={allBreaches[accId] ?? []}
            kpiTh={kpiThresholds[accId] ?? DEFAULT_THRESHOLDS}
            ds={dataSources[accId] ?? DEFAULT_DATA_SOURCE}
          />
        </div>
      ))}
    </div>
  )
}

// ── Overview Card ─────────────────────────────────────────────────────────────
function OverviewCard({ accId, displayName, accountData, agentTimers, breaches, kpiTh, ds }: {
  accId: string; displayName: string; accountData: AccountData | undefined
  agentTimers: Record<string, number>; breaches: BreachRow[]
  kpiTh: Thresholds; ds: DataSourceConfig
}) {
  const kpiRows = accountData?.kpiRows ?? []
  const groups  = ds.groups ?? []
  const freshestUpdatedAt = mostRecentUpdatedAt(kpiRows, ds.kpiUpdatedAt)
  const stale   = isDataStale(freshestUpdatedAt)
  const hasCrit = breaches.some(b => b.severity === 'critical')

  return (
    <>
      <div className="overview-card-header">
        <div className="overview-card-title">
          <i className="bx bx-buildings" />
          <span>{displayName}</span>
          {displayName !== accId && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>
              ({accId})
            </span>
          )}
        </div>
        <div className="overview-card-header-right">
          {breaches.length > 0 && (
            <i className="bx bxs-alarm ov-siren-icon"
              style={{ color: hasCrit ? 'var(--danger)' : 'var(--warning)', animation: 'ov-siren-pulse 1s infinite' }} />
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

        {/* KPI tiles — one set per manually-defined group */}
        {groups.map(group => {
          const rc      = (b: any) => resolveCell(kpiRows, b, ds.kpiGroupCol, group.groupVal)
          const slaVal  = rc(group.cells.sla).replace(/\s+/g,'')
          const waitVal = rc(group.cells.wait)
          const ahtVal  = rc(group.cells.aht)
          const abnVal  = rc(group.cells.abn)
          return (
            <div key={group.id} style={{ marginBottom: 10 }}>
              <div className="ov-section-label">{group.name || 'Global'}</div>
              <div className="ov-kpi-tiles">
                {group.cells.sla  && <OvKpiTile label={ds.kpiLabels.sla}  value={slaVal}  sublabel={`Target ${kpiTh.sla.targ}%`}  colorClass={getKpiColorClass(extractPercent(slaVal), kpiTh.sla)} />}
                {group.cells.wait && <OvKpiTile label={ds.kpiLabels.wait} value={waitVal} sublabel="In queue"                     colorClass={getKpiColorClass(parseInt(waitVal)||0, kpiTh.wait)} />}
                {group.cells.aht  && <OvKpiTile label={ds.kpiLabels.aht}  value={ahtVal}  sublabel="Handle time"                  colorClass="text-main" />}
                {group.cells.abn  && <OvKpiTile label={ds.kpiLabels.abn}  value={abnVal}  sublabel={`Target <${kpiTh.abn.targ}%`} colorClass={getKpiColorClass(extractPercent(abnVal), kpiTh.abn)} />}
                {(ds.extraTiles ?? []).map(t => {
                  if (!group.cells[t.key]) return null
                  const raw = rc(group.cells[t.key])
                  return <OvKpiTile key={t.key} label={t.label} value={raw} sublabel={`Target ${t.targ}`} colorClass={getExtraTileColorClass(extractPercent(raw), t)} />
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Breach table */}
      <div className="ov-breach-section">
        <div className="ov-breach-header"><i className="bx bx-error-circle" /> Breach / Anomalies</div>
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
                <td style={{ color: 'var(--text-muted)' }}>{b.threshold}</td>
                <td><span className={`ov-status-badge ${b.severity}`}>{b.severity === 'critical' ? 'Critical' : 'Warning'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overview-card-footer">
        <i className="bx bx-time-five" />
        Updated: {freshestUpdatedAt ? formatTime(freshestUpdatedAt) : 'Waiting for data...'}
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
      <div className={`ov-kpi-tile-value ${colorClass}`}>{value || '--'}</div>
      <div className="ov-kpi-tile-sublabel">{sublabel}</div>
    </div>
  )
}