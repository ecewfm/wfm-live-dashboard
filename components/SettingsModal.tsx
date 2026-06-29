'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Thresholds, DataSourceConfig } from '@/lib/types'
import type { StatusThresholds } from '@/lib/utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS,
  PRESET_AIRCALL, PRESET_TALKDESK,
  fetchPublicTables, fetchTableColumns
} from '@/lib/utils'

type Tab = 'kpi' | 'status' | 'datasource'

const KPI_ROWS: { key: keyof Thresholds; label: string; sublabel: string; unit: string }[] = [
  { key: 'sla',  label: 'SLA %',         sublabel: 'Service Level Agreement',       unit: '%' },
  { key: 'aht',  label: 'ASA',           sublabel: 'Avg Speed of Answer (minutes)',  unit: 'm' },
  { key: 'abn',  label: 'ABN %',         sublabel: 'Abandon Rate Percentage',        unit: '%' },
  { key: 'wait', label: 'Calls Waiting', sublabel: 'Current Queue Depth',            unit: ''  },
]

const STATUS_ROWS: { key: string; label: string }[] = [
  { key: 'Ringing',         label: 'Ringing'         },
  { key: 'In call',         label: 'In Call'          },
  { key: 'After call work', label: 'After Call Work'  },
  { key: 'On a break',      label: 'On a Break'       },
  { key: 'Out for lunch',   label: 'Out for Lunch'    },
  { key: 'Do not disturb',  label: 'Do Not Disturb'   },
  { key: 'Not available',   label: 'Not Available'    },
  { key: 'Back office',     label: 'Back Office'      },
  { key: 'In training',     label: 'In Training'      },
  { key: 'Other',           label: 'Other'            },
]

// ── All modal CSS self-contained — no globals.css dependency ──────────────────
const MODAL_STYLES = `
  .sm-overlay {
    position: fixed !important;
    top: 0 !important; left: 0 !important;
    right: 0 !important; bottom: 0 !important;
    z-index: 99999 !important;
    background: rgba(0,0,0,0.65);
    display: flex !important;
    align-items: center;
    justify-content: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }
  .sm-modal {
    background: var(--bg-card, #ffffff);
    border: 1px solid var(--border, #e1e6e4);
    border-radius: 12px;
    width: 100%; max-width: 740px;
    max-height: 90vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    overflow: hidden;
    animation: sm-appear 0.18s ease-out;
    font-family: var(--font-sans, 'Poppins', Arial, sans-serif);
  }
  @keyframes sm-appear {
    from { opacity: 0; transform: scale(0.95) translateY(10px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  .dark .sm-modal { background: #1a1a1a; border-color: #2e2e2e; }
  .sm-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 24px;
    background: linear-gradient(135deg, #3b5a4f 0%, #2b423a 100%);
    flex-shrink: 0;
  }
  .sm-header-left { display: flex; align-items: center; gap: 12px; }
  .sm-header-icon { font-size: 26px; color: #d97a35; }
  .sm-title { font-size: 16px; font-weight: 700; color: #fff; }
  .sm-subtitle { font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 2px; }
  .sm-subtitle strong { color: rgba(255,255,255,0.9); }
  .sm-close {
    width: 34px; height: 34px; border-radius: 8px;
    background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
    color: #fff; font-size: 22px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s; line-height: 1;
  }
  .sm-close:hover { background: rgba(255,255,255,0.22); }
  .sm-tabs {
    display: flex; border-bottom: 1px solid var(--border, #e1e6e4);
    padding: 0 24px; flex-shrink: 0;
    background: var(--bg-body, #f0f2f1);
  }
  .dark .sm-tabs { background: #111; border-bottom-color: #2e2e2e; }
  .sm-tab {
    display: flex; align-items: center; gap: 7px;
    padding: 12px 16px; font-size: 13px; font-weight: 500;
    color: var(--text-muted, #687d75);
    background: transparent; border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer; margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
    font-family: inherit;
  }
  .sm-tab i { font-size: 15px; }
  .sm-tab:hover { color: var(--text-main, #2c3b36); }
  .sm-tab.active { color: #d97a35; border-bottom-color: #d97a35; font-weight: 600; }
  .dark .sm-tab:hover { color: #f0f0f0; }
  .sm-body { flex: 1; overflow-y: auto; padding: 22px 24px; }
  .sm-desc { font-size: 12px; color: var(--text-muted, #687d75); margin-bottom: 16px; line-height: 1.65; }
  .sm-section-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--text-muted, #687d75);
    padding-bottom: 8px; border-bottom: 1px solid var(--border, #e1e6e4);
    margin-bottom: 14px;
  }
  .dark .sm-section-title { border-bottom-color: #2e2e2e; }
  .sm-note {
    display: flex; align-items: flex-start; gap: 7px;
    margin-top: 14px; padding: 10px 14px;
    background: rgba(75,139,156,0.08); border: 1px solid rgba(75,139,156,0.22);
    border-radius: 6px; font-size: 12px; color: var(--text-muted, #687d75); line-height: 1.55;
  }
  .sm-note i { font-size: 15px; color: #4b8b9c; flex-shrink: 0; margin-top: 1px; }
  .sm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sm-table thead th {
    padding: 9px 14px; text-align: left;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--text-muted, #687d75);
    border-bottom: 2px solid var(--border, #e1e6e4);
    background: rgba(0,0,0,0.02); white-space: nowrap;
  }
  .dark .sm-table thead th { background: rgba(255,255,255,0.02); border-bottom-color: #2e2e2e; color: #888; }
  .sm-table tbody td {
    padding: 10px 14px; border-bottom: 1px solid var(--border, #e1e6e4);
    vertical-align: middle; color: var(--text-main, #2c3b36);
  }
  .dark .sm-table tbody td { border-bottom-color: #2e2e2e; color: #e0e0e0; }
  .sm-table tbody tr:last-child td { border-bottom: none; }
  .sm-table tbody tr:hover { background: rgba(0,0,0,0.015); }
  .dark .sm-table tbody tr:hover { background: rgba(255,255,255,0.02); }
  .sm-metric { font-size: 13px; font-weight: 600; }
  .sm-metric-sub { font-size: 11px; color: var(--text-muted, #687d75); margin-top: 2px; }
  .sm-input-cell { display: flex; align-items: center; gap: 6px; }
  .sm-input {
    width: 68px; padding: 7px 8px;
    background: var(--bg-body, #f0f2f1); border: 1px solid var(--border, #e1e6e4);
    border-radius: 6px; color: var(--text-main, #2c3b36);
    font-family: inherit; font-size: 13px; font-weight: 500;
    outline: none; text-align: center; transition: border-color 0.15s, box-shadow 0.15s;
  }
  .sm-input:focus { border-color: #d97a35; box-shadow: 0 0 0 3px rgba(217,122,53,0.15); }
  .dark .sm-input { background: #111; border-color: #2e2e2e; color: #e0e0e0; }
  .sm-unit { font-size: 11px; color: var(--text-muted, #687d75); white-space: nowrap; }
  .sm-dir-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: 6px; cursor: pointer;
    font-size: 11px; font-weight: 600; white-space: nowrap;
    border: 1px solid transparent; transition: all 0.15s; font-family: inherit;
  }
  .sm-dir-btn i { font-size: 14px; }
  .sm-dir-btn.asc  { background: rgba(217,158,53,0.1); color: #d99e35; border-color: rgba(217,158,53,0.3); }
  .sm-dir-btn.asc:hover  { background: rgba(217,158,53,0.2); }
  .sm-dir-btn.desc { background: rgba(75,139,156,0.1); color: #4b8b9c; border-color: rgba(75,139,156,0.3); }
  .sm-dir-btn.desc:hover { background: rgba(75,139,156,0.2); }
  /* Data source tab styles */
  .ds-row {
    display: grid; grid-template-columns: 140px 1fr; gap: 10px;
    align-items: center; padding: 8px 0;
    border-bottom: 1px solid var(--border, #e1e6e4);
  }
  .dark .ds-row { border-bottom-color: #2e2e2e; }
  .ds-row:last-child { border-bottom: none; }
  .ds-label { font-size: 12px; color: var(--text-muted, #687d75); font-weight: 500; }
  .ds-select {
    width: 100%; padding: 7px 10px;
    background: var(--bg-body, #f0f2f1); border: 1px solid var(--border, #e1e6e4);
    border-radius: 6px; color: var(--text-main, #2c3b36);
    font-family: inherit; font-size: 13px; outline: none;
    transition: border-color 0.15s;
  }
  .ds-select:focus { border-color: #d97a35; }
  .dark .ds-select { background: #111; border-color: #2e2e2e; color: #e0e0e0; }
  .ds-preset-row { display: flex; gap: 8px; margin-bottom: 16px; }
  .ds-preset-btn {
    padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
    cursor: pointer; border: 1px solid; transition: all 0.15s; font-family: inherit;
  }
  .ds-preset-btn.aircall  { background: rgba(59,90,79,0.1); color: #3b5a4f; border-color: rgba(59,90,79,0.3); }
  .ds-preset-btn.aircall:hover  { background: rgba(59,90,79,0.2); }
  .ds-preset-btn.talkdesk { background: rgba(75,139,156,0.1); color: #4b8b9c; border-color: rgba(75,139,156,0.3); }
  .ds-preset-btn.talkdesk:hover { background: rgba(75,139,156,0.2); }
  .ds-loading { font-size: 12px; color: var(--text-muted, #687d75); padding: 4px 0; }
  /* Footer */
  .sm-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px; border-top: 1px solid var(--border, #e1e6e4);
    background: var(--bg-body, #f0f2f1); flex-shrink: 0;
  }
  .dark .sm-footer { background: #111; border-top-color: #2e2e2e; }
  .sm-btn-reset {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 500;
    background: transparent; border: 1px solid var(--border, #e1e6e4);
    color: var(--text-muted, #687d75); cursor: pointer; transition: all 0.15s; font-family: inherit;
  }
  .sm-btn-reset:hover { border-color: #888; color: var(--text-main, #2c3b36); }
  .sm-btn-cancel {
    padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 500;
    background: transparent; border: 1px solid var(--border, #e1e6e4);
    color: var(--text-main, #2c3b36); cursor: pointer; transition: background 0.15s; font-family: inherit;
  }
  .sm-btn-cancel:hover { background: rgba(0,0,0,0.04); }
  .sm-btn-save {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 20px; border-radius: 6px; font-size: 13px; font-weight: 700;
    background: #d97a35; border: none; color: #fff; cursor: pointer;
    transition: opacity 0.15s; font-family: inherit;
  }
  .sm-btn-save:hover { opacity: 0.88; }
`

interface Props {
  accountId: string
  kpiThresholds: Thresholds
  statusThresholds: StatusThresholds
  dataSource: DataSourceConfig
  onSave: (kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig) => void
  onClose: () => void
}

// ── ColSelect — React.memo prevents re-render closing the dropdown ────────────
// CRITICAL: defined at MODULE level, never inside another component.
// Having components inside render functions causes unmount/remount on every
// parent render, which closes any open native <select> dropdown.
// eslint-disable-next-line react/display-name
const ColSelect = React.memo(({ field, value, cols, onSet }: {
  field: keyof DataSourceConfig, value: string, cols: string[]
  onSet: (k: keyof DataSourceConfig, v: string) => void
}) => (
  <select
    className="ds-select"
    value={value}
    onChange={e => onSet(field, e.target.value)}
  >
    <option value="">-- none --</option>
    {cols.map(c => <option key={c} value={c}>{c}</option>)}
    {value && !cols.includes(value) && <option value={value}>{value}</option>}
  </select>
), (prev, next) => prev.value === next.value && prev.cols === next.cols && prev.onSet === next.onSet)

// ── TableSelect — also at module level for same reason ────────────────────────
// eslint-disable-next-line react/display-name
const TableSelect = React.memo(({ field, value, tables, onSet }: {
  field: keyof DataSourceConfig, value: string, tables: string[]
  onSet: (k: keyof DataSourceConfig, v: string) => void
}) => (
  <select
    className="ds-select"
    value={value}
    onChange={e => onSet(field, e.target.value)}
  >
    <option value="">-- select table --</option>
    {tables.map(t => <option key={t} value={t}>{t}</option>)}
    {value && !tables.includes(value) && <option value={value}>{value}</option>}
  </select>
), (prev, next) => prev.value === next.value && prev.tables === next.tables && prev.onSet === next.onSet)

// ── Data Sources Tab ──────────────────────────────────────────────────────────
function DataSourcesTab({
  accountId, ds: initialDs, onChange
}: {
  accountId: string
  ds: DataSourceConfig          // only used for initialization
  onChange: (ds: DataSourceConfig) => void
}) {
  // ── LOCAL state — not tied to parent re-renders ───────────────────────────
  // This prevents parent state updates from cascading into ColSelect/TableSelect
  // and closing any open native dropdown.
  const [localDs,   setLocalDs]   = useState<DataSourceConfig>(() => ({ ...initialDs }))
  const [tables,    setTables]    = useState<string[]>([])
  const [kpiCols,   setKpiCols]   = useState<string[]>([])
  const [agentCols, setAgentCols] = useState<string[]>([])

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  useEffect(() => {
    fetchPublicTables(supaUrl, supaKey).then(t => setTables(t))
  }, [])

  // Watch localDs table fields to reload columns
  useEffect(() => {
    if (!localDs.kpiTable) return
    fetchTableColumns(supaUrl, supaKey, localDs.kpiTable).then(c => {
      setKpiCols(prev => JSON.stringify(prev) === JSON.stringify(c) ? prev : c)
    })
  }, [localDs.kpiTable])

  useEffect(() => {
    if (!localDs.agentTable) return
    fetchTableColumns(supaUrl, supaKey, localDs.agentTable).then(c => {
      setAgentCols(prev => JSON.stringify(prev) === JSON.stringify(c) ? prev : c)
    })
  }, [localDs.agentTable])

  // ── STABLE setter — functional setState so no dependency on localDs ───────
  // This is the key: useCallback with [onChange] only.
  // onChange = setDs from parent = stable React state setter.
  // Functional setState reads latest state without needing it as a dep.
  const set = useCallback((key: keyof DataSourceConfig, val: string) => {
    setLocalDs(prev => {
      const next = { ...prev, [key]: val }
      onChange(next)  // sync to parent
      return next
    })
  }, [onChange])

  // Preset loader — also stable
  const loadPreset = useCallback((preset: DataSourceConfig) => {
    const copy = { ...preset }
    setLocalDs(copy)
    onChange(copy)
  }, [onChange])

  return (
    <div>
      <p className="sm-desc">
        Configure which Supabase tables and columns this account reads from.
        Use <strong>Presets</strong> to auto-fill for standard platforms, then customize if needed.
      </p>

      {/* Presets */}
      <div className="ds-preset-row">
        <button className="ds-preset-btn aircall"  onClick={() => loadPreset(PRESET_AIRCALL)}>
          <i className="bx bx-phone" /> Aircall Preset
        </button>
        <button className="ds-preset-btn talkdesk" onClick={() => loadPreset(PRESET_TALKDESK)}>
          <i className="bx bx-headphone" /> Talkdesk Preset
        </button>
      </div>

      {/* KPI Data Source */}
      <div className="sm-section-title">KPI DATA SOURCE</div>
      <div className="ds-row">
        <span className="ds-label">Table</span>
        <TableSelect field="kpiTable" value={localDs.kpiTable} tables={tables} onSet={set} />
      </div>
      <div className="ds-row">
        <span className="ds-label">Account ID col</span>
        <ColSelect field="kpiAccountCol" value={localDs.kpiAccountCol} cols={kpiCols} onSet={set} />
      </div>
      <div className="ds-row">
        <span className="ds-label">
          Group by
          <div style={{ fontSize: 10, color: '#687d75', marginTop: 2 }}>
            Set for multi-LOB tables (shows per-group tiles)
          </div>
        </span>
        <ColSelect field="kpiGroupCol" value={localDs.kpiGroupCol} cols={kpiCols} onSet={set} />
      </div>

      <div style={{ marginTop: 10, marginBottom: 6, fontSize: 11, color: '#687d75', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Column Mapping
      </div>
      {([
        ['kpiSlaCol',    'SLA %'         ],
        ['kpiQueueCol',  'Queue / Waiting'],
        ['kpiAsaCol',    'ASA / AHT'     ],
        ['kpiAbnCol',    'Abandon Rate'  ],
        ['kpiAgentsCol', 'Agents Count'  ],
        ['kpiUpdatedAt', 'Updated At'    ],
      ] as [keyof DataSourceConfig, string][]).map(([field, label]) => (
        <div key={field} className="ds-row">
          <span className="ds-label">{label}</span>
          <ColSelect field={field} value={localDs[field]} cols={kpiCols} onSet={set} />
        </div>
      ))}

      {/* Agent Data Source */}
      <div className="sm-section-title" style={{ marginTop: 24 }}>AGENT DATA SOURCE</div>
      <div className="ds-row">
        <span className="ds-label">Table</span>
        <TableSelect field="agentTable" value={localDs.agentTable} tables={tables} onSet={set} />
      </div>
      <div className="ds-row">
        <span className="ds-label">Account ID col</span>
        <ColSelect field="agentAccountCol" value={localDs.agentAccountCol} cols={agentCols} onSet={set} />
      </div>

      <div style={{ marginTop: 10, marginBottom: 6, fontSize: 11, color: '#687d75', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Column Mapping
      </div>
      {([
        ['agentNameCol',      'Agent Name'       ],
        ['agentStatusCol',    'Status'           ],
        ['agentDurationCol',  'Duration (string)'],
        ['agentDurationSecs', 'Duration (secs)'  ],
      ] as [keyof DataSourceConfig, string][]).map(([field, label]) => (
        <div key={field} className="ds-row">
          <span className="ds-label">{label}</span>
          <ColSelect field={field} value={localDs[field]} cols={agentCols} onSet={set} />
        </div>
      ))}

      <div className="sm-note" style={{ marginTop: 16 }}>
        <i className="bx bx-info-circle" />
        <span>
          When <strong>Group by</strong> is set, the overview shows one KPI tile row per group value.
          Leave it empty for a single global KPI row.
        </span>
      </div>
    </div>
  )
}

// ── Main Settings Content ─────────────────────────────────────────────────────
function SettingsContent({ accountId, kpiThresholds, statusThresholds, dataSource, onSave, onClose }: Props) {
  const [tab, setTab]   = useState<Tab>('datasource')
  const [kpi, setKpi]   = useState<Thresholds>(JSON.parse(JSON.stringify(kpiThresholds)))
  const [stat, setStat] = useState<StatusThresholds>(JSON.parse(JSON.stringify(statusThresholds)))
  const [ds, setDs]     = useState<DataSourceConfig>(JSON.parse(JSON.stringify(dataSource)))

  const updateKpi = (key: keyof Thresholds, field: string, rawVal: string) => {
    const value = field === 'direction' ? rawVal : (parseFloat(rawVal) || 0)
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }
  const toggleDirection = (key: keyof Thresholds) => {
    setKpi(prev => ({
      ...prev,
      [key]: { ...prev[key], direction: prev[key].direction === 'asc' ? 'desc' : 'asc' }
    }))
  }
  const updateStat = (statusKey: string, field: 'warn' | 'crit', rawVal: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: { ...(prev[statusKey] ?? { warn: 15, crit: 30 }), [field]: parseInt(rawVal) || 0 }
    }))
  }

  const handleReset = () => {
    if (tab === 'kpi')        setKpi(JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)))
    if (tab === 'status')     setStat(JSON.parse(JSON.stringify(DEFAULT_STATUS_THRESHOLDS)))
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: MODAL_STYLES }} />
      <div className="sm-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="sm-modal">

          {/* Header */}
          <div className="sm-header">
            <div className="sm-header-left">
              <i className="bx bx-cog sm-header-icon" />
              <div>
                <div className="sm-title">Settings</div>
                <div className="sm-subtitle">Thresholds &amp; Data Sources for: <strong>{accountId}</strong></div>
              </div>
            </div>
            <button className="sm-close" onClick={onClose}>&times;</button>
          </div>

          {/* Tabs */}
          <div className="sm-tabs">
            <button className={`sm-tab${tab === 'datasource' ? ' active' : ''}`} onClick={() => setTab('datasource')}>
              <i className="bx bx-data" /> Data Sources
            </button>
            <button className={`sm-tab${tab === 'kpi' ? ' active' : ''}`} onClick={() => setTab('kpi')}>
              <i className="bx bx-bar-chart-alt-2" /> KPI Thresholds
            </button>
            <button className={`sm-tab${tab === 'status' ? ' active' : ''}`} onClick={() => setTab('status')}>
              <i className="bx bx-user-clock" /> Status Durations
            </button>
          </div>

          {/* Body */}
          <div className="sm-body">

            {tab === 'datasource' && (
              <DataSourcesTab accountId={accountId} ds={ds} onChange={setDs} />
            )}

            {tab === 'kpi' && (
              <>
                <p className="sm-desc">
                  Set <strong>Warning</strong> and <strong>Critical</strong> thresholds for each KPI.
                  Use the <strong>Direction</strong> button to control whether high or low values trigger a breach.
                </p>
                <div className="sm-section-title">KPI BREACH THRESHOLDS</div>
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th style={{ width: '28%' }}>Metric</th>
                      <th>Warning</th><th>Critical</th><th>Target</th><th>Direction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {KPI_ROWS.map(row => {
                      const th = kpi[row.key]
                      const isAsc = th.direction === 'asc'
                      return (
                        <tr key={row.key}>
                          <td>
                            <div className="sm-metric">{row.label}</div>
                            <div className="sm-metric-sub">{row.sublabel}</div>
                          </td>
                          {(['warn','crit','targ'] as const).map(f => (
                            <td key={f}>
                              <div className="sm-input-cell">
                                <input type="number" className="sm-input" value={(th as any)[f]} min={0}
                                  onChange={e => updateKpi(row.key, f, e.target.value)} />
                                {row.unit && <span className="sm-unit">{row.unit}</span>}
                              </div>
                            </td>
                          ))}
                          <td>
                            <button type="button" className={`sm-dir-btn${isAsc ? ' asc' : ' desc'}`}
                              onClick={() => toggleDirection(row.key)}>
                              <i className={`bx ${isAsc ? 'bx-trending-up' : 'bx-trending-down'}`} />
                              <span>{isAsc ? 'High = Bad' : 'Low = Bad'}</span>
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="sm-note">
                  <i className="bx bx-info-circle" />
                  <span>For SLA: <strong>Low = Bad</strong>. For Queue, ASA, ABN%: <strong>High = Bad</strong>.</span>
                </div>
              </>
            )}

            {tab === 'status' && (
              <>
                <p className="sm-desc">
                  Set how long (in <strong>minutes</strong>) an agent can stay in each status before a breach.
                </p>
                <div className="sm-section-title">AGENT STATUS DURATION THRESHOLDS</div>
                <table className="sm-table">
                  <thead>
                    <tr><th style={{ width: '40%' }}>Status</th><th>Warning (min)</th><th>Critical (min)</th></tr>
                  </thead>
                  <tbody>
                    {STATUS_ROWS.map(row => {
                      const th = stat[row.key] ?? { warn: 15, crit: 30 }
                      return (
                        <tr key={row.key}>
                          <td><div className="sm-metric">{row.label}</div></td>
                          {(['warn','crit'] as const).map(f => (
                            <td key={f}>
                              <div className="sm-input-cell">
                                <input type="number" className="sm-input" value={th[f]} min={0}
                                  onChange={e => updateStat(row.key, f, e.target.value)} />
                                <span className="sm-unit">min</span>
                              </div>
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="sm-footer">
            {tab !== 'datasource' ? (
              <button className="sm-btn-reset" onClick={handleReset}>
                <i className="bx bx-reset" /> Reset to Defaults
              </button>
            ) : <div />}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              <button className="sm-btn-save" onClick={() => { onSave(kpi, stat, ds); onClose() }}>
                <i className="bx bx-save" /> Save Changes
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  )
}

// ── Portal wrapper ────────────────────────────────────────────────────────────
export default function SettingsModal(props: Props) {
  if (typeof document === 'undefined') return null
  return createPortal(<SettingsContent {...props} />, document.body)
}