-- breach_alarm.sql — one-time column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Per-account breach alarm sound choice for the Overview page's account
-- cards (see lib/alarmSounds.ts). Empty string / NULL = no sound (default).

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS alarm_sound text DEFAULT '';
