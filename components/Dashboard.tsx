'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import SettingsModal from './SettingsModal'
import type { AccountData, Thresholds, DataSourceConfig, KpiGroup, AgentSource, DashboardLayout, PanelRect, HeaderColors, CliqGlobalSettings } from '@/lib/types'
import { buildBreaches, mostRecentUpdatedAt, type BreachRow } from '@/lib/breaches'
import {
  loadSettings, saveSettings, saveDashboardLayout, saveHeaderColors, loadAllSettings, loadAccounts, seedAccountsIfEmpty, addAccount,
  loadCliqSettings, saveCliqSettings, DEFAULT_CLIQ_GLOBAL_SETTINGS,
  type AccountConfig
} from '@/lib/settings'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  extractPercent, formatTime, formatSeconds, isDataStale, parseDurationToSeconds, isCoarseDuration,
  getKpiColorClass, getStatusPillClass, resolveCell, getExtraTileColorClass,
  loadKpiThresholds, saveKpiThresholds,
  loadStatusThresholds, saveStatusThresholds,
  loadDataSource, saveDataSource,
  defaultDashboardLayout,
  type StatusThresholds
} from '@/lib/utils'

type Page = 'dashboard' | 'overview'

// Stable reference (not a fresh {} literal) so passing this as a fallback
// prop doesn't look like a changed value on every render — an unstable
// fallback here would make DashboardPage's layout-sync effect fire on every
// single render instead of just when the layout actually changes.
const EMPTY_LAYOUT: DashboardLayout = {}
const DEFAULT_HEADER_COLORS: HeaderColors = { band: '', text: '' }

// ── Read a value from a row using the configured column name ──────────────────
function col(row: Record<string, any> | null, colName: string): string {
  if (!row || !colName) return ''
  return String(row[colName] ?? '')
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
  const [dashboardLayouts, setDashboardLayouts] = useState<Record<string, DashboardLayout>>({})
  const [headerColors, setHeaderColors]         = useState<Record<string, HeaderColors>>({})
  const [cliqChannels, setCliqChannels]         = useState<Record<string, string>>({})
  const [cliqGlobal, setCliqGlobal]             = useState<CliqGlobalSettings>(DEFAULT_CLIQ_GLOBAL_SETTINGS)
  const [displayNames, setDisplayNames]         = useState<Record<string, string>>({})

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Keys whose latest scraped duration text is day/hour-only (e.g. "5d 4h") —
  // no minute/second precision to tick live from, so the 1s clock below skips
  // them and just shows whatever the last poll actually reported.
  const coarseKeysRef = useRef<Set<string>>(new Set())
  // Debounce timers for the Realtime refetch — a single scraper write batch
  // (e.g. 20+ agents upserted at once) fires one change event PER ROW, so
  // without this a burst of simultaneous events for the same account was
  // triggering that many fully-redundant fetchAccount() calls back to back.
  const refetchTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

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

      // Agent fetch — the legacy single table (if set) PLUS every configured
      // agentSources entry, all combined. "Additional Agent Sources" means
      // additional to the table above, not instead of it — every row comes
      // out normalized to _name/_status/_duration/_durationSecs/_agentGroup
      // so downstream code (breaches, timers, rendering) never has to branch
      // on which source produced it.
      const agentSourcesToFetch: AgentSource[] = []
      if (src.agentTable) {
        agentSourcesToFetch.push({
          id: 'legacy', label: src.agentTable, groupByCol: '',
          table: src.agentTable, accountCol: src.agentAccountCol,
          nameCol: src.agentNameCol, statusCol: src.agentStatusCol,
          durationCol: src.agentDurationCol, durationSecsCol: src.agentDurationSecs,
        })
      }
      if (src.agentSources) agentSourcesToFetch.push(...src.agentSources)
      const agents: any[] = (await Promise.all(agentSourcesToFetch.map(as_ => fetchAgentSource(as_, accId)))).flat()

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
          // parseDurationToSeconds (not parseInt) for BOTH fields — it already
          // handles a plain integer string correctly, but also correctly
          // parses "HH:MM:SS"/"MM:SS" text. parseInt() on "01:55:04" silently
          // returns 1 (stops at the colon), so if "Duration (secs)" ever gets
          // mapped to a formatted-text column by mistake (e.g. a duration
          // column reused for both slots), every agent's real time was
          // getting thrown away in favor of ~0-1s, then all ticking up
          // together from the shared 1s/interval clock below — which is why
          // every agent showed the same tiny number instead of their actual
          // duration.
          const raw  = String(a._durationSecs || a._duration || '')
          const secs = parseDurationToSeconds(raw)
          next[key] = secs
          if (isCoarseDuration(raw)) coarseKeysRef.current.add(key)
          else coarseKeysRef.current.delete(key)
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
      const layoutMap: Record<string, DashboardLayout>  = {}
      const colorMap: Record<string, HeaderColors>      = {}
      const cliqChanMap: Record<string, string>         = {}
      ids.forEach(id => {
        kpiMap[id]      = allSettings[id].kpi
        statusMap[id]   = allSettings[id].status
        dsMap[id]       = allSettings[id].ds
        layoutMap[id]   = allSettings[id].layout
        colorMap[id]    = allSettings[id].headerColors
        cliqChanMap[id] = allSettings[id].cliqChannel
      })
      setKpiThresholds(kpiMap)
      setStatusThresholds(statusMap)
      setDataSources(dsMap)
      setDashboardLayouts(layoutMap)
      setHeaderColors(colorMap)
      setCliqChannels(cliqChanMap)
      loadCliqSettings().then(setCliqGlobal)

      const savedAcc = localStorage.getItem('wfm_current_account')
      const first = savedAcc && ids.includes(savedAcc) ? savedAcc : (ids[0] ?? '')
      setCurrentAccount(first)

      // Fetch all accounts
      await Promise.all(ids.map(id => fetchAccount(id, dsMap[id])))
    }
    init()
  }, [fetchAccount])

  // ── Realtime — TEMPORARILY DISABLED (band-aid) ──────────────────────────────
  // Supabase bills Realtime messages per-recipient (1 change × N listening
  // tabs = N messages counted) — so viewer count alone, independent of how
  // clean the trigger logic is, was on track to blow past the 5M/mo org-wide
  // quota once real-time monitoring analysts start watching this in bulk
  // (10-20+ concurrent tabs, mostly on the all-accounts Overview page). Turned
  // off entirely until the self-hosted webhook-relay replacement ships — the
  // 30s poll below (a few lines down) is now the sole refresh mechanism. That
  // poll bills under API Gateway, a completely separate quota nowhere near
  // its limit. Flip REALTIME_ENABLED back to true once the relay is ready —
  // everything below is untouched and will just work again.
  const REALTIME_ENABLED = false
  useEffect(() => {
    if (!REALTIME_ENABLED) return
    // Debounced: a single scraper write batch fires one event per row, so a
    // burst of N events for the same account within the window collapses
    // into exactly one fetchAccount() call (the last one to fire wins).
    const refetch = (table: string, accId: string | undefined) => {
      if (!accId) return
      if (refetchTimersRef.current[accId]) clearTimeout(refetchTimersRef.current[accId])
      refetchTimersRef.current[accId] = setTimeout(() => {
        delete refetchTimersRef.current[accId]
        const ds = dataSources[accId]
        fetchAccount(accId, ds)
      }, 500)
    }
    const ch = supabase.channel('wfm-realtime')
      // Agent status tables no longer use postgres_changes — a DB trigger
      // (sql/realtime_status_broadcast.sql) only broadcasts on this single
      // 'status_change' event when an agent's status column actually differs
      // from before, instead of on every write (which fired every ~30s per
      // agent regardless of whether anything changed, since updated_at always
      // bumps). Same tables (wfm_agent_states/talkdesk_agent_states/
      // five9_agent_states/uniters_agent_states), far fewer messages.
      .on('broadcast', { event: 'status_change' },
          p => refetch((p.payload as any)?.table, (p.payload as any)?.account_id))
      // Same idea for the KPI tables (wfm_kpi_snapshots/talkdesk_lob_kpis/
      // five9_kpis/uniters_kpis) — sql/realtime_kpi_broadcast.sql only
      // broadcasts 'kpi_change' when a row's actual values differ from
      // before (whole-row compare, ignoring id/account_id/updated_at), not
      // on every unconditional ~30s write.
      .on('broadcast', { event: 'kpi_change' },
          p => refetch((p.payload as any)?.table, (p.payload as any)?.account_id))
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
        setDashboardLayouts(prev => ({ ...prev, [accId]: settings.layout }))
        setHeaderColors(prev => ({ ...prev, [accId]: settings.headerColors }))
        setCliqChannels(prev => ({ ...prev, [accId]: settings.cliqChannel }))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
      Object.values(refetchTimersRef.current).forEach(clearTimeout)
      refetchTimersRef.current = {}
    }
  }, [fetchAccount, dataSources])

  // ── Live agent timers ──────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setAgentTimers(prev => {
        const next: Record<string, number> = {}
        for (const k in prev) next[k] = coarseKeysRef.current.has(k) ? prev[k] : (prev[k] ?? 0) + 1
        return next
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  // ── Polling — sole data refresh mechanism while Realtime is disabled ──────
  // 30s matches the scraper's own write cadence exactly — polling faster
  // (e.g. 15s) can't surface fresher data than this, since the source itself
  // only updates every 30s; it would just double the request count for no
  // benefit. Billed under API Gateway, not Realtime Messages.
  useEffect(() => {
    if (accounts.length === 0) return
    const poll = setInterval(() => {
      accounts.forEach(id => fetchAccount(id, dataSources[id]))
    }, 30_000)
    return () => clearInterval(poll)
  }, [accounts, fetchAccount, dataSources])

  // ── Auto-reload on new deployment ───────────────────────────────────────────
  // A tab that's been open since before a deploy keeps running the OLD JS
  // bundle forever — including its old Realtime subscription config — since
  // a server-side deploy can't retroactively update code already loaded in a
  // browser. This polls /api/version (always reads the live deployment's
  // commit SHA fresh) and compares it to the SHA baked into THIS tab's bundle
  // at build time; a mismatch means a newer build has shipped since this tab
  // loaded, so it reloads itself to pick it up. Skips while Settings is open
  // so an in-progress edit isn't interrupted — it'll just check again next
  // interval once closed.
  useEffect(() => {
    const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA
    if (!BUILD_SHA || BUILD_SHA === 'dev') return // skip in local dev
    const checkVersion = async () => {
      if (settingsOpen) return
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        const { sha } = await res.json()
        if (sha && sha !== BUILD_SHA) {
          console.log('[version] New deployment detected — reloading to pick it up')
          window.location.reload()
        }
      } catch {}
    }
    const interval = setInterval(checkVersion, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [settingsOpen])

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
  const handleSaveSettings = async (kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig, cliqChannel: string) => {
    // Update local state immediately (instant UI feedback)
    setKpiThresholds(prev => ({ ...prev, [currentAccount]: kpi }))
    setStatusThresholds(prev => ({ ...prev, [currentAccount]: status }))
    setDataSources(prev => ({ ...prev, [currentAccount]: ds }))
    setCliqChannels(prev => ({ ...prev, [currentAccount]: cliqChannel }))
    // Re-fetch with new data source
    fetchAccount(currentAccount, ds)
    // Persist to Supabase (shared) + localStorage (cache)
    await saveSettings(currentAccount, kpi, status, ds, cliqChannel)
  }

  // ── Save one account's Overview header colors — instant, like layout drag ──
  const updateHeaderColors = (accId: string, patch: Partial<HeaderColors>) => {
    const next = { ...(headerColors[accId] ?? DEFAULT_HEADER_COLORS), ...patch }
    setHeaderColors(prev => ({ ...prev, [accId]: next }))
    saveHeaderColors(accId, next)
  }

  // ── Save the global Cliq notification settings (shared across all accounts) ─
  const handleSaveCliqGlobal = (settings: CliqGlobalSettings) => {
    setCliqGlobal(settings)
    saveCliqSettings(settings)
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
          cliqChannel={cliqChannels[currentAccount] ?? ''}
          cliqGlobalSettings={cliqGlobal}
          onSave={handleSaveSettings}
          onSaveCliqGlobal={handleSaveCliqGlobal}
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
              setDashboardLayouts(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].layout }); return n })
              setHeaderColors(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].headerColors }); return n })
              setCliqChannels(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].cliqChannel }); return n })
            }
          }}
          onConfigureAccount={id => { switchAccount(id) }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Top navigation bar — replaces the old left sidebar */}
      <div className="top-nav">
        <div className="top-nav-brand"><i className="bx bx-pulse" /> WFM Live</div>
        <div className="top-nav-account">
          <i className="bx bx-buildings" title="Active account" />
          <select value={currentAccount} onChange={e => switchAccount(e.target.value)}>
            {accounts.length === 0 && <option>Loading...</option>}
            {accounts.map(id => <option key={id} value={id}>{displayNames[id] || id}</option>)}
          </select>
        </div>
        <div className="top-nav-menu">
          <div className={`top-nav-item${currentPage === 'overview'  ? ' active' : ''}`} onClick={() => navigate('overview')}>
            <i className="bx bx-grid-alt" /> Overview
          </div>
          <div className={`top-nav-item${currentPage === 'dashboard' ? ' active' : ''}`} onClick={() => navigate('dashboard')}>
            <i className="bx bx-home-circle" /> Dashboard
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
              statusTh={statusThresholds[currentAccount] ?? DEFAULT_STATUS_THRESHOLDS}
              ds={currentDs}
              layout={dashboardLayouts[currentAccount] ?? EMPTY_LAYOUT}
              onLayoutChange={layout => {
                setDashboardLayouts(prev => ({ ...prev, [currentAccount]: layout }))
                saveDashboardLayout(currentAccount, layout)
              }}
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
              headerColors={headerColors}
              onHeaderColorsChange={updateHeaderColors}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Column filter popup — checkbox list + Select All + Apply/Cancel ──────────
// A fixed full-screen click-catcher sits behind the popup so clicking anywhere
// outside it closes without applying (same effect as Cancel).
function ColumnFilterPopup({ options, selected, onApply, onClose }: {
  options: string[]; selected: Set<string> | null
  onApply: (vals: Set<string> | null) => void; onClose: () => void
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected ?? options))
  const allChecked = checked.size === options.length
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(options))
  const toggle = (v: string) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v); else next.add(v)
    return next
  })
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} onClick={onClose} />
      <div onClick={e => e.stopPropagation()} style={{
        position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 201,
        background: 'var(--bg-card,#fff)', border: '1px solid var(--border,#e1e6e4)',
        borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.3)', width: 200,
        maxHeight: 280, display: 'flex', flexDirection: 'column', fontSize: 12,
        textTransform: 'none', fontWeight: 400, color: 'var(--text-main)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
          borderBottom: '1px solid var(--border,#e1e6e4)', fontWeight: 700, cursor: 'pointer' }}>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} /> Select All
        </label>
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
          {options.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>No values</div>}
          {options.map(v => (
            <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer' }}>
              <input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} /> {v || '(blank)'}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--border,#e1e6e4)' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '6px 8px', borderRadius: 6,
            border: '1px solid var(--border,#e1e6e4)', background: 'transparent', color: 'var(--text-main)',
            cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={() => { onApply(checked.size === options.length ? null : checked); onClose() }}
            style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: 'none', background: '#3b82f6',
            color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Apply</button>
        </div>
      </div>
    </>
  )
}

// ── A <th> that opens a ColumnFilterPopup on click; only one open at a time
// across the table (managed by the parent via isOpen/onToggle/onClose).
// Small sort indicator shared by SortableTh and FilterableTh — neutral icon
// when this column isn't the active sort, a directional chevron when it is.
function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <i className={`bx ${active ? (dir === 'asc' ? 'bx-chevron-up' : 'bx-chevron-down') : 'bx-sort-alt-2'}`}
      style={{ fontSize: 13, color: active ? '#3b82f6' : 'var(--text-muted)' }} />
  )
}

// Plain sortable header — click anywhere to toggle asc/desc (or set this as
// the sort column if a different one was active).
function SortableTh({ label, active, dir, onClick }: {
  label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void
}) {
  return (
    <th onClick={onClick} style={{ cursor: 'pointer', userSelect: 'none' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <SortIcon active={active} dir={dir} />
      </span>
    </th>
  )
}

function FilterableTh({ label, options, filter, isOpen, onToggle, onClose, onApply, sortActive, sortDir, onSort }: {
  label: string; options: string[]; filter: Set<string> | null
  isOpen: boolean; onToggle: () => void; onClose: () => void; onApply: (vals: Set<string> | null) => void
  sortActive: boolean; sortDir: 'asc' | 'desc'; onSort: () => void
}) {
  const active = filter !== null
  return (
    // th itself stays untouched — .dash-table thead th is `position: sticky`
    // via CSS, and an inline position:relative here would silently override
    // it and break the sticky header while scrolling. The popup anchors off
    // this inner wrapper instead.
    <th>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {/* Clicking the label sorts; clicking the funnel icon opens the
            filter popup instead — stopPropagation so one click doesn't
            trigger both. */}
        <span onClick={onSort} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
          {label}
          <SortIcon active={sortActive} dir={sortDir} />
        </span>
        <i className="bx bx-filter" onClick={e => { e.stopPropagation(); onToggle() }}
          style={{ cursor: 'pointer', fontSize: 13, color: active ? '#3b82f6' : 'var(--text-muted)' }} />
        {isOpen && <ColumnFilterPopup options={options} selected={filter} onApply={onApply} onClose={onClose} />}
      </div>
    </th>
  )
}

// ── Draggable/resizable panel wrapper ─────────────────────────────────────────
// Plain DOM mouse events, not a grid-layout library — this codebase already
// has a hand-rolled drag pattern (SettingsModal's makeDraggable) that works
// fine on this project's React 19; a third-party drag/resize library's React
// 19 support is less certain, so this avoids that risk for zero added weight.
//
// Drag the header to move; grab any edge/corner handle to resize. rect always
// comes from the parent (source of truth) — onChange fires continuously while
// dragging/resizing for live visual feedback, onCommit fires once on mouseup
// to persist. A ref tracks the in-flight rect during a drag so onCommit always
// reads the latest value even though the mousemove/mouseup listeners were
// attached before this render's `rect` prop existed (avoids a stale-closure
// bug where releasing the mouse would save the position from BEFORE the drag).
function LayoutPanel({ id, rect, minW = 260, minH = 120, headerColor, title, icon, children, onChange, onCommit }: {
  id: string; rect: PanelRect; minW?: number; minH?: number
  headerColor?: string; title: React.ReactNode; icon?: string
  children: React.ReactNode
  onChange: (id: string, rect: PanelRect) => void
  onCommit: (id: string, rect: PanelRect) => void
}) {
  const liveRect  = useRef(rect)
  const dragState = useRef<{ mode: 'move'; startX: number; startY: number; orig: PanelRect } | { mode: 'resize'; edge: string; startX: number; startY: number; orig: PanelRect } | null>(null)

  useEffect(() => { liveRect.current = rect }, [rect])

  function clamp(r: PanelRect): PanelRect {
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.max(minW, r.w), h: Math.max(minH, r.h) }
  }

  function onMouseMove(e: MouseEvent) {
    const st = dragState.current
    if (!st) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    let next: PanelRect
    if (st.mode === 'move') {
      next = clamp({ ...st.orig, x: st.orig.x + dx, y: st.orig.y + dy })
    } else {
      next = { ...st.orig }
      if (st.edge.includes('right'))  next.w = st.orig.w + dx
      if (st.edge.includes('bottom')) next.h = st.orig.h + dy
      if (st.edge.includes('left'))   { next.w = st.orig.w - dx; next.x = st.orig.x + dx }
      if (st.edge.includes('top'))    { next.h = st.orig.h - dy; next.y = st.orig.y + dy }
      next = clamp(next)
    }
    liveRect.current = next
    onChange(id, next)
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    if (dragState.current) onCommit(id, liveRect.current)
    dragState.current = null
  }

  function startMove(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.panel-resize-handle')) return
    dragState.current = { mode: 'move', startX: e.clientX, startY: e.clientY, orig: rect }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    e.preventDefault()
  }

  function startResize(edge: string) {
    return (e: React.MouseEvent) => {
      dragState.current = { mode: 'resize', edge, startX: e.clientX, startY: e.clientY, orig: rect }
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const handleStyle: React.CSSProperties = { position: 'absolute', zIndex: 2 }
  return (
    <div className="panel" style={{
      position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h,
      background: 'var(--bg-card, #fff)', border: '1px solid var(--border,#e1e6e4)',
      borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      boxShadow: '0 1px 3px rgba(0,0,0,.08)',
    }}>
      <div onMouseDown={startMove} className="panel-header" style={{
        background: headerColor || 'var(--bg-secondary, rgba(127,127,127,.08))',
        color: headerColor ? '#fff' : 'var(--text-main)',
        padding: '8px 12px', fontWeight: 700, fontSize: 12, cursor: 'move',
        display: 'flex', alignItems: 'center', flexShrink: 0, userSelect: 'none',
      }}>
        {icon && <i className={`bx ${icon}`} style={{ marginRight: 6 }} />}
        {title}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {children}
      </div>

      {/* Resize handles — right/bottom edges + bottom-right corner */}
      <div className="panel-resize-handle" onMouseDown={startResize('right')}
        style={{ ...handleStyle, top: 0, right: 0, width: 6, height: '100%', cursor: 'ew-resize' }} />
      <div className="panel-resize-handle" onMouseDown={startResize('bottom')}
        style={{ ...handleStyle, left: 0, bottom: 0, width: '100%', height: 6, cursor: 'ns-resize' }} />
      <div className="panel-resize-handle" onMouseDown={startResize('bottom-right')}
        style={{ ...handleStyle, right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
    </div>
  )
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function DashboardPage({ accountId, accountData, breaches, alertAcked, onAck, agentTimers, kpiTh, statusTh, ds, layout, onLayoutChange }: {
  accountId: string; accountData: AccountData | undefined; breaches: BreachRow[]
  alertAcked: boolean; onAck: () => void; agentTimers: Record<string, number>
  kpiTh: Thresholds; statusTh: StatusThresholds; ds: DataSourceConfig
  layout: DashboardLayout; onLayoutChange: (layout: DashboardLayout) => void
}) {
  const agents  = accountData?.agents ?? []
  const hasCrit = breaches.some(b => b.severity === 'critical')
  const kpiRows = accountData?.kpiRows ?? []
  const groups  = ds.groups ?? []

  // Merge saved overrides on top of computed defaults so any group not yet
  // positioned (a brand-new KPI group, or a fresh account with no custom
  // layout saved at all) still gets a sensible starting spot.
  const panelIds = useMemo(() => [...groups.map(g => `kpi:${g.id}`), 'breach', 'agents'], [groups])
  const effectiveLayout = useMemo(() => {
    const defaults = defaultDashboardLayout(groups.map(g => g.id))
    const merged: DashboardLayout = {}
    panelIds.forEach(id => { merged[id] = layout[id] ?? defaults[id] })
    return merged
  }, [layout, panelIds, groups])

  // Live-update during drag/resize (no save); commit (save) once on release.
  const [liveLayout, setLiveLayout] = useState(effectiveLayout)
  useEffect(() => { setLiveLayout(effectiveLayout) }, [effectiveLayout])
  const handlePanelChange = (id: string, rect: PanelRect) => setLiveLayout(prev => ({ ...prev, [id]: rect }))
  const handlePanelCommit = (id: string, rect: PanelRect) => {
    const next = { ...layout, [id]: rect }
    onLayoutChange(next)
  }

  const containerHeight = Math.max(...panelIds.map(id => {
    const r = liveLayout[id] ?? effectiveLayout[id]
    return r ? r.y + r.h : 0
  }), 200) + 20

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

  // Agent Status column filters — Excel-style: click a header, check/uncheck
  // values, Apply. null = no filter (show everything) for that column.
  const [nameFilter,   setNameFilter]   = useState<Set<string> | null>(null)
  const [statusFilter, setStatusFilter] = useState<Set<string> | null>(null)
  const [openFilterCol, setOpenFilterCol] = useState<'name' | 'status' | null>(null)
  const nameOptions   = useMemo(() => Array.from(new Set(agents.map(a => String(a._name   ?? '')))).sort(), [agents])
  const statusOptions = useMemo(() => Array.from(new Set(agents.map(a => String(a._status ?? '')))).sort(), [agents])
  const passesAgentFilters = (a: any) =>
    !statusTh[String(a._status ?? '')]?.excluded &&
    (!nameFilter   || nameFilter.has(String(a._name   ?? ''))) &&
    (!statusFilter || statusFilter.has(String(a._status ?? '')))

  // Agent Status sort — click a header to sort by it; click the same header
  // again to flip direction. Duration sorts by actual seconds (agentTimers/
  // parsed), not the formatted "1h 55m" string, so it orders correctly.
  type AgentSortCol = 'name' | 'status' | 'duration'
  const [agentSort, setAgentSort] = useState<{ col: AgentSortCol; dir: 'asc' | 'desc' } | null>(null)
  const toggleAgentSort = (col: AgentSortCol) =>
    setAgentSort(prev => prev && prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  const agentSortValue = (a: any, col: AgentSortCol): string | number => {
    if (col === 'name')   return String(a._name ?? '').toLowerCase()
    if (col === 'status') return String(a._status ?? '').toLowerCase()
    const key = `${accountId}:${String(a._name ?? '')}`
    return agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
  }
  const sortAgentRows = (list: any[]): any[] => {
    if (!agentSort) return list
    const { col, dir } = agentSort
    return [...list].sort((a, b) => {
      const av = agentSortValue(a, col), bv = agentSortValue(b, col)
      if (av < bv) return dir === 'asc' ? -1 : 1
      if (av > bv) return dir === 'asc' ? 1 : -1
      return 0
    })
  }

  // Breach / Anomalies sort — same click-to-toggle pattern. Tries a numeric
  // compare first (Value/Threshold carry units like "76" or "<3%"), falling
  // back to a case-insensitive string compare for purely textual columns.
  type BreachSortCol = 'entity' | 'metric' | 'value' | 'threshold'
  const [breachSort, setBreachSort] = useState<{ col: BreachSortCol; dir: 'asc' | 'desc' } | null>(null)
  const toggleBreachSort = (col: BreachSortCol) =>
    setBreachSort(prev => prev && prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  const sortedBreaches = useMemo(() => {
    if (!breachSort) return breaches
    const { col, dir } = breachSort
    return [...breaches].sort((a, b) => {
      const rawA = String(a[col] ?? ''), rawB = String(b[col] ?? '')
      const numA = parseFloat(rawA), numB = parseFloat(rawB)
      const cmp = (!isNaN(numA) && !isNaN(numB)) ? numA - numB : rawA.toLowerCase().localeCompare(rawB.toLowerCase())
      return dir === 'asc' ? cmp : -cmp
    })
  }, [breaches, breachSort])

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

      {/* Every panel below is freely draggable (grab the header) and
          resizable (grab any edge/corner) — position/size persist per
          account. Container height grows to fit whatever's been dragged. */}
      <div style={{ position: 'relative', height: containerHeight }}>
        {groups.map(group => (
          <LayoutPanel key={group.id} id={`kpi:${group.id}`} rect={liveLayout[`kpi:${group.id}`] ?? effectiveLayout[`kpi:${group.id}`]}
            title={group.name || 'Metrics'} onChange={handlePanelChange} onCommit={handlePanelCommit}>
            <div style={{ padding: 12 }}>
              <KpiGrid group={group} rows={kpiRows} kpiTh={kpiTh} ds={ds} />
            </div>
          </LayoutPanel>
        ))}

        <LayoutPanel id="breach" rect={liveLayout.breach ?? effectiveLayout.breach} headerColor="var(--danger,#c0392b)" icon="bx-error-circle"
          title="Breach / Anomalies" onChange={handlePanelChange} onCommit={handlePanelCommit}>
          <table className="dash-table">
            <thead>
              <tr>
                <SortableTh label="Queue / Agent" active={breachSort?.col === 'entity'}    dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('entity')} />
                <SortableTh label="Metric"        active={breachSort?.col === 'metric'}    dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('metric')} />
                <SortableTh label="Value"         active={breachSort?.col === 'value'}     dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('value')} />
                <SortableTh label="Threshold"     active={breachSort?.col === 'threshold'} dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('threshold')} />
              </tr>
            </thead>
            <tbody>
              {sortedBreaches.length === 0
                ? <tr><td colSpan={4} className="no-data">No breaches detected</td></tr>
                : sortedBreaches.map((b, i) => (
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
        </LayoutPanel>

        <LayoutPanel id="agents" rect={liveLayout.agents ?? effectiveLayout.agents} headerColor="var(--success,#2e8b57)" icon="bx-user-check"
          title="Agent Status" onChange={handlePanelChange} onCommit={handlePanelCommit}>
          <table className="dash-table">
            <thead>
              <tr>
                <FilterableTh label="Agent" options={nameOptions} filter={nameFilter}
                  isOpen={openFilterCol === 'name'}
                  onToggle={() => setOpenFilterCol(cur => cur === 'name' ? null : 'name')}
                  onClose={() => setOpenFilterCol(null)}
                  onApply={setNameFilter}
                  sortActive={agentSort?.col === 'name'} sortDir={agentSort?.dir ?? 'asc'}
                  onSort={() => toggleAgentSort('name')} />
                <FilterableTh label="Status" options={statusOptions} filter={statusFilter}
                  isOpen={openFilterCol === 'status'}
                  onToggle={() => setOpenFilterCol(cur => cur === 'status' ? null : 'status')}
                  onClose={() => setOpenFilterCol(null)}
                  onApply={setStatusFilter}
                  sortActive={agentSort?.col === 'status'} sortDir={agentSort?.dir ?? 'asc'}
                  onSort={() => toggleAgentSort('status')} />
                <SortableTh label="Duration" active={agentSort?.col === 'duration'} dir={agentSort?.dir ?? 'asc'}
                  onClick={() => toggleAgentSort('duration')} />
              </tr>
            </thead>
            <tbody>
              {agents.length === 0
                ? <tr><td colSpan={3} className="no-data">No agent data</td></tr>
                : (() => {
                  const body = Array.from(agentGroups.entries()).flatMap(([groupName, groupAgents]) => {
                    const filtered = sortAgentRows(groupAgents.filter(passesAgentFilters))
                    if (filtered.length === 0) return []
                    const rows = filtered.map((a, i) => {
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
                  return body.length > 0 ? body : <tr><td colSpan={3} className="no-data">No agents match the current filter</td></tr>
                })()
              }
            </tbody>
          </table>
        </LayoutPanel>
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
function OverviewPage({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames, headerColors, onHeaderColorsChange }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
  headerColors: Record<string, HeaderColors>; onHeaderColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
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
        displayNames={displayNames} headerColors={headerColors} onHeaderColorsChange={onHeaderColorsChange}
      />
    </>
  )
}

function OverviewMasonry({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames, headerColors, onHeaderColorsChange }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
  headerColors: Record<string, HeaderColors>; onHeaderColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
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
            colors={headerColors[accId] ?? DEFAULT_HEADER_COLORS}
            onColorsChange={onHeaderColorsChange}
          />
        </div>
      ))}
    </div>
  )
}

// ── Overview Card ─────────────────────────────────────────────────────────────
function OverviewCard({ accId, displayName, accountData, agentTimers, breaches, kpiTh, ds, colors, onColorsChange }: {
  accId: string; displayName: string; accountData: AccountData | undefined
  agentTimers: Record<string, number>; breaches: BreachRow[]
  kpiTh: Thresholds; ds: DataSourceConfig
  colors: HeaderColors; onColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
}) {
  const kpiRows = accountData?.kpiRows ?? []
  const groups  = ds.groups ?? []
  const freshestUpdatedAt = mostRecentUpdatedAt(kpiRows, ds.kpiUpdatedAt)
  const stale   = isDataStale(freshestUpdatedAt)
  const hasCrit = breaches.some(b => b.severity === 'critical')

  // ── Per-account header colors (band background + title text) — a
  // personalization so accounts are visually distinguishable on the Overview
  // page. Synced via Supabase (lifted up in Dashboard, see updateHeaderColors)
  // so every browser/device shows the same color-coding.
  const bandColor = colors.band
  const textColor = colors.text
  const setBandColor   = (val: string) => onColorsChange(accId, { band: val })
  const resetBandColor = () => onColorsChange(accId, { band: '' })
  const setTextColor   = (val: string) => onColorsChange(accId, { text: val })
  const resetTextColor = () => onColorsChange(accId, { text: '' })

  return (
    <>
      <div className="overview-card-header" style={bandColor ? { background: bandColor } : undefined}>
        <div className="overview-card-title" style={textColor ? { color: textColor } : undefined}>
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
          <HeaderColorPicker icon="bxs-palette" title="Set header band color"
            color={bandColor} defaultColor="#3b5a4f" onChange={setBandColor} onReset={resetBandColor} />
          <HeaderColorPicker icon="bx-font" title="Set header text color"
            color={textColor} defaultColor="#ffffff" onChange={setTextColor} onReset={resetTextColor} />
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
                {group.cells.sla  && <OvKpiTile label={ds.kpiLabels.sla}  value={slaVal}  colorClass={getKpiColorClass(extractPercent(slaVal), kpiTh.sla)} />}
                {group.cells.wait && <OvKpiTile label={ds.kpiLabels.wait} value={waitVal} colorClass={getKpiColorClass(parseInt(waitVal)||0, kpiTh.wait)} />}
                {group.cells.aht  && <OvKpiTile label={ds.kpiLabels.aht}  value={ahtVal}  colorClass="text-main" />}
                {group.cells.abn  && <OvKpiTile label={ds.kpiLabels.abn}  value={abnVal}  colorClass={getKpiColorClass(extractPercent(abnVal), kpiTh.abn)} />}
                {(ds.extraTiles ?? []).map(t => {
                  if (!group.cells[t.key]) return null
                  const raw = rc(group.cells[t.key])
                  return <OvKpiTile key={t.key} label={t.label} value={raw} colorClass={getExtraTileColorClass(extractPercent(raw), t)} />
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

function HeaderColorPicker({ icon, title, color, defaultColor, onChange, onReset }: {
  icon: string; title: string; color: string; defaultColor: string
  onChange: (val: string) => void; onReset: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="ov-color-picker-wrap">
      <button type="button" className="ov-color-btn" title={title} onClick={() => inputRef.current?.click()}>
        <i className={`bx ${icon}`} />
        {color && <span className="ov-color-swatch" style={{ background: color }} />}
      </button>
      <input
        ref={inputRef} type="color" className="ov-color-input"
        value={color || defaultColor} onChange={e => onChange(e.target.value)}
        onClick={e => e.stopPropagation()}
      />
      {color && (
        <button type="button" className="ov-color-reset" title="Reset to default" onClick={onReset}>
          <i className="bx bx-x" />
        </button>
      )}
    </div>
  )
}

function OvKpiTile({ label, value, colorClass }: {
  label: string; value: string; colorClass: string
}) {
  return (
    <div className="ov-kpi-tile">
      <div className="ov-kpi-tile-label">{label}</div>
      <div className={`ov-kpi-tile-value ${colorClass}`}>{value || '--'}</div>
    </div>
  )
}