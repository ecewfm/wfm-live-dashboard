-- ─────────────────────────────────────────────────────────────────────────────
-- "Workforce RTA Logs" webapp-request reporting — one-time column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (every ADD COLUMN is IF NOT EXISTS).
--
-- A DIFFERENT Zoho integration from sql/zoho_workforce_logs.sql's Workforce
-- Logs reporting — this one submits to a generic Zoho "webapp request"
-- intake (the "All_Webapp_Api_Requests" form, same app: ece-time-tracker)
-- with Form="Workforce RTA Logs" and a JSON Values_field payload (see
-- lib/zohoWebappRequest.ts). Unlike Workforce Logs, this needs NO Zoho
-- lookup resolution (no account/category/site IDs to pick) — it just sends
-- the account id as a plain string, with category/sub_category fixed to
-- "Service Level & Volume Management" / "Understaffing Alert" for every
-- report — so the only per-account setting needed is the enable toggle
-- plus cooldown tracking.
--
-- rta_logs_enabled      — per-account toggle. When true, a detected breach
--                          also submits a "Workforce RTA Logs" webapp
--                          request, independent of (in addition to, or
--                          instead of) any Cliq alert / Workforce Log record.
-- rta_logs_last_sent_at — per-account cooldown tracking, same shape/reuse of
--                          the global frequency_minutes setting as Cliq and
--                          Workforce Logs — repeat breaches don't spam a new
--                          submission every single scan cycle.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_logs_enabled boolean DEFAULT false;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_logs_last_sent_at timestamptz;
