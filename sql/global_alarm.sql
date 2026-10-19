-- sql/global_alarm.sql
-- Global breach alarm: one sound, set by a super user, used for every account.
-- See lib/globalAlarm.ts for the rules, components/AlarmTab.tsx for the UI.
--
-- Replaces the per-account `wfm_settings.alarm_sound` idea in practice: that
-- column was never migrated on this project (verified 2026-10-19 — "column
-- wfm_settings.alarm_sound does not exist"), so per-account alarms have been
-- silent for every account all along.

-- ── Settings: exactly one row, id = 'global' ────────────────────────────────
create table if not exists wfm_alarm_settings (
  id              text primary key default 'global' check (id = 'global'),
  enabled         boolean not null default false,
  -- 'builtin' = one of the synthesized sounds in lib/alarmSounds.ts;
  -- 'upload'  = a file in the wfm-alarm-sounds bucket below.
  sound_kind      text not null default 'builtin' check (sound_kind in ('builtin', 'upload')),
  builtin_key     text not null default 'siren',
  sound_url       text,        -- public URL of the uploaded file
  sound_path      text,        -- its path in the bucket, so it can be deleted on replace
  sound_name      text,        -- original filename, for display
  volume          real not null default 0.8 check (volume between 0 and 1),
  -- 'all' = warning + critical breaches; 'critical' = critical only.
  severity        text not null default 'all' check (severity in ('all', 'critical')),
  -- Never ring more often than this, however many accounts change at once.
  min_gap_seconds integer not null default 30 check (min_gap_seconds between 0 and 3600),
  updated_at      timestamptz not null default now(),
  updated_by      text
);
insert into wfm_alarm_settings (id) values ('global') on conflict (id) do nothing;

-- Every dashboard reads this (that's how each screen learns the sound), so
-- reads are open. Writes are NOT: no write policy exists, and the grants are
-- revoked — only app/api/alarm/* can change it, with the service-role key,
-- after checking the caller is a super user.
alter table wfm_alarm_settings enable row level security;
drop policy if exists wfm_alarm_settings_read on wfm_alarm_settings;
create policy wfm_alarm_settings_read on wfm_alarm_settings for select using (true);
revoke insert, update, delete on wfm_alarm_settings from anon, authenticated;

-- ── Storage for the uploaded sound ──────────────────────────────────────────
-- Public bucket: browsers play the file straight from its public URL. Uploads
-- and deletes only happen server-side with the service role (which bypasses
-- storage RLS), so no storage policies are needed — anon/authenticated
-- clients can't write to it. Size and type are capped here as well as in the
-- upload route.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wfm-alarm-sounds', 'wfm-alarm-sounds', true, 2097152,   -- 2 MB
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
        'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a']
)
on conflict (id) do nothing;
