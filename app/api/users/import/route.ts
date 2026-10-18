// app/api/users/import/route.ts
// Roster import from .csv / .xlsx / .xls.
//
// TWO PHASES, always. `mode=preview` validates and reports; `mode=commit`
// creates. A roster that is half-applied because row 40 had a typo is worse
// than one that was never applied, so the operator sees exactly what will
// happen before anything is written.
//
// Both formats are normalised to a string[][] grid and handed to the SAME
// parser (lib/rosterImport.ts), so CSV and Excel can never diverge in how a
// role or an account name is interpreted.

import { requireRole, errorResponse, json, AuthError, admin, validateAccountIds } from '@/lib/authServer'
import { provisionUser } from '@/lib/userAdmin'
import { parseCsv, parseRoster, type AccountRef, type RosterUser } from '@/lib/rosterImport'
import { can } from '@/lib/authEmail'

/** Guard against someone uploading a 500MB file to a serverless function. */
const MAX_BYTES = 5 * 1024 * 1024

async function gridFromExcel(buf: ArrayBuffer): Promise<string[][]> {
  // Required lazily: exceljs is large and only this one route needs it.
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

    // Real accounts, so names in the file resolve to ids.
    const { data: accRows, error: accErr } = await admin()
      .from('wfm_accounts').select('id, display_name')
    if (accErr) throw new Error(`account list failed: ${accErr.message}`)
    const accounts: AccountRef[] = (accRows ?? []).map(a => ({ id: a.id, display_name: a.display_name || a.id }))

    const parsed = parseRoster(grid, accounts)

    // Which of these already exist? Re-running an import is normal, so this
    // must be reported rather than erroring.
    const usernames = parsed.users.map(u => u.username)
    const existing = new Set<string>()
    if (usernames.length) {
      const { data: have, error } = await admin()
        .from('wfm_profiles').select('username').in('username', usernames)
      if (error) throw new Error(`existing-user check failed: ${error.message}`)
      for (const r of have ?? []) existing.add(r.username.toLowerCase())
    }

    const toCreate = parsed.users.filter(u => !existing.has(u.username.toLowerCase()))
    const skipped  = parsed.users.filter(u =>  existing.has(u.username.toLowerCase()))
    const blocking = parsed.issues.filter(i => i.severity === 'error')

    if (mode !== 'commit') {
      return json({
        mode: 'preview',
        willCreate: toCreate,
        alreadyExist: skipped.map(u => u.username),
        issues: parsed.issues,
        ignoredColumns: parsed.ignoredColumns,
        canCommit: blocking.length === 0 && toCreate.length > 0,
      })
    }

    // ── commit ──────────────────────────────────────────────────────────────
    if (blocking.length) {
      throw new AuthError(400, `Fix ${blocking.length} error(s) in the file first; nothing was imported.`)
    }
    // Re-check assignment permission server-side: a superuser is the only
    // role allowed here today, but this keeps the rule in one place if RTAs
    // are ever given import rights.
    for (const u of toCreate) await validateAccountIds(me, u.accountIds)

    const created: string[] = []
    const failed: { username: string; error: string }[] = []
    for (const u of toCreate as RosterUser[]) {
      try {
        await provisionUser({
          username: u.username,
          fullName: u.fullName,
          role: u.role,
          accountIds: u.accountIds,
          isActive: u.isActive,
        })
        created.push(u.username)
      } catch (e) {
        // Keep going: one bad row shouldn't abandon the other 200.
        failed.push({ username: u.username, error: e instanceof Error ? e.message : String(e) })
      }
    }

    return json({
      mode: 'commit',
      created,
      failed,
      alreadyExist: skipped.map(u => u.username),
      issues: parsed.issues.filter(i => i.severity === 'warning'),
    })
  } catch (e) { return errorResponse(e) }
}

export const dynamic = 'force-dynamic'
