-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho Creator "Workforce Logs" breach reporting — one-time column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (every ADD COLUMN is IF NOT EXISTS) if you already ran an
-- earlier version of this file.
--
-- wf_logs_enabled     — per-account toggle. When true, a detected breach also
--                        creates a record in the client's Zoho Creator
--                        "All Workforce Logs" report (app: ece-time-tracker),
--                        in addition to (independent of) any Cliq alert.
-- zoho_account_name/_id, zoho_category_text/_id, zoho_subcategory_text/_id,
-- zoho_site_text/_id — each is a (text, id) pair for one Zoho lookup field
--                        (x_Account, Category, Sub_Categories, Site). The
--                        Settings UI is a single combobox per field backed by
--                        wfm_zoho_field_options (see sql/zoho_field_options.sql):
--                        picking a known value fills in *_id (writes by exact
--                        Zoho record ID); typing something new leaves *_id
--                        blank and uses *_text instead (writes by display
--                        value). wf_logs_enabled is ignored until at least
--                        the account field is filled in one way or the other.
-- wf_logs_last_sent_at — per-account cooldown tracking, same shape as
--                        cliq_last_sent_at, so repeat breaches don't spam a
--                        new Zoho record every single scan cycle.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS wf_logs_enabled boolean DEFAULT false;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_account_name text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_account_id text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_category_text text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_category_id text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_subcategory_text text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_subcategory_id text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_site_text text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS zoho_site_id text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS wf_logs_last_sent_at timestamptz;
