// ── Supabase table types ──────────────────────────────────────────────────────
// this is found at lib/types.ts because it is used by both the dashboard and the API routes.

import type { ZohoAuxConfig } from './zohoAuxShared'
export type { ZohoAuxConfig }

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
  // True once a fetch has actually come back (false/absent on the empty
  // placeholder shown while the very first fetch is in flight). Lives IN the
  // data, not beside it, so anything reading `data` sees a matching pair.
  loaded?: boolean
  // Rows fetched from every ALTERNATE KPI table this account's config points
  // at — keyed by the SOURCE's own identity, `${table}::${accountCol}` (see
  // kpiSourceKey() in lib/breaches.ts), NOT by group id.
  //
  // Keyed by source rather than by group because a per-TILE source
  // (GroupTile.source) has no group id of its own to hang rows on, and
  // because two tiles — or a tile and a group, or tiles in two different
  // groups — pointing at the same table must share ONE fetch. Keying this
  // way makes a group-level source a special case of a tile-level one
  // instead of a second mechanism.
  //
  // WRITTEN only by lib/breaches.ts's fetchKpiSourceRows(); READ only by
  // lib/breaches.ts's makeKpiCellResolver() and freshestAcrossSources(). If
  // you are about to read this field anywhere else, read CLAUDE.md's
  // normalizeAgentRow incident first — that is the whole reason it is
  // addressed through one shared function rather than inline.
  //
  // A group/tile with no `source` is absent here and keeps reading the
  // shared `kpiRows` above exactly as before. Rebuilt on every poll
  // (components/Dashboard.tsx) and every scan (lib/cliqScan.ts) and
  // persisted NOWHERE, so this rename (it was `kpiRowsByGroup`, keyed by
  // KpiGroup.id) is purely in-memory — nothing saved in Supabase or
  // localStorage changes shape.
  kpiRowsBySource?: Record<string, Record<string, any>[]>
}

// Per-KPI Workforce RTA Logs (Zoho) reporting flags — both absent/false means
// this KPI never reaches the RTA Logs pipeline. Shared by EVERY place a KPI
// threshold can be defined (the 4 generic Thresholds keys below, each
// GroupTile, and each ExtraTile) — every KPI threshold gets this control,
// whether it's one of the 4 built-in metrics or a fully custom tile. The two
// flags are INDEPENDENT checkboxes, not mutually exclusive — per the user
// (2026-10-14), both can be on at once: a KPI then reports at LEAST every 60
// minutes AND additionally whenever it changes while breaching (which can be
// more often than the 60-minute floor). See lib/breaches.ts's
// collectRtaKpiSignals() and lib/rtaLogsChangeDetection.ts's
// computeRtaKpiSignalDue().
//   rtaReportHeartbeat    — report this KPI's CURRENT value on a fixed
//                           60-minute cadence, breaching or not.
//   rtaReportBreachChange — report whenever it's breaching AND the value
//                           changed from the last one reported.
export interface RtaReportFlags {
  rtaReportHeartbeat?:    boolean
  rtaReportBreachChange?: boolean
}

// What KIND of value a KPI's warn/crit/targ numbers represent — drives both
// how the raw scraped cell is parsed into a comparable number (lib/utils.ts's
// extractKpiValue()) and how the threshold is edited/displayed (a plain "%"
// number, an "m:ss" ClockInput, or a bare whole number). Per the user
// (2026-10-14): every account wires different things into these slots (a
// ticket count, Calls in Queue, SLA, Abandon Rate, ...), so this has to be an
// explicit per-KPI choice, not inferred from the slot's name.
//   'percent'  — e.g. SLA %, Abandon Rate — value like "85.3%"
//   'duration' — e.g. ASA/AHT — value like "1:55" (mm:ss)
//   'count'    — e.g. Calls in Queue, a ticket count — a bare whole number
export type KpiUnit = 'percent' | 'duration' | 'count'

// ── KPI threshold type ────────────────────────────────────────────────────────
// excludeZero: when the account's CRM reports a metric as exactly 0 because
// there's literally no volume to work (e.g. SLA% with zero calls offered),
// skip breach-tagging it instead of treating 0 as a critical breach.
// sendToCliq: whether a breach on THIS KPI is included in the Zoho Cliq
// channel message — same "off by default, opt in per metric" posture as
// StatusThresholds.sendToCliq (lib/utils.ts), independent of Workforce
// Logs/RTA Logs reporting (which have their own scope settings). Absent =
// false, zero migration needed — see lib/cliqScan.ts's cliqBreaches filter.
export interface Thresholds {
  sla:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean; kpiUnit?: KpiUnit; sendToCliq?: boolean } & RtaReportFlags
  wait: { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean; kpiUnit?: KpiUnit; sendToCliq?: boolean } & RtaReportFlags
  aht:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean; kpiUnit?: KpiUnit; sendToCliq?: boolean } & RtaReportFlags
  abn:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc'; excludeZero?: boolean; kpiUnit?: KpiUnit; sendToCliq?: boolean } & RtaReportFlags
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

export interface ExtraTile extends RtaReportFlags {
  key:            string   // stable id, e.g. "extra_1699..."
  label:          string
  warn:           number
  crit:           number
  targ:           number
  higherIsBetter: boolean  // true → low values are bad; false → high values are bad
  // Absent = 'percent', matching this tile's historical always-extractPercent
  // behavior (see lib/utils.ts's extractKpiValue()) — zero migration needed.
  kpiUnit?:       KpiUnit
  // See Thresholds.sendToCliq above — same semantics, per extra tile.
  sendToCliq?:    boolean
}

// A KpiGroup's own table, completely independent of the account's main
// ds.kpiTable/kpiAccountCol/kpiRowKeyCol/kpiUpdatedAt — see KpiGroup.source
// below. Mirrors AgentSource's "one source = its own table + its own column
// mapping" shape (same reasoning: different physical tables rarely share
// column names, so every column this group's cells need to resolve against
// must be spelled out per-source, not inherited from the account-wide ones).
export interface KpiGroupSource {
  table:        string
  accountCol:   string
  rowKeyCol:    string   // '' = one row expected (no match filtering needed); else the metric-identifier column within this table (e.g. "metric")
  updatedAtCol: string   // '' = no per-group staleness column available
}

export interface KpiGroup {
  id:       string
  name:     string
  groupVal?: string                    // this group's value in kpiGroupCol (e.g. skill = "Team 1")
  cells:    Record<string, CellBinding> // key: 'sla'|'aht'|'abn'|'wait'|<extra.key> — LEGACY groups only, see `tiles`
  // NEW, optional: when set, this group's cells/tiles bind against ITS OWN
  // table (see KpiGroupSource above) instead of the account-wide
  // ds.kpiTable — e.g. Flex's "First Reply Time" group reading from
  // flex_overwatch_first_reply while every other group on the same account
  // keeps reading flex_explore_tiles. Absent = LEGACY behavior: this group
  // reads from the shared ds.kpiTable exactly as before this field existed,
  // so no already-configured group needs to be touched or migrated.
  source?:  KpiGroupSource | null
  // NEW, optional: when set (non-empty), this group is fully self-contained —
  // its own tile labels, cell bindings, AND breach thresholds, completely
  // independent of every other group. Lets two groups on the same account
  // (e.g. "Messaging SLA" vs "Email SLA") show entirely different metric
  // names with entirely different threshold numbers, instead of every group
  // being forced to share ds.kpiLabels/ds.extraTiles/the account-wide KPI
  // Thresholds tab values. Absent/empty = LEGACY behavior: this group renders
  // via the shared `cells` above + ds.kpiLabels/ds.extraTiles + the account's
  // one global Thresholds object — unchanged from before this field existed,
  // so no already-configured account needs to be touched or migrated.
  tiles?:   GroupTile[]
}

// One independently-configured KPI tile within a single group — see
// KpiGroup.tiles above. Combines what used to be spread across ds.kpiLabels/
// ds.extraTiles (label) + group.cells (binding) + the account-wide Thresholds
// object (warn/crit/targ/direction/excludeZero) into one self-contained record.
export interface GroupTile extends RtaReportFlags {
  key:          string   // stable id, e.g. 'tile_1699...' (or 'sla'/'wait'/etc./an extra.key when seeded from a legacy group's existing bindings)
  label:        string
  cell:         CellBinding | null
  // NEW, optional: when set, THIS TILE binds against its own table (see
  // KpiGroupSource above) instead of whatever the rest of its group reads —
  // so ONE KPI card can mix physically different tables. Homebase's "CHAT"
  // group is the case this exists for: its "SLA" tile reads the WIDE
  // homebase_chat_kpis (one row per account, value in avg_sla_pct) while
  // "LONGEST WAIT TIME"/"ONLINE AGENTS" read the TALL
  // homebase_omni_queue_stats (one row per metric, pinned by the binding's
  // own matchCol/matchVal, value in `value`) — without splitting them into
  // three separate groups the user doesn't want.
  // Precedence is exactly three tiers, resolved in ONE place —
  // effectiveKpiSource()/makeKpiCellResolver() in lib/breaches.ts:
  //     tile.source  ->  group.source  ->  the account-wide ds.kpiTable
  // Absent/null = LEGACY behavior: this tile reads whatever its GROUP reads,
  // exactly as before this field existed, so no already-configured tile on
  // any existing account needs to be touched or migrated.
  // INDEPENDENT-TILES groups only — the legacy `cells` path is a
  // Record<string, CellBinding> with no per-entry record to hang a table on,
  // and a source stored on CellBinding would be wiped by clearCell() in
  // components/SettingsModal.tsx every time a binding is re-picked.
  // NEVER read this directly — go through lib/breaches.ts's
  // effectiveKpiSource(), which is also what the Settings editor calls.
  source?:      KpiGroupSource | null
  warn:         number
  crit:         number
  targ:         number
  direction:    'asc' | 'desc'   // 'asc' = high values are bad, 'desc' = low values are bad (same convention as Thresholds)
  excludeZero?: boolean
  // Absent = 'percent', matching this tile's historical always-extractPercent
  // behavior (see lib/utils.ts's extractKpiValue()) — zero migration needed.
  kpiUnit?:     KpiUnit
  // See Thresholds.sendToCliq above — same semantics, per independent tile.
  sendToCliq?:  boolean
  // Per-tile Workforce RTA Logs (Zoho) reporting flags — replace the old
  // account-wide "Report KPI Tile breaches" toggle (wfm_settings.
  // rta_report_kpi), which was all-or-nothing across every KPI tile. See
  // RtaReportFlags above for the flag semantics.
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
  // The title this table's agents get in the Agent Status list (and the Breach /
  // Anomalies table, which sections by the same group) — what an Additional
  // Agent Source's own "label" already does for that source. Blank/unset = the
  // raw table name, exactly as before this existed. See legacyAgentSource().
  agentTableLabel?: string
  agentAccountCol:  string
  agentNameCol:     string
  agentStatusCol:   string
  agentDurationCol: string    // duration as string e.g. "5:23"
  agentDurationSecs:string    // duration in seconds ('' if N/A)
  // Account-wide (not per-source) — the Agent Status table's Duration column
  // is one visual column regardless of which source/table a given row came
  // from, so its display label and running/static mode are single account-
  // level settings rather than something each AgentSource sets independently.
  // agentDurationLabel: custom header text, e.g. rename "Duration" to
  // "Tickets Closed" when the mapped column isn't really a duration. '' = use
  // the default "Duration" label.
  agentDurationLabel?: string
  // agentDurationStatic: true = the mapped column is NOT a real elapsed-time
  // value (e.g. a ticket count) — shown exactly as scraped, no live 1s
  // ticking, no parseDurationToSeconds/formatSeconds, and excluded from
  // duration-based status-breach thresholds (see lib/breaches.ts). false/
  // unset = default "running" behavior, unchanged from before this existed.
  agentDurationStatic?: boolean
  // Only meaningful when agentDurationStatic is true — a plain NUMERIC
  // threshold on the static value itself (e.g. breach when "Ticket Solved"
  // drops to/below a number), same shape as a KPI's own threshold (see
  // Thresholds in this file) rather than the minutes-in-status model the
  // Status Durations tab uses (which doesn't apply here — there's no real
  // elapsed time once Duration is static). Unset = no numeric breach check
  // on this value at all (purely informational), same as before this existed.
  agentDurationStaticThreshold?: { warn: number; crit: number; direction: 'asc' | 'desc'; excludeZero?: boolean }
  // Legacy single-table mapping for agentExtraCols (see AgentExtraColumn) —
  // key -> raw column name in `agentTable`. Mirrors AgentSource.extraCols.
  agentExtraColsMap: Record<string, string>
  // Optional companion mapping, ONLY meaningful for an extra column that has
  // a breachText trigger set (e.g. Wyze's Adherence column, breachText "Out
  // of adherence"): key -> a SEPARATE raw column holding a human-readable
  // duration (e.g. Wyze's own "adherence_duration", "55s"). When mapped,
  // lib/breaches.ts shows THIS value as the Breach table's "Value" for that
  // breach instead of the raw matched text ("Out of adherence") — which is
  // redundant with the Threshold column already showing that same trigger
  // text, whereas a duration ("how long have they been out of adherence")
  // is actually useful there. Unmapped = unchanged behavior (raw breach text
  // shown as Value, exactly as before this existed). Mirrors
  // AgentSource.extraDurationCols for additional sources.
  agentExtraDurationColsMap?: Record<string, string>
  // Same idea as agentExtraDurationColsMap, for the Breach table's "Metric"
  // column instead of "Value": key -> a raw column whose per-agent value
  // replaces this column's own `label` as Metric (e.g. mapping to the
  // account's status column shows "Away"/"Offline" per row instead of
  // always "Adherence" — but any column can be mapped, not just status).
  // Unmapped = unchanged behavior (this column's label shown as Metric for
  // every row). Mirrors AgentSource.extraMetricCols for additional sources.
  agentExtraMetricColsMap?: Record<string, string>

  // Workforce RTA Logs (Zoho) reporting for agent-status breaches — a GROUP-
  // level flag (not per-status, unlike the KPI side's per-tile
  // RtaReportFlags): every currently-breaching agent across every status
  // reports together, in one bulk submission. Independent of (can be on
  // alongside) wfm_settings.rta_report_agent_status, which still gates the
  // existing "report when a NEW agent joins a breach type" behavior (see
  // lib/rtaLogsChangeDetection.ts). This flag adds a second, timer-based mode
  // on top: every 60 minutes, if at least one agent is currently breaching,
  // report the full current list regardless of whether it changed. Lives
  // here (in the always-safe data_source JSONB) rather than as its own
  // wfm_settings column, same reasoning as GroupTile.rtaReportHeartbeat.
  rtaReportAgentStatusHeartbeat?: boolean

  // Custom Agent Status table columns, defined once for the whole account —
  // see AgentExtraColumn. Where each one's value comes from (which raw
  // column, per table) is mapped separately: agentExtraColsMap above for the
  // legacy single table, AgentSource.extraCols for each additional source.
  agentExtraCols: AgentExtraColumn[]

  // Which Agent Status columns the Breach / Anomalies tables (Dashboard page
  // AND Overview card) show next to each breach — picked with the gear on the
  // table's header (components/BreachColumnsModal.tsx). Keys are
  // BREACH_COL_STATUS / BREACH_COL_DURATION (lib/breaches.ts) for the built-in
  // Status and Duration columns, or an AgentExtraColumn.key. Always shown in
  // the Agent Status table's own column order. Undefined = never set with the
  // gear: falls back to the older per-column AgentExtraColumn.showInBreachTable
  // flags (see breachTableExtraCols).
  breachTableCols?: string[]

  // Multiple agent tables and/or one table split into groups. Covers two
  // cases: (1) agent status is scraped into several physical tables (e.g.
  // Hippo's hippo_licensed_agents + hippo_level_1) — one AgentSource per
  // table; (2) agent status is one table with a column that already
  // distinguishes teams/queues (e.g. ZenBusiness's zenbusiness_agent_states.
  // team_name) — one AgentSource with groupByCol set, rows grouped by that
  // column's value instead of a fixed label. When non-empty, this takes
  // priority over the legacy single-table fields above.
  agentSources:  AgentSource[]

  // Zoho breaks & aux for this account's agents (Settings → Zoho Integrations).
  // When enabled, the dashboard adds a "Zoho Breaks & Aux" agent section fed by
  // wfm_zoho_agent_status — see lib/zohoAuxShared.ts / lib/zohoAux.ts. Kept in
  // this always-saved JSONB rather than its own wfm_settings column, so it needs
  // no migration of wfm_settings and can't trip the unknown-column fallbacks in
  // lib/settings.ts.
  zohoAux?: ZohoAuxConfig
}

// ── Dashboard panel layout (Dashboard page — KPI groups, Breach, Agent Status)
// Per-account, saved to wfm_settings.dashboard_layout. Panel ids: "kpi:<groupId>",
// "breach", "agents". Positions are plain pixels within the page's own layout
// container — see the LayoutPanel component in Dashboard.tsx.
export interface PanelRect { x: number; y: number; w: number; h: number }
export type DashboardLayout = Record<string, PanelRect>

// ── Overview page header colors (band background + title text) ──────────────
// Per-account, saved to wfm_settings.header_band_color/header_text_color —
// shared across every browser/device, unlike the theme toggle. '' = default.
export interface HeaderColors { band: string; text: string }

// ── Zoho Cliq breach-notification settings ───────────────────────────────────
// Global settings live in the wfm_cliq_settings singleton row (id='global').
// Per-account cliqChannel/cliqLastSentAt live on wfm_settings alongside the
// other per-account config. The actual scan/send loop runs in the wfm-live-
// scraper process, not this app — this app only edits the config it reads.
export interface CliqGlobalSettings {
  enabled:          boolean
  testMode:         boolean
  frequencyMinutes: number   // cooldown between repeat alerts for the same account
}

// ── Zoho Creator Workforce Logs reporting ─────────────────────────────────────
// One of these per lookup field the Workforce Logs form needs (x_Account,
// Category, Sub_Categories, Site). Picking a value scanned by
// lib/zohoFieldScan.ts fills in `id` (writes by exact Zoho record ID, most
// reliable); typing something new leaves `id` blank and uses `text` instead
// (writes by display value). Both blank means "don't set this field".
export interface ZohoLookupChoice { id: string; text: string }
export interface ZohoLookups {
  account:     ZohoLookupChoice
  category:    ZohoLookupChoice
  subCategory: ZohoLookupChoice
  site:        ZohoLookupChoice
}
export const DEFAULT_ZOHO_LOOKUPS: ZohoLookups = {
  account:     { id: '', text: '' },
  category:    { id: '', text: '' },
  subCategory: { id: '', text: '' },
  site:        { id: '', text: '' },
}

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
  // Custom Agent Table columns (see AgentExtraColumn) — maps each column's
  // key to the raw column name in THIS source's table. Different sources can
  // point the same custom column at a differently-named column (or leave it
  // unmapped, which renders blank for that source's rows).
  extraCols:        Record<string, string>
  // Optional companion mapping — mirrors DataSourceConfig.agentExtraDurationColsMap,
  // see its comment for the full reasoning. Per-source since each source can
  // point the same extra column's duration companion at a differently-named
  // column, same as extraCols above.
  extraDurationCols?: Record<string, string>
  // Mirrors DataSourceConfig.agentExtraMetricColsMap — see its comment.
  extraMetricCols?: Record<string, string>
  // Optional: a column holding WHEN the current status started (a timestamp),
  // instead of a scraped "00:05:44" duration. The duration is then worked out
  // as now − that time whenever the row is read (lib/breaches.ts's
  // normalizeAgentRow), so it is right however long ago the row was written —
  // used by the Zoho Breaks & Aux section, whose rows only change when Zoho
  // does (lib/zohoAuxShared.ts).
  durationSinceCol?: string
}

// ── Custom Agent Status table columns ─────────────────────────────────────────
// User-defined columns added to the Agent Status table beyond the fixed
// Agent/Status/Duration ones (see components/Dashboard.tsx's agent table).
// Defined ONCE per account (shown as an extra <th> for every agent row,
// regardless of which AgentSource/legacy table produced it) — same
// add/rename/remove pattern as ExtraTile, but with no numeric thresholds
// since this is a plain display column, not a KPI. Where each column's VALUE
// actually comes from is mapped separately per source: DataSourceConfig.
// agentExtraColsMap (legacy single-table) and AgentSource.extraCols (each
// additional source), both keyed by this key.
export interface AgentExtraColumn {
  key:   string   // stable id, e.g. "agentcol_1699..."
  label: string   // shown as the table's column header
  // Optional TEXT-based breach rule — some CRMs flag a problem as a literal
  // status word (e.g. Wyze's Adherence column reading "Out of adherence")
  // rather than a duration to compare against a threshold. When set,
  // lib/breaches.ts flags any agent whose value for this column contains
  // this text (case-insensitive) as a breach. Blank = never breach on this
  // column — a purely informational display column, the default.
  breachText?:     string
  breachSeverity?: 'warning' | 'critical'   // only meaningful when breachText is set; defaults to 'critical'
  // Also show this column in the Breach / Anomalies table (Dashboard page AND
  // the Overview card): an agent breach shows that agent's value for it, a KPI
  // breach shows "—". Off by default — the table stays as it was. Superseded by
  // DataSourceConfig.breachTableCols once the table's gear has been used; only
  // read while that is unset.
  showInBreachTable?: boolean
}
