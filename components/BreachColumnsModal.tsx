'use client'

// The gear on a Breach / Anomalies table's header (Dashboard page AND Overview
// card) opens this: pick which Agent Status columns appear next to each breach.
// Saves DataSourceConfig.breachTableCols for the account, so both tables — and
// everyone watching that account — show the same columns. The choices and the
// values come from lib/breaches.ts (breachColumnChoices / BreachRow.extras).

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export default function BreachColumnsModal({ isDark, accountName, choices, picked, onSave, onClose }: {
  isDark: boolean
  accountName: string
  choices: { key: string; label: string }[]
  picked: string[]
  /** Resolves false when the save didn't go through — the modal stays open. */
  onSave: (keys: string[]) => Promise<boolean>
  onClose: () => void
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(picked))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const toggle = (key: string) => setSel(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const save = async () => {
    setSaving(true); setFailed(false)
    // Stored in the Agent Status table's order — the order the tables show them in.
    const ok = await onSave(choices.filter(c => sel.has(c.key)).map(c => c.key))
    setSaving(false)
    if (ok) onClose(); else setFailed(true)
  }

  return createPortal(
    <div className={isDark ? 'dark' : ''}>
      <div className="bcm-backdrop" onMouseDown={() => { if (!saving) onClose() }} />
      <div className="bcm-dialog" role="dialog" aria-modal="true" aria-labelledby="bcm-title">
        <div className="bcm-head">
          <i className="bx bx-cog" aria-hidden />
          <div>
            <div className="bcm-title" id="bcm-title">Breach / Anomalies columns</div>
            <div className="bcm-sub">{accountName}</div>
          </div>
          <button type="button" className="bcm-x" aria-label="Close" onClick={onClose} disabled={saving}>
            <i className="bx bx-x" />
          </button>
        </div>

        <p className="bcm-text">
          Pick the Agent Status columns to show next to each breach — on this account&apos;s
          Dashboard table and on its Overview card. A breaching agent&apos;s row shows that
          agent&apos;s value; a KPI breach shows &quot;—&quot;.
        </p>

        <div className="bcm-list">
          {choices.map(c => (
            <label key={c.key} className="bcm-item">
              <input type="checkbox" checked={sel.has(c.key)} onChange={() => toggle(c.key)}
                aria-label={`Show ${c.label} in Breach / Anomalies`} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>

        <p className="bcm-hint">
          <i className="bx bx-info-circle" aria-hidden /> A column you need isn&apos;t listed? Add it to
          Agent Status first: Settings → Data Sources → Agent Data Source, then the <strong>+</strong> card.
        </p>

        {failed && <div className="bcm-error" role="alert">Couldn&apos;t save — check your connection and try again.</div>}

        <div className="bcm-foot">
          <button type="button" className="bcm-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="bcm-btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
