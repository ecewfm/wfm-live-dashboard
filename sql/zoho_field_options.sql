-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho Creator lookup field option cache — one-time table create
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Populated by scanning every existing record in the client's
-- "All_Workforce_Logs_RTA_View" report (lib/zohoFieldScan.ts) — once a day
-- via Vercel Cron, or on demand via the "Scan Zoho Field Options Now" button
-- in Settings → Zoho Integrations. Collects the unique {ID, display_value}
-- pairs that have ever actually been used for the Category, Sub_Categories,
-- x_Account, and Site lookup fields, so the Settings UI can offer them as
-- autocomplete suggestions instead of requiring someone to dig up raw Zoho
-- record IDs by hand. Not locked down with RLS — nothing in here is
-- sensitive, just category/site/account names and their Zoho IDs (same
-- posture as wfm_settings, unlike wfm_cliq_oauth which holds a real secret).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wfm_zoho_field_options (
  id            bigserial PRIMARY KEY,
  field_name    text NOT NULL,   -- 'Category' | 'Sub_Categories' | 'x_Account' | 'Site'
  zoho_id       text NOT NULL,
  display_value text NOT NULL,
  last_seen_at  timestamptz DEFAULT now(),
  UNIQUE (field_name, zoho_id)
);

-- Explicit, not just "no policies added" — if this table was ever created
-- through Supabase's dashboard "New Table" UI instead of this script, RLS
-- defaults ON there with zero policies, which silently blocks the anon-key
-- reads the Settings UI's comboboxes depend on (writes still succeed via
-- the service-role key, so a scan looks successful while the dropdowns
-- stay empty). Safe/idempotent to re-run.
ALTER TABLE wfm_zoho_field_options DISABLE ROW LEVEL SECURITY;
