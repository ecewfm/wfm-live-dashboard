'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Thresholds, DataSourceConfig, ExtraTile, CellBinding, GroupTile, KpiGroupSource, AgentSource, AgentExtraColumn, CliqGlobalSettings, ZohoLookups, ZohoLookupChoice, KpiUnit } from '@/lib/types'
import type { StatusThresholds } from '@/lib/utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS,
  PRESET_AIRCALL, PRESET_TALKDESK, PRESET_FIVE9, PRESET_UNITERS,
  DEFAULT_KPI_LABELS, genId, newGroup, newGroupTile, newAgentSource,
  fetchPublicTables, formatMinutesAsClock, parseClockToMinutes
} from '@/lib/utils'
// effectiveKpiSource is the SAME precedence function the renderers and the
// Cliq/RTA scan resolve with — imported rather than re-implemented here so
// the editor's idea of which table a slot binds against cannot disagree with
// what the runtime actually reads (that mismatch yields '--' with no error).
import { effectiveKpiSource, kpiSourceKey } from '@/lib/breaches'
import { addAccount, removeAccount, renameAccount, DEFAULT_CLIQ_GLOBAL_SETTINGS, loadZohoFieldOptions, type AccountConfig, type ZohoFieldOption } from '@/lib/settings'
import { ALARM_SOUNDS, playAlarm } from '@/lib/alarmSounds'
import type { GeminiKeyMasked } from '@/lib/geminiKeys'
import { loadGeminiModels, saveGeminiModels } from '@/lib/geminiModels'
import UsersTab from './UsersTab'
import AlarmTab from './AlarmTab'
import { useAuth } from './AuthGate'
import { can } from '@/lib/authEmail'
import { includeBreaksOf, includeAuxOf, type ZohoAuxConfig } from '@/lib/zohoAuxShared'

type Tab = 'kpi' | 'status' | 'datasource' | 'accounts' | 'cliq' | 'users' | 'alarm'

// ── A free-typed mm:ss input that only reformats/commits on blur — a plain
// controlled input reformatting on every keystroke would fight the user
// mid-type (e.g. typing "1:5" gets reformatted to "1:05" before they can
// type the second "5"). Used for AHT's warn/crit/targ, the only generic KPI
// that's a duration rather than a percent/count.
function ClockInput({ value, onCommit }: { value: number; onCommit: (mmss: string) => void }) {
  const [draft, setDraft] = useState(formatMinutesAsClock(value))
  useEffect(() => { setDraft(formatMinutesAsClock(value)) }, [value])
  return (
    <input type="text" className="sm-input" style={{ width: 56, textAlign: 'center' }}
      value={draft} placeholder="m:ss"
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

// The display suffix/sublabel used to be static per row (every account's
// "AHT" was always a duration, "SLA %" always a percent, etc.) — now that
// kpiUnit is an explicit per-account choice (see KpiUnit in lib/types.ts),
// the suffix is derived dynamically from the stored unit instead (see
// kpiUnitSuffix below); only the row's identity/default sublabel stay static.
const KPI_ROWS: { key: keyof Thresholds; label: string; sublabel: string }[] = [
  { key: 'sla',  label: 'SLA %',         sublabel: 'Service Level Agreement' },
  { key: 'aht',  label: 'ASA',           sublabel: 'Avg Speed of Answer' },
  { key: 'abn',  label: 'ABN %',         sublabel: 'Abandon Rate Percentage' },
  { key: 'wait', label: 'Calls Waiting', sublabel: 'Current Queue Depth' },
]

function kpiUnitSuffix(unit: KpiUnit | undefined): string {
  return unit === 'percent' ? '%' : ''
}

// ── The per-KPI unit selector — percent / duration / count (see KpiUnit in
// lib/types.ts). Shared by all 3 places a KPI threshold is edited: the
// shared KPI Thresholds table, each independent GroupTile table, and the
// account-wide Extra KPI Tiles section on the Data Sources tab.
function KpiUnitSelect({ value, onChange }: { value: KpiUnit | undefined; onChange: (unit: KpiUnit) => void }) {
  return (
    <select className="sm-input" style={{ minWidth: 118 }} value={value ?? 'percent'}
      onChange={e => onChange(e.target.value as KpiUnit)}>
      <option value="percent">Percentage (%)</option>
      <option value="duration">Duration (mm:ss)</option>
      <option value="count">Whole number</option>
    </select>
  )
}

// Known Zoho Creator "Site" records (per the Apollo integration's own docs) —
// checkboxes for these, plus a free-text field below for anything not listed
// (this list can go stale the same way Apollo's own does; see CLAUDE.md).
const KNOWN_RTA_SITES = ['Manila', 'Dumaguete', 'Honduras']

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
  .sm-err-overlay {
    position: fixed !important;
    top: 0 !important; left: 0 !important;
    right: 0 !important; bottom: 0 !important;
    z-index: 100000 !important;
    background: rgba(0,0,0,0.65);
    display: flex !important;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .sm-err-modal {
    background: var(--bg-card, #ffffff);
    border: 1px solid var(--border, #e1e6e4);
    border-radius: 12px;
    width: 100%; max-width: 620px;
    max-height: 85vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    overflow: hidden;
    animation: sm-appear 0.18s ease-out;
    font-family: var(--font-sans, 'Poppins', Arial, sans-serif);
  }
  .dark .sm-err-modal { background: #252525; border-color: #333333; }
  .sm-err-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px;
    background: linear-gradient(135deg, #b0413e 0%, #7a2b28 100%);
    flex-shrink: 0;
  }
  .sm-err-title { font-size: 14.5px; font-weight: 700; color: #fff; }
  .sm-err-body { padding: 18px 20px; overflow-y: auto; color: var(--text-main); }
  .sm-err-row { font-size: 12.5px; margin-bottom: 4px; word-break: break-all; }
  .sm-err-pre {
    margin: 6px 0 0; padding: 10px; max-height: 220px; overflow: auto;
    background: var(--bg-body,#f0f2f1); border: 1px solid var(--border,#e1e6e4);
    border-radius: 6px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap;
    word-break: break-all;
  }
  .sm-err-footer {
    display: flex; justify-content: flex-end;
    padding: 14px 20px; border-top: 1px solid var(--border,#e1e6e4); flex-shrink: 0;
  }
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
  /* A super user has 7 tabs — sized to fit the modal; on a narrower screen
     the row scrolls sideways instead of clipping the last tabs. */
  .sm-tabs {
    display: flex; border-bottom: 1px solid var(--border, #e1e6e4);
    padding: 0 24px; flex-shrink: 0;
    background: var(--bg-body, #f0f2f1);
    overflow-x: auto; scrollbar-width: thin;
  }
  .dark .sm-tabs { background: #111; border-bottom-color: #2e2e2e; }
  .sm-tab {
    display: flex; align-items: center; gap: 6px;
    padding: 12px 10px; font-size: 13px; font-weight: 500;
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
  /* Users tab: the row whose edit form is open. */
  .sm-table tbody tr.sm-row-editing td { background: rgba(232,121,35,0.10); }
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

  /* ── Pill toggle switch — used for the RTA Logs Reporting per-KPI checks */
  .sm-toggle { position: relative; display: inline-block; width: 30px; height: 17px; flex-shrink: 0; }
  .sm-toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 1; }
  .sm-toggle-track {
    position: absolute; inset: 0; border-radius: 999px;
    background: var(--border, #c9d0ce); transition: background 0.15s;
  }
  .dark .sm-toggle-track { background: #3a3a3a; }
  .sm-toggle-track::before {
    content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.3);
    transition: transform 0.15s;
  }
  .sm-toggle input:checked + .sm-toggle-track { background: #d97a35; }
  .sm-toggle input:checked + .sm-toggle-track::before { transform: translateX(13px); }
  .sm-toggle input:disabled + .sm-toggle-track { opacity: 0.45; cursor: not-allowed; }
  .sm-toggle input:disabled { cursor: not-allowed; }
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
  .acc-name { flex: 1; font-size: 13px; font-weight: 600; color: var(--text-main, #2c3b36); display: flex; align-items: center; gap: 6px; }
  .dark .acc-name { color: #e0e0e0; }
  .acc-rename-icon { font-size: 13px; color: var(--text-muted, #687d75); cursor: pointer; opacity: 0; transition: opacity 0.15s, color 0.15s; }
  .acc-row:hover .acc-rename-icon { opacity: 1; }
  .acc-rename-icon:hover { color: #d97a35; }
  .acc-rename-input { flex: 1; padding: 5px 8px; font-size: 13px; font-weight: 600; }
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
  cliqChannel:       string               // this account's Cliq channel unique name ('' = alerts off)
  cliqGlobalSettings: CliqGlobalSettings   // shared across every account
  wfLogsEnabled:     boolean              // this account's Zoho Workforce Logs reporting toggle
  rtaLogsEnabled:    boolean              // this account's Zoho "Workforce RTA Logs" webapp-request toggle (a DIFFERENT Zoho intake — see lib/zohoWebappRequest.ts)
  rtaSites:          string[]             // this account's site(s) for THAT webapp-request — can be more than one, unlike zohoLookups.site
  rtaAccountName:    string               // plain-text override for THAT webapp-request's account name, when accountId doesn't match Zoho's own HR display name ('' = send accountId as-is)
  rtaAiCategorizationEnabled: boolean     // this account's opt-in for AI (Gemini) per-breach-type category/sub-category grouping — see lib/geminiClassifier.ts
  rtaReportKpi:      boolean              // this account's automatic RTA Logs reporting considers KPI Tile breaches (SLA, Abandon Rate, etc.) — default true
  rtaReportAgentStatus: boolean           // this account's automatic RTA Logs reporting considers Agent Status breaches — default false
  zohoLookups:       ZohoLookups          // this account's x_Account/Category/Sub_Categories/Site picks
  alarmSound:        string               // this account's Overview-card breach alarm sound ('' = silent)
  knownStatuses:     string[]             // every agent-status value ever seen for this account (see lib/settings.ts's appendKnownStatuses()) — read-only here, accumulated automatically outside the Save flow
  onSave:           (kpi: Thresholds, status: StatusThresholds, ds: DataSourceConfig, cliqChannel: string, wfLogsEnabled: boolean, zohoLookups: ZohoLookups, alarmSound: string, rtaLogsEnabled: boolean, rtaSites: string[], rtaAccountName: string, rtaAiCategorizationEnabled: boolean, rtaReportKpi: boolean, rtaReportAgentStatus: boolean) => void
  onSaveCliqGlobal: (settings: CliqGlobalSettings) => void
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
  const [renamingId,   setRenamingId]   = useState<string | null>(null)
  const [renameValue,  setRenameValue]  = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

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

  const startRename = (acc: AccountConfig) => {
    setRenamingId(acc.id)
    setRenameValue(acc.display_name || acc.id)
  }
  const cancelRename = () => { setRenamingId(null); setRenameValue('') }
  const saveRename = async (id: string) => {
    const trimmed = renameValue.trim()
    // No-op edits (unchanged, or cleared back to blank) just close the editor
    // rather than round-tripping an update or throwing "cannot be empty".
    if (!trimmed || trimmed === (accounts.find(a => a.id === id)?.display_name || id)) { cancelRename(); return }
    setRenameSaving(true)
    try {
      await renameAccount(id, trimmed)
      cancelRename()
      onRefresh()
    } catch (e: any) {
      alert(`Failed to rename: ${e.message}`)
    }
    setRenameSaving(false)
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
              {renamingId === acc.id ? (
                <input
                  className="acc-add-input acc-rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveRename(acc.id)
                    if (e.key === 'Escape') cancelRename()
                  }}
                  onBlur={() => saveRename(acc.id)}
                  disabled={renameSaving}
                />
              ) : (
                <div className="acc-name">
                  {acc.display_name || acc.id}
                  <i className="bx bx-pencil acc-rename-icon" title="Rename — shown on the Overview cards and account switcher"
                    onClick={() => startRename(acc)} />
                </div>
              )}
              {acc.display_name && acc.display_name !== acc.id && renamingId !== acc.id && (
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

// Custom Agent Table columns (DataSourceConfig.agentExtraCols) are mapped
// using the SAME DsSlotCard/DsPreviewTable mechanism as the fixed slots
// above, via a synthetic slot key namespaced with this prefix so activeSlot/
// activeAgentSlot state can tell the two kinds apart without a second parallel
// UI. See mapAgentCol (legacy table) and AgentSourceCard's mapCol (per source).
const EXTRA_AGENT_COL_PREFIX = 'agentExtraCol:'
// Same idea, for the OPTIONAL companion "duration" column an extra column
// can have when it's a breachText trigger (see DataSourceConfig.
// agentExtraDurationColsMap's comment in lib/types.ts) — a second, separate
// slot per extra column, only rendered when that column has a breachText set.
const EXTRA_AGENT_DURATION_COL_PREFIX = 'agentExtraDurationCol:'
// Same idea, for the OPTIONAL companion "metric" column (see
// DataSourceConfig.agentExtraMetricColsMap's comment in lib/types.ts) — a
// third slot per extra column, also only rendered when breachText is set.
const EXTRA_AGENT_METRIC_COL_PREFIX = 'agentExtraMetricCol:'

// Shared "what's the human label for this active slot key" lookup — used by
// the "active bar" banner in both the legacy Agent Data Source section and
// every AgentSourceCard, so a companion Duration/Metric slot shows its own
// descriptive name (e.g. "Adherence Duration") instead of just falling
// through to undefined.
function activeAgentColSlotLabel(
  activeSlot: string,
  fixedSlots: { key: string; label: string }[],
  extraCols: AgentExtraColumn[]
): string | undefined {
  const fixed = fixedSlots.find(s => s.key === activeSlot)?.label
  if (fixed) return fixed
  const direct = extraCols.find(c => EXTRA_AGENT_COL_PREFIX + c.key === activeSlot)?.label
  if (direct) return direct
  const dur = extraCols.find(c => EXTRA_AGENT_DURATION_COL_PREFIX + c.key === activeSlot)?.label
  if (dur) return `${dur} Duration`
  const met = extraCols.find(c => EXTRA_AGENT_METRIC_COL_PREFIX + c.key === activeSlot)?.label
  if (met) return `${met} Metric`
  return undefined
}
function extraAgentColColor(i: number) { return EXTRA_COLORS[i % EXTRA_COLORS.length] }

// ── Module-level sub-components — MUST be outside DataSourcesTab ─────────────
// If defined inside, React remounts them on every render → scroll resets.

const DsSlotCard = React.memo(({ slotKey, label, hint, isActive, value, onToggle, onClear, color: colorOverride, editableLabel, onLabelChange, onRemove, breachText, onBreachTextChange, breachSeverity, onBreachSeverityToggle, durationMode, onToggleDurationMode, staticThreshold, onStaticThresholdChange, onClearStaticThreshold }: {
  slotKey: string; label: string; hint: string
  isActive: boolean; value: string; onToggle: (k: string) => void; onClear?: (k: string) => void
  color?: string           // override SLOT_COLORS lookup — needed for custom columns (no fixed slot color)
  editableLabel?: boolean  // renders `label` as a rename-in-place input — custom columns, and now the Duration slot too
  onLabelChange?: (label: string) => void
  onRemove?: () => void    // custom columns only — deletes the whole column, distinct from onClear's "unmap"
  // Custom columns only — text-based breach trigger (see AgentExtraColumn).
  // Shown/edited on every card this column appears in (legacy table + every
  // AgentSource) since it's one shared property of the column definition,
  // not a per-source mapping. Guarded on onBreachTextChange specifically
  // (not editableLabel, which the Duration slot below now also sets) so the
  // two bottom-row extras below never both try to render on the same card.
  breachText?: string
  onBreachTextChange?: (v: string) => void
  breachSeverity?: 'warning' | 'critical'
  onBreachSeverityToggle?: () => void
  // Duration slot only (legacy table's agentDurationCol, and each AgentSource's
  // durationCol) — lets the mapped value be marked "static" (e.g. a plain
  // scraped count like tickets_closed) instead of "running" (the default:
  // parsed as elapsed time and ticked up live client-side, same as every
  // other duration column always did before this existed). See
  // lib/breaches.ts and components/Dashboard.tsx for where this is actually
  // read — static mode skips both the live 1s ticking AND duration-based
  // status-breach thresholds, and shows the raw scraped value as-is instead
  // of running it through formatSeconds().
  durationMode?: 'running' | 'static'
  onToggleDurationMode?: () => void
  // Only shown/meaningful when durationMode === 'static' — a plain numeric
  // breach threshold on the static value itself (e.g. Ticket Solved), since
  // the Status Durations tab's minutes-in-status model doesn't apply here.
  // See DataSourceConfig.agentDurationStaticThreshold.
  staticThreshold?: { warn: number; crit: number; direction: 'asc' | 'desc' }
  onStaticThresholdChange?: (patch: Partial<{ warn: number; crit: number; direction: 'asc' | 'desc' }>) => void
  // Fully REMOVES the threshold config (vs. zeroing warn/crit, which would
  // leave a still-truthy {warn:0,crit:0} object that keeps firing for any
  // agent whose value is legitimately exactly 0).
  onClearStaticThreshold?: () => void
}) => {
  const color = colorOverride || SLOT_COLORS[slotKey] || '#888'
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
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
        {editableLabel ? (
          <input value={label} onClick={e => e.stopPropagation()}
            onChange={e => onLabelChange?.(e.target.value)}
            placeholder="Column name"
            style={{ background: 'transparent', border: 'none', outline: 'none', color: '#fff',
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
              minWidth: 0, flex: 1, padding: 0 }} />
        ) : <span>{label}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {value && <i className={`bx ${onClear ? 'bx-x' : 'bx-check'}`} style={{ fontSize: 12 }} />}
          {onRemove && <i className="bx bx-trash" title="Remove this column"
            onClick={e => { e.stopPropagation(); onRemove() }} style={{ fontSize: 12, cursor: 'pointer' }} />}
        </div>
      </div>
      <div title={value || undefined} style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600,
        color: value ? color : 'var(--text-muted,#687d75)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        background: value ? `${color}12` : 'transparent' }}>
        {value || (isActive ? '← click a column' : 'Not mapped')}
      </div>
      {onBreachTextChange && (
        <div onClick={e => e.stopPropagation()}
          style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '5px 8px 7px', borderTop: '1px solid var(--border,#e1e6e4)' }}>
          <input value={breachText ?? ''} onChange={e => onBreachTextChange?.(e.target.value)}
            placeholder="Flag breach if text contains…"
            title="Case-insensitive — e.g. &quot;Out of adherence&quot;. Leave blank to never breach on this column."
            style={{ flex: 1, minWidth: 0, fontSize: 10, padding: '3px 6px', borderRadius: 4,
              border: '1px solid var(--border,#e1e6e4)', background: 'var(--bg-body,#f0f2f1)', color: 'var(--text-main)' }} />
          {!!(breachText ?? '').trim() && (
            <button onClick={() => onBreachSeverityToggle?.()} title="Toggle warning/critical severity"
              style={{ fontSize: 9, fontWeight: 700, padding: '3px 6px', borderRadius: 4, border: 'none',
                cursor: 'pointer', flexShrink: 0, color: '#fff',
                background: breachSeverity === 'warning' ? '#d99e35' : '#c95c5c' }}>
              {breachSeverity === 'warning' ? 'WARN' : 'CRIT'}
            </button>
          )}
        </div>
      )}
      {durationMode && (
        <div onClick={e => e.stopPropagation()}
          style={{ padding: '5px 8px 7px', borderTop: '1px solid var(--border,#e1e6e4)' }}>
          <button onClick={() => onToggleDurationMode?.()}
            title={durationMode === 'running'
              ? 'Running: treated as elapsed time — parsed and ticked up live every second, and eligible for duration-based status-breach thresholds. Click to switch to Static.'
              : 'Static: shown exactly as scraped (no live ticking, no elapsed-time parsing) — use this when the mapped column isn’t really a duration (e.g. a ticket count). Duration-based status-breach thresholds are skipped in this mode. Click to switch to Running.'}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              fontSize: 10, fontWeight: 700, padding: '4px 6px', borderRadius: 5, border: 'none',
              cursor: 'pointer', color: '#fff',
              background: durationMode === 'running' ? '#4b8b9c' : '#888' }}>
            <i className={`bx ${durationMode === 'running' ? 'bx-timer' : 'bx-pause-circle'}`} style={{ fontSize: 12 }} />
            {durationMode === 'running' ? 'Running (live timer)' : 'Static (shown as-is)'}
          </button>
          {durationMode === 'static' && onStaticThresholdChange && (
            staticThreshold ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 5 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>W
                  <input type="number" value={staticThreshold.warn}
                    onChange={e => onStaticThresholdChange?.({ warn: parseFloat(e.target.value) || 0 })}
                    style={{ width: 36, padding: '3px 4px', borderRadius: 4, fontSize: 10, textAlign: 'center',
                      border: '1px solid var(--border,#e1e6e4)', background: 'var(--bg-body,#f0f2f1)', color: 'var(--text-main)' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>C
                  <input type="number" value={staticThreshold.crit}
                    onChange={e => onStaticThresholdChange?.({ crit: parseFloat(e.target.value) || 0 })}
                    style={{ width: 36, padding: '3px 4px', borderRadius: 4, fontSize: 10, textAlign: 'center',
                      border: '1px solid var(--border,#e1e6e4)', background: 'var(--bg-body,#f0f2f1)', color: 'var(--text-main)' }} />
                </label>
                <button onClick={() => onStaticThresholdChange?.({ direction: staticThreshold.direction === 'asc' ? 'desc' : 'asc' })}
                  title="Toggle whether high or low values are bad"
                  style={{ flex: 1, fontSize: 9, fontWeight: 700, padding: '3px 4px', borderRadius: 4, border: '1px solid rgba(75,139,156,0.3)',
                    cursor: 'pointer', color: '#4b8b9c', background: 'rgba(75,139,156,0.1)' }}>
                  {staticThreshold.direction === 'desc' ? 'Low = Bad' : 'High = Bad'}
                </button>
                {onClearStaticThreshold && (
                  <i className="bx bx-x" title="Remove this threshold — stop breach-checking this value entirely"
                    onClick={() => onClearStaticThreshold()}
                    style={{ fontSize: 14, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }} />
                )}
              </div>
            ) : (
              <button onClick={() => onStaticThresholdChange?.({})}
                title="Add a numeric breach threshold on this static value (e.g. breach when Ticket Solved drops too low)"
                style={{ width: '100%', marginTop: 5, fontSize: 9, fontWeight: 700, padding: '4px 6px', borderRadius: 5,
                  border: '1px dashed var(--border,#e1e6e4)', cursor: 'pointer', color: 'var(--text-muted)', background: 'transparent' }}>
                <i className="bx bx-plus" style={{ fontSize: 11, verticalAlign: 'middle' }} /> Add breach threshold
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
})

// "+" tile appended to a slot grid — adds a new custom Agent Table column.
const AddSlotCard = React.memo(({ onClick }: { onClick: () => void }) => (
  <div onClick={onClick} title="Add a custom column"
    style={{ border: '2px dashed var(--border,#e1e6e4)', borderRadius: 8, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 54, minWidth: 60,
      color: 'var(--text-muted)', transition: 'border-color 0.15s, color 0.15s' }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = '#d97a35'; e.currentTarget.style.color = '#d97a35' }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border,#e1e6e4)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
    <i className="bx bx-plus" style={{ fontSize: 20 }} />
  </div>
))

// ── Shared sort comparator for preview tables ────────────────────────────────
// Numeric-aware: if both values parse as numbers, compares numerically (so
// "9" sorts before "10"); otherwise falls back to a case-insensitive string
// compare. Blank/nullish values always sort last, in either direction, so a
// column with mostly-empty values doesn't scatter its few real entries
// throughout the sort.
function comparePreviewValues(a: unknown, b: unknown): number {
  const av = a ?? '', bv = b ?? ''
  const aBlank = String(av).trim() === '', bBlank = String(bv).trim() === ''
  if (aBlank && bBlank) return 0
  if (aBlank) return 1
  if (bBlank) return -1
  const an = parseFloat(String(av).replace(/,/g, '')), bn = parseFloat(String(bv).replace(/,/g, ''))
  if (!isNaN(an) && !isNaN(bn)) return an - bn
  return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
}

function SortArrow({ dir }: { dir: 'asc' | 'desc' }) {
  return <i className={`bx bx-chevron-${dir === 'asc' ? 'up' : 'down'}`} style={{ fontSize: 12, marginLeft: 3 }} />
}

const DsPreviewTable = React.memo(({ rows, mappedCols, hasActiveSlot, onMap }: {
  rows: Record<string, any>[]; mappedCols: Record<string, string>
  hasActiveSlot: boolean; onMap: (col: string) => void
}) => {
  // Hooks must run unconditionally (before the early "no rows" return below).
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const sortedRows = useMemo(() => {
    if (!sortCol || !rows.length) return rows
    const copy = [...rows]
    copy.sort((r1, r2) => {
      const cmp = comparePreviewValues(r1[sortCol], r2[sortCol])
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [rows, sortCol, sortDir])

  if (!rows.length) return (
    <div style={{ padding:'16px 24px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>
      No preview data — table may be empty
    </div>
  )
  const cols = Object.keys(rows[0])
  // A slot being actively placed takes priority — header click maps the
  // column, same as before. Only sort when nothing is being placed, so
  // there's no ambiguity about what a header click does at any given moment.
  const headerClick = (col: string) => {
    if (hasActiveSlot) { onMap(col); return }
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  return (
    <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:200, fontSize:11 }}>
      <table style={{ borderCollapse:'collapse', width:'100%', minWidth:'max-content' }}>
        <thead>
          <tr>
            {cols.map(col => {
              const color = mappedCols[col]
              return (
                <th key={col} onClick={() => headerClick(col)}
                  title={hasActiveSlot ? undefined : 'Click to sort'}
                  style={{ padding:'6px 10px', textAlign:'left', whiteSpace:'nowrap',
                    position:'sticky', top:0, zIndex:2,
                    background: color ? `${color}22` : 'var(--bg-body,#f0f2f1)',
                    color: color || (hasActiveSlot ? '#d97a35' : 'var(--text-muted)'),
                    fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.5px',
                    cursor: 'pointer',
                    borderBottom:`2px solid ${color||(hasActiveSlot?'#d97a35':'var(--border)')}`,
                    transition:'all 0.15s' }}>
                  {color && <span style={{ display:'inline-block', width:6, height:6,
                    borderRadius:'50%', background:color, marginRight:4 }} />}
                  {col}
                  {hasActiveSlot && !color && <span style={{ marginLeft:4, color:'#d97a35' }}>←</span>}
                  {!hasActiveSlot && sortCol === col && <SortArrow dir={sortDir} />}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, ri) => (
            <tr key={ri} style={{ background: ri%2===0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
              {cols.map(col => (
                <td key={col} onClick={() => hasActiveSlot && onMap(col)}
                  title={String(row[col] ?? '')}
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
function AgentSourceCard({ source, tables, supaUrl, supaKey, extraCols, onAddExtraCol, onRenameExtraCol, onRemoveExtraCol, onSetExtraColBreachText, onToggleExtraColSeverity, onChange, onRemove }: {
  source: AgentSource; tables: string[]; supaUrl: string; supaKey: string
  extraCols: AgentExtraColumn[]
  onAddExtraCol: () => void
  onRenameExtraCol: (key: string, label: string) => void
  onRemoveExtraCol: (key: string) => void
  onSetExtraColBreachText: (key: string, breachText: string) => void
  onToggleExtraColSeverity: (key: string) => void
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
    if (activeSlot.startsWith(EXTRA_AGENT_DURATION_COL_PREFIX)) {
      const key = activeSlot.slice(EXTRA_AGENT_DURATION_COL_PREFIX.length)
      onChange({ extraDurationCols: { ...(source.extraDurationCols || {}), [key]: colName } })
    } else if (activeSlot.startsWith(EXTRA_AGENT_METRIC_COL_PREFIX)) {
      const key = activeSlot.slice(EXTRA_AGENT_METRIC_COL_PREFIX.length)
      onChange({ extraMetricCols: { ...(source.extraMetricCols || {}), [key]: colName } })
    } else if (activeSlot.startsWith(EXTRA_AGENT_COL_PREFIX)) {
      const key = activeSlot.slice(EXTRA_AGENT_COL_PREFIX.length)
      onChange({ extraCols: { ...source.extraCols, [key]: colName } })
    } else {
      onChange({ [activeSlot]: colName } as Partial<AgentSource>)
    }
    setActiveSlot(null)
  }, [activeSlot, onChange, source.extraCols, source.extraDurationCols, source.extraMetricCols])

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
        {extraCols.map((c, i) => {
          const slotKey = EXTRA_AGENT_COL_PREFIX + c.key
          const durSlotKey = EXTRA_AGENT_DURATION_COL_PREFIX + c.key
          const metSlotKey = EXTRA_AGENT_METRIC_COL_PREFIX + c.key
          const hasBreachTrigger = !!(c.breachText || '').trim()
          return <React.Fragment key={slotKey}>
            <DsSlotCard slotKey={slotKey} label={c.label} hint="Custom column — mapped from this source's table"
              color={extraAgentColColor(i)} editableLabel onLabelChange={l => onRenameExtraCol(c.key, l)} onRemove={() => onRemoveExtraCol(c.key)}
              breachText={c.breachText} onBreachTextChange={v => onSetExtraColBreachText(c.key, v)}
              breachSeverity={c.breachSeverity} onBreachSeverityToggle={() => onToggleExtraColSeverity(c.key)}
              isActive={activeSlot === slotKey} value={source.extraCols?.[c.key] || ''}
              onToggle={k => setActiveSlot(cur => cur === k ? null : k)}
              onClear={() => { const ec = { ...source.extraCols }; delete ec[c.key]; onChange({ extraCols: ec }) }} />
            {hasBreachTrigger && (
              <DsSlotCard slotKey={durSlotKey} label={`${c.label} Duration`}
                hint="Optional — maps a SEPARATE column holding a duration (e.g. how long an agent has been in this state). When mapped, the Breach table shows THIS as the Value instead of just repeating the trigger text."
                color={extraAgentColColor(i)}
                isActive={activeSlot === durSlotKey} value={source.extraDurationCols?.[c.key] || ''}
                onToggle={k => setActiveSlot(cur => cur === k ? null : k)}
                onClear={() => { const ec = { ...(source.extraDurationCols || {}) }; delete ec[c.key]; onChange({ extraDurationCols: ec }) }} />
            )}
            {hasBreachTrigger && (
              <DsSlotCard slotKey={metSlotKey} label={`${c.label} Metric`}
                hint="Optional — maps a SEPARATE column (e.g. the account's status column) whose per-agent value replaces this column's label in the Breach table's Metric — e.g. shows &quot;Away&quot; instead of always &quot;Adherence&quot;."
                color={extraAgentColColor(i)}
                isActive={activeSlot === metSlotKey} value={source.extraMetricCols?.[c.key] || ''}
                onToggle={k => setActiveSlot(cur => cur === k ? null : k)}
                onClear={() => { const ec = { ...(source.extraMetricCols || {}) }; delete ec[c.key]; onChange({ extraMetricCols: ec }) }} />
            )}
          </React.Fragment>
        })}
        <AddSlotCard onClick={onAddExtraCol} />
      </div>
      {activeSlot && (
        <div className="ds-active-bar">
          <i className="bx bx-crosshair" style={{ fontSize: 16 }} />
          <strong>{activeAgentColSlotLabel(activeSlot, AGENT_SOURCE_SLOTS, extraCols)}</strong> is active — click a column header below
        </div>
      )}
      {source.table && (
        <div className="ds-preview">
          {loading ? (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading preview...</div>
          ) : (
            <DsPreviewTable rows={preview} hasActiveSlot={!!activeSlot} onMap={mapCol}
              mappedCols={{
                ...AGENT_SOURCE_SLOTS.reduce((acc, s) => { const v = (source as any)[s.key]; if (v) acc[v] = SLOT_COLORS[s.key] || '#888'; return acc }, {} as Record<string, string>),
                ...extraCols.reduce((acc, c, i) => { const v = source.extraCols?.[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
                ...extraCols.reduce((acc, c, i) => { const v = source.extraDurationCols?.[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
                ...extraCols.reduce((acc, c, i) => { const v = source.extraMetricCols?.[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
              }} />
          )}
        </div>
      )}
    </div>
  )
}

// A single KPI group's OWN data preview — mirrors AgentSourceCard's preview
// fetch exactly (own useEffect, own loading state, since each group with a
// `source` can point at a completely different table from every other
// group). Row+column clickable (needed for row-pinning via matchCol/
// matchVal, which is why this is a bespoke table rather than reusing the
// simpler column-only DsPreviewTable the Agent source cards use — agent
// tables are one-row-per-entity with no row-pinning concept, KPI tables
// commonly are not).
/** Which already-bound cells to outline in this preview, and in what colour.
 *  One entry per tile that reads THIS table, so a shared source shows every
 *  tile that points into it, each in its own tile colour. */
export interface SourceHighlight {
  color: string; label: string
  valueCol: string; matchCol?: string | null; matchVal?: string | null
}

function KpiGroupSourcePreview({ table, accountCol, accountId, supaUrl, supaKey, hasActiveSlot, highlights, onPick }: {
  table: string; accountCol?: string; accountId: string; supaUrl: string; supaKey: string
  hasActiveSlot: boolean
  highlights?: SourceHighlight[]
  onPick: (row: Record<string, any>, col: string) => void
}) {
  const [preview, setPreview] = useState<Record<string, any>[]>([])
  const [loading, setLoading] = useState(false)
  // Opt-in escape hatch: rows for OTHER accounts, shown for orientation only
  // and deliberately NOT clickable (see the fetch comment below).
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    // Clear synchronously, not in the .then — otherwise for one render this
    // table shows the PREVIOUS table's rows with live click handlers, and a
    // mistimed click binds a column from the wrong table entirely. Matters
    // much more now that one panel can swap between tiles pointing at
    // different tables.
    setPreview([])
    if (!table) return
    setLoading(true)
    // Filter to THIS account. A TALL key/value table (one row per metric per
    // account, e.g. homebase_omni_queue_stats) can easily push this account's
    // rows past an unfiltered window, leaving the exact row you need to click
    // invisible. The runtime fetch ALWAYS filters by accountCol, so an
    // unfiltered preview is not just unhelpful — a click on another account's
    // row writes a matchVal the runtime can never match.
    const col = accountCol || 'account_id'
    const url = showAll
      ? `${supaUrl}/rest/v1/${table}?limit=20`
      : `${supaUrl}/rest/v1/${table}?${col}=eq.${encodeURIComponent(accountId)}&limit=50`
    fetch(url, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setPreview(Array.isArray(d) ? d : []))
      .catch(() => setPreview([]))
      .finally(() => setLoading(false))
  }, [table, accountCol, accountId, showAll, supaUrl, supaKey])

  if (!table) return null
  if (loading) return <div style={{ padding: 12, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>Loading preview...</div>
  if (preview.length === 0) return (
    <div style={{ padding: 12, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
      {showAll ? 'No rows in this table' : <>No rows in <code>{table}</code> for <strong>{accountId}</strong> (matching on <code>{accountCol || 'account_id'}</code>) — check the table and Account col, or the scraper may not have written yet.{' '}
        <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setShowAll(true)}>show all rows (read-only)</a></>}
    </div>
  )

  const cols = Object.keys(preview[0])
  // Rows from the "show all" escape hatch belong to other accounts — binding
  // against one would store a matchVal this account's runtime query never
  // returns, so clicking is disabled there regardless of hasActiveSlot.
  const clickable = hasActiveSlot && !showAll
  // Same matching rule the runtime resolver uses: an exact row-key match pins
  // ONE row, otherwise an unconstrained binding means the first row. Never
  // highlight in the "show all" view — those rows belong to other accounts
  // and aren't what this binding resolves against.
  const hiColor = (row: Record<string, any>, colName: string, ri: number): SourceHighlight | undefined => {
    if (showAll) return undefined
    for (const h of (highlights ?? [])) {
      if (h.valueCol !== colName) continue
      if (h.matchVal != null && h.matchVal !== '') {
        if (!h.matchCol || String(row[h.matchCol] ?? '') !== h.matchVal) continue
      } else if (ri !== 0) continue   // no constraints at all -> first row only
      return h
    }
    return undefined
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: 200, fontSize: 11, border: '1px solid var(--border,#e1e6e4)', borderRadius: 6, marginTop: 6 }}>
      {showAll && (
        <div style={{ padding: '4px 8px', fontSize: 10, background: 'rgba(217,122,53,0.12)', color: 'var(--text-muted)' }}>
          Showing ALL accounts&apos; rows — not bindable.{' '}
          <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setShowAll(false)}>back to {accountId}</a>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 'max-content' }}>
        <thead><tr>{cols.map(c => <th key={c} className="ds-th">{c}</th>)}</tr></thead>
        <tbody>
          {preview.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
              {cols.map(c => {
                const hi = hiColor(row, c, ri)
                return (
                  <td key={c} className="ds-td"
                    title={hi ? `Bound to "${hi.label}"` : String(row[c] ?? '')}
                    style={{
                      cursor: clickable ? 'pointer' : 'default',
                      background: hi ? `${hi.color}22` : undefined,
                      outline: hi ? `2px solid ${hi.color}` : 'none',
                    }}
                    onClick={() => clickable && onPick(row, c)}>
                    {String(row[c] ?? '')}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// One source editor, used for a whole GROUP and for a single TILE — four
// pickers plus the account-filtered preview. Lifted verbatim out of the
// per-group panel rather than re-typed, for the same reason the resolver is
// shared: two hand-maintained copies is how the tile editor ends up missing a
// field the group editor gained.
function KpiSourcePanel({ title, color, source, tables, supaUrl, supaKey, accountId, hint, previewClickable, highlights, onPatch, onRevert, onPick }: {
  title: string; color?: string; source: KpiGroupSource
  tables: string[]; supaUrl: string; supaKey: string; accountId: string
  hint: React.ReactNode; previewClickable: boolean; highlights?: SourceHighlight[]
  onPatch: (patch: Partial<KpiGroupSource>) => void
  onRevert?: () => void
  onPick: (row: Record<string, any>, col: string) => void
}) {
  return (
    <div className="ds-group-source-panel" style={{ background: 'var(--bg-card,#fff)', border: '1px solid var(--border,#e1e6e4)', borderLeft: color ? `3px solid ${color}` : undefined, borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div className="ds-section-title" style={{ borderBottom: 'none', padding: 0, margin: 0, color }}>{title}</div>
        {/* Reverting to the inherited source is an EXPLICIT control here, not
            the same icon that opens this panel — otherwise the obvious thing
            to click when you want to re-check a configured tile destroys its
            table/row key. */}
        {onRevert && (
          <button className="ds-mode-btn" style={{ marginLeft: 'auto' }}
            title="Stop this tile reading its own table — revert it to whatever the rest of its group reads. The cell binding is left alone."
            onClick={onRevert}><i className="bx bx-undo" /> Use group&apos;s source</button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Table</span>
          <DsTableSelector field="table" value={source.table} tables={tables} onChange={(_, v) => onPatch({ table: v })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Account col</span>
          <input className="ds-select" style={{ minWidth: 120 }} value={source.accountCol} onChange={e => onPatch({ accountCol: e.target.value })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Row key</span>
          <input className="ds-select" style={{ minWidth: 120 }} placeholder="(one row)" value={source.rowKeyCol} onChange={e => onPatch({ rowKeyCol: e.target.value })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="ds-mini-label">Updated at</span>
          <input className="ds-select" style={{ minWidth: 120 }} placeholder="(none)" value={source.updatedAtCol} onChange={e => onPatch({ updatedAtCol: e.target.value })} />
        </div>
      </div>
      <p className="ds-hint" style={{ marginBottom: 0 }}>{hint}</p>
      {/* key: force a fresh mount when the table changes, so stale rows from
          the previous table can never be left on screen and clickable. */}
      <KpiGroupSourcePreview key={`${source.table}::${source.accountCol}`}
        table={source.table} accountCol={source.accountCol} accountId={accountId}
        supaUrl={supaUrl} supaKey={supaKey}
        hasActiveSlot={previewClickable} highlights={highlights} onPick={onPick} />
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
  const [kpiSortCol, setKpiSortCol] = useState<string | null>(null)
  const [kpiSortDir, setKpiSortDir] = useState<'asc' | 'desc'>('asc')

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  useEffect(() => { fetchPublicTables(supaUrl, supaKey).then(setTables) }, [])

  // Column list per EFFECTIVE source, so a tile card can say when its binding
  // names a column that table doesn't have. Fetched here rather than reported
  // up from the preview panels, because the tile that most needs this check is
  // precisely the one that INHERITS a source and therefore renders no panel at
  // all — which is how "New Metric" ended up silently asking
  // homebase_omni_queue_stats for avg_sla_pct.
  const [sourcePreviewCols, setSourcePreviewCols] = useState<Record<string, string[]>>({})
  const effSourceSig = JSON.stringify(
    (localDs.groups ?? []).flatMap(g => [g.source, ...(Array.isArray(g.tiles) ? g.tiles.map(t => t?.source) : [])])
      .filter(Boolean).map(s => kpiSourceKey(s as KpiGroupSource)))
  useEffect(() => {
    const srcs = new Map<string, KpiGroupSource>()
    ;(localDs.groups ?? []).forEach(g => {
      const add = (s?: KpiGroupSource | null) => { if (s?.table) srcs.set(kpiSourceKey(s), s) }
      add(g.source)
      ;(Array.isArray(g.tiles) ? g.tiles : []).forEach(t => add(t?.source))
    })
    let cancelled = false
    Promise.all([...srcs.entries()].map(async ([key, s]) => {
      try {
        const r = await fetch(`${supaUrl}/rest/v1/${s.table}?limit=1`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
        const d = await r.json()
        return [key, Array.isArray(d) && d[0] ? Object.keys(d[0]) : []] as const
      } catch { return [key, []] as const }
    })).then(pairs => { if (!cancelled) setSourcePreviewCols(Object.fromEntries(pairs)) })
    return () => { cancelled = true }
  }, [effSourceSig, supaUrl, supaKey])

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
  const toggleAgentDurationStatic = useCallback(() => {
    setLocalDs(prev => ({ ...prev, agentDurationStatic: !prev.agentDurationStatic }))
  }, [])
  const updateAgentDurationStaticThreshold = useCallback((patch: Partial<{ warn: number; crit: number; direction: 'asc' | 'desc' }>) => {
    setLocalDs(prev => ({ ...prev, agentDurationStaticThreshold: {
      // Same starter defaults as addExtra's Extra KPI Tiles, not 0/0 — an
      // all-zero threshold looks "off" but isn't (it still breach-checks
      // any value that's legitimately exactly 0).
      warn: 10, crit: 20, direction: 'asc' as const, ...(prev.agentDurationStaticThreshold || {}), ...patch,
    } }))
  }, [])
  const clearAgentDurationStaticThreshold = useCallback(() => {
    setLocalDs(prev => { const next = { ...prev }; delete next.agentDurationStaticThreshold; return next })
  }, [])
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
  // Toggle/edit a group's own data source (see KpiGroupSource in
  // lib/types.ts) — OFF (patch=null) reverts to the shared ds.kpiTable path
  // with zero other changes; ON seeds sensible defaults (accountCol
  // defaults to 'account_id', the overwhelmingly common column name) the
  // user can still override via the picker, same "legacy fallback until
  // overridden" convention as agentSources elsewhere in this file.
  const setGroupSource = useCallback((id: string, patch: Partial<KpiGroupSource> | null) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => {
      if (g.id !== id) return g
      if (patch === null) return { ...g, source: null }
      return { ...g, source: { table: '', accountCol: 'account_id', rowKeyCol: '', updatedAtCol: '', ...(g.source || {}), ...patch } }
    }) }))
  }, [])
  // Toggle/edit ONE TILE's own data source (see GroupTile.source in
  // lib/types.ts) — exactly setGroupSource's semantics one level deeper:
  // OFF (patch=null) reverts this tile to reading whatever the REST of its
  // group reads (group.source if set, else the shared ds.kpiTable), with zero
  // other changes; ON seeds the same defaults (accountCol 'account_id', the
  // overwhelmingly common column name) the user can override below.
  //
  // Writes ONLY `source`, never `key`: the Workforce RTA Logs heartbeat /
  // breach-change baselines in wfm_settings.rta_logs_state are keyed
  // `${group.id}:${tile.key}` (see lib/breaches.ts), so re-keying a tile here
  // would silently reset its baseline and fire a spurious immediate report.
  // The tile's existing `cell` binding is deliberately left alone too —
  // re-point the table, then re-click the cell, same as the group-level flow.
  const setGroupTileSource = useCallback((groupId: string, tileKey: string, patch: Partial<KpiGroupSource> | null) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => {
      if (g.id !== groupId || !g.tiles) return g
      return { ...g, tiles: g.tiles.map(t => {
        if (t.key !== tileKey) return t
        if (patch === null) return { ...t, source: null }
        return { ...t, source: { table: '', accountCol: 'account_id', rowKeyCol: '', updatedAtCol: '', ...(t.source || {}), ...patch } }
      }) }
    }) }))
  }, [])
  const clearCell = useCallback((groupId: string, kpiKey: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => {
      if (g.id !== groupId) return g
      if (g.tiles && g.tiles.length) return { ...g, tiles: g.tiles.map(t => t.key === kpiKey ? { ...t, cell: null } : t) }
      const cells = { ...g.cells }; delete cells[kpiKey]; return { ...g, cells }
    }) }))
  }, [])
  const addExtra = useCallback(() => {
    setLocalDs(prev => ({ ...prev, extraTiles: [...prev.extraTiles,
      { key: 'extra_' + genId(), label: `Extra ${prev.extraTiles.length + 1}`, warn: 10, crit: 20, targ: 5, higherIsBetter: false, kpiUnit: 'percent' }] }))
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
        // Pin the exact row. Prefer the ACTIVE group's own Row key when that
        // group has its own `source` (an alt-table group's row-key column has
        // nothing to do with the account-wide kpiRowKeyCol — e.g. Flex's
        // flex_overwatch_first_reply uses "metric", not whatever
        // flex_explore_tiles uses); otherwise fall back to the account-wide
        // kpiRowKeyCol, then auto-detect a unique identifier column so a
        // single click always binds ONE cell.
        const cols = Object.keys(row)
        const activeGroup = prev.groups.find(g => g.id === cur.groupId)
        const activeTile  = activeGroup?.tiles?.find(t => t.key === cur.kpiKey) ?? null
        const autoDetect = cols.includes('kpi_key') ? 'kpi_key' : cols.includes('id') ? 'id' : ''
        // The row key is scoped to whichever table this cell actually came
        // from — a TILE with its own source first (GroupTile.source), then its
        // GROUP's, then the account-wide kpiRowKeyCol. Precedence comes from
        // lib/breaches.ts's effectiveKpiSource(), the SAME function the
        // renderers and the Cliq/RTA scan resolve with, so the editor cannot
        // pin a row against a table the runtime won't read. A row key is NEVER
        // inherited across tables: a column from one table may not exist in
        // another at all.
        const pickSrc = activeGroup ? effectiveKpiSource(activeGroup, activeTile) : null
        const rk = pickSrc
          ? (pickSrc.rowKeyCol || autoDetect)
          : (prev.kpiRowKeyCol || autoDetect)
        if (rk) { binding.matchCol = rk; binding.matchVal = String(row[rk] ?? '') }
        return { ...prev, groups: prev.groups.map(g => {
          if (g.id !== cur.groupId) return g
          // Independent-tiles group — bind straight onto that tile's own `cell`.
          if (g.tiles && g.tiles.length) {
            return { ...g, tiles: g.tiles.map(t => t.key === cur.kpiKey ? { ...t, cell: binding } : t) }
          }
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

  // ── Per-group independent tiles (see GroupTile in lib/types.ts) ────────────
  // Toggling a group INTO independent-tile mode snapshots its current shared
  // labels + bindings (so already-working mappings aren't lost) with generic
  // starter thresholds — real numbers get set afterward on the KPI Thresholds
  // tab, now rendered per-group for exactly this case. Toggling back out just
  // drops `tiles`, reverting to the shared kpiLabels/extraTiles/cells path.
  const setGroupCustomMode = useCallback((groupId: string, on: boolean) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => {
      if (g.id !== groupId) return g
      if (!on) return { ...g, tiles: undefined }
      const dirDefault: Record<string, 'asc' | 'desc'> = { sla: 'desc', wait: 'asc', aht: 'asc', abn: 'asc' }
      const unitDefault: Record<string, GroupTile['kpiUnit']> = { sla: 'percent', wait: 'count', aht: 'duration', abn: 'percent' }
      const boundKeys = ['sla', 'wait', 'aht', 'abn', ...prev.extraTiles.map(t => t.key)].filter(k => g.cells[k])
      const tiles: GroupTile[] = boundKeys.length
        ? boundKeys.map(k => {
            const extra = prev.extraTiles.find(t => t.key === k)
            const label = k === 'sla' || k === 'wait' || k === 'aht' || k === 'abn' ? prev.kpiLabels[k] : (extra?.label || k)
            return {
              key: k, label, cell: g.cells[k] || null,
              warn: extra?.warn ?? 10, crit: extra?.crit ?? 20, targ: extra?.targ ?? 5,
              direction: extra ? (extra.higherIsBetter ? 'desc' : 'asc') : (dirDefault[k] ?? 'asc'),
              kpiUnit: extra ? (extra.kpiUnit ?? 'percent') : (unitDefault[k] ?? 'percent'),
            }
          })
        : [newGroupTile()]
      return { ...g, tiles }
    }) }))
  }, [])
  const addGroupTile = useCallback((groupId: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === groupId
      ? { ...g, tiles: [...(g.tiles || []), newGroupTile(`Metric ${(g.tiles?.length || 0) + 1}`)] } : g) }))
  }, [])
  const removeGroupTile = useCallback((groupId: string, key: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === groupId
      ? { ...g, tiles: (g.tiles || []).filter(t => t.key !== key) } : g) }))
  }, [])
  const updateGroupTileLabel = useCallback((groupId: string, key: string, label: string) => {
    setLocalDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === groupId
      ? { ...g, tiles: (g.tiles || []).map(t => t.key === key ? { ...t, label } : t) } : g) }))
  }, [])
  const mapAgentCol = useCallback((colName: string) => {
    setActiveAgentSlot(cur => {
      if (cur) setLocalDs(prev => {
        // Custom column slots write into agentExtraColsMap (legacy single
        // table's mapping) instead of a flat top-level field.
        if (cur.startsWith(EXTRA_AGENT_DURATION_COL_PREFIX)) {
          const key = cur.slice(EXTRA_AGENT_DURATION_COL_PREFIX.length)
          return { ...prev, agentExtraDurationColsMap: { ...(prev.agentExtraDurationColsMap || {}), [key]: colName } }
        }
        if (cur.startsWith(EXTRA_AGENT_METRIC_COL_PREFIX)) {
          const key = cur.slice(EXTRA_AGENT_METRIC_COL_PREFIX.length)
          return { ...prev, agentExtraMetricColsMap: { ...(prev.agentExtraMetricColsMap || {}), [key]: colName } }
        }
        if (cur.startsWith(EXTRA_AGENT_COL_PREFIX)) {
          const key = cur.slice(EXTRA_AGENT_COL_PREFIX.length)
          return { ...prev, agentExtraColsMap: { ...prev.agentExtraColsMap, [key]: colName } }
        }
        return { ...prev, [cur]: colName }
      })
      return null
    })
  }, [])

  // ── Custom Agent Status table columns — defined ONCE for the whole account
  // (shown as an extra column on the Dashboard's Agent Status table for every
  // source), same add/rename/remove pattern as Extra KPI Tiles but with no
  // thresholds (a plain display column, not a KPI). Each source (legacy table
  // + every AgentSource) maps this key to its OWN column name separately —
  // see agentExtraColsMap below and AgentSourceCard's extraCols prop.
  const addAgentExtraCol = useCallback(() => {
    setLocalDs(prev => ({ ...prev, agentExtraCols: [...prev.agentExtraCols,
      { key: 'agentcol_' + genId(), label: `Column ${prev.agentExtraCols.length + 1}` }] }))
  }, [])
  const renameAgentExtraCol = useCallback((key: string, label: string) => {
    setLocalDs(prev => ({ ...prev, agentExtraCols: prev.agentExtraCols.map(c => c.key === key ? { ...c, label } : c) }))
  }, [])
  const setAgentExtraColBreachText = useCallback((key: string, breachText: string) => {
    setLocalDs(prev => ({ ...prev, agentExtraCols: prev.agentExtraCols.map(c => c.key === key ? { ...c, breachText } : c) }))
  }, [])
  const toggleAgentExtraColSeverity = useCallback((key: string) => {
    setLocalDs(prev => ({ ...prev, agentExtraCols: prev.agentExtraCols.map(c =>
      c.key === key ? { ...c, breachSeverity: c.breachSeverity === 'warning' ? 'critical' : 'warning' } : c) }))
  }, [])
  const removeAgentExtraCol = useCallback((key: string) => {
    setLocalDs(prev => {
      const agentExtraColsMap = { ...prev.agentExtraColsMap }; delete agentExtraColsMap[key]
      const agentExtraDurationColsMap = { ...(prev.agentExtraDurationColsMap || {}) }; delete agentExtraDurationColsMap[key]
      const agentExtraMetricColsMap = { ...(prev.agentExtraMetricColsMap || {}) }; delete agentExtraMetricColsMap[key]
      return {
        ...prev,
        agentExtraCols: prev.agentExtraCols.filter(c => c.key !== key),
        agentExtraColsMap,
        agentExtraDurationColsMap,
        agentExtraMetricColsMap,
        agentSources: prev.agentSources.map(s => {
          if (!(key in (s.extraCols || {})) && !(key in (s.extraDurationCols || {})) && !(key in (s.extraMetricCols || {}))) return s
          const extraCols = { ...s.extraCols }; delete extraCols[key]
          const extraDurationCols = { ...(s.extraDurationCols || {}) }; delete extraDurationCols[key]
          const extraMetricCols = { ...(s.extraMetricCols || {}) }; delete extraMetricCols[key]
          return { ...s, extraCols, extraDurationCols, extraMetricCols }
        }),
      }
    })
    setActiveAgentSlot(cur => (cur === EXTRA_AGENT_COL_PREFIX + key || cur === EXTRA_AGENT_DURATION_COL_PREFIX + key || cur === EXTRA_AGENT_METRIC_COL_PREFIX + key) ? null : cur)
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
  // The shared KPI preview table reflects the account-wide kpiTable — if the
  // active slot belongs to a group with its OWN source, clicks there must be
  // disabled (its own KpiGroupSourcePreview handles that group's binding instead).
  // Which preview accepts the next click is decided by the ARMED SLOT's
  // EFFECTIVE source (tile.source -> group.source -> account-wide), using the
  // same lib/breaches.ts precedence the renderers resolve with — so a click
  // can only ever land in the preview of the table the binding will actually
  // be read from. Without the tile tier, a tile with its own source inside a
  // shared-source group would still make the bottom account-wide preview
  // clickable, writing a valueCol from a table that doesn't contain it — a
  // binding that silently resolves to '' forever.
  const activeGroupObj = activeCell ? (localDs.groups.find(g => g.id === activeCell.groupId) ?? null) : null
  const activeTileObj  = activeCell ? (activeGroupObj?.tiles?.find(t => t.key === activeCell.kpiKey) ?? null) : null
  const activeEffSource = activeGroupObj ? effectiveKpiSource(activeGroupObj, activeTileObj) : null
  const sharedPreviewClickable = !!activeCell && !activeEffSource
  // Carries each row's ORIGINAL index alongside it — cellColor() below pins
  // "no filter configured" bindings to the first row by POSITION (ri === 0),
  // so sorting must not change which row that logic considers "first";
  // sortedKpiPreview only changes display order, never what's passed to
  // cellColor as the row's index.
  const sortedKpiPreview = useMemo(() => {
    const withIndex = kpiPreview.map((row, i) => ({ row, i }))
    if (!kpiSortCol) return withIndex
    withIndex.sort((a, b) => {
      const cmp = comparePreviewValues(a.row[kpiSortCol], b.row[kpiSortCol])
      return kpiSortDir === 'asc' ? cmp : -cmp
    })
    return withIndex
  }, [kpiPreview, kpiSortCol, kpiSortDir])
  const handleKpiHeaderClick = (col: string) => {
    if (kpiSortCol === col) setKpiSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setKpiSortCol(col); setKpiSortDir('asc') }
  }
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
        .ds-mode-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 6px;
          border: 1px solid rgba(75,139,156,0.3); background: rgba(75,139,156,0.1); color: #4b8b9c;
          font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit; white-space: nowrap; }
        .ds-mode-btn.on { border-color: rgba(217,122,53,0.35); background: rgba(217,122,53,0.12); color: #d97a35; }
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
        {localDs.groups.map(group => {
          const isCustom = !!(group.tiles && group.tiles.length)
          // Which bound cells to outline inside a given source's preview.
          // Collected across the WHOLE group, so a table shared by several
          // tiles shows every one of them (each in its own tile colour) —
          // not just the tile whose panel you happen to be looking at.
          // effectiveKpiSource() decides membership, so a tile only lights up
          // in the preview of the table it actually resolves against.
          const highlightsFor = (src: KpiGroupSource | null): SourceHighlight[] => {
            if (!src?.table) return []
            const key = kpiSourceKey(src)
            return (group.tiles ?? []).flatMap((t, i) => {
              const ts = effectiveKpiSource(group, t)
              if (!ts?.table || kpiSourceKey(ts) !== key) return []
              if (!t.cell?.valueCol) return []
              return [{
                color: EXTRA_COLORS[i % EXTRA_COLORS.length], label: t.label,
                valueCol: t.cell.valueCol, matchCol: t.cell.matchCol ?? null, matchVal: t.cell.matchVal ?? null,
              }]
            })
          }

          // `tile` is the single injection point that lets the ONE shared
          // slot-render loop below show the per-tile source affordance
          // without branching in JSX.
          const slots = isCustom
            ? group.tiles!.map((t, i) => ({ key: t.key, label: t.label, binding: t.cell, color: EXTRA_COLORS[i % EXTRA_COLORS.length], tile: t as GroupTile | undefined }))
            // Legacy shared-tiles groups bind through g.cells, a plain
            // Record<string, CellBinding> with nowhere to hang a table — so
            // per-tile sources are an independent-tiles-only feature and this
            // branch always reports `tile: undefined`. Flip the group to
            // "Independent tiles" (setGroupCustomMode, which carries existing
            // bindings across) to use them.
            : allKpiKeys.map(k => ({ key: k, label: tileLabel(k), binding: group.cells[k], color: tileColor(k), tile: undefined as GroupTile | undefined }))
          return (
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
              <button className={`ds-mode-btn${isCustom ? ' on' : ''}`}
                title={isCustom
                  ? 'This group has its own independent tiles (labels, bindings, and — on the KPI Thresholds tab — thresholds), separate from every other group. Click to revert to the account-wide shared tiles.'
                  : 'Give this group its own independent tiles — different labels, bindings, and thresholds from every other group (e.g. "Messaging SLA" vs "Email SLA" with completely different columns).'}
                onClick={() => {
                  // Turning Independent tiles OFF drops `tiles` entirely, and
                  // per-tile sources live ON those tiles — so this silently
                  // destroys every per-tile table choice in the group. Only
                  // confirm when there is actually something to lose.
                  const losing = isCustom ? (group.tiles ?? []).filter(t => t.source).length : 0
                  if (losing > 0 && !window.confirm(
                    `Switching "${group.name || 'this group'}" back to Shared tiles will delete the per-tile data source on ${losing} tile${losing === 1 ? '' : 's'}.\n\n` +
                    `Those tiles will go back to reading the group's table. Continue?`
                  )) return
                  setGroupCustomMode(group.id, !isCustom)
                }}>
                <i className={`bx ${isCustom ? 'bx-git-branch' : 'bx-link'}`} /> {isCustom ? 'Independent tiles' : 'Shared tiles'}
              </button>
              <button className={`ds-mode-btn${group.source ? ' on' : ''}`}
                title={group.source
                  ? 'This group reads from its OWN table, independent of the account-wide KPI Data Source above. Click to revert to the shared table.'
                  : 'Give this group its own data source — read its tiles from a DIFFERENT Supabase table than every other group on this account (e.g. a second scraped dashboard).'}
                onClick={() => setGroupSource(group.id, group.source ? null : {})}>
                <i className={`bx ${group.source ? 'bx-data' : 'bx-share-alt'}`} /> {group.source ? 'Own source' : 'Shared source'}
              </button>
              <button className="ds-x" title="Remove group" onClick={() => removeGroup(group.id)}><i className="bx bx-trash" /></button>
            </div>

            {group.source && (
              <KpiSourcePanel title={`${group.name || 'GROUP'} — OWN SOURCE`} source={group.source}
                tables={tables} supaUrl={supaUrl} supaKey={supaKey} accountId={accountId}
                hint={<>This group&apos;s tiles bind against THIS table — click a slot below, then click a cell here. A tile with its OWN source (the database icon on its card) overrides this for that one tile.</>}
                previewClickable={!!activeCell && activeCell.groupId === group.id && !activeTileObj?.source}
                highlights={highlightsFor(group.source)}
                onPatch={p => setGroupSource(group.id, p)}
                onPick={(row, col) => pickCell(row, col)} />
            )}

            <div className="ds-slot-grid">
              {slots.map(slot => {
                const { key: k, label, binding: b, color, tile } = slot
                const isActive = !!activeCell && activeCell.groupId === group.id && activeCell.kpiKey === k
                // ALWAYS show which table this tile actually reads — not just
                // when it has its own source. A tile that inherits a group
                // source it was never bound against renders '--' on the
                // dashboard with nothing on this card explaining why, which
                // is exactly how the "only one tile shows up" confusion keeps
                // recurring. effectiveKpiSource() is the same precedence the
                // runtime resolves with, so what's printed here is literally
                // the table the value will be read from.
                const effSrc = effectiveKpiSource(group, tile ?? null)
                const effTable = effSrc ? (effSrc.table || '(no table picked)') : (localDs.kpiTable || '(account-wide)')
                const bindDisp = b ? (b.matchVal ? `${b.matchVal} → ${b.valueCol}` : b.valueCol) : (isActive ? '← click a cell' : 'not set')
                const disp = b ? `${effTable}: ${bindDisp}` : bindDisp
                // A binding whose valueCol cannot exist in the effective
                // table is dead — flag it rather than letting it silently
                // render '--' three screens away on the Overview page.
                const srcRows = effSrc ? sourcePreviewCols[kpiSourceKey(effSrc)] : null
                const deadBinding = !!b && !!srcRows && srcRows.length > 0 && !srcRows.includes(b.valueCol)
                return (
                  <div key={k} className="ds-cellcard"
                    style={{ borderColor: isActive ? color : 'var(--border,#e1e6e4)', animation: isActive ? 'slot-pulse 1s infinite' : 'none' }}
                    onClick={() => setActiveCell(cur => (cur && cur.groupId === group.id && cur.kpiKey === k) ? null : { groupId: group.id, kpiKey: k })}>
                    <div className="ds-cellcard-h" style={{ background: color }}>
                      {/* Editable right on the card you already click to arm cell-picking —
                          stopPropagation so typing here doesn't also arm/disarm the card.
                          Legacy (shared) tiles rename everywhere this KPI key is shown, since
                          there's one shared display name per key. Independent tiles rename
                          ONLY within this group — see GroupTile. */}
                      <input value={label} title="Click to rename this tile"
                        onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                        onChange={e => {
                          const val = e.target.value
                          if (isCustom) updateGroupTileLabel(group.id, k, val)
                          else if (k === 'sla' || k === 'wait' || k === 'aht' || k === 'abn') setLabel(k, val)
                          else updateExtra(k, { label: val })
                        }}
                        style={{
                          background: 'transparent', border: 'none', outline: 'none', color: '#fff',
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
                          width: '100%', minWidth: 0, padding: 0, margin: 0, fontFamily: 'inherit', cursor: 'text',
                        }} />
                      {/* Per-tile source. ARMS the tile and turns its source
                          ON — never off: on a configured tile this is the
                          obvious thing to click to reopen its panel, and
                          making it destructive would also flip
                          sharedPreviewClickable true, so the next click in
                          the bottom account-wide preview would silently
                          rebind this tile to the wrong table. Reverting lives
                          in the panel ("Use group's source"). */}
                      {isCustom && (
                        <i className={`bx bx-data`} style={{ cursor: 'pointer', flexShrink: 0, opacity: tile?.source ? 1 : 0.55 }}
                          title={tile?.source
                            ? `This tile reads its own table (${tile.source.table || 'none picked yet'}) — edit it in the panel below`
                            : 'Give THIS tile its own data source, separate from the rest of the group'}
                          onClick={e => {
                            e.stopPropagation()
                            if (!tile?.source) setGroupTileSource(group.id, k, {})
                            setActiveCell({ groupId: group.id, kpiKey: k })
                          }} />
                      )}
                      {b && <i className="bx bx-x" title="Clear binding" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={e => { e.stopPropagation(); clearCell(group.id, k) }} />}
                      {isCustom && <i className="bx bx-trash" title="Remove this tile" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={e => { e.stopPropagation(); removeGroupTile(group.id, k) }} />}
                    </div>
                    <div className="ds-cellcard-v"
                      title={deadBinding
                        ? `This tile reads "${effTable}", which has no "${b!.valueCol}" column — so it renders -- on the dashboard. Click the database icon to give this tile its own table.`
                        : `Reads from ${effTable}`}
                      style={{
                        color: deadBinding ? 'var(--danger,#c0392b)' : (b ? color : 'var(--text-muted)'),
                        background: deadBinding ? 'rgba(192,57,43,0.12)' : (b ? `${color}12` : 'transparent'),
                      }}>
                      {deadBinding && <i className="bx bx-error-circle" style={{ marginRight: 4 }} />}
                      {disp}
                    </div>
                  </div>
                )
              })}
              {isCustom && <AddSlotCard onClick={() => addGroupTile(group.id)} />}
            </div>

            {/* One panel per tile that has its own source. Rendered for ANY
                such tile, NOT only the armed one: pickCell() ends by clearing
                activeCell, so an arm-gated panel would unmount the instant a
                cell is clicked — taking Table/Account col/Row key off screen
                before the user can confirm what they just bound. Only the
                preview's CLICKABILITY is gated on arming. */}
            {isCustom && group.tiles!.filter(t => t.source).map(t => {
              const i = group.tiles!.findIndex(x => x.key === t.key)
              const color = EXTRA_COLORS[i % EXTRA_COLORS.length]
              const armed = !!activeCell && activeCell.groupId === group.id && activeCell.kpiKey === t.key
              return (
                <KpiSourcePanel key={t.key} title={`${t.label} — OWN SOURCE`} color={color} source={t.source!}
                  tables={tables} supaUrl={supaUrl} supaKey={supaKey} accountId={accountId}
                  hint={armed
                    ? <>Only <strong>{t.label}</strong> binds against this table — click a cell below. For a TALL table (one row per metric) set <strong>Row key</strong> to a column that is UNIQUE per row (on <code>homebase_omni_queue_stats</code> that is <code>id</code>, not <code>metric</code> — <code>metric</code> repeats once a second queue is scraped); for a WIDE one-row table leave Row key empty.</>
                    : <>Click the <strong>{t.label}</strong> card above to arm it, then click a cell here to bind it.</>}
                  previewClickable={armed}
                  highlights={highlightsFor(t.source!)}
                  onPatch={p => setGroupTileSource(group.id, t.key, p)}
                  onRevert={() => setGroupTileSource(group.id, t.key, null)}
                  onPick={(row, col) => pickCell(row, col)} />
              )
            })}
          </div>
          )
        })}
        <button className="ds-add-btn" onClick={addGroup}><i className="bx bx-plus" /> Add Group</button>

        {/* Extra tiles */}
        <div className="ds-extra-wrap">
          <div className="ds-section-title">EXTRA KPI TILES</div>
          {localDs.extraTiles.map((t, i) => {
            const unit = t.kpiUnit ?? 'percent'
            return (
            <div key={t.key} className="ds-extra-row">
              <span className="ds-label-dot" style={{ background: EXTRA_COLORS[i % EXTRA_COLORS.length] }} />
              <input className="acc-add-input ds-extra-name" value={t.label} onChange={e => updateExtra(t.key, { label: e.target.value })} placeholder="Tile name" />
              <KpiUnitSelect value={unit} onChange={u => updateExtra(t.key, { kpiUnit: u })} />
              {unit === 'duration' ? (
                <>
                  <label className="ds-extra-num">W<ClockInput value={t.warn} onCommit={mmss => updateExtra(t.key, { warn: parseClockToMinutes(mmss) })} /></label>
                  <label className="ds-extra-num">C<ClockInput value={t.crit} onCommit={mmss => updateExtra(t.key, { crit: parseClockToMinutes(mmss) })} /></label>
                  <label className="ds-extra-num">T<ClockInput value={t.targ} onCommit={mmss => updateExtra(t.key, { targ: parseClockToMinutes(mmss) })} /></label>
                </>
              ) : (
                <>
                  <label className="ds-extra-num">W<input type="number" value={t.warn} onChange={e => updateExtra(t.key, { warn: parseFloat(e.target.value) || 0 })} /></label>
                  <label className="ds-extra-num">C<input type="number" value={t.crit} onChange={e => updateExtra(t.key, { crit: parseFloat(e.target.value) || 0 })} /></label>
                  <label className="ds-extra-num">T<input type="number" value={t.targ} onChange={e => updateExtra(t.key, { targ: parseFloat(e.target.value) || 0 })} /></label>
                </>
              )}
              <button className={`ds-hib${t.higherIsBetter ? ' on' : ''}`} onClick={() => updateExtra(t.key, { higherIsBetter: !t.higherIsBetter })}
                title="Toggle whether high or low values are bad">{t.higherIsBetter ? 'Low = Bad' : 'High = Bad'}</button>
              <button className="ds-x" onClick={() => removeExtra(t.key)}><i className="bx bx-trash" /></button>
            </div>
            )
          })}
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
                  <thead><tr>{kpiCols.map(c => (
                    <th key={c} className="ds-th" onClick={() => handleKpiHeaderClick(c)}
                      style={{ cursor: 'pointer' }} title="Click to sort">
                      {c}
                      {kpiSortCol === c && <SortArrow dir={kpiSortDir} />}
                    </th>
                  ))}</tr></thead>
                  <tbody>
                    {sortedKpiPreview.map(({ row, i }, ri) => (
                      <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
                        {kpiCols.map(c => {
                          const hi = cellColor(row, c, i)
                          return (
                            <td key={c} className="ds-td"
                              title={String(row[c] ?? '')}
                              style={{ cursor: sharedPreviewClickable ? 'pointer' : 'default', background: hi ? `${hi}22` : undefined, outline: hi ? `2px solid ${hi}` : 'none' }}
                              onClick={() => sharedPreviewClickable && pickCell(row, c)}>
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
        {/* The title this table's agents get in Agent Status — the same job an
            Additional Agent Source's name box does for that source. Blank keeps
            the raw table name (the placeholder shows what that would be). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span className="ds-mini-label">Name</span>
          <input className="ds-group-name" aria-label="Agent data source name"
            value={localDs.agentTableLabel || ''}
            placeholder={localDs.agentTable || 'Name shown in Agent Status (e.g. Agents on Ready)'}
            onChange={e => setField('agentTableLabel', e.target.value)} />
        </div>
        <p className="ds-hint" style={{ marginTop: -4 }}>
          The title shown above these agents in <strong>Agent Status</strong> (and in Breach / Anomalies) when there is
          more than one group. Leave blank to use the table name.
        </p>
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
        <p className="ds-hint">
          <strong>Click a slot</strong>, then click a column header in the preview to map it. Click{' '}
          <i className="bx bx-plus" /> to add a custom column beyond Agent/Status/Duration.
        </p>
        <div className="ds-slot-grid">
          {AGENT_SLOTS.map(s => {
            const isDuration = s.key === 'agentDurationCol'
            return <DsSlotCard key={s.key} slotKey={s.key} hint={s.hint}
              label={isDuration ? (localDs.agentDurationLabel || s.label) : s.label}
              editableLabel={isDuration || undefined}
              onLabelChange={isDuration ? (l => setField('agentDurationLabel', l)) : undefined}
              durationMode={isDuration ? (localDs.agentDurationStatic ? 'static' : 'running') : undefined}
              onToggleDurationMode={isDuration ? toggleAgentDurationStatic : undefined}
              staticThreshold={isDuration ? localDs.agentDurationStaticThreshold : undefined}
              onStaticThresholdChange={isDuration ? updateAgentDurationStaticThreshold : undefined}
              onClearStaticThreshold={isDuration ? clearAgentDurationStaticThreshold : undefined}
              isActive={activeAgentSlot === s.key} value={(localDs as any)[s.key] || ''}
              onToggle={k => setActiveAgentSlot(cur => cur === k ? null : k)}
              onClear={k => setField(k, '')} />
          })}
          {localDs.agentExtraCols.map((c, i) => {
            const slotKey = EXTRA_AGENT_COL_PREFIX + c.key
            const durSlotKey = EXTRA_AGENT_DURATION_COL_PREFIX + c.key
            const metSlotKey = EXTRA_AGENT_METRIC_COL_PREFIX + c.key
            const hasBreachTrigger = !!(c.breachText || '').trim()
            return <React.Fragment key={slotKey}>
              <DsSlotCard slotKey={slotKey} label={c.label} hint="Custom column — mapped from the legacy table"
                color={extraAgentColColor(i)} editableLabel onLabelChange={l => renameAgentExtraCol(c.key, l)} onRemove={() => removeAgentExtraCol(c.key)}
                breachText={c.breachText} onBreachTextChange={v => setAgentExtraColBreachText(c.key, v)}
                breachSeverity={c.breachSeverity} onBreachSeverityToggle={() => toggleAgentExtraColSeverity(c.key)}
                isActive={activeAgentSlot === slotKey} value={localDs.agentExtraColsMap[c.key] || ''}
                onToggle={k => setActiveAgentSlot(cur => cur === k ? null : k)}
                onClear={() => setLocalDs(prev => { const m = { ...prev.agentExtraColsMap }; delete m[c.key]; return { ...prev, agentExtraColsMap: m } })} />
              {hasBreachTrigger && (
                <DsSlotCard slotKey={durSlotKey} label={`${c.label} Duration`}
                  hint="Optional — maps a SEPARATE column holding a duration (e.g. how long an agent has been in this state). When mapped, the Breach table shows THIS as the Value instead of just repeating the trigger text."
                  color={extraAgentColColor(i)}
                  isActive={activeAgentSlot === durSlotKey} value={localDs.agentExtraDurationColsMap?.[c.key] || ''}
                  onToggle={k => setActiveAgentSlot(cur => cur === k ? null : k)}
                  onClear={() => setLocalDs(prev => { const m = { ...(prev.agentExtraDurationColsMap || {}) }; delete m[c.key]; return { ...prev, agentExtraDurationColsMap: m } })} />
              )}
              {hasBreachTrigger && (
                <DsSlotCard slotKey={metSlotKey} label={`${c.label} Metric`}
                  hint="Optional — maps a SEPARATE column (e.g. the account's status column) whose per-agent value replaces this column's label in the Breach table's Metric — e.g. shows &quot;Away&quot; instead of always &quot;Adherence&quot;."
                  color={extraAgentColColor(i)}
                  isActive={activeAgentSlot === metSlotKey} value={localDs.agentExtraMetricColsMap?.[c.key] || ''}
                  onToggle={k => setActiveAgentSlot(cur => cur === k ? null : k)}
                  onClear={() => setLocalDs(prev => { const m = { ...(prev.agentExtraMetricColsMap || {}) }; delete m[c.key]; return { ...prev, agentExtraMetricColsMap: m } })} />
              )}
            </React.Fragment>
          })}
          <AddSlotCard onClick={addAgentExtraCol} />
        </div>
        {activeAgentSlot && (
          <div className="ds-active-bar">
            <i className="bx bx-crosshair" style={{ fontSize: 16 }} />
            <strong>{activeAgentColSlotLabel(activeAgentSlot, AGENT_SLOTS, localDs.agentExtraCols)}</strong> is active — click a column header below
          </div>
        )}
        {localDs.agentTable && (
          <div className="ds-preview">
            {loadingAgt ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading preview...</div>
            ) : (
              <DsPreviewTable rows={agtPreview} hasActiveSlot={!!activeAgentSlot} onMap={mapAgentCol}
                mappedCols={{
                  ...AGENT_SLOTS.reduce((acc, s) => { const v = (localDs as any)[s.key]; if (v) acc[v] = SLOT_COLORS[s.key] || '#888'; return acc }, {} as Record<string, string>),
                  ...localDs.agentExtraCols.reduce((acc, c, i) => { const v = localDs.agentExtraColsMap[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
                  ...localDs.agentExtraCols.reduce((acc, c, i) => { const v = localDs.agentExtraDurationColsMap?.[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
                  ...localDs.agentExtraCols.reduce((acc, c, i) => { const v = localDs.agentExtraMetricColsMap?.[c.key]; if (v) acc[v] = extraAgentColColor(i); return acc }, {} as Record<string, string>),
                }} />
            )}
          </div>
        )}
        {/* Which of these columns the Breach / Anomalies tables show is picked
            with the gear on those tables (components/BreachColumnsModal.tsx). */}
        <p className="ds-hint" style={{ marginTop: 14 }}>
          <i className="bx bx-cog" style={{ verticalAlign: -2 }} /> To show any of these columns next to
          each breach, use the gear on the <strong>Breach / Anomalies</strong> table (Dashboard page or
          Overview card).
        </p>
      </div>

      {/* Multiple agent sources — either several physical tables, or one
          table already split by a team/queue column (groupByCol). When any
          source is added here, it's used INSTEAD of the single table above. */}
      <div className="ds-section">
        <div className="ds-section-title">ADDITIONAL AGENT SOURCES</div>
        <p className="ds-hint">
          Use this when agent status is split across <strong>multiple tables</strong> (add one source
          per table), or when one table already has a column that separates teams/queues (add one
          source and set its <strong>Group by col</strong>). Anything added here shows up
          <strong> in addition to</strong> the single table above, not instead of it — the dashboard's
          Agent Status list combines all of them, grouped by label or by Group by col.
        </p>
        {localDs.agentSources.map(source => (
          <AgentSourceCard key={source.id} source={source} tables={tables} supaUrl={supaUrl} supaKey={supaKey}
            extraCols={localDs.agentExtraCols}
            onAddExtraCol={addAgentExtraCol} onRenameExtraCol={renameAgentExtraCol} onRemoveExtraCol={removeAgentExtraCol}
            onSetExtraColBreachText={setAgentExtraColBreachText} onToggleExtraColSeverity={toggleAgentExtraColSeverity}
            onChange={patch => updateAgentSource(source.id, patch)} onRemove={() => removeAgentSource(source.id)} />
        ))}
        <button className="ds-add-btn" onClick={addAgentSource}><i className="bx bx-plus" /> Add Agent Source</button>
      </div>
    </div>
  )
}


// ── Zoho lookup field combobox — pick from scanned options or type new text ──
// Backed by wfm_zoho_field_options (lib/zohoFieldScan.ts's daily/on-demand
// scan). Typing something that exactly matches a known option's label stores
// its Zoho ID (most reliable write); anything else is kept as plain typed
// text (Zoho resolves it by display value at write time — see CLAUDE.md).
function ZohoLookupField({ label, hint, fieldName, value, onChange, refreshKey, parentId }: {
  label:     string
  hint:      string
  fieldName: 'Category' | 'Sub_Categories' | 'x_Account' | 'Site'
  value:     ZohoLookupChoice
  onChange:  (v: ZohoLookupChoice) => void
  refreshKey: number   // bumped after a successful field scan to force a re-fetch without closing the modal
  // Sub_Categories only — the currently-selected Category's Zoho ID. When
  // set, suggestions are narrowed to just the sub-categories the scan linked
  // to that Category (see lib/zohoFieldScan.ts); ignored for every other
  // fieldName.
  parentId?: string
}) {
  const [options, setOptions] = useState<ZohoFieldOption[]>([])
  useEffect(() => {
    let cancelled = false
    loadZohoFieldOptions(fieldName).then(opts => { if (!cancelled) setOptions(opts) })
    return () => { cancelled = true }
  }, [fieldName, refreshKey])

  // Only cascade when a Category is actually picked from the list (has an
  // ID) — a blank or free-typed Category can't be matched to anything, so
  // fall back to the full list rather than filtering everything out.
  const cascading = fieldName === 'Sub_Categories' && !!parentId
  const visibleOptions = cascading ? options.filter(o => o.parentId === parentId) : options

  const currentText = value.id ? (options.find(o => o.id === value.id)?.label ?? '') : (value.text || '')
  const datalistId = `zoho-lookup-${fieldName}`

  const handleChange = (typed: string) => {
    const match = visibleOptions.find(o => o.label === typed)
    onChange(match ? { id: match.id, text: '' } : { id: '', text: typed })
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="sm-metric">{label}</div>
      <div className="sm-metric-sub" style={{ marginBottom: 6 }}>{hint}</div>
      <input type="text" className="sm-input" style={{ width: '100%', textAlign: 'left' }}
        list={datalistId} value={currentText}
        placeholder="Pick a suggestion or type a new value"
        onChange={e => handleChange(e.target.value)} />
      <datalist id={datalistId}>
        {visibleOptions.map(o => <option key={o.id} value={o.label} />)}
      </datalist>
      {fieldName === 'Sub_Categories' && !cascading && options.some(o => o.parentId) && (
        <div className="sm-metric-sub" style={{ marginTop: 4 }}>Pick a Category above to narrow this list.</div>
      )}
    </div>
  )
}

// ── Zoho Breaks & Aux — per account (Settings → Zoho Integrations) ──────────
// Edits DataSourceConfig.zohoAux (saved with everything else by Save Changes).
// The pull itself and the matching are lib/zohoAux.ts; the rules are
// lib/zohoAuxShared.ts. "Pull now" runs on the SAVED settings, server-side.
function ZohoAuxSection({ accountId, value, onChange }: {
  accountId: string
  value: ZohoAuxConfig | undefined
  onChange: (v: ZohoAuxConfig) => void
}) {
  const cfg: ZohoAuxConfig = value ?? { enabled: false }
  const set = (patch: Partial<ZohoAuxConfig>) => onChange({ ...cfg, ...patch })
  const [status, setStatus] = useState<{ pullMinutes?: number; lastPull?: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[] | null>(null)

  const loadStatus = useCallback(() => {
    fetch('/api/zoho/aux-status').then(r => r.json()).then(d => setStatus(d && !d.error ? d : {})).catch(() => setStatus({}))
  }, [])
  useEffect(() => { loadStatus() }, [loadStatus])

  const pullNow = async () => {
    setBusy(true); setLog(null)
    try {
      const res = await fetch('/api/zoho/aux-sync-now', { method: 'POST' })
      const data = await res.json()
      setLog(data.log ?? [data.error || `HTTP ${res.status}`])
      loadStatus()
    } catch (e: any) {
      setLog([`Request failed: ${e.message}`])
    }
    setBusy(false)
  }

  const lastPull = status?.lastPull ? new Date(status.lastPull).toLocaleTimeString() : 'not pulled yet today'
  const off = !cfg.enabled

  return (
    <>
      <div className="sm-section-title" style={{ marginTop: 20 }}>ZOHO BREAKS &amp; AUX — {accountId}</div>
      <p className="sm-desc" style={{ marginBottom: 10 }}>
        Adds a <strong>Zoho Breaks &amp; Aux</strong> section to this account&apos;s Agent Status: every
        agent who is on a Zoho break or aux right now (from the ECE Time Tracker break logs), with how long
        they&apos;ve been on it. Each Zoho type — 15 Minute Break, 1 Hour Lunch, Chat, Meeting, … — shows up
        in <strong>Status Durations</strong> once it&apos;s been seen, so it can have its own thresholds; a
        break that runs too long then appears in Breach / Anomalies like any other status.
      </p>
      <table className="sm-table">
        <tbody>
          <tr>
            <td><div className="sm-metric">Show Zoho breaks &amp; aux for this account</div><div className="sm-metric-sub">Off by default — nothing is fetched from Zoho for an account until this is on</div></td>
            <td style={{ textAlign: 'center' }}>
              <input type="checkbox" aria-label="Show Zoho breaks and aux" checked={!!cfg.enabled}
                onChange={() => set({ enabled: !cfg.enabled })} />
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.5 : 1 }}>
            <td><div className="sm-metric">Include breaks &amp; lunch</div><div className="sm-metric-sub">15 / 10 / 30 Minute Break, 1 Hour Lunch, …</div></td>
            <td style={{ textAlign: 'center' }}>
              <input type="checkbox" aria-label="Include breaks and lunch" disabled={off} checked={includeBreaksOf(cfg)}
                onChange={() => set({ includeBreaks: !includeBreaksOf(cfg) })} />
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.5 : 1 }}>
            <td><div className="sm-metric">Include other aux</div><div className="sm-metric-sub">Chat, Email, Meeting, Training, Coaching, Back-Office, Lactation, …</div></td>
            <td style={{ textAlign: 'center' }}>
              <input type="checkbox" aria-label="Include other aux" disabled={off} checked={includeAuxOf(cfg)}
                onChange={() => set({ includeAux: !includeAuxOf(cfg) })} />
            </td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 12, opacity: off ? 0.5 : 1 }}>
        <div className="sm-metric">Extra Zoho names (optional)</div>
        <div className="sm-metric-sub" style={{ marginBottom: 6 }}>
          Agents are matched <strong>by name</strong>: an agent counts for this account when the name in this
          account&apos;s own agent tables is their Zoho Employee name (capitals and extra spaces don&apos;t matter).
          Add, one per line, anyone who isn&apos;t in those tables or whose Zoho name is spelled differently.
        </div>
        <textarea className="sm-input" aria-label="Extra Zoho names" disabled={off} rows={3}
          style={{ width: '100%', textAlign: 'left', resize: 'vertical', fontFamily: 'inherit' }}
          placeholder={'Jane Doe\nJuan Dela Cruz'}
          value={cfg.extraNames ?? ''} onChange={e => set({ extraNames: e.target.value })} />
      </div>

      <p className="sm-desc" style={{ marginTop: 10, marginBottom: 10 }}>
        Zoho is pulled for the whole organisation every {status?.pullMinutes ?? 5} min while any account has
        this on (last pull today: <strong>{status ? lastPull : '…'}</strong>), so a break that just started or
        ended can take that long to show. Changes here apply after <strong>Save Changes</strong> — and
        &quot;Pull now&quot; uses the saved settings, so save first.
      </p>
      <button type="button" className="acc-btn acc-btn-cfg" disabled={busy}
        style={{ fontSize: 13, padding: '9px 16px' }} onClick={pullNow}>
        <i className={`bx ${busy ? 'bx-loader-alt bx-spin' : 'bx-download'}`} style={{ marginRight: 6 }} />
        {busy ? 'Pulling from Zoho...' : 'Pull Zoho breaks & aux now'}
      </button>
      {log && (
        <pre style={{
          marginTop: 12, padding: 12, maxHeight: 220, overflowY: 'auto',
          background: 'var(--bg-body,#f0f2f1)', border: '1px solid var(--border,#e1e6e4)',
          borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
          color: 'var(--text-main)',
        }}>
          {log.join('\n')}
        </pre>
      )}
    </>
  )
}

// ── Two independent RTA Logs Reporting toggles for one KPI threshold — NOT
// mutually exclusive, per the user (2026-10-14): both can be on at once, so
// a KPI reports at least every 60 minutes AND additionally whenever it
// changes while breaching. Shared by both the KPI Thresholds tables below
// (the generic shared table and each independent-tiles group's own table).
function RtaReportFlagsCell({ heartbeat, breachChange, disabled, onToggleHeartbeat, onToggleBreachChange }: {
  heartbeat: boolean; breachChange: boolean; disabled: boolean
  onToggleHeartbeat: () => void; onToggleBreachChange: () => void
}) {
  const disabledTitle = disabled ? 'Enable Workforce RTA Logs Reporting (Zoho Integrations tab) to use this' : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, whiteSpace: 'nowrap' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={disabledTitle}>
        <span className="sm-toggle">
          <input type="checkbox" checked={heartbeat} disabled={disabled} onChange={onToggleHeartbeat} />
          <span className="sm-toggle-track" />
        </span>
        <span style={{ opacity: disabled ? 0.5 : 1 }}>Every 60 min</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={disabledTitle}>
        <span className="sm-toggle">
          <input type="checkbox" checked={breachChange} disabled={disabled} onChange={onToggleBreachChange} />
          <span className="sm-toggle-track" />
        </span>
        <span style={{ opacity: disabled ? 0.5 : 1 }}>On breach, value changes</span>
      </label>
    </div>
  )
}

// ── Main Settings Content ─────────────────────────────────────────────────────
function SettingsContent({ accountId, accounts, kpiThresholds, statusThresholds, dataSource, cliqChannel, cliqGlobalSettings, wfLogsEnabled, rtaLogsEnabled, rtaSites, rtaAccountName, rtaAiCategorizationEnabled, rtaReportKpi, rtaReportAgentStatus, zohoLookups, alarmSound, knownStatuses, onSave, onSaveCliqGlobal, onAccountsChange, onConfigureAccount, onClose, tab, setTab }: Props & OpenTab) {
  const { profile: me } = useAuth()
  const canManageAccounts = can.manageAccounts(me.role)
  const canManageUsers    = can.manageUsers(me.role)

  const [kpi, setKpi]   = useState<Thresholds>(JSON.parse(JSON.stringify(kpiThresholds)))
  const [stat, setStat] = useState<StatusThresholds>(JSON.parse(JSON.stringify(statusThresholds)))
  const [ds, setDs]     = useState<DataSourceConfig>(JSON.parse(JSON.stringify(dataSource)))
  const [cliqChan, setCliqChan]     = useState(cliqChannel)
  const [cliqGlobal, setCliqGlobal] = useState<CliqGlobalSettings>(JSON.parse(JSON.stringify(cliqGlobalSettings)))
  // Status Durations search — see statusMatches() below.
  const [statusFilter, setStatusFilter] = useState('')
  const [statusConfiguredOnly, setStatusConfiguredOnly] = useState(false)
  const [cliqScanning, setCliqScanning] = useState(false)
  const [cliqScanLog, setCliqScanLog]   = useState<string[] | null>(null)
  const [wfLogsOn, setWfLogsOn]         = useState(wfLogsEnabled)
  const [rtaLogsOn, setRtaLogsOn]       = useState(rtaLogsEnabled)
  const [rtaSitesOn, setRtaSitesOn]     = useState<string[]>(rtaSites)
  const [rtaAcctName, setRtaAcctName]   = useState(rtaAccountName)
  const [rtaAiCatOn, setRtaAiCatOn]     = useState(rtaAiCategorizationEnabled)
  const [rtaReportKpiOn, setRtaReportKpiOn]             = useState(rtaReportKpi)
  const [rtaReportAgentStatusOn, setRtaReportAgentStatusOn] = useState(rtaReportAgentStatus)
  // Confirmation gate for turning Workforce RTA Logs Reporting ON —
  // per the user (2026-09-28), an account can accidentally start sending
  // real breach reports before its thresholds are finalized, so checking
  // this box (OFF → ON only; unchecking needs no confirmation) prompts an
  // "are you sure?" first instead of taking effect immediately.
  const [rtaEnableConfirmOpen, setRtaEnableConfirmOpen] = useState(false)
  const [geminiKeys, setGeminiKeys]     = useState<GeminiKeyMasked[] | null>(null)
  const [geminiKeyInput, setGeminiKeyInput] = useState('')
  const [geminiLabelInput, setGeminiLabelInput] = useState('')
  const [geminiBusy, setGeminiBusy]     = useState(false)
  const [geminiError, setGeminiError]   = useState<string | null>(null)
  const [geminiModels, setGeminiModelsState] = useState<string[] | null>(null)
  const [geminiModelInput, setGeminiModelInput] = useState('')
  const [geminiModelsBusy, setGeminiModelsBusy] = useState(false)
  const [zohoLu, setZohoLu]             = useState<ZohoLookups>(JSON.parse(JSON.stringify(zohoLookups)))
  const [alarmSnd, setAlarmSnd]         = useState(alarmSound || 'none')
  const [fieldScanning, setFieldScanning] = useState(false)
  const [fieldScanLog, setFieldScanLog]   = useState<string[] | null>(null)
  const [fieldOptionsRefresh, setFieldOptionsRefresh] = useState(0)
  const [rtaTesting, setRtaTesting]   = useState(false)
  const [rtaTestOkAt, setRtaTestOkAt] = useState<string | null>(null)
  const [rtaTestAuthorizedAs, setRtaTestAuthorizedAs] = useState<{ email: string; displayName: string } | null>(null)
  // A pre-submission failure (bad request, no breaches to classify, every
  // Gemini model/key combination failed, etc.) — nothing was sent to Zoho.
  const [rtaTestTopError, setRtaTestTopError] = useState<string | null>(null)
  // One entry per Zoho submission actually attempted — AI Categorization ON
  // can mean MORE THAN ONE (one per group, same as the real scan); OFF is
  // always exactly one. `category`/`subCategory` are only set in AI mode.
  const [rtaTestSubmissions, setRtaTestSubmissions] = useState<Array<{
    category?: string; subCategory?: string
    ok: boolean; status?: number; requestUrl?: string; requestBody?: any; responseBody?: any
  }> | null>(null)

  // ── Force an immediate Cliq scan (bypasses cooldown, not staleness) ─────────
  const handleForceScan = async () => {
    setCliqScanning(true)
    setCliqScanLog(null)
    try {
      const res  = await fetch('/api/cliq/force-scan', { method: 'POST' })
      const data = await res.json()
      setCliqScanLog(data.log ?? [data.error || 'Unknown error'])
    } catch (e: any) {
      setCliqScanLog([`Request failed: ${e.message}`])
    }
    setCliqScanning(false)
  }

  // ── Force an immediate scan of Zoho Workforce Logs for Category/Sub
  // Categories/x_Account/Site option values (populates the comboboxes below) ─
  const handleForceFieldScan = async () => {
    setFieldScanning(true)
    setFieldScanLog(null)
    try {
      const res  = await fetch('/api/zoho/force-scan-fields', { method: 'POST' })
      const data = await res.json()
      setFieldScanLog(data.log ?? [data.error || 'Unknown error'])
      // Re-fetch every combobox's options immediately — without this, a scan
      // triggered from an already-open modal writes fresh data to Supabase
      // but the four ZohoLookupFields below (which only fetch once on mount)
      // never know to reload it, so they'd stay looking empty/stale until
      // the modal was closed and reopened.
      setFieldOptionsRefresh(v => v + 1)
    } catch (e: any) {
      setFieldScanLog([`Request failed: ${e.message}`])
    }
    setFieldScanning(false)
  }

  // ── Gemini API key pool (global, shared by every account's AI
  // Categorization toggle) — goes through app/api/gemini/keys since
  // wfm_gemini_keys has RLS locked down the same way as wfm_cliq_oauth; the
  // anon client this modal otherwise uses can't reach it directly. ──────────
  const loadGeminiKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/gemini/keys')
      const data = await res.json()
      setGeminiKeys(data.keys ?? [])
    } catch {
      setGeminiKeys([])
    }
  }, [])

  useEffect(() => { loadGeminiKeys() }, [loadGeminiKeys])

  const handleAddGeminiKey = async () => {
    if (!geminiKeyInput.trim()) return
    setGeminiBusy(true)
    setGeminiError(null)
    try {
      const res = await fetch('/api/gemini/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: geminiKeyInput.trim(), label: geminiLabelInput.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
      setGeminiKeys(data.keys ?? [])
      setGeminiKeyInput('')
      setGeminiLabelInput('')
    } catch (e: any) {
      setGeminiError(e.message)
    }
    setGeminiBusy(false)
  }

  const handleDeleteGeminiKey = async (id: string) => {
    setGeminiBusy(true)
    setGeminiError(null)
    try {
      const res = await fetch(`/api/gemini/keys?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
      setGeminiKeys(data.keys ?? [])
    } catch (e: any) {
      setGeminiError(e.message)
    }
    setGeminiBusy(false)
  }

  // ── Gemini MODEL list (global) — model names aren't secrets, so this goes
  // straight through the anon client (lib/geminiModels.ts), no service-role
  // route needed, unlike the API keys above. Tried in the SAME order/on-error
  // rotation pattern as the keys — see lib/geminiClassifier.ts. ─────────────
  useEffect(() => { loadGeminiModels().then(setGeminiModelsState) }, [])

  const handleAddGeminiModel = async () => {
    const trimmed = geminiModelInput.trim()
    if (!trimmed || !geminiModels || geminiModels.includes(trimmed)) { setGeminiModelInput(''); return }
    setGeminiModelsBusy(true)
    const updated = [...geminiModels, trimmed]
    if (await saveGeminiModels(updated)) { setGeminiModelsState(updated); setGeminiModelInput('') }
    setGeminiModelsBusy(false)
  }

  const handleRemoveGeminiModel = async (model: string) => {
    if (!geminiModels) return
    setGeminiModelsBusy(true)
    const updated = geminiModels.filter(m => m !== model)
    if (await saveGeminiModels(updated)) setGeminiModelsState(updated)
    setGeminiModelsBusy(false)
  }

  // ── Test the Workforce RTA Logs payload against Zoho for real (no sandbox
  // exists for this intake) — surfaces success inline, and a full request/
  // response breakdown in a popup on any failed submission ─────────────────
  // Deliberately does NOT persist anything — Test is test-only, by design
  // (per the user, 2026-09-25); only the "Save Changes" button writes to
  // Supabase. A confirmed-working test using typed-but-unsaved values won't
  // survive a refresh until Save Changes is clicked — that's intentional.
  //
  // When AI Categorization is on, this sends this account's REAL current
  // breaches through the same classifier the live scan uses, and submits
  // ONE test per group it returns — per the user (2026-09-28), the button
  // should exercise the exact same "many different Workforce RTA Logs when
  // there's more than one categorization" behavior the real scan has.
  const handleTestRtaLog = async () => {
    setRtaTesting(true)
    setRtaTestOkAt(null)
    setRtaTestAuthorizedAs(null)
    setRtaTestTopError(null)
    setRtaTestSubmissions(null)
    try {
      const res  = await fetch('/api/zoho/test-rta-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId, sites: rtaSitesOn, zohoAccountName: rtaAcctName || undefined,
          aiEnabled: rtaAiCatOn, ds, kpiThresholds: kpi, statusThresholds: stat,
          reportAgentStatus: rtaReportAgentStatusOn,
        }),
      })
      const data = await res.json()
      setRtaTestAuthorizedAs(data.authorizedAs ?? null)
      if (!res.ok || data.error) {
        setRtaTestTopError(data.error || `Request failed (HTTP ${res.status})`)
      } else if (data.aiMode) {
        const subs = data.submissions ?? []
        setRtaTestSubmissions(subs)
        if (subs.length > 0 && subs.every((s: any) => s.ok)) setRtaTestOkAt(new Date().toLocaleString())
      } else {
        setRtaTestSubmissions([{ ok: data.ok, status: data.status, requestUrl: data.requestUrl, requestBody: data.requestBody, responseBody: data.responseBody }])
        if (data.ok) setRtaTestOkAt(new Date().toLocaleString())
      }
    } catch (e: any) {
      setRtaTestTopError(`Request failed: ${e.message}`)
    }
    setRtaTesting(false)
  }

  // ── Dynamic status discovery ────────────────────────────────────────────────
  // Every CRM/account uses its own status vocabulary (Aircall's "Ringing" vs
  // ZenBusiness's "15 Minute Break"/"Working Contacts"/"Bathroom Break") — a
  // fixed hardcoded list can never cover all of them. Instead, query whatever
  // Agent Data Source(s) this account is actually configured with (same
  // tables the Dashboard's Agent Status list reads from) and show whichever
  // status strings genuinely show up, so the list is always right for this
  // specific account instead of a generic one-size-fits-all set.
  const statSupaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const statSupaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const [discoveredStatuses, setDiscoveredStatuses] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    async function discover() {
      const sources: { table: string; statusCol: string; accountCol: string }[] = []
      if (ds.agentTable && ds.agentStatusCol) {
        sources.push({ table: ds.agentTable, statusCol: ds.agentStatusCol, accountCol: ds.agentAccountCol || 'account_id' })
      }
      ;(ds.agentSources || []).forEach(s => {
        if (s.table && s.statusCol) sources.push({ table: s.table, statusCol: s.statusCol, accountCol: s.accountCol || 'account_id' })
      })
      if (sources.length === 0) { if (!cancelled) setDiscoveredStatuses([]); return }

      const results = await Promise.all(sources.map(async src => {
        try {
          const url = `${statSupaUrl}/rest/v1/${src.table}?select=${encodeURIComponent(src.statusCol)}&${encodeURIComponent(src.accountCol)}=eq.${encodeURIComponent(accountId)}&limit=1000`
          const res = await fetch(url, { headers: { apikey: statSupaKey, Authorization: `Bearer ${statSupaKey}` } })
          if (!res.ok) return []
          const rows = await res.json()
          // Keep the EMPTY status instead of dropping it (per the user,
          // 2026-10-17). An agent row whose status column is blank still
          // renders in the Agent Status table — as the "—" placeholder — and
          // the exclude lookups key off String(a._status ?? ''), i.e. ''
          // (components/Dashboard.tsx, lib/breaches.ts). So '' is a
          // perfectly valid, excludable status; .filter(Boolean) was the
          // only reason it never appeared here to be ticked, leaving those
          // rows impossible to hide. Flex hit this: its agent source maps to
          // unassigned Zendesk tickets, whose status column is literally "".
          return Array.isArray(rows) ? rows.map((r: any) => String(r[src.statusCol] ?? '').trim()) : []
        } catch { return [] }
      }))
      if (!cancelled) setDiscoveredStatuses(Array.from(new Set(results.flat())).sort((a, b) => a.localeCompare(b)))
    }
    discover()
    return () => { cancelled = true }
  }, [ds.agentTable, ds.agentAccountCol, ds.agentStatusCol, JSON.stringify(ds.agentSources), accountId, statSupaUrl, statSupaKey])

  // Split into two sections (per the user, 2026-10-15): a status this live
  // scan actually found just now vs. one that's ONLY known from history —
  // already-configured thresholds, or lib/settings.ts's knownStatuses (every
  // status value Dashboard.tsx has EVER seen an agent in for this account,
  // accumulated automatically, never shrinks — see sql/known_statuses.sql).
  // Without that accumulated history, a status nobody happens to be in RIGHT
  // NOW (e.g. a rarely-used one) would silently vanish from this tab and
  // become unconfigurable the moment it stopped being live. MINUS the old
  // generic default keys unless they're also actually live/known for this
  // account — otherwise every account would always show the same irrelevant
  // legacy list underneath the real ones.
  const legacyDefaultKeys = new Set(Object.keys(DEFAULT_STATUS_THRESHOLDS))
  const customConfiguredKeys = Object.keys(stat).filter(k => !legacyDefaultKeys.has(k))
  const liveSet = new Set(discoveredStatuses)
  const currentStatusRows = Array.from(new Set(discoveredStatuses)).sort((a, b) => a.localeCompare(b))
  const pastStatusRows = Array.from(new Set([...knownStatuses, ...customConfiguredKeys]))
    .filter(k => !liveSet.has(k))
    .sort((a, b) => a.localeCompare(b))
  // Kept for "Reset to Defaults" (resets every row currently shown, in
  // either section) — not rendered directly.
  const statusRows = Array.from(new Set([...currentStatusRows, ...pastStatusRows]))

  // ── Status search / filter ────────────────────────────────────────────────
  // Per the user (2026-10-17): some accounts accumulate hundreds of statuses
  // — Flex's agent "status" column is carrying Zendesk ticket SUBJECTS
  // ("Conversation with Adam Hill", "Adding Progressive", ...) — so the one
  // status you actually want to configure is unreachable by scrolling.
  // `isConfigured` is what makes this genuinely useful on an account like
  // that: it collapses hundreds of rows down to the handful someone has
  // deliberately set up.
  const isConfigured = (k: string) => {
    const t = stat[k]
    if (!t) return false
    return (t.warn < 999) || (t.crit < 999) || !!t.breachText || !!t.excluded || !!t.sendToCliq
  }
  const statusMatches = (k: string) => {
    if (statusConfiguredOnly && !isConfigured(k)) return false
    const q = statusFilter.trim().toLowerCase()
    return !q || k.toLowerCase().includes(q)
  }
  const currentShown = currentStatusRows.filter(statusMatches)
  const pastShown    = pastStatusRows.filter(statusMatches)
  const statusFiltering = !!statusFilter.trim() || statusConfiguredOnly

  const updateKpi = (key: keyof Thresholds, field: string, rawVal: string) => {
    const value = field === 'direction' ? rawVal : (parseFloat(rawVal) || 0)
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }
  // AHT's warn/crit/targ are stored as plain minutes (same field, same unit,
  // just no longer forced to be a WHOLE minute — see formatMinutesAsClock/
  // parseClockToMinutes in lib/utils.ts) — this is the ONLY generic KPI
  // that's a duration rather than a percent/count, so it gets its own mm:ss
  // text input instead of updateKpi's plain numeric one.
  // Any of the 4 generic KPI rows can be set to kpiUnit:'duration' now (not
  // just AHT), so this needs to write to whichever key is currently showing
  // the ClockInput, not a hardcoded 'aht'.
  const updateKpiClock = (key: keyof Thresholds, field: 'warn' | 'crit' | 'targ', mmss: string) => {
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], [field]: parseClockToMinutes(mmss) } }))
  }
  const setKpiUnit = (key: keyof Thresholds, unit: KpiUnit) => {
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], kpiUnit: unit } }))
  }
  const toggleDirection = (key: keyof Thresholds) => {
    setKpi(prev => ({
      ...prev,
      [key]: { ...prev[key], direction: prev[key].direction === 'asc' ? 'desc' : 'asc' }
    }))
  }
  // Exclude a KPI from breach-tagging when its reported value is exactly 0 —
  // covers accounts whose CRM reports 0 because there's no volume to work on
  // that period, not because performance actually broke down.
  const toggleExcludeZero = (key: keyof Thresholds) => {
    setKpi(prev => ({
      ...prev,
      [key]: { ...prev[key], excludeZero: !prev[key].excludeZero }
    }))
  }
  const toggleKpiRtaFlag = (key: keyof Thresholds, flag: 'rtaReportHeartbeat' | 'rtaReportBreachChange') => {
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], [flag]: !prev[key][flag] } }))
  }
  const toggleKpiSendToCliq = (key: keyof Thresholds) => {
    setKpi(prev => ({ ...prev, [key]: { ...prev[key], sendToCliq: !prev[key].sendToCliq } }))
  }

  // ── Per-group independent tile thresholds (see GroupTile in lib/types.ts) —
  // a group that opted into "Independent tiles" on the Data Sources tab owns
  // its own warn/crit/targ/direction/excludeZero PER TILE, edited here on `ds`
  // directly rather than on the single shared `kpi` (Thresholds) object above.
  const updateGroupTile = (groupId: string, tileKey: string, patch: Partial<GroupTile>) => {
    setDs(prev => ({ ...prev, groups: prev.groups.map(g => g.id === groupId
      ? { ...g, tiles: (g.tiles || []).map(t => t.key === tileKey ? { ...t, ...patch } : t) } : g) }))
  }
  // Clearing a field (empty string) reverts that status to "N/A" (999 is the
  // existing "disabled, never breach" sentinel already used elsewhere in this
  // codebase, e.g. DEFAULT_STATUS_THRESHOLDS.Offline/Available) — so a newly
  // discovered status never breaches until someone deliberately sets real
  // numbers for it.
  const updateStat = (statusKey: string, field: 'warn' | 'crit', rawVal: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: {
        ...(prev[statusKey] ?? { warn: 999, crit: 999 }),
        [field]: rawVal.trim() === '' ? 999 : (parseInt(rawVal) || 0),
      }
    }))
  }

  // Excluded statuses (e.g. "Logged Out", "Offline") never breach AND are
  // hidden from the Agent Status table on the actual Dashboard — stronger
  // than just leaving warn/crit at N/A, which still leaves the agent visible.
  const toggleExcluded = (statusKey: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: {
        ...(prev[statusKey] ?? { warn: 999, crit: 999 }),
        excluded: !(prev[statusKey]?.excluded),
      }
    }))
  }
  const toggleSendToCliq = (statusKey: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: {
        ...(prev[statusKey] ?? { warn: 999, crit: 999 }),
        sendToCliq: !(prev[statusKey]?.sendToCliq),
      }
    }))
  }
  // Text-based breach trigger for statuses whose Duration is WORDING rather
  // than a clock ("No value", "—", "just now") — see StatusThresholds in
  // lib/utils.ts. Blank clears it back to minutes-only.
  const updateStatBreachText = (statusKey: string, text: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: {
        ...(prev[statusKey] ?? { warn: 999, crit: 999 }),
        breachText: text,
      }
    }))
  }
  const toggleStatBreachSeverity = (statusKey: string) => {
    setStat(prev => ({
      ...prev,
      [statusKey]: {
        ...(prev[statusKey] ?? { warn: 999, crit: 999 }),
        breachSeverity: (prev[statusKey]?.breachSeverity || 'critical') === 'critical' ? 'warning' : 'critical',
      }
    }))
  }

  const handleReset = () => {
    if (tab === 'kpi')    setKpi(JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)))
    if (tab === 'status') {
      // Reset means "back to N/A for everything currently shown" — not the
      // old generic list, which usually isn't even relevant for this account.
      const reset: StatusThresholds = {}
      statusRows.forEach(key => { reset[key] = { warn: 999, crit: 999 } })
      setStat(reset)
    }
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
            {/* Creating/removing accounts is global, so it stays with the
                super user. An RTA configures the accounts they already have. */}
            {canManageAccounts && (
              <button className={`sm-tab${tab === 'accounts' ? ' active' : ''}`} onClick={() => setTab('accounts')}>
                <i className="bx bx-buildings" /> Accounts
              </button>
            )}
            <button className={`sm-tab${tab === 'datasource' ? ' active' : ''}`} onClick={() => setTab('datasource')}>
              <i className="bx bx-data" /> Data Sources
            </button>
            <button className={`sm-tab${tab === 'kpi' ? ' active' : ''}`} onClick={() => setTab('kpi')}>
              <i className="bx bx-bar-chart-alt-2" /> KPI Thresholds
            </button>
            <button className={`sm-tab${tab === 'status' ? ' active' : ''}`} onClick={() => setTab('status')}>
              <i className="bx bx-user-clock" /> Status Durations
            </button>
            <button className={`sm-tab${tab === 'cliq' ? ' active' : ''}`} onClick={() => setTab('cliq')}>
              <i className="bx bx-bell" /> Zoho Integrations
            </button>
            {canManageUsers && (
              <button className={`sm-tab${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>
                <i className="bx bx-user" /> Users
              </button>
            )}
            {/* One alarm for every account — global, so super users only. */}
            {canManageAccounts && (
              <button className={`sm-tab${tab === 'alarm' ? ' active' : ''}`} onClick={() => setTab('alarm')}>
                <i className="bx bx-alarm" /> Alarm
              </button>
            )}
          </div>

          {/* Body */}
          <div className="sm-body">

            {tab === 'accounts' && canManageAccounts && (
              <AccountsTab
                accounts={accounts}
                onConfigure={id => { onConfigureAccount(id); setTab('datasource') }}
                onRefresh={onAccountsChange}
              />
            )}

            {tab === 'alarm' && canManageAccounts && <AlarmTab />}

            {tab === 'users' && canManageUsers && (
              <UsersTab accounts={accounts.map(a => ({ id: a.id, display_name: a.display_name || a.id }))} />
            )}

            {tab === 'datasource' && (
              <DataSourcesTab accountId={accountId} ds={ds} onChange={setDs} />
            )}

            {tab === 'kpi' && (
              <>
                <p className="sm-desc">
                  Set <strong>Warning</strong> and <strong>Critical</strong> thresholds for each KPI.
                  Use the <strong>Direction</strong> button to control whether high or low values trigger a breach.
                  Check <strong>Exclude 0</strong> for metrics where a reported value of 0 means there was
                  no volume to work (not an actual breach).
                </p>

                {/* Shared thresholds — apply to every group still using the
                    account-wide kpiLabels/extraTiles path (Data Sources tab).
                    Hidden once every group has switched to independent tiles,
                    since none of them read these values anymore. */}
                {ds.groups.some(g => !(g.tiles && g.tiles.length)) && (
                  <>
                    <div className="sm-section-title">
                      KPI BREACH THRESHOLDS{ds.groups.some(g => g.tiles && g.tiles.length) ? ' — SHARED' : ''}
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                    <table className="sm-table">
                      <thead>
                        <tr>
                          <th style={{ width: '18%' }}>Metric</th>
                          <th>Unit</th>
                          <th>Warning</th><th>Critical</th><th>Target</th><th>Direction</th><th>Exclude 0</th>
                          <th title="Controls whether (and how) this KPI reports to Zoho's Workforce RTA Logs">RTA Logs Reporting</th>
                          <th title="Whether a breach on THIS KPI is included in the Zoho Cliq channel message (independent of Workforce Logs/RTA Logs, which have their own scope settings)">Send to Cliq</th>
                        </tr>
                      </thead>
                      <tbody>
                        {KPI_ROWS.map(row => {
                          const th = kpi[row.key]
                          const isAsc = th.direction === 'asc'
                          const unit = th.kpiUnit ?? 'percent'
                          // Prefer this account's custom tile name (set on the Data
                          // Sources tab) over the generic default, so a renamed KPI
                          // (e.g. "AWAITING" → "Total Calls") shows the same name
                          // here instead of reverting to the hardcoded default.
                          const label = ds.kpiLabels?.[row.key] || row.label
                          const cliqDisabled = !(cliqGlobal.enabled && cliqChan)
                          return (
                            <tr key={row.key}>
                              <td>
                                <div className="sm-metric">{label}</div>
                                <div className="sm-metric-sub">{row.sublabel}</div>
                              </td>
                              <td>
                                <KpiUnitSelect value={unit} onChange={u => setKpiUnit(row.key, u)} />
                              </td>
                              {(['warn','crit','targ'] as const).map(f => (
                                <td key={f}>
                                  <div className="sm-input-cell">
                                    {unit === 'duration' ? (
                                      <ClockInput value={(th as any)[f]} onCommit={mmss => updateKpiClock(row.key, f, mmss)} />
                                    ) : (
                                      <input type="number" className="sm-input" value={(th as any)[f]} min={0}
                                        onChange={e => updateKpi(row.key, f, e.target.value)} />
                                    )}
                                    {unit === 'percent' && <span className="sm-unit">{kpiUnitSuffix(unit)}</span>}
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
                              <td style={{ textAlign: 'center' }}>
                                <input type="checkbox" checked={!!th.excludeZero} onChange={() => toggleExcludeZero(row.key)} />
                              </td>
                              <td>
                                <RtaReportFlagsCell
                                  heartbeat={!!th.rtaReportHeartbeat} breachChange={!!th.rtaReportBreachChange}
                                  disabled={!rtaLogsOn}
                                  onToggleHeartbeat={() => toggleKpiRtaFlag(row.key, 'rtaReportHeartbeat')}
                                  onToggleBreachChange={() => toggleKpiRtaFlag(row.key, 'rtaReportBreachChange')} />
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span className="sm-toggle" title={cliqDisabled ? 'Enable Cliq globally and set this account\'s channel (Zoho Integrations tab) to use this' : undefined}>
                                  <input type="checkbox" checked={!!th.sendToCliq} disabled={cliqDisabled}
                                    onChange={() => toggleKpiSendToCliq(row.key)} />
                                  <span className="sm-toggle-track" />
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    </div>
                    <div className="sm-note">
                      <i className="bx bx-info-circle" />
                      <span>For SLA: <strong>Low = Bad</strong>. For Queue, ASA, ABN%: <strong>High = Bad</strong>.</span>
                    </div>
                  </>
                )}

                {/* Independent-tiles groups — each group's own tiles get their
                    own thresholds, entirely separate from the shared table
                    above and from every other group. See GroupTile. */}
                {ds.groups.filter(g => g.tiles && g.tiles.length).map(group => (
                  <div key={group.id} style={{ marginTop: 22 }}>
                    <div className="sm-section-title">KPI BREACH THRESHOLDS — {group.name || 'Untitled group'}</div>
                    <div style={{ overflowX: 'auto' }}>
                    <table className="sm-table">
                      <thead>
                        <tr>
                          <th style={{ width: '18%' }}>Metric</th>
                          <th>Unit</th>
                          <th>Warning</th><th>Critical</th><th>Target</th><th>Direction</th><th>Exclude 0</th>
                          <th title="Controls whether (and how) this KPI reports to Zoho's Workforce RTA Logs">RTA Logs Reporting</th>
                          <th title="Whether a breach on THIS KPI is included in the Zoho Cliq channel message (independent of Workforce Logs/RTA Logs, which have their own scope settings)">Send to Cliq</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.tiles!.map(tile => {
                          const isAsc = tile.direction === 'asc'
                          const unit = tile.kpiUnit ?? 'percent'
                          const cliqDisabled = !(cliqGlobal.enabled && cliqChan)
                          return (
                            <tr key={tile.key}>
                              <td><div className="sm-metric">{tile.label}</div></td>
                              <td>
                                <KpiUnitSelect value={unit} onChange={u => updateGroupTile(group.id, tile.key, { kpiUnit: u })} />
                              </td>
                              {(['warn','crit','targ'] as const).map(f => (
                                <td key={f}>
                                  <div className="sm-input-cell">
                                    {unit === 'duration' ? (
                                      <ClockInput value={tile[f]} onCommit={mmss => updateGroupTile(group.id, tile.key, { [f]: parseClockToMinutes(mmss) })} />
                                    ) : (
                                      <input type="number" className="sm-input" value={tile[f]} min={0}
                                        onChange={e => updateGroupTile(group.id, tile.key, { [f]: parseFloat(e.target.value) || 0 })} />
                                    )}
                                    {unit === 'percent' && <span className="sm-unit">{kpiUnitSuffix(unit)}</span>}
                                  </div>
                                </td>
                              ))}
                              <td>
                                <button type="button" className={`sm-dir-btn${isAsc ? ' asc' : ' desc'}`}
                                  onClick={() => updateGroupTile(group.id, tile.key, { direction: isAsc ? 'desc' : 'asc' })}>
                                  <i className={`bx ${isAsc ? 'bx-trending-up' : 'bx-trending-down'}`} />
                                  <span>{isAsc ? 'High = Bad' : 'Low = Bad'}</span>
                                </button>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <input type="checkbox" checked={!!tile.excludeZero}
                                  onChange={() => updateGroupTile(group.id, tile.key, { excludeZero: !tile.excludeZero })} />
                              </td>
                              <td>
                                <RtaReportFlagsCell
                                  heartbeat={!!tile.rtaReportHeartbeat} breachChange={!!tile.rtaReportBreachChange}
                                  disabled={!rtaLogsOn}
                                  onToggleHeartbeat={() => updateGroupTile(group.id, tile.key, { rtaReportHeartbeat: !tile.rtaReportHeartbeat })}
                                  onToggleBreachChange={() => updateGroupTile(group.id, tile.key, { rtaReportBreachChange: !tile.rtaReportBreachChange })} />
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span className="sm-toggle" title={cliqDisabled ? 'Enable Cliq globally and set this account\'s channel (Zoho Integrations tab) to use this' : undefined}>
                                  <input type="checkbox" checked={!!tile.sendToCliq} disabled={cliqDisabled}
                                    onChange={() => updateGroupTile(group.id, tile.key, { sendToCliq: !tile.sendToCliq })} />
                                  <span className="sm-toggle-track" />
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === 'status' && (
              <>
                <p className="sm-desc">
                  Set how long (in <strong>minutes</strong>) an agent can stay in each status before a breach.
                  Check <strong>Exclude</strong> for statuses like "Logged Out" or "Offline" that shouldn't be
                  tracked at all — excluded statuses never breach and are hidden from the Agent Status table.
                  <strong> Send to Cliq</strong> controls ONLY the Zoho Cliq channel message — off by default for
                  every status, so pick which ones should actually page the channel (Workforce Logs/RTA Logs are
                  unaffected, they have their own scope settings on the Zoho Integrations tab).
                </p>
                {(() => {
                  // Shared row renderer for both sections below — identical
                  // columns/mutators regardless of which section a status is
                  // currently sorted into (it can move between them over
                  // time as agents enter/leave it).
                  const renderStatusRow = (key: string) => {
                    const th = stat[key] ?? { warn: 999, crit: 999 }
                    const excluded = !!th.excluded
                    const cliqDisabled = !(cliqGlobal.enabled && cliqChan)
                    return (
                      <tr key={key}>
                        <td>
                          {/* The empty status is a real, excludable status
                              (agents whose status column is blank render as
                              "—" in the Agent Status table). Labelled, not
                              shown as an empty cell, so it doesn't look like
                              a glitch. */}
                          <div className="sm-metric" style={key === '' ? { fontStyle: 'italic', color: 'var(--text-muted)' } : undefined}>
                            {key === '' ? '(blank — no status value)' : key}
                          </div>
                          {key === '' && (
                            <div className="sm-metric-sub">Agents whose status column is empty — shown as “—” on the dashboard</div>
                          )}
                        </td>
                        {(['warn','crit'] as const).map(f => (
                          <td key={f}>
                            <div className="sm-input-cell">
                              <input type="number" className="sm-input" min={0} disabled={excluded}
                                value={th[f] >= 999 ? '' : th[f]} placeholder="N/A"
                                onChange={e => updateStat(key, f, e.target.value)} />
                              <span className="sm-unit">min</span>
                            </div>
                          </td>
                        ))}
                        {/* Text trigger — for statuses whose Duration is
                            wording rather than a clock. Works alongside the
                            minute thresholds (leave those blank/N/A to match
                            on text alone). */}
                        <td>
                          <input type="text" className="sm-input" style={{ minWidth: 110 }} disabled={excluded}
                            placeholder="(none)" value={th.breachText ?? ''}
                            title={'Breach when this status\'s Duration CONTAINS this text (case-insensitive) — e.g. "No value". For durations reported as wording instead of a clock, which parse to 0 minutes and can never cross a minute threshold. Leave the minute boxes blank to match on text only.'}
                            onChange={e => updateStatBreachText(key, e.target.value)} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button type="button" className={`sm-dir-btn${(th.breachSeverity || 'critical') === 'critical' ? ' asc' : ' desc'}`}
                            disabled={excluded || !th.breachText}
                            style={{ opacity: th.breachText ? 1 : 0.4 }}
                            title="Severity for the text trigger"
                            onClick={() => toggleStatBreachSeverity(key)}>
                            <span>{(th.breachSeverity || 'critical') === 'critical' ? 'Critical' : 'Warning'}</span>
                          </button>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={excluded} onChange={() => toggleExcluded(key)} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="sm-toggle" title={cliqDisabled ? 'Enable Cliq globally and set this account\'s channel (Zoho Integrations tab) to use this' : undefined}>
                            <input type="checkbox" checked={!!th.sendToCliq} disabled={cliqDisabled || excluded}
                              onChange={() => toggleSendToCliq(key)} />
                            <span className="sm-toggle-track" />
                          </span>
                        </td>
                      </tr>
                    )
                  }
                  const statusTableHead = (
                    <thead>
                      <tr>
                        <th style={{ width: '22%' }}>Status</th><th>Warning (min)</th><th>Critical (min)</th>
                        <th title="Breach when this status's Duration CONTAINS this text (case-insensitive) — for durations reported as wording (&quot;No value&quot;, &quot;—&quot;, &quot;just now&quot;) that parse to 0 minutes and can never cross a minute threshold">Breach if text</th>
                        <th>Text severity</th><th>Exclude</th>
                        <th title="Whether a breach on THIS status is included in the Zoho Cliq channel message (independent of Workforce Logs/RTA Logs, which have their own scope settings)">Send to Cliq</th>
                      </tr>
                    </thead>
                  )
                  return (
                    <>
                      {/* Search — some accounts carry hundreds of statuses
                          (Flex's status column holds Zendesk ticket subjects),
                          making the one you want unreachable by scrolling. */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '4px 0 10px' }}>
                        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 200 }}>
                          <i className="bx bx-search" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14 }} />
                          <input type="text" className="sm-input" style={{ width: '100%', paddingLeft: 28 }}
                            placeholder={`Search ${statusRows.length} status${statusRows.length === 1 ? '' : 'es'}...`}
                            value={statusFilter} onChange={e => setStatusFilter(e.target.value)} />
                          {statusFilter && (
                            <i className="bx bx-x" title="Clear search"
                              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--text-muted)' }}
                              onClick={() => setStatusFilter('')} />
                          )}
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          title="Show only statuses with a threshold, text trigger, Exclude or Send to Cliq already set — the fastest way to find what you configured among hundreds of auto-discovered ones">
                          <input type="checkbox" checked={statusConfiguredOnly} onChange={() => setStatusConfiguredOnly(v => !v)} />
                          Configured only
                        </label>
                        {statusFiltering && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {currentShown.length + pastShown.length} of {statusRows.length} shown
                          </span>
                        )}
                      </div>

                      <div className="sm-section-title">CURRENTLY ACTIVE STATUSES</div>
                      <div style={{ overflowX: 'auto' }}>
                      <table className="sm-table">
                        {statusTableHead}
                        <tbody>
                          {currentShown.length === 0 ? (
                            <tr><td colSpan={7} style={{ padding: '20px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                              {currentStatusRows.length > 0
                                ? <>No live status matches the filter ({currentStatusRows.length} hidden).</>
                                : <>No agent statuses currently live — set up an Agent Data Source on the Data Sources tab first
                                   (or check back once the scraper has written some data).</>}
                            </td></tr>
                          ) : currentShown.map(renderStatusRow)}
                        </tbody>
                      </table>
                      </div>

                      <div className="sm-section-title" style={{ marginTop: 22 }}>PREVIOUSLY SEEN STATUSES</div>
                      <p className="sm-desc" style={{ marginBottom: 10 }}>
                        Statuses no agent is in RIGHT NOW, but that this account has been seen in before — kept here (and
                        fully configurable) instead of disappearing just because nobody happens to be in them this moment.
                      </p>
                      <div style={{ overflowX: 'auto' }}>
                      <table className="sm-table">
                        {statusTableHead}
                        <tbody>
                          {pastShown.length === 0 ? (
                            <tr><td colSpan={7} style={{ padding: '20px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                              {pastStatusRows.length > 0
                                ? <>No previously-seen status matches the filter ({pastStatusRows.length} hidden).</>
                                : <>Nothing here yet — every status ever seen for this account is currently active above.</>}
                            </td></tr>
                          ) : pastShown.map(renderStatusRow)}
                        </tbody>
                      </table>
                      </div>
                    </>
                  )
                })()}

                <div className="sm-section-title" style={{ marginTop: 22 }}>
                  RTA LOGS REPORTING — ALL STATUSES
                </div>
                <p className="sm-desc">
                  Reports every currently-breaching agent across every status above in ONE bulk
                  Workforce RTA Logs submission — this is a GROUP-level setting, not per status.
                  Only applies to actual breaches/anomalies (an agent currently over a
                  Warning/Critical duration), same as everything else on this page.
                </p>
                <div style={{ display: 'flex', gap: 24 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    title={!rtaLogsOn ? 'Enable Workforce RTA Logs Reporting (Zoho Integrations tab) to use this' : undefined}>
                    <span className="sm-toggle">
                      <input type="checkbox" checked={!!ds.rtaReportAgentStatusHeartbeat} disabled={!rtaLogsOn}
                        onChange={() => setDs(prev => ({ ...prev, rtaReportAgentStatusHeartbeat: !prev.rtaReportAgentStatusHeartbeat }))} />
                      <span className="sm-toggle-track" />
                    </span>
                    <span style={{ opacity: !rtaLogsOn ? 0.5 : 1, fontSize: 13 }}>
                      Every 60 min <span className="sm-metric-sub" style={{ display: 'block' }}>Bulk-reports every currently-breaching agent on a fixed timer, regardless of whether it changed</span>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    title={!rtaLogsOn ? 'Enable Workforce RTA Logs Reporting (Zoho Integrations tab) to use this' : undefined}>
                    <span className="sm-toggle">
                      <input type="checkbox" checked={rtaReportAgentStatusOn} disabled={!rtaLogsOn}
                        onChange={() => setRtaReportAgentStatusOn(prev => !prev)} />
                      <span className="sm-toggle-track" />
                    </span>
                    <span style={{ opacity: !rtaLogsOn ? 0.5 : 1, fontSize: 13 }}>
                      On new breach <span className="sm-metric-sub" style={{ display: 'block' }}>Reports as soon as a NEW agent/status joins — e.g. a new overbreak — not every tick of one already known</span>
                    </span>
                  </label>
                </div>
              </>
            )}

            {tab === 'cliq' && (
              <>
                <p className="sm-desc">
                  Sends a breach alert message to a Zoho Cliq channel, and/or creates a record in
                  Zoho Creator&apos;s Workforce Logs report, whenever active breaches are detected. Both
                  run as the same Vercel Cron job, checking every minute — not something you need to
                  leave a browser tab open for. <strong>Test Mode</strong> (Cliq only) prefixes every
                  message with <code>[TEST]</code> so channel members know alerts are still being verified.
                </p>

                <div className="sm-section-title">ZOHO AUTHORIZATION</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
                  <a href="/api/zoho/authorize" target="_blank" rel="noopener noreferrer"
                    className="acc-btn acc-btn-cfg" style={{ fontSize: 13, padding: '9px 16px' }}>
                    <i className="bx bx-link-external" style={{ marginRight: 6 }} />
                    Authorize with Zoho
                  </a>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    One-time setup — covers both Cliq alerts and Workforce Logs reporting (same Zoho
                    self-client, both scopes requested together). Requires <code>ZOHO_CLIQ_CLIENT_ID</code>/
                    <code>ZOHO_CLIQ_CLIENT_SECRET</code>/<code>SUPABASE_SERVICE_ROLE_KEY</code> to already be
                    set as env vars on this deployment. Opens Zoho&apos;s consent screen in a new tab; once you
                    approve, the resulting token is saved automatically — nothing to copy or paste.
                    Re-run this any time a new Zoho scope is added, since Zoho only grants what was
                    requested at consent time.
                  </span>
                </div>

                <div className="sm-section-title">GLOBAL CLIQ SETTINGS</div>
                <table className="sm-table">
                  <tbody>
                    <tr>
                      <td><div className="sm-metric">Enable Cliq Notifications</div><div className="sm-metric-sub">Applies to every account with a channel configured below</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={cliqGlobal.enabled}
                          onChange={() => setCliqGlobal(prev => ({ ...prev, enabled: !prev.enabled }))} />
                      </td>
                    </tr>
                    <tr>
                      <td><div className="sm-metric">Test Mode</div><div className="sm-metric-sub">Prefixes every message with [TEST]</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={cliqGlobal.testMode}
                          onChange={() => setCliqGlobal(prev => ({ ...prev, testMode: !prev.testMode }))} />
                      </td>
                    </tr>
                    <tr>
                      <td><div className="sm-metric">Re-alert Frequency</div><div className="sm-metric-sub">Minimum minutes between repeat alerts for the same account</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <div className="sm-input-cell" style={{ justifyContent: 'center' }}>
                          <input type="number" className="sm-input" min={1} max={60}
                            value={cliqGlobal.frequencyMinutes}
                            onChange={e => setCliqGlobal(prev => ({ ...prev, frequencyMinutes: Math.max(1, parseInt(e.target.value) || 5) }))} />
                          <span className="sm-unit">min</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="sm-section-title" style={{ marginTop: 20 }}>AI CATEGORIZATION (GEMINI)</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  Global — shared by every account&apos;s &quot;Enable AI Categorization&quot; toggle under
                  Workforce RTA Logs below. Add one or more Gemini API keys; if one errors (bad key,
                  quota, etc.) the next is tried automatically. Keys are never shown again after
                  saving — only a masked preview.
                </p>
                {geminiKeys === null ? (
                  <p className="sm-desc">Loading…</p>
                ) : geminiKeys.length === 0 ? (
                  <p className="sm-desc" style={{ opacity: 0.75 }}>No API keys added yet.</p>
                ) : (
                  <table className="sm-table" style={{ marginBottom: 12 }}>
                    <tbody>
                      {geminiKeys.map(k => (
                        <tr key={k.id}>
                          <td>
                            <div className="sm-metric">{k.label}</div>
                            <div className="sm-metric-sub">
                              <code>{k.maskedKey}</code>
                              {k.lastError && <span style={{ color: '#d9534f' }}> — last error: {k.lastError}</span>}
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button type="button" className="ds-x" disabled={geminiBusy}
                              title="Delete this key" style={{ fontSize: 18 }}
                              onClick={() => handleDeleteGeminiKey(k.id)}>
                              <i className="bx bx-trash" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <input type="text" className="sm-input" placeholder="Gemini API key"
                    style={{ flex: '2 1 220px' }} value={geminiKeyInput}
                    onChange={e => setGeminiKeyInput(e.target.value)} />
                  <input type="text" className="sm-input" placeholder="Label (optional)"
                    style={{ flex: '1 1 120px' }} value={geminiLabelInput}
                    onChange={e => setGeminiLabelInput(e.target.value)} />
                  <button type="button" className="acc-btn acc-btn-cfg" disabled={geminiBusy || !geminiKeyInput.trim()}
                    style={{ fontSize: 13, padding: '9px 16px' }} onClick={handleAddGeminiKey}>
                    <i className={`bx ${geminiBusy ? 'bx-loader-alt bx-spin' : 'bx-plus'}`} style={{ marginRight: 6 }} />
                    Add Key
                  </button>
                </div>
                {geminiError && (
                  <p className="sm-desc" style={{ color: '#d9534f', marginBottom: 10 }}>{geminiError}</p>
                )}

                <p className="sm-desc" style={{ marginTop: 16, marginBottom: 6 }}>
                  <strong>Models</strong> — tried in this same order (top to bottom), exhausting every
                  key for one model before moving to the next, same as the keys above.
                </p>
                {geminiModels === null ? (
                  <p className="sm-desc">Loading…</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {geminiModels.map((m, i) => (
                      <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, opacity: 0.6, width: 18 }}>{i + 1}.</span>
                        <code style={{ flex: 1 }}>{m}</code>
                        <button type="button" className="ds-x" disabled={geminiModelsBusy}
                          title="Remove this model" style={{ fontSize: 18 }}
                          onClick={() => handleRemoveGeminiModel(m)}>
                          <i className="bx bx-trash" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
                  <input type="text" className="sm-input" placeholder="e.g. gemini-2.0-flash"
                    style={{ flex: '2 1 220px' }} value={geminiModelInput}
                    onChange={e => setGeminiModelInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddGeminiModel() }} />
                  <button type="button" className="acc-btn acc-btn-cfg" disabled={geminiModelsBusy || !geminiModelInput.trim()}
                    style={{ fontSize: 13, padding: '9px 16px' }} onClick={handleAddGeminiModel}>
                    <i className={`bx ${geminiModelsBusy ? 'bx-loader-alt bx-spin' : 'bx-plus'}`} style={{ marginRight: 6 }} />
                    Add Model
                  </button>
                </div>

                <div className="sm-section-title" style={{ marginTop: 20 }}>CLIQ CHANNEL — {accountId}</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  Enter the <strong>Unique Name</strong> of the Zoho Cliq channel for this account
                  (find it under the channel&apos;s Connectors tab in Cliq). Leave blank to disable
                  Cliq alerts for this account specifically.
                </p>
                <input type="text" className="sm-input" style={{ width: '100%', textAlign: 'left' }}
                  placeholder="e.g. ashleywfmlive" value={cliqChan}
                  onChange={e => setCliqChan(e.target.value.trim())} />

                <div className="sm-section-title" style={{ marginTop: 20 }}>BREACH ALARM — {accountId}</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  Sound this account&apos;s card plays on the Overview page when a new
                  breach appears. Give each account a different sound so you can tell
                  them apart without looking at the screen.
                </p>
                <div className="sm-input-cell" style={{ justifyContent: 'flex-start', gap: 10 }}>
                  <select className="sm-input" style={{ minWidth: 200 }} value={alarmSnd}
                    onChange={e => setAlarmSnd(e.target.value)}>
                    {ALARM_SOUNDS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <button type="button" className="sm-btn-save" style={{ padding: '7px 16px' }}
                    onClick={() => playAlarm(alarmSnd)}>
                    <i className="bx bx-play-circle" /> Test
                  </button>
                </div>

                <div className="sm-section-title" style={{ marginTop: 20 }}>WORKFORCE LOGS REPORTING — {accountId}</div>
                <table className="sm-table">
                  <tbody>
                    <tr>
                      <td><div className="sm-metric">Enable Workforce Logs Reporting</div><div className="sm-metric-sub">Creates a record in Zoho Creator&apos;s Workforce Logs report for this account&apos;s breaches</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={wfLogsOn}
                          onChange={() => setWfLogsOn(prev => !prev)} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="sm-desc" style={{ marginTop: 10, marginBottom: 4 }}>
                  Pick a value already seen in Zoho&apos;s existing records, or type a new one if it
                  isn&apos;t in the list yet — the field just below each box shows what&apos;s been
                  scanned so far. Reporting stays off for this account until <strong>Account</strong> is
                  filled in, even if the toggle above is checked.
                </p>
                <ZohoLookupField label="Account" fieldName="x_Account" refreshKey={fieldOptionsRefresh}
                  hint="Must match this account's name in Zoho's own Accounts list (the x_Account field)."
                  value={zohoLu.account} onChange={v => setZohoLu(prev => ({ ...prev, account: v }))} />
                <ZohoLookupField label="Category" fieldName="Category" refreshKey={fieldOptionsRefresh}
                  hint="Optional — leave blank to not set Category on this account's records."
                  value={zohoLu.category} onChange={v => setZohoLu(prev => ({ ...prev, category: v }))} />
                <ZohoLookupField label="Sub Category" fieldName="Sub_Categories" refreshKey={fieldOptionsRefresh}
                  hint="Optional — leave blank to not set Sub Category on this account's records."
                  value={zohoLu.subCategory} onChange={v => setZohoLu(prev => ({ ...prev, subCategory: v }))}
                  parentId={zohoLu.category.id || undefined} />
                <ZohoLookupField label="Site" fieldName="Site" refreshKey={fieldOptionsRefresh}
                  hint="Optional — leave blank to not set Site on this account's records."
                  value={zohoLu.site} onChange={v => setZohoLu(prev => ({ ...prev, site: v }))} />

                <div className="sm-section-title" style={{ marginTop: 20 }}>WORKFORCE RTA LOGS — {accountId}</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  A SEPARATE Zoho intake from Workforce Logs above — submits a &quot;Workforce RTA
                  Logs&quot; webapp request (account-wide, category fixed to Service Level &amp; Volume
                  Management / Understaffing Alert unless AI Categorization below picks a better one)
                  instead of a Workforce Logs record. Just the account&apos;s own id, its Site(s), and a
                  plain-text breach summary — no Zoho lookup IDs to resolve.
                </p>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  <strong>Cadence — NOT the Re-alert Frequency cooldown above.</strong> This reports
                  whenever something actually changes: a KPI (e.g. SLA %) reports every time its value
                  moves while still breaching, but stays quiet while it sits at the exact same number;
                  an agent-status breach only reports again when a NEW agent joins that breach type,
                  not just because an already-known agent&apos;s duration keeps climbing. Once the
                  account is fully healthy again, the next breach — even at a number/agent seen
                  before — is treated as fresh.
                </p>
                <table className="sm-table">
                  <tbody>
                    <tr>
                      <td><div className="sm-metric">Enable Workforce RTA Logs Reporting</div><div className="sm-metric-sub">Submits a Workforce RTA Logs webapp request for this account&apos;s breaches</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={rtaLogsOn}
                          onChange={() => { if (rtaLogsOn) setRtaLogsOn(false); else setRtaEnableConfirmOpen(true) }} />
                      </td>
                    </tr>
                    <tr>
                      <td><div className="sm-metric">Enable AI Categorization</div><div className="sm-metric-sub">Gemini groups this account&apos;s breaches by type and picks a real Zoho Category/Sub-Category for each group, instead of always sending the fixed one below{geminiKeys && geminiKeys.length === 0 ? ' — add at least one API key below first' : ''}</div></td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={rtaAiCatOn} disabled={!!geminiKeys && geminiKeys.length === 0}
                          onChange={() => setRtaAiCatOn(prev => !prev)} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="sm-desc" style={{ marginTop: 4, marginBottom: 10 }}>
                  There is no account-wide "report KPI breaches" switch anymore — every KPI threshold
                  has its OWN two independent RTA Logs Reporting toggles ("Every 60 min" and "On breach,
                  value changes" — both can be on at once), set on the <strong>KPI Thresholds</strong> tab.
                  Agent status breaches have their own matching pair of toggles (for the group as a
                  whole, not per status), set on the <strong>Status Durations</strong> tab.
                </p>
                {!rtaReportAgentStatusOn && !ds.rtaReportAgentStatusHeartbeat
                  && !(['sla', 'wait', 'aht', 'abn'] as const).some(k => kpi[k].rtaReportHeartbeat || kpi[k].rtaReportBreachChange)
                  && !ds.groups.some(g => (g.tiles || []).some(t => t.rtaReportHeartbeat || t.rtaReportBreachChange))
                  && (
                  <p className="sm-desc" style={{ marginTop: 4, marginBottom: 10, color: '#c0392b' }}>
                    No Agent Status toggle and no KPI RTA Logs Reporting toggle is on — this account&apos;s
                    automatic Workforce RTA Logs reporting has nothing to send and will always be skipped
                    until at least one is turned on.
                  </p>
                )}
                {rtaAiCatOn && (
                  <p className="sm-desc" style={{ marginTop: 4, marginBottom: 10 }}>
                    If Gemini is unavailable or none of its picks match a real Zoho category on a given
                    scan, this account&apos;s RTA Logs submission is skipped for that cycle and retried
                    next time — it will <strong>not</strong> fall back to sending the fixed category below.
                  </p>
                )}
                <p className="sm-desc" style={{ marginTop: 10, marginBottom: 6 }}>
                  <strong>Zoho Account Name</strong> — Zoho&apos;s script resolves the account by
                  matching this against its own HR/Accounts list by NAME, not by <strong>{accountId}</strong>
                  &apos;s id. Leave blank to send <strong>{accountId}</strong> as-is; fill this in only
                  if Zoho rejects it with &quot;Account not found in HR&quot; — e.g. the id
                  &quot;guardianbikes&quot; needs &quot;Guardian Bikes&quot; here to match Zoho&apos;s
                  own record.
                </p>
                <input type="text" className="sm-input" placeholder={`Zoho account name (defaults to "${accountId}")`}
                  style={{ width: '100%', marginBottom: 10 }}
                  value={rtaAcctName} onChange={e => setRtaAcctName(e.target.value)} />
                <p className="sm-desc" style={{ marginTop: 4, marginBottom: 6 }}>
                  <strong>Site(s)</strong> — Zoho&apos;s own processing script rejects this submission
                  with no site at all. An account can span more than one (check all that apply); type
                  any not listed below, comma-separated.
                </p>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
                  {KNOWN_RTA_SITES.map(site => (
                    <label key={site} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={rtaSitesOn.includes(site)}
                        onChange={() => setRtaSitesOn(prev => prev.includes(site) ? prev.filter(s => s !== site) : [...prev, site])} />
                      {site}
                    </label>
                  ))}
                </div>
                <input type="text" className="sm-input" placeholder="Other site(s), comma-separated"
                  style={{ width: '100%', marginBottom: 10 }}
                  value={rtaSitesOn.filter(s => !KNOWN_RTA_SITES.includes(s)).join(', ')}
                  onChange={e => {
                    const others = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    setRtaSitesOn([...rtaSitesOn.filter(s => KNOWN_RTA_SITES.includes(s)), ...others])
                  }} />
                <p className="sm-desc" style={{ marginTop: 4, marginBottom: 10 }}>
                  There&apos;s no Zoho sandbox for this intake, so the button below sends a real,
                  clearly-tagged <code>[TEST]</code> submission for <strong>{accountId}</strong> — check
                  Zoho&apos;s own list to confirm it arrived (safe to delete it there afterward). This is
                  test-only — it does <strong>not</strong> save the Zoho Account Name or Site(s) above;
                  click <strong>Save Changes</strong> below to persist them.{' '}
                  {rtaAiCatOn && (
                    <>Since AI Categorization is on, this classifies this account&apos;s REAL current
                      breaches and sends one <code>[TEST]</code> submission per group — same as a real
                      scan would (fails with a clear message if nothing is breaching right now).</>
                  )}
                </p>
                <button type="button" className="acc-btn acc-btn-cfg" disabled={rtaTesting}
                  style={{ fontSize: 13, padding: '9px 16px' }} onClick={handleTestRtaLog}>
                  <i className={`bx ${rtaTesting ? 'bx-loader-alt bx-spin' : 'bx-send'}`} style={{ marginRight: 6 }} />
                  {rtaTesting ? 'Sending...' : 'Test Workforce RTA Logs'}
                </button>
                {rtaTestOkAt && (
                  <div style={{ marginTop: 10, fontSize: 12.5, color: '#2f9e5b' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <i className="bx bx-check-circle" style={{ fontSize: 16 }} />
                      Zoho accepted {rtaTestSubmissions && rtaTestSubmissions.length > 1 ? `all ${rtaTestSubmissions.length} submissions` : 'the submission'} at {rtaTestOkAt} — go check the Workforce RTA Logs list.
                    </div>
                    {rtaTestSubmissions && rtaTestSubmissions.length > 1 && (
                      <ul style={{ margin: '6px 0 0 22px', padding: 0, fontSize: 12, opacity: 0.85 }}>
                        {rtaTestSubmissions.map((s, i) => (
                          <li key={i}>{s.category} / {s.subCategory}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {(rtaTestOkAt || rtaTestTopError || rtaTestSubmissions) && (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                    Authorized Zoho account: <strong>{rtaTestAuthorizedAs ? `${rtaTestAuthorizedAs.displayName} <${rtaTestAuthorizedAs.email}>` : 'Unknown (could not read identity — token may predate the profile-read scope; re-authorize to pick it up)'}</strong>
                  </div>
                )}

                <ZohoAuxSection accountId={accountId} value={ds.zohoAux}
                  onChange={z => setDs(prev => ({ ...prev, zohoAux: z }))} />

                <div className="sm-section-title" style={{ marginTop: 20 }}>SCAN ZOHO FIELD OPTIONS</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  Scans every existing record in Zoho&apos;s Workforce Logs report to refresh the
                  Account/Category/Sub Category/Site suggestions above with whatever&apos;s actually
                  been used before. Runs automatically once a day — use this button to refresh
                  immediately instead of waiting.
                </p>
                <button type="button" className="acc-btn acc-btn-cfg" disabled={fieldScanning}
                  style={{ fontSize: 13, padding: '9px 16px' }} onClick={handleForceFieldScan}>
                  <i className={`bx ${fieldScanning ? 'bx-loader-alt bx-spin' : 'bx-refresh'}`} style={{ marginRight: 6 }} />
                  {fieldScanning ? 'Scanning...' : 'Scan Zoho Field Options Now'}
                </button>
                {fieldScanLog && (
                  <pre style={{
                    marginTop: 12, padding: 12, maxHeight: 220, overflowY: 'auto',
                    background: 'var(--bg-body,#f0f2f1)', border: '1px solid var(--border,#e1e6e4)',
                    borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    color: 'var(--text-main)',
                  }}>
                    {fieldScanLog.join('\n')}
                  </pre>
                )}

                <div className="sm-section-title" style={{ marginTop: 20 }}>FORCE BREACH SCAN</div>
                <p className="sm-desc" style={{ marginBottom: 10 }}>
                  Runs the breach scan (Cliq alert + Workforce Logs record + Workforce RTA Logs
                  request) immediately instead of waiting for the next scheduled minute — bypasses
                  the Re-alert Frequency cooldown above for Cliq/Workforce Logs, but not the
                  staleness suppression (an account whose data hasn&apos;t updated recently still
                  won&apos;t send). Workforce RTA Logs isn&apos;t on that cooldown at all — see its
                  own section above for when it actually reports.
                </p>
                <button type="button" className="acc-btn acc-btn-cfg" disabled={cliqScanning}
                  style={{ fontSize: 13, padding: '9px 16px' }} onClick={handleForceScan}>
                  <i className={`bx ${cliqScanning ? 'bx-loader-alt bx-spin' : 'bx-play-circle'}`} style={{ marginRight: 6 }} />
                  {cliqScanning ? 'Scanning...' : 'Force Scan Now'}
                </button>
                {cliqScanLog && (
                  <pre style={{
                    marginTop: 12, padding: 12, maxHeight: 220, overflowY: 'auto',
                    background: 'var(--bg-body,#f0f2f1)', border: '1px solid var(--border,#e1e6e4)',
                    borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    color: 'var(--text-main)',
                  }}>
                    {cliqScanLog.join('\n')}
                  </pre>
                )}
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
              <button className="sm-btn-save" onClick={() => { onSave(kpi, stat, ds, cliqChan, wfLogsOn, zohoLu, alarmSnd, rtaLogsOn, rtaSitesOn, rtaAcctName, rtaAiCatOn, rtaReportKpiOn, rtaReportAgentStatusOn); onSaveCliqGlobal(cliqGlobal); onClose() }}>
                <i className="bx bx-save" /> Save Changes
              </button>
            </div>
          </div>

        </div>
      </div>

      {(rtaTestTopError || (rtaTestSubmissions && rtaTestSubmissions.some(s => !s.ok))) && (
        <div className="sm-err-overlay" onMouseDown={e => { if (e.target === e.currentTarget) { setRtaTestTopError(null); setRtaTestSubmissions(null) } }}>
          <div className="sm-err-modal">
            <div className="sm-err-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <i className="bx bx-error-circle" style={{ fontSize: 22, color: '#d9534f' }} />
                <span className="sm-err-title">Workforce RTA Logs test failed</span>
              </div>
              <button className="sm-close" onClick={() => { setRtaTestTopError(null); setRtaTestSubmissions(null) }}><i className="bx bx-x" /></button>
            </div>
            <div className="sm-err-body">
              <div className="sm-err-row" style={{ marginBottom: 12 }}>
                <strong>Authorized Zoho account:</strong>{' '}
                {rtaTestAuthorizedAs ? `${rtaTestAuthorizedAs.displayName} <${rtaTestAuthorizedAs.email}>` : 'Unknown (could not read identity — re-authorize to pick up the profile-read scope)'}
              </div>
              {rtaTestTopError ? (
                <p style={{ margin: '0 0 12px', fontSize: 13 }}>{rtaTestTopError}</p>
              ) : (
                <>
                  <p style={{ margin: '0 0 12px', fontSize: 13 }}>
                    {rtaTestSubmissions!.length > 1
                      ? `${rtaTestSubmissions!.filter(s => s.ok).length} of ${rtaTestSubmissions!.length} AI-grouped submissions succeeded — details for each below.`
                      : 'Zoho rejected the submission — see details below.'}
                  </p>
                  {rtaTestSubmissions!.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: i < rtaTestSubmissions!.length - 1 ? '1px solid var(--border,#e1e6e4)' : 'none' }}>
                      {(s.category || rtaTestSubmissions!.length > 1) && (
                        <div className="sm-err-row" style={{ marginBottom: 6 }}>
                          <strong>{s.ok ? '✓' : '✗'} Group {i + 1}{s.category ? `: ${s.category} / ${s.subCategory}` : ''}</strong>
                        </div>
                      )}
                      {s.ok ? (
                        <div className="sm-err-row" style={{ color: '#2f9e5b' }}>Accepted.</div>
                      ) : (
                        <>
                          {s.status != null && (
                            <div className="sm-err-row"><strong>HTTP Status:</strong> {s.status}</div>
                          )}
                          {s.requestUrl && (
                            <div className="sm-err-row"><strong>Request URL:</strong> {s.requestUrl}</div>
                          )}
                          {s.requestBody && (
                            <>
                              <div className="sm-err-row" style={{ marginTop: 10 }}><strong>Request Payload:</strong></div>
                              <pre className="sm-err-pre">{JSON.stringify(s.requestBody, null, 2)}</pre>
                            </>
                          )}
                          {s.responseBody && (
                            <>
                              <div className="sm-err-row" style={{ marginTop: 10 }}><strong>Zoho Response:</strong></div>
                              <pre className="sm-err-pre">{JSON.stringify(s.responseBody, null, 2)}</pre>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="sm-err-footer">
              <button className="sm-btn-cancel" onClick={() => { setRtaTestTopError(null); setRtaTestSubmissions(null) }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {rtaEnableConfirmOpen && (
        <div className="sm-err-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setRtaEnableConfirmOpen(false) }}>
          <div className="sm-err-modal" style={{ maxWidth: 460 }}>
            <div className="sm-err-header" style={{ background: 'linear-gradient(135deg, #d97a35 0%, #a85a24 100%)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <i className="bx bx-error" style={{ fontSize: 22, color: '#fff' }} />
                <span className="sm-err-title">Enable Workforce RTA Logs Reporting?</span>
              </div>
              <button className="sm-close" onClick={() => setRtaEnableConfirmOpen(false)}><i className="bx bx-x" /></button>
            </div>
            <div className="sm-err-body">
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                This starts sending real breach reports to Zoho for <strong>{accountId}</strong> the
                next time the scan runs — are you sure its KPI Thresholds and Status Durations are
                finalized? If not, turn this on later once they&apos;re confirmed.
              </p>
            </div>
            <div className="sm-err-footer" style={{ gap: 8 }}>
              <button className="sm-btn-cancel" onClick={() => setRtaEnableConfirmOpen(false)}>Cancel</button>
              <button className="sm-btn-save" onClick={() => { setRtaLogsOn(true); setRtaEnableConfirmOpen(false) }}>
                <i className="bx bx-check" /> Yes, Enable It
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Portal wrapper ────────────────────────────────────────────────────────────
/** Which tab is open. Kept OUTSIDE the keyed SettingsContent (see below). */
interface OpenTab { tab: Tab; setTab: (t: Tab) => void }

export default function SettingsModal(props: Props) {
  // The open tab lives here, not in SettingsContent: the key below remounts
  // SettingsContent whenever the account changes — including once on its own
  // right after page load, when the account list arrives — and a remount
  // would throw the user back to the first tab mid-click. That also covers
  // Accounts → "Configure", which switches account and opens Data Sources.
  // An RTA has no Accounts tab, so opening on it would show a blank body.
  const { profile } = useAuth()
  const [tab, setTab] = useState<Tab>(can.manageAccounts(profile.role) ? 'accounts' : 'datasource')
  if (typeof document === 'undefined') return null
  // Portal renders outside #layout-wrapper — wrap with dark class so all
  // .dark .sm-* selectors inside MODAL_STYLES resolve correctly
  return createPortal(
    <div className={props.isDark ? 'dark' : ''}>
      {/* key={props.accountId} — CONFIRMED root cause of a real data-loss
          incident (2026-09-21): SettingsContent seeds its kpi/stat/ds state
          ONCE via useState(props.*) at mount and never re-syncs from props
          afterward. Clicking "Configure" on a DIFFERENT account from the
          Accounts tab (onConfigureAccount -> switchAccount) changes
          `accountId` while the modal stays open, but WITHOUT this key,
          React keeps the same component instance — its kpi/stat/ds state
          stays frozen on whatever account was open when it first mounted.
          Clicking "Save Changes" after that silently wrote one account's
          entire config onto a DIFFERENT account's row (flex's real "Messaging
          SLA"/"Email SLA" KPI mapping got overwritten with wyze's). The key
          forces a full remount — and fresh useState(props.*) — every time
          the account being configured changes. */}
      <SettingsContent key={props.accountId} {...props} tab={tab} setTab={setTab} />
    </div>,
    document.body
  )
}