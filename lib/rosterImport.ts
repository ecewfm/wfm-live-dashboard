// lib/rosterImport.ts
// Parsing and validation for the "import users" roster file (.csv / .xlsx).
//
// Pure functions, no Supabase and no file I/O: the route handler turns an
// upload into a string[][] grid (itself for CSV, via exceljs for Excel) and
// hands it here. One mapper for both formats means the two can't drift.
//
// The import is deliberately two-phase — parse/validate to a PREVIEW, then
// commit only what the operator confirms. A roster that is half-applied
// because row 40 had a typo is worse than one that was never applied.

import { UserRole, normalizeUsername, isValidUsername } from './authEmail'

// ── CSV ─────────────────────────────────────────────────────────────────────
/**
 * RFC4180-ish CSV → grid. Handles quoted fields containing commas and
 * newlines, and "" as an escaped quote — the sample roster relies on the
 * first of those for cells like "Flex, Wyze".
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Strip a UTF-8 BOM — Excel's "Save as CSV" adds one, and it would
  // otherwise become part of the first header name.
  const s = text.replace(/^﻿/, '')

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }   // escaped quote
        else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"')  { inQuotes = true; continue }
    if (c === ',')  { row.push(field); field = ''; continue }
    if (c === '\r') { if (s[i + 1] === '\n') i++; rows.push([...row, field]); row = []; field = ''; continue }
    if (c === '\n') { rows.push([...row, field]); row = []; field = ''; continue }
    field += c
  }
  if (field !== '' || row.length) rows.push([...row, field])
  // Drop trailing all-empty rows (a file ending in a newline yields one).
  while (rows.length && rows[rows.length - 1].every(c => c.trim() === '')) rows.pop()
  return rows
}

// ── Header mapping ──────────────────────────────────────────────────────────
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')

// Ordered: the FIRST matching alias wins. "accounts" must be matched exactly
// and not by prefix, because the sample file also has an "Accounts handled"
// column holding a COUNT — grabbing that as the account list would give every
// user an account literally named "1".
const FIELD_ALIASES: Record<string, string[]> = {
  fullName: ['name', 'fullname', 'full name', 'employee', 'employeename', 'agentname'],
  username: ['username', 'user', 'login', 'userid', 'loginid', 'email', 'emailaddress'],
  role:     ['role', 'userrole', 'accesslevel', 'permission'],
  accounts: ['accounts', 'account', 'accountlist', 'assignedaccounts', 'accountsassigned'],
  status:   ['status', 'active', 'isactive', 'state'],
}

export interface HeaderMap { [field: string]: number }

export function mapHeaders(header: string[]): { map: HeaderMap; unknown: string[] } {
  const normalized = header.map(norm)
  const map: HeaderMap = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(norm(alias))
      if (idx !== -1 && !Object.values(map).includes(idx)) { map[field] = idx; break }
    }
  }
  const used = new Set(Object.values(map))
  const unknown = header.filter((h, i) => !used.has(i) && h.trim() !== '')
  return { map, unknown }
}

// ── Role parsing ────────────────────────────────────────────────────────────
const ROLE_ALIASES: Record<string, UserRole> = {
  superuser: 'superuser', super: 'superuser', admin: 'superuser',
  superadmin: 'superuser', administrator: 'superuser',
  rta: 'rta', realtimeanalyst: 'rta', realtime: 'rta', analyst: 'rta',
  teamlead: 'team_lead', tl: 'team_lead', lead: 'team_lead',
  teamleader: 'team_lead', supervisor: 'team_lead',
}

export function parseRole(raw: string): UserRole | null {
  return ROLE_ALIASES[norm(raw)] ?? null
}

// ── Account-name resolution ─────────────────────────────────────────────────
export interface AccountRef { id: string; display_name: string }

/**
 * Two-way match: a roster cell may name an account by its DATABASE ID
 * ("ashley-phones") or by its DISPLAY NAME ("Ashley Voice") — both are tried,
 * case-insensitively, then again with spaces and punctuation ignored, so
 * "Rocco Ridge", "rocco-ridge" and "ROCCORIDGE" all land on `roccoridge`.
 *
 * Never a fuzzy / closest-guess match, and never a guess between two
 * candidates: silently attaching someone to the wrong tenant is worse than
 * leaving the account off and saying so.
 */
export function resolveAccount(name: string, accounts: AccountRef[]): string | null {
  const n = name.trim()
  if (!n) return null
  const lower = n.toLowerCase()

  // 1. Exact database id.
  const byId = accounts.find(a => a.id.toLowerCase() === lower)
  if (byId) return byId.id

  // 2. Exact display name — only if exactly one account carries it.
  const byName = accounts.filter(a => (a.display_name || '').toLowerCase() === lower)
  if (byName.length === 1) return byName[0].id

  // 3. Either one, ignoring spaces/punctuation. "Rocco Ridge" -> "roccoridge".
  const squashed = norm(n)
  if (!squashed) return null
  const loose = [...new Set(
    accounts
      .filter(a => norm(a.id) === squashed || norm(a.display_name || '') === squashed)
      .map(a => a.id),
  )]
  return loose.length === 1 ? loose[0] : null
}

export function splitAccountCell(cell: string): string[] {
  return (cell || '')
    .split(/[,;|/]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// ── Row → user ──────────────────────────────────────────────────────────────
export interface RosterUser {
  username: string
  fullName: string
  role: UserRole
  accountIds: string[]
  /**
   * Account names from the file that matched nothing in WFM Live — usually
   * accounts that simply haven't been created yet. Ignored for now; importing
   * the same file again after they exist will assign them.
   */
  ignoredAccounts: string[]
  isActive: boolean
  /** 1-based spreadsheet rows this user was built from (>1 when merged). */
  sourceRows: number[]
}

/**
 * 'error' is reserved for problems with the FILE itself (no username or role
 * column) — the only thing that stops an import. Anything wrong with an
 * individual row is a 'warning': that row, or that one account name, is
 * skipped and everything else still goes in.
 */
export interface RosterIssue {
  row: number | null          // null = whole-file issue
  severity: 'error' | 'warning'
  message: string
}

export interface ParsedRoster {
  users: RosterUser[]
  issues: RosterIssue[]
  /** Columns present in the file that this importer ignores. */
  ignoredColumns: string[]
}

const isInactive = (s: string) => /^(inactive|disabled|no|false|0|terminated|resigned)$/i.test(s.trim())

const ROLE_WORD: Record<UserRole, string> = { superuser: 'a super user', rta: 'an RTA', team_lead: 'a team lead' }

/**
 * Validate a grid into the users that WOULD be created. Never throws: every
 * problem comes back as an issue so the preview can show all of them at once
 * rather than failing on the first bad cell.
 */
export function parseRoster(grid: string[][], accounts: AccountRef[]): ParsedRoster {
  const issues: RosterIssue[] = []
  if (!grid.length) {
    return { users: [], issues: [{ row: null, severity: 'error', message: 'The file is empty.' }], ignoredColumns: [] }
  }

  const [header, ...body] = grid
  const { map, unknown } = mapHeaders(header)

  for (const req of ['username', 'role'] as const) {
    if (map[req] === undefined) {
      issues.push({ row: null, severity: 'error', message: `No "${req}" column found. Columns seen: ${header.filter(h => h.trim()).join(', ') || '(none)'}` })
    }
  }
  if (issues.some(i => i.severity === 'error')) return { users: [], issues, ignoredColumns: unknown }

  const cell = (r: string[], f: string) => (map[f] === undefined ? '' : (r[map[f]] ?? '')).trim()

  // Keyed by lowercase username: the same person listed on several rows (the
  // sample roster does this — one username with two different account lists)
  // is ONE user here, holding the union of their accounts. The sibling-profile
  // app this roster format came from would have made two logins instead.
  const byUsername = new Map<string, RosterUser>()

  // Everything below is a 'warning'. A row that can't become a user is
  // skipped and reported; an account name that matches nothing is dropped and
  // reported. Neither stops the rest of the file from importing.
  const warn = (row: number, message: string) => issues.push({ row, severity: 'warning', message })

  body.forEach((raw, i) => {
    const rowNo = i + 2                        // 1-based, +1 for the header
    if (raw.every(c => (c ?? '').trim() === '')) return   // blank line

    const username = normalizeUsername(cell(raw, 'username'))
    if (!username) { warn(rowNo, 'Skipped: no username.'); return }
    const badName = isValidUsername(username)
    if (badName) { warn(rowNo, `Skipped "${username}": ${badName}`); return }

    const roleRaw = cell(raw, 'role')
    const role = parseRole(roleRaw)
    if (!role) {
      // Skipped rather than defaulted to a role: guessing would hand someone a
      // login, with real data access, that nobody actually decided to give.
      warn(rowNo, `Skipped "${username}": role "${roleRaw || '(blank)'}" isn't SuperUser, RTA or Team Lead.`)
      return
    }

    const accountIds: string[] = []
    const ignoredAccounts: string[] = []
    for (const name of splitAccountCell(cell(raw, 'accounts'))) {
      const id = resolveAccount(name, accounts)
      if (id) { if (!accountIds.includes(id)) accountIds.push(id) }
      else if (!ignoredAccounts.includes(name)) ignoredAccounts.push(name)
    }

    // A superuser sees everything by role, so an account list is meaningless
    // for them; say so rather than quietly dropping it.
    if (role === 'superuser') {
      if (accountIds.length || ignoredAccounts.length) {
        warn(rowNo, `"${username}" is a super user and already sees every account — the listed accounts are ignored.`)
      }
      accountIds.length = 0
      ignoredAccounts.length = 0
    } else if (ignoredAccounts.length) {
      warn(rowNo, `"${username}": ${ignoredAccounts.map(n => `"${n}"`).join(', ')} ${ignoredAccounts.length === 1 ? "isn't" : "aren't"} in WFM Live yet — ignored for now.`)
    }

    const fullName = cell(raw, 'fullName') || username
    const active   = map.status === undefined ? true : !isInactive(cell(raw, 'status'))

    const key = username.toLowerCase()
    const existing = byUsername.get(key)
    if (!existing) {
      byUsername.set(key, { username, fullName, role, accountIds, ignoredAccounts, isActive: active, sourceRows: [rowNo] })
      return
    }

    // Merge a repeated username. Accounts are unioned; for single-valued
    // fields the FIRST row wins, and any disagreement is reported rather than
    // silently resolved by last-write-wins.
    for (const a of accountIds) if (!existing.accountIds.includes(a)) existing.accountIds.push(a)
    for (const n of ignoredAccounts) if (!existing.ignoredAccounts.includes(n)) existing.ignoredAccounts.push(n)
    existing.sourceRows.push(rowNo)
    warn(rowNo, `"${username}" also appears on row ${existing.sourceRows[0]}; treated as one user with the combined accounts${existing.accountIds.length ? ` (${existing.accountIds.join(', ')})` : ''}.`)
    if (existing.role !== role) {
      warn(rowNo, `"${username}" is ${ROLE_WORD[existing.role]} on row ${existing.sourceRows[0]} but ${ROLE_WORD[role]} here; keeping ${ROLE_WORD[existing.role]}.`)
    }
    if (existing.fullName !== fullName && fullName !== username) {
      warn(rowNo, `"${username}" has two names ("${existing.fullName}" and "${fullName}"); keeping "${existing.fullName}".`)
    }
    if (existing.isActive !== active) {
      warn(rowNo, `"${username}" has conflicting status; keeping ${existing.isActive ? 'Active' : 'Inactive'}.`)
    }
  })

  // People with no matching account at all are NOT warned about here — the
  // parser doesn't know who already exists. planImport() below decides what
  // happens to them and lists them in their own "won't be imported" group.

  return { users: [...byUsername.values()], issues, ignoredColumns: unknown }
}

// ── Plan: what the import will actually do ──────────────────────────────────
export interface ExistingUser { id: string; username: string; role: UserRole; accountIds: string[] }

export interface ImportPlan {
  /** New people with at least one real WFM Live account (or super users). */
  willCreate: RosterUser[]
  /**
   * New people whose accounts are ALL missing from WFM Live. Shown in the
   * preview so the operator can see who was left out and why, but never
   * created: a login with no account to look at is just a blank dashboard.
   * Importing the same file again after their account exists picks them up.
   */
  willSkip: RosterUser[]
  /** Existing people who'll gain accounts they don't have yet. Additive only. */
  willAddAccounts: { id: string; username: string; add: string[]; ignoredAccounts: string[] }[]
  /** Existing people with nothing to change. */
  upToDate: string[]
  extraIssues: RosterIssue[]
}

/**
 * Decide, per person in the file: create, skip, top up, or leave alone.
 * `existing` is keyed by LOWERCASE username.
 *
 * Pure — no I/O — so the rules can be unit-tested without a database.
 */
export function planImport(users: RosterUser[], existing: Map<string, ExistingUser>): ImportPlan {
  const p: ImportPlan = { willCreate: [], willSkip: [], willAddAccounts: [], upToDate: [], extraIssues: [] }
  for (const u of users) {
    const have = existing.get(u.username.toLowerCase())

    if (!have) {
      // Super users see every account by role, so they never "lack" one.
      if (u.role !== 'superuser' && u.accountIds.length === 0) p.willSkip.push(u)
      else p.willCreate.push(u)
      continue
    }

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
