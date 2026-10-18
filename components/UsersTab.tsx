'use client'

// components/UsersTab.tsx
// The Settings → Users tab. Shown to super users and RTAs.
//
// What each role can do here is decided by the SERVER (app/api/users), not by
// this file. The gating below only avoids showing buttons that would fail:
//  - super user: every user, every role, plus roster import
//  - RTA:        team leads on their own accounts only
// Keeping the UI's rules in lib/authEmail's `can` means the two read from one
// source, but the route re-derives them from the caller's token regardless.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/authClient'
import { useAuth } from './AuthGate'
import { UserProfile, UserRole, ROLE_LABELS, can, isValidUsername } from '@/lib/authEmail'

interface AccountOpt { id: string; display_name: string }

interface Props {
  accounts: AccountOpt[]
}

type Draft = {
  id?: string
  username: string
  fullName: string
  role: UserRole
  accountIds: string[]
  /** Accounts as loaded, for edits — so we only send accountIds when they changed. */
  originalAccountIds?: string[]
}

const blankDraft = (role: UserRole): Draft => ({ username: '', fullName: '', role, accountIds: [] })

const sameSet = (a: string[], b?: string[]) =>
  !!b && a.length === b.length && a.every(x => b.includes(x))

export default function UsersTab({ accounts }: Props) {
  // Context reaches here even though SettingsModal renders through a portal —
  // a portal keeps the React tree, only the DOM parent differs.
  const { profile: me } = useAuth()

  const [users, setUsers]   = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft]   = useState<Draft | null>(null)
  const [busy, setBusy]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<UserProfile | null>(null)

  const assignable = can.assignableRoles(me.role)
  // An RTA can only ever hand out their own accounts, so don't offer more.
  const assignableAccounts = useMemo(
    () => me.role === 'superuser' ? accounts : accounts.filter(a => me.accountIds.includes(a.id)),
    [accounts, me],
  )

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch('/api/users')
      setUsers(r.users ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await fn(); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.') }
    finally { setBusy(false) }
  }

  const save = (d: Draft) => run(async () => {
    if (!d.id) {
      const bad = isValidUsername(d.username)
      if (bad) throw new Error(bad)
      const r = await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: d.username, fullName: d.fullName, role: d.role, accountIds: d.accountIds }),
      })
      setNotice(`Created "${r.username}". Temporary password: ${r.tempPassword} — they must change it at first sign-in.`)
    } else {
      await apiFetch('/api/users', {
        method: 'PATCH',
        body: JSON.stringify({
          id: d.id, fullName: d.fullName, role: d.role,
          // Omitted when untouched: someone imported before their accounts existed
          // has none, and a rename must not be forced to assign one.
          ...(sameSet(d.accountIds, d.originalAccountIds) ? {} : { accountIds: d.accountIds }),
        }),
      })
      setNotice(`Saved "${d.username}".`)
    }
    setDraft(null)
  })

  const resetPw = (u: UserProfile) => run(async () => {
    const r = await apiFetch('/api/users', { method: 'PATCH', body: JSON.stringify({ id: u.id, action: 'reset-password' }) })
    setNotice(`"${u.username}" was reset to ${r.tempPassword}. They'll be asked to choose a new one at next sign-in.`)
  })

  const toggleActive = (u: UserProfile) => run(async () => {
    await apiFetch('/api/users', { method: 'PATCH', body: JSON.stringify({ id: u.id, action: 'set-active', isActive: !u.isActive }) })
    setNotice(`"${u.username}" is now ${u.isActive ? 'deactivated' : 'active'}.`)
  })

  const doDelete = (u: UserProfile) => run(async () => {
    await apiFetch(`/api/users?id=${encodeURIComponent(u.id)}`, { method: 'DELETE' })
    setNotice(`Deleted "${u.username}".`)
    setConfirmDelete(null)
  })

  const accountLabel = (id: string) => accounts.find(a => a.id === id)?.display_name || id

  // ── Column filters ────────────────────────────────────────────────────────
  // What each column "contains" for filtering. Accounts is multi-valued: a row
  // passes if ANY of its accounts is ticked (tick "Flex" → everyone on Flex).
  const cellValues = (u: UserProfile, key: ColKey): string[] => {
    switch (key) {
      case 'username': return [u.username]
      case 'name':     return [u.fullName || NO_NAME]
      case 'role':     return [ROLE_LABELS[u.role]]
      case 'accounts': return u.role === 'superuser' ? [ALL_ACCOUNTS]
                         : u.accountIds.length ? u.accountIds.map(accountLabel) : [NO_ACCOUNTS]
      case 'status':   return [statusLabel(u)]
    }
  }
  // Across columns it's AND; within a column, OR over the ticked values.
  // `except` skips one column — used to count options the way Excel does
  // (each column's counts reflect every OTHER column's filter).
  const passes = (u: UserProfile, except?: ColKey) =>
    COLUMNS.every(({ key }) => {
      const sel = filters[key]
      return key === except || !sel || cellValues(u, key).some(v => sel.has(v))
    })
  const visibleUsers = users.filter(u => passes(u))
  const anyFilter = COLUMNS.some(({ key }) => filters[key] !== null)

  const optionsFor = (key: ColKey): FilterOption[] => {
    const counts = new Map<string, number>()
    for (const u of users) for (const v of cellValues(u, key)) counts.set(v, 0)
    for (const u of users) {
      if (!passes(u, key)) continue
      for (const v of new Set(cellValues(u, key))) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => orderFor(key, a.value, b.value))
  }

  // Mirrors the server's canAdminister(). Shown as disabled controls rather
  // than hidden rows, so an RTA can still SEE who else is on their accounts.
  const editable = (u: UserProfile): boolean => {
    if (me.role === 'superuser') return true
    if (me.role !== 'rta') return false
    if (u.role !== 'team_lead') return false
    return u.accountIds.every(a => me.accountIds.includes(a))
  }

  return (
    <div>
      <div className="sm-section-title">USERS</div>
      <p className="sm-desc">
        {me.role === 'superuser'
          ? 'Everyone with a login. Super users see every account; RTAs and team leads see only the accounts assigned here.'
          : 'Team leads you have added to your accounts. They can view the dashboard for those accounts but cannot change any settings.'}
      </p>

      {error  && <div className="auth-note auth-note-err" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="auth-note auth-note-ok"  style={{ marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="sm-btn-save" disabled={busy || !assignable.length}
                onClick={() => setDraft(blankDraft(assignable[assignable.length - 1]))}>
          <i className="bx bx-plus" /> Add user
        </button>
        {can.importUsers(me.role) && <RosterImport onDone={load} accountLabel={accountLabel} />}
      </div>

      {!loading && users.length > 0 && (
        <div className="sm-desc" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px' }}>
          <span>
            {anyFilter
              ? <>Showing <strong>{visibleUsers.length}</strong> of {users.length} users</>
              : <>{users.length} user{users.length === 1 ? '' : 's'}</>}
          </span>
          {anyFilter && (
            <button className="sm-btn-cancel" style={{ padding: '3px 10px', fontSize: 12 }}
                    onClick={() => setFilters(EMPTY_FILTERS)}>
              <i className="bx bx-x" /> Clear all filters
            </button>
          )}
        </div>
      )}

      {loading ? <p className="sm-desc">Loading…</p> : (
       // Scrolls sideways on narrow screens instead of cutting off the actions.
       <div style={{ overflowX: 'auto' }}>
        <table className="sm-table">
          <thead>
            <tr>
              {COLUMNS.map(({ key, label }) => (
                <th key={key} style={{ whiteSpace: 'nowrap' }}>
                  {label}
                  {users.length > 0 && (
                    <ColumnFilter
                      label={label}
                      options={optionsFor(key)}
                      selected={filters[key]}
                      onApply={next => setFilters(f => ({ ...f, [key]: next }))}
                    />
                  )}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={6} className="sm-desc">No users yet.</td></tr>
            )}
            {users.length > 0 && visibleUsers.length === 0 && (
              <tr><td colSpan={6} className="sm-desc">
                No users match these filters.{' '}
                <button className="sm-btn-cancel" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear all filters
                </button>
              </td></tr>
            )}
            {visibleUsers.map(u => {
              const mayEdit = editable(u) && u.id !== me.id
              return (
                <tr key={u.id}>
                  <td>{u.username}{u.id === me.id && <span className="sm-metric-sub"> (you)</span>}</td>
                  <td>{u.fullName}</td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td>
                    {u.role === 'superuser'
                      ? <span className="sm-metric-sub">all accounts</span>
                      : u.accountIds.map(accountLabel).join(', ') || <span className="sm-metric-sub">none</span>}
                  </td>
                  <td>
                    {u.isActive ? 'Active' : 'Inactive'}
                    {u.mustResetPassword && <span className="sm-metric-sub"> · must set password</span>}
                  </td>
                  {/* Icon buttons (labels on hover) — the text versions were
                      wide enough to push this column off the edge of the modal. */}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="acc-btn acc-btn-cfg" disabled={!mayEdit || busy}
                            title={mayEdit ? 'Edit' : 'You cannot manage this user'} aria-label="Edit"
                            onClick={() => setDraft({ id: u.id, username: u.username, fullName: u.fullName ?? '', role: u.role, accountIds: [...u.accountIds], originalAccountIds: [...u.accountIds] })}>
                      <i className="bx bx-edit" />
                    </button>
                    <button className="acc-btn acc-btn-cfg" disabled={!editable(u) || busy}
                            title="Reset to the default password" aria-label="Reset password"
                            onClick={() => resetPw(u)}>
                      <i className="bx bx-key" />
                    </button>
                    <button className="acc-btn acc-btn-cfg" disabled={!mayEdit || busy}
                            title={u.isActive ? 'Deactivate' : 'Reactivate'} aria-label={u.isActive ? 'Deactivate' : 'Reactivate'}
                            onClick={() => toggleActive(u)}>
                      <i className={`bx ${u.isActive ? 'bx-user-x' : 'bx-user-check'}`} />
                    </button>
                    <button className="acc-btn acc-btn-cfg" disabled={!mayEdit || busy}
                            title="Delete" aria-label="Delete"
                            onClick={() => setConfirmDelete(u)}>
                      <i className="bx bx-trash" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {draft && (
        <UserForm
          draft={draft} setDraft={setDraft}
          assignableRoles={assignable}
          accounts={assignableAccounts}
          busy={busy}
          onSave={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}

      {confirmDelete && (
        <div className="auth-note" style={{ marginTop: 14 }}>
          <strong>Delete "{confirmDelete.username}"?</strong>
          <p>Their login is removed permanently. This cannot be undone.</p>
          <button className="sm-btn-save" disabled={busy} onClick={() => doDelete(confirmDelete)}>Delete</button>
          <button className="sm-btn-cancel" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Add / edit form ─────────────────────────────────────────────────────────
function UserForm({ draft, setDraft, assignableRoles, accounts, busy, onSave, onCancel }: {
  draft: Draft
  setDraft: (d: Draft) => void
  assignableRoles: UserRole[]
  accounts: AccountOpt[]
  busy: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const needsAccounts = draft.role !== 'superuser'
  const toggle = (id: string) => setDraft({
    ...draft,
    accountIds: draft.accountIds.includes(id)
      ? draft.accountIds.filter(a => a !== id)
      : [...draft.accountIds, id],
  })

  return (
    <div className="auth-note" style={{ marginTop: 16 }}>
      <div className="sm-section-title">{draft.id ? `EDIT ${draft.username.toUpperCase()}` : 'NEW USER'}</div>

      {!draft.id && (
        <>
          <div className="ds-mini-label">Username (what they type to sign in)</div>
          <input className="sm-input" value={draft.username} autoFocus spellCheck={false}
                 placeholder="e.g. jdoe@corp.com or vn20012"
                 onChange={e => setDraft({ ...draft, username: e.target.value })} />
        </>
      )}

      <div className="ds-mini-label">Full name</div>
      <input className="sm-input" value={draft.fullName}
             onChange={e => setDraft({ ...draft, fullName: e.target.value })} />

      <div className="ds-mini-label">Role</div>
      <select className="ds-select" value={draft.role} disabled={assignableRoles.length <= 1}
              onChange={e => setDraft({ ...draft, role: e.target.value as UserRole })}>
        {assignableRoles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>

      {needsAccounts ? (
        <>
          <div className="ds-mini-label">Accounts they can see</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '6px 0 10px' }}>
            {accounts.length === 0 && <span className="sm-desc">You have no accounts to assign.</span>}
            {accounts.map(a => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
                <input type="checkbox" checked={draft.accountIds.includes(a.id)} onChange={() => toggle(a.id)} />
                {a.display_name}
              </label>
            ))}
          </div>
        </>
      ) : (
        <p className="sm-desc">Super users see every account automatically — there is nothing to assign.</p>
      )}

      {!draft.id && (
        <p className="sm-desc">
          They'll start on the default password and be made to choose their own at first sign-in.
        </p>
      )}

      <button className="sm-btn-save" disabled={busy || (needsAccounts && draft.accountIds.length === 0 && (!draft.id || !sameSet(draft.accountIds, draft.originalAccountIds)))} onClick={onSave}>
        {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Create user'}
      </button>
      <button className="sm-btn-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  )
}

// ── Roster import ───────────────────────────────────────────────────────────
// Always previews first. Committing a roster that turns out to have a bad row
// halfway down is far worse than being told before anything is written.
function RosterImport({ onDone, accountLabel }: { onDone: () => Promise<void>; accountLabel: (id: string) => string }) {
  const [file, setFile]       = useState<File | null>(null)
  const [preview, setPreview] = useState<any>(null)
  const [result, setResult]   = useState<any>(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const send = async (mode: 'preview' | 'commit') => {
    if (!file) return
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('mode', mode)
      const r = await apiFetch('/api/users/import', { method: 'POST', body: fd })
      if (mode === 'preview') { setPreview(r); setResult(null) }
      else { setResult(r); setPreview(null); await onDone() }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
    } finally { setBusy(false) }
  }

  const reset = () => { setFile(null); setPreview(null); setResult(null); setError(null) }

  return (
    <>
      <label className="sm-btn-save" style={{ cursor: 'pointer' }}>
        <i className="bx bx-upload" /> Import roster
        <input
          type="file" hidden
          accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={e => { const f = e.target.files?.[0]; if (f) { reset(); setFile(f) } ; e.target.value = '' }}
        />
      </label>

      {file && (
        <div className="auth-note" style={{ flexBasis: '100%', marginTop: 10 }}>
          <strong>{file.name}</strong> ({(file.size / 1024).toFixed(0)} KB)
          {error && <div className="auth-note-err" style={{ marginTop: 8, padding: 8 }}>{error}</div>}

          {!preview && !result && (
            <div style={{ marginTop: 8 }}>
              <button className="sm-btn-save" disabled={busy} onClick={() => send('preview')}>
                {busy ? 'Checking…' : 'Check file'}
              </button>
              <button className="sm-btn-cancel" disabled={busy} onClick={reset}>Cancel</button>
            </div>
          )}

          {preview && (() => {
            const nCreate = preview.willCreate.length
            const nSkip   = preview.willSkip?.length ?? 0
            const nTopUp  = preview.willAddAccounts.length
            return (
              <div style={{ marginTop: 8 }}>
                <p>
                  <strong>{nCreate}</strong> will be added
                  {nSkip > 0 && <> · <strong>{nSkip}</strong> won&apos;t be added (no WFM Live account)</>}
                  {nTopUp > 0 && <> · <strong>{nTopUp}</strong> existing user(s) get new accounts</>}
                  {preview.upToDate.length > 0 && <> · <strong>{preview.upToDate.length}</strong> already up to date</>}
                </p>

                {nCreate > 0 && (
                  <>
                    <div className="ds-mini-label" style={{ marginTop: 10 }}>Will be added</div>
                    <table className="sm-table">
                      <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Accounts</th><th>Not in WFM Live yet (ignored)</th></tr></thead>
                      <tbody>
                        {preview.willCreate.map((u: any) => (
                          <tr key={u.username}>
                            <td>{u.username}</td><td>{u.fullName}</td>
                            <td>{ROLE_LABELS[u.role as UserRole]}</td>
                            <td>
                              {u.role === 'superuser'
                                ? <span className="sm-metric-sub">all accounts</span>
                                : u.accountIds.map(accountLabel).join(', ')}
                            </td>
                            <td className="sm-metric-sub">{u.ignoredAccounts.join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {/* Shown so it's clear who was left out and why — but these
                    people are NOT created when you confirm. */}
                {nSkip > 0 && (
                  <>
                    <div className="ds-mini-label" style={{ marginTop: 10, color: 'var(--danger)' }}>
                      Won&apos;t be added — none of their accounts exist in WFM Live
                    </div>
                    <table className="sm-table" style={{ opacity: 0.75 }}>
                      <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Accounts in the file</th></tr></thead>
                      <tbody>
                        {preview.willSkip.map((u: any) => (
                          <tr key={u.username}>
                            <td>{u.username}</td><td>{u.fullName}</td>
                            <td>{ROLE_LABELS[u.role as UserRole]}</td>
                            <td className="sm-metric-sub">{u.ignoredAccounts.join(', ') || '(none listed)'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="sm-desc">
                      Once their account is created in WFM Live, import this file again and they&apos;ll be added.
                    </p>
                  </>
                )}

                {nTopUp > 0 && (
                  <>
                    <div className="ds-mini-label" style={{ marginTop: 10 }}>Existing users — accounts that will be added</div>
                    <table className="sm-table">
                      <thead><tr><th>Username</th><th>Adding</th><th>Still not in WFM Live (ignored)</th></tr></thead>
                      <tbody>
                        {preview.willAddAccounts.map((t: any) => (
                          <tr key={t.username}>
                            <td>{t.username}</td>
                            <td>{t.add.map(accountLabel).join(', ')}</td>
                            <td className="sm-metric-sub">{t.ignoredAccounts.join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {preview.upToDate.length > 0 && (
                  <p className="sm-desc">Already up to date (nothing to change): {preview.upToDate.join(', ')}</p>
                )}
                <IssueList issues={preview.issues} />
                {preview.ignoredColumns?.length > 0 && (
                  <p className="sm-desc">Columns not used: {preview.ignoredColumns.join(', ')}</p>
                )}

                <button className="sm-btn-save" disabled={busy || !preview.canCommit} onClick={() => send('commit')}>
                  {busy ? 'Importing…' : nCreate > 0 ? `Add ${nCreate} user(s)` : 'Import'}
                </button>
                <button className="sm-btn-cancel" disabled={busy} onClick={reset}>Cancel</button>
                {!preview.canCommit && (
                  <p className="sm-desc">
                    {preview.issues.some((i: any) => i.severity === 'error')
                      ? "This file can't be read — see above. Nothing has been written."
                      : nSkip > 0
                        ? 'Nothing to add — everyone new in this file is missing a WFM Live account.'
                        : 'Nothing to do — everyone in this file is already set up.'}
                  </p>
                )}
              </div>
            )
          })()}

          {result && (
            <div style={{ marginTop: 8 }}>
              <p>
                <strong>{result.created.length}</strong> added
                {result.accountsAdded?.length > 0 && <> · <strong>{result.accountsAdded.length}</strong> given new accounts</>}
                {result.skipped?.length > 0 && <> · <strong>{result.skipped.length}</strong> not added (no WFM Live account)</>}
                {result.failed?.length > 0 && <> · <strong>{result.failed.length}</strong> failed</>}
              </p>
              {result.skipped?.length > 0 && (
                <p className="sm-desc">
                  Not added: {result.skipped.map((s: any) => `${s.username}${s.accounts.length ? ` (${s.accounts.join(', ')})` : ''}`).join(', ')}
                </p>
              )}
              {result.created.length > 0 && (
                <p className="sm-desc">
                  New users start on the default password and choose their own at first sign-in: {result.created.join(', ')}
                </p>
              )}
              {result.accountsAdded?.length > 0 && (
                <ul className="sm-desc">
                  {result.accountsAdded.map((t: any) => <li key={t.username}>{t.username}: + {t.added.map(accountLabel).join(', ')}</li>)}
                </ul>
              )}
              {result.failed?.length > 0 && (
                <div className="auth-note-err" style={{ padding: 8 }}>
                  <ul>{result.failed.map((f: any) => <li key={f.username}>{f.username}: {f.error}</li>)}</ul>
                </div>
              )}
              <IssueList issues={result.issues} />
              <button className="sm-btn-cancel" onClick={reset}>Done</button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function IssueList({ issues }: { issues?: { row: number | null; severity: string; message: string }[] }) {
  if (!issues?.length) return null
  const errs = issues.filter(i => i.severity === 'error')
  const warns = issues.filter(i => i.severity === 'warning')
  return (
    <>
      {/* Errors are file-level only now (no username / role column).
          Everything row-level is a note: that row or account was skipped,
          the rest still imports. */}
      {errs.length > 0 && (
        <div className="auth-note-err" style={{ padding: 8, marginBottom: 8 }}>
          <strong>This file can't be imported:</strong>
          <ul>{errs.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
        </div>
      )}
      {warns.length > 0 && (
        // Open by default when short — these are the notes that say which
        // rows and accounts were skipped, so they shouldn't hide.
        <details className="sm-desc" open={warns.length <= 10}>
          <summary>{warns.length} note(s) — skipped rows and ignored accounts</summary>
          <ul>{warns.map((i, n) => <li key={n}>{i.row ? `Row ${i.row}: ` : ''}{i.message}</li>)}</ul>
        </details>
      )}
    </>
  )
}
