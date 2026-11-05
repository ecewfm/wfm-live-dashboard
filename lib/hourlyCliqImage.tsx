// lib/hourlyCliqImage.tsx
// Server-side only — draws the day's hourly table (the Hourly page's table, up
// to the hour being reported) as a PNG, which lib/hourlyCliq.ts posts to the
// account's Cliq channel right under the hourly report message (per the user,
// 2026-11-05). Same way as the breach alert's card picture
// (lib/cliqCardImage.tsx — its colours, font, icons and emoji fallback are
// shared from there): next/og's ImageResponse, dark theme, in memory only —
// never written anywhere, never in the Loggings tab.
//
// Satori has no <table>, so every column has a fixed width (fitted to its text,
// textPx) and every row a fixed height; the image's size is added up front.
// The cell texts and tones come ready-made from lib/hourlyCliq.ts, which builds
// them with the SAME functions as the page (lib/hourlyReport.ts).

import { ImageResponse } from 'next/og'
import type { ReactNode } from 'react'
import { C, SCALE, PAD, textPx, headerPx, oneLine, Icon, loadFonts, noEmoji } from './cliqCardImage'
import type { CellTone } from './hourlyReport'

export interface HourlyImageCell { text: string; tone: CellTone }
export interface HourlyImageRow {
  label: string            // "10:00"
  highlight: boolean       // the hour being reported
  scheduled: string; actual: string; attendance: string; attTone: CellTone
  kpi: HourlyImageCell[]   // every shown tile, group by group
}
export interface HourlyImageInput {
  accountId: string
  displayName: string
  dateLabel: string        // "Thu, Nov 5"
  tzLabel: string          // "ET"
  modeLabel: string        // "End of hour"
  groups: { id: string; name: string; tiles: { key: string; label: string }[] }[]
  rows: HourlyImageRow[]
  total: { scheduled: string; actual: string; attendance: string; kpi: string[] }
  footNote: string         // "TOTAL = the day so far (8:00–11:00 ET) · sent 11:02 AM"
  testMode: boolean
}

const H = { title: 48, groupRow: 24, colRow: 32, row: 28, total: 30, footer: 44 }
const CELL_PAD = 24, MIN_W = 560, MAX_IMAGE_PX = 4000
const HC_LABELS = ['Scheduled HC', 'Actual HC', 'Attendance %']
const GROUP_LINE = '1px solid #3a3a3a'
const TONE: Record<CellTone, { color: string; background: string } | null> = {
  ok:   { color: C.success, background: 'rgba(77,202,133,0.12)' },
  warn: { color: C.warning, background: 'rgba(255,209,102,0.13)' },
  bad:  { color: C.danger,  background: 'rgba(255,107,107,0.16)' },
  '':   null,
}
const ATT_COLOR: Record<CellTone, string | null> = { ok: null, warn: C.warning, bad: C.danger, '': null }

interface Layout { interval: number; hc: number[]; tiles: number[]; width: number }

// Each column fitted to its header and its values (12px text, 10px capitals in
// the header), 44–150px of text for a KPI column; a table narrower than MIN_W
// is widened in proportion.
function layout(input: HourlyImageInput): Layout {
  const fit = (label: string, values: string[], min = 0, max = Infinity) =>
    Math.min(max, Math.max(min, headerPx(label), ...values.map(v => textPx(v)))) + CELL_PAD
  const interval = fit('Interval', ['TOTAL', ...input.rows.map(r => r.label)])
  const hc = [
    fit(HC_LABELS[0], [input.total.scheduled, ...input.rows.map(r => r.scheduled)]),
    fit(HC_LABELS[1], [input.total.actual, ...input.rows.map(r => r.actual)]),
    fit(HC_LABELS[2], [input.total.attendance, ...input.rows.map(r => r.attendance)]),
  ]
  const tiles = input.groups.flatMap(g => g.tiles).map((t, i) =>
    fit(t.label, [input.total.kpi[i] ?? '', ...input.rows.map(r => r.kpi[i]?.text ?? '')], 44, 150))
  const natural = interval + hc.reduce((a, b) => a + b, 0) + tiles.reduce((a, b) => a + b, 0)
  const k = natural < MIN_W ? MIN_W / natural : 1
  const r = (n: number) => Math.round(n * k)
  const out = { interval: r(interval), hc: hc.map(r), tiles: tiles.map(r) }
  return { ...out, width: out.interval + out.hc.reduce((a, b) => a + b, 0) + out.tiles.reduce((a, b) => a + b, 0) }
}

const height = (input: HourlyImageInput) => 2 + H.title + H.groupRow + H.colRow + input.rows.length * H.row + H.total + H.footer

// One fixed-width cell, its text on one line ("…" past the width). Satori
// throws on a style value that is `undefined`, so optional ones are spread in.
function Cell({ w, children, align = 'center', line, style }: {
  w: number; children: ReactNode; align?: 'center' | 'flex-start'; line?: boolean; style?: Record<string, string | number>
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: align, width: w, flexShrink: 0, padding: '0 12px',
      ...(line ? { borderLeft: GROUP_LINE } : {}), ...(style ?? {}),
    }}>
      <div style={{ display: 'block', ...oneLine }}>{children}</div>
    </div>
  )
}

function Table({ input, L }: { input: HourlyImageInput; L: Layout }) {
  const { groups, rows, total } = input
  // Which tile columns start a group — they get the group's dividing line.
  const starts = new Set<number>()
  let at = 0
  for (const g of groups) { starts.add(at); at += g.tiles.length }
  const tileLabels = groups.flatMap(g => g.tiles.map(t => t.label))
  const hcW = L.hc.reduce((a, b) => a + b, 0)

  return (
    // The card's 1px border is outside the columns (+2), like the 2 in height().
    <div style={{
      display: 'flex', flexDirection: 'column', width: L.width + 2, background: C.card,
      border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: 'Poppins',
    }}>
      {/* Title — like the Overview card's header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: H.title, padding: '0 16px',
        background: 'linear-gradient(135deg, #1e1e1e 0%, #141414 100%)', borderBottom: `1px solid ${C.border}`,
        borderTopLeftRadius: 7, borderTopRightRadius: 7,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flexShrink: 1 }}>
          <Icon name="buildings" size={17} color={C.primary} />
          <div style={{ display: 'block', marginLeft: 8, fontSize: 14, fontWeight: 700, color: '#ffffff', letterSpacing: 0.3, ...oneLine }}>
            {`Hourly Report — ${input.displayName}`}
          </div>
          {input.displayName !== input.accountId && (
            <div style={{ display: 'block', marginLeft: 6, fontSize: 10, color: C.muted, ...oneLine }}>{`(${input.accountId})`}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: 12 }}>
          {input.testMode && (
            <div style={{
              display: 'flex', marginRight: 10, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
              color: C.warning, background: 'rgba(255,209,102,0.15)', border: '1px solid rgba(255,209,102,0.35)',
            }}>TEST</div>
          )}
          <div style={{ display: 'flex', fontSize: 11, color: C.muted }}>{`${input.dateLabel} · ${input.tzLabel} · KPI: ${input.modeLabel}`}</div>
        </div>
      </div>

      {/* Group row — HEAD COUNT (ZOHO), then each KPI group over its tiles */}
      <div style={{
        display: 'flex', height: H.groupRow, background: 'rgba(255,255,255,0.03)', borderBottom: `1px solid ${C.border}`,
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: C.muted,
      }}>
        <Cell w={L.interval}>{''}</Cell>
        <Cell w={hcW} line>Head count (Zoho)</Cell>
        {groups.map((g, gi) => {
          const first = groups.slice(0, gi).reduce((n, x) => n + x.tiles.length, 0)
          const w = L.tiles.slice(first, first + g.tiles.length).reduce((a, b) => a + b, 0)
          return <Cell key={g.id} w={w} line>{g.name}</Cell>
        })}
      </div>

      {/* Column row */}
      <div style={{
        display: 'flex', height: H.colRow, background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${C.border}`,
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: C.head,
      }}>
        <Cell w={L.interval} align="flex-start">Interval</Cell>
        {HC_LABELS.map((l, i) => <Cell key={l} w={L.hc[i]} line={i === 0}>{l}</Cell>)}
        {tileLabels.map((l, i) => <Cell key={i} w={L.tiles[i]} line={starts.has(i)}>{l}</Cell>)}
      </div>

      {/* The hours */}
      {rows.map((r, ri) => {
        const att = ATT_COLOR[r.attTone]
        return (
          <div key={ri} style={{
            display: 'flex', height: H.row, fontSize: 12, color: C.cell,
            borderBottom: ri < rows.length - 1 ? `1px solid ${C.border}` : 'none',
            ...(r.highlight ? { background: 'rgba(217,122,53,0.10)' } : {}),
          }}>
            <Cell w={L.interval} align="flex-start" style={{ fontWeight: 600, ...(r.highlight ? { color: C.primary } : {}) }}>{r.label}</Cell>
            <Cell w={L.hc[0]} line>{r.scheduled}</Cell>
            <Cell w={L.hc[1]}>{r.actual}</Cell>
            <Cell w={L.hc[2]} style={att ? { color: att, fontWeight: 700 } : {}}>{r.attendance}</Cell>
            {r.kpi.map((c, i) => {
              const t = TONE[c.tone]
              return <Cell key={i} w={L.tiles[i]} line={starts.has(i)} style={t ? { ...t, fontWeight: c.tone === 'bad' ? 700 : 600 } : {}}>{c.text}</Cell>
            })}
          </div>
        )
      })}

      {/* TOTAL — the day so far */}
      <div style={{
        display: 'flex', height: H.total, fontSize: 12, fontWeight: 700, color: C.text,
        background: 'rgba(255,255,255,0.05)', borderTop: GROUP_LINE,
      }}>
        <Cell w={L.interval} align="flex-start">TOTAL</Cell>
        <Cell w={L.hc[0]} line>{total.scheduled}</Cell>
        <Cell w={L.hc[1]}>{total.actual}</Cell>
        <Cell w={L.hc[2]}>{total.attendance}</Cell>
        {total.kpi.map((t, i) => <Cell key={i} w={L.tiles[i]} line={starts.has(i)}>{t}</Cell>)}
      </div>

      {/* Footer — up to two lines, so the note fits even the narrowest table */}
      <div style={{
        display: 'flex', alignItems: 'center', height: H.footer, padding: '0 14px', fontSize: 11, lineHeight: 1.35, color: C.muted,
        borderTop: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.01)', borderBottomLeftRadius: 7, borderBottomRightRadius: 7,
      }}>
        <Icon name="clock" size={12} color={C.muted} />
        <div style={{ display: 'block', marginLeft: 6, flexShrink: 1, minWidth: 0, maxHeight: 30, overflow: 'hidden' }}>{input.footNote}</div>
      </div>
    </div>
  )
}

// A picture that fails (an emoji whose image couldn't be fetched) is drawn once
// more with every emoji taken out — same as the alert card.
function withoutEmoji(input: HourlyImageInput): HourlyImageInput {
  return {
    ...input,
    displayName: noEmoji(input.displayName),
    groups: input.groups.map(g => ({ ...g, name: noEmoji(g.name), tiles: g.tiles.map(t => ({ ...t, label: noEmoji(t.label) })) })),
    rows: input.rows.map(r => ({ ...r, kpi: r.kpi.map(c => ({ ...c, text: noEmoji(c.text) })) })),
    total: { ...input.total, kpi: input.total.kpi.map(noEmoji) },
  }
}

/** The day's hourly table as PNG bytes, in memory only. */
export async function renderHourlyTablePng(input: HourlyImageInput): Promise<Uint8Array> {
  try {
    return await draw(input)
  } catch (e) {
    const plain = withoutEmoji(input)
    if (JSON.stringify(plain) === JSON.stringify(input)) throw e
    return await draw(plain)
  }
}

async function draw(input: HourlyImageInput): Promise<Uint8Array> {
  const L = layout(input)
  const page = { width: L.width + 2 + PAD * 2, height: height(input) + PAD * 2 }
  // 2x like the card, less for a very wide table so the file stays a sensible size.
  const scale = Math.max(1, Math.min(SCALE, MAX_IMAGE_PX / page.width))
  const px = { width: Math.round(page.width * scale), height: Math.round(page.height * scale) }
  const res = new ImageResponse(
    (
      <div style={{ display: 'flex', width: px.width, height: px.height, background: C.page }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', flexShrink: 0, width: page.width, height: page.height, padding: PAD,
          transform: `scale(${scale})`, transformOrigin: 'top left',
        }}>
          <Table input={input} L={L} />
        </div>
      </div>
    ),
    { ...px, fonts: await loadFonts() },
  )
  return new Uint8Array(await res.arrayBuffer())
}
