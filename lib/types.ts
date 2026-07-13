// ── Supabase table types ──────────────────────────────────────────────────────
// this is found at lib/types.ts because it is used by both the dashboard and the API routes.

export interface KpiSnapshot {
  id?: string
  account_id: string
  sla?: string
  total_calls?: string
  outbound?: string
  inbound?: string
  answered?: string
  unanswered?: string
  time_to_answer?: string
  longest_waiting?: string
  available_users?: string
  calls_waiting?: string
  updated_at?: string
  [key: string]: any  // allow dynamic column access
}

export interface AgentState {
  id?: string
  account_id: string
  agent_name: string
  status?: string
  duration?: string
  updated_at?: string
  [key: string]: any
}

export interface UserStatusCounts {
  id?: string
  account_id: string
  available?: number
  ringing?: number
  in_call?: number
  after_call_work?: number
  not_available?: number
  do_not_disturb?: number
  on_a_break?: number
  out_for_lunch?: number
  offline?: number
  updated_at?: string
  [key: string]: any
}

export interface ActiveCall {
  id?: string
  account_id: string
  direction?: string
  status?: string
  duration?: string
  updated_at?: string
  [key: string]: any
}

// ── Account data (generic — supports any data source) ─────────────────────────
export interface AccountData {
  kpi:     Record<string, any> | null    // single-row KPI (Aircall-style)
  kpiRows: Record<string, any>[]         // multi-row KPI (Talkdesk LOB-style)
  agents:  Record<string, any>[]
  status:  Record<string, any> | null
  calls:   Record<string, any>[]
  syncing?: boolean
}

// ── KPI threshold type ────────────────────────────────────────────────────────
// excludeZero: when the account's CRM reports a metric as exactly 0 because
// there's literally no volume to work (e.g. SLA% with zero calls offered),
// skip breach-tagging it instead of treating 0 as a critical breach.
export interface Thresholds {
  sla:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
  wait: { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
  aht:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
  abn:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
}

// ── Data source configuration (per account, stored in wfm_settings + localStorage)
// Cell-picker model (mirrors the Apps Script DataSourcePicker):
//   • The KPI table is fetched as rows filtered by account_id.
//   • You define one or more GROUPS (LOBs) by hand.
//   • Each group binds each KPI (core + extra tiles) to a CELL:
//       - valueCol: the column holding the value
//       - matchCol/matchVal: optionally pin a specific row (tall tables like
//         five9_kpis where kpiRowKeyCol='kpi_key'); omit for single-row/first-row.

export interface CellBinding {
  valueCol: string    // column holding the value
  matchCol?: string   // optional: column used to identify a specific row
  matchVal?: string   // optional: value of matchCol that identifies the row
}

export interface ExtraTile {
  key:            string   // stable id, e.g. "extra_1699..."
  label:          string
  warn:           number
  crit:           number
  targ:           number
  higherIsBetter: boolean  // true → low values are bad; false → high values are bad
}

export interface KpiGroup {
  id:       string
  name:     string
  groupVal?: string                    // this group's value in kpiGroupCol (e.g. skill = "Team 1")
  cells:    Record<string, CellBinding> // key: 'sla'|'aht'|'abn'|'wait'|<extra.key>
}

export interface DataSourceConfig {
  version:       number   // 2 = cell-picker model

  // KPI data
  kpiTable:      string
  kpiAccountCol: string   // column that contains account_id
  kpiGroupCol:   string   // '' = single group; else the column whose distinct values are the LOBs (e.g. skill, lob_name)
  kpiRowKeyCol:  string   // '' = one row per group; else the metric-identifier column within a group (e.g. label, kpi_key)
  kpiUpdatedAt:  string   // column for updated_at timestamp
  kpiLabels:     { sla: string; aht: string; abn: string; wait: string }
  extraTiles:    ExtraTile[]
  groups:        KpiGroup[]

  // Agent data (column-based — one row per agent already)
  // Legacy single-table fields — still read as a fallback when agentSources
  // is empty, so every account configured before agentSources existed keeps
  // working unchanged. New setup should use agentSources instead.
  agentTable:       string
  agentAccountCol:  string
  agentNameCol:     string
  agentStatusCol:   string
  agentDurationCol: string    // duration as string e.g. "5:23"
  agentDurationSecs:string    // duration in seconds ('' if N/A)

  // Multiple agent tables and/or one table split into groups. Covers two
  // cases: (1) agent status is scraped into several physical tables (e.g.
  // Hippo's hippo_licensed_agents + hippo_level_1) — one AgentSource per
  // table; (2) agent status is one table with a column that already
  // distinguishes teams/queues (e.g. ZenBusiness's zenbusiness_agent_states.
  // team_name) — one AgentSource with groupByCol set, rows grouped by that
  // column's value instead of a fixed label. When non-empty, this takes
  // priority over the legacy single-table fields above.
  agentSources:  AgentSource[]
}

// ── Dashboard panel layout (Dashboard page — KPI groups, Breach, Agent Status)
// Per-account, saved to wfm_settings.dashboard_layout. Panel ids: "kpi:<groupId>",
// "breach", "agents". Positions are plain pixels within the page's own layout
// container — see the LayoutPanel component in Dashboard.tsx.
export interface PanelRect { x: number; y: number; w: number; h: number }
export type DashboardLayout = Record<string, PanelRect>

export interface AgentSource {
  id:               string   // stable id for React keys / add-remove
  label:            string   // static group label for rows from this source (ignored when groupByCol is set)
  table:            string
  accountCol:       string
  nameCol:          string
  statusCol:        string
  durationCol:      string
  durationSecsCol:  string
  groupByCol:       string   // '' = use `label` for every row; else group rows by this column's own value (e.g. "team_name")
}
