@AGENTS.md
# WFM Live Dashboard V2 — Claude Code Instructions

## Deployment

### Trigger phrases (IMPORTANT)
When the user says **"go live"** or **"make it live"**, deploy this project to
production using the steps below, then post the update to Hermes (see next section).
When the user says **"push to dev"**, deploy to the test/dev target only and do
NOT change production.

This project deploys via **git** (Next.js app, auto-deployed from the repo).

- **Repo:**            `origin` → https://github.com/ecewfm/wfm-live-dashboard.git
- **Production branch:** `main`
- **Go live:**  push to production
  ```
  git push origin main
  ```
- **Push to dev:** there is currently **no separate dev/staging branch** — `main` is the
  only branch. If a dev branch/target is added later, wire it up here. Until then,
  "push to dev" has no target and should be confirmed with the user before doing anything.
- Build/verify before shipping:
  ```
  npm run build
  ```

## Hermes API

All updates, bugs, and features must be logged to Hermes after changes.
Always read `TASK-API.md` before posting to the Hermes API.

- Endpoint:   https://workforce-hermes.vercel.app/api/task
- Task ID:    jd76naj5zhp39xqt6wbfsh3xfn89hd8f
- API access: https://workforce-hermes.vercel.app/api/task?taskId=jd76naj5zhp39xqt6wbfsh3xfn89hd8f
- Auth:       x-api-key header (key: hermes_4fa53bf02ab1566844420de3681e050f02214601fb2c1976)

This is the canonical Hermes task ("**WFM Live v2**") for **WFM Live Dashboard V2** —
always use this task ID for all Hermes updates (notes, bugs, features) on THIS project
unless told otherwise. Do NOT reuse another project's task ID.

### Quick reference

- New feature   → POST resource=feature  { name, description, suggestedBy }
- New bug       → POST resource=bug      { name, description, suggestedBy }
- Note/update   → POST resource=note     { text, writer }
- Mark complete → PATCH resource=feature&id=<id> { status: "completed" }

### Reporting recent changes / updates to Hermes (PowerShell)

Post a note describing what changed. Do this on every go-live, and any time the
user asks to "report to Hermes" / "log this update".

```powershell
Invoke-RestMethod -Method POST `
  -Uri "https://workforce-hermes.vercel.app/api/task?taskId=jd76naj5zhp39xqt6wbfsh3xfn89hd8f&resource=note" `
  -Headers @{"x-api-key"="hermes_4fa53bf02ab1566844420de3681e050f02214601fb2c1976"} `
  -ContentType "application/json" `
  -Body '{"text":"<what changed>","writer":"Rod"}'
```

Full schema → see TASK-API.md

## Zoho Cliq breach notifications

Migrated from an older Google Apps Script tool's Cliq integration. Runs
entirely in **this** app via a Vercel Cron job — NOT in the `wfm-live-scraper`
repo (that was tried first, then moved here once this project confirmed it's
on Vercel Pro, which allows a real 1-minute cron for free; Hobby plan only
allows once-a-day cron, which is why it didn't start here originally).

- `vercel.json` — `crons` config, hits `/api/cliq/scan` every minute.
- `app/api/cliq/scan/route.ts` — the Cron-triggered scan (protected by
  `CRON_SECRET`, which Vercel auto-sends as a Bearer token when that env var
  is set).
- `app/api/cliq/force-scan/route.ts` — same scan, no secret, triggered by the
  "Force Scan Now" button in Settings → Cliq Alerts.
- `lib/cliqScan.ts` — the actual orchestration (fetch every account's
  `wfm_settings` row → for ones with `cliq_channel` set, fetch live KPI/agent
  data per that account's own `data_source` config → run `lib/breaches.ts`'s
  `buildBreaches()` → send to Cliq if any breach found).
- `lib/breaches.ts` — the ONE canonical breach algorithm, shared by this scan
  AND the live Dashboard/Overview pages (`components/Dashboard.tsx` imports
  it too) — never duplicate this logic elsewhere.
- `lib/zohoAuth.ts` — mints Zoho access tokens from the ONE refresh token
  stored in Supabase (`wfm_cliq_oauth`, see below). Shared by every Zoho
  product this app talks to (Cliq + Creator) — one self-client, one stored
  refresh token, scopes for both requested together at authorize time.
- `lib/zohoCliq.ts` — posts to the Cliq message API using `lib/zohoAuth.ts`.
- `app/api/zoho/authorize` + `app/api/zoho/callback` — the ONE-TIME OAuth
  handshake (needs a public HTTPS redirect, which is why this lives in the
  Vercel app specifically). The callback route saves the resulting refresh
  token straight into `wfm_cliq_oauth` via `lib/supabaseAdmin.ts`'s
  service-role client — no copy/paste into an env var, no redeploy needed,
  same idea as the GAS predecessor's OAuth2 library silently persisting the
  token into `PropertiesService`. Triggered by the "Authorize with Zoho"
  button in the same Settings tab.
- `sql/cliq_oauth_token.sql` — creates `wfm_cliq_oauth` with RLS enabled and
  **no policies**, so the public anon key (used everywhere else in this app,
  including client-side) cannot read/write it. Only the `service_role` key
  bypasses RLS — that's why `lib/supabaseAdmin.ts` exists as a *separate*
  client from `lib/supabase.ts`; don't use it for anything else.

Required env vars (Vercel dashboard, NOT `NEXT_PUBLIC_` — server-only):
`ZOHO_CLIQ_CLIENT_ID`, `ZOHO_CLIQ_CLIENT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`
(from Supabase Dashboard → Project Settings → API — needed by the callback
route and by `lib/zohoCliq.ts` to reach `wfm_cliq_oauth`), and optionally
`CRON_SECRET` (recommended — without it, `/api/cliq/scan` accepts
unauthenticated requests).

Per-account cooldown (`wfm_settings.cliq_last_sent_at`, default 5 min,
configurable in Settings) and a 5-minute staleness suppression (same
`isDataStale()` threshold the dashboard's own "DATA NOT IN SYNC" overlay
uses) both apply on the scheduled scan — cooldown only advances on a
confirmed successful send. Force Scan bypasses cooldown, not staleness.

## Zoho Creator Workforce Logs reporting

Client-requested: every detected breach for an account with reporting enabled
also creates a record in Zoho Creator's "All Workforce Logs" report (app
`ece-time-tracker`, owner `ececonsultinggroup`). Runs in the SAME Vercel Cron
scan as Cliq alerts (`lib/cliqScan.ts`) — an account can have Cliq alerts,
Workforce Logs reporting, both, or neither, fully independently. There is
**no global on/off switch** for this one, only the per-account toggle (Cliq
has both; this was a deliberate scope choice — see chat history if that needs
to change).

- `lib/zohoCreator.ts` — `createWorkforceLogRecord()`. POSTs to the Creator
  v2.1 Add Record API for `FORM_LINK_NAME`. `x_Account`/`Category`/
  `Sub_Categories`/`Site` are all Zoho lookup fields, each written from a
  per-account `{id, text}` pair (`ZohoLookupChoice`, `lib/types.ts`) — `id`
  set means write by exact Zoho record ID (reliable), `text` set (no `id`)
  means write by plain display value (Zoho resolves it — unverified against
  a live write, see caveat below). No live "search Zoho for this name" call
  happens at write time anymore — see the field-scan feature below for why.
- `lib/cliqScan.ts` — per-account gate is `wf_logs_enabled && (zoho_account_id
  || zoho_account_name)` (all in `wfm_settings`), independent of the Cliq
  global-enable toggle. Cooldown (`wfm_settings.wf_logs_last_sent_at`) reuses
  the same global "Re-alert Frequency" minutes setting as Cliq — there's no
  separate one.
- `sql/zoho_workforce_logs.sql` — adds `wf_logs_enabled` plus an `(id, text)`
  column pair per lookup field (`zoho_account_id`/`zoho_account_name`,
  `zoho_category_id`/`_text`, `zoho_subcategory_id`/`_text`,
  `zoho_site_id`/`_text`) and `wf_logs_last_sent_at` to `wfm_settings`.
- Settings UI: Settings → **Zoho Integrations** tab (renamed from "Cliq
  Alerts" since it now covers both) → "WORKFORCE LOGS REPORTING — {account}"
  section, below the Cliq channel field. Each lookup field is a single
  `<input list>`/`<datalist>` combobox (`ZohoLookupField` in
  `components/SettingsModal.tsx`) — picking a suggestion stores its ID,
  typing something new stores it as plain text instead.

No env vars for any of this — none of it is a secret, so it's all plain
constants at the top of `lib/zohoCreator.ts`/`lib/zohoFieldScan.ts`:
- `OWNER_NAME` (`ececonsultinggroup`), `APP_LINK_NAME` (`ece-time-tracker`) —
  known from the client's own app URL.
- `FORM_LINK_NAME` (`lib/zohoCreator.ts`) — **CONFIRMED**, no longer a guess.
  The Creator Add-Record API writes to a *form*, not the
  `All_Workforce_Logs_RTA_View` *report* the client linked (forms are for
  submitting data, reports are filtered views of it). Set to
  `'Workforce_RTA_Logs'` — confirmed via the field-scan feature below's Meta
  API cross-check (the app's actual form list includes `Workforce_RTA_Logs`,
  a near-exact match for the report name, just reordered).

Status on every auto-created record is hardcoded `Resolved` (client's explicit
choice — these are being treated as an audit log, not something needing
follow-up review). `NTE_NOD` and `Coached` are hardcoded `No`.

The exact Zoho Creator v2.1 field payload shapes (lookup fields as ID vs
array-of-ID, whether `Category`/`Sub_Categories` accept a bare numeric ID or
plain text for an unresolved value) are implemented from Zoho's documented
API behavior but have **not yet been verified against a live write** —
expect to debug/adjust the payload in `lib/zohoCreator.ts` on the first real
test, the same way the Cliq send format needed no adjustment but this
integration is new and untested.

### Zoho field option discovery (Category/Sub_Categories/x_Account/Site)

Rather than requiring anyone to dig up raw Zoho record IDs for the four
lookup fields above, `lib/zohoFieldScan.ts`'s `scanZohoFields()` reads every
existing record in the `All_Workforce_Logs_RTA_View` **report** (reading is a
report-level operation, unlike writing — no `FORM_LINK_NAME` needed here) and
collects the unique `{ID, display_value}` pairs ever used for each of those
four fields into `wfm_zoho_field_options` (`sql/zoho_field_options.sql`).
The Settings UI's comboboxes read straight from that table (via
`loadZohoFieldOptions()` in `lib/settings.ts`, anon client — nothing
sensitive in there) to offer real, previously-used values as suggestions.

- `app/api/zoho/scan-fields/route.ts` — daily Vercel Cron (`vercel.json`,
  `0 3 * * *`), `CRON_SECRET`-protected same as `/api/cliq/scan`.
- `app/api/zoho/force-scan-fields/route.ts` — the "Scan Zoho Field Options
  Now" button in the same Settings tab, no auth (matches this app's existing
  posture).
- Pagination uses Zoho's `record_cursor` response header, looping until it's
  absent.
- Every scan also calls Zoho's Meta API (`GET .../meta/{owner}/{app}/forms`,
  needs the `ZohoCreator.meta.READ` scope) to list the app's actual forms and
  cross-checks `lib/zohoCreator.ts`'s `FORM_LINK_NAME` guess against that
  list — confirms it or flags a mismatch right in the scan log, so nobody
  has to click through the Creator builder by hand to verify it.

A brand-new account/category/site that's never appeared in an existing Zoho
record won't show up as a suggestion — the combobox's free-text fallback
covers that case (stored as `_text`, no `_id`) until it's been written once
and shows up in a later scan.

## Zoho "Workforce RTA Logs" webapp-request reporting

A SEPARATE Zoho integration from Workforce Logs above — different intake,
different payload shape, no shared code beyond the same app/owner constants
and the same `lib/zohoAuth.ts` token (Creator record-create scope on this
self-client already covers the whole `ece-time-tracker` app, not per-form, so
no new OAuth scope/re-authorization was needed). Runs in the SAME scan as
Cliq + Workforce Logs (`lib/cliqScan.ts`) — gated ONLY by its own per-account
toggle, same "no global switch" posture as Workforce Logs.

Submits to a generic Zoho-side "webapp request" intake (the
`All_Webapp_Api_Requests` form, same app) that a Zoho-side Deluge script
watches, dispatching processing based on a `Form` field's value — confirmed
live via a debug log for an existing, unrelated "Dispute Log" `Form` type
(that script fills in `Synced`/`ID`/`Added_Time`/`Function_Notes` itself
*after* processing a submission — none of those four are ours to set). Our
`Form` value is `"Workforce RTA Logs"`; the actual payload rides inside a
`Values_field` string (JSON-encoded).

- `lib/zohoWebappRequest.ts` — `createAccountBreachRtaLog(accountId, remarks)`.
  Builds the "Account Wide" shape (one of three `selection_type` variants the
  Zoho programmer's example JSONs showed — "Site Wide"/"Employees" are for
  different, non-breach use cases and aren't implemented here):
  `{ selection_type: "Account Wide", sites: [], accounts: [accountId],
  employee: "", category, sub_category, remarks, url_link: "",
  recommendation: "", status: "Pending", requested_by:
  "rta@ececontactcenters.com" }`. `category`/`sub_category` are FIXED to
  `"Service Level & Volume Management"` / `"Understaffing Alert"` for every
  report regardless of the underlying breach type (SLA, queue, agent-status,
  etc.) — an explicit scope decision, not a per-breach-type mapping (see chat
  history if that needs to change). No Zoho lookup resolution at all — unlike
  Workforce Logs' `x_Account`/`Category`/etc., this sends the plain
  `accountId` string directly, no ID/master-list matching needed.
- `FORM_LINK_NAME` (`'All_Webapp_Api_Requests'`) — **UNVERIFIED against a live
  write**, assumed same for form and report (unlike `Workforce_RTA_Logs`,
  which needed correcting once already — see above). If a write here 404s the
  same way that one did, it needs the same Meta-API form-list cross-check
  `lib/zohoFieldScan.ts` already does for the other form.
- `lib/cliqScan.ts` — per-account gate is just `rta_logs_enabled` (no account
  link requirement, unlike Workforce Logs, since there's no lookup to
  resolve). Cooldown (`wfm_settings.rta_logs_last_sent_at`) reuses the same
  global "Re-alert Frequency" setting as Cliq/Workforce Logs. `remarks` is the
  exact same `BreachRow[] -> text` formatting (`formatWorkforceLogRemarks`)
  Workforce Logs already uses — one shared formatter, two different Zoho
  destinations.
- `sql/zoho_rta_logs.sql` — adds `rta_logs_enabled` + `rta_logs_last_sent_at`
  to `wfm_settings`.
- Settings UI: Settings → **Zoho Integrations** tab → "WORKFORCE RTA LOGS —
  {account}" section, below Workforce Logs Reporting. Just a checkbox — no
  lookup comboboxes, since category/sub_category are fixed constants and the
  account is sent as a plain string.
- **"Test Workforce RTA Logs" button** — same section, always visible
  (independent of the enable toggle). No Zoho sandbox exists for this intake,
  so this sends a REAL submission tagged `[TEST]` in its remarks (safe to
  delete in Zoho afterward) via `testAccountBreachRtaLog()` in
  `lib/zohoWebappRequest.ts` → `POST /api/zoho/test-rta-log`. On success shows
  an inline confirmation; on failure (bad token, Zoho rejecting the payload,
  wrong `FORM_LINK_NAME`, etc.) opens a popup showing the HTTP status, the
  exact request payload sent, and Zoho's raw response body — this is the
  fastest way to confirm/fix the still-unverified `FORM_LINK_NAME` guess above
  without digging through Vercel logs.