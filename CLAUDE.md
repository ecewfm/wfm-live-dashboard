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
- `lib/zohoCliq.ts` — mints Zoho access tokens from a stored refresh token
  (`ZOHO_CLIQ_REFRESH_TOKEN` env var) and posts to the Cliq message API.
- `app/api/zoho/authorize` + `app/api/zoho/callback` — the ONE-TIME OAuth
  handshake (needs a public HTTPS redirect, which is why this lives in the
  Vercel app specifically) that produces `ZOHO_CLIQ_REFRESH_TOKEN` in the
  first place. Triggered by the "Authorize with Zoho" button in the same
  Settings tab. Refresh token is logged server-side only (Vercel function
  logs), never rendered in the callback page.

Required env vars (Vercel dashboard, NOT `NEXT_PUBLIC_` — server-only):
`ZOHO_CLIQ_CLIENT_ID`, `ZOHO_CLIQ_CLIENT_SECRET`, `ZOHO_CLIQ_REFRESH_TOKEN`
(from the one-time authorize flow), and optionally `CRON_SECRET` (recommended
— without it, `/api/cliq/scan` accepts unauthenticated requests).

Per-account cooldown (`wfm_settings.cliq_last_sent_at`, default 5 min,
configurable in Settings) and a 5-minute staleness suppression (same
`isDataStale()` threshold the dashboard's own "DATA NOT IN SYNC" overlay
uses) both apply on the scheduled scan — cooldown only advances on a
confirmed successful send. Force Scan bypasses cooldown, not staleness.