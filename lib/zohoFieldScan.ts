// lib/zohoFieldScan.ts
// Populates wfm_zoho_field_options (sql/zoho_field_options.sql) — the table
// the Settings UI reads to offer autocomplete suggestions for the four Zoho
// lookup fields, instead of requiring someone to dig up raw Zoho record IDs
// by hand. Two different sources feed it depending on the field:
//
//   Category / Sub_Categories — read from the client's two canonical MASTER
//   reports (Workforce_RTA_Categories_Report / Workforce_RTA_Sub_Categories_
//   Report). These are the full valid lists (including values never yet used
//   in a log), and the Sub-Categories report links each row back to its
//   parent Category via its own Workforce_RTA_Categories lookup field, which
//   is stored as parent_zoho_id so the Settings UI can cascade Sub Category
//   suggestions to just the ones under the selected Category. Deliberately
//   NOT scanned out of the logs report (like x_Account/Site below) — the
//   master reports are the single source of truth for these two fields, so
//   a Category/Sub_Categories row is deleted from wfm_zoho_field_options the
//   moment it's no longer in the master report, rather than lingering
//   forever from some historical log record.
//
//   x_Account / Site — no equivalent master report exists for these (yet),
//   so they're still discovered by scanning every existing record in
//   "All_Workforce_Logs_RTA_View" for the unique {ID, display_value} pairs
//   that have ever actually been used.
//
// Uses REPORT link names throughout (not forms) — reading records is a
// report-level operation in Zoho Creator's API, unlike writing (see
// lib/zohoCreator.ts, which needs the underlying form).
//
// Triggered by app/api/zoho/scan-fields (daily Vercel Cron) and
// app/api/zoho/force-scan-fields (the "Scan Zoho Field Options Now" button
// in Settings → Zoho Integrations).

import { getZohoAccessToken } from './zohoAuth'
import { getSupabaseAdmin } from './supabaseAdmin'
import { OWNER_NAME, APP_LINK_NAME, FORM_LINK_NAME } from './zohoCreator'
import { FORM_LINK_NAME as RTA_LOGS_FORM_LINK_NAME } from './zohoWebappRequest'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'
const REPORT_LINK_NAME = 'All_Workforce_Logs_RTA_View'
const CATEGORIES_REPORT_LINK_NAME    = 'Workforce_RTA_Categories_Report'
const SUBCATEGORIES_REPORT_LINK_NAME = 'Workforce_RTA_Sub_Categories_Report'

// ── List every form in the app via Zoho's Meta API — lets the scan confirm
// (or flag a mismatch in) lib/zohoCreator.ts's FORM_LINK_NAME guess without
// anyone needing to click through the Creator builder by hand. Requires the
// ZohoCreator.meta.READ scope (added alongside report.READ/CREATE — a
// re-authorize is needed if this was granted after the first consent).
async function listFormLinkNames(token: string): Promise<string[]> {
  try {
    const url = `${CREATOR_API_BASE}/meta/${OWNER_NAME}/${APP_LINK_NAME}/forms`
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } })
    const body: any = await res.json().catch(() => ({}))
    const forms = body?.result?.forms ?? body?.forms ?? []
    if (!res.ok || !Array.isArray(forms)) return []
    return forms.map((f: any) => f.link_name || f.linkName || f.form_link_name).filter(Boolean)
  } catch {
    return []
  }
}

// Same idea as listFormLinkNames but for reports — the "Invalid API URL
// format" error the Get Records call throws when REPORT_LINK_NAME is wrong
// gives no hint what the correct name actually is, so cross-check against
// Zoho's own report list instead of guessing again.
async function listReportLinkNames(token: string): Promise<string[]> {
  try {
    const url = `${CREATOR_API_BASE}/meta/${OWNER_NAME}/${APP_LINK_NAME}/reports`
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } })
    const body: any = await res.json().catch(() => ({}))
    const reports = body?.result?.reports ?? body?.reports ?? []
    if (!res.ok || !Array.isArray(reports)) return []
    return reports.map((r: any) => r.link_name || r.linkName || r.report_link_name).filter(Boolean)
  } catch {
    return []
  }
}

const LOOKUP_FIELDS = ['Category', 'Sub_Categories', 'x_Account', 'Site'] as const
type LookupField = typeof LOOKUP_FIELDS[number]

// x_Account/Site are the only two still scanned out of historical Workforce
// Logs records — see file header. Category/Sub_Categories now come
// exclusively from their own master reports below.
const LOG_LOOKUP_FIELDS = ['x_Account', 'Site'] as const

interface DiscoveredOption {
  field_name:     LookupField
  zoho_id:        string
  display_value:  string
  // Sub_Categories only — parent Category's zoho_id. Null for every other
  // field_name (including Category itself, which has no parent).
  parent_zoho_id: string | null
}

// A lookup field's value comes back as either a single object, an array of
// them (multi-lookup, e.g. x_Account), or blank/null. The display-name key
// is "zc_display_value" in the actual REST API response — "display_value"
// (checked first below) only ever showed up in the original Deluge debug
// dump, which formats fields differently than the raw v2.1 JSON does; kept
// as a fallback in case a future API version changes this back.
function extractPairs(fieldName: typeof LOG_LOOKUP_FIELDS[number], raw: any): DiscoveredOption[] {
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : [raw]
  return items
    .filter(v => v && typeof v === 'object' && v.ID != null)
    .map(v => ({
      field_name:     fieldName,
      zoho_id:        String(v.ID),
      display_value:  String(v.display_value ?? v.zc_display_value ?? v.ID),
      parent_zoho_id: null,
    }))
}

// Paginates a Get Records call to completion via Zoho's record_cursor
// header. Used for all three reports this scan reads (logs, categories,
// sub-categories) — a failure mid-pagination logs a warning and returns
// whatever was collected so far rather than throwing, so one bad report
// doesn't abort the other two.
async function fetchAllRecords(token: string, reportLinkName: string, l: (msg: string) => void): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null

  do {
    const url = `${CREATOR_API_BASE}/data/${OWNER_NAME}/${APP_LINK_NAME}/report/${reportLinkName}?field_config=all&max_records=200`
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` }
    if (cursor) headers.record_cursor = cursor

    const res = await fetch(url, { headers })
    const body: any = await res.json().catch(() => ({}))

    if (!res.ok) {
      // "no more records" is Zoho's normal end-of-pagination signal, not a
      // real failure — anything else is worth surfacing in the scan log.
      if (body?.code !== 3001) l(`Get Records failed for report "${reportLinkName}": ${JSON.stringify(body).substring(0, 200)}`)
      break
    }

    const records: any[] = Array.isArray(body.data) ? body.data : []
    all.push(...records)
    cursor = res.headers.get('record_cursor')
  } while (cursor)

  return all
}

export interface FieldScanResult {
  recordsScanned: number
  optionsDiscovered: Record<LookupField, number>
  log: string[]
}

export async function scanZohoFields(): Promise<FieldScanResult> {
  const log: string[] = []
  const l = (msg: string) => log.push(msg)
  const token = await getZohoAccessToken()

  // Confirm (or flag a mismatch in) the two FORM_LINK_NAME constants used for
  // writes — Workforce Logs (lib/zohoCreator.ts) and Workforce RTA Logs
  // (lib/zohoWebappRequest.ts) write to two DIFFERENT forms in this same app
  // — no builder click-through needed, just read the app's own form list.
  const forms = await listFormLinkNames(token)
  const formChecks: Array<[string, string]> = [
    [FORM_LINK_NAME, 'Workforce Logs (lib/zohoCreator.ts)'],
    [RTA_LOGS_FORM_LINK_NAME, 'Workforce RTA Logs (lib/zohoWebappRequest.ts)'],
  ]
  if (forms.length === 0) {
    l(`Could not list forms (check ZohoCreator.meta.READ scope / re-authorize) — cannot verify FORM_LINK_NAME constants.`)
  } else {
    for (const [name, label] of formChecks) {
      if (forms.includes(name)) l(`${label} FORM_LINK_NAME="${name}" confirmed — it exists in this app's form list.`)
      else l(`WARNING: ${label} FORM_LINK_NAME="${name}" was NOT found among this app's forms: [${forms.join(', ')}]. Update the constant to the correct one before relying on this integration.`)
    }
  }

  // Same check for the three REPORT link names this scan reads — Get Records
  // returns a generic "Invalid API URL format" (no report list) when one is
  // wrong, so cross-check against Zoho's own report list too instead of
  // guessing blind a second time.
  const reports = await listReportLinkNames(token)
  const reportChecks: Array<[string, string]> = [
    [REPORT_LINK_NAME, 'Workforce Logs (x_Account/Site source)'],
    [CATEGORIES_REPORT_LINK_NAME, 'Categories'],
    [SUBCATEGORIES_REPORT_LINK_NAME, 'Sub-Categories'],
  ]
  if (reports.length === 0) {
    l(`Could not list reports (check ZohoCreator.meta.READ scope / re-authorize) — proceeding with the configured report link names as-is.`)
  } else {
    for (const [name, label] of reportChecks) {
      if (reports.includes(name)) l(`${label} REPORT_LINK_NAME="${name}" confirmed — it exists in this app's report list.`)
      else l(`WARNING: ${label} REPORT_LINK_NAME="${name}" was NOT found among this app's reports: [${reports.join(', ')}]. Update the constant in lib/zohoFieldScan.ts to the correct one — the Get Records call for it will otherwise keep failing.`)
    }
  }

  const found = new Map<string, DiscoveredOption>() // key: field_name|zoho_id
  let recordsScanned = 0

  // ── x_Account / Site — still discovered from historical Workforce Logs
  // records (no master report for these two exists yet). ────────────────────
  const logRecords = await fetchAllRecords(token, REPORT_LINK_NAME, l)
  recordsScanned += logRecords.length
  for (const rec of logRecords) {
    for (const field of LOG_LOOKUP_FIELDS) {
      for (const pair of extractPairs(field, rec[field])) {
        found.set(`${pair.field_name}|${pair.zoho_id}`, pair)
      }
    }
  }

  // ── Category — full canonical list from the dedicated Categories report ──
  const categoryRecords = await fetchAllRecords(token, CATEGORIES_REPORT_LINK_NAME, l)
  recordsScanned += categoryRecords.length
  for (const rec of categoryRecords) {
    const zohoId = rec.ID != null ? String(rec.ID) : null
    const displayValue = rec.Category
    if (zohoId && displayValue) {
      found.set(`Category|${zohoId}`, { field_name: 'Category', zoho_id: zohoId, display_value: String(displayValue), parent_zoho_id: null })
    }
  }

  // ── Sub_Categories — full canonical list, each linked to its parent
  // Category via this report's own Workforce_RTA_Categories lookup field. ───
  const subCategoryRecords = await fetchAllRecords(token, SUBCATEGORIES_REPORT_LINK_NAME, l)
  recordsScanned += subCategoryRecords.length
  for (const rec of subCategoryRecords) {
    const zohoId = rec.ID != null ? String(rec.ID) : null
    const displayValue = rec.Sub_Category
    const parent = rec.Workforce_RTA_Categories
    const parentId = parent && typeof parent === 'object' && parent.ID != null ? String(parent.ID) : null
    if (zohoId && displayValue) {
      found.set(`Sub_Categories|${zohoId}`, { field_name: 'Sub_Categories', zoho_id: zohoId, display_value: String(displayValue), parent_zoho_id: parentId })
    }
  }

  const options = [...found.values()]
  let upsertOk = true
  if (options.length > 0) {
    const { error } = await getSupabaseAdmin()
      .from('wfm_zoho_field_options')
      .upsert(
        options.map(o => ({ ...o, last_seen_at: new Date().toISOString() })),
        { onConflict: 'field_name,zoho_id' }
      )
    if (error) { l(`Supabase upsert failed: ${error.message}`); upsertOk = false }
  }

  // Category/Sub_Categories are exclusively sourced from their master reports
  // above (unlike x_Account/Site, which only ever accumulate) — so a value
  // removed/renamed in Zoho should stop being offered as a suggestion here
  // too, instead of lingering forever. Skipped whenever a report's fetch came
  // back empty OR the upsert above failed (e.g. wfm_zoho_field_options is
  // missing the parent_zoho_id column because sql/zoho_field_options.sql's
  // ALTER TABLE hasn't been run yet) — otherwise a failed write that never
  // actually saved the fresh rows would still be followed by this deleting
  // every OLD row, wiping the table instead of merely failing to update it.
  if (upsertOk) {
    const admin = getSupabaseAdmin()
    for (const [fieldName, records] of [
      ['Category', categoryRecords],
      ['Sub_Categories', subCategoryRecords],
    ] as const) {
      const currentIds = records.map((r: any) => r.ID != null ? String(r.ID) : null).filter((id: string | null): id is string => !!id)
      if (currentIds.length === 0) continue
      const { error } = await admin
        .from('wfm_zoho_field_options')
        .delete()
        .eq('field_name', fieldName)
        .not('zoho_id', 'in', `(${currentIds.map(id => `"${id}"`).join(',')})`)
      if (error) l(`Cleanup delete failed for ${fieldName}: ${error.message}`)
    }
  } else {
    l('Skipping stale-option cleanup because the upsert above failed — existing options left untouched.')
  }

  const optionsDiscovered = LOOKUP_FIELDS.reduce((acc, f) => {
    acc[f] = options.filter(o => o.field_name === f).length
    return acc
  }, {} as Record<LookupField, number>)

  l(`Scanned ${recordsScanned} record(s) total (logs + categories + sub-categories). Discovered: ${LOOKUP_FIELDS.map(f => `${f}=${optionsDiscovered[f]}`).join(', ')}.`)
  return { recordsScanned, optionsDiscovered, log }
}
