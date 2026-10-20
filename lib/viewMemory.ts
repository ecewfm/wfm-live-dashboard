// lib/viewMemory.ts
// What THIS browser tab was last looking at — which page (Overview / Dashboard)
// and which account — so a reload puts the person back where they were instead
// of on the Overview. That matters most for the automatic reload that picks up
// a new deployment (the version check in components/Dashboard.tsx): without
// this, every deploy sent every open screen back to the Overview, and each
// person had to click their way back to their own account's dashboard.
//
// sessionStorage, deliberately NOT localStorage:
//   - it survives a reload (auto or F5) and a browser's "restore tabs", so the
//     tab comes straight back to the same view;
//   - but it belongs to ONE tab. localStorage is shared by every tab of the
//     browser, so two tabs open on two different accounts would overwrite each
//     other's "last account" and one of them would come back on the wrong one.
// A brand-new tab has no memory and starts where it always did (Overview; the
// account falls back to the browser-wide wfm_current_account).

const KEY = 'wfm_view'

export type ViewPage = 'overview' | 'dashboard'
export interface ViewMemory { page?: ViewPage; account?: string }

/** The remembered view, or {} when there is none / it is unreadable. Never throws. */
export function loadView(): ViewMemory {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: ViewMemory = {}
    if (raw.page === 'overview' || raw.page === 'dashboard') out.page = raw.page
    if (typeof raw.account === 'string' && raw.account) out.account = raw.account
    return out
  } catch {
    return {}
  }
}

/** Remember part of the view; whatever isn't given keeps its remembered value. Never throws. */
export function saveView(patch: ViewMemory): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...loadView(), ...patch })) } catch { /* storage unavailable — it just won't be remembered */ }
}

/**
 * Which account to open on: this tab's remembered one, else the browser-wide last
 * one, else the first — but only ever one the person can actually see (an
 * account may have been removed or unassigned since it was remembered).
 */
export function pickAccount(visible: string[], tabAccount: string | undefined, browserAccount: string | null | undefined): string {
  for (const a of [tabAccount, browserAccount || undefined]) if (a && visible.includes(a)) return a
  return visible[0] ?? ''
}
