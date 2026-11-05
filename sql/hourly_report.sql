-- ─────────────────────────────────────────────────────────────────────────────
-- The Hourly page — each account's KPI tiles and Zoho head count, hour by hour
-- Run once in: Supabase Dashboard → SQL Editor → New Query. Safe to re-run.
-- See lib/hourlyReportServer.ts (writes + reads) and lib/hourlyReport.ts (rules).
-- All three are read and written only by the server (service-role key): RLS on,
-- NO policies, like wfm_zoho_activity — the schedules hold every employee's
-- shifts, and the page reads all of it through /api/hourly, which checks the
-- caller's role and accounts.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. KPI readings per account per hour. The minute cron (/api/kpi/hourly-snapshot)
--    folds each reading of each KPI tile into its hour's record:
--    tiles = { "<groupId>:<tileKey>": { last, lastNum, min, max, sum, n, pct, at } }.
--    Kept 120 days (pruned by the cron itself).
CREATE TABLE IF NOT EXISTS wfm_kpi_hourly (
  account_id  text        NOT NULL,
  hour_start  timestamptz NOT NULL,             -- the top of the hour, UTC
  tiles       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_wfm_kpi_hourly_hour ON wfm_kpi_hourly (hour_start);
ALTER TABLE wfm_kpi_hourly ENABLE ROW LEVEL SECURITY;

-- 2. Zoho's Daily Schedules, ORGANISATION-WIDE, one row per date × source app ×
--    Zoho account (the account as Zoho has it on the schedule row), holding that
--    account's shifts for the date: payload = [{ employee, start, end, source }]
--    (UTC). Rest days aren't kept. Pulled when the page asks for a date whose
--    copy is old; a failed or empty pull never wipes a date.
CREATE TABLE IF NOT EXISTS wfm_zoho_schedules (
  log_date      date        NOT NULL,            -- the Zoho date (New York clock)
  source        text        NOT NULL,            -- 'primary' | 'honduras'
  account_norm  text        NOT NULL,            -- normalizeAccount(account)
  account       text        NOT NULL,
  payload       jsonb       NOT NULL,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (log_date, source, account_norm)
);
CREATE INDEX IF NOT EXISTS idx_wfm_zoho_schedules_account ON wfm_zoho_schedules (account_norm, log_date);
ALTER TABLE wfm_zoho_schedules ENABLE ROW LEVEL SECURITY;

-- 3. When each date's schedules were last pulled (and when a pull started, so two
--    requests at once don't both call Zoho) — like wfm_zoho_sync for the time logs.
CREATE TABLE IF NOT EXISTS wfm_zoho_schedule_sync (
  log_date     date PRIMARY KEY,
  refreshed_at timestamptz,
  started_at   timestamptz,
  note         text
);
ALTER TABLE wfm_zoho_schedule_sync ENABLE ROW LEVEL SECURITY;
