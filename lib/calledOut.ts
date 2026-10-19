// lib/calledOut.ts
// "Called out" check marks on the Breach / Anomalies table of the Dashboard page
// (not the Overview cards — those stay a compact at-a-glance view). An RTA ticks
// a row once they've called that agent / raised that breach, so nobody has to
// remember — or do it twice.
//
// THE RULE (as the users asked for it): a check lives exactly as long as its
// breach does. The moment the row leaves the table — the agent changed aux,
// the KPI recovered — the check is gone, and if that agent/KPI breaches again
// later it is a NEW breach and starts unchecked. Only an UNBROKEN stay in the
// table keeps the check.
//
// "Leaves the table" needs one careful definition. The agent timers on the
// page tick locally every second and are re-synced from the scraper's numbers
// at every ~30s refresh — and those numbers are up to ~30s old when they
// arrive, so a duration that has only just crossed its threshold can drop back
// under it for a few seconds and then re-cross. Resetting on that would uncheck
// a box the user ticked a moment ago, for a breach that never actually ended.
// So a row has to be GONE for CALLED_OUT_GRACE_MS before its check is cleared.
// A genuine end can't sneak back inside the grace window for an agent: coming
// back means a fresh status that has to run its whole threshold again.
//
// WHERE THE CHECKS LIVE: in the shared wfm_called_out table (sql/called_out.sql),
// so a tick on one computer shows on every other watching the account, with who
// ticked it and when (lib/calledOutShared.ts, driven by lib/useCalledOut.ts).
// Until that SQL has been run, the checks fall back to this browser's
// localStorage — the functions at the bottom of this file — so the feature
// never just stops working. The grace-window rule is the same either way.

import type { BreachRow } from './breaches'

/** How long a checked row may be missing before its check is cleared. */
export const CALLED_OUT_GRACE_MS = 90_000

const STORAGE_KEY = 'wfm_called_out'
const SEP = '\u001f'

/** One checked row. `by`/`at` are unknown for a check saved only in this browser. */
export interface CalledOutMark { by: string | null; at: number | null }
/** account id -> breach key -> its mark. What the tables draw their checkboxes from. */
export type CalledOutMarks = Record<string, Record<string, CalledOutMark>>

// ── Browser-only storage (the fallback) ──────────────────────────────────────
/** breach key -> when that breach was last seen in the table (ms since epoch). */
export type CalledOutMap = Record<string, number>
/** account id -> that account's called-out breaches. */
export type CalledOutAll = Record<string, CalledOutMap>

/**
 * What makes a row "the same breach" from one refresh to the next:
 * its kind, the agent's group, who/what it's about, and which metric. Notably
 * NOT the value or threshold — an SLA sliding 74% -> 72% is still the same
 * breach — and the metric of a duration breach includes the status ("Break
 * Duration"), so an agent changing aux becomes a different key by itself.
 */
export function breachKey(b: BreachRow): string {
  return [b.kind, b.group ?? '', b.entity, b.metric].join(SEP)
}

/**
 * A key for every row. Two rows that would share a key (the same agent
 * breaching the same metric twice) get a "#2", "#3"… suffix in row order, so
 * each has its own checkbox instead of two boxes that toggle together.
 */
export function keyBreaches(rows: BreachRow[]): { row: BreachRow; key: string }[] {
  const seen = new Map<string, number>()
  return rows.map(row => {
    const base = breachKey(row)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { row, key: n === 1 ? base : `${base}#${n}` }
  })
}

/**
 * Bring one account's checks up to date with what is in the table now. PURE.
 *   - checked and still there      -> kept, last-seen refreshed to `now`
 *   - checked, missing, within the grace window -> kept (see the header)
 *   - checked, missing for longer  -> dropped: it's reset
 * `dropped` lets the caller tell "something was cleared" (re-render + save)
 * from the every-second no-op.
 */
export function reconcileCalledOut(
  marked: CalledOutMap, present: Set<string>, now: number, graceMs = CALLED_OUT_GRACE_MS,
): { next: CalledOutMap; dropped: string[] } {
  const next: CalledOutMap = {}
  const dropped: string[] = []
  for (const [key, lastSeen] of Object.entries(marked)) {
    if (present.has(key)) next[key] = now
    else if (now - lastSeen <= graceMs) next[key] = lastSeen
    else dropped.push(key)
  }
  return { next, dropped }
}

/** A browser-only store, as the marks the tables read (who/when are unknown). */
export function localToMarks(all: CalledOutAll): CalledOutMarks {
  const out: CalledOutMarks = {}
  for (const [acc, marked] of Object.entries(all)) {
    const keys = Object.keys(marked)
    if (!keys.length) continue
    out[acc] = {}
    for (const k of keys) out[acc][k] = { by: null, at: null }
  }
  return out
}

// ── Persistence (browser-only fallback) ───────────────────────────────────────
// Defensive on every path: private windows / blocked storage throw, and an old
// or hand-edited value must never take the dashboard down.
export function loadCalledOut(): CalledOutAll {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CalledOutAll = {}
    for (const [acc, marked] of Object.entries(parsed as Record<string, unknown>)) {
      if (!marked || typeof marked !== 'object' || Array.isArray(marked)) continue
      const clean: CalledOutMap = {}
      for (const [key, seen] of Object.entries(marked as Record<string, unknown>)) {
        if (typeof seen === 'number' && Number.isFinite(seen)) clean[key] = seen
      }
      if (Object.keys(clean).length) out[acc] = clean
    }
    return out
  } catch {
    return {}
  }
}

export function saveCalledOut(all: CalledOutAll): void {
  try {
    const slim: CalledOutAll = {}
    for (const [acc, marked] of Object.entries(all)) if (Object.keys(marked).length) slim[acc] = marked
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
  } catch { /* storage unavailable — the checks just won't survive a reload */ }
}
