-- ─────────────────────────────────────────────────────────────────────────────
-- "Called out" checks on the Dashboard page's Breach / Anomalies table —
-- SHARED between every computer / browser viewing the account.
-- Run once in: Supabase Dashboard → SQL Editor → New Query. Safe to re-run.
--
-- Until this is run, the checkboxes still work but are saved in each browser
-- only (lib/calledOut.ts). After it, a tick on one computer shows on every
-- other within ~10 seconds (components poll — Realtime is off, see Dashboard.tsx),
-- along with who ticked it and when.
--
-- THE RULE (lib/calledOut.ts has the long version): a check lives exactly as
-- long as its breach stays in the table. When the agent changes aux / the KPI
-- recovers and the row is gone for the grace window, the check is deleted, and
-- breaching again later starts unchecked.
--
-- Why last_seen_at + a function, instead of every browser deleting on its own:
-- many screens watch the same account, and some may be behind (a backgrounded
-- tab, a slow connection). A screen that is behind must not wipe a check that
-- another screen can see is still valid. So:
--   - every screen that sees the breach in its table "touches" last_seen_at;
--   - a check is only deleted when NO screen has seen its breach for the grace
--     window — judged here, on the database's own clock, so the screens' clocks
--     (which differ) never matter.
-- Both steps happen in wfm_called_out_sync() below, in one round trip.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists wfm_called_out (
  account_id   text        not null,
  -- Identifies "the same breach" across refreshes (kind, agent group, agent or
  -- KPI name, metric — NOT its value). Built by lib/calledOut.ts breachKey();
  -- treat it as opaque. May contain a unit-separator character and "#2"-style
  -- suffixes.
  breach_key   text        not null,
  called_by    text,                                  -- display name of whoever ticked it
  called_at    timestamptz not null default now(),    -- when they ticked it
  last_seen_at timestamptz not null default now(),    -- last time any screen saw this breach in its table
  primary key (account_id, breach_key)
);

-- Same posture as the app's other data tables: the browser's own key reads and
-- writes it directly. The login wall organises who sees which account; it isn't
-- a security boundary (and a tick is not sensitive) — so no service-role route.
alter table wfm_called_out enable row level security;
drop policy if exists wfm_called_out_all on wfm_called_out;
create policy wfm_called_out_all on wfm_called_out
  for all to anon, authenticated using (true) with check (true);
grant select, insert, update, delete on wfm_called_out to anon, authenticated;

-- One call per account, every ~20 seconds per screen, only for accounts that
-- have ticks:
--   1. p_present = the breach keys currently in THIS screen's table → touch them.
--   2. Delete every tick for the account that is NOT among them AND whose
--      breach nobody has seen for p_grace_seconds.
-- Returns the keys it deleted, so the screen can drop them straight away.
create or replace function wfm_called_out_sync(
  p_account       text,
  p_present       text[],
  p_grace_seconds integer default 90
) returns text[]
language plpgsql
set search_path = public
as $$
declare
  gone text[];
begin
  update wfm_called_out
     set last_seen_at = now()
   where account_id = p_account
     and breach_key = any(coalesce(p_present, '{}'));

  with removed as (
    delete from wfm_called_out
     where account_id = p_account
       and not (breach_key = any(coalesce(p_present, '{}')))
       and last_seen_at < now() - make_interval(secs => p_grace_seconds)
    returning breach_key
  )
  select coalesce(array_agg(breach_key), '{}') into gone from removed;

  return gone;
end;
$$;

grant execute on function wfm_called_out_sync(text, text[], integer) to anon, authenticated;
