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
