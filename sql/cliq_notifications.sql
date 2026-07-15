-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho Cliq breach-notification settings — one-time column/table add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- cliq_channel        — per-account Cliq channel "Unique Name" to post alerts to.
--                        '' or NULL = Cliq alerts disabled for that account.
-- cliq_last_sent_at    — per-account cooldown tracking (last successful send),
--                        so the notifier — which runs in the always-on scraper
--                        process, not this app — can persist cooldown across
--                        its own restarts instead of resetting to "never sent"
--                        every time it restarts.
-- wfm_settings is already in the supabase_realtime publication as a whole
-- table, so no separate realtime setup is needed for these new columns.
--
-- wfm_cliq_settings — a single global settings row (id is always 'global').
-- Mirrors the old GAS tool's PropertiesService-backed settings: enabled,
-- test mode (prefixes every message with [TEST]), and the cooldown window
-- between repeat alerts for the SAME account (frequency_minutes).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS cliq_channel text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS cliq_last_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS wfm_cliq_settings (
  id                text PRIMARY KEY DEFAULT 'global',
  enabled           boolean DEFAULT false,
  test_mode         boolean DEFAULT true,
  frequency_minutes int DEFAULT 5,
  updated_at        timestamptz DEFAULT now()
);

INSERT INTO wfm_cliq_settings (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;
