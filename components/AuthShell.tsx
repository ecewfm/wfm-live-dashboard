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

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
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
  // tiles removed after --tiles-out-at (2380) + fade (240)
  full:   { assemblyMs: 2750, stepsAt: [650, 1450, 2300] },
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

/**
 * Each file's starting point in the orbiting cloud.
 *
 * All units are TILES (one grid cell), because CSS translate % is relative to
 * the element itself — so the cloud scales with the card on any screen size.
 * The card spans ±3 tiles across and ±3.5 down from its centre.
 *
 *  - Each file orbits in the direction of its own slot (plus jitter) at
 *    5.5–10 tiles from the centre: a cloud all around the card, reaching well
 *    across the hero on desktop.
 *  - --d is 0 at the centre … 1 at the corners: the radial stagger, so the
 *    middle of the card forms first and it grows outward (POLA does the same
 *    with each flower's distance from the bouquet's centre).
 *  - --r is the tilt each file has before it unfolds flat.
 */
const TILES: CSSProperties[] = (() => {
  const rand = mulberry32(0x77f3)
  const out: CSSProperties[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sx = c + 0.5 - COLS / 2                     // slot offset from centre, tiles
      const sy = r + 0.5 - ROWS / 2
      const d = Math.min(1, Math.hypot(sx / (COLS / 2), sy / (ROWS / 2)) / Math.SQRT2)
      const angle = Math.atan2(sy, sx) + (rand() - 0.5) * 1.1
      const radius = 5.5 + rand() * 4.5
      out.push({
        '--ox': (Math.cos(angle) * radius - sx).toFixed(2),
        '--oy': (Math.sin(angle) * radius - sy).toFixed(2),
        '--r':  `${Math.round((rand() - 0.5) * 70)}deg`,
        '--d':  (d * 0.85 + rand() * 0.15).toFixed(3),
      } as CSSProperties)
    }
  }
  return out
})()

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
  const [tilesGone, setTilesGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setTilesGone(true), TIMING[motion].assemblyMs)
    return () => clearTimeout(t)
  }, [motion])

  return (
    <div className={`${styles.card} ${styles.assembling}`}>
      <div className={styles.surface} aria-hidden><span className={styles.fill} /></div>
      <div className={styles.frame} aria-hidden />
      {!tilesGone && (
        <div className={styles.tiles} aria-hidden>
          {TILES.map((style, i) => (
            <span key={i} className={styles.tile} style={style}><span className={styles.paper} /></span>
          ))}
        </div>
      )}
      <div className={styles.content}>{children}</div>
    </div>
  )
}
