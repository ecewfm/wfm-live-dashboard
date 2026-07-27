// lib/zohoFieldScan.ts
// Scans every existing record in the client's "All_Workforce_Logs_RTA_View"
// Zoho Creator report and collects the unique {ID, display_value} pairs ever
// used for the Category, Sub_Categories, x_Account, and Site lookup fields —
// into wfm_zoho_field_options (sql/zoho_field_options.sql). The Settings UI
// reads that table to offer real, valid options as autocomplete suggestions
// instead of requiring someone to dig up raw Zoho record IDs by hand.
//
// Uses the REPORT link name directly (not the form) — reading records is a
// report-level operation in Zoho Creator's API, unlike writing (see
// lib/zohoCreator.ts, which needs the underlying form).
//
// Triggered by app/api/zoho/scan-fields (daily Vercel Cron) and
// app/api/zoho/force-scan-fields (the "Scan Zoho Field Options Now" button
// in Settings → Zoho Integrations).

import { getZohoAccessToken } from './zohoAuth'
import { getSupabaseAdmin } from './supabaseAdmin'
import { OWNER_NAME, APP_LINK_NAME, FORM_LINK_NAME } from './zohoCreator'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'
const REPORT_LINK_NAME = 'All_Workforce_Logs_RTA_View'

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

interface DiscoveredOption { field_name: LookupField; zoho_id: string; display_value: string }

// A lookup field's value comes back as either a single object, an array of
// them (multi-lookup, e.g. x_Account), or blank/null. The display-name key
// is "zc_display_value" in the actual REST API response — "display_value"
// (checked first below) only ever showed up in the original Deluge debug
// dump, which formats fields differently than the raw v2.1 JSON does; kept
// as a fallback in case a future API version changes this back.
function extractPairs(fieldName: LookupField, raw: any): DiscoveredOption[] {
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : [raw]
  return items
    .filter(v => v && typeof v === 'object' && v.ID != null)
    .map(v => ({ field_name: fieldName, zoho_id: String(v.ID), display_value: String(v.display_value ?? v.zc_display_value ?? v.ID) }))
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

  // Confirm (or flag a mismatch in) the FORM_LINK_NAME guess used for writes
  // — no builder click-through needed, just read the app's own form list.
  const forms = await listFormLinkNames(token)
  if (forms.length === 0) {
    l(`Could not list forms (check ZohoCreator.meta.READ scope / re-authorize) — cannot verify FORM_LINK_NAME="${FORM_LINK_NAME}".`)
  } else if (forms.includes(FORM_LINK_NAME)) {
    l(`FORM_LINK_NAME="${FORM_LINK_NAME}" confirmed — it exists in this app's form list.`)
  } else {
    l(`WARNING: FORM_LINK_NAME="${FORM_LINK_NAME}" was NOT found among this app's forms: [${forms.join(', ')}]. Update the constant in lib/zohoCreator.ts to the correct one before relying on Workforce Logs reporting.`)
  }

  // Same check for the REPORT link name used to read/scan records — Get
  // Records returns a generic "Invalid API URL format" (no report list) when
  // this is wrong, so cross-check against Zoho's own report list too instead
  // of guessing blind a second time.
  const reports = await listReportLinkNames(token)
  if (reports.length === 0) {
    l(`Could not list reports (check ZohoCreator.meta.READ scope / re-authorize) — proceeding with REPORT_LINK_NAME="${REPORT_LINK_NAME}" as-is.`)
  } else if (reports.includes(REPORT_LINK_NAME)) {
    l(`REPORT_LINK_NAME="${REPORT_LINK_NAME}" confirmed — it exists in this app's report list.`)
  } else {
    l(`WARNING: REPORT_LINK_NAME="${REPORT_LINK_NAME}" was NOT found among this app's reports: [${reports.join(', ')}]. Update the constant in lib/zohoFieldScan.ts to the correct one — the Get Records call below will otherwise keep failing.`)
  }

  const found = new Map<string, DiscoveredOption>() // key: field_name|zoho_id
  let recordsScanned = 0
  let cursor: string | null = null

  do {
    // Both link names are individually confirmed valid (logged above) via
    // Zoho's Meta API, which itself needed an explicit "/meta/" path segment
    // before {owner}/{app} to work — the parallel "/data/" segment below for
    // this actual record-read call is what that symmetry implies, and is
    // the fix for the generic "Invalid API URL format" (code 1000) error
    // this call was throwing without it.
    const url = `${CREATOR_API_BASE}/data/${OWNER_NAME}/${APP_LINK_NAME}/report/${REPORT_LINK_NAME}?field_config=all&max_records=200`
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` }
    if (cursor) headers.record_cursor = cursor

    const res = await fetch(url, { headers })
    const body: any = await res.json().catch(() => ({}))

    if (!res.ok) {
      // "no more records" is Zoho's normal end-of-pagination signal, not a
      // real failure — anything else is worth surfacing in the scan log.
      if (body?.code !== 3001) l(`Get Records failed: ${JSON.stringify(body).substring(0, 200)}`)
      break
    }

    const records: any[] = Array.isArray(body.data) ? body.data : []
    recordsScanned += records.length
    for (const rec of records) {
      for (const field of LOOKUP_FIELDS) {
        for (const pair of extractPairs(field, rec[field])) {
          found.set(`${pair.field_name}|${pair.zoho_id}`, pair)
        }
      }
    }

    cursor = res.headers.get('record_cursor')
  } while (cursor)

  const options = [...found.values()]
  if (options.length > 0) {
    const { error } = await getSupabaseAdmin()
      .from('wfm_zoho_field_options')
      .upsert(
        options.map(o => ({ ...o, last_seen_at: new Date().toISOString() })),
        { onConflict: 'field_name,zoho_id' }
      )
    if (error) l(`Supabase upsert failed: ${error.message}`)
  }

  const optionsDiscovered = LOOKUP_FIELDS.reduce((acc, f) => {
    acc[f] = options.filter(o => o.field_name === f).length
    return acc
  }, {} as Record<LookupField, number>)

  l(`Scanned ${recordsScanned} record(s). Discovered: ${LOOKUP_FIELDS.map(f => `${f}=${optionsDiscovered[f]}`).join(', ')}.`)
  return { recordsScanned, optionsDiscovered, log }
}
