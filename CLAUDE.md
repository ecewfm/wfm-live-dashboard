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
- `FORM_LINK_NAME` (`lib/zohoCreator.ts`) — set to `'Workforce_RTA_Logs'`, and
  a re-run of the field-scan's Meta API cross-check on 2026-09-24 shows this
  form is genuinely gone/renamed (client renamed it to `All_Workforce_Rta_Logs`
  — the scan will keep logging a WARNING every run for this constant).
  **Deliberately left unfixed, per user (2026-09-24)**: this direct-write path
  isn't the intended mechanism for getting records into Zoho's "All Workforce
  RTA Logs" list anymore (if it ever was) — that happens exclusively through
  the webapp-request portal below (`lib/zohoWebappRequest.ts`), where a
  Zoho-side Deluge script does its OWN lookup/validation across every field
  (account, category, sub-category, site) before creating the record, instead
  of us pre-resolving Zoho record IDs ourselves. Don't chase this warning or
  try to "fix" `FORM_LINK_NAME`/`createWorkforceLogRecord()` — it's expected
  to stay broken and unused.

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
and the same `lib/zohoAuth.ts` token. The first live write attempt
(2026-09-24, via the "Test Workforce RTA Logs" button) failed with Zoho error
2945 "invalid oauthscope" — turned out `ZohoCreator.report.CREATE` (the scope
requested at authorize time) isn't a real Zoho Creator scope; Creator writes
only ever go through forms, never reports, so the correct scope is
`ZohoCreator.form.CREATE` — fixed in `app/api/zoho/authorize/route.ts`. A
re-authorize (the same "Authorize with Zoho" Settings button) was required
after this fix, since Zoho only grants what was requested at consent time.
Runs in the SAME scan as Cliq + Workforce Logs (`lib/cliqScan.ts`) — gated
ONLY by its own per-account toggle, same "no global switch" posture as
Workforce Logs.

Submits to a generic Zoho-side "webapp request" intake (the
`WebApp_API_Requests` form, same app). **CONFIRMED live (2026-09-24)**: a
Zoho-side Deluge script DOES watch `Form=="Workforce RTA Logs"` submissions
here too (same as it does for the unrelated "Dispute Log" `Form` type) —
after a permission fix (see below) got a submission through, its validation
feedback came back written into `Function_Notes` itself: `"WORKFORCE RTA WEB
API - FAILED ... ERROR(S): - At least one site is required for Account
Wide."` — proving both that the script exists and processes our `Form` type,
and that it OVERWRITES whatever `Function_Notes` we send with its own
processing result. We still submit a complete row ourselves (the fields
below) since nothing else about its behavior (whether it also fills
`Synced`/`ID`/`Added_Time` before/after validating) is confirmed:
- `Form` = `"Workforce RTA Logs"`
- `Added_User` = `"wfm_live_dashboard"` (this app's own submitter identity —
  NOT copied from the Dispute Log example's `"powerbi_ececontactcenters24"`,
  which is that other integration's own service identity; flag if this
  should actually match something specific instead)
- `ID` = a self-generated, distinctly-namespaced string (`wfm-rta-<uuid>`,
  `generateRequestId()`) — NOT Zoho's own reserved/auto-assigned record ID
  field (the 19-digit numbers seen elsewhere throughout this app), which
  can't be set via the API anyway; this is just our own tracking id, kept far
  from that numeric format so it can never collide with one.
- `Values_field` = the JSON payload (shape below), JSON-encoded to a string.
- `Function_Notes` = a plain-text one-line summary of the submission
  (`buildFunctionNotes()`), so a human scanning the report doesn't have to
  decode `Values_field`'s JSON to see what it is.

- `lib/zohoWebappRequest.ts` — `createAccountBreachRtaLog(accountName,
  remarks, sites)`. Builds the "Account Wide" shape (one of three
  `selection_type` variants the Zoho programmer's example JSONs showed —
  "Site Wide"/"Employees" are for different, non-breach use cases and aren't
  implemented here): `{ selection_type: "Account Wide", sites, accounts:
  [accountName], employee: "", category, sub_category, remarks, url_link: "",
  recommendation: "", status: "Pending", requested_by:
  "powerbi@ececontactcenters.net" }`. `category`/`sub_category` are FIXED to
  `"Service Level & Volume Management"` / `"Understaffing Alert"` for every
  report regardless of the underlying breach type (SLA, queue, agent-status,
  etc.) — an explicit scope decision, not a per-breach-type mapping (see chat
  history if that needs to change). No Zoho lookup ID resolution for
  `accounts`/`category`/`sub_category`/`sites` — these are sent as plain
  text, resolved server-side by Zoho's own processing script (see below).
- **`requested_by` must be a real ECE Time Tracker employee** — confirmed
  live (2026-09-25): the original guess `"rta@ececontactcenters.com"` isn't
  one ("Requested By employee was not found in ECE Time Tracker"). Set to
  `"powerbi@ececontactcenters.net"` — the same WFM Admin/Power BI account
  this whole integration is already authorized as (see `app/api/zoho/
  authorize/route.ts`), a real, already-confirmed-valid employee record.
- **`sites` is REQUIRED (non-empty)** — confirmed live (2026-09-24, see
  above): `selection_type: "Account Wide"` fails Zoho's validation with no
  site at all. An account can genuinely span MORE than one site (e.g. both
  Manila and Dumaguete) — the client confirmed this — so this is its OWN
  per-account field, `wfm_settings.rta_sites` (comma-separated text), rather
  than reusing Workforce Logs' `zoho_site_text`/`_id`, which is a single Zoho
  lookup value and can't represent more than one. Settings UI: checkboxes
  for the known sites (`Manila`/`Dumaguete`/`Honduras` —
  `KNOWN_RTA_SITES` in `SettingsModal.tsx`, sourced from the separate Apollo
  webapp's own docs) plus a free-text box for anything not listed (that list
  can go stale the same way Apollo's own does). An account with none checked
  gets this submission skipped entirely (logged, not silently dropped)
  rather than sent to fail Zoho's validation every time.
- `FORM_LINK_NAME` (`'WebApp_API_Requests'`) — **CONFIRMED** via
  `lib/zohoFieldScan.ts`'s Meta API form-list cross-check (2026-09-24) — the
  original guess `'All_Webapp_Api_Requests'` was NOT in the app's form list
  and would have 404'd; the real name has no `All_` prefix and different
  casing. Every scan re-checks this constant automatically going forward.
- `category`/`sub_category` (fixed to `"Service Level & Volume Management"` /
  `"Understaffing Alert"`) — both confirmed to be REAL values in Zoho's own
  master lists (`wfm_zoho_field_options`, field_name `Category`/
  `Sub_Categories`, populated by the scan below) — `"Understaffing Alert"`'s
  `parent_zoho_id` correctly points at `"Service Level & Volume Management"`.
  Other real sub-categories exist under the same parent that map more
  precisely to specific breach types (e.g. `"High Abandonment Rate"`,
  `"SLA Escalation Incident P0/P1 Event"`, `"Queue Surge/Low Queue Alert"`,
  `"Overstaffing Alert"`) — not used per-breach-type since `BreachRow.metric`
  is free-form/user-customizable text (KPI labels are editable in Settings),
  making reliable string-matching to one of these fragile; the single fixed
  sub-category remains the deliberate scope decision it always was (see
  chat history if per-breach-type mapping is wanted later).
- **`accounts` (the account name sent) is the account's Zoho Account** —
  the ONE Zoho account setting (see "Zoho Account — one setting" below):
  its first name, else the display name (`rtaZohoAccountName()`). Confirmed
  required live (2026-09-25): Zoho's script resolves the `accounts` value
  against its own HR/Accounts master by NAME, and rejected `"guardianbikes"`
  (our internal account id) with `"No valid Account was resolved from HR...
  Active Account not found in HR: guardianbikes"` — its real Zoho record is
  named `"Guardian Bikes"`. Until 2026-11-05 this was its own field,
  `wfm_settings.rta_account_name` ("Zoho Account Name", blank = the id);
  that column is still read while an account's Zoho Account has never been
  saved, and Save Changes keeps writing the first name to it. The RTA Logs
  section now just shows what will be sent.
- `lib/cliqScan.ts` — per-account gate is just `rta_logs_enabled` (no account
  link requirement, unlike Workforce Logs, since there's no lookup ID to
  resolve — just optional plain-text overrides, see above and `rta_sites`).
  `remarks` (non-AI path) is the exact same `BreachRow[] -> text` formatting
  (`formatWorkforceLogRemarks`) Workforce Logs already uses — one shared
  formatter, two different Zoho destinations. `rta_logs_last_sent_at` is
  still updated on every successful send, but is PURELY informational now
  (see cadence below) — no longer used to gate sending.
- `sql/zoho_rta_logs.sql` — adds `rta_logs_enabled` + `rta_logs_last_sent_at`
  + `rta_sites` + `rta_account_name` to `wfm_settings`.

### Cadence — change-detection, NOT a time cooldown

Per the user (2026-09-28): unlike Cliq/Workforce Logs (which both still use
the global "Re-alert Frequency" time cooldown), Workforce RTA Logs reports
whenever something actually CHANGED and stays quiet otherwise — even
indefinitely, with no timer forcing a resend of an unchanged number.

- A **KPI/queue-level breach** (e.g. SLA %) reports every time its VALUE
  changes while still breaching (75% → 72% → 78%, all under threshold, each
  one reports) — but not while it sits at the exact same value.
- An **agent-status breach** only reports again when a NEW agent name joins
  that breach type (e.g. someone new starts breaching "Case Follow Up
  Duration") — NOT just because an already-known agent's duration keeps
  climbing.
- Once an account has ZERO active breaches, the baseline is cleared — a
  LATER re-breach, even at a value/agent seen before, is treated as fresh
  rather than deduped forever.
- **Per-account scope: WHICH breach kinds count** (`rta_report_kpi`/
  `rta_report_agent_status`, `sql/rta_logs_breach_scope.sql`, 2026-09-29) —
  two independent toggles gate whether the automatic send considers KPI Tile
  breaches (SLA, Abandon Rate, etc. — `BreachRow.kind === 'kpi'`) and/or
  Agent Status breaches (`kind === 'agent'`). **Default: KPI Tiles ON, Agent
  Status OFF** — an account with only agent-status breaches active (e.g.
  Wyze's "Out of adherence") sends nothing automatically unless Agent Status
  reporting is explicitly turned on. `lib/cliqScan.ts`'s `processAccount()`
  filters `breaches` down to `rtaBreaches` by this scope BEFORE
  change-detection/remarks/AI classification even run — an account with
  both toggles off always skips with a log line, regardless of what's
  breaching. The manual Test button applies the SAME filter in AI mode (via
  `reportKpi`/`reportAgentStatus` in the request body) so a test reflects
  the account's real configured scope, not everything currently breaching.
  Settings UI: two checkboxes right under "Enable Workforce RTA Logs
  Reporting", before "Enable AI Categorization" (which classifies whatever
  scope is left after this filter, not the account's full breach list).
- **Staleness halts the automatic send too** — `processAccount()` in
  `lib/cliqScan.ts` checks `isDataStale()` (same 5-minute threshold as the
  dashboard's own "DATA NOT IN SYNC" overlay) immediately after fetching an
  account's data, BEFORE breaches are even built — so on stale data, NOTHING
  fires for that account that cycle: not Cliq, not Workforce Logs, not RTA
  Logs, and `rta_logs_state`/cooldown timestamps are left untouched. Applies
  even on a forced scan (Force Scan Now). This is NOT gated per-output —
  it's a single early return shared by all three, confirmed already in place
  (2026-09-28). The manual "Test Workforce RTA Logs" button deliberately does
  NOT check staleness, since it's a one-off payload/connectivity test, not
  the automatic cadence.
- `lib/breaches.ts` — every `BreachRow` now carries a `kind: 'kpi' | 'agent'`
  tag (set at every `rows.push(...)` site) so the two different rules above
  can actually be told apart — `'kpi'` for every KPI-group-derived breach,
  `'agent'` for every one of the three agent-status breach checks (duration,
  static-duration, text-based).
- `lib/rtaLogsChangeDetection.ts` — `computeRtaLogsChangeSignal(breaches,
  storedState)`. Builds the CURRENT snapshot (`{ kpi: { "entity|metric":
  value }, agent: { metric: [agent names] } }`), compares it against the
  stored one, and returns `{ shouldSend, currentSnapshot }`. `lib/cliqScan.ts`
  gates the whole RTA Logs block on `forceSend || shouldSend` (replacing the
  old `Date.now() - lastSent >= cooldownMs` check), and — only when a send
  actually happens (AI-grouped or not, forced or not) — persists
  `currentSnapshot` as the new baseline (`wfm_settings.rta_logs_state`,
  `sql/rta_logs_change_detection.sql`). A no-send cycle never touches the
  stored state.
- The accounts query in `lib/cliqScan.ts`'s `runCliqScan()` now has a
  one-tier fallback dropping `rta_logs_state` if that column isn't migrated
  yet, instead of failing the WHOLE select (which would silently break
  Cliq + Workforce Logs + RTA Logs for every account at once) — see
  `lib/settings.ts`'s own near-identical bug (below) for why this matters:
  PostgREST rejects an entire select over any one unknown column.
- Settings UI: Settings → **Zoho Integrations** tab → "WORKFORCE RTA LOGS —
  {account}" section, below Workforce Logs Reporting. Just a checkbox — no
  lookup comboboxes, since category/sub_category are fixed constants and the
  account is sent as a plain string.
- **Checking "Enable Workforce RTA Logs Reporting" prompts an "are you
  sure?" confirmation first** — per the user (2026-09-28), turning this on
  starts sending real breach reports on the next scan, so it shouldn't be a
  one-click accident before an account's thresholds are actually finalized.
  Only gates OFF → ON; unchecking it back off needs no confirmation. Doesn't
  auto-save either way — still requires clicking **Save Changes** below,
  same as every other field in this modal. State: `rtaEnableConfirmOpen` in
  `SettingsModal.tsx`.
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
  - **If AI Categorization is on for the account being tested** (per the
    user, 2026-09-28): the button exercises the SAME AI path the real scan
    uses instead of the generic message — `app/api/zoho/test-rta-log/route.ts`
    computes the account's REAL current breaches (`lib/cliqScan.ts`'s
    `fetchAccountData()` + `lib/breaches.ts`'s `buildBreaches()`), runs them
    through `lib/geminiClassifier.ts`, and submits one `[TEST]`-prefixed
    request PER validated group — same "many different Workforce RTA Logs
    when there's more than one categorization" behavior as production, not
    just one flat test message. Fails with a clear message if nothing is
    breaching right now (AI mode needs at least one real breach to classify)
    rather than silently falling back to the non-AI message. The Settings
    popup on failure now shows one block per submission attempted (only
    failed ones expand with full request/response detail) since AI mode can
    mean more than one Zoho call per test.

## AI (Gemini) categorization for Workforce RTA Logs

Client-requested (2026-09-28): instead of every account's Workforce RTA Logs
submission always using the one fixed category/sub-category
(`BREACH_CATEGORY`/`BREACH_SUB_CATEGORY` in `lib/zohoWebappRequest.ts`), an
account can opt into having Gemini look at what's ACTUALLY breaching right
now, group same-type breaches together (e.g. several agents all breaching
the same AUX/status metric belong in one group; an SLA breach and an
individual agent's status-duration breach are different groups), and pick a
REAL Category/Sub-Category from Zoho's own master list for each group — then
submit ONE Workforce RTA Logs webapp request per group instead of always
exactly one per account, with its own AI-written natural-language remarks
(mentioning the specific agents/values involved) instead of the mechanical
`formatWorkforceLogRemarks()` breach-list formatter.

Decisions made explicitly by the user when this was designed:
- **Opt-in PER ACCOUNT**, not a global switch (`wfm_settings.
  rta_ai_categorization_enabled`) — mirrors `rta_logs_enabled`'s own "no
  global switch" posture, so a bad key or a Gemini outage only affects
  accounts that turned this on.
- **No fallback to the fixed category on failure.** If every configured
  Gemini model/key COMBINATION errors for a scan cycle, or none of a
  response's picks match a real Zoho category/sub-category, that account's
  RTA Logs submission is SKIPPED for that cycle and retried next time
  (cooldown does NOT advance on a total failure, so the retry isn't a full
  cooldown window away) — a mismatched/generic category is deliberately
  never sent just to force something through.

- `lib/geminiClassifier.ts` — `classifyBreachesForRtaLog(accountId, breaches,
  categoryOptions, subCategoryOptions)`. Calls the Gemini API
  (`generativelanguage.googleapis.com/v1beta`) with structured JSON output
  (`responseSchema`) — the model returns
  `{ groups: [{ category, sub_category, remarks }] }`. Every returned
  category/sub_category is validated against the REAL tree (case-insensitive
  match, then normalized to Zoho's own exact spelling) — a group that
  doesn't match anything real is DROPPED individually rather than failing
  the whole batch, since one bad pick among several groups shouldn't waste
  the others. Throws only if every model/key combination fails outright, or
  if NONE of a given attempt's groups validate.
- Category/Sub-Category reference data is NOT re-scanned by this feature —
  it reuses `wfm_zoho_field_options` (`lib/settings.ts`'s
  `loadZohoFieldOptions()`), the SAME table `lib/zohoFieldScan.ts`'s daily
  scan already populates for the Workforce Logs comboboxes (with
  parent-child links via `parentId`). `lib/cliqScan.ts` fetches this ONCE
  per scan run (not per account), and only when at least one qualifying
  account actually has AI categorization enabled.
- `lib/geminiKeys.ts` — CRUD for the Gemini API key POOL (global, not
  per-account — shared by every account's toggle). Locked down the SAME way
  as `wfm_cliq_oauth` (`sql/cliq_oauth_token.sql`): RLS enabled, NO policies,
  only `SUPABASE_SERVICE_ROLE_KEY` via `lib/supabaseAdmin.ts` can reach it —
  the public anon key used everywhere else in this app can never read/write
  a live Gemini key. The Settings UI only ever sees a MASKED version
  (`listGeminiKeysMasked()`) via `app/api/gemini/keys` — the raw key is never
  sent back to the browser after creation.
- `lib/geminiModels.ts` — the ORDERED Gemini model list, `wfm_gemini_settings`
  (single global row, `id='global'`, `models` a comma-separated string) —
  model NAMES aren't secrets, so unlike the key pool this has no RLS
  lockdown and is read/written directly with the anon client (no API route
  needed). `loadGeminiModels()` falls back to `[DEFAULT_GEMINI_MODEL]`
  (`'gemini-2.0-flash'`) when no row exists or the list is empty, so the
  feature works before anyone's configured a model, same as the key pool
  needing at least one key added before AI categorization can actually run.
- **Model/key rotation** — per the user (2026-09-28), models are tried in
  the SAME left-to-right, exhaust-on-error order as keys: for each model (in
  the order listed in Settings), every key is tried (oldest first, via
  `created_at`) before moving to the next model — i.e. model[0]+key[0],
  model[0]+key[1], … all keys exhausted for model[0], THEN model[1]+key[0],
  etc. No persisted "which combination is next" state — each call just
  starts from the top and fails over; simple, and sufficient since failures
  are expected to be rare. Each key's `last_error`/`last_used_at` is
  recorded (visible in Settings) purely for diagnosing a broken key, not for
  the rotation logic itself.
- `sql/gemini_ai_categorization.sql` — creates `wfm_gemini_keys`
  (`id`/`label`/`api_key`/`last_error`/`last_used_at`/`created_at`) and
  `wfm_gemini_settings` (`id`/`models`), and adds
  `rta_ai_categorization_enabled` to `wfm_settings`.
- Settings UI: Settings → **Zoho Integrations** tab. A new global
  "AI CATEGORIZATION (GEMINI)" section (right after Global Cliq Settings,
  since both keys and models are shared across every account) lists
  configured keys (masked, with any last error shown inline) with add/delete
  going through `app/api/gemini/keys` (GET/POST/DELETE, since the anon
  client can't reach `wfm_gemini_keys` directly), followed by a numbered,
  reorderable-by-re-adding model list (add/delete only for now — no drag
  reorder — going straight through `lib/geminiModels.ts`'s anon client
  calls, no API route needed). The per-account "Enable AI Categorization"
  checkbox lives in the WORKFORCE RTA LOGS section, right after "Enable
  Workforce RTA Logs Reporting" — disabled (greyed out) until at least one
  key exists.
- `lib/zohoWebappRequest.ts` — `createAccountBreachRtaLog()` gained two
  optional trailing params, `category`/`subCategory`, defaulting to the
  fixed `BREACH_CATEGORY`/`BREACH_SUB_CATEGORY` constants when omitted (the
  non-AI path is unchanged). `lib/cliqScan.ts` passes the AI's validated
  picks through when `rta_ai_categorization_enabled` is set, looping over
  every returned group and submitting one webapp request per group.
- **CONFIRMED working live (2026-09-28)** — a real Gemini-classified test
  submission posted to Zoho successfully (Test Workforce RTA Logs button,
  AI Categorization on).

## Zoho breaks & aux → "Zoho Breaks & Aux" agent section (2026-10-23)

Per the user: show each account's agents who are on a Zoho break or aux (from
the ECE Time Tracker break logs) as an agent-status section, with a per-account
on/off toggle. Ported from Workforce R.E.S.T. vCORE's own pipeline (its "Zoho
breaks & aux → the Adherence timeline" technical reference) so both apps read
the same Zoho data the same way. vCORE's cache is in a DIFFERENT Supabase
project (no `zoho_activity` here), so this app pulls Zoho itself.

- `lib/zohoAuxShared.ts` — the pure rules: the two Creator apps/reports/fields
  (`ece-time-tracker`: `Time_Log_Records_RTA`/`T_Date`, `View_Break_Logs_All`/
  `B_Date`; `ece-time-tracker-honduras`: `Time_Logs_Report`/`Breaks_Report`,
  `Shift_Date`), wall-clock → UTC in each SOURCE app's timezone (ET / Tegucigalpa),
  vCORE's `normalizeName` + `classifyBreak`, and `computeCurrentAux()`: someone is
  "on a break/aux" only while LOGGED IN (open session) with an open break (no End)
  that started inside that session — Zoho has hundreds of never-closed break rows
  a week, and without the session check those would show for days.
- `lib/zohoAux.ts` (server) — `runZohoAuxSync()`: org-wide, ONE date per pull
  (never per account/page view), today every `ZOHO_AUX_PULL_MINUTES` (default 5,
  2–10 — same as vCORE, the org's Zoho API allowance is shared with it),
  yesterday every 30 min for overnight shifts. Creator v2.1 + `record_cursor`
  paging (same call as `lib/zohoFieldScan.ts`), our existing token
  (`lib/zohoAuth.ts`, `ZohoCreator.report.READ` already granted). A failed pull
  keeps the last good copy; an ok-but-empty pull never wipes a date. Pulls
  NOTHING while no account has the toggle on. Keeps every session per person per
  date (vCORE keeps only the first — its §10.1).
- Matching is BY ZOHO ACCOUNT (per the user, 2026-10-23 — replaced matching by
  name against the account's CRM agent tables, which found almost nobody: CRM
  names like Gorgias's "Ayla S" rarely equal a Zoho full name). An account shows
  the people whose account in Zoho equals its display name here (or its id),
  compared ignoring case/spaces/punctuation (`normalizeAccount`), or its Zoho
  Account setting (one or more — see "Zoho Account — one setting" below; it
  replaced this section's own "Zoho account(s) to use" picker,
  `zohoAux.zohoAccounts`, still read until the new one is saved) when Zoho calls it
  differently — plus the optional "Extra Zoho names". Rows show the ZOHO name
  only (`agent_name` = the Zoho Employee name). vCORE never reads an account off
  these reports, so the field isn't documented anywhere: `pickAccountField()`
  finds it on the rows each pull (known names first, then any field with
  "account" in its name — never a manager/lead one), break rows take it from the
  person's time log, and the "Pull now" log names the field used — or, if none,
  lists the fields the rows DO have. The Settings panel lists every account in
  today's Zoho logs (from `/api/zoho/aux-status`) and shows live whether this
  account's name matches one.
- Settings → Status Durations has its own **ZOHO BREAKS & AUX** section while the
  account has Zoho on: every type in the last 2 days of Zoho logs (org-wide,
  `zohoTypes` from `/api/zoho/aux-status`, breaks/lunch first) plus how many of
  this account's people are in each right now (`wfm_zoho_agent_status`), so
  thresholds can be set before anyone on the account has been in a type. Same
  `status_thresholds` map as every other status (a Zoho row's status IS its Zoho
  type) — Exclude, text trigger and Send to Cliq all apply. "Fill break / lunch
  thresholds from their names" sets Warning = the named allowance and Critical
  = +1 min (`allowanceMinutesOf`, vCORE's over-break line), only where unset.
  A Zoho type is listed there instead of under Previously Seen.
- A Zoho row is always elapsed time (`durationIsStatic()` / `agentElapsedSecs()` /
  `agentTimerKey()` in `lib/breaches.ts`), even on an account whose Duration is
  "static" (Guardian Bikes: "Ticket solved") — before, Zoho breaks there showed
  "--" and never breached — and keeps its own timer key, so the same full name
  in a CRM section and the Zoho section doesn't share one clock.
- `sql/zoho_breaks_aux.sql` — `wfm_zoho_activity` (cache) and `wfm_zoho_sync`
  (per-date pull stamp + in-progress lease) are RLS-on / NO policies (they hold
  EVERY employee's logs); `wfm_zoho_agent_status` (what each enabled account
  shows) is RLS-off like the other agent tables.
- Setting: `DataSourceConfig.zohoAux` `{ enabled, includeBreaks, includeAux,
  extraNames }` — in the data_source JSONB on purpose (no `wfm_settings` column,
  so no migration and nothing for `lib/settings.ts`'s unknown-column tiers to
  trip on). UI: Settings → Zoho Integrations → "ZOHO BREAKS & AUX — {account}"
  (`ZohoAuxSection` in `SettingsModal.tsx`) + "Pull Zoho breaks & aux now".
- Dashboard + Cliq scan: `agentSourcesFor(ds)` in `lib/breaches.ts` is now the
  ONE list of an account's agent sources (legacy table, additional sources, then
  `zohoAuxAgentSource(ds)` while the toggle is on) — `components/Dashboard.tsx`
  and `lib/cliqScan.ts` both call it, so a too-long Zoho break breaches/alerts
  through the normal Status Durations thresholds (each Zoho Type, e.g.
  "15 Minute Break", appears there once seen). Durations come from the row's
  `since` timestamp at READ time (`AgentSource.durationSinceCol`, handled in
  `normalizeAgentRow`), so they're right however long ago the 5-min pull wrote it.
- Routes: `app/api/zoho/aux-sync` (cron, every minute in `vercel.json`, gated
  internally; `CRON_SECRET`), `app/api/zoho/aux-sync-now` (Settings button),
  `app/api/zoho/aux-status` (last-pull time for the panel).
- NOT yet verified against live Zoho (no Zoho client id/secret locally): field
  names/report link names are vCORE's, verified in its source 2026-10-22; whether
  OUR consenting Zoho user can read these reports (and the Honduras app) shows up
  in the "Pull now" log. Optional env: `ZOHO_HONDURAS_ENABLED=false`.
- **Logged In, from the time logs** (per the user, 2026-11-03 — people who just
  log in and work, choosing no aux): `computeCurrentAux()` also returns everyone
  logged in on no break/aux as status `ZOHO_LOGGED_IN_STATUS` ("Logged In",
  category `login`). Rules: only a person's LATEST session (by login) counts —
  open = logged in (so a forgotten Log_Out followed by a later, closed session is
  logged out); inside it, their latest-STARTING break/aux decides — no End = on
  it, ended (or none) = Logged In since that End, else the login (time in status,
  like a CRM's "Available"). That also stopped a never-closed break hiding a later
  closed one. Toggle `zohoAux.includeLoggedIn` (default ON, "Include logged in, on
  no break or aux" in the Zoho panel); Status Durations always lists Logged In first in
  the ZOHO section (`zohoStatusCategory()`), so it can get its own minutes like any
  Zoho type. Same rows/table (`category` is free text) — no migration; the section
  keeps its "Zoho Breaks & Aux" name. Overnight caveat: yesterday is re-pulled
  every 30 min, so a Log_Out on yesterday's row can take that long to drop someone.

## Zoho ↔ CRM status match — Settings → Zoho ↔ CRM (2026-11-04)

Per the user: flag an agent whose CRM status doesn't mean the same as their
Zoho Time Tracker status (e.g. "Management" in the CRM while on a Zoho "15 Minute
Break"). Names and status titles differ between the two ("John C." / "John
Cane", "Taking a Break" / "15 Minute Break"), so both are matched by hand.

- Config `DataSourceConfig.zohoCrmMatch` (data_source JSONB, no `wfm_settings`
  column): `enabled`, `crmField` (unset = the Agent Status; else an
  `AgentExtraColumn` key — Gorgias's availability column is where its breaks
  show), `pairs` (`{ zoho, crm }`, names compared like `normalizeName`), `sameAs`
  (Zoho status → the CRM values that mean the same; a Zoho status with none
  ticked isn't checked), `checkNotInZoho` (adds the Zoho status "Not logged in to
  Zoho"), `warnMins`/`critMins` (5 / 10), `sendToCliq`. Defaults per the user:
  check, Cliq and not-in-Zoho all OFF. Rules in `lib/zohoCrmMatch.ts` (pure).
- **Gate (per the user):** usable only while the account has Zoho Breaks & Aux on
  AND "Include logged in" (`zohoCrmMatchAvailable`); otherwise the tab is greyed
  (`sm-tab-off`) and opens to a note saying which switch is off. Live off the
  modal's unsaved state.
- **Who is out of sync is decided on the SERVER, every minute**, in the Zoho
  sync (`checkZohoCrm()` in `lib/zohoAux.ts`, after each account's Zoho rows),
  and stored with WHEN it started in `wfm_zoho_crm_mismatch`
  (`sql/zoho_crm_match.sql` — **must be run once**; RLS off like
  `wfm_zoho_agent_status`). Why not in the browser like other breaches: the two
  accounts using Zoho (Guardian Bikes, Rocco Ridge — Gorgias) have NO time in
  status on their CRM rows (Duration = tickets), so a mismatch can only be timed
  by remembering when it was first seen. `since` is kept while the agent stays
  out of sync (even if a status changes), and restarts if the row wasn't
  re-confirmed for 5 min (`nextMismatchRows`).
- Compared against EVERYONE's current Zoho status (`computeCurrentAux`), not the
  account's displayed Zoho rows — the include-toggles only decide what Agent
  Status lists — and against the CRM rows before the Agent Filter.
- Paused (rows cleared, so nothing breaches) while Zoho's data for today is over
  15 min old (a broken pull would flag everyone), the CRM rows' `updated_at` is
  over 5 min old, or there are no CRM rows. A missing table only logs a line
  pointing at the SQL file — the Zoho section keeps working.
- **The breach:** `buildBreaches()` turns each stored row into a 'kind:agent'
  row (metric `Zoho / CRM Mismatch`, constant so RTA Logs / the alarm treat it as
  one breach type; value `CRM: X · Zoho: Y · 12m 3s`; `zohoCrm` carries both
  statuses + the Zoho name, shown on hover in both Breach / Anomalies tables) once
  it's lasted the account's minutes. Rows the sync hasn't confirmed for 5 min are
  ignored. Not subject to a status's Exclude (Offline-in-the-CRM-while-logged-in
  is exactly the point). Fetched by `fetchZohoCrmMismatches()` from BOTH
  Dashboard.tsx and cliqScan.ts (Agent Filter applied there, by CRM name).
- Cliq: its own `sendToCliq` (the Cliq filter checks `b.zohoCrm` before the
  Status Durations toggle). RTA Logs: like any agent breach (only with the
  account's Agent Status reporting on). Frozen-scraper detection ignores these
  rows (`agentBreachSignature`) — their clock keeps ticking on a frozen CRM.
- UI: `components/ZohoCrmMatchTab.tsx` — settings, **1 · Match names** (suggested
  pairs from `suggestZohoCrmPairs()` — "Jade D" ↔ "Jade Juben Enojo Dagooc",
  "Ann Basilio" ↔ "Kenneth Ann Leonor Basilio"; only unambiguous both ways;
  accept one / all, or pair by hand), **2 · Match statuses** (a chip per CRM
  value under each Zoho status; this account's Zoho types first, "Show all" for
  the organisation's), **3 · Right now** (the same `findZohoCrmMismatches()` on
  the unsaved settings, plus what the server last stored). Zoho side from
  `app/api/zoho/crm-match` (`requireRole` superuser/RTA, an RTA only for their
  own accounts — the Zoho cache is service-role only); CRM side read in the
  browser like the Agent Filter tab.
- Verified: rules (45 checks, incl. the user's examples and the real Guardian
  Bikes / Rocco Ridge names), the sync minute by minute with a fake Zoho and
  store (30), the route's role check (9), the real Cliq scan on live data with
  writes intercepted (7), and the tab + breach on the production build (47).

## Breach / Anomalies columns — the table's gear (2026-10-23)

Per the user: a gear on the Breach / Anomalies header (Dashboard page panel AND
each Overview card) opens `components/BreachColumnsModal.tsx`, to pick which
Agent Status columns appear next to each breach. Choices = `breachColumnChoices(ds)`
in `lib/breaches.ts`: the built-in Agent Status / Duration (`BREACH_COL_STATUS` /
`BREACH_COL_DURATION`) plus every custom `AgentExtraColumn`, in Agent Status order.

- Saved as `DataSourceConfig.breachTableCols` (in the data_source JSONB — no
  migration) via `saveDataSourceOnly()` in `lib/settings.ts`, which writes ONLY
  `data_source`. Both tables read it through `breachTableExtraCols(ds)` — never
  build the column list anywhere else.
- The values come from `BreachRow.extras`, stamped on every agent breach row by
  `buildBreaches()` (status, duration exactly as the Agent Status table shows it,
  and each custom column). KPI breach rows have none → "—".
- Older per-column `AgentExtraColumn.showInBreachTable` ticks (the Settings
  checkboxes this replaced) still apply until the gear is first saved for that
  account; saving drops them.
- Gear shown only to `can.editSettings` roles (superuser / RTA) — it changes what
  everyone watching the account sees. Everyone sees the chosen columns.
- **The Cliq message carries the same columns** (per the user, 2026-11-03):
  `formatMessage()` in `lib/cliqScan.ts` writes each breach as the card's row —
  `🔴 1. Agent — Metric: Value (threshold X) · <each picked column>: <value> ·
  Critical` (e.g. Flex's `ticket id: 7995424`). Values via `breachExtraFields()`
  (`lib/breaches.ts`), the same `extras` the tables read; a KPI row has none and
  a blank value is left out (the tables show "—" for both). The Loggings detail
  (`breachDetails(rows, cols)`) keeps them too. Workforce/RTA Logs remarks are
  unchanged.

## Cliq alert picture — the account's card as an image (2026-11-03)

Per the user: every Cliq breach alert is followed by a picture of the account's
Overview card (KPI tiles + Breach / Anomalies table), like vCORE's mismatch
alerts. The picture is never saved and is not in the Loggings tab (also per the
user).

- `lib/cliqCardImage.tsx` `renderAccountCardPng()` draws it with `next/og`'s
  `ImageResponse` (Satori + Resvg, no browser) — dark theme, Poppins from
  `assets/fonts` (OFL), Boxicons paths inline, 2x scale. Bytes stay in memory.
- `lib/zohoCliq.ts` `sendCliqChannelFile()` uploads it (multipart,
  `POST /channelsbyname/{channel}/files`, scope `ZohoCliq.Webhooks.CREATE` —
  already granted, no re-authorize). Zoho's docs disagree on the form field
  (`files` in the parameter list, `file` in the example): sends `file`, a 400
  retries once with `files`. **Not yet verified against live Cliq.**
- `lib/cliqScan.ts`: only after the text message was sent, same channel, same
  breaches as the message (`cliqBreaches`, not every breach on the card), the
  account's gear columns, `freshestAcrossSources()` as "Updated". A failed
  picture is a scan-log line only — the alert still counts as sent (cooldown,
  Loggings row). Display names: one `wfm_accounts` read per scan. At most
  `MAX_CARD_PICTURES` (15) per scan — Cliq allows 20 uploads a minute, then
  locks uploads for 10 minutes.
- Tiles come from `kpiCardGroups()` (`lib/breaches.ts`) — now the ONE source for
  the Overview card's tiles too (`OverviewCard` in `components/Dashboard.tsx`
  maps it), so the picture can't drift from the card. Checked identical to the
  old inline code on every account (192 tiles).
- Satori rules this depends on: every `div` with 2+ children needs
  `display: flex`; a style value of `undefined` throws; no `<table>`, so rows
  are fixed-height flex rows and `cardHeight()` adds them up (the image height
  must be known up front); `overflow: hidden` under the scale transform drops
  the icons, so the card rounds its header/footer corners instead. Columns are
  sized from a text-width estimate (`textPx`), 560–1000px card.
- Emoji are fetched from a CDN at render time and a failed fetch fails the
  picture, so a failed render is retried once with emoji stripped. Non-Latin
  scripts load from Google Fonts (a failure only drops those letters).
- `next.config.ts` `outputFileTracingIncludes` ships `assets/fonts` with
  `/api/cliq/*` (checked in the build's `.nft.json`).
- Verified: real `runCliqScan()` on live data with every write and Zoho call
  intercepted (23 checks: picture after each message, upload shape, `files`
  fallback, failures, the 15 cap, nothing in Loggings or storage); edge renders
  (Test Mode pill, 27 breaches → 20 + "+7 more", 1000px cap, empty, accents /
  emoji / Chinese with no network); the production build's Force Scan with a
  fetch-intercepting `--import` preload.

## Global breach alarm — separate warning / critical sounds (2026-10-26)

Per the user: the global alarm (Settings → Alarm, super users; rules in
`lib/globalAlarm.ts`) has its own sound + volume for critical breaches and for
warnings.

- The original `wfm_alarm_settings` sound columns (`sound_kind`/`builtin_key`/
  `sound_url`/`volume`) ARE the critical sound. Warnings: `warning_sound_kind`
  (`same` | `builtin` | `upload`), `warning_builtin_key`, `warning_sound_*`,
  `warning_volume` — added in `sql/global_alarm.sql`'s upgrade section (safe to
  re-run). `same` (the default, and what a table without those columns reads
  as) = warnings use the critical sound, i.e. exactly the old behaviour.
- `severity` (`all` | `critical`) is now the Warning block's "Ring for warning
  breaches too" toggle — criticals always ring while the alarm is on.
- `alarmSoundFor(settings, severity)` is the ONE place a sound is picked.
  `evaluateAlarm()` tags every change with its breach's severity
  (`AlarmChange`); a prompt with any critical line plays the critical sound
  (`topSeverity`), so a critical joining a prompt of warnings switches the loop
  to the critical sound, and a 'once' ring uses the critical sound if any of
  that cycle's changes is critical.
- Uploads: `app/api/alarm/sound?slot=warning` for the warning file (same
  bucket, `alarm-warning-*`); no `slot` = the critical file. `app/api/alarm`
  drops a group of not-yet-migrated columns (`NEWER_COLUMN_GROUPS`) and saves
  the rest, returning `needsMigration`, instead of failing the whole save.

## Settings → Agent Filter tab (2026-11-02)

Per the user (first for Homebase): choose which agents an account shows at all,
and so which ones can ever reach Cliq.

- Saved as `DataSourceConfig.agentFilter` `{ mode: 'all'|'include'|'exclude',
  names, pausedMode? }` in the data_source JSONB (no migration, nothing for
  `lib/settings.ts`'s column tiers to trip on). include = ONLY `names` show (a
  new agent starts hidden); exclude = everyone but `names` (a new agent starts
  shown); 'all' = off, `names` + `pausedMode` kept so switching back on brings
  the same ticks back. Names match ignoring case/surrounding spaces.
- `applyAgentFilter()` (`lib/breaches.ts`) is called right where agents are
  collected — `fetchAccount()` in `components/Dashboard.tsx` and
  `fetchAccountData()` in `lib/cliqScan.ts` (also the RTA test route) — so a
  filtered-out agent is gone from the Agent Status table, Breach / Anomalies,
  Overview, the alarm, Cliq, Workforce Logs and RTA Logs alike. Never filter
  in only one of them. Staleness ("DATA NOT IN SYNC") reads KPI tables only, so
  hiding agents can't make an account look stale.
- The tab (`SettingsModal.tsx`, `tab === 'agents'`) lists names straight from
  the account's agent tables (`agentSourcesFor`, incl. Zoho Breaks & Aux), NOT
  from the dashboard's agent list (already filtered), plus saved names not on
  the tables right now. Search (name / section / status), All / Shown / Hidden
  views, Select all / Deselect all act on what's listed; the list box has its
  own scroll with a sticky, solid header row. Applies on Save Changes.
- Modal widened 740 → 820px so the 8 tabs fit (→ 1080px with the 9th, Zoho ↔ CRM).
- Verified: real `fetchAccountData()` on Homebase's live tables (7 checks), and
  a browser test on the production build with live read-only data and every
  write intercepted (24 checks, incl. reload, off/on, mode switch, dark mode).

## Status Durations minutes beat Data Sources text triggers (2026-11-02)

Per the user: Wyze's "Untracked" status reads "Out of adherence" from its first
second, so the Data Sources text trigger (`AgentExtraColumn.breachText`, Wyze's
Adherence column) flagged it at once — but it should only breach after
Untracked's own Status Durations minutes.

- `buildBreaches()` (`lib/breaches.ts`): when the agent's status has a Critical
  time (`statusTh[status].crit < 999`, real elapsed time — `statusHasMinutes`),
  the custom-column text triggers don't fire for that agent; the normal
  minutes-in-status check is the only one that raises it ("Untracked Duration ·
  5m 1s · 5m"). Statuses without minutes are unchanged. One function, so the
  Dashboard, Overview and the Cliq scan all follow it.
- That check times the STATUS, not the adherence — an Untracked agent who is IN
  adherence breaches at the same 5 min (as every Status Durations status does).
- Only Wyze has a text trigger today (checked 2026-11-02), and none of its
  current statuses has minutes, so nothing changed until Untracked is filled in.
- Verified on Wyze's real settings + live rows (with Untracked = 5 min Critical:
  the Untracked agent at 25 s dropped off; 4m59s no breach, 5m1s breach).

## Loggings tab — every Cliq message / RTA Log sent (2026-11-02)

Per the user: super users get a third top-nav tab, **Loggings** (after Overview
and Dashboard; the Hourly tab comes after it — see below), listing every Zoho
Cliq notification and every Workforce RTA Logs submission the webapp made — in
brief, easy-to-read lines.

- Table `wfm_notification_log` (`sql/notification_log.sql` — **must be run once
  in Supabase**): one row per attempt, `kind` cliq | rta_log, `status` sent |
  failed (+ `error`), `source` auto | force | test, a one-line `summary`, and
  `details` jsonb (Cliq: channel, test mode, the exact message, the breaches;
  RTA: Zoho account, sites, category / sub-category, mode, the remarks, the
  items). RLS on, NO policies (like `wfm_cliq_oauth`) — it holds every
  account's breach details.
- Written ONLY by `lib/notificationLog.ts` `recordNotification()` (service-role
  client), which never throws — a missing table or Supabase hiccup must never
  stop a send. Called next to every send in `lib/cliqScan.ts` (Cliq, RTA
  AI-grouped / heartbeat / combined, and an AI-categorization failure that
  stopped an RTA Log) and in `app/api/zoho/test-rta-log` (source `test`). A new
  send path must log there too. Workforce Logs (the unused direct-write path)
  is deliberately not logged. Summaries are built by the helpers in that file
  (`cliqSummary`, `rtaSummary`, `briefRta`…) — one place for the wording.
- Kept 90 days: `pruneNotificationLog()` at the end of `runCliqScan()`, at most
  hourly per instance.
- Read through `app/api/logs` (GET, `requireRole(['superuser'])` on the first
  line; filters kind / status / account / since / `q` search, `page` + `upTo`
  paging, `first=1` adds the total + 24 h counts; an unmigrated table returns
  `needsMigration` instead of an error).
- **20 rows a page** (per the user, 2026-11-03): `components/LogsPage.tsx`
  fetches a page the first time it's opened and keeps it (`pages`), so going
  back is instant — never all rows at once. Pager = up to 5 numbers (the block
  holding the page: 1–5, 6–10…) with ‹ / › stepping one page newer / older.
  Later pages read only rows up to page 1's newest id (`upTo`), so entries
  logged meanwhile don't shift them; the kept pages are dropped when a filter
  or the search changes, on Refresh (back to page 1), or when the every-minute
  refresh (page 1 only) finds new entries. Search runs on the server over every
  entry (`listNotifications` `search` — summary, account, error, channel,
  category / sub-category; display names are matched in the browser and sent
  as `names`), not just the visible page.
- UI: `components/LogsPage.tsx`; tab shown only when `can.viewLogs(role)`
  (superuser); `lib/viewMemory.ts` remembers `logs`, and a non-superuser with
  that remembered lands on the Overview.
- Verified: the real `runCliqScan()` (Force Scan) on the live accounts' data
  read-only, with every write and Zoho/Gemini call intercepted (14 checks:
  one row per message/submission, failures carry Zoho's reason, exact message /
  remarks kept, still sends when the table is missing); the route's role check
  and filters (8); the page on the production build (27, light + dark).

## Hourly tab — KPI readings + Zoho head count per hour (2026-11-05)

Per the user (RTAs and super users asked for it, like their hand-kept interval
sheets): a fourth top-nav tab, **Hourly** (after Loggings; `can.viewHourly` —
superuser + RTA, an RTA only for their own accounts), a table per account and
day: one row per hour — **Scheduled HC**, **Actual HC**, **Attendance %** from
Zoho, then every KPI tile of the account (grouped by KPI group), and a TOTAL row.
Account dropdown (the same `currentAccount` as the top nav), day picker (up to 7
days ahead), time zone (`HOURLY_TIMEZONES` — ET default, CT/MT/PT, Honduras,
Manila; whole-hour offsets only), KPI value mode, KPI group chips (hidden groups
remembered per account in localStorage), "All 24 hours", CSV download. Click an
hour for who was scheduled / there / not.

- **KPI history is recorded by this app** — the CRMs only give live numbers (most
  "today so far" or "right now"), so `/api/kpi/hourly-snapshot` (Vercel Cron, every
  minute, `CRON_SECRET`) reads every account's tiles through `kpiCardGroups()` (the
  Overview card's tiles — now also carrying each tile's `unit`, `lowIsBad` and
  `colorOf`) and folds the reading into that hour's record in `wfm_kpi_hourly`
  (`addKpiReading`: last / min / max / sum / n per tile, a same-minute rerun not
  counted twice, a `00:00` duration not counted). Not recorded while the account's
  data is stale (5 min, same as "DATA NOT IN SYNC"). Hours before it went live, and
  any minute it didn't run, are blank — there is no backfill. Kept 120 days.
  Modes: **End of hour** (the hour's last reading, exactly as the tile showed it;
  TOTAL = end of day), **Average**, **Worst** (by the tile's direction). Cells are
  coloured with the tile's own thresholds via `colorOf`; columns come from the
  account's CURRENT tiles (keyed `groupId:tileKey`, so renames keep their history).
- **Head count rules** (`lib/hourlyReport.ts`, `HC_SHARE` = half): Scheduled = the
  Zoho daily schedule covers ≥ half the hour; Actual = logged in to the Time Tracker
  for ≥ half of their scheduled time in the hour (half the hour if not scheduled —
  overtime / in early count in Actual HC, not Attendance); Attendance = scheduled
  people there ÷ those due so far (the current hour is judged on its elapsed part;
  someone whose shift starts later in it is "upcoming", not absent). TOTAL =
  distinct people; attendance = scheduled hours attended ÷ scheduled hours due.
  Open sessions run to now, a forgotten logout stops at 18 h (`MAX_OPEN_SESSION_HOURS`).
  Attendance colour: < 95 amber, < 85 red (vCORE's adherence lines — no setting).
- **Zoho Daily Schedules** (new pull, vCORE's field names — its "Zoho Daily
  Schedules and Time Logs" reference, 2026-11-05): `ece-time-tracker` /
  `All_Daily_Schedules_View_Only` (`S_Date`, `Schedule_Start`/`_End`, `WHPD`,
  `Account`) and `ece-time-tracker-honduras` / `Schedules_Report` (a WEEKLY
  template, criteria `Day == "Wednesday"`, `Working_Hours`, `Employee.Account`).
  Times parsed by `toHM`, stored as UTC (overnight = next day's wall clock); rest
  days (WHPD 0, blank, start = end) dropped; one row per person (the last). Cached
  per date × source × Zoho account in `wfm_zoho_schedules` + `wfm_zoho_schedule_sync`
  (lease, never wiped by a failed/empty pull). Pulled ON VIEW only (no cron — vCORE
  works the same way): today and later every 30 min, yesterday every 6 h, an older
  day once (again if it was pulled before the day after it was over).
- **Time logs** are the Zoho Breaks & Aux cache (`wfm_zoho_activity`); a date it
  hasn't got (an older day, or no account has Breaks & Aux on) is pulled by the page
  through the same `refreshZohoLogDates()` the cron uses (extracted from
  `runZohoAuxSync`, with the lease — a date is never pulled twice at once). Reads
  sessions only, pages in parallel (`readCache(dates, 'sessions')`).
- Files: `lib/hourlyReport.ts` (pure: windows, schedule parsing, head count, KPI
  folding/formatting, `HourlyReport` type), `lib/hourlyReportServer.ts` (server:
  the minute job, the schedule pull, `getHourlyReport()`), `app/api/hourly`
  (GET, `requireRole(['superuser','rta'])` + the account check on the first lines),
  `app/api/kpi/hourly-snapshot`, `components/HourlyPage.tsx`, `.hr-*` in globals.css,
  `sql/hourly_report.sql` (**must be run once** — RLS on, no policies; the page says
  so until then). The server KPI fetch is `fetchKpiData()` in `lib/breaches.ts`,
  shared with the breach scan (`fetchAccountKpiData` in `lib/cliqScan.ts`).
- Schedules CONFIRMED live (2026-11-05, `wfm_zoho_schedule_sync` after go-live):
  "primary: 2229 shifts / 62 accounts / account field Account; honduras: 43 shifts /
  7 accounts / account field Employee.Account" — vCORE's field names hold. If a pull
  fails the page shows Zoho's error; the sync row's `note` has the counts.
- The table's rows and cells are built by the shared functions in
  `lib/hourlyReport.ts` (`hourlyRows`, `trimHourlyRows`, `hourlyKpiCell`,
  `hourlyTotalKpi`, `attendanceTone`, `pctText`) — the hourly report in Cliq (below)
  uses the same ones; don't build them inline in the page again.
- Known quirk, deliberately left alone: a count tile whose value has a thousands
  comma ("2,205") parses as 2 in `extractKpiValue` (tile colour, breaches, the
  Hourly Average/Worst) — fixing it would start breaching Perfect Serve's
  "total_calls" (thresholds 15/25). End of hour shows the text as scraped.
- Verified: pure rules (59), the server with fake Zoho + stores (42), the route's
  role check (16), a read-only dry run on production data (every account's KPI
  tiles; Ashley Voice / Flex / Guardian Bikes / Rocco Ridge head counts from the real
  cache), and the page + Settings on the production build (42, light + dark).

## Zoho Account — one setting for every Zoho feature (2026-11-05)

Per the user: Settings → Zoho Integrations → **ZOHO ACCOUNT — {account}** (first of
the account's Zoho sections) is the one place an account's name in Zoho is set;
default (blank) = its display name, the title on its KPI card. One or more names
(Flex is "Flex", "Flex PartTime", "Flex-PnOps" in Zoho), matched ignoring case,
spaces and punctuation ("Ashley Voice" = "Ashley - Voice").
- Saved as `DataSourceConfig.zohoAccounts` (data_source JSONB, one per line — no
  migration). Read ONLY through `zohoAccountsTextOf()` / `zohoAccountNamesOf()` in
  `lib/zohoAuxShared.ts`: undefined (never saved) falls back to Breaks & Aux's old
  `zohoAux.zohoAccounts`, then RTA Logs' old `rta_account_name`, so nothing changed
  until it's saved; the modal seeds itself from them, and Save Changes writes it
  (plus its first name into `rta_account_name`).
- Used by: the Hourly page's head count, Zoho Breaks & Aux (`runZohoAuxSync` —
  `loadAccounts()` now also returns `rta_account_name`), the Zoho ↔ CRM tab (passed
  in as `zohoAccounts`), Workforce RTA Logs (`rtaZohoAccountName()` — first name,
  else display name; the scan reads display names whenever an account has RTA Logs
  on) and the Test RTA Logs button. `accountKeysFor(id, displayName, names)` now
  takes the names.
- Build quirk found here: in multi-line JSX text, the space right after a closing
  tag is DROPPED by this Next/Turbopack build ("Unique Nameof", "Accounton") — a
  single-line text node keeps it. The new text uses `{' '}`; older Settings text
  ("Unique Name", "Site(s)") still shows it.

## Hourly report in Cliq (2026-11-05)

Per the user: the Hourly table goes to each account's Cliq channel every hour, as
"Hourly Report" — a message (like the breach alerts) followed by a picture of the
table (like the alert's card picture). Per account, **off by default**: Settings →
Zoho Integrations → **HOURLY REPORT TO CLIQ — {account}** (right under the Cliq
channel; `HourlyCliqSection` in `SettingsModal.tsx`): the switch, the time zone of
the hours (`HOURLY_TIMEZONES`, ET default), the KPI value (End of hour / Average /
Worst) and which KPI groups to include. Saved as `DataSourceConfig.hourlyCliq`
(data_source JSONB, no `wfm_settings` column), read through `hourlyCliqOf()`.

- `lib/hourlyCliq.ts` — `runHourlyCliqReports()` (the cron), `sendHourlyCliqReport()`,
  `buildHourlyCliqReport()`, `sendHourlyReportNow()`. Same channel (`cliq_channel`),
  global "Enable Cliq Notifications" and Test Mode as the breach alerts (Cliq off →
  nothing; Test Mode → `[TEST]` + a TEST pill on the picture). Not gated by staleness:
  an hour whose data was out of sync just has no KPI readings, and the message says so.
- **What's sent** — the hour that JUST ENDED: Scheduled / Actual / Attendance, every
  shown KPI tile (🔴/🟡 by the tile's thresholds), and "Day so far"; then the picture
  (`lib/hourlyCliqImage.tsx`): the day's rows up to that hour (trimmed like the page),
  that hour highlighted, TOTAL = the day so far. Numbers come from the SAME
  `getHourlyReport()` and the SAME row/cell functions as the page —
  `hourlyRows` / `trimHourlyRows` / `hourlyKpiCell` / `hourlyTotalKpi` /
  `attendanceTone` / `pctText` in `lib/hourlyReport.ts` (`components/HourlyPage.tsx`
  was switched onto them, so the two can't drift). An hour with nobody scheduled or
  logged in and no KPI reading is skipped (not sent, not logged).
- **When** — `/api/cliq/hourly-report` (Vercel Cron, every minute, `CRON_SECRET`)
  works only 2–30 minutes past the hour (`SEND_FROM_MIN` / `SEND_UNTIL_MIN`), at
  most `HOURLY_PER_RUN` (4) accounts a minute, one at a time: Cliq allows 20 uploads
  a minute and the breach scan can post 15 pictures in the same minute.
- **Never twice** — `wfm_hourly_cliq_sent` (`sql/hourly_report.sql` section 4 —
  **run that file again once**; until then the cron logs the hint and sends
  nothing): one row per account per hour, claimed BEFORE sending (insert; a unique
  violation = another run has it). sending | sent | failed | skipped; a failed one is
  retried 2 min later, 3 attempts in all; kept 30 days.
- The picture: `renderHourlyTablePng()` — Satori like the card (colours, Poppins,
  icons, emoji fallback all shared from `lib/cliqCardImage.tsx`'s exports), fixed
  column widths fitted to the text (KPI 44–150px), 2x, less for a table past 4000px
  (never below 1x — Uniters' 24 tiles make a ~4000px-wide picture; the group chips
  trim it). Fonts ship with both routes via `next.config.ts`'s `/api/cliq/*`
  (checked in the build's `.nft.json`). Only after the message went through; a
  failed picture is a log line and a note on the claim row, never a failed report.
- **Loggings**: kind `cliq` with `details.type: 'hourly'` (+ `hourText`, `tz`,
  `kpiMode`, the exact message) — shown as "Cliq · Hourly", triggered "Every hour" /
  "Send the last hour now". Summary from `hourlySummary()` in `lib/notificationLog.ts`.
- **"Send the last hour now"** (Settings, same section) → `/api/cliq/hourly-report-now`
  (POST, `requireRole(['superuser','rta'])`, an RTA only for their accounts): the
  hour that just ended, right away, with the channel and settings shown in the modal
  (saved or not), even with the switch or Cliq off (Test Mode still applies). No
  claim — it doesn't replace that hour's automatic report. Logged with source `test`.
- Verified: rules + cron + send-now with fakes (117 — incl. retries, the 4-a-minute
  cap, the midnight hour, Manila hours, real renders); a read-only dry run on
  production (all 9 accounts with a Cliq channel: messages + real pictures, nothing
  written, Cliq faked); the Settings section, send-now, Save and the Loggings row on
  the production build (25, light + dark); the Hourly page re-run (42).

## Settings Save no longer writes the default Cliq settings (fixed 2026-11-05)

Found while testing the above: the Dashboard loads the global Cliq settings
(`loadCliqSettings`) AFTER the accounts, and the Settings modal copied them into its
state once, when it opened. Opened in the first second or two after a page load, it
showed the defaults — Enable Cliq Notifications OFF, Test Mode ON — and Save Changes
wrote them, silently stopping every account's Cliq alerts. The modal now keeps only
what was changed in it (`cliqGlobalEdits`) on top of the loaded settings, and Save
writes the global Cliq settings only when something there was changed (switching it
off and on again counts as no change). Verified in the browser on the production
build (4 checks: opened at once and saved untouched → nothing written; Test Mode
changed → written with Cliq still ON).

## `lib/settings.ts` load/save silently dropping fields (fixed 2026-09-28)

Found while chasing why `rta_sites`/`rta_account_name` kept reverting to
blank after a reload despite clicking Save Changes. Root cause turned out to
be much bigger than those two fields:

`header_band_color`/`header_text_color` (`sql/header_colors.sql`) and
`alarm_sound` were **never actually migrated** on this Supabase project.
PostgREST rejects an ENTIRE select/upsert if even one named column doesn't
exist — and the old retry-tier fallback chain in both `loadSettings()` and
`saveSettings()` kept those two/three broken columns bundled together with
`rta_sites`/`rta_account_name`/`rta_logs_enabled`/etc. in the SAME tier, all
the way down to the second-to-last one. So every load AND every save was
silently collapsing to the bare-minimum tier (just
kpi/status/data_source/dashboard_layout) — discarding `cliq_channel`,
`wf_logs_enabled`, every Zoho lookup, `alarm_sound`, and every `rta_*` field,
every single time, regardless of what was actually saved. This was NOT
specific to RTA Logs — it affected everything past the 4 bare-minimum
fields, silently, this whole time.

Fixed by rewriting both functions to use a genuinely granular, loop-based
tier system (`SELECT_TIERS`/`UPSERT_TIERS` in `lib/settings.ts`) that
isolates ONLY the confirmed-broken columns into their own tier, instead of
bundling them with unrelated, definitely-present newer columns. Verified
live directly against Supabase REST (bypassing the app) that the corrected
tier-1 payload (everything except `alarm_sound`) persists `rta_sites`/
`rta_account_name` correctly.

**Takeaway for any future column addition to `wfm_settings`**: never assume
an older/"already migrated" column is safe to leave in every fallback tier —
verify it's actually present, or budget a dedicated tier for it. A single
untested assumption here quietly broke far more than whatever feature
prompted the last migration.

## `lib/cliqScan.ts` blind to text-based agent breaches (fixed 2026-09-28)

Found while chasing why Wyze's "Out of adherence" breaches — clearly visible
on the live Overview page, several agents deep — never showed up for
"Test Workforce RTA Logs" ("No active breaches right now for this account").

Root cause: `components/Dashboard.tsx` (client-side, used by the live
Dashboard/Overview pages) and `lib/cliqScan.ts` (server-side, used by the
Cliq scan / Workforce Logs / RTA Logs) each had their OWN copy of the logic
that turns a raw agent-table row into the `_name`/`_status`/`_duration`/
`_agentGroup` shape `lib/breaches.ts`'s `buildBreaches()` checks. Dashboard's
copy also mapped `_extra_<key>`/`_extraDuration_<key>`/`_extraMetric_<key>`
for any configured `AgentSource.extraCols` — required for a TEXT-BASED
breach (`AgentExtraColumn.breachText`, e.g. Wyze's "Out of adherence") to be
detectable at all. `lib/cliqScan.ts`'s copy never mapped those fields, and
its legacy single-table `AgentSource` synthesis in `fetchAccountData()`
hardcoded `extraCols: {}` with the comment `"breach scanning never needs
custom display columns"` — flatly wrong for this breach type. Net effect:
any account using a text-based custom-column breach was invisible to
EVERY server-side output — not just the new RTA Logs AI test, but live Cliq
alerts and Workforce Logs reporting too, silently, for as long as
`lib/cliqScan.ts` has existed.

Fixed by extracting the correct (Dashboard.tsx) version into one shared,
canonical `normalizeAgentRow(row, src)` in `lib/breaches.ts`, and switching
BOTH `lib/cliqScan.ts`'s `fetchAgentSource()` and `Dashboard.tsx`'s own
`fetchAgentSource()` to call it — including fixing `lib/cliqScan.ts`'s
legacy-table synthesis to pass `ds.agentExtraColsMap`/
`agentExtraDurationColsMap`/`agentExtraMetricColsMap` through, matching
Dashboard.tsx's. There is now only the one implementation, same reasoning as
`buildBreaches()` itself — this is the SAME class of client/server drift bug
as the `lib/settings.ts` one directly above; same day, same root cause
shape ("a server-side copy of client logic silently fell out of sync").

**Takeaway**: any per-row/per-account normalization step that feeds
`buildBreaches()` must live in `lib/breaches.ts` itself (or be otherwise
explicitly shared), never re-implemented separately in a page component and
a server scan file — verified twice now that "just mirror it carefully" does
not hold up over time.