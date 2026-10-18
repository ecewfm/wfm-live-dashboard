'use client'

// components/AuthGate.tsx
// Wraps the whole app: nobody sees the dashboard without signing in, and a
// user on the default password is sent straight to "choose a password".
//
// SCOPE — be clear about what this is: the dashboard's data tables are
// readable AND writable with the public anon key that ships in every browser
// bundle (verified against the live project, not assumed). This gate decides
// what the APP shows, which is access organisation, not a security boundary.
// The parts that ARE genuinely enforced are the /api/users and
// /api/auth/password routes, which verify the caller's token and role on the
// server before touching anything.
//
// The Next 16 docs call out that "return null in a layout if a user is not
// authorized" is not real protection because an app has many entry points.
// That is exactly why the user-management routes repeat the check themselves
// rather than trusting this component.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { UserProfile, DEFAULT_PASSWORD, validateNewPassword, can } from '@/lib/authEmail'
import { signIn, signOut, loadMyProfile, setMyPassword, onAuthChange } from '@/lib/authClient'
import AuthShell, { AssembleCard, stackClass, cardTitleClass, cardSubClass } from './AuthShell'

interface AuthCtx {
  profile: UserProfile
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

/** Current user. Only valid inside <AuthGate>, which is the whole app. */
export function useAuth(): AuthCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth must be used inside <AuthGate>')
  return c
}

/** Convenience for the common "may this user do X?" checks. */
export function useCan() {
  const { profile } = useAuth()
  return {
    role: profile.role,
    openSettings:   can.openSettings(profile.role),
    manageUsers:    can.manageUsers(profile.role),
    manageAccounts: can.manageAccounts(profile.role),
    importUsers:    can.importUsers(profile.role),
  }
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setProfile(await loadMyProfile())
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await loadMyProfile()
      if (alive) { setProfile(p); setLoading(false) }
    })()
    // Covers a token refresh failing, or signing out in another tab.
    const off = onAuthChange(() => { loadMyProfile().then(p => { if (alive) setProfile(p) }) })
    return () => { alive = false; off() }
  }, [])

  // The login screen lives outside <Dashboard>, which is what normally applies
  // the saved theme — so apply it here too, or a dark-mode user gets a light
  // sign-in page and then a flash to dark once they're in.
  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('wfm_theme') === 'dark') } catch {}
  }, [])

  // Just the page background while the session check runs (usually a few
  // hundred ms). Deliberately empty: showing the hero here would flash a login
  // screen at people who are already signed in.
  if (loading) return <div className="auth-screen" />

  if (!profile) return <LoginScreen onSignedIn={refresh} />
  if (profile.mustResetPassword) return <SetPasswordScreen profile={profile} onDone={refresh} />

  return (
    <Ctx.Provider value={{ profile, refresh, signOut: async () => { await signOut(); setProfile(null) } }}>
      {children}
    </Ctx.Provider>
  )
}

// ── Sign in ─────────────────────────────────────────────────────────────────
function LoginScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bootstrap, setBootstrap] = useState<{ needed: boolean; username: string } | null>(null)
  const [bootMsg, setBootMsg] = useState<string | null>(null)

  // A brand-new install has no users at all. Rather than leaving someone at a
  // login box they can never satisfy, offer to create the first super user.
  useEffect(() => {
    fetch('/api/auth/bootstrap')
      .then(r => r.json())
      .then(j => { if (j?.needsBootstrap) setBootstrap({ needed: true, username: j.username }) })
      .catch(() => {})
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      const res = await signIn(username, password)
      if (!res.ok) setError(res.error || 'Could not sign in.')
      else await onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
    } finally { setBusy(false) }
  }

  const doBootstrap = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/auth/bootstrap', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Bootstrap failed.')
      setBootstrap(null)
      setUsername(j.username)
      setBootMsg(`Created "${j.username}". Sign in with the password ${j.tempPassword} and you'll be asked to choose a new one.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bootstrap failed.')
    } finally { setBusy(false) }
  }

  return (
    <AuthShell>
     <AssembleCard>
      <form className={stackClass} onSubmit={submit}>
        <h2 className={cardTitleClass}>Sign in</h2>
        <p className={cardSubClass}>Use the username your administrator gave you.</p>

        {bootMsg && <div className="auth-note auth-note-ok">{bootMsg}</div>}

        <label className="auth-label" htmlFor="auth-username">Username</label>
        <input
          id="auth-username" className="auth-input" value={username} autoFocus
          autoComplete="username" spellCheck={false}
          onChange={e => setUsername(e.target.value)}
          placeholder="e.g. super@wfmlive"
        />

        <label className="auth-label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password" className="auth-input" type="password" value={password}
          autoComplete="current-password"
          onChange={e => setPassword(e.target.value)}
        />

        {error && <div className="auth-note auth-note-err">{error}</div>}

        <button className="auth-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {bootstrap?.needed && (
          <div className="auth-note">
            <strong>No users exist yet.</strong>
            <p>Create the first super user (<code>{bootstrap.username}</code>) to get started. This option disappears once it exists.</p>
            <button type="button" className="auth-btn auth-btn-ghost" onClick={doBootstrap} disabled={busy}>
              Create {bootstrap.username}
            </button>
          </div>
        )}
      </form>
     </AssembleCard>
    </AuthShell>
  )
}

// ── Forced first-login password change ──────────────────────────────────────
function SetPasswordScreen({ profile, onDone }: { profile: UserProfile; onDone: () => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Same validator the server uses, so the two can't disagree.
    const bad = validateNewPassword(pw, confirm)
    if (bad) { setError(bad); return }
    setBusy(true); setError(null)
    try {
      await setMyPassword(pw, confirm)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your password.')
    } finally { setBusy(false) }
  }

  // intro={false}: the hero stays put when arriving here from the sign-in
  // card. Only the card itself re-assembles, into this new form.
  return (
    <AuthShell intro={false}>
     <AssembleCard>
      <form className={stackClass} onSubmit={submit}>
        <h2 className={cardTitleClass}>Choose a password</h2>
        <p className={cardSubClass}>
          Signed in as <strong>{profile.username}</strong>. You're on the default
          password (<code>{DEFAULT_PASSWORD}</code>) and need to set your own before continuing.
        </p>

        <label className="auth-label" htmlFor="pw-new">New password</label>
        <input id="pw-new" className="auth-input" type="password" value={pw} autoFocus
               autoComplete="new-password" onChange={e => setPw(e.target.value)} />

        <label className="auth-label" htmlFor="pw-confirm">Confirm password</label>
        <input id="pw-confirm" className="auth-input" type="password" value={confirm}
               autoComplete="new-password" onChange={e => setConfirm(e.target.value)} />

        {error && <div className="auth-note auth-note-err">{error}</div>}

        <button className="auth-btn" type="submit" disabled={busy || !pw || !confirm}>
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>
        <button type="button" className="auth-btn auth-btn-ghost" onClick={() => signOut().then(onDone)}>
          Sign out
        </button>
      </form>
     </AssembleCard>
    </AuthShell>
  )
}
