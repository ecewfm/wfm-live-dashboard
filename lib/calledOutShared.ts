// lib/calledOutShared.ts
// The shared side of the "called out" checks: the wfm_called_out table and its
// wfm_called_out_sync() function (sql/called_out.sql). Plain I/O with the
// browser's Supabase client — all the rules (what counts as the same breach,
// when a check clears) are in lib/calledOut.ts and in that SQL function.

import { supabase } from './supabase'
import { CALLED_OUT_GRACE_MS, type CalledOutMarks } from './calledOut'

const TABLE = 'wfm_called_out'

interface DbError { code?: string; message?: string }

/**
 * Is this "the SQL hasn't been run yet" (no such table), as opposed to a
 * network blip or a permissions problem? PostgREST reports a missing table as
 * PGRST205 ("not found in the schema cache"); Postgres itself says 42P01.
 */
export function isMissingTable(err: DbError | null | undefined): boolean {
  if (!err) return false
  return err.code === 'PGRST205' || err.code === '42P01'
    || /could not find the table|schema cache|does not exist/i.test(err.message ?? '')
}

export type FetchResult =
  | { ok: true; marks: CalledOutMarks }
  | { ok: false; missing: boolean; message: string }

/** Every tick on the given accounts, from the shared table. */
export async function fetchSharedMarks(accountIds: string[]): Promise<FetchResult> {
  if (accountIds.length === 0) return { ok: true, marks: {} }
  const { data, error } = await supabase
    .from(TABLE)
    .select('account_id, breach_key, called_by, called_at')
    .in('account_id', accountIds)
  if (error) return { ok: false, missing: isMissingTable(error), message: error.message }

  const marks: CalledOutMarks = {}
  for (const r of (data ?? []) as { account_id: string; breach_key: string; called_by: string | null; called_at: string | null }[]) {
    const at = r.called_at ? Date.parse(r.called_at) : NaN
    ;(marks[r.account_id] ??= {})[r.breach_key] = { by: r.called_by ?? null, at: Number.isFinite(at) ? at : null }
  }
  return { ok: true, marks }
}

/**
 * Tick (on) or untick (off) one row. Throws on failure.
 *
 * Ticking never overwrites an existing row: if another computer ticked the same
 * row a moment earlier, that person stays recorded as who called it, and
 * called_at/last_seen_at are left alone (the database fills them in with ITS
 * clock for a new row — the browsers' clocks never get involved).
 */
export async function setSharedMark(accountId: string, key: string, on: boolean, by: string | null): Promise<void> {
  if (on) {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ account_id: accountId, breach_key: key, called_by: by }, { onConflict: 'account_id,breach_key', ignoreDuplicates: true })
    if (error) throw error
  } else {
    const { error } = await supabase.from(TABLE).delete().eq('account_id', accountId).eq('breach_key', key)
    if (error) throw error
  }
}

/**
 * Tell the database which breaches this screen currently sees for the account,
 * and get back the ticks it cleared because their breach has been gone from
 * EVERY screen for the grace window. Throws on failure. (The rule and why it is
 * judged on the database's clock: see sql/called_out.sql.)
 */
export async function syncSharedMarks(accountId: string, presentKeys: string[]): Promise<string[]> {
  const { data, error } = await supabase.rpc('wfm_called_out_sync', {
    p_account: accountId,
    p_present: presentKeys,
    p_grace_seconds: Math.round(CALLED_OUT_GRACE_MS / 1000),
  })
  if (error) throw error
  return Array.isArray(data) ? (data as string[]) : []
}
