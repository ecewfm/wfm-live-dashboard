// lib/settings.ts
// Saves and loads account settings (KPI thresholds, status thresholds, data source)
// to Supabase so ALL browsers and devices share the same configuration.
// localStorage is kept as a cache/fallback for offline use.

import { supabase } from './supabase'
import type { Thresholds, DataSourceConfig } from './types'
import type { StatusThresholds } from './utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  loadKpiThresholds, loadStatusThresholds, loadDataSource,
  saveKpiThresholds, saveStatusThresholds, saveDataSource
} from './utils'

export interface AccountSettings {
  kpi:    Thresholds
  status: StatusThresholds
  ds:     DataSourceConfig
}

// ── Load settings for one account ─────────────────────────────────────────────
// Priority: Supabase → localStorage → hardcoded defaults
export async function loadSettings(accountId: string): Promise<AccountSettings> {
  try {
    const { data, error } = await supabase
      .from('wfm_settings')
      .select('kpi_thresholds, status_thresholds, data_source')
      .eq('id', accountId)
      .maybeSingle()

    if (!error && data) {
      const settings: AccountSettings = {
        kpi:    data.kpi_thresholds
                  ? { ...DEFAULT_THRESHOLDS,        ...data.kpi_thresholds    }
                  : loadKpiThresholds(accountId),
        status: data.status_thresholds
                  ? { ...DEFAULT_STATUS_THRESHOLDS, ...data.status_thresholds }
                  : loadStatusThresholds(accountId),
        ds:     data.data_source
                  ? { ...DEFAULT_DATA_SOURCE,       ...data.data_source       }
                  : loadDataSource(accountId),
      }
      // Refresh localStorage cache
      saveKpiThresholds(accountId, settings.kpi)
      saveStatusThresholds(accountId, settings.status)
      saveDataSource(accountId, settings.ds)
      return settings
    }
  } catch {}

  // Fallback: localStorage (works offline or if table doesn't exist yet)
  return {
    kpi:    loadKpiThresholds(accountId),
    status: loadStatusThresholds(accountId),
    ds:     loadDataSource(accountId),
  }
}

// ── Save settings for one account ─────────────────────────────────────────────
// Writes to Supabase (shared) AND localStorage (local cache).
export async function saveSettings(
  accountId: string,
  kpi:    Thresholds,
  status: StatusThresholds,
  ds:     DataSourceConfig
): Promise<boolean> {
  // 1. Always write to localStorage immediately (instant, works offline)
  saveKpiThresholds(accountId, kpi)
  saveStatusThresholds(accountId, status)
  saveDataSource(accountId, ds)

  // 2. Write to Supabase (shared across all browsers/devices)
  try {
    const { error } = await supabase
      .from('wfm_settings')
      .upsert({
        id:                accountId,
        account_id:        accountId,
        kpi_thresholds:    kpi,
        status_thresholds: status,
        data_source:       ds,
        updated_at:        new Date().toISOString(),
      })
    if (error) { console.warn('[settings] Supabase save error:', error.message); return false }
    return true
  } catch (e) {
    console.warn('[settings] Supabase save failed:', e)
    return false
  }
}

// ── Load settings for multiple accounts in parallel ───────────────────────────
export async function loadAllSettings(
  accountIds: string[]
): Promise<Record<string, AccountSettings>> {
  const results = await Promise.all(accountIds.map(id => loadSettings(id)))
  const map: Record<string, AccountSettings> = {}
  accountIds.forEach((id, i) => { map[id] = results[i] })
  return map
}
