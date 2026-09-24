// lib/zohoWebappRequest.ts
// Server-side only — submits to the client's generic Zoho "webapp request"
// intake (the "All_Webapp_Api_Requests" form/report, SAME app as Workforce
// Logs: ece-time-tracker / ececonsultinggroup — see lib/zohoCreator.ts). A
// Zoho-side Deluge script watches this intake and dispatches processing based
// on the `Form` field's value — confirmed live for an existing "Dispute Log"
// Form type (a completely separate integration, not ours) via a debug log
// showing it filled in `Synced`/`ID`/`Added_Time`/`Function_Notes` itself
// AFTER processing a submission — none of those four are ours to set. We only
// ever write `Form`, `Values_field` (a JSON-encoded string, shape below), and
// `Added_User` (identifies OUR system as the submitter, mirroring how that
// existing Dispute Log submission carried its own submitter's name there).
//
// Our Form type is "Workforce RTA Logs" — three selection_type shapes exist
// (per 3 example JSONs the Zoho programmer sent): "Site Wide" (sites[] only),
// "Account Wide" (sites[] + accounts[]), "Employees" (a single employee
// email). This file only implements the "Account Wide" shape, for automated
// per-account breach reporting — the other two are for different, manual
// use cases outside this app's scope.
//
// Uses the SAME stored Zoho refresh token as Cliq/Workforce Logs
// (lib/zohoAuth.ts) — confirmed no new scope needed: Creator's Add Record
// API just needs {owner}/{app}/form/{form_link_name}, and record-create scope
// on this self-client already covers the whole app, not per-form.

import { getZohoAccessToken } from './zohoAuth'
import { OWNER_NAME, APP_LINK_NAME } from './zohoCreator'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'

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

const REQUESTED_BY = 'rta@ececontactcenters.com'

// Fixed for every account-wide breach report, regardless of whether the
// underlying breach is SLA, queue, or agent-status related — explicit
// decision (see chat history), not a per-breach-type mapping.
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

async function submitWebappRequest(valuesField: WorkforceRtaLogPayload): Promise<WebappRequestResult> {
  const token = await getZohoAccessToken()

  const url = `${CREATOR_API_BASE}/data/${OWNER_NAME}/${APP_LINK_NAME}/form/${FORM_LINK_NAME}`
  const requestBody = {
    data: {
      Form: FORM_TYPE,
      Values_field: JSON.stringify(valuesField),
      Added_User: ADDED_USER,
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
export async function createAccountBreachRtaLog(accountDisplayName: string, remarks: string): Promise<void> {
  const result = await submitWebappRequest({
    selection_type: 'Account Wide',
    sites: [],
    accounts: [accountDisplayName],
    employee: '',
    category: BREACH_CATEGORY,
    sub_category: BREACH_SUB_CATEGORY,
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
// generic "it failed" message.
export async function testAccountBreachRtaLog(accountDisplayName: string): Promise<WebappRequestResult> {
  const ts = new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  const remarks = `[TEST] Manual connectivity test from WFM Live Dashboard Settings for ${accountDisplayName} at ${ts}. Safe to ignore/delete in Zoho.`
  return submitWebappRequest({
    selection_type: 'Account Wide',
    sites: [],
    accounts: [accountDisplayName],
    employee: '',
    category: BREACH_CATEGORY,
    sub_category: BREACH_SUB_CATEGORY,
    remarks,
    url_link: '',
    recommendation: '',
    status: 'Pending',
    requested_by: REQUESTED_BY,
  })
}
