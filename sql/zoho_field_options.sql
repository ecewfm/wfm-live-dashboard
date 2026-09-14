-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho Creator lookup field option cache — one-time table create
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Populated by lib/zohoFieldScan.ts — once a day via Vercel Cron, or on
-- demand via the "Scan Zoho Field Options Now" button in Settings → Zoho
-- Integrations. Two different sources feed this table depending on the
-- field:
--   Category / Sub_Categories → the two canonical master reports
--     (Workforce_RTA_Categories_Report / Workforce_RTA_Sub_Categories_Report)
--     — the FULL valid list, including values never yet used in a log.
--   x_Account / Site → still discovered by scanning every existing record in
--     "All_Workforce_Logs_RTA_View" for whatever's actually been used before
--     (no equivalent master report for these two exists yet).
-- Either way the Settings UI reads this table to offer autocomplete
-- suggestions instead of requiring someone to dig up raw Zoho record IDs by
-- hand. Not locked down with RLS — nothing in here is sensitive, just
-- category/site/account names and their Zoho IDs (same posture as
-- wfm_settings, unlike wfm_cliq_oauth which holds a real secret).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wfm_zoho_field_options (
  id            bigserial PRIMARY KEY,
  field_name    text NOT NULL,   -- 'Category' | 'Sub_Categories' | 'x_Account' | 'Site'
  zoho_id       text NOT NULL,
  display_value text NOT NULL,
  last_seen_at  timestamptz DEFAULT now(),
  UNIQUE (field_name, zoho_id)
);

-- Sub_Categories rows only — the zoho_id of the parent Category this option
-- belongs to (read off the Sub-Categories report's own Workforce_RTA_
-- Categories lookup field), so the Settings UI can filter Sub Category
-- suggestions down to just the ones under the account's selected Category.
-- NULL for every other field_name. Safe/idempotent to re-run.
ALTER TABLE wfm_zoho_field_options ADD COLUMN IF NOT EXISTS parent_zoho_id text;

-- Explicit, not just "no policies added" — if this table was ever created
-- through Supabase's dashboard "New Table" UI instead of this script, RLS
-- defaults ON there with zero policies, which silently blocks the anon-key
-- reads the Settings UI's comboboxes depend on (writes still succeed via
-- the service-role key, so a scan looks successful while the dropdowns
-- stay empty). Safe/idempotent to re-run.
ALTER TABLE wfm_zoho_field_options DISABLE ROW LEVEL SECURITY;
