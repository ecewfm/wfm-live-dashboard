-- ─────────────────────────────────────────────────────────────────────────────
-- Workforce RTA Logs — per-account scope: WHICH breach kinds the automatic
-- webapp-request reporting includes. Run once in: Supabase Dashboard → SQL
-- Editor → New Query. Safe to re-run (ADD COLUMN is IF NOT EXISTS).
--
-- Per the user (2026-09-29): an account can independently toggle whether the
-- automatic RTA Logs send considers KPI Tile breaches (SLA, Abandon Rate,
-- etc. — BreachRow.kind === 'kpi') and/or Agent Status breaches
-- (BreachRow.kind === 'agent'). Default is KPI Tiles ON, Agent Status OFF —
-- see lib/cliqScan.ts's processAccount() RTA Logs block for where this
-- filters the breach list before change-detection/remarks/AI classification.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_report_kpi boolean DEFAULT true;
ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_report_agent_status boolean DEFAULT false;
