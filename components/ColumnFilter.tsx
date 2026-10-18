'use client'

// components/ColumnFilter.tsx
// Excel-style filter for one table column: a funnel button in the header that
// opens search + Select all / Clear all + a checkbox list + Apply / Cancel.
//
// Behaves exactly like the Overview page's AccountFilterDropdown
// (components/Dashboard.tsx), so the two feel the same:
//  - Edits are local until Apply. Cancel, Escape or clicking outside discards.
//  - Select all / Clear all act on what the SEARCH is currently showing, so you
//    can search, bulk-pick a subset, change the search, and keep adding.
//  - Ticking everything back on and applying clears the filter (`null`).
//
// The popover is portalled to <body> with fixed positioning. It lives inside
// the Settings modal, whose body scrolls and which animates with a transform —
// an absolutely-positioned popover there gets clipped by the scroll area, and
// a transformed ancestor breaks position:fixed. Portalling avoids both.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export interface FilterOption {
  value: string
  /** Rows that have this value AND pass every OTHER column's filter. */
  count: number
}

const POP_W = 280
const POP_H = 400

export default function ColumnFilter({ label, options, selected, onApply }: {
  label: string
  /** Every distinct value in the column, already sorted. */
  options: FilterOption[]
  /** null = no filter on this column (everything shown). */
  selected: Set<string> | null
  onApply: (next: Set<string> | null) => void
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false })
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const allValues = options.map(o => o.value)
  const active = selected !== null

  const openPopover = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Keep it on screen: clamp horizontally, and open upward if there isn't
    // room below the header.
    const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - POP_W - 8))
    const up = window.innerHeight - r.bottom < POP_H + 16 && r.top > POP_H + 16
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, up })
    // Fresh copy every open, so a previous Cancel leaves nothing behind.
    setChecked(new Set(selected ?? allValues))
    setSearch('')
    setOpen(true)
  }

  // While open: Escape cancels; anything OUTSIDE the popover scrolling, or a
  // resize, closes it — the header it's pinned to would move out from under it.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onScroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const q = search.trim().toLowerCase()
  const shown = q ? options.filter(o => o.value.toLowerCase().includes(q)) : options
  const allShownChecked = shown.length > 0 && shown.every(o => checked.has(o.value))
  const noneShownChecked = shown.every(o => !checked.has(o.value))

  const selectAllShown = () => setChecked(prev => new Set([...prev, ...shown.map(o => o.value)]))
  const clearAllShown = () => setChecked(prev => {
    const next = new Set(prev)
    shown.forEach(o => next.delete(o.value))
    return next
  })
  const toggle = (v: string) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v); else next.add(v)
    return next
  })
  const apply = () => {
    onApply(allValues.every(v => checked.has(v)) ? null : new Set(checked))
    setOpen(false)
  }

  const btnStyle: CSSProperties = {
    display: 'inline-grid', placeItems: 'center',
    width: 22, height: 22, marginLeft: 6, padding: 0,
    border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
    borderRadius: 5, cursor: 'pointer', verticalAlign: 'middle',
    background: active ? 'var(--primary-light)' : 'transparent',
    color: active ? 'var(--primary)' : 'inherit',
    opacity: active ? 1 : 0.6,
  }
  const smallBtn = (disabled: boolean): CSSProperties => ({
    flex: 1, padding: '5px 6px', borderRadius: 6, fontSize: 11.5,
    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-main)',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  })

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        style={btnStyle}
        onClick={() => (open ? setOpen(false) : openPopover())}
        title={active ? `Filtering ${label}: ${selected!.size} of ${allValues.length} shown` : `Filter ${label}`}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
      >
        <i className={`bx ${active ? 'bxs-filter-alt' : 'bx-filter-alt'}`} style={{ fontSize: 13 }} />
      </button>

      {open && createPortal(
        <>
          {/* Click-outside = Cancel. Sits above the Settings modal (z 99999). */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 100001 }} onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="dialog"
            aria-label={`Filter ${label}`}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', top: pos.top, left: pos.left, zIndex: 100002,
              transform: pos.up ? 'translateY(-100%)' : undefined,
              width: POP_W, maxHeight: POP_H, display: 'flex', flexDirection: 'column',
              background: 'var(--bg-card)', color: 'var(--text-main)',
              border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 10px 30px rgba(0,0,0,.28)',
              fontSize: 12.5, textTransform: 'none', letterSpacing: 'normal', fontWeight: 400,
            }}
          >
            <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-muted)', marginBottom: 6 }}>
                FILTER · {label.toUpperCase()}
              </div>
              <input
                type="text" autoFocus value={search} placeholder={`Search ${label.toLowerCase()}…`}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') apply() }}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'var(--bg-body)',
                  color: 'var(--text-main)', fontSize: 12.5, fontFamily: 'inherit',
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
              <button type="button" onClick={selectAllShown} disabled={allShownChecked} style={smallBtn(allShownChecked)}>
                Select all{q ? ' (shown)' : ''}
              </button>
              <button type="button" onClick={clearAllShown} disabled={noneShownChecked} style={smallBtn(noneShownChecked)}>
                Clear all{q ? ' (shown)' : ''}
              </button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
              {shown.length === 0 && (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)' }}>No matches</div>
              )}
              {shown.map(o => (
                <label
                  key={o.value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer',
                    // Values no row would show (given the other filters) are dimmed, not hidden.
                    opacity: o.count === 0 ? 0.45 : 1,
                  }}
                >
                  <input type="checkbox" checked={checked.has(o.value)} onChange={() => toggle(o.value)} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.value}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{o.count}</span>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--border)' }}>
              <button type="button" onClick={() => setOpen(false)} style={{
                flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 12,
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-main)', cursor: 'pointer',
              }}>Cancel</button>
              <button type="button" onClick={apply} disabled={checked.size === 0} style={{
                flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: 'none', background: 'var(--primary)', color: '#fff',
                cursor: checked.size === 0 ? 'not-allowed' : 'pointer', opacity: checked.size === 0 ? 0.5 : 1,
              }}>Apply</button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
