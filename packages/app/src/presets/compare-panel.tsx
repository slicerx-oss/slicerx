// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useState } from 'react'
import { useApp } from '../state/store'
import { comparePresets, type CompareRow } from './compare'
import { formatValue, settingDef } from '../adapters/settings'
import { KIND_LABEL, KINDS } from './presets'
import type { PresetKind } from './store'

/** Settings > Presets > Compare: pick two presets of one kind and read what differs. */
export function ComparePanel() {
  const presets = useApp((s) => s.userPresets)
  const [kind, setKind] = useState<PresetKind>('process')
  const list = presets.filter((p) => p.kind === kind)
  const [aId, setA] = useState('')
  const [bId, setB] = useState('')
  const a = list.find((p) => p.id === aId)
  const b = list.find((p) => p.id === bId)
  const rows: CompareRow[] | null = a && b ? comparePresets(a, b, { label: (k) => settingDef(k)?.label ?? k, format: (k, v) => formatValue(settingDef(k), v) }) : null
  if (presets.length < 2) return null
  return (
    <section className="preset-group" aria-labelledby="presets-compare-h">
      <h4 className="set-sub" id="presets-compare-h">Compare presets</h4>
      <div className="preset-save">
        <label className="sr-only" htmlFor="cmp-kind">Kind</label>
        <select id="cmp-kind" value={kind} onChange={(e) => { setKind(e.target.value as PresetKind); setA(''); setB('') }}>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <label className="sr-only" htmlFor="cmp-a">First preset</label>
        <select id="cmp-a" value={aId} onChange={(e) => setA(e.target.value)}>
          <option value="">First preset</option>
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="cmp-b">Second preset</label>
        <select id="cmp-b" value={bId} onChange={(e) => setB(e.target.value)}>
          <option value="">Second preset</option>
          {list.filter((p) => p.id !== aId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {a && b && rows ? (
        rows.length === 0 ? (
          <p className="sx-small sx-muted" role="status">These two presets have the same settings.</p>
        ) : (
          <table className="sx-small preset-compare">
            <thead>
              <tr><th scope="col">Setting</th><th scope="col">{a.name}</th><th scope="col">{b.name}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}><th scope="row">{r.label}</th><td>{r.a}</td><td>{r.b}</td></tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p className="sx-small sx-muted">{list.length < 2 ? `Save two ${KIND_LABEL[kind].toLowerCase()} presets to compare them.` : 'Pick two presets.'}</p>
      )}
    </section>
  )
}
