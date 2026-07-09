'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Thresholds, DataSourceConfig, ExtraTile, CellBinding, AgentSource } from '@/lib/types'
import type { StatusThresholds } from '@/lib/utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS,
  PRESET_AIRCALL, PRESET_TALKDESK, PRESET_FIVE9, PRESET_UNITERS,
  DEFAULT_KPI_LABELS, genId, newGroup, newAgentSource,
  fetchPublicTables
} from '@/lib/utils'
import { addAccount, removeAccount, type AccountConfig } from '@/lib/settings'

type Tab = 'kpi' | 'status' | 'datasource' | 'accounts'

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
  .dark .sm-modal { background: #252525; border-color: #333333; }
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
  /* Accounts tab */
  .acc-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .acc-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-radius: 8px;
    background: var(--bg-body, #f0f2f1); border: 1px solid var(--border, #e1e6e4);
    transition: border-color 0.15s;
  }
  .acc-row:hover { border-color: #d97a35; }
  .dark .acc-row { background: #111; border-color: #2e2e2e; }
  .acc-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
  .acc-name { flex: 1; font-size: 13px; font-weight: 600; color: var(--text-main, #2c3b36); }
  .dark .acc-name { color: #e0e0e0; }
  .acc-type { font-size: 11px; color: var(--text-muted, #687d75); background: rgba(0,0,0,0.05); padding: 2px 8px; border-radius: 10px; }
  .dark .acc-type { background: rgba(255,255,255,0.07); }
  .acc-btn {
    padding: 5px 10px; border-radius: 6px; font-size: 11px; font-weight: 600;
    cursor: pointer; border: 1px solid; font-family: inherit; transition: all 0.15s;
  }
  .acc-btn-cfg  { background: rgba(217,122,53,0.1); color: #d97a35; border-color: rgba(217,122,53,0.3); }
  .acc-btn-cfg:hover  { background: rgba(217,122,53,0.2); }
  .acc-btn-del  { background: rgba(239,68,68,0.1);  color: #ef4444; border-color: rgba(239,68,68,0.3); }
  .acc-btn-del:hover  { background: rgba(239,68,68,0.2); }
  .acc-add-form { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px dashed var(--border, #e1e6e4); border-radius: 8px; }
  .dark .acc-add-form { border-color: #2e2e2e; }
  .acc-add-row  { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .acc-add-input {
    padding: 8px 10px; border-radius: 6px; font-size: 13px;
    background: var(--bg-body, #f0f2f1); border: 1px solid var(--border, #e1e6e4);
    color: var(--text-main, #2c3b36); font-family: inherit; outline: none;
    transition: border-color 0.15s;
  }
  .acc-add-input:focus { border-color: #d97a35; }
  .dark .acc-add-input { background: #111; border-color: #2e2e2e; color: #e0e0e0; }
  .acc-add-btn {
    padding: 8px; border-radius: 6px; font-size: 13px; font-weight: 700;
    background: #d97a35; border: none; color: #fff; cursor: pointer; font-family: inherit; transition: opacity 0.15s;
  }
  .acc-add-btn:hover { opacity: 0.88; }
  .acc-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .acc-empty { text-align: center; padding: 24px; color: var(--text-muted, #687d75); font-size: 13px; }
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
  isDark?:          boolean
  accountId:        string
  accounts:         AccountConfig[]
  kpiThresholds:    Thresholds
  statusThresholds: StatusThresholds
  dataSource:       DataSourceConfig
  onSave:           (kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig) => void
  onAccountsChange: () => void           // called after add/remove
  onConfigureAccount: (id: string) => void  // switch active account + go to Data Sources
  onClose:          () => void
}


// ── Accounts Tab ──────────────────────────────────────────────────────────────
function AccountsTab({
  accounts, onConfigure, onRefresh
}: {
  accounts: AccountConfig[]
  onConfigure: (id: string) => void
  onRefresh: () => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [newId,    setNewId]    = useState('')
  const [newName,  setNewName]  = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [removing, setRemoving] = useState<string | null>(null)

  const handleAdd = async () => {
    const trimId = newId.trim()
    if (!trimId) { setError('Account ID is required'); return }
    setSaving(true)
    setError('')
    try {
      await addAccount(trimId, newName.trim() || undefined)
      setNewId(''); setNewName(''); setShowForm(false)
      onRefresh()
    } catch (e: any) {
      setError(e.message || 'Failed to add account')
    }
    setSaving(false)
  }

  const handleRemove = async (id: string) => {
    if (!confirm(`Remove "${id}" from the dashboard? (Supabase data is kept)`)) return
    setRemoving(id)
    try {
      await removeAccount(id)
      onRefresh()
    } catch (e: any) {
      alert(`Failed to remove: ${e.message}`)
    }
    setRemoving(null)
  }

  return (
    <div>
      <p className="sm-desc">
        Manage which accounts appear in the dashboard. Each account reads from its own
        configured <strong>Data Sources</strong>. Adding an account here does not start scraping —
        configure the scraper separately.
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="sm-section-title" style={{ margin: 0 }}>ACTIVE ACCOUNTS ({accounts.length})</div>
        <button
          className="acc-btn acc-btn-cfg"
          style={{ fontSize: 12 }}
          onClick={() => setShowForm(v => !v)}
        >
          {showForm ? '✕ Cancel' : '+ Add Account'}
        </button>
      </div>

      {showForm && (
        <div className="acc-add-form" style={{ marginBottom: 14 }}>
          <div className="acc-add-row">
            <div>
              <div style={{ fontSize: 10, color: '#687d75', marginBottom: 4, fontWeight: 600 }}>ACCOUNT ID *</div>
              <input
                className="acc-add-input"
                style={{ width: '100%' }}
                placeholder="e.g. perfectserve"
                value={newId}
                onChange={e => setNewId(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#687d75', marginBottom: 4, fontWeight: 600 }}>DISPLAY NAME</div>
              <input
                className="acc-add-input"
                style={{ width: '100%' }}
                placeholder="e.g. PerfectServe F9"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
          </div>
          <button className="acc-add-btn" disabled={!newId.trim() || saving} onClick={handleAdd}>
            {saving ? 'Saving...' : '✅ Add Account'}
          </button>
          {error && (
            <div style={{ fontSize: 12, color: '#ef4444', padding: '6px 8px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.25)' }}>
              ❌ {error}
            </div>
          )}
          <div className="sm-note" style={{ marginTop: 0 }}>
            <i className="bx bx-info-circle" />
            <span>After adding, click <strong>Configure</strong> to set up the Data Sources for this account.</span>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="acc-empty">
          No accounts yet — click <strong>+ Add Account</strong> to get started.
        </div>
      ) : (
        <div className="acc-list">
          {accounts.map(acc => (
            <div key={acc.id} className="acc-row">
              <div className="acc-dot" />
              <div className="acc-name">{acc.display_name || acc.id}</div>
              {acc.display_name && acc.display_name !== acc.id && (
                <div style={{ fontSize: 10, color: '#687d75' }}>{acc.id}</div>
              )}
              <button className="acc-btn acc-btn-cfg" onClick={() => onConfigure(acc.id)}>
                <i className="bx bx-cog" style={{ marginRight: 4 }} />Configure
              </button>
              <button
                className="acc-btn acc-btn-del"
                disabled={removing === acc.id}
                onClick={() => handleRemove(acc.id)}
              >
                {removing === acc.id ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Slot-based DataSourcesTab — mimics PAPAYA GAS DataSourcePicker UX ────────
// Click a slot card → it pulses. Click a column header in the live preview → mapped.

const SLOT_COLORS: Record<string, string> = {
  agentNameCol:    '#3b6c5a',
  agentStatusCol:  '#4b7a9a',
  agentDurationCol:'#7a6a9a',
  agentDurationSecs:'#888',
  // Per-AgentSource-card slots (AgentSourceCard, below) reuse this same
  // lookup so DsSlotCard/DsPreviewTable colors stay consistent everywhere.
  nameCol:          '#3b6c5a',
  statusCol:        '#4b7a9a',
  durationCol:      '#7a6a9a',
  durationSecsCol:  '#888',
  groupByCol:       '#b07d3a',
}

const AGENT_SOURCE_SLOTS = [
  { key: 'nameCol',         label: 'Agent Name',      hint: 'e.g. agent_name, name' },
  { key: 'statusCol',       label: 'Status',          hint: 'e.g. status, state' },
  { key: 'durationCol',     label: 'Duration',        hint: 'e.g. duration, time_in_status' },
  { key: 'durationSecsCol', label: 'Duration (secs)', hint: 'e.g. duration_secs (or leave empty)' },
  { key: 'groupByCol',      label: 'Group By',        hint: "e.g. team_name — groups this source's rows by the column's own value instead of the label above" },
]

// Core KPI cells that every group binds
const CORE_KPIS: { key: 'sla' | 'aht' | 'abn' | 'wait'; color: string }[] = [
  { key: 'sla',  color: '#d97a35' },
  { key: 'wait', color: '#4b8b9c' },
  { key: 'aht',  color: '#846b9a' },
  { key: 'abn',  color: '#c95c5c' },
]
// Palette for extra custom tiles (cycled by index)
const EXTRA_COLORS = ['#3b7a5c', '#5a7abf', '#b07d3a', '#9a5ba0', '#4b9a8f', '#a05b7a']

const AGENT_SLOTS = [
  { key: 'agentNameCol',      label: 'Agent Name',      hint: 'e.g. agent_name, name' },
  { key: 'agentStatusCol',    label: 'Status',          hint: 'e.g. status, state' },
  { key: 'agentDurationCol',  label: 'Duration',        hint: 'e.g. duration, time_in_status' },
  { key: 'agentDurationSecs', label: 'Duration (secs)', hint: 'e.g. duration_secs (or leave empty)' },
]

// ── Module-level sub-components — MUST be outside DataSourcesTab ─────────────
// If defined inside, React remounts them on every render → scroll resets.

const DsSlotCard = React.memo(({ slotKey, label, hint, isActive, value, onToggle, onClear }: {
  slotKey: string; label: string; hint: string
  isActive: boolean; value: string; onToggle: (k: string) => void; onClear?: (k: string) => void
}) => {
  const color = SLOT_COLORS[slotKey] || '#888'
  // Empty slot → click arms it for picking (existing behavior). Already-armed
  // slot → click cancels. Already-mapped, not-armed slot → click clears it —
  // otherwise there was no way back to "unmapped" short of picking a
  // different column, which is exactly how a wrong mapping (e.g. Duration
  // (secs) pointed at a formatted-text column) could get stuck with no fix.
  const handleClick = () => {
    if (!isActive && value && onClear) { onClear(slotKey); return }
    onToggle(slotKey)
  }
  return (
    <div onClick={handleClick}
      style={{ border: `2px solid ${isActive ? color : 'var(--border,#e1e6e4)'}`,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
        animation: isActive ? 'slot-pulse 1s ease-in-out infinite' : 'none',
        transition: 'border-color 0.15s', background: 'var(--bg-body,#f0f2f1)', minWidth: 0 }}
      title={!isActive && value && onClear ? `${hint} — click to clear` : hint}>
      <div style={{ background: color, padding: '5px 10px', color: '#fff',
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{label}</span>
        {value && <i className={`bx ${onClear ? 'bx-x' : 'bx-check'}`} style={{ fontSize: 12 }} />}
      </div>
      <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600,
        color: value ? color : 'var(--text-muted,#687d75)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        background: value ? `${color}12` : 'transparent' }}>
        {value || (isActive ? '← click a column' : 'Not mapped')}
      </div>
    </div>
  )
}, (p, n) => p.isActive === n.isActive && p.value === n.value && p.onToggle === n.onToggle && p.onClear === n.onClear)

const DsPreviewTable = React.memo(({ rows, mappedCols, hasActiveSlot, onMap }: {
  rows: Record<string, any>[]; mappedCols: Record<string, string>
  hasActiveSlot: boolean; onMap: (col: string) => void
}) => {
  if (!rows.length) return (
    <div style={{ padding:'16px 24px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>
      No preview data — table may be empty
    </div>
  )
  const cols = Object.keys(rows[0])
  return (
    <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:200, fontSize:11 }}>
      <table style={{ borderCollapse:'collapse', width:'100%', minWidth:'max-content' }}>
        <thead>
          <tr>
            {cols.map(col => {
              const color = mappedCols[col]
              return (
                <th key={col} onClick={() => hasActiveSlot && onMap(col)}
                  style={{ padding:'6px 10px', textAlign:'left', whiteSpace:'nowrap',
                    position:'sticky', top:0, zIndex:2,
                    background: color ? `${color}22` : 'var(--bg-body,#f0f2f1)',
                    color: color || (hasActiveSlot ? '#d97a35' : 'var(--text-muted)'),
                    fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.5px',
                    cursor: hasActiveSlot ? 'pointer' : 'default',
                    borderBottom:`2px solid ${color||(hasActiveSlot?'#d97a35':'var(--border)')}`,
                    transition:'all 0.15s' }}>
                  {color && <span style={{ display:'inline-block', width:6, height:6,
                    borderRadius:'50%', background:color, marginRight:4 }} />}
                  {col}
                  {hasActiveSlot && !color && <span style={{ marginLeft:4, color:'#d97a35' }}>←</span>}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri%2===0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
              {cols.map(col => (
                <td key={col} onClick={() => hasActiveSlot && onMap(col)}
                  style={{ padding:'5px 10px', borderBottom:'1px solid var(--border,#e1e6e4)',
                    cursor: hasActiveSlot ? 'pointer' : 'default', color:'var(--text-main)',
                    maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                    background: mappedCols[col] ? `${mappedCols[col]}08` : 'transparent' }}>
                  {String(row[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}, (p, n) => p.rows === n.rows && p.mappedCols === n.mappedCols && p.hasActiveSlot === n.hasActiveSlot && p.onMap === n.onMap)

// eslint-disable-next-line react/display-name
const DsTableSelector = React.memo(({ field, value, tables, onChange }: {
  field: string; value: string; tables: string[]
  onChange: (field: string, val: string) => void
}) => (
  <select className="ds-select" value={value}
    onChange={e => onChange(field, e.target.value)} style={{ minWidth: 200 }}>
    <option value="">-- select table --</option>
    {tables.map(t => <option key={t} value={t}>{t}</option>)}
    {value && !tables.includes(value) && <option value={value}>{value}</option>}
  </select>
), (p, n) => p.value === n.value && p.tables === n.tables && p.onChange === n.onChange)

// eslint-disable-next-line react/display-name
const ColSelect = React.memo(({ cols, value, onChange, emptyLabel }: {
  cols: string[]; value: string; onChange: (v: string) => void; emptyLabel?: string
}) => (
  <select className="ds-select" value={value} onChange={e => onChange(e.target.value)} style={{ minWidth: 150 }}>
    <option value="">{emptyLabel || '-- none --'}</option>
    {cols.map(c => <option key={c} value={c}>{c}</option>)}
    {value && !cols.includes(value) && <option value={value}>{value}</option>}
  </select>
), (p, n) => p.value === n.value && p.cols === n.cols && p.onChange === n.onChange)

// One card per agent source — its own table + column mapping, fetching its
// own column list independently since each source can point at a different
// table. `groupByCol` (if set) groups that source's rows by the VALUE of that
// column instead of the static `label` (covers "one table, already split by
// team/queue column" — e.g. ZenBusiness's team_name — vs "one source per
// physical table" — e.g. Hippo's Licensed Agents + Level 1).
function AgentSourceCard({ source, tables, supaUrl, supaKey, onChange, onRemove }: {
  source: AgentSource; tables: string[]; supaUrl: string; supaKey: string
  onChange: (patch: Partial<AgentSource>) => void; onRemove: () => void
}) {
  const [preview, setPreview] = useState<Record<string, any>[]>([])
  const [loading, setLoading] = useState(false)
  const [activeSlot, setActiveSlot] = useState<string | null>(null)

  useEffect(() => {
    if (!source.table) { setPreview([]); return }
    setLoading(true)
    fetch(`${supaUrl}/rest/v1/${source.table}?limit=8`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setPreview(Array.isArray(d) ? d : []))
      .catch(() => setPreview([]))
      .finally(() => setLoading(false))
  }, [source.table, supaUrl, supaKey])

  const cols = preview.length ? Object.keys(preview[0]) : []
  // Reads activeSlot directly rather than via the setActiveSlot updater —
  // calling the PARENT's onChange (a different component's setState) from
  // inside a setState updater callback is a React violation ("Cannot update
  // a component while rendering a different component"). Both setState
  // calls below happen as plain top-level statements in an event handler
  // instead, which is the normal, valid place for them.
  const mapCol = useCallback((colName: string) => {
    if (!activeSlot) return
    onChange({ [activeSlot]: colName } as Partial<AgentSource>)
    setActiveSlot(null)
  }, [activeSlot, onChange])

  return (
    <div className="ds-group" style={{ marginBottom: 10 }}>
      <div className="ds-group-head">
        <input className="ds-group-name" value={source.label} placeholder="Label (e.g. Level 1)"
          onChange={e => onChange({ label: e.target.value })} />
        <button className="ds-x" title="Remove source" onClick={onRemove}><i className="bx bx-trash" /></button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Table</span>
          <DsTableSelector field="table" value={source.table} tables={tables} onChange={(_, v) => { onChange({ table: v }); setActiveSlot(null) }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Account col</span>
          <ColSelect cols={cols} value={source.accountCol} onChange={v => onChange({ accountCol: v })} />
        </div>
      </div>
      <p className="ds-hint"><strong>Click a slot</strong>, then click a column header in the preview to map it.</p>
      <div className="ds-slot-grid">
        {AGENT_SOURCE_SLOTS.map(s => <DsSlotCard key={s.key} slotKey={s.key} label={s.label} hint={s.hint}
          isActive={activeSlot === s.key} value={(source as any)[s.key] || ''}
          onToggle={k => setActiveSlot(cur => cur === k ? null : k)}
          onClear={k => onChange({ [k]: '' } as Partial<AgentSource>)} />)}
      </div>
      {activeSlot && (
        <div className="ds-active-bar">
          <i className="bx bx-crosshair" style={{ fontSize: 16 }} />
          <strong>{AGENT_SOURCE_SLOTS.find(s => s.key === activeSlot)?.label}</strong> is active — click a column header below
        </div>
      )}
      {source.table && (
        <div className="ds-preview">
          {loading ? (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading preview...</div>
          ) : (
            <DsPreviewTable rows={preview} hasActiveSlot={!!activeSlot} onMap={mapCol}
              mappedCols={AGENT_SOURCE_SLOTS.reduce((acc, s) => { const v = (source as any)[s.key]; if (v) acc[v] = SLOT_COLORS[s.key] || '#888'; return acc }, {} as Record<string, string>)} />
          )}
        </div>
      )}
    </div>
  )
}

function DataSourcesTab({ accountId, ds: initialDs, onChange }: {
  accountId: string
  ds: DataSourceConfig
  onChange: (ds: DataSourceConfig) => void
}) {
  const [localDs,    setLocalDs]    = useState<DataSourceConfig>(() => JSON.parse(JSON.stringify(initialDs)))
  const [tables,     setTables]     = useState<string[]>([])
  const [kpiPreview, setKpiPreview] = useState<Record<string, any>[]>([])
  const [agtPreview, setAgtPreview] = useState<Record<string, any>[]>([])
  const [activeCell, setActiveCell] = useState<{ groupId: string; kpiKey: string } | null>(null)
  const [activeAgentSlot, setActiveAgentSlot] = useState<string | null>(null)
  const [loadingKpi, setLoadingKpi] = useState(false)
  const [loadingAgt, setLoadingAgt] = useState(false)

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  useEffect(() => { fetchPublicTables(supaUrl, supaKey).then(setTables) }, [])

  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onChangeRef.current(localDs) }, [localDs])

  useEffect(() => {
    if (!localDs.kpiTable) { setKpiPreview([]); return }
    setLoadingKpi(true)
    fetch(`${supaUrl}/rest/v1/${localDs.kpiTable}?limit=50`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
      .then(r => r.ok ? r.json() : []).then(d => setKpiPreview(Array.isArray(d) ? d : []))
      .catch(() => setKpiPreview([])).finally(() => setLoadingKpi(false))
  }, [localDs.kpiTable])

  useEffect(() => {
    if (!localDs.agentTable) { setAgtPreview([]); return }
    setLoadingAgt(true)
    fetch(`${supaUrl}/rest/v1/${localDs.agentTable}?limit=8`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
      .then(r => r.ok ? r.json() : []).then(d => setAgtPreview(Array.isArray(d) ? d : []))
      .catch(() => setAgtPreview([])).finally(() => setLoadingAgt(false))
  }, [localDs.agentTable])

  const loadPreset = useCallback((preset: DataSourceConfig) => {
    setLocalDs(JSON.parse(JSON.stringify(preset))); setActiveCell(null); setActiveAgentSlot(null)
  }, [])
  const setField = useCallback((key: string, val: string) => { setLocalDs(prev => ({ ...prev, [key]: val })) }, [])
  const setLabel = useCallback((key: 'sla'|'aht'|'abn'|'wait', val: string) => {
    setLocalDs(prev => ({ ...prev, kpiLabels: { ...prev.kpiLabels, [key]: val } }))
  }, [])
  const addGroup = useCallback(() => {
    setLocalDs(prev => ({ ...prev, groups: [...prev.groups, newGroup(`Group ${prev.groups.length + 1}`)] }))
  }, [])
  const removeGroup = useCallback((id: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.filter(g => g.id !== id) }))
    setActiveCell(cur => (cur && cur.groupId === id ? null : cur))
  }, [])
  const renameGroup = useCallback((id: string, name: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === id ? { ...g, name } : g) }))
  }, [])
  const setGroupVal = useCallback((id: string, val: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === id ? { ...g, groupVal: val } : g) }))
  }, [])
  const clearCell = useCallback((groupId: string, kpiKey: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => {
      if (g.id !== groupId) return g
      const cells = { ...g.cells }; delete cells[kpiKey]; return { ...g, cells }
    }) }))
  }, [])
  const addExtra = useCallback(() => {
    setLocalDs(prev => ({ ...prev, extraTiles: [...prev.extraTiles,
      { key: 'extra_' + genId(), label: `Extra ${prev.extraTiles.length + 1}`, warn: 10, crit: 20, targ: 5, higherIsBetter: false }] }))
  }, [])
  const updateExtra = useCallback((key: string, patch: Partial<ExtraTile>) => {
    setLocalDs(prev => ({ ...prev, extraTiles: prev.extraTiles.map(t => t.key === key ? { ...t, ...patch } : t) }))
  }, [])
  const removeExtra = useCallback((key: string) => {
    setLocalDs(prev => ({
      ...prev,
      extraTiles: prev.extraTiles.filter(t => t.key !== key),
      groups: prev.groups.map(g => { const cells = { ...g.cells }; delete cells[key]; return { ...g, cells } }),
    }))
  }, [])
  const pickCell = useCallback((row: Record<string, any>, colName: string) => {
    setActiveCell(cur => {
      if (!cur) return cur
      setLocalDs(prev => {
        const binding: CellBinding = { valueCol: colName }
        // Pin the exact row. Prefer the configured Row key; otherwise auto-detect
        // a unique identifier column so a single click always binds ONE cell.
        const cols = Object.keys(row)
        const rk = prev.kpiRowKeyCol || (cols.includes('kpi_key') ? 'kpi_key' : cols.includes('id') ? 'id' : '')
        if (rk) { binding.matchCol = rk; binding.matchVal = String(row[rk] ?? '') }
        return { ...prev, groups: prev.groups.map(g => {
          if (g.id !== cur.groupId) return g
          // groupVal is set by hand via the group's dropdown (see setGroupVal) —
          // it must NOT be auto-overwritten here. Every KPI key in this group
          // shares g.groupVal for highlight matching, so silently changing it
          // on each pick would retroactively break previously-bound fields'
          // highlights (e.g. picking "Awaiting" from a different-skill row than
          // SLA% was picked from would scramble SLA%'s highlight too).
          return { ...g, cells: { ...g.cells, [cur.kpiKey]: binding } }
        }) }
      })
      return null
    })
  }, [])
  const mapAgentCol = useCallback((colName: string) => {
    setActiveAgentSlot(cur => { if (cur) setLocalDs(prev => ({ ...prev, [cur]: colName })); return null })
  }, [])

  // ── Multiple agent sources — covers both "agent status split across several
  // tables" (one source per table) and "one table, grouped by a column" (one
  // source with groupByCol set). Independent of the legacy single-table
  // fields above; when non-empty, fetchAccount uses this instead.
  const addAgentSource = useCallback(() => {
    setLocalDs(prev => ({ ...prev, agentSources: [...prev.agentSources, newAgentSource(`Source ${prev.agentSources.length + 1}`)] }))
  }, [])
  const removeAgentSource = useCallback((id: string) => {
    setLocalDs(prev => ({ ...prev, agentSources: prev.agentSources.filter(s => s.id !== id) }))
  }, [])
  const updateAgentSource = useCallback((id: string, patch: Partial<AgentSource>) => {
    setLocalDs(prev => ({ ...prev, agentSources: prev.agentSources.map(s => s.id === id ? { ...s, ...patch } : s) }))
  }, [])

  const tileColor = (key: string) => {
    const core = CORE_KPIS.find(c => c.key === key)
    if (core) return core.color
    const idx = localDs.extraTiles.findIndex(t => t.key === key)
    return EXTRA_COLORS[(idx < 0 ? 0 : idx) % EXTRA_COLORS.length]
  }
  const tileLabel = (key: string) => {
    if (key === 'sla' || key === 'aht' || key === 'abn' || key === 'wait') return localDs.kpiLabels[key]
    return localDs.extraTiles.find(t => t.key === key)?.label || key
  }
  const allKpiKeys = ['sla', 'wait', 'aht', 'abn', ...localDs.extraTiles.map(t => t.key)]
  const kpiCols = kpiPreview.length ? Object.keys(kpiPreview[0]) : []
  const agtCols = agtPreview.length ? Object.keys(agtPreview[0]) : []
  const groupVals = localDs.kpiGroupCol
    ? Array.from(new Set(kpiPreview.map(r => String(r[localDs.kpiGroupCol] ?? '')).filter(Boolean)))
    : []

  // Highlight: a preview cell lights up only when it is the EXACT bound cell —
  // matched on both the group value (skill/lob) and the row key (metric).
  const hiBindings = localDs.groups.flatMap(g =>
    Object.entries(g.cells).map(([k, b]) => ({
      color:    tileColor(k),
      valueCol: b.valueCol,
      groupVal: localDs.kpiGroupCol ? (g.groupVal ?? null) : null,
      matchCol: b.matchCol || null,
      matchVal: (b.matchVal !== undefined && b.matchVal !== '') ? b.matchVal : null,
    }))
  ).filter(x => x.valueCol)

  const cellColor = (row: Record<string, any>, colName: string, ri: number): string | undefined => {
    for (const bd of hiBindings) {
      if (bd.valueCol !== colName) continue
      if (bd.matchVal !== null) {
        // An exact row-key match is authoritative on its own — it already pins
        // ONE specific row, so a group filter must not additionally veto it.
        // This also lets one group mix KPIs from different skills (e.g. SLA
        // from "Service Level 1", Awaiting from "Queue Counter") as long as
        // each is pinned by matchVal.
        if (!bd.matchCol || String(row[bd.matchCol] ?? '') !== bd.matchVal) continue
      } else if (bd.groupVal !== null) {
        if (String(row[localDs.kpiGroupCol] ?? '') !== bd.groupVal) continue
      } else if (ri !== 0) {
        continue  // no constraints at all → only the first row is used
      }
      return bd.color
    }
    return undefined
  }

  return (
    <div>
      <style>{`
        @keyframes slot-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,122,53,0.4); } 50% { box-shadow: 0 0 0 5px rgba(217,122,53,0); } }
        .ds-section { margin-bottom: 22px; }
        .ds-section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
          color: var(--text-muted); padding-bottom: 8px; border-bottom: 1px solid var(--border, #e1e6e4); margin-bottom: 12px; }
        .ds-slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
        .ds-active-bar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: rgba(217,122,53,0.1);
          border: 1px solid rgba(217,122,53,0.3); border-radius: 6px; margin: 8px 0; font-size: 12px; font-weight: 600; color: #d97a35; }
        .ds-table-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
        .ds-mini-label { font-size: 12px; color: var(--text-muted); font-weight: 500; }
        .ds-hint { font-size: 11px; color: var(--text-muted); margin: 4px 0 10px; line-height: 1.5; }
        .ds-preview { border: 1px solid var(--border, #e1e6e4); border-radius: 8px; overflow: hidden; margin-top: 10px; }
        .dark .ds-preview { border-color: #2e2e2e; }
        .ds-label-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
        .ds-label-field { display: flex; align-items: center; gap: 6px; }
        .ds-label-dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
        .ds-group { border: 1px solid var(--border, #e1e6e4); border-radius: 8px; padding: 10px; margin-bottom: 10px; background: var(--bg-body,#f0f2f1); }
        .dark .ds-group { border-color: #2e2e2e; background: #1a1a1a; }
        .ds-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .ds-group-name { flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border,#e1e6e4);
          background: var(--bg-card,#fff); color: var(--text-main,#2c3b36); font-family: inherit; font-size: 13px; font-weight: 600; outline: none; }
        .dark .ds-group-name { background:#111; border-color:#2e2e2e; color:#e0e0e0; }
        .ds-cellcard { border: 2px solid var(--border,#e1e6e4); border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--bg-card,#fff); min-width: 0; }
        .dark .ds-cellcard { background:#111; }
        .ds-cellcard-h { padding: 4px 8px; color: #fff; font-size: 10px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.4px; display: flex; align-items: center; justify-content: space-between; }
        .ds-cellcard-v { padding: 5px 8px; font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-x { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 15px; padding: 4px 6px; border-radius: 6px; }
        .ds-x:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
        .ds-add-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; margin-top: 2px;
          border: 1px dashed var(--border,#e1e6e4); background: transparent; color: var(--text-muted); border-radius: 6px;
          font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
        .ds-add-btn:hover { border-color: #d97a35; color: #d97a35; }
        .ds-extra-wrap { margin-top: 14px; }
        .ds-extra-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
        .ds-extra-name { flex: 1; min-width: 120px; padding: 5px 8px; font-size: 12px; }
        .ds-extra-num { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-muted); font-weight: 700; }
        .ds-extra-num input { width: 48px; padding: 4px 6px; border-radius: 5px; border: 1px solid var(--border,#e1e6e4);
          background: var(--bg-body,#f0f2f1); color: var(--text-main,#2c3b36); font-family: inherit; font-size: 12px; text-align: center; }
        .dark .ds-extra-num input { background:#111; border-color:#2e2e2e; color:#e0e0e0; }
        .ds-hib { padding: 5px 9px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; border: 1px solid;
          background: rgba(75,139,156,0.1); color: #4b8b9c; border-color: rgba(75,139,156,0.3); font-family: inherit; white-space: nowrap; }
        .ds-hib.on { background: rgba(217,158,53,0.1); color: #d99e35; border-color: rgba(217,158,53,0.3); }
        .ds-th { padding: 6px 10px; text-align: left; white-space: nowrap; position: sticky; top: 0; z-index: 2;
          background: var(--bg-body,#f0f2f1); color: var(--text-muted); font-weight: 700; font-size: 10px;
          text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid var(--border,#e1e6e4); }
        .dark .ds-th { background:#1a1a1a; }
        .ds-td { padding: 5px 10px; border-bottom: 1px solid var(--border,#e1e6e4); color: var(--text-main,#2c3b36);
          max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; outline-offset: -2px; }
      `}</style>

      {/* Presets */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="ds-preset-btn aircall"  onClick={() => loadPreset(PRESET_AIRCALL)}><i className="bx bx-phone" /> Aircall</button>
        <button className="ds-preset-btn talkdesk" onClick={() => loadPreset(PRESET_TALKDESK)}><i className="bx bx-headphone" /> Talkdesk</button>
        <button className="ds-preset-btn talkdesk" onClick={() => loadPreset(PRESET_FIVE9)}><i className="bx bx-grid-alt" /> Five9</button>
        <button className="ds-preset-btn talkdesk" onClick={() => loadPreset(PRESET_UNITERS)}><i className="bx bx-grid-alt" /> Uniters</button>
      </div>

      {/* KPI Section */}
      <div className="ds-section">
        <div className="ds-section-title">KPI DATA SOURCE</div>
        <div className="ds-table-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Table</span>
            <DsTableSelector field="kpiTable" value={localDs.kpiTable} tables={tables} onChange={(f, v) => setField(f, v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Account col</span>
            <ColSelect cols={kpiCols} value={localDs.kpiAccountCol} onChange={v => setField('kpiAccountCol', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Group by</span>
            <ColSelect cols={kpiCols} value={localDs.kpiGroupCol} onChange={v => setField('kpiGroupCol', v)} emptyLabel="(one group)" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Row key</span>
            <ColSelect cols={kpiCols} value={localDs.kpiRowKeyCol} onChange={v => setField('kpiRowKeyCol', v)} emptyLabel="(one row)" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Updated at</span>
            <ColSelect cols={kpiCols} value={localDs.kpiUpdatedAt} onChange={v => setField('kpiUpdatedAt', v)} />
          </div>
        </div>

        <p className="ds-hint">
          <strong>Group by</strong> = the column whose values are your LOBs (e.g. <code>skill</code>); pick each group&apos;s value in its header.
          <strong> Row key</strong> = the metric column within a group (e.g. <code>label</code>). Then <strong>click a KPI slot</strong> (it pulses) and
          <strong> click the value cell</strong> — with both set, exactly one cell binds.
        </p>

        {/* Groups */}
        {localDs.groups.map(group => (
          <div key={group.id} className="ds-group">
            <div className="ds-group-head">
              <input className="ds-group-name" value={group.name} onChange={e => renameGroup(group.id, e.target.value)} placeholder="Group name" />
              {localDs.kpiGroupCol && (
                <select className="ds-select" style={{ maxWidth: 170 }} value={group.groupVal ?? ''} onChange={e => setGroupVal(group.id, e.target.value)}>
                  <option value="">{localDs.kpiGroupCol}…</option>
                  {groupVals.map(v => <option key={v} value={v}>{v}</option>)}
                  {group.groupVal && !groupVals.includes(group.groupVal) && <option value={group.groupVal}>{group.groupVal}</option>}
                </select>
              )}
              <button className="ds-x" title="Remove group" onClick={() => removeGroup(group.id)}><i className="bx bx-trash" /></button>
            </div>
            <div className="ds-slot-grid">
              {allKpiKeys.map(k => {
                const b = group.cells[k]
                const color = tileColor(k)
                const isActive = !!activeCell && activeCell.groupId === group.id && activeCell.kpiKey === k
                const disp = b ? (b.matchVal ? `${b.matchVal} → ${b.valueCol}` : b.valueCol) : (isActive ? '← click a cell' : 'not set')
                return (
                  <div key={k} className="ds-cellcard"
                    style={{ borderColor: isActive ? color : 'var(--border,#e1e6e4)', animation: isActive ? 'slot-pulse 1s infinite' : 'none' }}
                    onClick={() => setActiveCell(cur => (cur && cur.groupId === group.id && cur.kpiKey === k) ? null : { groupId: group.id, kpiKey: k })}>
                    <div className="ds-cellcard-h" style={{ background: color }}>
                      {/* Editable right on the card you already click to arm cell-picking —
                          stopPropagation so typing here doesn't also arm/disarm the card.
                          Renames this KPI's tile label everywhere it's shown (Overview,
                          Dashboard, breach text) — shared across every group, since there's
                          one display name per KPI key, not one per group. */}
                      <input value={tileLabel(k)} title="Click to rename this tile"
                        onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                        onChange={e => {
                          const val = e.target.value
                          if (k === 'sla' || k === 'wait' || k === 'aht' || k === 'abn') setLabel(k, val)
                          else updateExtra(k, { label: val })
                        }}
                        style={{
                          background: 'transparent', border: 'none', outline: 'none', color: '#fff',
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
                          width: '100%', minWidth: 0, padding: 0, margin: 0, fontFamily: 'inherit', cursor: 'text',
                        }} />
                      {b && <i className="bx bx-x" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={e => { e.stopPropagation(); clearCell(group.id, k) }} />}
                    </div>
                    <div className="ds-cellcard-v" style={{ color: b ? color : 'var(--text-muted)', background: b ? `${color}12` : 'transparent' }}>{disp}</div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        <button className="ds-add-btn" onClick={addGroup}><i className="bx bx-plus" /> Add Group</button>

        {/* Extra tiles */}
        <div className="ds-extra-wrap">
          <div className="ds-section-title">EXTRA KPI TILES</div>
          {localDs.extraTiles.map((t, i) => (
            <div key={t.key} className="ds-extra-row">
              <span className="ds-label-dot" style={{ background: EXTRA_COLORS[i % EXTRA_COLORS.length] }} />
              <input className="acc-add-input ds-extra-name" value={t.label} onChange={e => updateExtra(t.key, { label: e.target.value })} placeholder="Tile name" />
              <label className="ds-extra-num">W<input type="number" value={t.warn} onChange={e => updateExtra(t.key, { warn: parseFloat(e.target.value) || 0 })} /></label>
              <label className="ds-extra-num">C<input type="number" value={t.crit} onChange={e => updateExtra(t.key, { crit: parseFloat(e.target.value) || 0 })} /></label>
              <label className="ds-extra-num">T<input type="number" value={t.targ} onChange={e => updateExtra(t.key, { targ: parseFloat(e.target.value) || 0 })} /></label>
              <button className={`ds-hib${t.higherIsBetter ? ' on' : ''}`} onClick={() => updateExtra(t.key, { higherIsBetter: !t.higherIsBetter })}
                title="Toggle whether high or low values are bad">{t.higherIsBetter ? 'Low = Bad' : 'High = Bad'}</button>
              <button className="ds-x" onClick={() => removeExtra(t.key)}><i className="bx bx-trash" /></button>
            </div>
          ))}
          <button className="ds-add-btn" onClick={addExtra}><i className="bx bx-plus" /> Add Extra Tile</button>
        </div>

        {/* KPI preview grid — click a cell to bind the active slot */}
        {localDs.kpiTable && (
          <div className="ds-preview">
            {loadingKpi ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading preview...</div>
            ) : kpiPreview.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No rows in this table</div>
            ) : (
              <div style={{ overflow: 'auto', maxHeight: 260, fontSize: 11 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 'max-content' }}>
                  <thead><tr>{kpiCols.map(c => <th key={c} className="ds-th">{c}</th>)}</tr></thead>
                  <tbody>
                    {kpiPreview.map((row, ri) => (
                      <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
                        {kpiCols.map(c => {
                          const hi = cellColor(row, c, ri)
                          return (
                            <td key={c} className="ds-td"
                              style={{ cursor: activeCell ? 'pointer' : 'default', background: hi ? `${hi}22` : undefined, outline: hi ? `2px solid ${hi}` : 'none' }}
                              onClick={() => activeCell && pickCell(row, c)}>
                              {String(row[c] ?? '')}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Agent Section (column-based) */}
      <div className="ds-section">
        <div className="ds-section-title">AGENT DATA SOURCE</div>
        <div className="ds-table-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Table</span>
            <DsTableSelector field="agentTable" value={localDs.agentTable} tables={tables} onChange={(f, v) => { setField(f, v); setActiveAgentSlot(null) }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ds-mini-label">Account col</span>
            <ColSelect cols={agtCols} value={localDs.agentAccountCol} onChange={v => setField('agentAccountCol', v)} />
          </div>
        </div>
        <p className="ds-hint"><strong>Click a slot</strong>, then click a column header in the preview to map it.</p>
        <div className="ds-slot-grid">
          {AGENT_SLOTS.map(s => <DsSlotCard key={s.key} slotKey={s.key} label={s.label} hint={s.hint}
            isActive={activeAgentSlot === s.key} value={(localDs as any)[s.key] || ''}
            onToggle={k => setActiveAgentSlot(cur => cur === k ? null : k)}
            onClear={k => setField(k, '')} />)}
        </div>
        {activeAgentSlot && (
          <div className="ds-active-bar">
            <i className="bx bx-crosshair" style={{ fontSize: 16 }} />
            <strong>{AGENT_SLOTS.find(s => s.key === activeAgentSlot)?.label}</strong> is active — click a column header below
          </div>
        )}
        {localDs.agentTable && (
          <div className="ds-preview">
            {loadingAgt ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading preview...</div>
            ) : (
              <DsPreviewTable rows={agtPreview} hasActiveSlot={!!activeAgentSlot} onMap={mapAgentCol}
                mappedCols={AGENT_SLOTS.reduce((acc, s) => { const v = (localDs as any)[s.key]; if (v) acc[v] = SLOT_COLORS[s.key] || '#888'; return acc }, {} as Record<string, string>)} />
            )}
          </div>
        )}
      </div>

      {/* Multiple agent sources — either several physical tables, or one
          table already split by a team/queue column (groupByCol). When any
          source is added here, it's used INSTEAD of the single table above. */}
      <div className="ds-section">
        <div className="ds-section-title">ADDITIONAL AGENT SOURCES</div>
        <p className="ds-hint">
          Use this when agent status is split across <strong>multiple tables</strong> (add one source
          per table), or when one table already has a column that separates teams/queues (add one
          source and set its <strong>Group by col</strong>). Adding any source here overrides the
          single table above — the dashboard's Agent Status list will show all sources combined,
          grouped by label or by Group by col.
        </p>
        {localDs.agentSources.map(source => (
          <AgentSourceCard key={source.id} source={source} tables={tables} supaUrl={supaUrl} supaKey={supaKey}
            onChange={patch => updateAgentSource(source.id, patch)} onRemove={() => removeAgentSource(source.id)} />
        ))}
        <button className="ds-add-btn" onClick={addAgentSource}><i className="bx bx-plus" /> Add Agent Source</button>
      </div>
    </div>
  )
}


// ── Main Settings Content ─────────────────────────────────────────────────────
function SettingsContent({ accountId, accounts, kpiThresholds, statusThresholds, dataSource, onSave, onAccountsChange, onConfigureAccount, onClose }: Props) {
  const [tab, setTab]   = useState<Tab>('accounts')
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
            <button className={`sm-tab${tab === 'accounts' ? ' active' : ''}`} onClick={() => setTab('accounts')}>
              <i className="bx bx-buildings" /> Accounts
            </button>
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

            {tab === 'accounts' && (
              <AccountsTab
                accounts={accounts}
                onConfigure={id => { onConfigureAccount(id); setTab('datasource') }}
                onRefresh={onAccountsChange}
              />
            )}

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
            {(tab === 'kpi' || tab === 'status') ? (
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
  // Portal renders outside #layout-wrapper — wrap with dark class so all
  // .dark .sm-* selectors inside MODAL_STYLES resolve correctly
  return createPortal(
    <div className={props.isDark ? 'dark' : ''}>
      <SettingsContent {...props} />
    </div>,
    document.body
  )
}