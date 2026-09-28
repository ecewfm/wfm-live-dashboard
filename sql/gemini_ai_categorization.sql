-- ─────────────────────────────────────────────────────────────────────────────
-- AI-based Workforce RTA Logs categorization (Gemini) — one-time table/column add
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (every ADD COLUMN/CREATE TABLE is IF NOT EXISTS).
--
-- Per the user (2026-09-28): instead of every "Workforce RTA Logs" webapp
-- request submission always using the one fixed category/sub-category
-- ("Service Level & Volume Management" / "Understaffing Alert" — see
-- lib/zohoWebappRequest.ts), an account can opt into having Gemini group its
-- currently-detected breaches by TYPE (e.g. an SLA breach vs. an individual
-- agent's AUX-duration breach are different things) and pick the real
-- Category/Sub-Category from Zoho's own master list for each group, writing
-- its own natural-language remarks per group instead of the mechanical
-- breach-list formatter. See lib/geminiClassifier.ts.
--
-- wfm_gemini_keys — Gemini API key pool, ROTATED across (lib/geminiKeys.ts
--                    tries each in order on any error) rather than tied to
--                    one account. RLS enabled with NO policies — same
--                    lockdown as wfm_cliq_oauth (sql/cliq_oauth_token.sql):
--                    the public anon key used everywhere else in this app
--                    (including client-side) cannot read/write this table.
--                    Only SUPABASE_SERVICE_ROLE_KEY (lib/supabaseAdmin.ts)
--                    can, so a live Gemini key can never leak through the
--                    same REST API the browser bundle already has
--                    credentials for. Settings UI only ever sees a masked
--                    version (lib/geminiKeys.ts's listGeminiKeysMasked()),
--                    never the raw key back, via app/api/gemini/keys routes.
--
-- wfm_gemini_settings — global Gemini config, currently just `models`: a
--                    comma-separated, ORDERED list of model names (e.g.
--                    "gemini-2.0-flash,gemini-1.5-flash") — per the user
--                    (2026-09-28), tried in the SAME left-to-right,
--                    exhaust-on-error order as the API key pool above, and
--                    for EVERY model, every key is tried before moving to
--                    the next model (see lib/geminiClassifier.ts's nested
--                    loop). Model names aren't secrets, so — unlike the two
--                    tables above — this one has NO RLS lockdown, same
--                    openness as wfm_cliq_settings/wfm_settings (read/write
--                    directly with the anon key, no service-role route
--                    needed). Blank/no row = fall back to a single
--                    hardcoded default model.
--
-- rta_ai_categorization_enabled — per-account toggle (wfm_settings), same
--                    "no global switch" posture as rta_logs_enabled itself —
--                    an account can turn this on independently, so a bad key
--                    or a Gemini outage only affects accounts that opted in.
--                    If Gemini fails for a scan cycle (every model/key
--                    combination errors, or none of its picks match a real
--                    Zoho category), that account's RTA Logs submission is
--                    SKIPPED for that cycle and retried next time —
--                    deliberately NOT falling back to the fixed category,
--                    so a mismatched/generic category is never sent just to
--                    force something through.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wfm_gemini_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text,
  api_key      text NOT NULL,
  last_error   text,
  last_used_at timestamptz,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE wfm_gemini_keys ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements — deny-all for anon/authenticated roles by default.

CREATE TABLE IF NOT EXISTS wfm_gemini_settings (
  id     text PRIMARY KEY DEFAULT 'global',
  models text
);
-- Deliberately NOT RLS-locked — see comment above.

ALTER TABLE wfm_settings ADD COLUMN IF NOT EXISTS rta_ai_categorization_enabled boolean DEFAULT false;
