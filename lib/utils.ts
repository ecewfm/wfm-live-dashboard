import type { Thresholds, DataSourceConfig } from './types'

// ── Status thresholds type ────────────────────────────────────────────────────
export type StatusThresholds = Record<string, { warn: number; crit: number }>

// ── Default KPI thresholds ────────────────────────────────────────────────────
export const DEFAULT_THRESHOLDS: Thresholds = {
  sla:  { warn: 75, crit: 65, targ: 80, direction: 'desc' },
  wait: { warn: 15, crit: 25, targ: 10, direction: 'asc'  },
  aht:  { warn: 30, crit: 60, targ: 25, direction: 'asc'  },
  abn:  { warn: 5,  crit: 8,  targ: 3,  direction: 'asc'  },
}

// ── Default status thresholds ─────────────────────────────────────────────────
export const DEFAULT_STATUS_THRESHOLDS: StatusThresholds = {
  'Ringing':           { warn: 3,   crit: 5   },
  'In call':           { warn: 20,  crit: 30  },
  'After call work':   { warn: 3,   crit: 6   },
  'On a break':        { warn: 15,  crit: 20  },
  'Out for lunch':     { warn: 35,  crit: 45  },
  'Do not disturb':    { warn: 10,  crit: 20  },
  'Not available':     { warn: 10,  crit: 20  },
  'Back office':       { warn: 15,  crit: 30  },
  'In training':       { warn: 30,  crit: 60  },
  'Other':             { warn: 15,  crit: 30  },
  'Available':         { warn: 999, crit: 999 },
  'Offline':           { warn: 999, crit: 999 },
}

// ── Data source presets ───────────────────────────────────────────────────────
export const PRESET_AIRCALL: DataSourceConfig = {
  kpiTable:      'wfm_kpi_snapshots',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   '',
  kpiSlaCol:     'sla',
  kpiQueueCol:   'calls_waiting',
  kpiAsaCol:     'time_to_answer',
  kpiAbnCol:     '',
  kpiAgentsCol:  'available_users',
  kpiUpdatedAt:  'updated_at',
  agentTable:       'wfm_agent_states',
  agentAccountCol:  'account_id',
  agentNameCol:     'agent_name',
  agentStatusCol:   'status',
  agentDurationCol: 'duration',
  agentDurationSecs:''
}

export const PRESET_TALKDESK: DataSourceConfig = {
  kpiTable:      'talkdesk_lob_kpis',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   'lob_name',
  kpiSlaCol:     'sla',
  kpiQueueCol:   'contacts_in_queue',
  kpiAsaCol:     'aht',
  kpiAbnCol:     '',
  kpiAgentsCol:  'agents_logged_in',
  kpiUpdatedAt:  'updated_at',
  agentTable:       'talkdesk_agent_states',
  agentAccountCol:  'account_id',
  agentNameCol:     'agent_name',
  agentStatusCol:   'status',
  agentDurationCol: 'duration',
  agentDurationSecs:'duration_secs'
}

export const DEFAULT_DATA_SOURCE = PRESET_AIRCALL

// ── localStorage helpers ──────────────────────────────────────────────────────
export function loadKpiThresholds(accountId: string): Thresholds {
  try {
    const raw = localStorage.getItem(`wfm_kpi_th_${accountId}`)
    if (raw) {
      const p = JSON.parse(raw)
      return {
        sla:  { ...DEFAULT_THRESHOLDS.sla,  ...p.sla  },
        wait: { ...DEFAULT_THRESHOLDS.wait, ...p.wait },
        aht:  { ...DEFAULT_THRESHOLDS.aht,  ...p.aht  },
        abn:  { ...DEFAULT_THRESHOLDS.abn,  ...p.abn  },
      }
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS))
}

export function saveKpiThresholds(accountId: string, th: Thresholds): void {
  try { localStorage.setItem(`wfm_kpi_th_${accountId}`, JSON.stringify(th)) } catch {}
}

export function loadStatusThresholds(accountId: string): StatusThresholds {
  try {
    const raw = localStorage.getItem(`wfm_status_th_${accountId}`)
    if (raw) return { ...DEFAULT_STATUS_THRESHOLDS, ...JSON.parse(raw) }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_STATUS_THRESHOLDS))
}

export function saveStatusThresholds(accountId: string, th: StatusThresholds): void {
  try { localStorage.setItem(`wfm_status_th_${accountId}`, JSON.stringify(th)) } catch {}
}

export function loadDataSource(accountId: string): DataSourceConfig {
  try {
    const raw = localStorage.getItem(`wfm_ds_${accountId}`)
    if (raw) return { ...DEFAULT_DATA_SOURCE, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_DATA_SOURCE }
}

export function saveDataSource(accountId: string, ds: DataSourceConfig): void {
  try { localStorage.setItem(`wfm_ds_${accountId}`, JSON.stringify(ds)) } catch {}
}

// ── Supabase schema helpers (called client-side only) ─────────────────────────
export async function fetchPublicTables(supabaseUrl: string, supabaseKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/information_schema.tables?select=table_name&table_schema=eq.public&table_type=eq.BASE+TABLE&order=table_name`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    )
    if (res.ok) {
      const data = await res.json()
      return data.map((r: any) => r.table_name)
    }
  } catch {}
  // Fallback: known tables
  return [
    'wfm_kpi_snapshots', 'wfm_agent_states', 'wfm_user_status_counts', 'wfm_active_calls',
    'talkdesk_lob_kpis', 'talkdesk_agent_states', 'talkdesk_status_counts'
  ]
}

export async function fetchTableColumns(supabaseUrl: string, supabaseKey: string, tableName: string): Promise<string[]> {
  if (!tableName) return []
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/information_schema.columns?select=column_name&table_schema=eq.public&table_name=eq.${encodeURIComponent(tableName)}&order=ordinal_position`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    )
    if (res.ok) {
      const data = await res.json()
      if (data.length > 0) return data.map((r: any) => r.column_name)
    }
  } catch {}
  // Fallback: sample row
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/${tableName}?limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    )
    if (res.ok) {
      const data = await res.json()
      if (data.length > 0) return Object.keys(data[0])
    }
  } catch {}
  return []
}

// ── Duration parsing ──────────────────────────────────────────────────────────
export function parseDurationToSeconds(str: string | null | undefined): number {
  if (!str) return 0
  const s = String(str).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  // HH:MM:SS or MM:SS
  const parts = s.split(':').map(Number)
  if (parts.every(p => !isNaN(p))) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
  }
  let total = 0
  const h = s.match(/(\d+)\s*h/i);  if (h)  total += parseInt(h[1]) * 3600
  const m = s.match(/(\d+)\s*m(?!s)/i); if (m) total += parseInt(m[1]) * 60
  const sc = s.match(/(\d+)\s*s/i); if (sc) total += parseInt(sc[1])
  return total
}

export function formatSeconds(totalSec: number): string {
  totalSec = Math.round(Math.max(0, totalSec))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

export function extractPercent(str: string | null | undefined): number {
  if (!str || str === 'N/A' || str === '-') return NaN
  const cleaned = String(str).replace(/\s+/g, '')
  const m = cleaned.match(/([\d.]+)%/)
  if (m) return parseFloat(m[1])
  const n = parseFloat(cleaned)
  return isNaN(n) ? NaN : n
}

export function isDataStale(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false
  return Date.now() - new Date(updatedAt).getTime() > 3 * 60 * 1000
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--:--'
  return new Date(iso).toLocaleTimeString()
}

export function getStatusPillClass(status: string | null): string {
  const s = (status || '').toLowerCase()
  if (s.includes('available') && !s.includes('not')) return 'pill pill-available'
  if (s.includes('ringing'))                           return 'pill pill-ringing'
  if (s.includes('in call') || s.includes('incall'))   return 'pill pill-incall'
  if (s.includes('after call') || s === 'acw')         return 'pill pill-acw'
  if (s.includes('break') || s.includes('lunch') || s.includes('do not')) return 'pill pill-break'
  if (s.includes('not available') || s.includes('unavailable'))            return 'pill pill-nav'
  if (s.includes('offline'))                           return 'pill pill-offline'
  if (s.includes('training') || s.includes('coaching') || s.includes('meeting') || s.includes('back office')) return 'pill pill-meeting'
  return 'pill pill-default'
}

export function getKpiColorClass(
  value: number,
  th: { warn: number; crit: number; direction: 'asc' | 'desc' }
): string {
  if (isNaN(value)) return 'text-muted'
  if (th.direction === 'desc') {
    if (value <= th.crit) return 'text-danger'
    if (value <= th.warn) return 'text-warning'
    return 'text-success'
  } else {
    if (value >= th.crit) return 'text-danger'
    if (value >= th.warn) return 'text-warning'
    return 'text-success'
  }
}
