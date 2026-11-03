-- sql/notification_log.sql
-- The Loggings page (super users): one row per Zoho Cliq message and per
-- Workforce RTA Logs submission the webapp makes — sent or failed. Written by
-- the server (lib/notificationLog.ts, service-role key) from the scan
-- (lib/cliqScan.ts) and the Settings "Test Workforce RTA Logs" button; read
-- only through /api/logs, which checks the caller is a super user.
--
-- RLS on with NO policies, like wfm_cliq_oauth: the public anon key (shipped
-- to every browser) can neither read nor write it — these rows hold breach
-- details (agent names, values) for every account.
--
-- Rows older than 90 days are deleted by the scan itself
-- (pruneNotificationLog). Safe to re-run.

create table if not exists public.wfm_notification_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  kind         text not null check (kind in ('cliq', 'rta_log')),
  account_id   text not null,
  status       text not null check (status in ('sent', 'failed')),
  source       text not null default 'auto' check (source in ('auto', 'force', 'test')),
  summary      text not null,
  breach_count integer,
  error        text,
  details      jsonb not null default '{}'::jsonb
);

create index if not exists wfm_notification_log_created_idx
  on public.wfm_notification_log (created_at desc);
create index if not exists wfm_notification_log_account_idx
  on public.wfm_notification_log (account_id, created_at desc);

alter table public.wfm_notification_log enable row level security;
