import AuthGate from '@/components/AuthGate'
import Dashboard from '@/components/Dashboard'

// AuthGate renders the login screen (or the forced password change) instead
// of the dashboard until there is a valid session. It is a client component,
// so the session check happens in the browser where the Supabase session
// lives — see the scope note in components/AuthGate.tsx for what that does
// and does not protect.
export default function Page() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
