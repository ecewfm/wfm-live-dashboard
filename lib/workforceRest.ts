// lib/workforceRest.ts
// SERVER ONLY. Workforce REST (vCORE) as the KPI source for accounts without a
// CRM dashboard (per the user, 2026-11-09): the client wants their card to agree
// with vCORE's Adherence timeline — vCORE's schedule (Agent Manager's assigned
// weeks + overrides) as the basis of Scheduled Now / the head count, against the
// agents actually logged in on that timeline.
//
// Once a minute runZohoAuxSync (lib/zohoAux.ts) posts every Zoho-KPI account
// here in ONE request and gets the eight tiles back, already in ZohoKpiValues
// shape; vCORE computes them (its lib/live-kpis.ts — rules listed there):
//   Scheduled Now · Logged In (scheduled agents only) · On Break · Not Logged In
//   · Adherence (vCORE's own) · Attendance / Absenteeism / Late Today (this
//   app's rules, on vCORE's schedule).
// An account is matched by its "Workforce REST account" setting
// (DataSourceConfig.restAccount), else its display name — vCORE compares names
// ignoring case and punctuation ("D&L Transport", "EarnIn - Fraud").
//
// FALLBACK (the user's choice): an account vCORE can't answer for — not
// configured, unreachable, too slow, no such account, or vCORE's own Zoho data
// over REST_MAX_AGE_MIN old — keeps the tiles this app works out from Zoho's
// schedule (computeAccountKpis), and the sync log says why.
//
// Env (server-only): WORKFORCE_REST_URL (e.g. https://ecewfmrest.vercel.app) and
// WORKFORCE_REST_KPI_SECRET (the same value as vCORE's WFM_LIVE_KPI_SECRET).
// Either one unset = off: every account stays on Zoho, exactly as before.

import type { DataSourceConfig } from './types'
import type { ZohoKpiValues } from './zohoWorkforce'

/** vCORE's Zoho data older than this → fall back (the same 15 min this app allows its own). */
export const REST_MAX_AGE_MIN = 15
/** The whole request; the minute sync has 60 s and its own Zoho work to do. */
const REST_TIMEOUT_MS = 25_000

export type RestKpi =
  | { ok: true; account: string; values: ZohoKpiValues; zohoAgeMin: number; agents: number }
  | { ok: false; reason: string }

export type RestFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** vCORE's answer (app/api/live/kpis in workforce-rest). */
type RestAnswer = {
  error?: string
  results?: Record<string, { ok?: boolean; reason?: string; account?: string; agents?: number; zohoRefreshedAt?: string | null; values?: unknown }>
}

export function restKpiConfig(env: Record<string, string | undefined> = process.env): { url: string; secret: string } | null {
  const url = env.WORKFORCE_REST_URL?.trim().replace(/\/+$/, '')
  const secret = env.WORKFORCE_REST_KPI_SECRET?.trim()
  return url && secret ? { url, secret } : null
}

/** The name vCORE knows this account by: its "Workforce REST account" setting, else its display name. */
export function restAccountName(ds: Partial<DataSourceConfig> | null | undefined, displayName: string): string {
  const set = typeof ds?.restAccount === 'string' ? ds.restAccount.trim() : ''
  return set || displayName
}

const NUM_KEYS = ['scheduledNow', 'loggedIn', 'onBreak', 'notLoggedIn', 'lateToday', 'shiftsToday', 'started', 'noShows', 'onLeave'] as const
const PCT_KEYS = ['attendance', 'absenteeism', 'adherence'] as const

/** vCORE's values, checked field by field — anything malformed is a failure, not a zero on the card. */
function asValues(raw: unknown): ZohoKpiValues | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  for (const k of NUM_KEYS) if (!finite(v[k])) return null
  for (const k of PCT_KEYS) if (v[k] !== null && !finite(v[k])) return null
  return Object.fromEntries([...NUM_KEYS, ...PCT_KEYS].map(k => [k, v[k]])) as unknown as ZohoKpiValues
}

/**
 * One request for every account; a Map by account id. Never throws — a failure
 * of the whole call comes back as the same reason on every account.
 */
export async function fetchRestKpis(
  asks: { key: string; name: string }[],
  opts: { now: number; env?: Record<string, string | undefined>; fetch?: RestFetch; timeoutMs?: number },
): Promise<Map<string, RestKpi>> {
  const out = new Map<string, RestKpi>()
  const all = (reason: string) => { for (const a of asks) out.set(a.key, { ok: false, reason }); return out }
  const cfg = restKpiConfig(opts.env)
  if (!cfg) return all('not configured')
  if (!asks.length) return out

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REST_TIMEOUT_MS)
  let body: RestAnswer | null
  try {
    const res = await (opts.fetch ?? (fetch as unknown as RestFetch))(`${cfg.url}/api/live/kpis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify({ accounts: asks }),
      signal: ctrl.signal,
    })
    body = (await res.json().catch(() => null)) as RestAnswer | null
    if (!res.ok) return all(`answered HTTP ${res.status}${body?.error ? ` (${body.error})` : ''}`)
  } catch (e) {
    return all(ctrl.signal.aborted ? `no answer within ${Math.round((opts.timeoutMs ?? REST_TIMEOUT_MS) / 1000)} s` : `unreachable — ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }

  const results = body?.results ?? {}
  for (const a of asks) {
    const r = results[a.key]
    if (!r) { out.set(a.key, { ok: false, reason: 'no answer for this account' }); continue }
    if (!r.ok) { out.set(a.key, { ok: false, reason: String(r.reason ?? 'failed') }); continue }
    const values = asValues(r.values)
    if (!values) { out.set(a.key, { ok: false, reason: 'answered with malformed values' }); continue }
    const refreshed = r.zohoRefreshedAt ? Date.parse(r.zohoRefreshedAt) : NaN
    const zohoAgeMin = Number.isFinite(refreshed) ? Math.max(0, (opts.now - refreshed) / 60000) : Infinity
    if (!(zohoAgeMin <= REST_MAX_AGE_MIN)) {
      out.set(a.key, { ok: false, reason: `its Zoho data is ${Number.isFinite(zohoAgeMin) ? `${Math.round(zohoAgeMin)} min old` : 'not synced today yet'}` })
      continue
    }
    out.set(a.key, { ok: true, account: String(r.account ?? a.name), values, zohoAgeMin, agents: Number(r.agents) || 0 })
  }
  return out
}
