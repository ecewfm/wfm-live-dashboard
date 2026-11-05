'use client'

// components/ZohoCrmMatchTab.tsx
// Settings → Zoho ↔ CRM (per the user, 2026-11-04): flag an agent whose CRM
// status doesn't mean the same as their Zoho Time Tracker status. Three parts:
// pair each Zoho person with their CRM agent (names differ: "John Cane" in Zoho,
// "John C." in the CRM), tick which CRM values mean the same as each Zoho status
// ("Taking a Break" = "15 Minute Break"), and when a mismatch becomes a breach.
// Edits DataSourceConfig.zohoCrmMatch, saved with everything else by Save
// Changes. Usable only while the account has Zoho Breaks & Aux on with its time
// log ("Logged In") — greyed out otherwise. Rules: lib/zohoCrmMatch.ts; the
// every-minute check: lib/zohoAux.ts; the breach: lib/breaches.ts.

import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import type { AgentSource, DataSourceConfig } from '@/lib/types'
import { apiFetch } from '@/lib/authClient'
import { agentSourcesFor, normalizeAgentRow } from '@/lib/breaches'
import { formatSeconds } from '@/lib/utils'
import { normalizeName, zohoStatusCategory, includeLoggedInOf, ZOHO_LOGGED_IN_STATUS } from '@/lib/zohoAuxShared'
import {
  emptyZohoCrmMatch, zohoCrmMatchAvailable, findZohoCrmMismatches, suggestZohoCrmPairs, crmValueOf, statusKey,
  mismatchWarnMins, mismatchCritMins, ZOHO_NOT_LOGGED_IN_STATUS,
  type ZohoCrmMatchConfig, type ZohoCrmPair, type ZohoNow, type ZohoCrmMatchInfo,
} from '@/lib/zohoCrmMatch'

interface Props {
  accountId: string
  ds: DataSourceConfig
  setDs: Dispatch<SetStateAction<DataSourceConfig>>
  /** This account's CRM statuses as Status Durations lists them (live + previously seen). */
  knownCrmStatuses: string[]
  /** Opens Settings → Zoho Integrations, where Zoho Breaks & Aux is switched on. */
  onOpenZohoSettings: () => void
  /** The account's Zoho Account setting as the modal has it (zohoAccountsTextOf), one per line — whose people are paired. */
  zohoAccounts: string
}

const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

/** Distinct by statusKey/normalizeName, first spelling kept, blanks dropped. */
function uniq(values: string[], key: (s: string) => string = statusKey): string[] {
  const m = new Map<string, string>()
  for (const v of values) { const t = String(v ?? '').trim(); const k = key(t); if (k && !m.has(k)) m.set(k, t) }
  return [...m.values()]
}

/** Minutes typed freely (a cleared box doesn't snap back mid-edit); committed while valid. */
function MinutesInput({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null)   // null = not being edited: show the saved value
  return (
    <input type="number" min={0} max={1440} className="sm-input" aria-label={label} value={text ?? String(value)}
      onFocus={() => setText(String(value))}
      onChange={e => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0) onCommit(Math.round(n)) }}
      onBlur={() => setText(null)} />
  )
}

export default function ZohoCrmMatchTab({ accountId, ds, setDs, knownCrmStatuses, onOpenZohoSettings, zohoAccounts }: Props) {
  const available = zohoCrmMatchAvailable(ds)
  const cfg: ZohoCrmMatchConfig = { ...emptyZohoCrmMatch(), ...(ds.zohoCrmMatch ?? {}) }
  // Built from the PREVIOUS config, so quick clicks never undo each other.
  const update = (fn: (c: ZohoCrmMatchConfig) => Partial<ZohoCrmMatchConfig>) => setDs(prev => {
    const c = { ...emptyZohoCrmMatch(), ...(prev.zohoCrmMatch ?? {}) }
    return { ...prev, zohoCrmMatch: { ...c, ...fn(c) } }
  })

  // ── Zoho side: the account's people and their status now (server — the Zoho cache is service-role only) ──
  const [info, setInfo] = useState<ZohoCrmMatchInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  // When `info` arrived — "Zoho now" durations are as of then.
  const [infoAt, setInfoAt] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const extraNames = ds.zohoAux?.extraNames ?? ''
  useEffect(() => {
    if (!available) return
    let cancelled = false
    const q = new URLSearchParams({ account: accountId, zohoAccounts, extraNames })
    apiFetch(`/api/zoho/crm-match?${q}`)
      .then(d => { if (!cancelled) { setInfo(d as ZohoCrmMatchInfo); setInfoAt(Date.now()); setInfoError(null) } })
      .catch(e => { if (!cancelled) setInfoError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [available, accountId, zohoAccounts, extraNames, refresh])

  // ── CRM side: the account's agent tables, minus the Zoho section, normalized like the dashboard's ──
  const [crmAgents, setCrmAgents] = useState<Record<string, any>[] | null>(null)
  const crmSrcKey = JSON.stringify(agentSourcesFor(ds, { includeZohoAux: false }))
  useEffect(() => {
    if (!available) return
    let cancelled = false
    const sources = JSON.parse(crmSrcKey) as AgentSource[]
    ;(async () => {
      const lists = await Promise.all(sources.map(async src => {
        if (!src.table) return []
        try {
          const res = await fetch(`${supaUrl}/rest/v1/${src.table}?select=*&${encodeURIComponent(src.accountCol || 'account_id')}=eq.${encodeURIComponent(accountId)}&limit=5000`,
            { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })
          const rows = res.ok ? await res.json() : []
          return Array.isArray(rows) ? rows.map((r: Record<string, any>) => normalizeAgentRow(r, src)) : []
        } catch { return [] }
      }))
      if (!cancelled) setCrmAgents(lists.flat())
    })()
    return () => { cancelled = true }
  }, [available, accountId, crmSrcKey, refresh])

  const [draftZoho, setDraftZoho] = useState('')
  const [draftCrm, setDraftCrm] = useState('')
  const [draftValue, setDraftValue] = useState('')
  const [addedValues, setAddedValues] = useState<string[]>([])
  const [showAllTypes, setShowAllTypes] = useState(false)

  const zohoNow: ZohoNow = useMemo(() => new Map((info?.people ?? []).filter(p => p.status)
    .map(p => [normalizeName(p.name), { name: p.name, status: p.status! }])), [info])

  // ── Greyed out until Zoho Breaks & Aux is on with its time log ──
  if (!available) {
    const zohoOn = !!ds.zohoAux?.enabled, loggedInOn = zohoOn && includeLoggedInOf(ds.zohoAux)
    const kept = ds.zohoCrmMatch?.pairs?.length ?? 0
    return (
      <>
        <p className="sm-desc">
          Flags an agent whose CRM status doesn&apos;t mean the same as their Zoho Time Tracker status — e.g.
          <strong> Management</strong> in the CRM while on a Zoho <strong>15 Minute Break</strong>.
        </p>
        <div className="sm-note" style={{ marginTop: 0, background: 'rgba(217,158,53,0.1)', borderColor: 'rgba(217,158,53,0.35)' }}>
          <i className="bx bx-lock-alt" style={{ color: '#d99e35' }} />
          <div>
            <div style={{ marginBottom: 6 }}>
              To use this, turn these on for <strong>{accountId}</strong> in <strong>Zoho Integrations → Zoho Breaks &amp; Aux</strong>:
            </div>
            <div aria-label="Needed first">
              <div>{zohoOn ? '✓' : '✗'} Show Zoho breaks &amp; aux for this account</div>
              <div>{loggedInOn ? '✓' : '✗'} Include logged in, on no break or aux</div>
            </div>
            {kept > 0 && <div style={{ marginTop: 6 }}>The {kept} name pair{kept === 1 ? '' : 's'} and status matches already set here are kept, but nothing is checked until both are on.</div>}
            <button type="button" className="acc-btn acc-btn-cfg" style={{ marginTop: 10, fontSize: 12, padding: '6px 12px' }} onClick={onOpenZohoSettings}>
              <i className="bx bx-right-arrow-alt" /> Open Zoho Integrations
            </button>
          </div>
        </div>
      </>
    )
  }

  const loading = info === null || crmAgents === null
  const now = infoAt

  // ── Names ──
  const crmByKey = new Map<string, Record<string, any>[]>()
  for (const a of crmAgents ?? []) {
    const k = normalizeName(a._name)
    if (!k) continue
    const list = crmByKey.get(k)
    if (list) list.push(a); else crmByKey.set(k, [a])
  }
  const crmNames = uniq((crmAgents ?? []).map(a => String(a._name ?? '')), normalizeName).sort((a, b) => a.localeCompare(b))
  const zohoNames = uniq((info?.people ?? []).map(p => p.name), normalizeName)
  const zohoByKey = new Map((info?.people ?? []).map(p => [normalizeName(p.name), p]))
  const pairs = [...cfg.pairs].sort((a, b) => a.crm.localeCompare(b.crm))
  const pairedCrm = new Set(cfg.pairs.map(p => normalizeName(p.crm)))
  const pairedZoho = new Set(cfg.pairs.map(p => normalizeName(p.zoho)))
  const unpairedZoho = zohoNames.filter(n => !pairedZoho.has(normalizeName(n)))
  const unpairedCrm = crmNames.filter(n => !pairedCrm.has(normalizeName(n)))
  const suggestions = loading ? [] : suggestZohoCrmPairs(zohoNames, crmNames, cfg.pairs)

  const addPairs = (list: ZohoCrmPair[]) => update(c => {
    const out = [...c.pairs]
    for (const p of list) {
      const zoho = p.zoho.trim(), crm = p.crm.trim()
      if (!zoho || !crm) continue
      const i = out.findIndex(x => normalizeName(x.crm) === normalizeName(crm))
      if (i >= 0) out[i] = { zoho, crm }; else out.push({ zoho, crm })
    }
    return { pairs: out }
  })
  const removePair = (crm: string) => update(c => ({ pairs: c.pairs.filter(p => normalizeName(p.crm) !== normalizeName(crm)) }))
  const addDraftPair = () => {
    if (!draftZoho.trim() || !draftCrm.trim()) return
    addPairs([{ zoho: draftZoho, crm: draftCrm }])
    setDraftZoho(''); setDraftCrm('')
  }

  const zohoNowText = (name: string) => {
    const p = zohoByKey.get(normalizeName(name))
    if (!p?.status) return p ? 'Not logged in' : 'Not in the last 2 days of Zoho logs'
    const secs = p.since ? Math.max(0, Math.round((now - Date.parse(p.since)) / 1000)) : null
    return secs === null ? p.status : `${p.status} · ${formatSeconds(secs)}`
  }
  const crmNowText = (name: string) => {
    const rows = crmByKey.get(normalizeName(name))
    if (!rows?.length) return 'Not on the CRM tables right now'
    return uniq(rows.map(a => crmValueOf(a, cfg))).join(' / ') || '—'
  }

  // ── Statuses ──
  const extraCols = ds.agentExtraCols ?? []
  const fieldGone = !!cfg.crmField && !extraCols.some(c => c.key === cfg.crmField)
  const fieldLabel = cfg.crmField ? (extraCols.find(c => c.key === cfg.crmField)?.label || '(deleted column)') : 'Agent Status'
  const sameAsKey = (c: ZohoCrmMatchConfig, zs: string) => Object.keys(c.sameAs).find(k => statusKey(k) === statusKey(zs)) ?? zs
  const tickedFor = (zs: string) => cfg.sameAs[sameAsKey(cfg, zs)] ?? []
  const isTicked = (zs: string, v: string) => tickedFor(zs).some(x => statusKey(x) === statusKey(v))
  const toggleValue = (zs: string, v: string) => update(c => {
    const key = sameAsKey(c, zs)
    const cur = c.sameAs[key] ?? []
    const on = cur.some(x => statusKey(x) === statusKey(v))
    const next = on ? cur.filter(x => statusKey(x) !== statusKey(v)) : [...cur, v]
    const sameAs = { ...c.sameAs }
    if (next.length) sameAs[key] = next; else delete sameAs[key]
    return { sameAs }
  })
  const valueOptions = uniq([
    ...(crmAgents ?? []).map(a => crmValueOf(a, cfg)),
    ...(cfg.crmField ? [] : knownCrmStatuses),
    ...Object.values(cfg.sameAs).flat(),
    ...addedValues,
  ]).sort((a, b) => a.localeCompare(b))
  const addDraftValue = () => {
    const v = draftValue.trim()
    if (v && !valueOptions.some(x => statusKey(x) === statusKey(v))) setAddedValues(prev => [...prev, v])
    setDraftValue('')
  }

  // Logged In first, Not logged in to Zoho when that's on, then the Zoho types —
  // this account's own (and any already matched, and any a paired agent is in
  // now) unless "show all"; breaks & lunch before other aux.
  const special = new Set([statusKey(ZOHO_LOGGED_IN_STATUS), statusKey(ZOHO_NOT_LOGGED_IN_STATUS)])
  const ownTypes = uniq([
    ...(info?.accountTypes ?? []),
    ...Object.keys(cfg.sameAs),
    ...cfg.pairs.map(p => zohoNow.get(normalizeName(p.zoho))?.status ?? ''),
  ]).filter(t => !special.has(statusKey(t)))
  const allTypes = uniq((info?.zohoTypes ?? []).map(t => t.type)).filter(t => !special.has(statusKey(t)))
  const ownSet = new Set(ownTypes.map(statusKey))
  const moreTypes = allTypes.filter(t => !ownSet.has(statusKey(t)))
  const ORDER = { login: 0, break: 1, aux: 2 } as const
  const typeRows = [...ownTypes, ...(showAllTypes ? moreTypes : [])]
    .map((t, i) => ({ t, i })).sort((a, b) => ORDER[zohoStatusCategory(a.t)] - ORDER[zohoStatusCategory(b.t)] || a.i - b.i).map(x => x.t)
  const zohoRows = [ZOHO_LOGGED_IN_STATUS, ...(cfg.checkNotInZoho ? [ZOHO_NOT_LOGGED_IN_STATUS] : []), ...typeRows]
  const pairedIn = (zs: string) => cfg.pairs.filter(p => {
    if (!crmByKey.has(normalizeName(p.crm))) return false
    const z = zohoNow.get(normalizeName(p.zoho))
    return zs === ZOHO_NOT_LOGGED_IN_STATUS ? !z : statusKey(z?.status) === statusKey(zs)
  }).length

  // ── Right now ──
  const preview = loading ? [] : findZohoCrmMismatches(cfg, crmAgents!, zohoNow)
  const pairedOnCrm = cfg.pairs.filter(p => crmByKey.has(normalizeName(p.crm))).length
  const stored = info?.mismatches ?? []
  const lastChecked = stored.reduce<string | null>((best, r) => (!best || r.checked_at > best ? r.checked_at : best), null)
  const warn = mismatchWarnMins(cfg), crit = mismatchCritMins(cfg)
  const off = !cfg.enabled

  const box: CSSProperties = { marginTop: 8 }
  const cell: CSSProperties = { fontSize: 12 }

  return (
    <>
      <p className="sm-desc">
        Flags an agent whose CRM status doesn&apos;t mean the same as their Zoho Time Tracker status — e.g.
        <strong> Management</strong>{' '}in the CRM while on a Zoho <strong>15 Minute Break</strong>. Names and
        status titles differ between the two, so pair each Zoho person with their CRM agent (<strong>1</strong>),
        then tick which CRM values mean the same as each Zoho status (<strong>2</strong>) — &quot;Taking a Break&quot;
        for &quot;15 Minute Break&quot;. The server checks every minute once this is on and saved; a mismatch
        shows in Breach / Anomalies after it has lasted the Warning minutes.
      </p>

      <table className="sm-table" aria-label="Zoho CRM check settings">
        <tbody>
          <tr>
            <td>
              <div className="sm-metric">Check Zoho against the CRM for {accountId}</div>
              <div className="sm-metric-sub">Off by default — nothing is flagged until names are paired and statuses ticked below</div>
            </td>
            <td style={{ textAlign: 'center', width: 150 }}>
              <input type="checkbox" aria-label="Check Zoho against the CRM" checked={!!cfg.enabled}
                onChange={() => update(c => ({ enabled: !c.enabled }))} />
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.55 : 1 }}>
            <td>
              <div className="sm-metric">Compare with the CRM&apos;s</div>
              <div className="sm-metric-sub">The CRM column that shows breaks and aux — e.g. an availability column, when the status is only Online / Offline</div>
            </td>
            <td>
              <select className="ds-select" aria-label="CRM column to compare" value={cfg.crmField ?? ''}
                onChange={e => update(() => ({ crmField: e.target.value || undefined }))}>
                <option value="">Agent Status</option>
                {extraCols.map(c => <option key={c.key} value={c.key}>{c.label || '(unnamed column)'}</option>)}
                {fieldGone && <option value={cfg.crmField}>(deleted column)</option>}
              </select>
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.55 : 1 }}>
            <td>
              <div className="sm-metric">A mismatch is a breach after</div>
              <div className="sm-metric-sub">
                Zoho is pulled every {info?.pullMinutes ?? 5} min, so a status that just changed can take that long
                to match — keep Warning above that
              </div>
            </td>
            <td>
              <div className="sm-input-cell" style={{ marginBottom: 6 }}>
                <MinutesInput label="Warning after minutes" value={warn} onCommit={n => update(() => ({ warnMins: n }))} />
                <span className="sm-unit">min · Warning</span>
              </div>
              <div className="sm-input-cell">
                <MinutesInput label="Critical after minutes" value={crit} onCommit={n => update(() => ({ critMins: n }))} />
                <span className="sm-unit">min · Critical</span>
              </div>
              {crit < warn && <div className="sm-metric-sub" style={{ color: 'var(--warning)' }}>Critical is before Warning</div>}
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.55 : 1 }}>
            <td>
              <div className="sm-metric">Send mismatches to Cliq</div>
              <div className="sm-metric-sub">
                Off by default: they show in Breach / Anomalies and ring the alarm, but no Cliq message. Like any
                agent breach, they count toward Workforce RTA Logs when this account reports Agent Status.
              </div>
            </td>
            <td style={{ textAlign: 'center' }}>
              <input type="checkbox" aria-label="Send mismatches to Cliq" checked={!!cfg.sendToCliq}
                onChange={() => update(c => ({ sendToCliq: !c.sendToCliq }))} />
            </td>
          </tr>
          <tr style={{ opacity: off ? 0.55 : 1 }}>
            <td>
              <div className="sm-metric">Also flag paired agents not logged in to Zoho</div>
              <div className="sm-metric-sub">
                Off by default. Adds <strong>{ZOHO_NOT_LOGGED_IN_STATUS}</strong>{' '}under 2 — tick the CRM values that
                are fine while someone is out of Zoho (e.g. Offline); any other is a mismatch
              </div>
            </td>
            <td style={{ textAlign: 'center' }}>
              <input type="checkbox" aria-label="Also flag paired agents not logged in to Zoho" checked={!!cfg.checkNotInZoho}
                onChange={() => update(c => ({ checkNotInZoho: !c.checkNotInZoho }))} />
            </td>
          </tr>
        </tbody>
      </table>

      {infoError && (
        <div className="sm-note" role="alert" style={{ background: 'rgba(217,83,79,0.08)', borderColor: 'rgba(217,83,79,0.3)' }}>
          <i className="bx bx-error-circle" style={{ color: '#d9534f' }} />
          <span>Couldn&apos;t load this account&apos;s Zoho people — {infoError}</span>
        </div>
      )}
      {info?.needsMigration && (
        <div className="sm-note" role="alert" style={{ background: 'rgba(217,158,53,0.1)', borderColor: 'rgba(217,158,53,0.35)' }}>
          <i className="bx bx-error" style={{ color: '#d99e35' }} />
          <span>
            One-time setup: run <code>sql/zoho_crm_match.sql</code>{' '}in Supabase (SQL Editor). Until then the server
            can&apos;t store mismatches, so none become breaches — the matching below can still be set up and saved.
          </span>
        </div>
      )}

      {/* ── 1. Names ── */}
      <div className="sm-section-title" style={{ marginTop: 22 }}>1 · MATCH NAMES — {cfg.pairs.length} PAIRED</div>
      <p className="sm-desc" style={{ marginBottom: 8 }}>
        Which Zoho person is which CRM agent. {loading ? 'Loading…' : (
          <>{unpairedZoho.length} of {zohoNames.length} Zoho people and {unpairedCrm.length} of {crmNames.length} CRM agents aren&apos;t paired — an agent who isn&apos;t is never checked.</>
        )}
      </p>

      {suggestions.length > 0 && (
        <div className="sm-note" style={{ marginTop: 0, marginBottom: 10, display: 'block' }} aria-label="Suggested pairs">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span><i className="bx bx-bulb" style={{ marginRight: 4 }} /><strong>{suggestions.length} suggested pair{suggestions.length === 1 ? '' : 's'}</strong> — from names that look alike. Check them before accepting.</span>
            <button type="button" className="acc-btn acc-btn-cfg" onClick={() => addPairs(suggestions)}>Accept all</button>
          </div>
          <div style={{ maxHeight: 170, overflowY: 'auto' }}>
            {suggestions.map(s => (
              <div key={s.crm} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}>
                <span style={{ flex: 1 }}><strong>{s.zoho}</strong> <span style={{ opacity: .6 }}>(Zoho)</span> ↔ <strong>{s.crm}</strong> <span style={{ opacity: .6 }}>(CRM)</span></span>
                <button type="button" className="sm-chip" aria-label={`Accept ${s.zoho} as ${s.crm}`} onClick={() => addPairs([s])}>Accept</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sm-agent-box">
        <table className="sm-table" aria-label="Name pairs">
          <thead>
            <tr><th>Zoho person</th><th>Zoho now</th><th>CRM agent</th><th>CRM {fieldLabel} now</th><th style={{ width: 40 }} /></tr>
          </thead>
          <tbody>
            {pairs.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                No pairs yet — accept a suggestion, or pick a Zoho person and a CRM agent below.
              </td></tr>
            ) : pairs.map(p => (
              <tr key={p.crm}>
                <td><div className="sm-metric" style={{ fontSize: 12.5 }}>{p.zoho}</div></td>
                <td style={cell}>{loading ? '…' : zohoNowText(p.zoho)}</td>
                <td><div className="sm-metric" style={{ fontSize: 12.5 }}>{p.crm}</div></td>
                <td style={cell}>{loading ? '…' : crmNowText(p.crm)}</td>
                <td style={{ textAlign: 'center' }}>
                  <button type="button" aria-label={`Remove the pair for ${p.crm}`} title="Remove this pair" onClick={() => removePair(p.crm)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 17, lineHeight: 1 }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', ...box }}>
        <input type="text" className="sm-input" aria-label="Zoho person to pair" list={`zcm-zoho-${accountId}`} placeholder="Zoho person…"
          style={{ flex: 1, textAlign: 'left' }} value={draftZoho} onChange={e => setDraftZoho(e.target.value)} />
        <datalist id={`zcm-zoho-${accountId}`}>
          {unpairedZoho.map(n => <option key={n} value={n} label={zohoNowText(n)} />)}
        </datalist>
        <span style={{ color: 'var(--text-muted)' }}>↔</span>
        <input type="text" className="sm-input" aria-label="CRM agent to pair" list={`zcm-crm-${accountId}`} placeholder="CRM agent…"
          style={{ flex: 1, textAlign: 'left' }} value={draftCrm} onChange={e => setDraftCrm(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraftPair() } }} />
        <datalist id={`zcm-crm-${accountId}`}>
          {unpairedCrm.map(n => <option key={n} value={n} label={crmNowText(n)} />)}
        </datalist>
        <button type="button" className="acc-btn acc-btn-cfg" aria-label="Add this pair" disabled={!draftZoho.trim() || !draftCrm.trim()}
          style={{ fontSize: 13, padding: '0 14px', alignSelf: 'stretch', opacity: !draftZoho.trim() || !draftCrm.trim() ? 0.45 : 1 }} onClick={addDraftPair}>
          <i className="bx bx-plus" /> Pair
        </button>
      </div>

      {/* ── 2. Statuses ── */}
      <div className="sm-section-title" style={{ marginTop: 22 }}>2 · MATCH STATUSES</div>
      <p className="sm-desc" style={{ marginBottom: 8 }}>
        For each Zoho status, tick the CRM <strong>{fieldLabel}</strong>{' '}values that mean the same. While a paired
        agent is in that Zoho status, any other CRM value is a mismatch. A Zoho status with nothing ticked isn&apos;t checked.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" className="sm-input" aria-label="Add a CRM value" placeholder={`Add a CRM ${fieldLabel} value not listed…`}
          style={{ flex: 1, textAlign: 'left' }} value={draftValue} onChange={e => setDraftValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraftValue() } }} />
        <button type="button" className="acc-btn acc-btn-cfg" disabled={!draftValue.trim()} aria-label="Add this CRM value"
          style={{ fontSize: 13, padding: '0 14px', opacity: draftValue.trim() ? 1 : 0.45 }} onClick={addDraftValue}>
          <i className="bx bx-plus" /> Add
        </button>
      </div>
      <table className="sm-table" aria-label="Status matches">
        <thead><tr><th style={{ width: '32%' }}>Zoho status</th><th>Same as, in the CRM</th></tr></thead>
        <tbody>
          {zohoRows.map(zs => {
            const ticked = tickedFor(zs).length
            const n = pairedIn(zs)
            return (
              <tr key={zs} data-zoho-status={zs}>
                <td>
                  <div className="sm-metric" style={{ fontSize: 12.5 }}>{zs}</div>
                  <div className="sm-metric-sub" style={ticked ? undefined : { color: 'var(--warning)' }}>
                    {ticked ? `${n} paired agent${n === 1 ? '' : 's'} in it now` : 'Not checked — nothing ticked'}
                  </div>
                </td>
                <td>
                  {valueOptions.length === 0 ? (
                    <span className="sm-metric-sub">{loading ? 'Loading…' : `No CRM ${fieldLabel} values found — add one above`}</span>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {valueOptions.map(v => {
                        const on = isTicked(zs, v)
                        return (
                          <button key={v} type="button" className={`sm-chip${on ? ' active' : ''}`} aria-pressed={on}
                            aria-label={`${v} means the same as ${zs}`} onClick={() => toggleValue(zs, v)}>
                            {on && <i className="bx bx-check" style={{ marginRight: 2 }} />}{v}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {moreTypes.length > 0 && (
        <button type="button" className="sm-chip" style={{ marginTop: 8 }} onClick={() => setShowAllTypes(v => !v)}>
          {showAllTypes ? 'Show only this account\'s Zoho types' : `Show all ${allTypes.length} Zoho types (${moreTypes.length} more, from the whole organisation)`}
        </button>
      )}

      {/* ── 3. Right now ── */}
      <div className="sm-section-title" style={{ marginTop: 22 }}>3 · RIGHT NOW</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <p className="sm-desc" style={{ margin: 0, flex: 1 }} role="status">
          {loading ? 'Loading…' : preview.length === 0
            ? <>With the matches above, all {pairedOnCrm} paired agent{pairedOnCrm === 1 ? '' : 's'} on the CRM right now {pairedOnCrm === 1 ? 'is' : 'are'} in sync.</>
            : <>With the matches above, <strong>{preview.length}</strong> of {pairedOnCrm} paired agent{pairedOnCrm === 1 ? '' : 's'} on the CRM {preview.length === 1 ? 'is' : 'are'} out of sync right now — each becomes a breach once it has lasted {warn} min:</>}
        </p>
        <button type="button" className="acc-btn acc-btn-cfg" title="Reload Zoho and the CRM" onClick={() => { setInfo(null); setInfoError(null); setCrmAgents(null); setRefresh(v => v + 1) }}>
          <i className="bx bx-refresh" /> Refresh
        </button>
      </div>
      {preview.length > 0 && (
        <div className="sm-agent-box" style={{ maxHeight: '30vh' }}>
          <table className="sm-table" aria-label="Out of sync right now">
            <thead><tr><th>CRM agent</th><th>CRM {fieldLabel}</th><th>Zoho</th><th>Zoho person</th></tr></thead>
            <tbody>
              {preview.map(m => (
                <tr key={m.crmName}>
                  <td><div className="sm-metric" style={{ fontSize: 12.5 }}>{m.crmName}</div></td>
                  <td style={cell}>{m.crmStatus}</td>
                  <td style={cell}>{m.zohoStatus}</td>
                  <td style={cell}>{m.zohoName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !info?.needsMigration && (
        <p className="sm-desc" style={{ marginTop: 8 }}>
          {!cfg.enabled || !cfg.pairs.length
            ? <>The server starts checking once this is on, has a pair, and is saved.</>
            : lastChecked
              ? <>The server&apos;s last check ({new Date(lastChecked).toLocaleTimeString()}), with the saved settings: {stored.length} out of sync.</>
              : <>The server checks every minute with the <strong>saved</strong> settings (press Save Changes after a change) — it has no one stored as out of sync right now.</>}
        </p>
      )}
    </>
  )
}
