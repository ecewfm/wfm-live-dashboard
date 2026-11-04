-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho ↔ CRM status match (Settings → Zoho ↔ CRM)
-- Run once in: Supabase Dashboard → SQL Editor → New Query. Safe to re-run.
-- See lib/zohoCrmMatch.ts (the rules) and lib/zohoAux.ts (the every-minute check).
-- ─────────────────────────────────────────────────────────────────────────────

-- The agents who are out of sync right now — their CRM status doesn't mean the
-- same as their Zoho Time Tracker status — and SINCE WHEN. Written by the Zoho
-- sync every minute (service-role key); read by the dashboard and the Cliq scan,
-- which turn each row into a Warning / Critical breach once it has lasted the
-- account's minutes. A row disappears as soon as the agent is back in sync.
-- Same contents as the agent tables (names + statuses) and read with the public
-- key like them, so no RLS — same as wfm_zoho_agent_status.
CREATE TABLE IF NOT EXISTS wfm_zoho_crm_mismatch (
  id          text PRIMARY KEY,          -- "{account_id}:{normalized CRM name}"
  account_id  text NOT NULL,
  crm_name    text NOT NULL,             -- the CRM agent, as the account's Agent Status shows them
  zoho_name   text NOT NULL,             -- who they are paired with in Zoho
  crm_status  text NOT NULL,             -- their CRM value (status, or the compared custom column)
  zoho_status text NOT NULL,             -- "Logged In", a Zoho type, or "Not logged in to Zoho"
  crm_group   text,                      -- their Agent Status section
  since       timestamptz NOT NULL,      -- when they were first seen out of sync
  checked_at  timestamptz NOT NULL DEFAULT now()   -- the last check that confirmed it
);
CREATE INDEX IF NOT EXISTS idx_wfm_zoho_crm_mismatch_account ON wfm_zoho_crm_mismatch (account_id);
ALTER TABLE wfm_zoho_crm_mismatch DISABLE ROW LEVEL SECURITY;
