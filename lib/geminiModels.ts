// lib/geminiModels.ts
// The ordered Gemini model list used by lib/geminiClassifier.ts, tried in
// the SAME left-to-right, exhaust-on-error order as the API key pool
// (lib/geminiKeys.ts) — see sql/gemini_ai_categorization.sql. Model NAMES
// aren't secrets (unlike the API keys), so this table has no RLS lockdown —
// safe to read/write directly with the anon client, from either client or
// server code, same openness as wfm_cliq_settings/wfm_settings.

import { supabase } from './supabase'

// Used whenever wfm_gemini_settings has no row yet, or an empty models
// list — the feature works out of the box without anyone having to add a
// model first, same as the API key pool needing at least one key added.
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'

export async function loadGeminiModels(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('wfm_gemini_settings')
      .select('models')
      .eq('id', 'global')
      .maybeSingle()
    if (error || !data?.models) return [DEFAULT_GEMINI_MODEL]
    const models = String(data.models).split(',').map(m => m.trim()).filter(Boolean)
    return models.length > 0 ? models : [DEFAULT_GEMINI_MODEL]
  } catch {
    return [DEFAULT_GEMINI_MODEL]
  }
}

export async function saveGeminiModels(models: string[]): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('wfm_gemini_settings')
      .upsert({ id: 'global', models: models.join(',') })
    return !error
  } catch {
    return false
  }
}
