import type { KpiSnapshot, Thresholds } from './types'

// ── StatusThresholds type ─────────────────────────────────────────────────────
export type StatusThresholds = Record<string, { warn: number; crit: number }>

// ── Default KPI thresholds ────────────────────────────────────────────────────
export const DEFAULT_THRESHOLDS: Thresholds = {
  sla:  { warn: 75, crit: 65, targ: 80, direction: 'desc' },
  wait: { warn: 15, crit: 25, targ: 10, direction: 'asc'  },
  aht:  { warn: 30, crit: 60, targ: 25, direction: 'asc'  },
  abn:  { warn: 5,  crit: 8,  targ: 3,  direction: 'asc'  },
}

// ── Default status duration thresholds (minutes) ──────────────────────────────
export const DEFAULT_STATUS_THRESHOLDS: StatusThresholds = {
  'Ringing':           { warn: 3,  crit: 5   },
  'In call':           { warn: 20, crit: 30  },
  'After call work':   { warn: 3,  crit: 6   },
  'On a break':        { warn: 15, crit: 20  },
  'Out for lunch':     { warn: 35, crit: 45  },
  'Do not disturb':    { warn: 10, crit: 20  },
  'Not available':     { warn: 10, crit: 20  },
  'Back office':       { warn: 15, crit: 30  },
  'In training':       { warn: 30, crit: 60  },
  'Other':             { warn: 15, crit: 30  },
  'Available':         { warn: 999, crit: 999 },
  'Offline':           { warn: 999, crit: 999 },
}

// ── localStorage helpers (safe for SSR — only call inside useEffect/handlers) ─
export function loadKpiThresholds(accountId: string): Thresholds {
  try {
    const raw = localStorage.getItem(`wfm_kpi_th_${accountId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        sla:  { ...DEFAULT_THRESHOLDS.sla,  ...parsed.sla  },
        wait: { ...DEFAULT_THRESHOLDS.wait, ...parsed.wait },
        aht:  { ...DEFAULT_THRESHOLDS.aht,  ...parsed.aht  },
        abn:  { ...DEFAULT_THRESHOLDS.abn,  ...parsed.abn  },
      }
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS))
}

export function saveKpiThresholds(accountId: string, th: Thresholds): void {
  try { localStorage.setItem(`wfm_kpi_th_${accountId}`, JSON.stringify(th)) } catch {}
}

export function loadStatusThresholds(accountId: string): StatusThresholds {
  try {
    const raw = localStorage.getItem(`wfm_status_th_${accountId}`)
    if (raw) return { ...DEFAULT_STATUS_THRESHOLDS, ...JSON.parse(raw) }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_STATUS_THRESHOLDS))
}

export function saveStatusThresholds(accountId: string, th: StatusThresholds): void {
  try { localStorage.setItem(`wfm_status_th_${accountId}`, JSON.stringify(th)) } catch {}
}

// ── Duration parsing ──────────────────────────────────────────────────────────
export function parseDurationToSeconds(str: string | null | undefined): number {
  if (!str) return 0
  const s = String(str).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  let total = 0
  const h = s.match(/(\d+)\s*h/i);   if (h)  total += parseInt(h[1]) * 3600
  const m = s.match(/(\d+)\s*min/i) || s.match(/(\d+)\s*m(?!s)/i)
  if (m) total += parseInt(m[1]) * 60
  const sec = s.match(/(\d+)\s*s/i); if (sec) total += parseInt(sec[1])
  return total
}

// ── Format seconds to "5m 30s" ────────────────────────────────────────────────
export function formatSeconds(totalSec: number): string {
  totalSec = Math.round(Math.max(0, totalSec))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

// ── Extract percent value from "85.7%" → 85.7 ────────────────────────────────
export function extractPercent(str: string | null | undefined): number {
  if (!str || str === 'N/A' || str === '-') return NaN
  const cleaned = String(str).replace(/\s+/g, '')
  const m = cleaned.match(/([\d.]+)%/)
  if (m) return parseFloat(m[1])
  const n = parseFloat(cleaned)
  return isNaN(n) ? NaN : n
}

// ── Compute abandon rate from KPI snapshot ────────────────────────────────────
export function calcAbandonRate(kpi: KpiSnapshot | null): string {
  if (!kpi) return 'N/A'
  const total = parseInt(kpi.total_calls ?? '0')
  const unans = parseInt(kpi.unanswered  ?? '0')
  if (!total) return '0%'
  return ((unans / total) * 100).toFixed(1) + '%'
}

// ── Stale data check (> 3 minutes old) ───────────────────────────────────────
export function isDataStale(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false
  return Date.now() - new Date(updatedAt).getTime() > 3 * 60 * 1000
}

// ── Format timestamp ──────────────────────────────────────────────────────────
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--:--'
  return new Date(iso).toLocaleTimeString()
}

// ── Status pill CSS class ─────────────────────────────────────────────────────
export function getStatusPillClass(status: string | null): string {
  const s = (status || '').toLowerCase()
  if (s.includes('available') && !s.includes('not')) return 'pill pill-available'
  if (s.includes('ringing'))                           return 'pill pill-ringing'
  if (s.includes('in call') || s.includes('incall'))   return 'pill pill-incall'
  if (s.includes('after call') || s === 'acw')         return 'pill pill-acw'
  if (s.includes('break') || s.includes('lunch') || s.includes('do not')) return 'pill pill-break'
  if (s.includes('not available') || s.includes('unavailable'))            return 'pill pill-nav'
  if (s.includes('offline'))                           return 'pill pill-offline'
  if (s.includes('training') || s.includes('coaching') || s.includes('meeting') || s.includes('back office')) return 'pill pill-meeting'
  return 'pill pill-default'
}

// ── KPI color class ───────────────────────────────────────────────────────────
export function getKpiColorClass(
  value: number,
  th: { warn: number; crit: number; direction: 'asc' | 'desc' }
): string {
  if (isNaN(value)) return 'text-muted'
  if (th.direction === 'desc') {
    if (value <= th.crit) return 'text-danger'
    if (value <= th.warn) return 'text-warning'
    return 'text-success'
  } else {
    if (value >= th.crit) return 'text-danger'
    if (value >= th.warn) return 'text-warning'
    return 'text-success'
  }
}
