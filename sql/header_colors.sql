-- ─────────────────────────────────────────────────────────────────────────────
-- Per-account Overview header colors (band background + title text) — one-time
-- column add. Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Lets every user see the same account color-coding on the All Accounts
-- Overview page, instead of it being a per-browser localStorage preference.
-- wfm_settings is already in the supabase_realtime publication as a whole
-- table, so no separate realtime setup is needed for these new columns.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS header_band_color text;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS header_text_color text;
