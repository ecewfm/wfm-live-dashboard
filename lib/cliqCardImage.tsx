// lib/cliqCardImage.tsx
// Server-side only — draws an account's Overview card (KPI tiles + Breach /
// Anomalies table) as a PNG, which lib/cliqScan.ts posts to the account's Cliq
// channel right under the text alert (per the user, 2026-11-03). Built with
// next/og's ImageResponse (Satori + Resvg, no browser), in the dashboard's
// dark theme and font (Poppins, assets/fonts — traced into the Cliq scan
// routes by next.config.ts).
//
// The PNG only ever lives in memory: lib/zohoCliq.ts's sendCliqChannelFile()
// uploads the bytes and they're dropped — never written to disk or storage,
// and never recorded in the Loggings tab (also per the user).
//
// Satori lays out with flexbox only (no <table>) and needs the image height up
// front, so every row has a fixed height, text never wraps (a long value ends
// in "…"), and cardHeight() adds those heights up.
//
// The exported colours, font loader, icons and text helpers are shared with the
// hourly report's table picture (lib/hourlyCliqImage.tsx).

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import type { ReactNode } from 'react'
import type { BreachRow, KpiCardGroup } from './breaches'

export interface CardImageInput {
  accountId: string
  displayName: string
  groups: KpiCardGroup[]      // kpiCardGroups() — the same tiles the Overview card shows
  breaches: BreachRow[]       // the breaches in the Cliq message
  cols: { key: string; label: string }[]   // breachTableExtraCols() — the table's gear
  updatedAt: string | undefined            // freshestAcrossSources()
  testMode: boolean
}

// Dark-mode colours from app/globals.css (.dark and the .ov-* card rules).
export const C = {
  page: '#1a1a1a', card: '#252525', border: '#2e2e2e',
  text: '#f0f0f0', cell: '#e0e0e0', muted: '#a0a0a0', head: '#888888',
  success: '#4dca85', warning: '#ffd166', danger: '#ff6b6b', primary: '#d97a35', live: '#54c78b',
}
const TILE_COLOR: Record<string, string> = { 'text-success': C.success, 'text-warning': C.warning, 'text-danger': C.danger }

export const SCALE = 2          // drawn at 2x so it stays sharp when opened full size
export const PAD = 12           // page margin around the card
const TILES_PER_ROW = 4  // .ov-kpi-tile is 25% wide
const MAX_ROWS = 20      // breach rows drawn; the rest are counted in a "+N more" row
const H = { header: 48, label: 26, tileRow: 62, groupGap: 10, breachHead: 33, tableHead: 31, row: 37, more: 30, footer: 33 }
// Table columns are fitted to their text, like the HTML table's auto layout:
// 50–300px of text (textPx) plus the cell's 24px padding. The card is
// 560–1000px wide; past 1000 the columns shrink in proportion and the longest
// values end in "…".
const CELL_PAD = 24, MIN_W = 560, MAX_W = 1000
const STATUS_PX = 70   // the Critical / Warning pill

// Rough width of `s` in 12px Poppins (a wide font: capitals and digits take
// more room than lower case), measured off rendered cards with ~8% to spare.
export function textPx(s: string): number {
  let w = 0
  for (const ch of s) w += /[A-Z0-9%#&@]/.test(ch) ? 8.4 : /[\s.,:;|'!()ijlt]/.test(ch) ? 4 : 7
  return w * 1.08
}
// A header label: 10px capitals with 0.5px letter spacing.
export const headerPx = (label: string) => textPx(label.toUpperCase()) * 10 / 12 + label.length * 0.5

// Boxicons 2.1.4 (the set app/layout.tsx loads) — bx-buildings, bxs-alarm,
// bx-error-circle, bx-time-five.
const ICONS: Record<string, string[]> = {
  buildings: ['M19 2H9c-1.103 0-2 .897-2 2v6H5c-1.103 0-2 .897-2 2v9a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4c0-1.103-.897-2-2-2zM5 12h6v8H5v-8zm14 8h-6v-8c0-1.103-.897-2-2-2H9V4h10v16z', 'M11 6h2v2h-2zm4 0h2v2h-2zm0 4.031h2V12h-2zM15 14h2v2h-2zm-8 .001h2v2H7z'],
  alarm: ['M12 4c-4.878 0-9 4.122-9 9s4.122 9 9 9c4.879 0 9-4.122 9-9s-4.121-9-9-9zm5 10h-6V8h2v4h4v2zm3.292-7.292-3.01-3 1.412-1.417 3.01 3zM5.282 2.294 6.7 3.706l-2.99 3-1.417-1.413z'],
  error: ['M11.953 2C6.465 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.493 2 11.953 2zM12 20c-4.411 0-8-3.589-8-8s3.567-8 7.953-8C16.391 4 20 7.589 20 12s-3.589 8-8 8z', 'M11 7h2v7h-2zm0 8h2v2h-2z'],
  clock: ['M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z', 'M13 7h-2v5.414l3.293 3.293 1.414-1.414L13 11.586z'],
}

export function Icon({ name, size, color }: { name: string; size: number; color: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24">
      {ICONS[name].map((d, i) => <path key={i} d={d} fill={color} />)}
    </svg>
  )
}

// One line of text that ends in "…" instead of wrapping.
export const oneLine = { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } as const

// Satori throws on a style value that is `undefined`, so optional ones are
// only added when set.
function Cell({ grow, children, color, weight }: { grow: number; children: ReactNode; color?: string; weight?: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexGrow: grow, flexBasis: 0, minWidth: 0, padding: '0 12px',
      ...(color ? { color } : {}), ...(weight ? { fontWeight: weight } : {}),
    }}>
      <div style={{ display: 'block', ...oneLine }}>{children}</div>
    </div>
  )
}

// Each column's text width, used as its flex-grow, and the card's width. The
// cells have flexBasis 0 plus 24px padding, so flex hands out the width left
// after padding in proportion to `grow` — at the natural width every column
// gets exactly its text width.
function tableLayout(input: CardImageInput): { grow: number[]; width: number } {
  const rows = input.breaches.slice(0, MAX_ROWS)
  const columns: [string, (b: BreachRow) => string][] = [
    ['Queue/Agent', b => b.entity],
    ['Metric',      b => b.metric],
    ['Value',       b => b.value],
    ['Threshold',   b => b.threshold],
    ...input.cols.map(c => [c.label, (b: BreachRow) => (b.kind === 'agent' ? b.extras?.[c.key] : '') || '—'] as [string, (b: BreachRow) => string]),
  ]
  const grow = columns.map(([label, value]) => {
    const text = Math.max(headerPx(label), ...rows.map(b => textPx(String(value(b) ?? ''))))
    return Math.min(300, Math.max(50, text))
  })
  grow.push(STATUS_PX)
  const natural = grow.reduce((a, b) => a + b + CELL_PAD, 0)
  return { grow, width: Math.round(Math.min(MAX_W, Math.max(MIN_W, natural))) }
}

function cardHeight(input: CardImageInput): number {
  const groups = input.groups.reduce((sum, g) =>
    sum + H.label + Math.ceil(g.tiles.length / TILES_PER_ROW) * H.tileRow + 1 + H.groupGap, 0)
  const rows = Math.max(1, Math.min(MAX_ROWS, input.breaches.length)) * H.row
  const more = input.breaches.length > MAX_ROWS ? H.more : 0
  return 2 + H.header + groups + H.breachHead + H.tableHead + rows + more + H.footer
}

function Card({ input, grow, width }: { input: CardImageInput; grow: number[]; width: number }) {
  const { accountId, displayName, groups, cols, testMode } = input
  const statusGrow = grow[grow.length - 1]
  const shown = input.breaches.slice(0, MAX_ROWS)
  const more = input.breaches.length - shown.length
  const hasCrit = input.breaches.some(b => b.severity === 'critical')
  const updated = input.updatedAt
    ? new Date(input.updatedAt).toLocaleTimeString('en-US', { timeZoneName: 'short' })
    : 'Waiting for data...'

  // No overflow: hidden for the rounded corners — under the 2x scale Satori
  // then drops the icons. The header and footer round their own corners.
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width, background: C.card,
      border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: 'Poppins',
    }}>
      {/* Header — .overview-card-header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: H.header,
        padding: '0 16px', background: 'linear-gradient(135deg, #1e1e1e 0%, #141414 100%)',
        borderBottom: `1px solid ${C.border}`, borderTopLeftRadius: 7, borderTopRightRadius: 7,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <Icon name="buildings" size={17} color={C.primary} />
          <div style={{ display: 'block', marginLeft: 8, fontSize: 14, fontWeight: 700, color: '#ffffff', letterSpacing: 0.3, ...oneLine }}>{displayName}</div>
          {displayName !== accountId && (
            <div style={{ display: 'block', marginLeft: 6, fontSize: 10, color: C.muted, ...oneLine }}>{`(${accountId})`}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {testMode && (
            <div style={{
              display: 'flex', marginRight: 10, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
              color: C.warning, background: 'rgba(255,209,102,0.15)', border: '1px solid rgba(255,209,102,0.35)',
            }}>TEST</div>
          )}
          {input.breaches.length > 0 && <Icon name="alarm" size={17} color={hasCrit ? C.danger : C.warning} />}
          <div style={{ display: 'flex', width: 7, height: 7, marginLeft: 10, borderRadius: 7, background: C.live, boxShadow: `0 0 5px ${C.live}` }} />
          <div style={{ display: 'flex', marginLeft: 5, fontSize: 11, fontWeight: 600, color: C.live }}>Live</div>
        </div>
      </div>

      {/* KPI tiles — .ov-section-label + .ov-kpi-tiles, one block per group */}
      {groups.map(g => {
        const rows: KpiCardGroup['tiles'][] = []
        for (let i = 0; i < g.tiles.length; i += TILES_PER_ROW) rows.push(g.tiles.slice(i, i + TILES_PER_ROW))
        return (
          <div key={g.id} style={{ display: 'flex', flexDirection: 'column', marginBottom: H.groupGap }}>
            <div style={{
              display: 'flex', alignItems: 'center', height: H.label, padding: '0 12px',
              fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5,
              background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={{ display: 'block', ...oneLine }}>{g.name}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', height: rows.length * H.tileRow + 1, borderBottom: `1px solid ${C.border}` }}>
              {rows.map((row, r) => (
                <div key={r} style={{ display: 'flex', height: H.tileRow }}>
                  {row.map((t, i) => (
                    <div key={t.key} style={{
                      display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, flexBasis: 0, minWidth: 0,
                      padding: '0 12px', borderRight: i < row.length - 1 ? `1px solid ${C.border}` : 'none',
                    }}>
                      <div style={{ display: 'block', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: C.muted, ...oneLine }}>{t.label}</div>
                      <div style={{ display: 'block', marginTop: 3, fontSize: 20, fontWeight: 700, lineHeight: 1.1, color: TILE_COLOR[t.colorClass] ?? C.muted, ...oneLine }}>{t.value || '--'}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* Breach / Anomalies — .ov-breach-header + .ov-breach-table */}
      <div style={{
        display: 'flex', alignItems: 'center', height: H.breachHead, padding: '0 14px',
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: C.danger,
        background: 'rgba(255,107,107,0.1)', borderBottom: '1px solid rgba(255,107,107,0.18)',
      }}>
        <Icon name="error" size={13} color={C.danger} />
        <div style={{ display: 'flex', marginLeft: 6 }}>Breach / Anomalies</div>
      </div>
      <div style={{
        display: 'flex', height: H.tableHead, background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${C.border}`,
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: C.head,
      }}>
        <Cell grow={grow[0]}>Queue/Agent</Cell>
        <Cell grow={grow[1]}>Metric</Cell>
        <Cell grow={grow[2]}>Value</Cell>
        <Cell grow={grow[3]}>Threshold</Cell>
        {cols.map((c, i) => <Cell key={c.key} grow={grow[4 + i]}>{c.label}</Cell>)}
        <Cell grow={statusGrow}>Status</Cell>
      </div>
      {shown.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: H.row, fontSize: 12, color: C.success }}>
          No breaches detected
        </div>
      ) : shown.map((b, i) => {
        const crit = b.severity === 'critical'
        return (
          <div key={i} style={{
            display: 'flex', height: H.row, fontSize: 12, color: C.cell,
            borderBottom: i < shown.length - 1 || more > 0 ? `1px solid ${C.border}` : 'none',
          }}>
            <Cell grow={grow[0]} weight={500}>{b.entity}</Cell>
            <Cell grow={grow[1]}>{b.metric}</Cell>
            <Cell grow={grow[2]} weight={600} color={crit ? C.danger : C.warning}>{b.value}</Cell>
            <Cell grow={grow[3]} color={C.muted}>{b.threshold}</Cell>
            {cols.map((c, i) => <Cell key={c.key} grow={grow[4 + i]}>{b.kind === 'agent' ? (b.extras?.[c.key] || '—') : '—'}</Cell>)}
            <div style={{ display: 'flex', alignItems: 'center', flexGrow: statusGrow, flexBasis: 0, minWidth: 0, padding: '0 12px' }}>
              <div style={{
                display: 'flex', padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                color: crit ? C.danger : C.warning,
                background: crit ? 'rgba(255,107,107,0.15)' : 'rgba(255,209,102,0.15)',
                border: `1px solid ${crit ? 'rgba(255,107,107,0.35)' : 'rgba(255,209,102,0.35)'}`,
              }}>{crit ? 'Critical' : 'Warning'}</div>
            </div>
          </div>
        )
      })}
      {more > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: H.more, fontSize: 11, color: C.muted }}>
          {`+ ${more} more — the full list is in the message above`}
        </div>
      )}

      {/* Footer — .overview-card-footer */}
      <div style={{
        display: 'flex', alignItems: 'center', height: H.footer, padding: '0 14px',
        fontSize: 11, color: C.muted, borderTop: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.01)',
        borderBottomLeftRadius: 7, borderBottomRightRadius: 7,
      }}>
        <Icon name="clock" size={12} color={C.muted} />
        <div style={{ display: 'flex', marginLeft: 5 }}>{`Updated: ${updated}`}</div>
      </div>
    </div>
  )
}

// Read once per server instance; a failed read isn't cached, so the next
// alert tries again.
type Font = { name: string; data: Buffer; weight: 400 | 600 | 700; style: 'normal' }
let fonts: Promise<Font[]> | null = null
export function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all(([['Poppins-Regular.ttf', 400], ['Poppins-SemiBold.ttf', 600], ['Poppins-Bold.ttf', 700]] as const)
    .map(async ([file, weight]) => ({
      name: 'Poppins', weight, style: 'normal' as const,
      data: await readFile(path.join(process.cwd(), 'assets', 'fonts', file)),
    })))
    .catch(e => { fonts = null; throw e })
  return fonts
}

// Satori draws an emoji by fetching its picture from a CDN, and a failed fetch
// fails the whole picture (a missing font for other scripts only drops those
// letters). So a picture that fails is drawn once more with every emoji taken
// out of the text.
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu
export const noEmoji = (s: string) => s.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim()

function withoutEmoji(input: CardImageInput): CardImageInput {
  return {
    ...input,
    displayName: noEmoji(input.displayName),
    groups: input.groups.map(g => ({ ...g, name: noEmoji(g.name), tiles: g.tiles.map(t => ({ ...t, label: noEmoji(t.label), value: noEmoji(t.value) })) })),
    breaches: input.breaches.map(b => ({
      ...b, entity: noEmoji(b.entity), metric: noEmoji(b.metric), value: noEmoji(b.value), threshold: noEmoji(b.threshold),
      extras: b.extras && Object.fromEntries(Object.entries(b.extras).map(([k, v]) => [k, noEmoji(String(v ?? ''))])),
    })),
    cols: input.cols.map(c => ({ ...c, label: noEmoji(c.label) })),
  }
}

/** The account's card as PNG bytes, in memory only. */
export async function renderAccountCardPng(input: CardImageInput): Promise<Uint8Array> {
  try {
    return await draw(input)
  } catch (e) {
    const plain = withoutEmoji(input)
    if (JSON.stringify(plain) === JSON.stringify(input)) throw e
    return await draw(plain)
  }
}

async function draw(input: CardImageInput): Promise<Uint8Array> {
  const { grow, width } = tableLayout(input)
  const page = { width: width + PAD * 2, height: cardHeight(input) + PAD * 2 }
  // Laid out at 1x and scaled up as a whole; the inner box has the 1x size
  // set so it doesn't stretch to the (2x) image size before scaling.
  const res = new ImageResponse(
    (
      <div style={{ display: 'flex', width: page.width * SCALE, height: page.height * SCALE, background: C.page }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', flexShrink: 0, width: page.width, height: page.height, padding: PAD,
          transform: `scale(${SCALE})`, transformOrigin: 'top left',
        }}>
          <Card input={input} grow={grow} width={width} />
        </div>
      </div>
    ),
    { width: page.width * SCALE, height: page.height * SCALE, fonts: await loadFonts() },
  )
  return new Uint8Array(await res.arrayBuffer())
}
