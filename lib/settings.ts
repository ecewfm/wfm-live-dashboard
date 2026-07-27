// lib/settings.ts
// Saves and loads account settings (KPI thresholds, status thresholds, data source)
// to Supabase so ALL browsers and devices share the same configuration.
// localStorage is kept as a cache/fallback for offline use.

import { supabase } from './supabase'
import type { Thresholds, DataSourceConfig, DashboardLayout, HeaderColors, CliqGlobalSettings, ZohoLookups } from './types'
import { DEFAULT_ZOHO_LOOKUPS } from './types'
import type { StatusThresholds } from './utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  loadKpiThresholds, loadStatusThresholds, loadDataSource,
  saveKpiThresholds, saveStatusThresholds, saveDataSource,
  loadDashboardLayout, saveDashboardLayoutLocal,
  loadHeaderColorsLocal, saveHeaderColorsLocal,
  migrateDataSource
} from './utils'

export const DEFAULT_CLIQ_GLOBAL_SETTINGS: CliqGlobalSettings = {
  enabled: false, testMode: true, frequencyMinutes: 5,
}

export interface AccountSettings {
  kpi:    Thresholds
  status: StatusThresholds
  ds:     DataSourceConfig
  layout: DashboardLayout
  headerColors: HeaderColors
  cliqChannel: string
  wfLogsEnabled: boolean
  zohoLookups: ZohoLookups
}

// ── Load settings for one account ─────────────────────────────────────────────
// Priority: Supabase → localStorage → hardcoded defaults
export async function loadSettings(accountId: string): Promise<AccountSettings> {
  try {
    let { data, error } = await supabase
      .from('wfm_settings')
      .select(`
        kpi_thresholds, status_thresholds, data_source, dashboard_layout,
        header_band_color, header_text_color, cliq_channel, wf_logs_enabled,
        zoho_account_name, zoho_account_id,
        zoho_category_text, zoho_category_id,
        zoho_subcategory_text, zoho_subcategory_id,
        zoho_site_text, zoho_site_id
      `)
      .eq('id', accountId)
      .maybeSingle()

    // The zoho_*/wf_logs_enabled columns don't exist until their migration
    // has been run — PostgREST errors the WHOLE select on an unknown column,
    // so retry without them (falling back to the previously-newest columns,
    // then the base set) rather than losing everything else too.
    if (error) {
      const retry1 = await supabase
        .from('wfm_settings')
        .select('kpi_thresholds, status_thresholds, data_source, dashboard_layout, header_band_color, header_text_color, cliq_channel')
        .eq('id', accountId)
        .maybeSingle()
      if (!retry1.error) {
        data = retry1.data as any
        error = null
      } else {
        const retry2 = await supabase
          .from('wfm_settings')
          .select('kpi_thresholds, status_thresholds, data_source, dashboard_layout')
          .eq('id', accountId)
          .maybeSingle()
        data  = retry2.data as any
        error = retry2.error
      }
    }

    if (!error && data) {
      const localColors = loadHeaderColorsLocal(accountId)
      const settings: AccountSettings = {
        kpi:    data.kpi_thresholds
                  ? { ...DEFAULT_THRESHOLDS,        ...data.kpi_thresholds    }
                  : loadKpiThresholds(accountId),
        status: data.status_thresholds
                  ? { ...DEFAULT_STATUS_THRESHOLDS, ...data.status_thresholds }
                  : loadStatusThresholds(accountId),
        ds:     data.data_source
                  ? migrateDataSource(data.data_source)
                  : loadDataSource(accountId),
        layout: data.dashboard_layout || loadDashboardLayout(accountId),
        // header_band_color/header_text_color columns may not exist yet on an
        // account that hasn't run sql/header_colors.sql — fall back to
        // whatever was previously picked in THIS browser (pre-sync behavior)
        // so no one's already-chosen color appears to reset.
        headerColors: (data.header_band_color != null || data.header_text_color != null)
                  ? { band: data.header_band_color || '', text: data.header_text_color || '' }
                  : localColors,
        cliqChannel: data.cliq_channel || '',
        wfLogsEnabled: !!(data as any).wf_logs_enabled,
        zohoLookups: {
          account:     { id: (data as any).zoho_account_id     || '', text: (data as any).zoho_account_name    || '' },
          category:    { id: (data as any).zoho_category_id    || '', text: (data as any).zoho_category_text   || '' },
          subCategory: { id: (data as any).zoho_subcategory_id || '', text: (data as any).zoho_subcategory_text || '' },
          site:        { id: (data as any).zoho_site_id        || '', text: (data as any).zoho_site_text       || '' },
        },
      }
      // Refresh localStorage cache
      saveKpiThresholds(accountId, settings.kpi)
      saveStatusThresholds(accountId, settings.status)
      saveDataSource(accountId, settings.ds)
      saveDashboardLayoutLocal(accountId, settings.layout)
      return settings
    }
  } catch {}

  // Fallback: localStorage (works offline or if table doesn't exist yet)
  return {
    kpi:    loadKpiThresholds(accountId),
    status: loadStatusThresholds(accountId),
    ds:     loadDataSource(accountId),
    layout: loadDashboardLayout(accountId),
    headerColors: loadHeaderColorsLocal(accountId),
    cliqChannel: '',
    wfLogsEnabled: false,
    zohoLookups: { ...DEFAULT_ZOHO_LOOKUPS },
  }
}

// ── Save just the dashboard panel layout ──────────────────────────────────────
// Separate from saveSettings — layout changes save immediately on drag/resize
// end, not gated behind the Settings modal's Save button. Supabase upsert only
// touches the columns provided here, so this never disturbs kpi_thresholds/
// status_thresholds/data_source saved via the modal.
export async function saveDashboardLayout(accountId: string, layout: DashboardLayout): Promise<boolean> {
  saveDashboardLayoutLocal(accountId, layout)
  try {
    const { error } = await supabase
      .from('wfm_settings')
      .upsert({ id: accountId, account_id: accountId, dashboard_layout: layout, updated_at: new Date().toISOString() })
    if (error) { console.warn('[settings] layout save error:', error.message); return false }
    return true
  } catch (e) {
    console.warn('[settings] layout save failed:', e)
    return false
  }
}

// ── Save just the Overview header colors (band background + title text) ─────
// Separate from saveSettings — colors save immediately on pick, not gated
// behind the Settings modal's Save button. Requires sql/header_colors.sql to
// have been run; if the columns don't exist yet this just fails quietly and
// the color still applies locally via loadHeaderColorsLocal's fallback.
export async function saveHeaderColors(accountId: string, colors: HeaderColors): Promise<boolean> {
  saveHeaderColorsLocal(accountId, colors)
  try {
    const { error } = await supabase
      .from('wfm_settings')
      .upsert({
        id: accountId, account_id: accountId,
        header_band_color: colors.band, header_text_color: colors.text,
        updated_at: new Date().toISOString(),
      })
    if (error) { console.warn('[settings] header colors save error:', error.message); return false }
    return true
  } catch (e) {
    console.warn('[settings] header colors save failed:', e)
    return false
  }
}

// ── Zoho Cliq global notification settings (singleton row, id='global') ─────
// Enable/test-mode/frequency apply to every account — the actual scan/send
// loop lives in the wfm-live-scraper process and reads this same table
// directly via its own Supabase REST calls (see lib/cliq-notifier.js there).
export async function loadCliqSettings(): Promise<CliqGlobalSettings> {
  try {
    const { data, error } = await supabase
      .from('wfm_cliq_settings')
      .select('enabled, test_mode, frequency_minutes')
      .eq('id', 'global')
      .maybeSingle()
    if (!error && data) {
      return {
        enabled:          !!data.enabled,
        testMode:         data.test_mode !== false,
        frequencyMinutes: data.frequency_minutes || DEFAULT_CLIQ_GLOBAL_SETTINGS.frequencyMinutes,
      }
    }
  } catch (e) {
    console.warn('[settings] Cliq settings load failed:', e)
  }
  return { ...DEFAULT_CLIQ_GLOBAL_SETTINGS }
}

export async function saveCliqSettings(settings: CliqGlobalSettings): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('wfm_cliq_settings')
      .upsert({
        id:                'global',
        enabled:           settings.enabled,
        test_mode:         settings.testMode,
        frequency_minutes: settings.frequencyMinutes,
        updated_at:        new Date().toISOString(),
      })
    if (error) { console.warn('[settings] Cliq settings save error:', error.message); return false }
    return true
  } catch (e) {
    console.warn('[settings] Cliq settings save failed:', e)
    return false
  }
}

// ── Zoho Creator lookup field options (Category/Sub_Categories/x_Account/Site) ─
// Populated by lib/zohoFieldScan.ts (daily Cron + "Scan Zoho Field Options
// Now" button) scanning every existing Workforce Logs record. Read directly
// with the anon client — nothing sensitive in here, same posture as
// wfm_settings itself (only wfm_cliq_oauth is locked down).
export interface ZohoFieldOption { id: string; label: string }

export async function loadZohoFieldOptions(
  fieldName: 'Category' | 'Sub_Categories' | 'x_Account' | 'Site'
): Promise<ZohoFieldOption[]> {
  try {
    const { data, error } = await supabase
      .from('wfm_zoho_field_options')
      .select('zoho_id, display_value')
      .eq('field_name', fieldName)
      .order('display_value')
    if (error || !data) return []
    return data.map((r: any) => ({ id: r.zoho_id, label: r.display_value }))
  } catch {
    return []
  }
}

// ── Save settings for one account ─────────────────────────────────────────────
// Writes to Supabase (shared) AND localStorage (local cache).
export async function saveSettings(
  accountId: string,
  kpi:    Thresholds,
  status: StatusThresholds,
  ds:     DataSourceConfig,
  cliqChannel: string = '',
  wfLogsEnabled: boolean = false,
  zohoLookups: ZohoLookups = DEFAULT_ZOHO_LOOKUPS
): Promise<boolean> {
  // 1. Always write to localStorage immediately (instant, works offline)
  saveKpiThresholds(accountId, kpi)
  saveStatusThresholds(accountId, status)
  saveDataSource(accountId, ds)

  // 2. Write to Supabase (shared across all browsers/devices)
  try {
    let { error } = await supabase
      .from('wfm_settings')
      .upsert({
        id:                    accountId,
        account_id:            accountId,
        kpi_thresholds:        kpi,
        status_thresholds:     status,
        data_source:           ds,
        cliq_channel:          cliqChannel,
        wf_logs_enabled:       wfLogsEnabled,
        zoho_account_name:     zohoLookups.account.text,
        zoho_account_id:       zohoLookups.account.id,
        zoho_category_text:    zohoLookups.category.text,
        zoho_category_id:      zohoLookups.category.id,
        zoho_subcategory_text: zohoLookups.subCategory.text,
        zoho_subcategory_id:   zohoLookups.subCategory.id,
        zoho_site_text:        zohoLookups.site.text,
        zoho_site_id:          zohoLookups.site.id,
        updated_at:            new Date().toISOString(),
      })
    // The zoho_*/wf_logs_enabled columns don't exist until
    // sql/zoho_workforce_logs.sql has been run — PostgREST rejects the WHOLE
    // upsert on an unknown column, so retry without them rather than failing
    // to save kpi/status/data-source/cliq_channel too.
    if (error) {
      const retry = await supabase
        .from('wfm_settings')
        .upsert({
          id:                accountId,
          account_id:        accountId,
          kpi_thresholds:    kpi,
          status_thresholds: status,
          data_source:       ds,
          cliq_channel:      cliqChannel,
          updated_at:        new Date().toISOString(),
        })
      error = retry.error
    }
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

// ── Account management ─────────────────────────────────────────────────────────

export interface AccountConfig {
  id:           string
  display_name: string
  active:       boolean
  sort_order:   number
  created_at?:  string
}

/** Load all accounts from wfm_accounts, falling back to discovering from data tables */
export async function loadAccounts(): Promise<AccountConfig[]> {
  try {
    const { data, error } = await supabase
      .from('wfm_accounts')
      .select('*')
      .eq('active', true)
      .order('sort_order')
      .order('created_at')
    if (!error && data && data.length > 0) return data as AccountConfig[]
  } catch {}

  // Fallback: discover from existing data tables (backwards compat)
  try {
    const [r1, r2] = await Promise.all([
      supabase.from('wfm_kpi_snapshots').select('account_id'),
      supabase.from('talkdesk_lob_kpis').select('account_id'),
    ])
    const ids = new Set<string>()
    ;(r1.data ?? []).forEach((r: any) => ids.add(r.account_id))
    ;(r2.data ?? []).forEach((r: any) => ids.add(r.account_id))
    return [...ids].sort().map((id, i) => ({
      id, display_name: id, active: true, sort_order: i
    }))
  } catch {}
  return []
}

/** Add a new account — throws on error so the UI can show it */
export async function addAccount(id: string, displayName?: string): Promise<void> {
  const trimId = id.trim().toLowerCase().replace(/\s+/g, '-')
  if (!trimId) throw new Error('Account ID cannot be empty')
  const { error } = await supabase.from('wfm_accounts').upsert({
    id:           trimId,
    display_name: displayName?.trim() || trimId,
    active:       true,
    sort_order:   Math.floor(Date.now() / 1000),
    created_at:   new Date().toISOString(),
  })
  if (error) throw new Error(error.message || JSON.stringify(error))
}

/** Remove (deactivate) an account — throws on error */
export async function removeAccount(id: string): Promise<void> {
  const { error } = await supabase
    .from('wfm_accounts')
    .update({ active: false })
    .eq('id', id)
  if (error) throw new Error(error.message || JSON.stringify(error))
}

/** Seed existing discovered accounts into wfm_accounts (run once on first load) */
export async function seedAccountsIfEmpty(ids: string[]): Promise<void> {
  try {
    const { data } = await supabase.from('wfm_accounts').select('id').limit(1)
    if (data && data.length > 0) return  // already seeded
    await Promise.all(ids.map((id, i) =>
      supabase.from('wfm_accounts').upsert({
        id, display_name: id, active: true, sort_order: i,
        created_at: new Date().toISOString(),
      })
    ))
  } catch {}
}
