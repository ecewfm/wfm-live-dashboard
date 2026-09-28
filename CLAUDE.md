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
- **`accounts` (the account name sent) can be overridden** —
  `wfm_settings.rta_account_name`. Confirmed required live (2026-09-25):
  Zoho's script resolves the `accounts` value against its own HR/Accounts
  master by NAME, and rejected `"guardianbikes"` (our internal account id)
  with `"No valid Account was resolved from HR... Active Account not found
  in HR: guardianbikes"` — its real Zoho record is named `"Guardian
  Bikes"`. `lib/cliqScan.ts` sends `acc.rta_account_name || accountId`.
  Blank (the default) sends the internal id as-is, unchanged from before —
  only accounts whose id doesn't match Zoho's own naming need this filled
  in. Settings UI: a plain text input, "Zoho Account Name", right above the
  Site checkboxes.
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