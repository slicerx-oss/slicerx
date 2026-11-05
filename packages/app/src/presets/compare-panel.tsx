// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CompareRow } from '@slicerx/settings'
import { Button, Select, Switch, tipAttrs } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state/store'
import { appName } from '../edition'
import { comparePreset, copyValue, parentFor, stockFor, undoCopy, whole, type CompareSide } from './compare'
import { KIND_LABEL, KINDS, reportPresetError } from './presets'
import type { PresetKind, UserPreset } from './store'

/** `6 lines only in A1 quiet, 2 only in Stock`: how a G-code setting's two texts differ, line by line. */
function linesText(l: NonNullable<CompareRow['lines']>, a: string, b: string): string {
  const n = (k: number) => `${k} ${k === 1 ? 'line' : 'lines'}`
  const parts = [l.removed ? `${n(l.removed)} only in ${a}` : '', l.added ? `${l.removed ? l.added : n(l.added)} only in ${b}` : ''].filter(Boolean)
  return parts.join(', ') || 'The same lines in another order'
}

/**
 * Settings > Presets > Compare: a saved preset beside another of its kind, the maker preset it was made from, or the
 * stock settings. Lists what differs by settings group (or every setting with Show all); a value of the second side can
 * be copied into the first preset, and Undo puts it back.
 */
export function ComparePanel() {
  const presets = useApp((s) => s.userPresets)
  const [kind, setKind] = useState<PresetKind>('process')
  const list = presets.filter((p) => p.kind === kind)
  const [aId, setA] = useState('')
  const [withId, setWith] = useState('')
  const [all, setAll] = useState(false)
  const [undo, setUndo] = useState<{ before: UserPreset; key: string }[]>([])
  const [parent, setParent] = useState<{ of: string; side: CompareSide | null } | null>(null)
  const a = list.find((p) => p.id === aId)
  const other = withId.startsWith('preset:') ? list.find((p) => p.id === withId.slice('preset:'.length)) : undefined
  const inherits = a?.inherits

  useEffect(() => {
    if (withId !== 'parent' || !a?.inherits) return
    const of = `${a.kind}:${a.inherits}`
    if (parent?.of === of) return
    let live = true
    void parentFor(a).then((side) => live && setParent({ of, side: side ?? null }), reportPresetError)
    return () => {
      live = false
    }
  }, [withId, a, parent])

  const base = useMemo(() => (a ? (withId === 'parent' && parent?.side && parent.of === `${a.kind}:${a.inherits}` ? parent.side.config : stockFor(a)) : null), [a, withId, parent])
  const side: CompareSide | null = useMemo(() => {
    if (!a || !base) return null
    if (withId === 'stock') return { name: 'Stock', config: base }
    if (withId === 'parent') return parent?.side && parent.of === `${a.kind}:${a.inherits}` ? parent.side : null
    return other ? { name: other.name, config: whole(other, stockFor(other)) } : null
  }, [a, base, withId, parent, other])
  const result = useMemo(() => (a && base && side ? comparePreset(a, base, side, { all }) : null), [a, base, side, all])

  if (presets.length === 0) return null
  const pickA = (id: string) => {
    setA(id)
    setUndo([])
    const next = list.find((p) => p.id === id)
    // A choice the new first preset cannot have (itself, or a parent it lacks) goes back to the placeholder.
    if (withId === `preset:${id}` || (withId === 'parent' && !next?.inherits)) setWith('')
  }
  const copy = (r: CompareRow) => {
    if (!a || !base || !side) return
    void copyValue(a.id, r.key, side.config, base).then((before) => before && setUndo((u) => [...u, { before, key: r.key }]), reportPresetError)
  }
  const undoLast = () => {
    const last = undo[undo.length - 1]
    if (!last) return
    setUndo((u) => u.slice(0, -1))
    void undoCopy(last.before, last.key).catch(reportPresetError)
  }
  const missingParent = withId === 'parent' && a && parent?.of === `${a.kind}:${a.inherits}` && parent.side === null
  const count = result?.differ ?? 0
  return (
    <section className="preset-group cmp" aria-labelledby="presets-compare-h">
      <h4 className="set-sub" id="presets-compare-h">
        Compare presets
      </h4>
      <div className="preset-save cmp-picks">
        <label className="sr-only" htmlFor="cmp-kind">
          Kind
        </label>
        <Select
          id="cmp-kind"
          data-testid="preset-compare-kind"
          size="sm"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as PresetKind)
            setA('')
            setWith('')
            setUndo([])
          }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="cmp-a">
          Preset to compare
        </label>
        {/* A long name ellipsizes while closed; the tooltip and the open list show it whole. */}
        <Select id="cmp-a" data-testid="preset-compare-a" size="sm" face={a ? a.name : 'Preset'} wrap={{ className: 'cmp-pick', ...(a ? tipAttrs({ title: a.name }) : {}) }} value={aId} onChange={(e) => pickA(e.target.value)}>
          <option value="">Preset</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="cmp-b">
          Compare with
        </label>
        <Select id="cmp-b" data-testid="preset-compare-with" size="sm" face={withId === 'stock' ? 'Stock settings' : withId === 'parent' && inherits ? `Parent: ${inherits}` : (other?.name ?? 'Compare with')} wrap={{ className: 'cmp-pick', ...(withId === 'parent' && inherits ? tipAttrs({ title: inherits }) : other ? tipAttrs({ title: other.name }) : {}) }} value={withId} disabled={!a} onChange={(e) => setWith(e.target.value)}>
          <option value="">Compare with</option>
          {inherits ? <option value="parent">Parent: {inherits}</option> : null}
          {a ? <option value="stock">Stock settings</option> : null}
          {list
            .filter((p) => p.id !== aId)
            .map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {p.name}
              </option>
            ))}
        </Select>
      </div>
      {result && a && side ? (
        <>
          <div className="cmp-bar">
            <p className="sx-small" role="status">
              {count === 0 ? 'No settings differ' : `${count} ${count === 1 ? 'setting differs' : 'settings differ'}`}
            </p>
            <span className="cmp-tools">
              <label className="sx-small" htmlFor="cmp-all">
                Show all
              </label>
              <Switch id="cmp-all" testId="preset-compare-all" checked={all} onChange={setAll} />
              <Button size="sm" variant="ghost" icon="undo" data-testid="preset-compare-undo" disabled={undo.length === 0} onClick={undoLast}>
                Undo
              </Button>
            </span>
          </div>
          {result.groups.length ? (
            <div className="cmp-list">
              <div className="cmp-head sx-small" aria-hidden="true">
                <span className="cmp-head-label">Setting</span>
                <span {...tipAttrs({ title: a.name })}>{a.name}</span>
                <span {...tipAttrs({ title: side.name })}>{side.name}</span>
              </div>
              {result.groups.map((g) => (
                <section key={g.group} className="cmp-group" data-testid="preset-compare-group" data-group={g.group} aria-label={g.label}>
                  <h5 className="cmp-group-h">{g.label}</h5>
                  <table className="cmp-table sx-small">
                    <thead className="sr-only">
                      <tr>
                        <th scope="col">Setting</th>
                        <th scope="col">{a.name}</th>
                        <th scope="col">{side.name}</th>
                        <th scope="col">Copy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr key={r.key} data-testid="preset-compare-row" data-key={r.key} data-differs={r.differs ? 'true' : undefined}>
                          <th scope="row">
                            {/* The setting's key only in the tooltip's details line, never in the row. */}
                            <span className="cmp-label" {...tipAttrs({ title: r.label, key: r.key })}>
                              {r.label}
                            </span>
                            {r.lines ? <small className="cmp-note">{linesText(r.lines, a.name, side.name)}</small> : null}
                          </th>
                          <td>{r.aText}</td>
                          <td>{r.bText}</td>
                          <td className="cmp-act">
                            {r.differs ? <Button size="sm" variant="ghost" icon="arrow-left" data-testid="preset-compare-copy" aria-label={`Use the ${side.name} value of ${r.label} in ${a.name}`} tip={{ title: `Use this value in ${a.name}` }} onClick={() => copy(r)} /> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="sx-small sx-muted">
          {missingParent
            ? `The preset ${a?.name ?? ''} was made from does not ship with ${appName()}, so it cannot be compared.`
            : list.length === 0
              ? `Save a ${KIND_LABEL[kind].toLowerCase()} preset to compare it.`
              : !a
                ? 'Pick a preset, then what to compare it with.'
                : withId === 'parent' && !missingParent
                  ? 'Reading the parent preset.'
                  : 'Pick what to compare it with: another preset, its parent or the stock settings.'}
        </p>
      )}
    </section>
  )
}
