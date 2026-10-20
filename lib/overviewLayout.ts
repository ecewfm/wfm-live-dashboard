// lib/overviewLayout.ts
// Masonry layout for the Overview page's account cards, split into two steps
// on purpose:
//
//   assignColumns() — WHICH column each card lives in (each card, in account
//                     order, goes to whichever column is shortest at that
//                     point). This is the "shuffle". components/Dashboard.tsx
//                     only runs it when the view itself changes: first render,
//                     the first real data arriving, the page width changing,
//                     the set of visible accounts changing.
//   stackColumns()  — given that assignment, each card's position from the
//                     cards' CURRENT heights. Run whenever any card changes
//                     size (a breach row appears or goes away), so a growing
//                     card pushes the cards BELOW it down, inside its own
//                     column, and no card ever changes column.
//
// Before this split the whole greedy layout re-ran on every data refresh, so
// one card gaining a breach row could change which column was "shortest" for
// every card after it — cards visibly swapping places every few seconds while
// someone was just watching the page.

export const OV_GAP = 20
export const OV_MIN_COL_W = 520

export interface ColumnGeometry { numCols: number; colW: number }
export interface CardPos { top: number; left: number; width: number }

/** How many columns fit in `gridW`, and how wide each one is. */
export function columnGeometry(gridW: number, gap = OV_GAP, minW = OV_MIN_COL_W): ColumnGeometry {
  const numCols = Math.max(1, Math.floor((gridW + gap) / (minW + gap)))
  return { numCols, colW: (gridW + gap) / numCols - gap }
}

/** The shuffle: id → column index, filling the shortest column each time. */
export function assignColumns(ids: string[], heightOf: (id: string) => number, numCols: number, gap = OV_GAP): Record<string, number> {
  const colHeights = Array(Math.max(1, numCols)).fill(0)
  const colOf: Record<string, number> = {}
  for (const id of ids) {
    const c = colHeights.indexOf(Math.min(...colHeights))
    colOf[id] = c
    colHeights[c] += heightOf(id) + gap
  }
  return colOf
}

/**
 * Positions for `ids` with their columns FIXED by `colOf`. Within a column,
 * cards keep account order. A card with no (valid) column yet — it only just
 * appeared — goes to the shortest column as it stands; the returned `colOf`
 * includes it, so it then stays put like the rest.
 */
export function stackColumns(
  ids: string[], heightOf: (id: string) => number, colOf: Record<string, number>,
  geom: ColumnGeometry, gap = OV_GAP,
): { pos: Record<string, CardPos>; height: number; colOf: Record<string, number> } {
  const { numCols, colW } = geom
  const colHeights = Array(Math.max(1, numCols)).fill(0)
  const nextColOf: Record<string, number> = {}
  const pos: Record<string, CardPos> = {}
  for (const id of ids) {
    let c = colOf[id]
    if (!(Number.isInteger(c) && c >= 0 && c < colHeights.length)) c = colHeights.indexOf(Math.min(...colHeights))
    nextColOf[id] = c
    pos[id] = { top: colHeights[c], left: c * (colW + gap), width: colW }
    colHeights[c] += heightOf(id) + gap
  }
  return { pos, height: Math.max(0, Math.max(...colHeights) - gap), colOf: nextColOf }
}
