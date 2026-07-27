// lib/zohoCreator.ts
// Server-side only — creates a record in the client's Zoho Creator
// "All Workforce Logs" report (app: ece-time-tracker) whenever a breach is
// detected for an account that has Workforce Logs reporting enabled
// (Settings > Zoho Integrations > per-account toggle). Uses the SAME stored
// Zoho refresh token as the Cliq integration (lib/zohoAuth.ts) — Creator
// access just needs its scope added to the one self-client, re-authorized
// once via the existing "Authorize with Zoho" button.
//
// Everything below is a plain constant, not an env var — none of it is a
// secret (only ZOHO_CLIQ_CLIENT_ID/SECRET/SUPABASE_SERVICE_ROLE_KEY are,
// and those already live in Vercel for the Cliq integration). If any of
// these ever change, just edit this file.

import { getZohoAccessToken } from './zohoAuth'
import type { ZohoLookupChoice } from './types'

const CREATOR_API_BASE = 'https://www.zohoapis.com/creator/v2.1'

export const OWNER_NAME    = 'ececonsultinggroup'
export const APP_LINK_NAME = 'ece-time-tracker'

// Creator's Add-Record API writes to a FORM, not the "All_Workforce_Logs_
// RTA_View" REPORT the client linked (forms are for submitting data, reports
// are filtered views of it — Zoho's API only accepts writes at the form).
// "Workforce_Logs" is a best guess based on Zoho's own naming convention:
// a default report is auto-named "All_<FormName>", and this one has an
// extra "_RTA_View" suffix on top of that pattern, implying the underlying
// form is called "Workforce_Logs". lib/zohoFieldScan.ts's scan cross-checks
// this guess against Zoho's own Meta API (the actual list of forms in the
// app) and flags a mismatch in the scan log — fix this constant if it does.
export const FORM_LINK_NAME = 'Workforce_Logs'

// ── Lookup field choices ──────────────────────────────────────────────────
// x_Account, Category, Sub_Categories, and Site are all Zoho lookup fields.
// Rather than guessing at a separate "Accounts" source form to search at
// write-time, each account's Settings stores a value already resolved by
// lib/zohoFieldScan.ts's daily scan of existing records: either a known
// Zoho record ID (picked from the autocomplete list, most reliable) or,
// when nothing matched, plain typed text (Zoho resolves it by display value
// — untested against a live write, see CLAUDE.md). Blank means "don't set
// this field on the record at all".

// x_Account is a MULTI-lookup (the sample record showed an array) — written
// as an array; the other three are single lookups — written bare. Format
// for an ID-based value vs a typed-text value is a best guess (see
// CLAUDE.md) and may need adjusting after the first live test.
function lookupValue(choice: ZohoLookupChoice | undefined, multi: boolean): any {
  if (!choice) return undefined
  const single = choice.id ? Number(choice.id) : choice.text ? choice.text : undefined
  if (single === undefined) return undefined
  return multi ? [single] : single
}

export interface WorkforceLogInput {
  account:      ZohoLookupChoice   // x_Account — required for a meaningful record
  category?:    ZohoLookupChoice
  subCategory?: ZohoLookupChoice
  site?:        ZohoLookupChoice
  remarks:      string             // auto-generated breach description
  status?:      string             // defaults to 'Resolved' per client's choice
}

export async function createWorkforceLogRecord(input: WorkforceLogInput): Promise<void> {
  const token = await getZohoAccessToken()

  const data: Record<string, any> = {
    Remarks: input.remarks,
    Status:  input.status || 'Resolved',
    NTE_NOD: 'No',
    Coached: 'No',
  }
  const account = lookupValue(input.account, true)
  if (account !== undefined) data.x_Account = account
  const category = lookupValue(input.category, false)
  if (category !== undefined) data.Category = category
  const subCategory = lookupValue(input.subCategory, false)
  if (subCategory !== undefined) data.Sub_Categories = subCategory
  const site = lookupValue(input.site, false)
  if (site !== undefined) data.Site = site

  const url = `${CREATOR_API_BASE}/${OWNER_NAME}/${APP_LINK_NAME}/form/${FORM_LINK_NAME}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body: any = await res.json().catch(() => ({}))

  if (!res.ok || body.code !== 3000) {
    throw new Error(`Zoho Creator add-record failed: ${JSON.stringify(body).substring(0, 300)}`)
  }
}
