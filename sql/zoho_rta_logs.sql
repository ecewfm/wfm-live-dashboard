-- ─────────────────────────────────────────────────────────────────────────────
-- "Workforce RTA Logs" webapp-request reporting — one-time column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (every ADD COLUMN is IF NOT EXISTS).
--
-- A DIFFERENT Zoho integration from sql/zoho_workforce_logs.sql's Workforce
-- Logs reporting — this one submits to a generic Zoho "webapp request"
-- intake (the "WebApp_API_Requests" form, same app: ece-time-tracker) with
-- Form="Workforce RTA Logs" and a JSON Values_field payload (see
-- lib/zohoWebappRequest.ts). No Zoho lookup ID resolution needed — it sends
-- the account id and site name(s) as plain strings, category/sub_category
-- fixed to "Service Level & Volume Management" / "Understaffing Alert" for
-- every report.
--
-- rta_logs_enabled      — per-account toggle. When true, a detected breach
--                          also submits a "Workforce RTA Logs" webapp
--                          request, independent of (in addition to, or
--                          instead of) any Cliq alert / Workforce Log record.
-- rta_logs_last_sent_at — per-account cooldown tracking, same shape/reuse of
--                          the global frequency_minutes setting as Cliq and
--                          Workforce Logs — repeat breaches don't spam a new
--                          submission every single scan cycle.
-- rta_sites             — comma-separated site name(s) for this account
--                          (e.g. "Manila", "Dumaguete", or "Manila,Dumaguete"
--                          for an account that spans both) — CONFIRMED
--                          required live (2026-09-24): Zoho's own processing
--                          script rejects an "Account Wide" submission with
--                          no site at all ("At least one site is required").
--                          Deliberately a SEPARATE field from Workforce
--                          Logs' single-value zoho_site_text/_id above — an
--                          account can span more than one site here, which
--                          that single Zoho lookup field can't represent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_logs_enabled boolean DEFAULT false;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_logs_last_sent_at timestamptz;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_sites text;
