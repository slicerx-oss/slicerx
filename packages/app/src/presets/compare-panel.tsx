// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { isUnset, type CompareRow } from '@slicerx/settings'
import { Button, Select, Switch, tipAttrs } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast, useApp } from '../state/store'
import { appName } from '../edition'
import { comparePreset, CopyChanged, copyValue, parentFor, parentSide, stockFor, undoCopy, whole, type CompareSide, type CopyRecord } from './compare'
import { KIND_LABEL, KINDS, reportPresetError } from './presets'
import type { PresetKind } from './store'

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
  const [undo, setUndo] = useState<{ rec: CopyRecord; label: string }[]>([])
  // What the last copy did, on the status line in place of the count, until the next action of any kind.
  const [note, setNote] = useState<string | null>(null)
  // The list's height before the first copy, kept as its least height until the next action of another kind: a row (or a
  // whole group) that a copy removes leaves room at the list's end instead of shrinking the dialog body, which would pull
  // its scroll position, and the picks, the bar and the rows with it, when the body is scrolled to its end.
  const listRef = useRef<HTMLDivElement>(null)
  const [hold, setHold] = useState<number | null>(null)
  const [parent, setParent] = useState<{ of: string; side: CompareSide | null; failed?: boolean } | null>(null)
  const a = list.find((p) => p.id === aId)
  const other = withId.startsWith('preset:') ? list.find((p) => p.id === withId.slice('preset:'.length)) : undefined
  const inherits = a?.inherits

  useEffect(() => {
    if (withId !== 'parent' || !a?.inherits) return
    const of = `${a.kind}:${a.inherits}`
    if (parent?.of === of && !parent.failed) return
    let live = true
    void parentFor(a).then(
      (side) => live && setParent({ of, side: side ?? null }),
      (e: unknown) => {
        // A failed read says so; picking Parent again tries once more.
        if (live) setParent({ of, side: null, failed: true })
        reportPresetError(e)
      },
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withId, a])

  // The first preset always stands on its stock settings, which is what applying it gives, whatever it is compared with.
  const base = useMemo(() => (a ? stockFor(a) : null), [a])
  const side: CompareSide | null = useMemo(() => {
    if (!a || !base) return null
    if (withId === 'stock') return { name: 'Stock', config: base }
    if (withId === 'parent') return parent?.side && parent.of === `${a.kind}:${a.inherits}` ? parentSide(a, parent.side) : null
    return other ? { name: other.name, config: whole(other, stockFor(other)) } : null
  }, [a, base, withId, parent, other])
  const result = useMemo(() => (a && base && side ? comparePreset(a, base, side, { all }) : null), [a, base, side, all])

  if (presets.length === 0) return null
  const pickA = (id: string) => {
    setA(id)
    setUndo([])
    setNote(null)
    setHold(null)
    const next = list.find((p) => p.id === id)
    // A choice the new first preset cannot have (itself, or a parent it lacks) goes back to the placeholder.
    if (withId === `preset:${id}` || (withId === 'parent' && !next?.inherits)) setWith('')
  }
  const copy = (r: CompareRow) => {
    if (!a || !base || !side) return
    const name = a.name
    // From a side that does not set it, copyValue drops the preset's own value, so it goes back to its stock settings:
    // the line says it cleared it, never that it copied a value.
    const clears = isUnset(r.b)
    const h = listRef.current?.offsetHeight
    if (h) setHold((cur) => Math.max(cur ?? 0, h))
    void copyValue(a.id, r.key, side.config, base).then((rec) => {
      if (!rec) return
      setUndo((u) => [...u, { rec, label: r.label }])
      setNote(clears ? `Cleared ${r.label} in ${name}` : `Copied ${r.label} to ${name}`)
    }, reportPresetError)
  }
  const undoLast = () => {
    const last = undo[undo.length - 1]
    if (!last) return
    setUndo((u) => u.slice(0, -1))
    setNote(null)
    // Only the copied setting goes back, and only while it still holds the copied value: a later change stays.
    void undoCopy(last.rec).catch((e: unknown) => (e instanceof CopyChanged ? toast(`${last.label} in ${last.rec.name} changed after that copy, so it was not put back.`, 'info') : reportPresetError(e)))
  }
  const parentState = withId === 'parent' && a && parent?.of === `${a.kind}:${a.inherits}` && parent.side === null ? (parent.failed ? 'failed' : 'missing') : null
  const missingParent = parentState !== null
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
          face={KIND_LABEL[kind]}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as PresetKind)
            setA('')
            setWith('')
            setUndo([])
            setNote(null)
            setHold(null)
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
        <Select id="cmp-b" data-testid="preset-compare-with" size="sm" face={withId === 'stock' ? 'Stock settings' : withId === 'parent' && inherits ? `Parent: ${inherits}` : (other?.name ?? 'Compare with')} wrap={{ className: 'cmp-pick', ...(withId === 'parent' && inherits ? tipAttrs({ title: inherits }) : other ? tipAttrs({ title: other.name }) : {}) }} value={withId} disabled={!a} onChange={(e) => {
            setWith(e.target.value)
            setNote(null)
            setHold(null)
          }}>
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
          {/* The count (or what a copy did) and the column header stay at the top while the rows scroll under them. */}
          <div className="cmp-top">
            <div className="cmp-bar">
              {/* One line, always: the rows and the controls beside it never move when its text changes. */}
              <p className="sx-small cmp-status" role="status" {...(note ? tipAttrs({ title: note }) : {})}>
                {note ?? (count === 0 ? 'No settings differ' : `${count} ${count === 1 ? 'setting differs' : 'settings differ'}`)}
              </p>
              <span className="cmp-tools">
                {/* The words are part of the switch: pressing them, or the gap, toggles it. */}
                <label className="cmp-all sx-small">
                  <span>Show all</span>
                  <Switch
                    id="cmp-all"
                    testId="preset-compare-all"
                    checked={all}
                    onChange={(on) => {
                      setAll(on)
                      setNote(null)
                      setHold(null)
                    }}
                  />
                </label>
                <Button size="sm" variant="ghost" icon="undo" data-testid="preset-compare-undo" disabled={undo.length === 0} onClick={undoLast}>
                  Undo
                </Button>
              </span>
            </div>
            {result.groups.length || hold ? (
              <div className="cmp-head sx-small" aria-hidden="true">
                <span className="cmp-head-label">Setting</span>
                <span {...tipAttrs({ title: a.name })}>{a.name}</span>
                <span {...tipAttrs({ title: side.name })}>{side.name}</span>
              </div>
            ) : null}
          </div>
          {result.groups.length || hold ? (
            <div className="cmp-list" ref={listRef} data-all={all ? 'true' : undefined} style={hold ? { minHeight: hold } : undefined}>
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
                            {/* Labels only: the key stays in data-key on the row, for tests and integrators. */}
                            <span className="cmp-label">
                              {r.label}
                              {/* Show all marks the rows that differ: a bar at the row's start, and these words for a screen reader. */}
                              {all && r.differs ? <span className="sr-only">, differs</span> : null}
                            </span>
                            {r.lines ? <small className="cmp-note">{linesText(r.lines, a.name, side.name)}</small> : null}
                          </th>
                          <td>{r.aText}</td>
                          <td>{r.bText}</td>
                          <td className="cmp-act">
                            {r.differs ? (
                              isUnset(r.b) ? (
                                <Button size="sm" variant="ghost" icon="arrow-left" data-testid="preset-compare-copy" aria-label={`Clear ${r.label} in ${a.name}`} tip={{ title: `Clear this setting in ${a.name}` }} data-tip-avoid="tr" onClick={() => copy(r)} />
                              ) : (
                                <Button size="sm" variant="ghost" icon="arrow-left" data-testid="preset-compare-copy" aria-label={`Use the ${side.name} value of ${r.label} in ${a.name}`} tip={{ title: `Use this value in ${a.name}` }} data-tip-avoid="tr" onClick={() => copy(r)} />
                              )
                            ) : null}
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
          {parentState === 'failed'
            ? `Could not read ${a?.inherits ?? 'the parent preset'}. Pick Parent again to try once more.`
            : parentState === 'missing'
            ? `${a?.name ?? ''} was made from ${a?.inherits ?? ''}, which does not ship with ${appName()}, so there is nothing to compare it with.`
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
