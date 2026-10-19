'use client'

// components/AlarmPrompt.tsx
// The "Acknowledge" prompt for the global breach alarm. While it's up, the
// alarm keeps ringing on this screen (see startAlarmLoop in lib/globalAlarm.ts);
// pressing Acknowledge stops it and clears the list.

import { createPortal } from 'react-dom'
import { describeChange, type PendingAlarm } from '@/lib/globalAlarm'

export type AlarmPromptStatus = 'ringing' | 'blocked' | 'quiet' | 'muted'

const STATUS_TEXT: Record<AlarmPromptStatus, string> = {
  ringing: 'Ringing until acknowledged — on this screen only.',
  blocked: 'Your browser is blocking sound on this screen. Click anywhere to let it ring.',
  quiet:   'Just acknowledged — it will start ringing again after the quiet time.',
  muted:   'Sound is muted on this screen (bell in the top bar).',
}

export default function AlarmPrompt({ items, status, isDark, name, onAcknowledge }: {
  items: PendingAlarm[]
  status: AlarmPromptStatus
  isDark: boolean
  name: (accountId: string) => string
  onAcknowledge: () => void
}) {
  const newestFirst = [...items].sort((a, b) => b.lastAt - a.lastAt)
  // Portalled to <body> so it sits above the Settings modal too; the wrapper
  // carries the theme because <body> is outside #layout-wrapper's .dark.
  return createPortal(
    <div className={isDark ? 'dark' : ''}>
      <div className={`alarm-prompt ${status}`} role="alertdialog" aria-labelledby="alarm-prompt-title" aria-describedby="alarm-prompt-sub">
        <div className="alarm-prompt-head">
          <i className="bx bx-alarm" aria-hidden />
          <div>
            <div className="alarm-prompt-title" id="alarm-prompt-title">
              Breach alarm{items.length > 1 ? ` · ${items.length} changes` : ''}
            </div>
            <div className="alarm-prompt-sub" id="alarm-prompt-sub">{STATUS_TEXT[status]}</div>
          </div>
        </div>
        <ul className="alarm-prompt-list">
          {newestFirst.map(p => (
            <li key={p.key}>
              <span className="alarm-prompt-acct">{name(p.accountId)}</span>
              <span className="alarm-prompt-what">{describeChange(p.change)}</span>
              <time>{new Date(p.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </li>
          ))}
        </ul>
        <button type="button" className="alarm-prompt-ack" onClick={onAcknowledge}>
          <i className="bx bx-check" /> Acknowledge
        </button>
      </div>
    </div>,
    document.body,
  )
}
