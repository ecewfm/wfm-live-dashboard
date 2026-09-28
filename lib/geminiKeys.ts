// lib/geminiKeys.ts
// Server-only — CRUD for the Gemini API key pool used by
// lib/geminiClassifier.ts's AI-based Workforce RTA Logs category/sub-category
// grouping (see sql/gemini_ai_categorization.sql for why this exists). Locked
// down the SAME way as wfm_cliq_oauth (lib/supabaseAdmin.ts, service_role
// only) — these are live third-party API credentials, not app config, so the
// public anon key used everywhere else in this app can never read/write this
// table. Never import from a 'use client' component.

import { getSupabaseAdmin } from './supabaseAdmin'

export interface GeminiKeyRecord {
  id: string
  label: string | null
  api_key: string
  last_error: string | null
  last_used_at: string | null
  created_at: string
}

export interface GeminiKeyMasked {
  id: string
  label: string
  maskedKey: string
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
}

// Never sent back to the client whole — only enough to recognize which key
// is which (e.g. to tell two keys apart, or notice a stale/broken one).
function maskKey(key: string): string {
  if (key.length <= 10) return '•'.repeat(key.length)
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

const SELECT_COLS = 'id, label, api_key, last_error, last_used_at, created_at'

// ── Settings UI reads (masked) ──────────────────────────────────────────────
export async function listGeminiKeysMasked(): Promise<GeminiKeyMasked[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('wfm_gemini_keys')
    .select(SELECT_COLS)
    .order('created_at')
  if (error || !data) return []
  return (data as unknown as GeminiKeyRecord[]).map(r => ({
    id: r.id,
    label: r.label || '(unlabeled)',
    maskedKey: maskKey(r.api_key),
    lastError: r.last_error,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }))
}

export async function addGeminiKey(apiKey: string, label?: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('API key is required')
  const { error } = await getSupabaseAdmin()
    .from('wfm_gemini_keys')
    .insert({ api_key: trimmed, label: label?.trim() || null })
  if (error) throw new Error(error.message)
}

export async function deleteGeminiKey(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from('wfm_gemini_keys').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── lib/geminiClassifier.ts reads (raw, unmasked) — never exposed to the
// client; only this module and the classifier ever see a real key value. ───
export async function getRawGeminiKeys(): Promise<GeminiKeyRecord[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('wfm_gemini_keys')
    .select(SELECT_COLS)
    .order('created_at')
  if (error || !data) return []
  return data as unknown as GeminiKeyRecord[]
}

// Tracked purely for visibility in the Settings UI (which key errored last,
// and when any key was last actually used) — rotation itself doesn't need
// this persisted since it just tries every key in order on each call.
export async function recordGeminiKeyResult(id: string, errorMessage: string | null): Promise<void> {
  await getSupabaseAdmin()
    .from('wfm_gemini_keys')
    .update({ last_error: errorMessage, last_used_at: new Date().toISOString() })
    .eq('id', id)
}
