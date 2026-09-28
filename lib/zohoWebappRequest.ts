// lib/zohoWebappRequest.ts
// Server-side only — submits to the client's generic Zoho "webapp request"
// intake (the "All_Webapp_Api_Requests" form/report, SAME app as Workforce
// Logs: ece-time-tracker / ececonsultinggroup — see lib/zohoCreator.ts).
//
// Unlike the "Dispute Log" Form type also seen in this same intake (a
// completely separate integration, not ours — a Zoho-side script processes
// THAT one asynchronously and fills in Synced/ID/Added_Time/Function_Notes
// itself afterward), there's no evidence of an equivalent processing script
// for our "Workforce RTA Logs" Form type — so per the user (2026-09-24), we
// submit a COMPLETE row ourselves: `Form`, `Added_User`, `ID` (our own
// generated identifier — NOT Zoho's reserved record ID field; a distinctly
// namespaced string so it can never collide with one), `Values_field` (the
// JSON payload, shape below), and `Function_Notes` (a plain-text summary of
// what this submission contains, for a human scanning the report to read
// without having to decode Values_field's JSON).
//
// Our Form type is "Workforce RTA Logs" — three selection_type shapes exist
// (per 3 example JSONs the Zoho programmer sent): "Site Wide" (sites[] only),
// "Account Wide" (sites[] + accounts[]), "Employees" (a single employee
// email). This file only implements the "Account Wide" shape, for automated
// per-account breach reporting — the other two are for different, manual
// use cases outside this app's scope.
//
// Uses the SAME stored Zoho refresh token as Cliq/Workforce Logs
// (lib/zohoAuth.ts) — needs ZohoCreator.form.CREATE scope specifically (the
// Add Record API writes to a form, never a report — see
// app/api/zoho/authorize/route.ts for the scope list/history).

import { getZohoAccessToken } from './zohoAuth'
import { OWNER_NAME, APP_LINK_NAME } from './zohoCreator'

// Deliberately the OLDER Creator REST API v2 (creator.zoho.com), NOT the
// newer v2.1 (www.zohoapis.com/creator/v2.1) this file originally used — a
// live test (2026-09-24) hit "Permission denied to add record(s)" (code
// 2899) on v2.1 even with the correct ZohoCreator.form.CREATE scope. The
// pre-existing Apps Script "Workforce Apollo" tool (Code.gs's
// _createZohoRecord()) successfully writes to this EXACT SAME form
// (WebApp_API_Requests, same app/owner) using this older endpoint — same
// Authorization header scheme, same `{ data: {...} }` body, same
// `code === 3000` success check — so whatever permission gate v2.1 enforces
// that this app's authorized account doesn't clear, the older endpoint
// evidently doesn't apply it the same way. Matched exactly, including
// dropping the "/data/" path segment v2.1 requires but v2 doesn't.
const CREATOR_API_BASE = 'https://creator.zoho.com/api/v2'

// CONFIRMED via Zoho's Meta API (lib/zohoFieldScan.ts's scan lists every form
// in the app and cross-checks this against it) — the app's actual form list
// has "WebApp_API_Requests" (no "All_" prefix, unlike the original guess
// "All_Webapp_Api_Requests", which was NOT in the list and would have 404'd).
export const FORM_LINK_NAME = 'WebApp_API_Requests'

const FORM_TYPE = 'Workforce RTA Logs'

// Identifies this app as the submitter — same idea as the submitter name
// seen on an existing (unrelated) Dispute Log submission from a different
// integration into this same intake.
const ADDED_USER = 'wfm_live_dashboard'

// Zoho's own processing script validates this against its ECE Time Tracker
// employee list — confirmed live (2026-09-25): "rta@ececontactcenters.com"
// isn't a real employee record there ("Requested By employee was not found
// in ECE Time Tracker"). Using the same WFM Admin / Power BI account
// (powerbi@ececontactcenters.net) already authorized for this whole
// integration (see app/api/zoho/authorize/route.ts) — a real employee record
// that's already confirmed to exist and be recognized by Zoho.
const REQUESTED_BY = 'powerbi@ececontactcenters.net'

// DEFAULT category/sub_category for accounts that haven't opted into AI
// categorization (lib/geminiClassifier.ts) — used regardless of whether the
// underlying breach is SLA, queue, or agent-status related. An account with
// rta_ai_categorization_enabled set gets a real, per-breach-type
// category/sub_category from Gemini instead (createAccountBreachRtaLog's
// optional category/subCategory params below) — see
// sql/gemini_ai_categorization.sql.
const BREACH_CATEGORY = 'Service Level & Volume Management'
const BREACH_SUB_CATEGORY = 'Understaffing Alert'

interface WorkforceRtaLogPayload {
  selection_type: 'Site Wide' | 'Account Wide' | 'Employees'
  sites: string[]
  accounts: string[]
  employee: string
  category: string
  sub_category: string
  remarks: string
  url_link: string
  recommendation: string
  status: string
  requested_by: string
}

// Full round-trip detail, surfaced by the Settings "Test Workforce RTA Logs"
// button so a failure shows exactly what was sent and what Zoho said back,
// instead of just a truncated error string.
export interface WebappRequestResult {
  ok: boolean
  status: number
  requestUrl: string
  requestBody: any
  responseBody: any
}

// A human-readable one-liner describing this submission, written into
// Function_Notes so anyone scanning the report can tell what it is without
// decoding Values_field's JSON.
function buildFunctionNotes(valuesField: WorkforceRtaLogPayload): string {
  const target = valuesField.selection_type === 'Employees'
    ? valuesField.employee
    : [...valuesField.sites, ...valuesField.accounts].join(', ')
  return `WFM Live Dashboard automated submission — ${valuesField.selection_type} (${target}), `
    + `${valuesField.category} / ${valuesField.sub_category}. Remarks: ${valuesField.remarks}`
}

// Our OWN identifier for this submission — Zoho's actual record ID (its
// reserved, auto-assigned "ID" field, e.g. the 19-digit numbers seen on every
// other Zoho record throughout this app) is never something we can choose,
// so this is deliberately namespaced (never purely numeric) to guarantee it
// can't collide with one.
function generateRequestId(): string {
  return `wfm-rta-${crypto.randomUUID()}`
}

async function submitWebappRequest(valuesField: WorkforceRtaLogPayload): Promise<WebappRequestResult> {
  const token = await getZohoAccessToken()

  const url = `${CREATOR_API_BASE}/${OWNER_NAME}/${APP_LINK_NAME}/form/${FORM_LINK_NAME}`
  const requestBody = {
    data: {
      Form: FORM_TYPE,
      Added_User: ADDED_USER,
      ID: generateRequestId(),
      Values_field: JSON.stringify(valuesField),
      Function_Notes: buildFunctionNotes(valuesField),
    },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  const responseBody: any = await res.json().catch(() => ({}))

  return {
    ok: res.ok && responseBody.code === 3000,
    status: res.status,
    requestUrl: url,
    requestBody,
    responseBody,
  }
}

// One submission per account per scan — every current breach flattened into
// a single remarks string (caller passes this in, see lib/cliqScan.ts's
// formatWorkforceLogRemarks for the exact BreachRow[] -> text formatting
// already used for the OTHER Zoho integration; reused verbatim here rather
// than duplicated).
//
// `sites` is REQUIRED (non-empty) by Zoho's own processing script for
// "Account Wide" submissions — confirmed live (2026-09-24) via its own
// validation feedback written back into Function_Notes: "At least one site
// is required for Account Wide." (this also confirms a real Zoho-side
// Deluge script DOES watch Form=="Workforce RTA Logs" submissions here and
// validates/processes them, overwriting whatever Function_Notes we
// originally sent). An account can span MORE than one site (e.g. both
// Manila and Dumaguete) — per-account list lives in
// wfm_settings.rta_sites, a comma-separated field SEPARATE from Workforce
// Logs' single-value Site lookup, which can't represent more than one.
// `category`/`subCategory` — optional overrides for the fixed
// BREACH_CATEGORY/BREACH_SUB_CATEGORY defaults, used by
// lib/geminiClassifier.ts's AI-based per-breach-type grouping (an
// account can opt into this — see sql/gemini_ai_categorization.sql).
// Must be a REAL Zoho Category/Sub-Category pairing when provided — the
// caller (lib/cliqScan.ts) is responsible for validating that before
// calling this, same as every other plain-text field this integration
// sends (Zoho's own script validates account/site/requested_by the same
// way — see the comments below and in lib/geminiClassifier.ts).
export async function createAccountBreachRtaLog(
  accountDisplayName: string, remarks: string, sites: string[],
  category: string = BREACH_CATEGORY, subCategory: string = BREACH_SUB_CATEGORY
): Promise<void> {
  const result = await submitWebappRequest({
    selection_type: 'Account Wide',
    sites,
    accounts: [accountDisplayName],
    employee: '',
    category,
    sub_category: subCategory,
    remarks,
    url_link: '',
    recommendation: '',
    status: 'Pending',
    requested_by: REQUESTED_BY,
  })
  if (!result.ok) {
    throw new Error(`Zoho webapp request failed: ${JSON.stringify(result.responseBody).substring(0, 300)}`)
  }
}

// Manual "Test Workforce RTA Logs" button (Settings > Zoho Integrations) —
// sends a real submission (there's no Zoho sandbox for this intake) tagged
// as a test in its remarks, so it's obvious which record in Zoho is safe to
// ignore/delete. Returns the full round-trip instead of throwing, so the
// caller can show request/response detail on failure rather than just a
// generic "it failed" message. `sites` — see createAccountBreachRtaLog's
// comment; required for the same reason.
//
// `category`/`subCategory`/`remarksOverride` — used when the account being
// tested has AI Categorization enabled: app/api/zoho/test-rta-log/route.ts
// classifies the account's REAL current breaches (same as the live scan)
// and calls this once per group with that group's picks, instead of the one
// generic "[TEST] Manual connectivity test" message every non-AI test sends.
// `remarksOverride` is still prefixed with `[TEST]` so it's just as safe to
// spot/delete in Zoho as the default message.
export async function testAccountBreachRtaLog(
  accountDisplayName: string, sites: string[] = [],
  category?: string, subCategory?: string, remarksOverride?: string
): Promise<WebappRequestResult> {
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const remarks = remarksOverride
    ? `[TEST] ${remarksOverride}`
    : `[TEST] Manual connectivity test from WFM Live Dashboard Settings for ${accountDisplayName} at ${ts}. Safe to ignore/delete in Zoho.`
  return submitWebappRequest({
    selection_type: 'Account Wide',
    sites,
    accounts: [accountDisplayName],
    employee: '',
    category: category || BREACH_CATEGORY,
    sub_category: subCategory || BREACH_SUB_CATEGORY,
    remarks,
    url_link: '',
    recommendation: '',
    status: 'Pending',
    requested_by: REQUESTED_BY,
  })
}
