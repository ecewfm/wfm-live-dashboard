-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts run from Zoho alone (no CRM) — per the user, 2026-11-09
-- Run once in: Supabase Dashboard → SQL Editor → New Query. Safe to re-run.
-- See lib/zohoWorkforce.ts (the rules), lib/zohoAux.ts (the minute-by-minute
-- run) and lib/zohoOnlyAccounts.ts (Settings → Accounts → Add from Zoho).
-- Needs sql/zoho_breaks_aux.sql and sql/hourly_report.sql (already run).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Each Zoho-run account's KPI tiles — Scheduled Now, Logged In, On Break,
--    Not Logged In, Attendance, Absenteeism, Adherence, Late Today — one
--    row per account × tile, rewritten every minute by the Zoho sync
--    (/api/zoho/aux-sync). TALL, like homebase_omni_queue_stats: the account's
--    card binds it as a KPI source (table wfm_zoho_kpis, account column
--    account_id, row key tile_key, value column value, updated-at updated_at),
--    so any account can show these tiles. Read by the dashboard with the public
--    key, like every other KPI table, so no RLS — it holds only these numbers.
CREATE TABLE IF NOT EXISTS wfm_zoho_kpis (
  id          text PRIMARY KEY,          -- "{account_id}:{tile_key}"
  account_id  text NOT NULL,
  tile_key    text NOT NULL,             -- scheduled_now, logged_in, on_break, not_logged_in,
                                         -- attendance_pct, absenteeism_pct, adherence_pct, late_today
  label       text,
  value       text,                      -- as the tile shows it: "12", "93.5%", "--" when nothing is due yet
  num         numeric,                   -- the same as a number (null for "--")
  updated_at  timestamptz DEFAULT now()  -- not written while Zoho's data is over 15 min old → "DATA NOT IN SYNC"
);
CREATE INDEX IF NOT EXISTS idx_wfm_zoho_kpis_account ON wfm_zoho_kpis (account_id);
ALTER TABLE wfm_zoho_kpis DISABLE ROW LEVEL SECURITY;

-- 2. Accounts the global breach alarm leaves out (Settings → Alarm). New
--    accounts added from Zoho start here: their Attendance / Adherence move
--    every minute, and the alarm rings on every change of a breaching value.
--    Every other account rings exactly as before.
ALTER TABLE wfm_alarm_settings ADD COLUMN IF NOT EXISTS muted_accounts jsonb NOT NULL DEFAULT '[]'::jsonb;
