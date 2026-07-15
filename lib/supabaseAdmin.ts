// lib/supabaseAdmin.ts
// Server-only Supabase client using the service_role key, which bypasses
// Row Level Security. Never import this from a 'use client' component, and
// never expose SUPABASE_SERVICE_ROLE_KEY as a NEXT_PUBLIC_ variable — unlike
// the anon key (already public, shipped to every browser), this key can read
// and write ANY table regardless of RLS policies.
//
// Only used for wfm_cliq_oauth (the Zoho refresh token store, see
// sql/cliq_oauth_token.sql) — that table has RLS enabled with no policies,
// specifically so the public anon key used everywhere else in this app
// cannot reach it. Everything else keeps using the regular lib/supabase.ts
// client; don't reach for this one unless you're deliberately bypassing RLS.
//
// Lazily initialized (not a top-level createClient() call) so a missing env
// var only throws when this is actually used, not at module load — a
// module-level throw here would crash prerendering the same way a missing
// NEXT_PUBLIC_SUPABASE_URL did in lib/supabase.ts (see that incident).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in this deployment\'s env vars — ' +
      'get the service_role key from Supabase Dashboard → Project Settings → API.'
    )
  }

  _client = createClient(url, serviceRoleKey)
  return _client
}
