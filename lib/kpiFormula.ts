// lib/kpiFormula.ts
// Formula KPI tiles (per the user, 2026-11-16): instead of one cell, a tile's
// value can be worked out from several — e.g. "(A + B) / C * 100", where A, B and
// C are each a cell in the tile's table or another tile's current value
// (GroupTile.formula, lib/types.ts). The tile keeps its own unit and warning /
// critical thresholds, so "over 4% warning, over 10% critical" is just a percent
// tile with warn 4 / crit 10.
//
// Pure and shared by the browser and the server: the value is worked out inside
// makeKpiCellResolver() (lib/breaches.ts), so the Dashboard, the Overview card,
// breaches, Cliq (message + picture), Workforce/RTA Logs and the Hourly page all
// see the same number. Settings uses checkFormula() / evaluateKpiFormula() for
// its live check and "Test with live data".
//
// The language — a tiny parser, never eval():
//   numbers  12, 0.5          values  A … Z (any case)       + - * /  ( )
//   min(…)  max(…)  sum(…)  avg(…)  abs(x)  round(x)  round(x, 1)
//   Usual precedence: * and / before + and -, so "A + B / C" is A + (B / C) —
//   write "(A + B) / C" for the other. × and ÷ are read as * and /.
// Reading a value: "85.3%" → 85.3 · "1,256" → 1256 · "1:55" / "1h 2m" → seconds
// (115 / 3720) · blank, "--", "N/A" → no value.
// The result is shown in the tile's unit: percent "12.35%", count rounded to a
// whole number, duration = SECONDS shown like "1m 55s".
// No value (a blank operand, division by zero, an unknown letter) → the tile
// shows "--" and never breaches, like an unbound cell.

import type { KpiFormula, KpiFormulaOperand, KpiUnit } from './types'
import { extractPercent, formatSeconds, parseDurationToSeconds } from './utils'

export const FORMULA_FUNCTIONS = ['min', 'max', 'sum', 'avg', 'abs', 'round'] as const
type Fn = typeof FORMULA_FUNCTIONS[number]
/** The letters a formula can use, in order — "Add value" hands out the next free one. */
export const OPERAND_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; id: string }
  | { t: 'neg'; e: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Node; r: Node }
  | { t: 'call'; fn: Fn; args: Node[] }

export type ParsedFormula = { ok: true; ast: Node; vars: string[] } | { ok: false; error: string }

type Tok = { k: 'num'; v: number; at: number } | { k: 'name'; v: string; at: number } | { k: 'op'; v: string; at: number }

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      const text = src.slice(i, j)
      const v = Number(text)
      if (!/^(\d+\.?\d*|\.\d+)$/.test(text) || !Number.isFinite(v)) return `"${text}" isn't a number`
      out.push({ k: 'num', v, at: i }); i = j; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ k: 'name', v: src.slice(i, j), at: i }); i = j; continue
    }
    const op = c === '×' ? '*' : c === '÷' ? '/' : c
    if ('+-*/(),'.includes(op)) { out.push({ k: 'op', v: op, at: i }); i++; continue }
    return `"${c}" can't be used — only + - * / ( ) , numbers, letters and functions`
  }
  return out
}

const parseCache = new Map<string, ParsedFormula>()

/** Parse a formula once (cached by its text). Never throws. */
export function parseFormula(expr: unknown): ParsedFormula {
  const src = typeof expr === 'string' ? expr : ''
  const hit = parseCache.get(src)
  if (hit) return hit
  const res = parseUncached(src)
  if (parseCache.size > 500) parseCache.clear()
  parseCache.set(src, res)
  return res
}

function parseUncached(src: string): ParsedFormula {
  if (!src.trim()) return { ok: false, error: 'Type a formula, e.g. (A + B) / C * 100' }
  const toks = tokenize(src)
  if (typeof toks === 'string') return { ok: false, error: toks }
  let p = 0
  const vars = new Set<string>()
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v
  const fail = (msg: string): never => { throw new Error(msg) }

  const expr = (): Node => {
    let l = term()
    while (isOp('+') || isOp('-')) { const op = (toks[p++] as Tok).v as '+' | '-'; l = { t: 'bin', op, l, r: term() } }
    return l
  }
  const term = (): Node => {
    let l = unary()
    while (isOp('*') || isOp('/')) { const op = (toks[p++] as Tok).v as '*' | '/'; l = { t: 'bin', op, l, r: unary() } }
    return l
  }
  const unary = (): Node => {
    if (isOp('-')) { p++; return { t: 'neg', e: unary() } }
    if (isOp('+')) { p++; return unary() }
    return primary()
  }
  const primary = (): Node => {
    const tk = peek()
    if (!tk) return fail('The formula ends too early')
    if (tk.k === 'num') { p++; return { t: 'num', v: tk.v } }
    if (tk.k === 'op' && tk.v === '(') {
      p++
      const e = expr()
      if (!isOp(')')) fail('A "(" is missing its ")"')
      p++
      return e
    }
    if (tk.k === 'name') {
      p++
      if (isOp('(')) {
        const fn = tk.v.toLowerCase() as Fn
        if (!FORMULA_FUNCTIONS.includes(fn)) fail(`"${tk.v}" isn't a function — use ${FORMULA_FUNCTIONS.join(', ')}`)
        p++
        const args: Node[] = []
        if (!isOp(')')) {
          args.push(expr())
          while (isOp(',')) { p++; args.push(expr()) }
        }
        if (!isOp(')')) fail(`${fn}( is missing its ")"`)
        p++
        if (args.length === 0) fail(`${fn}() needs at least one value`)
        if (fn === 'abs' && args.length !== 1) fail('abs() takes one value')
        if (fn === 'round' && args.length > 2) fail('round() takes a value and, optionally, decimals: round(A, 1)')
        return { t: 'call', fn, args }
      }
      if (!/^[A-Za-z]$/.test(tk.v)) fail(`"${tk.v}" isn't a value — values are single letters A–Z`)
      const id = tk.v.toUpperCase()
      vars.add(id)
      return { t: 'var', id }
    }
    return fail(`"${tk.v}" is in the wrong place`)
  }

  try {
    const ast = expr()
    if (p < toks.length) {
      const tk = toks[p]
      return { ok: false, error: tk.k === 'op' && tk.v === ')' ? 'A ")" has no "(" before it' : `"${String(tk.v)}" is in the wrong place` }
    }
    return { ok: true, ast, vars: [...vars].sort() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Work out a parsed formula. null = no value (a missing operand, ÷ 0, not finite). */
export function evalAst(ast: Node, vars: Record<string, number | null | undefined>): number | null {
  const ev = (n: Node): number | null => {
    switch (n.t) {
      case 'num': return n.v
      case 'var': { const v = vars[n.id]; return v === undefined || v === null || !Number.isFinite(v) ? null : v }
      case 'neg': { const v = ev(n.e); return v === null ? null : -v }
      case 'bin': {
        const l = ev(n.l), r = ev(n.r)
        if (l === null || r === null) return null
        if (n.op === '+') return l + r
        if (n.op === '-') return l - r
        if (n.op === '*') return l * r
        return r === 0 ? null : l / r
      }
      case 'call': {
        const a = n.args.map(ev)
        if (a.some(v => v === null)) return null
        const xs = a as number[]
        switch (n.fn) {
          case 'min': return Math.min(...xs)
          case 'max': return Math.max(...xs)
          case 'sum': return xs.reduce((s, x) => s + x, 0)
          case 'avg': return xs.reduce((s, x) => s + x, 0) / xs.length
          case 'abs': return Math.abs(xs[0])
          case 'round': { const d = Math.max(0, Math.min(6, Math.round(xs[1] ?? 0))); const k = 10 ** d; return Math.round(xs[0] * k) / k }
        }
      }
    }
    return null
  }
  const v = ev(ast)
  return v === null || !Number.isFinite(v) ? null : v
}

/** A cell's text as a number: "85.3%" → 85.3, "$1,256" → 1256, "1:55" / "1h 2m" → seconds;
 *  blank / "--" / "N/A" → null. */
export function parseOperandValue(raw: unknown): number | null {
  const s = String(raw ?? '').trim()
  if (!s || /^[-–—]+$/.test(s) || /^n\/?a$/i.test(s) || /^null$/i.test(s)) return null
  if (/^\d+(\.\d+)?(:\d{1,2}){1,2}$/.test(s) || /^(\d+(\.\d+)?\s*[dhms]\s*)+$/i.test(s)) return parseDurationToSeconds(s)
  const n = extractPercent(s.replace(/[$€£₱]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** "12.35%" / "13" / "1m 55s" — the tile's unit decides; the value is what extractKpiValue() reads back. */
export function formatFormulaResult(n: number, unit: KpiUnit | undefined): string {
  if (unit === 'duration') return formatSeconds(n)
  if (unit === 'count') return String(Math.round(n) || 0)
  const t = Number(n.toFixed(2))
  return `${Object.is(t, -0) ? 0 : t}%`
}

export interface FormulaPart { id: string; raw: string; num: number | null }
export interface FormulaResult {
  /** The tile's value, formatted in its unit — '' when there's no value (the tile shows "--"). */
  value: string
  num: number | null
  parts: FormulaPart[]
  /** Why there's no value — a typo in the formula, or which value is blank. */
  error?: string
}

/** The operands of a saved formula, defensively: on the server it's raw JSONB. */
export function formulaOperands(f: KpiFormula | null | undefined): KpiFormulaOperand[] {
  return Array.isArray(f?.operands) ? f!.operands.filter(o => o && typeof o.id === 'string') : []
}

/** Evaluate a tile's formula. `rawOf(operand)` reads one operand's cell / tile as text. */
export function evaluateKpiFormula(
  f: KpiFormula | null | undefined, rawOf: (op: KpiFormulaOperand) => string, unit: KpiUnit | undefined,
): FormulaResult {
  const parsed = parseFormula(f?.expr)
  if (!parsed.ok) return { value: '', num: null, parts: [], error: parsed.error }
  const ops = new Map(formulaOperands(f).map(o => [o.id.toUpperCase(), o]))
  const parts: FormulaPart[] = parsed.vars.map(id => {
    const op = ops.get(id)
    const raw = op ? rawOf(op) : ''
    return { id, raw, num: op ? parseOperandValue(raw) : null }
  })
  const missing = parsed.vars.filter(id => !ops.has(id))
  if (missing.length) return { value: '', num: null, parts, error: `${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} set — add ${missing.length > 1 ? 'them' : 'it'} below` }
  const blank = parts.filter(x => x.num === null).map(x => x.id)
  const num = evalAst(parsed.ast, Object.fromEntries(parts.map(x => [x.id, x.num])))
  if (num === null) {
    return { value: '', num: null, parts, error: blank.length ? `No value for ${blank.join(', ')} right now` : 'No result — dividing by zero?' }
  }
  return { value: formatFormulaResult(num, unit), num, parts }
}

/** For the editor: what's wrong with a formula as configured (null = fine), and which values it leaves unused. */
export function checkFormula(f: KpiFormula | null | undefined): { error: string | null; unused: string[] } {
  const parsed = parseFormula(f?.expr)
  const ops = formulaOperands(f)
  if (!parsed.ok) return { error: parsed.error, unused: [] }
  const ids = new Set(ops.map(o => o.id.toUpperCase()))
  const missing = parsed.vars.filter(id => !ids.has(id))
  const unbound = ops.filter(o => parsed.vars.includes(o.id.toUpperCase()) && !o.cell?.valueCol && !o.tileRef?.tileKey).map(o => o.id)
  const unused = ops.filter(o => !parsed.vars.includes(o.id.toUpperCase())).map(o => o.id)
  if (missing.length) return { error: `${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} a value yet — add ${missing.length > 1 ? 'them' : 'it'} below`, unused }
  if (unbound.length) return { error: `Pick a cell or a tile for ${unbound.join(', ')}`, unused }
  return { error: null, unused }
}

/** The next letter not taken by an operand. */
export function nextOperandId(f: KpiFormula | null | undefined): string | null {
  const taken = new Set(formulaOperands(f).map(o => o.id.toUpperCase()))
  return OPERAND_IDS.find(id => !taken.has(id)) ?? null
}
