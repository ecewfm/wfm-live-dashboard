import type { Thresholds, DataSourceConfig, KpiGroup, CellBinding, ExtraTile, AgentSource, DashboardLayout } from './types'

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

// ── Data source model helpers ─────────────────────────────────────────────────
export const DEFAULT_KPI_LABELS = { sla: 'SLA %', aht: 'AHT', abn: 'ABN %', wait: 'Awaiting' }

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** A fresh group with no cell bindings. */
export function newGroup(name = 'Global'): KpiGroup {
  return { id: genId(), name, cells: {} }
}

/** A fresh agent source — one table + its column mapping, optionally grouped
 *  by a column value instead of a fixed label (see AgentSource.groupByCol). */
export function newAgentSource(label = ''): AgentSource {
  return {
    id: genId(), label, table: '',
    accountCol: 'account_id', nameCol: '', statusCol: '', durationCol: '', durationSecsCol: '',
    groupByCol: '',
  }
}

/** Read a single value from the fetched KPI rows using a cell binding.
 *  Narrows by the group value (groupCol=groupVal) AND the cell's row match, so
 *  a 2-D table (skill × metric) resolves to exactly one row. */
export function resolveCell(
  rows: Record<string, any>[], binding?: CellBinding,
  groupCol?: string, groupVal?: string
): string {
  if (!binding || !binding.valueCol) return ''
  const hasMatch = !!(binding.matchCol && binding.matchVal !== undefined && binding.matchVal !== '')
  const byMatch = (arr: Record<string, any>[]) =>
    hasMatch ? arr.filter(r => String(r[binding.matchCol!] ?? '') === String(binding.matchVal)) : arr

  let cands = rows
  if (groupCol && groupVal !== undefined && groupVal !== '') {
    cands = cands.filter(r => String(r[groupCol] ?? '') === String(groupVal))
  }
  cands = byMatch(cands)

  // Fallback: if the group filter eliminated everything but the row key is set
  // (kpi_key/id is unique on its own), resolve by the row key alone. Guards
  // against a stale/mismatched group value.
  if (cands.length === 0 && hasMatch) cands = byMatch(rows)

  const row = cands[0]
  return row ? String(row[binding.valueCol] ?? '') : ''
}

/** Color class for an extra tile given its own thresholds + direction. */
export function getExtraTileColorClass(value: number, t: ExtraTile): string {
  if (isNaN(value)) return 'text-muted'
  if (t.higherIsBetter) {
    // low = bad
    if (value <= t.crit) return 'text-danger'
    if (value <= t.warn) return 'text-warning'
    return 'text-success'
  }
  // high = bad
  if (value >= t.crit) return 'text-danger'
  if (value >= t.warn) return 'text-warning'
  return 'text-success'
}

// ── Data source presets (cell-picker model) ───────────────────────────────────
// Presets seed the table + a single "Global" group with best-guess value columns.
// For multi-LOB / tall tables, set the Row-key column and add groups manually.
export const PRESET_AIRCALL: DataSourceConfig = {
  version:       2,
  kpiTable:      'wfm_kpi_snapshots',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   '',
  kpiRowKeyCol:  '',
  kpiUpdatedAt:  'updated_at',
  kpiLabels:     { ...DEFAULT_KPI_LABELS },
  extraTiles:    [],
  groups:        [{ id: 'global', name: 'Global', cells: {
    sla:  { valueCol: 'sla' },
    wait: { valueCol: 'calls_waiting' },
    aht:  { valueCol: 'time_to_answer' },
  } }],
  agentTable:       'wfm_agent_states',
  agentAccountCol:  'account_id',
  agentNameCol:     'agent_name',
  agentStatusCol:   'status',
  agentDurationCol: 'duration',
  agentDurationSecs:'',
  agentSources:     []
}

export const PRESET_TALKDESK: DataSourceConfig = {
  version:       2,
  kpiTable:      'talkdesk_lob_kpis',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   'lob_name',
  kpiRowKeyCol:  '',
  kpiUpdatedAt:  'updated_at',
  kpiLabels:     { ...DEFAULT_KPI_LABELS },
  extraTiles:    [],
  groups:        [{ id: 'global', name: 'Global', cells: {
    sla:  { valueCol: 'sla' },
    wait: { valueCol: 'contacts_in_queue' },
    aht:  { valueCol: 'aht' },
  } }],
  agentTable:       'talkdesk_agent_states',
  agentAccountCol:  'account_id',
  agentNameCol:     'agent_name',
  agentStatusCol:   'status',
  agentDurationCol: 'duration',
  agentDurationSecs:'duration_secs',
  agentSources:     []
}

export const DEFAULT_DATA_SOURCE: DataSourceConfig = {
  version:       2,
  kpiTable:      '',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   '',
  kpiRowKeyCol:  '',
  kpiUpdatedAt:  'updated_at',
  kpiLabels:     { ...DEFAULT_KPI_LABELS },
  extraTiles:    [],
  groups:        [{ id: 'global', name: 'Global', cells: {} }],
  agentTable:       '',
  agentAccountCol:  'account_id',
  agentNameCol:     'name',
  agentStatusCol:   'state',
  agentDurationCol: 'duration',
  agentDurationSecs:'',
  agentSources:     []
}

/** Convert any stored data-source shape (old column-based or new) to the v2 model. */
export function migrateDataSource(raw: any): DataSourceConfig {
  if (!raw || typeof raw !== 'object') return JSON.parse(JSON.stringify(DEFAULT_DATA_SOURCE))

  // Already v2
  if (raw.version === 2 && Array.isArray(raw.groups)) {
    return {
      ...JSON.parse(JSON.stringify(DEFAULT_DATA_SOURCE)),
      ...raw,
      kpiLabels:    { ...DEFAULT_KPI_LABELS, ...(raw.kpiLabels || {}) },
      extraTiles:   Array.isArray(raw.extraTiles) ? raw.extraTiles : [],
      groups:       raw.groups.length ? raw.groups : [newGroup()],
      agentSources: Array.isArray(raw.agentSources) ? raw.agentSources : [],
    }
  }

  // Legacy column-based → single "Global" group with column value-bindings
  const cells: Record<string, CellBinding> = {}
  if (raw.kpiSlaCol)   cells.sla  = { valueCol: raw.kpiSlaCol }
  if (raw.kpiQueueCol) cells.wait = { valueCol: raw.kpiQueueCol }
  if (raw.kpiAsaCol)   cells.aht  = { valueCol: raw.kpiAsaCol }
  if (raw.kpiAbnCol)   cells.abn  = { valueCol: raw.kpiAbnCol }

  return {
    version:       2,
    kpiTable:      raw.kpiTable      || '',
    kpiAccountCol: raw.kpiAccountCol || 'account_id',
    kpiGroupCol:   raw.kpiGroupCol   || '',
    kpiRowKeyCol:  '',
    kpiUpdatedAt:  raw.kpiUpdatedAt  || 'updated_at',
    kpiLabels:     { ...DEFAULT_KPI_LABELS },
    extraTiles:    [],
    groups:        [{ id: 'global', name: 'Global', cells }],
    agentTable:       raw.agentTable       || '',
    agentAccountCol:  raw.agentAccountCol  || 'account_id',
    agentNameCol:     raw.agentNameCol     || 'name',
    agentStatusCol:   raw.agentStatusCol   || 'state',
    agentDurationCol: raw.agentDurationCol || 'duration',
    agentDurationSecs:raw.agentDurationSecs|| '',
    agentSources:     [],
  }
}

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
    if (raw) return migrateDataSource(JSON.parse(raw))
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_DATA_SOURCE))
}

export function saveDataSource(accountId: string, ds: DataSourceConfig): void {
  try { localStorage.setItem(`wfm_ds_${accountId}`, JSON.stringify(ds)) } catch {}
}

// ── Dashboard panel layout (drag/resize) ──────────────────────────────────────
export function loadDashboardLayout(accountId: string): DashboardLayout {
  try {
    const raw = localStorage.getItem(`wfm_layout_${accountId}`)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}

export function saveDashboardLayoutLocal(accountId: string, layout: DashboardLayout): void {
  try { localStorage.setItem(`wfm_layout_${accountId}`, JSON.stringify(layout)) } catch {}
}

/** Default panel positions for panel ids not yet present in a saved layout —
 *  stacked KPI group rows, then Breach/Anomalies + Agent Status side by side.
 *  Matches the original fixed flex layout's visual arrangement so a fresh
 *  account (no custom layout saved yet) looks the same as before this
 *  feature existed. */
export function defaultDashboardLayout(kpiGroupIds: string[]): DashboardLayout {
  const layout: DashboardLayout = {}
  let y = 0
  kpiGroupIds.forEach(gid => {
    layout[`kpi:${gid}`] = { x: 0, y, w: 1180, h: 150 }
    y += 166
  })
  layout['breach'] = { x: 0,   y, w: 580, h: 360 }
  layout['agents'] = { x: 600, y, w: 580, h: 360 }
  return layout
}

// ── Supabase schema helpers ───────────────────────────────────────────────────
// Uses two SQL RPC functions (get_public_tables, get_table_columns) that must
// exist in your Supabase project. See README for the CREATE FUNCTION SQL.
// Falls back to the OpenAPI spec if the functions don't exist yet.

const RPC = (url: string, key: string, fn: string, args = {}) =>
  fetch(`${url}/rest/v1/rpc/${fn}`, {
    method:  'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  })

export async function fetchPublicTables(supabaseUrl: string, supabaseKey: string): Promise<string[]> {
  // 1. Try the SQL RPC function (most reliable — auto-discovers all tables)
  try {
    const res = await RPC(supabaseUrl, supabaseKey, 'get_public_tables')
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) return data as string[]
    }
  } catch {}

  // 2. Fallback: OpenAPI spec
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
                 Accept: 'application/openapi+json' }
    })
    if (res.ok) {
      const spec = await res.json()
      const tables = Object.keys(spec.paths ?? {})
        .filter(p => p.startsWith('/') && !p.includes('{') && !p.startsWith('/rpc'))
        .map(p => p.slice(1)).filter(Boolean).sort()
      if (tables.length > 0) return tables
    }
  } catch {}

  return []
}

export async function fetchTableColumns(supabaseUrl: string, supabaseKey: string, tableName: string): Promise<string[]> {
  if (!tableName) return []

  // 1. Try the SQL RPC function
  try {
    const res = await RPC(supabaseUrl, supabaseKey, 'get_table_columns', { p_table: tableName })
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) return data as string[]
    }
  } catch {}

  // 2. Fallback: sample row
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${tableName}?limit=1`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
    })
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) return Object.keys(data[0])
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
  return Date.now() - new Date(updatedAt).getTime() > 5 * 60 * 1000
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
    // Low = Bad: boundary values fall in the BETTER zone
    // e.g. crit=70, warn=80 → <70=red, 70–79=yellow, ≥80=green
    if (value < th.crit) return 'text-danger'
    if (value < th.warn) return 'text-warning'
    return 'text-success'
  } else {
    // High = Bad: boundary values fall in the WORSE zone
    // e.g. warn=30, crit=60 → <30=green, 30–59=yellow, ≥60=red
    if (value >= th.crit) return 'text-danger'
    if (value >= th.warn) return 'text-warning'
    return 'text-success'
  }
}

// ── Five9 data source preset ──────────────────────────────────────────────────
// five9_kpis is a TALL table (one row per metric: kpi_key, label, skill, value).
// Set Row-key = 'label' and add a group per skill, pinning each KPI to the row
// whose label/kpi_key matches (via the cell picker).
export const PRESET_FIVE9: DataSourceConfig = {
  version:       2,
  kpiTable:      'five9_kpis',
  kpiAccountCol: 'account_id',
  kpiGroupCol:   'skill',
  kpiRowKeyCol:  'label',
  kpiUpdatedAt:  'updated_at',
  kpiLabels:     { ...DEFAULT_KPI_LABELS },
  extraTiles:    [],
  groups:        [{ id: 'global', name: 'Global', cells: {} }],
  agentTable:       'five9_agent_states',
  agentAccountCol:  'account_id',
  agentNameCol:     'name',
  agentStatusCol:   'state',
  agentDurationCol: 'duration',
  agentDurationSecs:'',
  agentSources:     []
}

// Uniters uses its own dedicated tables (same tall shape as Five9).
export const PRESET_UNITERS: DataSourceConfig = {
  ...JSON.parse(JSON.stringify(PRESET_FIVE9)),
  kpiTable:   'uniters_kpis',
  agentTable: 'uniters_agent_states',
}