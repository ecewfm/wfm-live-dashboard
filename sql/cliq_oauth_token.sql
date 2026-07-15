-- ─────────────────────────────────────────────────────────────────────────────
-- Zoho Cliq OAuth refresh token storage — one-time table add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Stores the refresh token produced by the one-time /api/zoho/authorize →
-- /api/zoho/callback handshake, so the app never has to ask a human to
-- copy/paste it into an env var (mirrors how the old GAS tool's OAuth2
-- library silently persisted it into PropertiesService).
--
-- RLS is enabled with NO policies — this makes the table completely
-- inaccessible via the public anon key (used everywhere else in this app
-- from client-side code), so a live Zoho refresh token can never leak
-- through the same REST API the browser bundle already has credentials for.
-- Only the service_role key (SUPABASE_SERVICE_ROLE_KEY env var, used ONLY by
-- lib/supabaseAdmin.ts, server-only, never NEXT_PUBLIC_) can read/write it —
-- that key bypasses RLS by design.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wfm_cliq_oauth (
  id            text PRIMARY KEY DEFAULT 'global',
  refresh_token text,
  updated_at    timestamptz DEFAULT now()
);

ALTER TABLE wfm_cliq_oauth ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements — deny-all for anon/authenticated roles by default.
