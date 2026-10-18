-- sql/user_auth.sql
-- Users, roles and per-account assignment for the WFM Live Dashboard.
--
-- MODEL: one person = one auth user = one wfm_profiles row, with the accounts
-- they can see held in wfm_user_accounts. This is deliberately NOT the
-- sibling-profile model from the vCORE app (one auth user per account, synced
-- by code). That model exists there because its RLS assumed one account per
-- auth user from day one, and its own write-up lists the cost: N passwords per
-- person to keep in sync, N sequential auth calls at sign-in, renames that
-- split a person in two, and admin resets that only land on one sibling.
-- Nothing here needs that trade, so a membership table it is.
--
-- SCOPE OF PROTECTION — read this before assuming it secures anything:
-- the dashboard's data tables (wfm_kpi_snapshots, *_agent_states, wfm_settings,
-- wfm_accounts, …) are today readable AND writable with the public anon key
-- that ships in every browser bundle. Verified, not assumed. This migration
-- does not change that. What it gives you is real sign-in, real roles and a
-- user list that cannot be tampered with from a browser. It is access
-- ORGANISATION, not a security boundary: a signed-in team lead who opens
-- devtools can still query another account's data directly.
-- Making it a real boundary means RLS on every data table plus moving the
-- dashboard's reads behind the session — a separate, much larger job.
--
-- The two tables below ARE properly locked down, same posture as
-- wfm_cliq_oauth (sql/cliq_oauth_token.sql): RLS on, and the only policies are
-- self-reads. Every write goes through a server route holding the service-role
-- key behind a role check, so a browser can never create a user or change a
-- role no matter what it sends.

-- ── Roles ───────────────────────────────────────────────────────────────────
do $$ begin
  create type wfm_user_role as enum ('superuser', 'rta', 'team_lead');
exception when duplicate_object then null;
end $$;

-- ── Profiles: one row per person, id mirrors auth.users.id ──────────────────
create table if not exists wfm_profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  username            text not null,
  full_name           text,
  -- The synthetic address this user signs in with. Users never see or receive
  -- mail at it; see lib/authEmail.ts for the mapping. Stored so a username
  -- change can locate the auth user without recomputing the slug.
  auth_email          text not null,
  role                wfm_user_role not null default 'team_lead',
  must_reset_password boolean not null default true,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Usernames are global here (unlike vCORE, where they repeat per account),
-- because one person has exactly one login.
create unique index if not exists uq_wfm_profiles_username
  on wfm_profiles (lower(username));
create unique index if not exists uq_wfm_profiles_auth_email
  on wfm_profiles (lower(auth_email));

-- ── Which accounts each user can see ────────────────────────────────────────
-- A superuser has NO rows here: the role itself means "every account", so
-- adding an account doesn't require touching every superuser.
create table if not exists wfm_user_accounts (
  user_id    uuid not null references wfm_profiles(id)  on delete cascade,
  account_id text not null references wfm_accounts(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, account_id)
);
create index if not exists ix_wfm_user_accounts_account on wfm_user_accounts(account_id);

-- ── Keep a profile row in step with its auth user ───────────────────────────
-- Supabase creates the auth user first; the server fills the profile in
-- immediately after. This trigger only guarantees a row exists so a failed
-- follow-up write can't leave an auth user with no profile at all.
create or replace function wfm_handle_new_auth_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into wfm_profiles (id, username, auth_email, full_name)
  values (new.id, new.email, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created_wfm on auth.users;
create trigger on_auth_user_created_wfm
  after insert on auth.users
  for each row execute function wfm_handle_new_auth_user();

-- ── RLS: self-read only; every write is service-role ────────────────────────
alter table wfm_profiles      enable row level security;
alter table wfm_user_accounts enable row level security;

drop policy if exists wfm_profiles_self_read on wfm_profiles;
create policy wfm_profiles_self_read on wfm_profiles
  for select using (id = auth.uid());

drop policy if exists wfm_user_accounts_self_read on wfm_user_accounts;
create policy wfm_user_accounts_self_read on wfm_user_accounts
  for select using (user_id = auth.uid());

-- No insert/update/delete policies exist, so anon and authenticated clients
-- cannot write these tables at all. Belt and braces, in case a policy is ever
-- added carelessly later:
revoke insert, update, delete on wfm_profiles      from anon, authenticated;
revoke insert, update, delete on wfm_user_accounts from anon, authenticated;

-- ── After running this ──────────────────────────────────────────────────────
-- 1. Supabase Dashboard → Authentication → Sign In / Providers →
--    turn OFF "Allow new users to sign up". Public signup is currently ON
--    (verified against the live project); leaving it on would let anyone
--    create an auth user, and the trigger above would hand them a profile.
-- 2. Set SUPABASE_SERVICE_ROLE_KEY in the Vercel env if it isn't already —
--    every user-management route needs it.
-- 3. Seed the first superuser by calling POST /api/auth/bootstrap once
--    (see app/api/auth/bootstrap/route.ts): it creates super@wfmlive with the
--    default password and refuses to run once any superuser exists.
