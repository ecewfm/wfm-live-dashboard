-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho breaks & aux → each account's "Zoho Breaks & Aux" agent section
-- Run once in: Supabase Dashboard → SQL Editor → New Query. Safe to re-run.
-- See lib/zohoAux.ts (pull + cache) and lib/zohoAuxShared.ts (the rules).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The ORGANISATION-WIDE cache of parsed Zoho logs — one row per date × kind ×
--    employee × source app, the same shape as Workforce R.E.S.T. vCORE's
--    zoho_activity. Every employee's logs, not just one account's, so it is
--    locked to the server: RLS on, NO policies (only the service-role key used
--    by the cron can read or write it — same lock-down as wfm_cliq_oauth).
CREATE TABLE IF NOT EXISTS wfm_zoho_activity (
  log_date      date        NOT NULL,
  kind          text        NOT NULL,              -- 'sessions' | 'breaks'
  employee_norm text        NOT NULL,              -- normalizeName(Employee)
  source        text        NOT NULL DEFAULT 'primary',   -- 'primary' | 'honduras'
  payload       jsonb       NOT NULL,              -- array of parsed sessions / breaks (UTC)
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (log_date, kind, employee_norm, source)
);
CREATE INDEX IF NOT EXISTS idx_wfm_zoho_activity_date ON wfm_zoho_activity (log_date);
ALTER TABLE wfm_zoho_activity ENABLE ROW LEVEL SECURITY;

-- 2. When each date was last pulled (and when a pull started, so two overlapping
--    cron runs don't both call Zoho). refreshed_at is NULL until a pull of that
--    date has actually finished. Server-only, like the cache.
CREATE TABLE IF NOT EXISTS wfm_zoho_sync (
  log_date     date PRIMARY KEY,
  refreshed_at timestamptz,
  started_at   timestamptz,
  note         text
);
ALTER TABLE wfm_zoho_sync ENABLE ROW LEVEL SECURITY;

-- 3. What each enabled account's dashboard shows: the agents (by this account's
--    own names) who are on a Zoho break or aux right now, and since when. Read by
--    the dashboard with the public key, like every other agent table, so no RLS.
CREATE TABLE IF NOT EXISTS wfm_zoho_agent_status (
  id          text PRIMARY KEY,         -- "{account_id}:{normalized name}"
  account_id  text NOT NULL,
  agent_name  text NOT NULL,            -- as THIS account shows the agent
  zoho_name   text,                     -- as Zoho has them
  status      text NOT NULL,            -- the Zoho Type: "15 Minute Break", "1 Hour Lunch", "Chat", …
  category    text,                     -- 'break' (breaks & lunch) | 'aux'
  since       timestamptz NOT NULL,     -- when it started; the dashboard counts the duration from this
  source      text,                     -- which Zoho app: 'primary' | 'honduras'
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wfm_zoho_agent_status_account ON wfm_zoho_agent_status (account_id);
ALTER TABLE wfm_zoho_agent_status DISABLE ROW LEVEL SECURITY;
