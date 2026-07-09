-- ─────────────────────────────────────────────────────────────────────────────
-- Draggable/resizable Dashboard page panels — one-time column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Stores each account's custom panel positions/sizes (KPI group tiles, Breach/
-- Anomalies, Agent Status) from the Dashboard page's new drag/resize feature.
-- wfm_settings is already in the supabase_realtime publication as a whole
-- table, so no separate realtime setup is needed for this new column.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS dashboard_layout jsonb;
