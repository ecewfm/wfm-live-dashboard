'use client'

// components/AuthShell.tsx
// The hero sign-in layout, plus <AssembleCard>: the card that builds itself
// out of a spinning cloud of files on page visit — modelled on the POLA
// Mother's Day intro (see the track-for-track mapping at the top of
// AuthHero.module.css).
//
// Deliberately light. No canvas, no animation library, no per-frame JS — the
// motion is plain CSS keyframes on transform/opacity. JavaScript only:
//   - computes the 42 orbit positions ONCE, at module load (seeded, so every
//     visit is identical),
//   - decides full vs gentle motion,
//   - runs a few timers (boot labels; removing the tiles once they've landed).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import styles from './AuthHero.module.css'

/** For the consumer's form: children of this class rise in one by one. */
export const stackClass = styles.stack
export const cardTitleClass = styles.cardTitle
export const cardSubClass = styles.cardSub

const COLS = 6
const ROWS = 7
const STEPS = ['INIT', 'SYNC', 'VERIFY', 'READY']

/** Timings per mode — must agree with the clocks in AuthHero.module.css. */
const TIMING = {
  // tiles removed after --tiles-out-at (2250) + fade (240)
  full:   { assemblyMs: 2600, stepsAt: [600, 1300, 2150] },
  // gentle: tiles fade out at 1000 + 200
  gentle: { assemblyMs: 1300, stepsAt: [300, 650, 1000] },
} as const

type Motion = 'full' | 'gentle'

/**
 * Full motion unless the OS asks for reduced motion — then a gentle version
 * that still assembles, just without spinning/orbiting.
 *
 * Worth knowing: Windows turns "Animation effects" OFF in Remote Desktop
 * sessions by default, and Chrome reports that as prefers-reduced-motion. So
 * anyone on RDP/VDI gets the gentle version unless they turn animations back
 * on. `?motion=full` in the URL forces the full version (useful to preview it
 * from an RDP session).
 */
function resolveMotion(): { motion: Motion; forced: boolean } {
  try {
    if (new URLSearchParams(window.location.search).get('motion') === 'full') return { motion: 'full', forced: true }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return { motion: 'gentle', forced: false }
  } catch { /* SSR or a locked-down browser — fall through */ }
  return { motion: 'full', forced: false }
}

/** Tiny seeded PRNG — the same cloud every visit, no Math.random churn. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Distance from (x, y) along unit vector (ux, uy) to the edge of a w×h box. */
function distToEdge(x: number, y: number, ux: number, uy: number, w: number, h: number): number {
  const tx = ux > 1e-6 ? (w - x) / ux : ux < -1e-6 ? -x / ux : Infinity
  const ty = uy > 1e-6 ? (h - y) / uy : uy < -1e-6 ? -y / uy : Infinity
  return Math.max(0, Math.min(tx, ty))
}

/**
 * Each file's starting point: just OUTSIDE the browser window, all around.
 *
 * Measured from the card's real position (it sits on the right on desktop,
 * below the hero on mobile), so it's correct at any size:
 *
 *  - Each file is placed just past the window edge in its direction from the
 *    card (+ one tile, + up to 35% extra so they don't all enter at once),
 *    then flies in a STRAIGHT line to its slot — no swirl, no tilt. So every
 *    file is guaranteed off-screen on the first frame, yet none is parked
 *    needlessly far away: they start streaming in immediately.
 *  - Direction: roughly the side its slot is on, with wide jitter, so files
 *    pour in from all over — top, bottom, left across the hero, and right.
 *  - --d: 0 for the centre slot … 1 for corners — the radial stagger, so the
 *    middle of the card forms first and it grows outward (POLA does the same
 *    with each flower's distance from the bouquet's centre).
 *
 * Seeded, so the pattern is identical every visit.
 */
function buildTiles(card: DOMRect, vw: number, vh: number): CSSProperties[] {
  const rand = mulberry32(0x77f3)
  const cx = card.left + card.width / 2
  const cy = card.top + card.height / 2
  const tw = card.width / COLS
  const th = card.height / ROWS
  const tileDiag = Math.hypot(tw, th)

  const out: CSSProperties[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sx = (c + 0.5) * tw - card.width / 2      // slot centre, px from card centre
      const sy = (r + 0.5) * th - card.height / 2
      const d = Math.min(1, Math.hypot(sx / (card.width / 2), sy / (card.height / 2)) / Math.SQRT2)
      const angle = Math.atan2(sy, sx) + (rand() - 0.5) * 1.8
      const edge = distToEdge(cx, cy, Math.cos(angle), Math.sin(angle), vw, vh)
      const dist = (edge + tileDiag) * (1 + rand() * 0.35)
      out.push({
        '--ox': `${Math.round(Math.cos(angle) * dist - sx)}px`,
        '--oy': `${Math.round(Math.sin(angle) * dist - sy)}px`,
        '--d':  (d * 0.85 + rand() * 0.15).toFixed(3),
      } as CSSProperties)
    }
  }
  return out
}

// ── Hero layout ──────────────────────────────────────────────────────────────
export default function AuthShell({ children, intro = true }: {
  children: ReactNode
  /** false = render settled (no entrance), e.g. moving from sign-in to set-password. */
  intro?: boolean
}) {
  const [{ motion, forced }] = useState(resolveMotion)
  const [step, setStep] = useState(intro ? 0 : STEPS.length - 1)

  useEffect(() => {
    if (!intro) { setStep(STEPS.length - 1); return }
    const timers = TIMING[motion].stepsAt.map((ms, i) => setTimeout(() => setStep(i + 1), ms))
    return () => timers.forEach(clearTimeout)
  }, [intro, motion])

  // Hero blocks rise in on staggered delays (--i × 70ms); `cls` adds the block's own style.
  const reveal = (i: number, cls = '') => ({
    className: `${cls} ${styles.reveal}`.trim(),
    style: { '--i': i } as CSSProperties,
  })

  return (
    <div className={[styles.root, intro ? styles.intro : '', forced ? styles.forceMotion : ''].join(' ')}>
      <section className={styles.hero}>
        <div {...reveal(0, styles.heroTop)}>WFM Live <span>// Real-time operations</span></div>

        <ol {...reveal(1, styles.steps)} aria-hidden>
          {STEPS.map((s, i) => (
            <li key={s} className={`${styles.step} ${i === step ? styles.stepActive : i < step ? styles.stepDone : ''}`}>{s}</li>
          ))}
        </ol>

        <div>
          <h1 className={styles.headline}>
            <span {...reveal(2)}>Workforce</span>
            <span {...reveal(3)}>Management</span>
            <span {...reveal(4)}><span className={styles.accent}>Live<i className={styles.liveDot} aria-hidden /></span></span>
          </h1>
          <p {...reveal(5, styles.tagline)}>Real-time service level &amp; adherence monitoring</p>
          <p {...reveal(6, styles.desc)}>
            Live KPIs, agent status and breach alerts across every account — in one console.
            Sign in to continue.
          </p>
        </div>

        <div {...reveal(7, styles.heroFoot)}>
          <span>Authorized access only</span>
          <span>WFM Live · v2</span>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.brandMark}><i className="bx bx-pulse" /></span>
          <span>
            <div className={styles.brandName}>WFM LIVE</div>
            <div className={styles.brandSub}>DASHBOARD</div>
          </span>
        </div>
        {children}
      </section>
    </div>
  )
}

// ── The self-assembling card ─────────────────────────────────────────────────
export function AssembleCard({ children }: { children: ReactNode }) {
  // Always assembles — the CSS picks full or gentle motion. Only the cleanup
  // timer needs to know which, since the gentle version finishes sooner.
  const [{ motion }] = useState(resolveMotion)
  const cardRef = useRef<HTMLDivElement>(null)
  const [tiles, setTiles] = useState<CSSProperties[] | null>(null)
  const [tilesGone, setTilesGone] = useState(false)

  // Measure where the card actually sits, then create the tiles with their
  // off-screen starts. useLayoutEffect runs after the DOM exists but BEFORE
  // the browser paints, and its setState re-renders before that paint too —
  // so the tiles are born already in position and their animations start
  // from the right place. (Rendering them first and patching the positions
  // in afterwards would let them flash at their slots for a frame.)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (el) setTiles(buildTiles(el.getBoundingClientRect(), window.innerWidth, window.innerHeight))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setTilesGone(true), TIMING[motion].assemblyMs)
    return () => clearTimeout(t)
  }, [motion])

  return (
    <div ref={cardRef} className={`${styles.card} ${styles.assembling}`}>
      <div className={styles.surface} aria-hidden><span className={styles.fill} /></div>
      <div className={styles.frame} aria-hidden />
      {tiles && !tilesGone && (
        <div className={styles.tiles} aria-hidden>
          {tiles.map((style, i) => (
            <span key={i} className={styles.tile} style={style}><span className={styles.paper} /></span>
          ))}
        </div>
      )}
      <div className={styles.content}>{children}</div>
    </div>
  )
}
