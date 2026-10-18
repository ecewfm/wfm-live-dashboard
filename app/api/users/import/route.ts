// app/api/users/import/route.ts
// Roster import from .csv / .xlsx / .xls.
//
// TWO PHASES, always. `mode=preview` validates and reports; `mode=commit`
// writes. The operator sees exactly what will happen before anything does.
//
// FORGIVING BY DESIGN: only a file that can't be read at all (no username or
// role column) stops an import. A bad row is skipped, an account name that
// isn't in WFM Live yet is ignored, and both are reported — the rest goes in.
//
// RE-RUNNABLE AND ADDITIVE: importing the same file again creates anyone new
// and ADDS any of a person's listed accounts they don't have yet — which is
// how an account that didn't exist on the first import gets picked up once
// it's been created. It never removes an account and never changes an
// existing person's role or name; those stay as an admin last set them.
//
// Both formats are normalised to a string[][] grid and handed to the SAME
// parser (lib/rosterImport.ts), so CSV and Excel can never diverge.

import { requireRole, errorResponse, json, AuthError, admin, validateAccountIds } from '@/lib/authServer'
import { provisionUser } from '@/lib/userAdmin'
import { parseCsv, parseRoster, type AccountRef, type RosterUser, type RosterIssue } from '@/lib/rosterImport'
import { can, type UserRole } from '@/lib/authEmail'

/** Guard against someone uploading a 500MB file to a serverless function. */
const MAX_BYTES = 5 * 1024 * 1024

async function gridFromExcel(buf: ArrayBuffer): Promise<string[][]> {
  // Loaded lazily: exceljs is large and only this one route needs it.
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  if (!ws) throw new AuthError(400, 'That workbook has no sheets.')

  const grid: string[][] = []
  const width = ws.columnCount
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const cells: string[] = []
    for (let c = 1; c <= width; c++) {
      // .text renders dates/formulas/rich text to their displayed string,
      // which is what a human reading the sheet would have seen.
      cells.push(String(row.getCell(c).text ?? '').trim())
    }
    grid.push(cells)
  }
  return grid
}

interface ExistingUser { id: string; username: string; role: UserRole; accountIds: string[] }

/** Every current user keyed by LOWERCASE username, with their accounts. */
async function loadExisting(): Promise<Map<string, ExistingUser>> {
  const db = admin()
  const { data: profiles, error } = await db.from('wfm_profiles').select('id, username, role')
  if (error) throw new Error(`user list failed: ${error.message}`)
  const { data: links, error: lErr } = await db.from('wfm_user_accounts').select('user_id, account_id')
  if (lErr) throw new Error(`assignment list failed: ${lErr.message}`)

  const accountsOf = new Map<string, string[]>()
  for (const l of links ?? []) accountsOf.set(l.user_id, [...(accountsOf.get(l.user_id) ?? []), l.account_id])

  // Keyed case-insensitively. A plain `.in('username', [...])` query is
  // case-SENSITIVE, so "Super@WFMLive" in a file would miss "super@wfmlive"
  // in the database, be treated as new, and then fail on the unique index.
  const out = new Map<string, ExistingUser>()
  for (const p of profiles ?? []) {
    out.set(p.username.toLowerCase(), { id: p.id, username: p.username, role: p.role as UserRole, accountIds: accountsOf.get(p.id) ?? [] })
  }
  return out
}

interface Plan {
  willCreate: RosterUser[]
  willAddAccounts: { id: string; username: string; add: string[]; ignoredAccounts: string[] }[]
  upToDate: string[]
  extraIssues: RosterIssue[]
}

/** Decide, per person in the file, whether to create, top up, or leave alone. */
function plan(users: RosterUser[], existing: Map<string, ExistingUser>): Plan {
  const p: Plan = { willCreate: [], willAddAccounts: [], upToDate: [], extraIssues: [] }
  for (const u of users) {
    const have = existing.get(u.username.toLowerCase())
    if (!have) { p.willCreate.push(u); continue }

    if (have.role !== u.role) {
      p.extraIssues.push({
        row: u.sourceRows[0], severity: 'warning',
        message: `"${have.username}" already exists as ${have.role}; the file says ${u.role}. Their role is left as it is — change it in the Users list if needed.`,
      })
    }
    // A superuser already sees everything; nothing to add.
    const add = have.role === 'superuser' ? [] : u.accountIds.filter(a => !have.accountIds.includes(a))
    if (add.length) p.willAddAccounts.push({ id: have.id, username: have.username, add, ignoredAccounts: u.ignoredAccounts })
    else p.upToDate.push(have.username)
  }
  return p
}

export async function POST(req: Request) {
  try {
    const me = await requireRole(req, ['superuser', 'rta'])
    if (!can.importUsers(me.role)) throw new AuthError(403, 'Only super users can import a roster.')

    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new AuthError(400, 'No file was uploaded.')
    if (file.size === 0) throw new AuthError(400, 'That file is empty.')
    if (file.size > MAX_BYTES) throw new AuthError(400, `That file is ${(file.size / 1048576).toFixed(1)}MB; the limit is 5MB.`)

    const mode = String(form?.get('mode') ?? 'preview')
    const name = file.name.toLowerCase()
    const buf = await file.arrayBuffer()

    let grid: string[][]
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      grid = parseCsv(new TextDecoder('utf-8').decode(buf))
    } else if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.xls')) {
      grid = await gridFromExcel(buf)
    } else {
      throw new AuthError(400, `Unsupported file type "${file.name}". Use .csv, .xlsx or .xls.`)
    }

    const { data: accRows, error: accErr } = await admin().from('wfm_accounts').select('id, display_name')
    if (accErr) throw new Error(`account list failed: ${accErr.message}`)
    const accounts: AccountRef[] = (accRows ?? []).map(a => ({ id: a.id, display_name: a.display_name || a.id }))

    const parsed = parseRoster(grid, accounts)
    const existing = await loadExisting()
    const { willCreate, willAddAccounts, upToDate, extraIssues } = plan(parsed.users, existing)
    const issues = [...parsed.issues, ...extraIssues]

    // Only a file-level problem (no username/role column) blocks the import.
    const fileErrors = issues.filter(i => i.severity === 'error')
    const somethingToDo = willCreate.length > 0 || willAddAccounts.length > 0

    if (mode !== 'commit') {
      return json({
        mode: 'preview',
        willCreate,
        willAddAccounts,
        upToDate,
        issues,
        ignoredColumns: parsed.ignoredColumns,
        canCommit: fileErrors.length === 0 && somethingToDo,
      })
    }

    // ── commit ──────────────────────────────────────────────────────────────
    if (fileErrors.length) {
      throw new AuthError(400, `This file can't be imported: ${fileErrors.map(e => e.message).join(' ')}`)
    }

    const created: string[] = []
    const topped: { username: string; added: string[] }[] = []
    const failed: { username: string; error: string }[] = []

    for (const u of willCreate) {
      try {
        // Re-checked server-side even though only superusers reach here, so
        // the rule stays in one place if RTAs are ever given import rights.
        await validateAccountIds(me, u.accountIds)
        await provisionUser({
          username: u.username,
          fullName: u.fullName,
          role: u.role,
          accountIds: u.accountIds,
          isActive: u.isActive,
          allowNoAccounts: true,       // their accounts may not exist yet
        })
        created.push(u.username)
      } catch (e) {
        // Keep going: one bad person shouldn't abandon the other 200.
        failed.push({ username: u.username, error: e instanceof Error ? e.message : String(e) })
      }
    }

    for (const t of willAddAccounts) {
      try {
        await validateAccountIds(me, t.add)
        // ignoreDuplicates: if an admin assigned one of these between the
        // preview and the commit, that's fine — the end state is the same.
        const { error } = await admin().from('wfm_user_accounts').upsert(
          t.add.map(account_id => ({ user_id: t.id, account_id })),
          { onConflict: 'user_id,account_id', ignoreDuplicates: true },
        )
        if (error) throw new Error(error.message)
        topped.push({ username: t.username, added: t.add })
      } catch (e) {
        failed.push({ username: t.username, error: e instanceof Error ? e.message : String(e) })
      }
    }

    return json({ mode: 'commit', created, accountsAdded: topped, upToDate, failed, issues })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
