// lib/geminiClassifier.ts
// Server-only — uses Google's Gemini API to group an account's currently
// detected breaches into one or more Workforce RTA Logs submissions, each
// tagged with a REAL Category/Sub-Category from Zoho's own master list
// (populated in wfm_zoho_field_options by lib/zohoFieldScan.ts's daily scan,
// read here via lib/settings.ts's loadZohoFieldOptions) instead of the single
// fixed category/sub-category every account used before this existed (see
// lib/zohoWebappRequest.ts's BREACH_CATEGORY/BREACH_SUB_CATEGORY).
//
// Per the user (2026-09-28):
//   - Opt-in PER ACCOUNT (wfm_settings.rta_ai_categorization_enabled) — a bad
//     key or a Gemini outage only affects accounts that turned this on.
//   - Rotates across however many API keys AND models are configured
//     (lib/geminiKeys.ts / lib/geminiModels.ts) — the SAME left-to-right,
//     exhaust-on-error pattern for both: for each model (in configured
//     order), every key is tried (in configured order) before moving to the
//     next model. Tries the next combination on ANY error (bad key, quota,
//     network, malformed response, unrecognized model name).
//   - If EVERY model/key combination fails, or none of a response's picks
//     match a real Zoho category/sub-category, the caller skips sending
//     anything for that account this cycle and retries next time —
//     deliberately NOT falling back to the fixed category, so a
//     mismatched/generic category is never sent just to force something
//     through.

import { getRawGeminiKeys, recordGeminiKeyResult } from './geminiKeys'
import { loadGeminiModels } from './geminiModels'
import type { BreachRow } from './breaches'
import type { ZohoFieldOption } from './settings'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface RtaLogGroup {
  category: string
  subCategory: string
  remarks: string
}

interface CategoryTree {
  category: string
  subCategories: string[]
}

function buildCategoryTree(categories: ZohoFieldOption[], subCategories: ZohoFieldOption[]): CategoryTree[] {
  return categories
    .map(cat => ({
      category: cat.label,
      subCategories: subCategories.filter(s => s.parentId === cat.id).map(s => s.label),
    }))
    .filter(c => c.subCategories.length > 0)
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    groups: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          category:     { type: 'STRING' },
          sub_category: { type: 'STRING' },
          remarks:      { type: 'STRING' },
        },
        required: ['category', 'sub_category', 'remarks'],
      },
    },
  },
  required: ['groups'],
}

function buildPrompt(accountId: string, breaches: BreachRow[], tree: CategoryTree[]): string {
  const breachList = breaches
    .map((b, i) => `${i + 1}. Entity: "${b.entity}" | Metric: "${b.metric}" | Value: "${b.value}" | Threshold: "${b.threshold}" | Severity: ${b.severity}`)
    .join('\n')

  const treeText = tree.map(c => `- ${c.category}: ${c.subCategories.map(s => `"${s}"`).join(', ')}`).join('\n')

  return `You are categorizing live call-center breach alerts for the account "${accountId}" into Zoho Creator "Workforce RTA Logs" tickets.

VALID CATEGORIES AND SUB-CATEGORIES (you MUST pick category and sub_category EXACTLY as spelled here — do not invent new ones, do not change capitalization or punctuation):
${treeText}

CURRENTLY DETECTED BREACHES for ${accountId}:
${breachList}

TASK: Group these breaches into one or more submissions. Breaches of the same underlying type (e.g. several different agents all breaching the same metric) belong in ONE group together — do not split one group into a submission per agent. Breaches of clearly different types (e.g. an overall SLA/queue breach vs. an individual agent's status/AUX-duration breach) belong in SEPARATE groups, each with whichever category/sub_category best matches that group's actual nature — do not default every group to the same one.

For each group, write "remarks" as a short, clear, professional summary a Real Time Analyst would read — mention the specific entity/agent name(s) and value(s) involved (e.g. "3 agents exceeded their allowed Case Follow Up Duration: Lemuel France Amper (1m), Mary Ann De Mesa (2m 1s), Donna Gonzales (11m 20s)."). Do not invent information not present in the breach list above, and do not drop any breach — every one listed above must belong to exactly one group.

Return ONLY the JSON groups.`
}

async function callGeminiOnce(model: string, apiKey: string, prompt: string): Promise<RtaLogGroup[]> {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini HTTP ${res.status}: ${body.substring(0, 300)}`)
  }
  const data: any = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Gemini returned no content: ${JSON.stringify(data).substring(0, 300)}`)

  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed?.groups)) throw new Error('Gemini response missing a "groups" array')

  return parsed.groups.map((g: any) => ({
    category: String(g.category || ''),
    subCategory: String(g.sub_category || ''),
    remarks: String(g.remarks || ''),
  }))
}

// Tries every configured MODEL, and for each model every configured KEY, in
// order — skipping to the next combination on ANY error. Throws only once
// every model/key combination has failed, so the caller can decide to skip
// this account's RTA Logs submission for the cycle entirely (per the user's
// explicit choice — see file header).
export async function classifyBreachesForRtaLog(
  accountId: string,
  breaches: BreachRow[],
  categories: ZohoFieldOption[],
  subCategories: ZohoFieldOption[]
): Promise<RtaLogGroup[]> {
  const [keys, models] = await Promise.all([getRawGeminiKeys(), loadGeminiModels()])
  if (keys.length === 0) throw new Error('No Gemini API keys configured (Settings > Zoho Integrations > AI Categorization)')

  const tree = buildCategoryTree(categories, subCategories)
  if (tree.length === 0) throw new Error('No Category/Sub-Category options scanned yet — run "Scan Zoho Field Options Now" in Settings first')

  const prompt = buildPrompt(accountId, breaches, tree)

  const errors: string[] = []
  for (const model of models) {
    for (const key of keys) {
      try {
        const groups = await callGeminiOnce(model, key.api_key, prompt)
        if (groups.length === 0) throw new Error('Gemini returned zero groups')

        // Validate every group's category/sub_category against the REAL tree
        // — Zoho's own processing script rejects anything that doesn't
        // exactly match its master list (confirmed live already for account
        // name/site/requested_by) — drop only the invalid groups, keep the
        // rest, rather than discarding the whole response over one bad pick.
        const valid = groups
          .map(g => {
            const cat = tree.find(c => c.category.toLowerCase() === g.category.trim().toLowerCase())
            if (!cat) return null
            const sub = cat.subCategories.find(s => s.toLowerCase() === g.subCategory.trim().toLowerCase())
            if (!sub) return null
            // Normalize to Zoho's own exact spelling/casing, even when
            // Gemini echoed back something that only differs in case, so
            // the submission always matches byte-for-byte.
            return { category: cat.category, subCategory: sub, remarks: g.remarks }
          })
          .filter((g): g is RtaLogGroup => g !== null)

        if (valid.length === 0) throw new Error(`None of Gemini's picks matched a real Zoho category/sub-category: ${JSON.stringify(groups).substring(0, 300)}`)

        await recordGeminiKeyResult(key.id, null)
        return valid
      } catch (e: any) {
        errors.push(`[${model} / ${key.label || key.id}] ${e.message}`)
        await recordGeminiKeyResult(key.id, e.message).catch(() => {})
      }
    }
  }
  throw new Error(`All Gemini model/key combination(s) failed: ${errors.join(' | ')}`)
}
