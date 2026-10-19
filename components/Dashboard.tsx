'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import SettingsModal from './SettingsModal'
import { useAuth } from './AuthGate'
import { visibleAccountsFor, can, ROLE_LABELS } from '@/lib/authEmail'
import type { AccountData, Thresholds, DataSourceConfig, KpiGroup, AgentSource, DashboardLayout, PanelRect, HeaderColors, CliqGlobalSettings, ZohoLookups } from '@/lib/types'
import { DEFAULT_ZOHO_LOOKUPS } from '@/lib/types'
import { buildBreaches, sectionBreaches, mostRecentUpdatedAt, freshestAcrossSources, normalizeAgentRow, fetchKpiSourceRows, makeKpiCellResolver, type BreachRow } from '@/lib/breaches'
import { playAlarm } from '@/lib/alarmSounds'
import {
  loadAlarmSettings, preloadAlarm, evaluateAlarm, describeEvent, mergePending, startAlarmLoop, stopAlarmLoop, ringOnce,
  isMutedHere, setMutedHere, audioAllowed, unlockAudio, onAudioStateChange, DEFAULT_ALARM_SETTINGS,
  ALARM_PREVIEW_EVENT, PREVIEW_ACCOUNT,
  type GlobalAlarmSettings, type AlarmBaseline, type PendingAlarm,
} from '@/lib/globalAlarm'
import AlarmPrompt from './AlarmPrompt'
import {
  keyBreaches, reconcileCalledOut, toKeySets, loadCalledOut, saveCalledOut,
  type CalledOutAll,
} from '@/lib/calledOut'
import {
  loadSettings, saveSettings, saveDashboardLayout, saveHeaderColors, loadAllSettings, loadAccounts, seedAccountsIfEmpty, addAccount,
  loadCliqSettings, saveCliqSettings, appendKnownStatuses, DEFAULT_CLIQ_GLOBAL_SETTINGS,
  type AccountConfig, type AccountSettings
} from '@/lib/settings'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  extractPercent, formatTime, formatSeconds, extractKpiValue, formatKpiThresholdLabel, isDataStale, parseDurationToSeconds, isCoarseDuration,
  // NOTE: resolveCell is deliberately NOT imported here. Every cell read on
  // this page goes through makeKpiCellResolver() in lib/breaches.ts so the
  // browser and the Cliq/RTA scan resolve identically — re-importing it is
  // how the drift CLAUDE.md documents would start again.
  getKpiColorClass, getStatusPillClass, getExtraTileColorClass,
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

// ── Fetch one agent source (a table + its column mapping), normalized via the
// SAME normalizeAgentRow() lib/cliqScan.ts uses server-side — see that
// function's comment in lib/breaches.ts for why this must never fork again.
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
  return rows.map(r => normalizeAgentRow(r, src))
}

// ── Main Dashboard component ──────────────────────────────────────────────────
export default function Dashboard() {
  // Provided by <AuthGate>, which never renders this component without a
  // signed-in, active profile.
  const { profile, signOut: doSignOut } = useAuth()
  const canOpenSettings = can.openSettings(profile.role)

  const [isDark, setIsDark]                 = useState(false)
  const [currentPage, setCurrentPage]       = useState<Page>('overview')
  const [accounts, setAccounts]             = useState<string[]>([])
  // Distinguishes "still loading" from "loaded, and this person has no
  // accounts" — a roster import can create someone before their account
  // exists, and they shouldn't sit on a "Loading..." that never ends.
  const [accountsReady, setAccountsReady]   = useState(false)
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
  const [wfLogsEnabledMap, setWfLogsEnabledMap] = useState<Record<string, boolean>>({})
  const [rtaLogsEnabledMap, setRtaLogsEnabledMap] = useState<Record<string, boolean>>({})
  const [rtaSitesMap, setRtaSitesMap]           = useState<Record<string, string[]>>({})
  const [rtaAccountNameMap, setRtaAccountNameMap] = useState<Record<string, string>>({})
  const [rtaAiCategorizationMap, setRtaAiCategorizationMap] = useState<Record<string, boolean>>({})
  const [rtaReportKpiMap, setRtaReportKpiMap]                     = useState<Record<string, boolean>>({})
  const [rtaReportAgentStatusMap, setRtaReportAgentStatusMap]     = useState<Record<string, boolean>>({})
  const [zohoLookupsMap, setZohoLookupsMap]     = useState<Record<string, ZohoLookups>>({})
  const [alarmSounds, setAlarmSounds]           = useState<Record<string, string>>({})
  // Every agent-status value ever seen per account (see lib/settings.ts's
  // appendKnownStatuses()) — accumulated by fetchAccount() below, read by
  // SettingsModal's "Previously Seen Statuses" section so a status that
  // stops being live doesn't disappear from the Status Durations tab.
  const [knownStatusesMap, setKnownStatusesMap] = useState<Record<string, string[]>>({})
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
  // Mirrors knownStatusesMap so fetchAccount() (a stable useCallback) can
  // read the latest value without needing the map itself in its dependency
  // array — that would recreate fetchAccount (and re-trigger every effect
  // keyed on its identity) every time a new status gets accumulated.
  const knownStatusesRef = useRef<Record<string, string[]>>({})
  useEffect(() => { knownStatusesRef.current = knownStatusesMap }, [knownStatusesMap])

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
          extraCols: src.agentExtraColsMap || {},
          extraDurationCols: src.agentExtraDurationColsMap || {},
          extraMetricCols: src.agentExtraMetricColsMap || {},
        })
      }
      if (src.agentSources) agentSourcesToFetch.push(...src.agentSources)
      const agents: any[] = (await Promise.all(agentSourcesToFetch.map(as_ => fetchAgentSource(as_, accId)))).flat()

      // Alternate KPI sources — any GROUP (KpiGroup.source) or individual
      // TILE (GroupTile.source) that reads from its own table instead of
      // src.kpiTable above. Which tables, how they're deduped and how the
      // results are keyed all live in lib/breaches.ts's fetchKpiSourceRows();
      // the ONLY thing contributed here is the browser's Supabase client.
      // lib/cliqScan.ts calls the exact same function with the server client,
      // so the two cannot drift — this used to be a hand-written loop copied
      // into both files, and that pair had already drifted by a token.
      const kpiRowsBySource = await fetchKpiSourceRows(src, accId,
        async (table, accountCol, accountId) => {
          const r = await supabase.from(table as any).select('*').eq(accountCol, accountId)
          return (r.data as any[]) ?? []
        })

      const kpiRows = (kpiRes.data as any[]) ?? []

      setData(prev => ({
        ...prev,
        [accId]: {
          kpi:     kpiRows[0] ?? null,
          kpiRows: kpiRows,
          kpiRowsBySource,
          agents:  agents,
          status:  null,
          calls:   [],
          syncing: false,
          loaded:  true,
        }
      }))

      // ── Accumulate agent-status history (see sql/known_statuses.sql) ───────
      // Every status value seen in THIS fetch, compared against what's
      // already known for this account — only hits Supabase when there's
      // actually something new (the common case, after the first few
      // cycles, is nothing new at all). See SettingsModal.tsx's "Previously
      // Seen Statuses" section for why this exists.
      const liveStatuses = Array.from(new Set(agents.map(a => String(a._status ?? '').trim()).filter(Boolean)))
      const alreadyKnown = knownStatusesRef.current[accId] ?? []
      const newStatuses = liveStatuses.filter(s => !alreadyKnown.includes(s))
      if (newStatuses.length > 0) {
        appendKnownStatuses(accId, newStatuses).then(merged => {
          if (merged) setKnownStatusesMap(prev => ({ ...prev, [accId]: merged }))
        })
      }

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
          // Static mode (DataSourceConfig.agentDurationStatic — see Settings'
          // Data Sources tab): the mapped column isn't really elapsed time
          // (e.g. a ticket count), so never let the 1s clock below tick it up
          // — same mechanism already used for day/hour-only coarse durations,
          // just forced on unconditionally instead of only when the text
          // itself looks coarse.
          if (src.agentDurationStatic || isCoarseDuration(raw)) coarseKeysRef.current.add(key)
          else coarseKeysRef.current.delete(key)

          // Breach-table companion duration columns (see AgentExtraColumn /
          // agentExtraDurationColsMap) — governed by the SAME account-wide
          // running/static setting as the main Duration column above, not a
          // separate one: toggling Duration to Running makes these tick live
          // too, toggling to Static freezes them too, matching what a single
          // "is this account's time data live" setting should mean. Stored
          // under a compound key in the same agentTimers map (arbitrary
          // string keys already), ticked by the same 1s clock below.
          ;(src.agentExtraCols ?? []).forEach(col => {
            const extraDurRaw = a[`_extraDuration_${col.key}`]
            if (extraDurRaw === undefined) return
            const durKey = `${accId}:${String(a._name ?? '')}:extraDur:${col.key}`
            const durRawStr = String(extraDurRaw || '')
            next[durKey] = parseDurationToSeconds(durRawStr)
            if (src.agentDurationStatic || isCoarseDuration(durRawStr)) coarseKeysRef.current.add(durKey)
            else coarseKeysRef.current.delete(durKey)
          })
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

  // ── Apply a bulk loadAllSettings() result to every settings-related state
  // map at once — shared by the initial load (init() below) AND the periodic
  // settings poll (a few effects down), so the two never drift out of sync
  // the way a second hand-copied version of this exact assembly would (same
  // class of bug CLAUDE.md documents being bitten by twice already).
  const applySettingsMap = useCallback((ids: string[], allSettings: Record<string, AccountSettings>) => {
    const kpiMap: Record<string, Thresholds>          = {}
    const statusMap: Record<string, StatusThresholds> = {}
    const dsMap: Record<string, DataSourceConfig>     = {}
    const layoutMap: Record<string, DashboardLayout>  = {}
    const colorMap: Record<string, HeaderColors>      = {}
    const cliqChanMap: Record<string, string>         = {}
    const wfLogsMap: Record<string, boolean>          = {}
    const rtaLogsMap: Record<string, boolean>         = {}
    const rtaSitesMap2: Record<string, string[]>      = {}
    const rtaAcctNameMap2: Record<string, string>     = {}
    const rtaAiCatMap2: Record<string, boolean>       = {}
    const rtaReportKpiMap2: Record<string, boolean>         = {}
    const rtaReportAgentStatusMap2: Record<string, boolean> = {}
    const zohoLuMap: Record<string, ZohoLookups>      = {}
    const alarmMap: Record<string, string>            = {}
    const knownStatusesMap2: Record<string, string[]> = {}
    ids.forEach(id => {
      if (!allSettings[id]) return
      kpiMap[id]      = allSettings[id].kpi
      statusMap[id]   = allSettings[id].status
      dsMap[id]       = allSettings[id].ds
      layoutMap[id]   = allSettings[id].layout
      colorMap[id]    = allSettings[id].headerColors
      cliqChanMap[id] = allSettings[id].cliqChannel
      wfLogsMap[id]   = allSettings[id].wfLogsEnabled
      rtaLogsMap[id]  = allSettings[id].rtaLogsEnabled
      rtaSitesMap2[id] = allSettings[id].rtaSites
      rtaAcctNameMap2[id] = allSettings[id].rtaAccountName
      rtaAiCatMap2[id] = allSettings[id].rtaAiCategorizationEnabled
      rtaReportKpiMap2[id] = allSettings[id].rtaReportKpi
      rtaReportAgentStatusMap2[id] = allSettings[id].rtaReportAgentStatus
      zohoLuMap[id]   = allSettings[id].zohoLookups
      alarmMap[id]    = allSettings[id].alarmSound
      knownStatusesMap2[id] = allSettings[id].knownStatuses
    })
    setKpiThresholds(kpiMap)
    setStatusThresholds(statusMap)
    setDataSources(dsMap)
    setDashboardLayouts(layoutMap)
    setHeaderColors(colorMap)
    setCliqChannels(cliqChanMap)
    setWfLogsEnabledMap(wfLogsMap)
    setRtaLogsEnabledMap(rtaLogsMap)
    setRtaSitesMap(rtaSitesMap2)
    setRtaAccountNameMap(rtaAcctNameMap2)
    setRtaAiCategorizationMap(rtaAiCatMap2)
    setRtaReportKpiMap(rtaReportKpiMap2)
    setRtaReportAgentStatusMap(rtaReportAgentStatusMap2)
    setZohoLookupsMap(zohoLuMap)
    setAlarmSounds(alarmMap)
    setKnownStatusesMap(knownStatusesMap2)
  }, [])

  // ── Discover accounts from all known tables ────────────────────────────────
  useEffect(() => {
    async function init() {
      // Load accounts from wfm_accounts table (user-managed)
      const accountConfigs = await loadAccounts()
      const allIds = accountConfigs.map(a => a.id)
      // Store display names for use in UI
      const nameMap: Record<string, string> = {}
      accountConfigs.forEach(a => { nameMap[a.id] = a.display_name || a.id })
      setDisplayNames(nameMap)

      // Seed wfm_accounts if it's empty (first run — auto-populate from existing data).
      // Superuser only: this writes the account registry, and it's also the
      // only role that would see an empty list as "needs seeding" rather than
      // "I'm not assigned to anything yet".
      if (accountConfigs.length === 0 && profile.role === 'superuser') {
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
          allIds.push(...seeded.map(a => a.id))
          seeded.forEach(a => { nameMap[a.id] = a.display_name || a.id })
          setDisplayNames({ ...nameMap })
        }
      }

      // THE account scoping point. Everything downstream — KPI fetches,
      // settings loads, the Overview grid, breach alarms — is driven off this
      // list, so narrowing it here scopes the whole dashboard. A superuser
      // gets every account by role; everyone else gets only what
      // wfm_user_accounts grants them.
      const ids = visibleAccountsFor(profile, allIds)
      setAccounts(ids)
      setAccountsReady(true)

      // Load per-account settings from Supabase (shared) with localStorage fallback
      const allSettings = await loadAllSettings(ids)
      applySettingsMap(ids, allSettings)
      loadCliqSettings().then(setCliqGlobal)

      const savedAcc = localStorage.getItem('wfm_current_account')
      const first = savedAcc && ids.includes(savedAcc) ? savedAcc : (ids[0] ?? '')
      setCurrentAccount(first)

      // Fetch all accounts
      await Promise.all(ids.map(id => fetchAccount(id, allSettings[id].ds)))
    }
    init()
    // `profile` is in the deps because the visible account list is derived
    // from it — if the signed-in user changes, everything downstream must be
    // rebuilt rather than keeping the previous user's accounts on screen.
  }, [fetchAccount, applySettingsMap, profile])

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
        setWfLogsEnabledMap(prev => ({ ...prev, [accId]: settings.wfLogsEnabled }))
        setZohoLookupsMap(prev => ({ ...prev, [accId]: settings.zohoLookups }))
        setAlarmSounds(prev => ({ ...prev, [accId]: settings.alarmSound }))
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

  // ── Settings poll — sole settings-sync mechanism while Realtime is disabled ─
  // The wfm_settings postgres_changes handler above (dead code while
  // REALTIME_ENABLED is false) used to be what let one session's Save
  // Changes show up in every OTHER open session automatically. With Realtime
  // off, nothing re-fetches kpi_thresholds/status_thresholds/data_source/
  // cliq_channel/etc. after the initial page load — a save in one browser
  // was invisible everywhere else (including new Settings toggles/values)
  // until a manual page refresh. This re-loads every account's settings on a
  // fixed interval and reapplies them so another session's save shows up
  // here without anyone needing to reload — same API-Gateway-billed poll
  // pattern as the KPI/agent poll just above, not Realtime Messages. 60s
  // (vs the KPI poll's 30s) since settings change far less often than live
  // KPI data and this fetches every account's FULL settings payload each
  // tick. Skips while THIS tab's own Settings modal is open, same reasoning
  // as the deploy-version check below — an in-progress local edit shouldn't
  // get silently overwritten by a refetch mid-edit.
  useEffect(() => {
    if (accounts.length === 0) return
    const poll = async () => {
      if (settingsOpen) return
      try {
        const allSettings = await loadAllSettings(accounts)
        applySettingsMap(accounts, allSettings)
      } catch (err) {
        console.error('[settings poll] failed:', err)
      }
    }
    const interval = setInterval(poll, 60_000)
    return () => clearInterval(interval)
  }, [accounts, settingsOpen, applySettingsMap])

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
  //
  // Checks on TWO triggers, not just the interval: this dashboard is the
  // kind of thing people leave open on a monitor or in a background tab for
  // hours, and browsers throttle setInterval heavily (sometimes to once a
  // minute or less) once a tab is backgrounded — so relying on the interval
  // alone meant a backgrounded tab could sit on a stale build far longer
  // than the interval's own period suggests. Also checking immediately on
  // `visibilitychange` (tab regains focus) catches that case reliably
  // regardless of how long it was backgrounded or how throttled the timer
  // was, without waiting for the next tick.
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
    const interval = setInterval(checkVersion, 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') checkVersion() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
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

  // Is this account's data real and complete enough to judge anything from?
  // Anything that treats "a breach isn't in the list" as news (the alarm, the
  // called-out checks) must wait for this, or the first thing it sees is a
  // half-loaded page:
  //   - before the first fetch returns, data[id] is an EMPTY placeholder
  //     (fetchAccount), which isn't "stale" — it has no timestamp at all.
  //     `loaded` is checked on the data itself: a separate "loaded" ref was
  //     tried first and could run AHEAD of the rendered data (an effect runs
  //     after a render, while the fetch had already marked the ref).
  //   - until the account's own settings arrive, buildBreaches() falls back to
  //     DEFAULT thresholds, which produce a different list of breaches.
  const accountDataReady = (id: string) =>
    !!(data[id]?.loaded && dataSources[id] && kpiThresholds[id] && statusThresholds[id])

  // ── "Called out" checks on the Breach / Anomalies tables ───────────────────
  // See lib/calledOut.ts for the rule: a check lasts exactly as long as its
  // breach stays in the table. The marks live in a ref (the lastSeen times tick
  // every second and must not re-render anything); only the SET of checked keys
  // is React state, because that is all the tables draw from.
  const calledOutRef = useRef<CalledOutAll>({})
  const calledOutSavedAt = useRef(0)
  const [calledOut, setCalledOut] = useState<Record<string, Set<string>>>({})

  useEffect(() => {
    const saved = loadCalledOut()
    calledOutRef.current = saved
    setCalledOut(toKeySets(saved))
  }, [])

  useEffect(() => {
    const all = calledOutRef.current
    const now = Date.now()
    let cleared = false
    for (const id of accounts) {
      const marked = all[id]
      if (!marked || Object.keys(marked).length === 0) continue
      // Not ready -> we can't tell "the breach ended" from "nothing has loaded
      // yet", and guessing wrong would wipe every check on every page load.
      if (!accountDataReady(id)) continue
      const present = new Set(keyBreaches(allBreaches[id] ?? []).map(k => k.key))
      const { next, dropped } = reconcileCalledOut(marked, present, now)
      all[id] = next
      if (dropped.length) cleared = true
    }
    if (cleared) {
      setCalledOut(toKeySets(all)); saveCalledOut(all); calledOutSavedAt.current = now
    } else if (now - calledOutSavedAt.current > 20_000) {
      // Keep the stored last-seen times fresh, so a long-closed tab reopens
      // knowing how long a breach has really been gone.
      saveCalledOut(all); calledOutSavedAt.current = now
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allBreaches])

  const toggleCalledOut = useCallback((accountId: string, key: string) => {
    const all = calledOutRef.current
    const marked = { ...(all[accountId] ?? {}) }
    if (key in marked) delete marked[key]; else marked[key] = Date.now()
    all[accountId] = marked
    setCalledOut(toKeySets(all))
    saveCalledOut(all); calledOutSavedAt.current = Date.now()
  }, [])

  // ── Global breach alarm (Settings → Alarm, super users) ────────────────────
  // One sound for every account, played here — at the top of the dashboard —
  // so it works on any page, not only while the Overview cards are on
  // screen. The rule (only CHANGES ring) is lib/globalAlarm.ts's
  // evaluateAlarm(), built on the same change detection as RTA Logs.
  const [alarmSettings, setAlarmSettings] = useState<GlobalAlarmSettings>(DEFAULT_ALARM_SETTINGS)
  const [alarmMuted, setAlarmMuted]       = useState(false)   // this screen only
  const [alarmBlocked, setAlarmBlocked]   = useState(false)   // browser wants a click first
  const [lastAlarm, setLastAlarm]         = useState<{ text: string; at: number } | null>(null)
  // Changes nobody has acknowledged yet. While this is non-empty the prompt
  // is up and (unless muted / in the quiet time) the alarm keeps ringing.
  const [alarmPending, setAlarmPending]   = useState<PendingAlarm[]>([])
  const [alarmPhase, setAlarmPhase]       = useState<'idle' | 'quiet' | 'ringing'>('idle')
  // 'once' mode only: the bell shakes for a moment after each ring.
  const [alarmFlash, setAlarmFlash]       = useState(false)
  const alarmBaselines = useRef(new Map<string, AlarmBaseline>())
  // 'until_ack' mode: after an acknowledgement, stay quiet until this time.
  const alarmQuietUntil = useRef(0)
  // 'once' mode: when it last rang (min gap between rings).
  const lastOnceAt = useRef(0)
  // Read inside the evaluation effect without re-running it: that effect must
  // fire on breach changes only — re-running it on a settings change would
  // re-evaluate against a half-updated view and could ring spuriously.
  const alarmRef = useRef(alarmSettings); alarmRef.current = alarmSettings
  const mutedRef = useRef(alarmMuted);    mutedRef.current = alarmMuted

  useEffect(() => { setAlarmMuted(isMutedHere()) }, [])

  // Load now, every 60s (same cadence as the settings poll above), and again
  // the moment this screen's Settings modal closes — so a super user's change
  // reaches every open dashboard within a minute, and their own immediately.
  useEffect(() => {
    if (settingsOpen) return
    let alive = true
    const load = () => loadAlarmSettings().then(s => { if (alive) { setAlarmSettings(s); preloadAlarm(s) } })
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [settingsOpen])

  // Browsers block audio until the page has had a click or keypress. After a
  // reload with a saved session there hasn't been one, so say so up front
  // (the bell turns amber) instead of discovering it when an alarm is missed.
  // The bell reflects the audio engine's real state (see audioAllowed), and
  // any click or keypress on the page is used to resume it.
  useEffect(() => {
    if (!alarmSettings.enabled) { setAlarmBlocked(false); return }
    const recheck = () => setAlarmBlocked(!audioAllowed())
    recheck()
    const offState = onAudioStateChange(recheck)   // resume() settles async — follow the engine itself
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    return () => { offState(); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio) }
  }, [alarmSettings.enabled])

  // One ring, with the bell shaking for a moment (ringMode 'once').
  const flashAndRing = useCallback((s: GlobalAlarmSettings) => {
    ringOnce(s).then(r => {
      if (r === 'blocked') { setAlarmBlocked(true); return }
      setAlarmFlash(true)
      setTimeout(() => setAlarmFlash(false), 2500)
    })
  }, [])

  useEffect(() => {
    // Only accounts whose data is ready (see accountDataReady) and never stale
    // data. A wrong first baseline would make the real thing, arriving a moment
    // later, look like a wave of new breaches — ringing on page load for
    // everything already on screen.
    const eligible = accounts.filter(id =>
      accountDataReady(id) && !isDataStale(freshestAcrossSources(dataSources[id], data[id])))
    const s = alarmRef.current
    const { events, next } = evaluateAlarm(alarmBaselines.current, allBreaches, eligible, s.severity, Date.now())
    // The baseline advances even while the alarm is off, so switching it on
    // later doesn't ring for everything that changed in the meantime.
    alarmBaselines.current = next
    if (!s.enabled || events.length === 0) return

    setLastAlarm({ text: events.map(e => describeEvent(e, id => displayNames[id] || id)).join('\n'), at: Date.now() })
    if (mutedRef.current) return

    if (s.ringMode === 'once') {
      // One ring per change, never more often than the minimum gap.
      const now = Date.now()
      if (now - lastOnceAt.current < s.minGapSeconds * 1000) return
      lastOnceAt.current = now
      flashAndRing(s)
      return
    }
    // 'until_ack': onto the prompt; the loop effect below does the ringing.
    setAlarmPending(p => mergePending(p, events, Date.now()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allBreaches])

  // Ring for as long as something is unacknowledged ('until_ack' mode). Restarts
  // if a super user saves a different sound mid-alarm; the 60s settings poll
  // returns equal values, which leave `soundSig` unchanged and the loop alone.
  const wantAlarmSound = alarmSettings.enabled && alarmSettings.ringMode === 'until_ack' && !alarmMuted && alarmPending.length > 0
  const soundSig = `${alarmSettings.soundKind}|${alarmSettings.builtinKey}|${alarmSettings.soundUrl}|${alarmSettings.volume}`
  useEffect(() => {
    if (!wantAlarmSound) { stopAlarmLoop(); setAlarmPhase('idle'); return }
    const start = () => {
      setAlarmPhase('ringing')
      startAlarmLoop(alarmRef.current, r => setAlarmBlocked(r === 'blocked'))
    }
    const wait = alarmQuietUntil.current - Date.now()
    let t: ReturnType<typeof setTimeout> | undefined
    if (wait > 0) { setAlarmPhase('quiet'); t = setTimeout(start, wait) } else start()
    return () => { if (t) clearTimeout(t); stopAlarmLoop() }
  }, [wantAlarmSound, soundSig])

  // Muting this screen, switching the alarm off, or switching to 'once' mode
  // drops what's pending — unmuting / switching back later shouldn't ring for
  // old news, and 'once' mode has nothing to acknowledge.
  useEffect(() => {
    if (alarmMuted || !alarmSettings.enabled || alarmSettings.ringMode !== 'until_ack') setAlarmPending([])
  }, [alarmMuted, alarmSettings.enabled, alarmSettings.ringMode])

  const acknowledgeAlarm = useCallback(() => {
    stopAlarmLoop()
    alarmQuietUntil.current = Date.now() + alarmRef.current.minGapSeconds * 1000
    setAlarmPending([])
  }, [])

  // Settings → Alarm → "Preview on this screen", with the settings the super
  // user just saved (this screen only reloads them once the Settings modal
  // closes). 'until_ack': a sample prompt, ringing straight away (no quiet
  // time). 'once': one ring — there's no prompt in that mode.
  useEffect(() => {
    const onPreview = (e: Event) => {
      const s = (e as CustomEvent<GlobalAlarmSettings>).detail ?? alarmRef.current
      setAlarmSettings(s); preloadAlarm(s)
      if (s.ringMode === 'once') { flashAndRing(s); return }
      alarmQuietUntil.current = 0
      setAlarmPending(p => mergePending(p, [{ accountId: PREVIEW_ACCOUNT, changes: [
        { kind: 'kpi', entity: 'Global', metric: 'SLA %', value: '74%', previous: '85%' },
      ] }], Date.now()))
    }
    window.addEventListener(ALARM_PREVIEW_EVENT, onPreview)
    return () => window.removeEventListener(ALARM_PREVIEW_EVENT, onPreview)
  }, [flashAndRing])

  // ── Save settings — writes to Supabase so all browsers sync ────────────────
  const handleSaveSettings = async (
    kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig, cliqChannel: string,
    wfLogsEnabled: boolean = false, zohoLookups: ZohoLookups = DEFAULT_ZOHO_LOOKUPS,
    alarmSound: string = '', rtaLogsEnabled: boolean = false, rtaSites: string[] = [],
    rtaAccountName: string = '', rtaAiCategorizationEnabled: boolean = false,
    rtaReportKpi: boolean = true, rtaReportAgentStatus: boolean = false
  ) => {
    // Update local state immediately (instant UI feedback)
    setKpiThresholds(prev => ({ ...prev, [currentAccount]: kpi }))
    setStatusThresholds(prev => ({ ...prev, [currentAccount]: status }))
    setDataSources(prev => ({ ...prev, [currentAccount]: ds }))
    setCliqChannels(prev => ({ ...prev, [currentAccount]: cliqChannel }))
    setWfLogsEnabledMap(prev => ({ ...prev, [currentAccount]: wfLogsEnabled }))
    setRtaLogsEnabledMap(prev => ({ ...prev, [currentAccount]: rtaLogsEnabled }))
    setRtaSitesMap(prev => ({ ...prev, [currentAccount]: rtaSites }))
    setRtaAccountNameMap(prev => ({ ...prev, [currentAccount]: rtaAccountName }))
    setRtaAiCategorizationMap(prev => ({ ...prev, [currentAccount]: rtaAiCategorizationEnabled }))
    setRtaReportKpiMap(prev => ({ ...prev, [currentAccount]: rtaReportKpi }))
    setRtaReportAgentStatusMap(prev => ({ ...prev, [currentAccount]: rtaReportAgentStatus }))
    setZohoLookupsMap(prev => ({ ...prev, [currentAccount]: zohoLookups }))
    setAlarmSounds(prev => ({ ...prev, [currentAccount]: alarmSound }))
    // Re-fetch with new data source
    fetchAccount(currentAccount, ds)
    // Persist to Supabase (shared) + localStorage (cache)
    await saveSettings(currentAccount, kpi, status, ds, cliqChannel, wfLogsEnabled, zohoLookups, alarmSound, rtaLogsEnabled, rtaSites, rtaAccountName, rtaAiCategorizationEnabled, rtaReportKpi, rtaReportAgentStatus)
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

      {mounted && alarmPending.length > 0 && (
        <AlarmPrompt
          items={alarmPending}
          status={alarmMuted ? 'muted' : alarmBlocked ? 'blocked' : alarmPhase === 'quiet' ? 'quiet' : 'ringing'}
          isDark={isDark}
          name={id => id === PREVIEW_ACCOUNT ? 'Test alarm' : displayNames[id] || id}
          onAcknowledge={acknowledgeAlarm}
        />
      )}

      {settingsOpen && mounted && (
        <SettingsModal
          isDark={isDark}
          accountId={currentAccount || accounts[0] || ''}
          accounts={accounts.map(id => ({ id, display_name: displayNames[id] || id, active: true, sort_order: 0 }))}
          kpiThresholds={kpiThresholds[currentAccount] ?? DEFAULT_THRESHOLDS}
          statusThresholds={statusThresholds[currentAccount] ?? DEFAULT_STATUS_THRESHOLDS}
          dataSource={dataSources[currentAccount] ?? DEFAULT_DATA_SOURCE}
          cliqChannel={cliqChannels[currentAccount] ?? ''}
          cliqGlobalSettings={cliqGlobal}
          wfLogsEnabled={wfLogsEnabledMap[currentAccount] ?? false}
          rtaLogsEnabled={rtaLogsEnabledMap[currentAccount] ?? false}
          rtaSites={rtaSitesMap[currentAccount] ?? []}
          rtaAccountName={rtaAccountNameMap[currentAccount] ?? ''}
          rtaAiCategorizationEnabled={rtaAiCategorizationMap[currentAccount] ?? false}
          rtaReportKpi={rtaReportKpiMap[currentAccount] ?? true}
          rtaReportAgentStatus={rtaReportAgentStatusMap[currentAccount] ?? false}
          zohoLookups={zohoLookupsMap[currentAccount] ?? DEFAULT_ZOHO_LOOKUPS}
          alarmSound={alarmSounds[currentAccount] ?? ''}
          knownStatuses={knownStatusesMap[currentAccount] ?? []}
          onSave={handleSaveSettings}
          onSaveCliqGlobal={handleSaveCliqGlobal}
          onAccountsChange={async () => {
            const configs = await loadAccounts()
            // Same scoping rule as the initial load. Only a superuser can
            // reach this today (the Accounts tab is superuser-only), but an
            // unfiltered setAccounts here would hand every account to anyone
            // who ever could — keep exactly one visibility rule.
            const ids = visibleAccountsFor(profile, configs.map(a => a.id))
            setAccounts(ids)
            // Refresh display names for EVERY account, not just new ones —
            // covers a rename (Accounts tab's pencil icon) on an existing
            // account, which otherwise wouldn't show up here until a full
            // page reload even though it already saved correctly.
            const nameMap: Record<string, string> = {}
            configs.forEach(a => { nameMap[a.id] = a.display_name || a.id })
            setDisplayNames(nameMap)
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
              setWfLogsEnabledMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].wfLogsEnabled }); return n })
              setRtaLogsEnabledMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaLogsEnabled }); return n })
              setRtaSitesMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaSites }); return n })
              setRtaAccountNameMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaAccountName }); return n })
              setRtaAiCategorizationMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaAiCategorizationEnabled }); return n })
              setRtaReportKpiMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaReportKpi }); return n })
              setRtaReportAgentStatusMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].rtaReportAgentStatus }); return n })
              setZohoLookupsMap(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].zohoLookups }); return n })
              setAlarmSounds(prev => { const n = {...prev}; newIds.forEach((id,i)=>{ n[id]=map[i].alarmSound }); return n })
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
            {accounts.length === 0 && <option>{accountsReady ? 'No accounts assigned' : 'Loading...'}</option>}
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
            {/* Team leads get the dashboard and nothing else — no settings
                entry point at all. The Settings modal itself is also gated,
                so this is presentation, not the only check. */}
            {canOpenSettings && (
              <button className="btn-icon" onClick={() => setSettingsOpen(true)} title="Settings">
                <i className="bx bx-cog" />
              </button>
            )}
            {/* Global breach alarm — shown to everyone while it's switched on.
                Click: acknowledge (while an alarm is up), else allow sound (if
                the browser is still blocking it), else mute / unmute THIS
                screen only. */}
            {alarmSettings.enabled && (
              <button
                className={`btn-icon alarm-bell${(alarmPhase === 'ringing' || alarmFlash) && !alarmBlocked ? ' ringing' : ''}${alarmBlocked ? ' blocked' : ''}${alarmMuted && !alarmBlocked ? ' muted' : ''}`}
                onClick={() => {
                  if (alarmPending.length) { acknowledgeAlarm(); return }
                  // While blocked, this click IS the gesture that unlocks audio
                  // (the page-wide listener resumes it and re-checks) — so it
                  // must not also toggle mute.
                  if (alarmBlocked) { unlockAudio(); return }
                  const m = !alarmMuted
                  setAlarmMuted(m); setMutedHere(m)
                }}
                title={
                  (alarmPending.length ? 'Breach alarm — click to acknowledge'
                    : alarmBlocked ? 'Breach alarm can\'t play yet — click to allow sound on this screen'
                    : alarmMuted ? 'Breach alarm muted on this screen — click to unmute'
                    : 'Breach alarm on — click to mute this screen')
                  + (lastAlarm ? `\n\nLast alarm ${new Date(lastAlarm.at).toLocaleTimeString()}:\n${lastAlarm.text}` : '')
                }
                aria-label="Breach alarm"
              >
                <i className={`bx ${alarmBlocked ? 'bx-volume-mute' : alarmMuted ? 'bx-bell-off' : 'bx-bell'}`} />
              </button>
            )}
            <button className="btn-icon" onClick={toggleTheme} title="Toggle theme">
              <i className={`bx ${isDark ? 'bx-sun' : 'bx-moon'}`} />
            </button>
            <button className="btn-icon" onClick={() => accounts.forEach(id => fetchAccount(id, dataSources[id]))} title="Refresh">
              <i className="bx bx-refresh" />
            </button>
            {/* Who you are + sign out, always visible. Showing the role here
                matters once there are several kinds of login: it's the
                quickest way to tell why a Settings button is missing, or to
                confirm you're testing as the team lead you think you are. */}
            <div className="user-chip" title={profile.fullName || profile.username}>
              <span className="user-avatar">{(profile.fullName || profile.username).charAt(0).toUpperCase()}</span>
              <span className="user-meta">
                <span className="user-name">{profile.username}</span>
                <span className={`user-role role-${profile.role}`}>{ROLE_LABELS[profile.role]}</span>
              </span>
            </div>
            <button className="btn-signout" onClick={doSignOut} title="Sign out">
              <i className="bx bx-log-out" />
              <span>Sign out</span>
            </button>
          </div>
        </div>

        <div className="page-content">
          {accountsReady && accounts.length === 0 && (
            <div className="auth-screen" style={{ minHeight: '60vh' }}>
              <div className="auth-card">
                <h1 className="auth-title">No accounts assigned yet</h1>
                <p className="auth-muted">
                  You're signed in as <strong>{profile.username}</strong>, but no accounts have been
                  assigned to you. Ask a super user{profile.role === 'team_lead' ? ' or your RTA' : ''} to
                  add one — it will appear here as soon as it is.
                </p>
              </div>
            </div>
          )}
          {currentPage === 'dashboard' && accounts.length > 0 && (
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
              <DashboardPage
                accountId={currentAccount}
                accountData={currentData}
                breaches={breaches}
                calledOut={calledOut[currentAccount] ?? NO_KEYS}
                onToggleCalledOut={key => toggleCalledOut(currentAccount, key)}
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
            </div>
          )}
          {currentPage === 'overview' && accounts.length > 0 && (
            <OverviewPage
              accounts={accounts}
              data={data}
              agentTimers={agentTimers}
              allBreaches={allBreaches}
              kpiThresholds={kpiThresholds}
              dataSources={dataSources}
              displayNames={displayNames}
              headerColors={headerColors}
              // While the global alarm is on it's the only alarm — the old
              // per-card sounds are silenced so nothing ever rings twice.
              alarmSounds={alarmSettings.enabled ? {} : alarmSounds}
              onHeaderColorsChange={updateHeaderColors}
              rtaLogsEnabledMap={rtaLogsEnabledMap}
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

// The checked-keys set a table gets when nothing is checked (one shared instance,
// so a prop that never changes doesn't look changed).
const NO_KEYS: Set<string> = new Set()

// ── The "called out" checkbox in a Breach / Anomalies row ─────────────────────
// Dashboard page only — the Overview cards are the compact at-a-glance view and
// deliberately have no checkbox (per the users, 2026-10-19). See
// lib/calledOut.ts for when a check clears.
function CalledOutBox({ checked, onToggle, who }: { checked: boolean; onToggle: () => void; who: string }) {
  return (
    <input
      type="checkbox" className="called-out-box" checked={checked} onChange={onToggle}
      aria-label={`Called out: ${who}`}
      title={checked
        ? 'Called out — stays checked while this breach continues, and clears when it goes away'
        : 'Tick once you have called this out'}
    />
  )
}

// ── A group's header row in the Dashboard page's tables ───────────────────────
// Shared by Agent Status and Breach / Anomalies so the two sectioned tables
// beside each other look identical.
function GroupHeaderRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{
        background: 'var(--bg-secondary, rgba(127,127,127,.08))', fontWeight: 700,
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px',
        color: 'var(--text-muted)', padding: '6px 12px',
      }}>{label}</td>
    </tr>
  )
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function DashboardPage({ accountId, accountData, breaches, calledOut, onToggleCalledOut, alertAcked, onAck, agentTimers, kpiTh, statusTh, ds, layout, onLayoutChange }: {
  accountId: string; accountData: AccountData | undefined; breaches: BreachRow[]
  calledOut: Set<string>; onToggleCalledOut: (key: string) => void
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

  // The table below is sectioned by agent group exactly when Agent Status is
  // (showAgentGroupHeaders), in that table's group order — so the two panels
  // beside each other read the same way. Sorting happens first, so a header
  // click sorts within each section. See sectionBreaches() in lib/breaches.ts.
  const breachSections = useMemo(
    () => sectionBreaches(sortedBreaches, Array.from(agentGroups.keys()), showAgentGroupHeaders),
    [sortedBreaches, agentGroups, showAgentGroupHeaders])
  // Each row's "called out" key — computed from the UNSORTED list so a row keeps
  // its key (including any duplicate suffix) whatever the sort order is.
  const keyOf = useMemo(() => new Map(keyBreaches(breaches).map(k => [k.row, k.key])), [breaches])

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
              <KpiGrid group={group} accountData={accountData} kpiTh={kpiTh} ds={ds} />
            </div>
          </LayoutPanel>
        ))}

        <LayoutPanel id="breach" rect={liveLayout.breach ?? effectiveLayout.breach} headerColor="var(--danger,#c0392b)" icon="bx-error-circle"
          title="Breach / Anomalies" onChange={handlePanelChange} onCommit={handlePanelCommit}>
          <table className="dash-table">
            <thead>
              <tr>
                <th className="called-out-th" title="Called out — tick a row once you have called it out. It clears by itself when the breach goes away.">
                  <i className="bx bx-check-circle" />
                </th>
                <SortableTh label="Queue / Agent" active={breachSort?.col === 'entity'}    dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('entity')} />
                <SortableTh label="Metric"        active={breachSort?.col === 'metric'}    dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('metric')} />
                <SortableTh label="Value"         active={breachSort?.col === 'value'}     dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('value')} />
                <SortableTh label="Threshold"     active={breachSort?.col === 'threshold'} dir={breachSort?.dir ?? 'asc'} onClick={() => toggleBreachSort('threshold')} />
              </tr>
            </thead>
            <tbody>
              {sortedBreaches.length === 0
                ? <tr><td colSpan={5} className="no-data">No breaches detected</td></tr>
                : breachSections.flatMap(section => {
                  const rows = section.rows.map((b, i) => (
                    <tr key={`${section.group}-${i}`}>
                      <td className="called-out-td">
                        <CalledOutBox checked={calledOut.has(keyOf.get(b) ?? '')} who={`${b.entity} — ${b.metric}`}
                          onToggle={() => { const k = keyOf.get(b); if (k) onToggleCalledOut(k) }} />
                      </td>
                      <td style={{ fontWeight: 600 }}>{b.entity}</td>
                      <td>{b.metric}</td>
                      <td><span className={b.severity === 'critical' ? 'badge-crit' : 'badge-warn'}>{b.value}</span></td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{b.threshold}</td>
                    </tr>
                  ))
                  return section.group
                    ? [<GroupHeaderRow key={`${section.group}-hdr`} label={section.group} colSpan={5} />, ...rows]
                    : rows
                })
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
                <SortableTh label={ds.agentDurationLabel || 'Duration'} active={agentSort?.col === 'duration'} dir={agentSort?.dir ?? 'asc'}
                  onClick={() => toggleAgentSort('duration')} />
                {(ds.agentExtraCols ?? []).map(col => (
                  <th key={col.key}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const extraCols = ds.agentExtraCols ?? []
                const colCount = 3 + extraCols.length
                if (agents.length === 0) return <tr><td colSpan={colCount} className="no-data">No agent data</td></tr>
                const body = Array.from(agentGroups.entries()).flatMap(([groupName, groupAgents]) => {
                  const filtered = sortAgentRows(groupAgents.filter(passesAgentFilters))
                  if (filtered.length === 0) return []
                  const rows = filtered.map((a, i) => {
                    const name = String(a._name ?? '')
                    const key  = `${accountId}:${name}`
                    const secs = agentTimers[key] ?? parseDurationToSeconds(String(a._duration ?? ''))
                    // Static mode (see Settings' Data Sources tab's Duration
                    // slot toggle): the mapped column isn't real elapsed time
                    // (e.g. a ticket count), so show it exactly as scraped
                    // instead of running it through formatSeconds(), which
                    // would otherwise misread e.g. "27" as "27 seconds".
                    const durationDisplay = ds.agentDurationStatic ? (a._duration || '--') : formatSeconds(secs)
                    return (
                      <tr key={`${groupName}-${i}`}>
                        <td style={{ fontWeight: 600 }}>{name}</td>
                        <td><span className={getStatusPillClass(String(a._status ?? ''))}>{String(a._status || '—')}</span></td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{durationDisplay}</td>
                        {extraCols.map(col => (
                          <td key={col.key}>{String(a[`_extra_${col.key}`] ?? '')}</td>
                        ))}
                      </tr>
                    )
                  })
                  if (!showAgentGroupHeaders || !groupName) return rows
                  return [<GroupHeaderRow key={`${groupName}-hdr`} label={groupName} colSpan={colCount} />, ...rows]
                })
                return body.length > 0 ? body : <tr><td colSpan={colCount} className="no-data">No agents match the current filter</td></tr>
              })()}
            </tbody>
          </table>
        </LayoutPanel>
      </div>
    </>
  )
}

// ── KPI Grid — renders one group's cell-bound tiles ───────────────────────────
// Takes the whole accountData, NOT a pre-resolved `rows` array. That prop was
// the structural reason per-tile sources were impossible: the caller picked
// the table one component up, before this ever saw the tiles. With
// accountData there is no way to hand it a group-level wrong answer.
function KpiGrid({ group, accountData, kpiTh, ds }: {
  group: KpiGroup; accountData: AccountData | undefined; kpiTh: Thresholds; ds: DataSourceConfig
}) {
  const rc = makeKpiCellResolver(ds, group, accountData)

  // Independent-tiles group (see GroupTile) — its own labels/bindings/
  // thresholds, entirely separate from every other group on this account.
  // Each tile may ALSO carry its own `source`, so pass the tile through.
  if (group.tiles && group.tiles.length) {
    return (
      <div className="kpi-grid">
        {group.tiles.map(t => {
          const raw = rc(t.cell || undefined, t)
          const { num } = extractKpiValue(raw, t.kpiUnit)
          return (
            <KpiTile key={t.key} label={t.label} value={raw || '--'} numValue={num}
              target={`Target ${formatKpiThresholdLabel(t.kpiUnit, t.targ, t.direction)}`} th={t} />
          )
        })}
      </div>
    )
  }

  const slaVal = rc(group.cells.sla).replace(/\s+/g,'')
  const waitVal = rc(group.cells.wait)
  const ahtVal  = rc(group.cells.aht)
  const abnVal  = rc(group.cells.abn)

  return (
    <div className="kpi-grid">
      <KpiTile label={ds.kpiLabels.sla}  value={slaVal || '--'}  numValue={extractKpiValue(slaVal, kpiTh.sla.kpiUnit).num}  target={`Target ${formatKpiThresholdLabel(kpiTh.sla.kpiUnit, kpiTh.sla.targ, kpiTh.sla.direction)}`}  th={kpiTh.sla}  showBar />
      <KpiTile label={ds.kpiLabels.wait} value={waitVal || '--'} numValue={extractKpiValue(waitVal, kpiTh.wait.kpiUnit).num} target="Calls in queue"                th={kpiTh.wait} />
      <KpiTile label={ds.kpiLabels.aht}  value={ahtVal || '--'}  numValue={extractKpiValue(ahtVal, kpiTh.aht.kpiUnit).num}  target={`Target ${formatKpiThresholdLabel(kpiTh.aht.kpiUnit, kpiTh.aht.targ, kpiTh.aht.direction)}`}  th={kpiTh.aht}  />
      <KpiTile label={ds.kpiLabels.abn}  value={abnVal || '--'}  numValue={extractKpiValue(abnVal, kpiTh.abn.kpiUnit).num}  target={`Target ${formatKpiThresholdLabel(kpiTh.abn.kpiUnit, kpiTh.abn.targ, kpiTh.abn.direction)}`} th={kpiTh.abn}  />
      {(ds.extraTiles ?? []).map(t => {
        const raw = rc(group.cells[t.key])
        const { num } = extractKpiValue(raw, t.kpiUnit)
        return (
          <KpiTile key={t.key} label={t.label} value={raw || '--'} numValue={num}
            target={`Target ${formatKpiThresholdLabel(t.kpiUnit, t.targ, t.higherIsBetter ? 'desc' : 'asc')}`} th={kpiTh.sla}
            colorOverride={getExtraTileColorClass(num, t)} />
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

// ── Overview Page's account filter — persisted so the chosen subset
// survives a reload. `null` (stored or in state) means "show all accounts",
// deliberately never an explicit full Set, same convention ColumnFilterPopup
// already uses elsewhere in this file. ──────────────────────────────────────
const OVERVIEW_ACCOUNT_FILTER_KEY = 'wfm_overview_account_filter'

function loadOverviewAccountFilter(): Set<string> | null {
  try {
    const raw = localStorage.getItem(OVERVIEW_ACCOUNT_FILTER_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr) : null
  } catch { return null }
}

function saveOverviewAccountFilter(selected: Set<string> | null) {
  try {
    if (selected === null) localStorage.removeItem(OVERVIEW_ACCOUNT_FILTER_KEY)
    else localStorage.setItem(OVERVIEW_ACCOUNT_FILTER_KEY, JSON.stringify([...selected]))
  } catch {}
}

// ── Account filter dropdown — search + checkbox list + Select All/Clear All
// (both scoped to whatever the search currently shows, so you can search,
// bulk-pick a subset, clear the search, and keep adding more) + Apply/
// Cancel. Local `checked` state only commits to the parent on Apply, same
// pattern as ColumnFilterPopup above — Cancel/backdrop-click discards
// whatever was toggled since opening. ────────────────────────────────────
function AccountFilterDropdown({ accounts, displayNames, selected, onApply }: {
  accounts: string[]; displayNames: Record<string, string>
  selected: Set<string> | null
  onApply: (vals: Set<string> | null) => void
}) {
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected ?? accounts))

  // Re-seed local state fresh every time the dropdown opens, so a prior
  // Cancel doesn't leave stale edits lingering for next time.
  const openDropdown = () => { setChecked(new Set(selected ?? accounts)); setSearch(''); setOpen(true) }

  const q = search.trim().toLowerCase()
  const filteredOptions = q
    ? accounts.filter(id => id.toLowerCase().includes(q) || (displayNames[id] || '').toLowerCase().includes(q))
    : accounts

  const allFilteredChecked = filteredOptions.length > 0 && filteredOptions.every(id => checked.has(id))
  const selectAllFiltered = () => setChecked(prev => new Set([...prev, ...filteredOptions]))
  const clearAllFiltered  = () => setChecked(prev => { const next = new Set(prev); filteredOptions.forEach(id => next.delete(id)); return next })
  const toggleOne = (id: string) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const activeCount = selected === null ? accounts.length : selected.size

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => (open ? setOpen(false) : openDropdown())}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
          borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer',
          background: selected !== null ? 'rgba(59,130,246,0.1)' : 'transparent',
          color: selected !== null ? '#3b82f6' : 'var(--text-main)', fontSize: 12.5, fontWeight: 600,
        }}
      >
        <i className="bx bx-filter-alt" style={{ fontSize: 15 }} />
        Filter Accounts
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
          background: selected !== null ? '#3b82f6' : 'var(--bg-body)',
          color: selected !== null ? '#fff' : 'var(--text-muted)',
        }}>{activeCount}/{accounts.length}</span>
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} onClick={() => setOpen(false)} />
          <div onClick={e => e.stopPropagation()} style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 201,
            background: 'var(--bg-card,#fff)', border: '1px solid var(--border,#e1e6e4)',
            borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.3)', width: 260,
            maxHeight: 400, display: 'flex', flexDirection: 'column',
            fontSize: 12.5, color: 'var(--text-main)',
          }}>
            <div style={{ padding: 8, borderBottom: '1px solid var(--border,#e1e6e4)' }}>
              <input
                type="text" placeholder="Search accounts..." value={search}
                onChange={e => setSearch(e.target.value)} autoFocus
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 6,
                  border: '1px solid var(--border,#e1e6e4)', background: 'var(--bg-body,#f7f8f7)',
                  color: 'var(--text-main)', fontSize: 12.5, boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border,#e1e6e4)' }}>
              <button onClick={selectAllFiltered} disabled={allFilteredChecked} style={{
                flex: 1, padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border,#e1e6e4)',
                background: 'transparent', color: 'var(--text-main)', cursor: allFilteredChecked ? 'default' : 'pointer',
                fontSize: 11.5, opacity: allFilteredChecked ? 0.5 : 1,
              }}>Select All{q ? ' (shown)' : ''}</button>
              <button onClick={clearAllFiltered} style={{
                flex: 1, padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border,#e1e6e4)',
                background: 'transparent', color: 'var(--text-main)', cursor: 'pointer', fontSize: 11.5,
              }}>Clear All{q ? ' (shown)' : ''}</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
              {filteredOptions.length === 0 && (
                <div style={{ padding: '10px', color: 'var(--text-muted)', textAlign: 'center' }}>No matching accounts</div>
              )}
              {filteredOptions.map(id => (
                <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked.has(id)} onChange={() => toggleOne(id)} />
                  {displayNames[id] || id}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--border,#e1e6e4)' }}>
              <button onClick={() => setOpen(false)} style={{
                flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border,#e1e6e4)',
                background: 'transparent', color: 'var(--text-main)', cursor: 'pointer', fontSize: 12,
              }}>Cancel</button>
              <button onClick={() => {
                onApply(checked.size === accounts.length ? null : checked)
                setOpen(false)
              }} style={{
                flex: 1, padding: '6px 8px', borderRadius: 6, border: 'none', background: '#3b82f6',
                color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>Apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Overview Page ──────────────────────────────────────────────────────────────
function OverviewPage({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames, headerColors, alarmSounds, onHeaderColorsChange, rtaLogsEnabledMap }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
  headerColors: Record<string, HeaderColors>; alarmSounds: Record<string, string>
  onHeaderColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
  rtaLogsEnabledMap: Record<string, boolean>
}) {
  const [accountFilter, setAccountFilter] = useState<Set<string> | null>(null)
  useEffect(() => { setAccountFilter(loadOverviewAccountFilter()) }, [])

  const handleApplyFilter = (vals: Set<string> | null) => {
    setAccountFilter(vals)
    saveOverviewAccountFilter(vals)
  }

  const visibleAccounts = accountFilter === null ? accounts : accounts.filter(a => accountFilter.has(a))

  return (
    <>
      <div className="ov-header">
        <div>
          <div className="ov-title">All Accounts Overview</div>
          <div className="ov-sub">Real-time summary across all configured accounts</div>
        </div>
        <AccountFilterDropdown
          accounts={accounts} displayNames={displayNames}
          selected={accountFilter} onApply={handleApplyFilter}
        />
      </div>
      <OverviewMasonry
        accounts={visibleAccounts} data={data} agentTimers={agentTimers}
        allBreaches={allBreaches} kpiThresholds={kpiThresholds} dataSources={dataSources}
        displayNames={displayNames} headerColors={headerColors} alarmSounds={alarmSounds}
        onHeaderColorsChange={onHeaderColorsChange}
        rtaLogsEnabledMap={rtaLogsEnabledMap}
      />
    </>
  )
}

function OverviewMasonry({ accounts, data, agentTimers, allBreaches, kpiThresholds, dataSources, displayNames, headerColors, alarmSounds, onHeaderColorsChange, rtaLogsEnabledMap }: {
  accounts: string[]; data: Record<string, AccountData>
  agentTimers: Record<string, number>; allBreaches: Record<string, BreachRow[]>
  kpiThresholds: Record<string, Thresholds>; dataSources: Record<string, DataSourceConfig>
  displayNames: Record<string, string>
  headerColors: Record<string, HeaderColors>; alarmSounds: Record<string, string>
  onHeaderColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
  rtaLogsEnabledMap: Record<string, boolean>
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
            alarmSound={alarmSounds[accId] ?? ''}
            onColorsChange={onHeaderColorsChange}
            rtaLogsEnabled={rtaLogsEnabledMap[accId] ?? false}
          />
        </div>
      ))}
    </div>
  )
}

// ── Overview Card ─────────────────────────────────────────────────────────────
function OverviewCard({ accId, displayName, accountData, agentTimers, breaches, kpiTh, ds, colors, alarmSound, onColorsChange, rtaLogsEnabled }: {
  accId: string; displayName: string; accountData: AccountData | undefined
  agentTimers: Record<string, number>; breaches: BreachRow[]
  kpiTh: Thresholds; ds: DataSourceConfig
  colors: HeaderColors; alarmSound: string
  onColorsChange: (accId: string, patch: Partial<HeaderColors>) => void
  rtaLogsEnabled: boolean
}) {
  const kpiRows = accountData?.kpiRows ?? []
  const groups  = ds.groups ?? []
  // Cross-source — see the same call on the Dashboard page above.
  const freshestUpdatedAt = freshestAcrossSources(ds, accountData)
  const stale   = isDataStale(freshestUpdatedAt)
  const hasCrit = breaches.some(b => b.severity === 'critical')

  // ── Breach alarm — this account's chosen sound (Settings → Zoho
  // Integrations → Breach Alarm) plays once when a NEW combination of
  // breaching entity/metric appears, not on every ~30s poll of an ongoing
  // one. Signature-based so a genuinely new breach re-rings even if the
  // account was previously acknowledged; clicking the siren silences the
  // CURRENT set until it changes (or clears and a new one appears later).
  const breachSig = useMemo(
    () => breaches.map(b => `${b.entity}:${b.metric}`).sort().join('|'),
    [breaches]
  )
  const [ackedSig, setAckedSig] = useState('')
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      // Skip the very first mount (e.g. opening the Overview page, or
      // switching tabs) — an already-breaching account shouldn't ring just
      // because its card appeared on screen.
      firstRender.current = false
      return
    }
    if (breachSig) {
      if (breachSig !== ackedSig) playAlarm(alarmSound)
    } else if (ackedSig) {
      setAckedSig('') // breach cleared — a future one should always ring again
    }
  }, [breachSig, ackedSig, alarmSound])
  const acked = breachSig !== '' && breachSig === ackedSig

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
              title={acked ? 'Alarm silenced — click stays silent until a new breach' : 'New breach — click to silence the alarm'}
              onClick={() => setAckedSig(breachSig)}
              style={{
                color: hasCrit ? 'var(--danger)' : 'var(--warning)',
                cursor: 'pointer',
                opacity: acked ? 0.4 : 1,
                animation: acked ? 'none' : 'ov-siren-pulse 1s infinite',
              }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="ov-live-dot" />
            <span className="ov-live-text">Live</span>
          </div>
          {rtaLogsEnabled && (
            <i className="bx bxs-cloud-upload" title="Workforce RTA Logs auto-reporting is enabled for this account"
              style={{ color: '#d97a35', fontSize: 15 }} />
          )}
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
          // ONE resolver — the SAME function KpiGrid() and the server-side
          // breach scan use, so this page and the Dashboard page can never
          // disagree about which table a tile reads. Holds the
          // tile.source -> group.source -> account-wide precedence.
          const rc = makeKpiCellResolver(ds, group, accountData)

          // Independent-tiles group (see GroupTile) — own labels/bindings/
          // thresholds, separate from every other group on this account.
          // Each tile may ALSO carry its own `source`, so pass the tile.
          if (group.tiles && group.tiles.length) {
            return (
              <div key={group.id} style={{ marginBottom: 10 }}>
                <div className="ov-section-label">{group.name || 'Global'}</div>
                <div className="ov-kpi-tiles">
                  {group.tiles.map(t => {
                    const raw = rc(t.cell || undefined, t)
                    return <OvKpiTile key={t.key} label={t.label} value={raw} colorClass={getKpiColorClass(extractKpiValue(raw, t.kpiUnit).num, t)} />
                  })}
                </div>
              </div>
            )
          }

          const slaVal  = rc(group.cells.sla).replace(/\s+/g,'')
          const waitVal = rc(group.cells.wait)
          const ahtVal  = rc(group.cells.aht)
          const abnVal  = rc(group.cells.abn)
          return (
            <div key={group.id} style={{ marginBottom: 10 }}>
              <div className="ov-section-label">{group.name || 'Global'}</div>
              <div className="ov-kpi-tiles">
                {group.cells.sla  && <OvKpiTile label={ds.kpiLabels.sla}  value={slaVal}  colorClass={getKpiColorClass(extractKpiValue(slaVal, kpiTh.sla.kpiUnit).num, kpiTh.sla)} />}
                {group.cells.wait && <OvKpiTile label={ds.kpiLabels.wait} value={waitVal} colorClass={getKpiColorClass(extractKpiValue(waitVal, kpiTh.wait.kpiUnit).num, kpiTh.wait)} />}
                {group.cells.aht  && <OvKpiTile label={ds.kpiLabels.aht}  value={ahtVal}  colorClass={getKpiColorClass(extractKpiValue(ahtVal, kpiTh.aht.kpiUnit).num, kpiTh.aht)} />}
                {group.cells.abn  && <OvKpiTile label={ds.kpiLabels.abn}  value={abnVal}  colorClass={getKpiColorClass(extractKpiValue(abnVal, kpiTh.abn.kpiUnit).num, kpiTh.abn)} />}
                {(ds.extraTiles ?? []).map(t => {
                  if (!group.cells[t.key]) return null
                  const raw = rc(group.cells[t.key])
                  return <OvKpiTile key={t.key} label={t.label} value={raw} colorClass={getExtraTileColorClass(extractKpiValue(raw, t.kpiUnit).num, t)} />
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