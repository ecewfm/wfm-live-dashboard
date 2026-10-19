'use client'

// lib/useCalledOut.ts
// The state behind the "called out" checkboxes on the Dashboard page's Breach /
// Anomalies table. The RULES are in lib/calledOut.ts (and sql/called_out.sql);
// this hook is the plumbing that keeps what's on screen in step with them.
//
// TWO BACKENDS, one interface — the screen only ever sees `marks`:
//   'shared' the wfm_called_out table. A tick on one computer reaches every
//            other within POLL_SHARED_MS. The default, once sql/called_out.sql
//            has been run.
//   'local'  this browser's localStorage. Used until that SQL has been run (and
//            re-checked every POLL_LOCAL_MS, so running it takes effect on open
//            screens without a reload) so the checkboxes never just stop working.
//   'unknown' the very first read hasn't answered yet (checkboxes wait).
// The first time a screen reaches 'shared', any checks saved by the browser-only
// version are uploaded once, so nobody loses what they had ticked.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BreachRow } from './breaches'
import {
  keyBreaches, reconcileCalledOut, localToMarks, loadCalledOut, saveCalledOut,
  type CalledOutAll, type CalledOutMarks,
} from './calledOut'
import { fetchSharedMarks, setSharedMark, syncSharedMarks, isMissingTable } from './calledOutShared'

export type CalledOutMode = 'unknown' | 'shared' | 'local'

/** How often a screen re-reads the shared ticks — i.e. how soon another computer's tick shows up. */
const POLL_SHARED_MS = 10_000
/** While browser-only, how often to check whether the SQL has been run since. */
const POLL_LOCAL_MS = 60_000
/** Per account with ticks: how often this screen reports "I can still see these breaches". Well inside the 90s grace window. */
const SYNC_MS = 20_000
const LOCAL_SAVE_MS = 20_000

interface Args {
  accounts: string[]
  allBreaches: Record<string, BreachRow[]>
  /** Accounts whose data AND settings have loaded (anything less can't tell "gone" from "not loaded yet"). */
  readyIds: Set<string>
  /** The subset of readyIds whose data is not stale. Only these may vouch that a breach is still there. */
  freshIds: Set<string>
  /** Recorded as who called it. */
  me: string | null
}

// A cheap fingerprint, so a poll that returns nothing new doesn't re-render the dashboard.
const signature = (m: CalledOutMarks) =>
  Object.keys(m).sort()
    .map(acc => Object.keys(m[acc]).sort().map(k => `${acc}\u0000${k}\u0000${m[acc][k].by ?? ''}\u0000${m[acc][k].at ?? ''}`).join('\n'))
    .join('\n')

export function useCalledOut({ accounts, allBreaches, readyIds, freshIds, me }: Args) {
  const [marks, setMarksState] = useState<CalledOutMarks>({})
  const [mode, setModeState] = useState<CalledOutMode>('unknown')
  // Refs mirror the state so callbacks and timers always see the latest values.
  const marksRef = useRef<CalledOutMarks>({})
  const modeRef = useRef<CalledOutMode>('unknown')
  const latest = useRef({ accounts, readyIds, freshIds, me })
  latest.current = { accounts, readyIds, freshIds, me }

  // shared backend
  const reloading = useRef(false)
  const reloadAgain = useRef(false)
  const lastToggleAt = useRef(0)
  const writesInFlight = useRef(0)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const lastSync = useRef<Record<string, number>>({})
  const migrated = useRef(false)
  // local backend
  const localRef = useRef<CalledOutAll>({})
  const localSavedAt = useRef(0)

  const setMarks = useCallback((next: CalledOutMarks) => {
    if (signature(next) === signature(marksRef.current)) return
    marksRef.current = next
    setMarksState(next)
  }, [])

  // ── browser-only backend ───────────────────────────────────────────────────
  const enterLocal = useCallback(() => {
    if (modeRef.current === 'local') return
    modeRef.current = 'local'
    setModeState('local')
    localRef.current = loadCalledOut()
    setMarks(localToMarks(localRef.current))
  }, [setMarks])

  // Upload whatever the browser-only version had saved, once, then retire it.
  // Returns true when it uploaded something (so the caller re-reads).
  const migrateLocal = useCallback(async (): Promise<boolean> => {
    if (migrated.current) return false
    const local = loadCalledOut()
    const visible = new Set(latest.current.accounts)
    let uploaded = false
    for (const [acc, keys] of Object.entries(local)) {
      if (!visible.has(acc)) continue
      for (const key of Object.keys(keys)) {
        try { await setSharedMark(acc, key, true, latest.current.me); uploaded = true }
        catch { return uploaded }              // try again on the next read; local copy stays until it all goes up
      }
    }
    // Retire the browser-only copy — but only if there was one: a screen that
    // never used it shouldn't gain an empty storage entry.
    if (Object.keys(local).length > 0) saveCalledOut({})
    migrated.current = true
    return uploaded
  }, [])

  // ── shared backend: read ───────────────────────────────────────────────────
  const reload = useCallback(async function run(): Promise<void> {
    if (reloading.current) { reloadAgain.current = true; return }
    const accts = latest.current.accounts
    if (accts.length === 0) return
    reloading.current = true
    try {
      const startedAt = Date.now()
      const res = await fetchSharedMarks(accts)
      if (!res.ok) {
        if (res.missing) enterLocal()
        return                                  // any other failure: keep what is on screen, retry on the next poll
      }
      // This snapshot may predate a tick/untick made here a moment ago, and would
      // briefly flip the box back. While a write is still in flight the write
      // itself triggers a fresh read when it finishes; otherwise read again now.
      if (writesInFlight.current > 0) return
      if (startedAt < lastToggleAt.current) { reloadAgain.current = true; return }

      if (modeRef.current !== 'shared') { modeRef.current = 'shared'; setModeState('shared') }
      if (!migrated.current && await migrateLocal()) { reloadAgain.current = true; return }
      setMarks(res.marks)
    } finally {
      reloading.current = false
      if (reloadAgain.current) { reloadAgain.current = false; void run() }
    }
  }, [enterLocal, migrateLocal, setMarks])

  // ── tick / untick ──────────────────────────────────────────────────────────
  const toggle = useCallback((accountId: string, key: string) => {
    const m = modeRef.current
    if (m === 'unknown') return
    const cur = marksRef.current
    const on = !cur[accountId]?.[key]

    // Optimistic: the box responds at once; the write follows.
    const accMarks = { ...(cur[accountId] ?? {}) }
    if (on) accMarks[key] = { by: latest.current.me, at: Date.now() }
    else delete accMarks[key]
    setMarks({ ...cur, [accountId]: accMarks })

    if (m === 'local') {
      const all = localRef.current
      const map = { ...(all[accountId] ?? {}) }
      if (on) map[key] = Date.now(); else delete map[key]
      all[accountId] = map
      saveCalledOut(all); localSavedAt.current = Date.now()
      return
    }

    lastToggleAt.current = Date.now()
    writesInFlight.current++
    writeChain.current = writeChain.current
      .then(() => setSharedMark(accountId, key, on, latest.current.me))
      .catch(err => {
        console.warn('[called-out] could not save a tick:', err?.message ?? err)
        if (isMissingTable(err)) enterLocal()
      })
      .finally(() => {
        writesInFlight.current--
        if (writesInFlight.current === 0) void reload()   // re-read: shows what is really stored (also undoes a failed tick)
      })
  }, [enterLocal, reload, setMarks])

  // ── poll the shared ticks ──────────────────────────────────────────────────
  const accountsKey = accounts.join('|')
  useEffect(() => {
    if (!accountsKey) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      await reload()
      if (!alive) return
      timer = setTimeout(loop, modeRef.current === 'local' ? POLL_LOCAL_MS : POLL_SHARED_MS)
    }
    void loop()
    // Coming back to a tab that sat in the background: catch up straight away.
    const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [accountsKey, reload])

  // ── keep the ticks honest as breaches come and go ──────────────────────────
  // Runs whenever the breach lists change (about once a second).
  useEffect(() => {
    const now = Date.now()
    const { readyIds, freshIds } = latest.current

    if (modeRef.current === 'local') {
      const all = localRef.current
      let cleared = false
      for (const [acc, marked] of Object.entries(all)) {
        if (Object.keys(marked).length === 0) continue
        // Not ready -> can't tell "the breach ended" from "nothing loaded yet";
        // guessing wrong would wipe every check on every page load.
        if (!readyIds.has(acc)) continue
        const present = new Set(keyBreaches(allBreaches[acc] ?? []).map(k => k.key))
        const { next, dropped } = reconcileCalledOut(marked, present, now)
        all[acc] = next
        if (dropped.length) cleared = true
      }
      if (cleared) { setMarks(localToMarks(all)); saveCalledOut(all); localSavedAt.current = now }
      else if (now - localSavedAt.current > LOCAL_SAVE_MS) { saveCalledOut(all); localSavedAt.current = now }
      return
    }

    if (modeRef.current !== 'shared') return
    // Shared: report what this screen sees. The database touches those ticks and
    // deletes the ones NO screen has seen for the grace window — so a screen that
    // is behind or still loading can never wipe a tick another screen can see.
    // Only a fresh screen may vouch for a breach (a frozen one would keep a
    // finished breach alive).
    for (const acc of Object.keys(marksRef.current)) {
      if (!freshIds.has(acc)) continue
      if (Object.keys(marksRef.current[acc]).length === 0) continue
      if (now - (lastSync.current[acc] ?? 0) < SYNC_MS) continue
      lastSync.current[acc] = now
      const present = keyBreaches(allBreaches[acc] ?? []).map(k => k.key)
      syncSharedMarks(acc, present)
        .then(removed => {
          if (removed.length === 0) return
          const cur = marksRef.current
          if (!cur[acc]) return
          const left = { ...cur[acc] }
          for (const k of removed) delete left[k]
          setMarks({ ...cur, [acc]: left })
        })
        .catch(err => console.warn('[called-out] sync failed:', err?.message ?? err))
    }
  }, [allBreaches, setMarks])

  return { marks, mode, toggle }
}
