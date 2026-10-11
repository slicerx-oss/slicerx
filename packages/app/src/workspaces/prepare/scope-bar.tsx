// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scope pill at the top of Print settings: the settings edit the plate, or the selected objects (or the part
// picked in the tree), which then print with values of their own.
import { Icon, Seg } from '@slicerx/ui'
import { useEffect, useMemo } from 'react'
import { overrideCount, scopeOf, type SettingsScope } from '../../plate/scope'
import { selectedIds, set, useApp } from '../../state/store'
import './scope.css'

/** The scope Print settings edits now, and its name for the pill. */
export function useScope(): { scope: SettingsScope; name: string } {
  const selection = useApp((s) => s.selection)
  const multi = useApp((s) => s.selectedIds)
  const which = useApp((s) => s.settingsScope)
  const part = useApp((s) => s.scopePart)
  const plate = useApp((s) => s.plate)
  const ids = useMemo(() => selectedIds({ selection, selectedIds: multi }), [selection, multi])
  // A selection that ends puts the next one back on the plate, the default.
  useEffect(() => {
    if (!ids.length && (which !== 'plate' || part)) set({ settingsScope: 'plate', scopePart: null })
  }, [ids.length, which, part])
  return useMemo(() => {
    const scope = which === 'objects' && ids.length ? scopeOf(ids, part) : ({ kind: 'plate' } as const)
    const first = plate.find((p) => p.id === ids[0])
    const name = scope.kind === 'part' ? scope.part : ids.length === 1 ? (first?.name ?? 'Object') : `${ids.length} objects`
    return { scope, name }
  }, [which, ids, part, plate])
}

/**
 * The pill: Plate, or the selection with how many settings it has of its own. One row of the same height whatever is
 * selected, so nothing under it moves as a selection starts or ends: with nothing selected the second option waits,
 * unavailable. What a change reaches is in each option's tip.
 */
export function ScopeBar() {
  const ids = useApp((s) => selectedIds(s).length)
  const { scope, name } = useScope()
  const own = useApp((s) => {
    const sel = selectedIds(s)
    const entry = sel.length === 1 ? s.plate.find((p) => p.id === sel[0]) : undefined
    return entry ? overrideCount(s, entry) : 0
  })
  const objectName = useApp((s) => s.plate.find((p) => p.id === s.selection)?.name ?? '')
  const label = !ids ? (
    <span className="scope-label" data-testid="slice-scope-label">
      <span className="scope-name">Selection</span>
    </span>
  ) : (
    <span className="scope-label" data-testid="slice-scope-label">
      {scope.kind === 'part' ? (
        <>
          <span className="scope-obj">{objectName}</span>
          <Icon name="chevron-right" size={12} />
        </>
      ) : null}
      <span className="scope-name">{scope.kind === 'part' ? scope.part : name}</span>
      {own ? <span className="scope-count sx-mono">{own}</span> : null}
    </span>
  )
  const who = scope.kind === 'part' ? scope.part : ids === 1 ? name : `these ${ids} objects`
  const reach = `Only ${who} ${ids === 1 || scope.kind === 'part' ? 'changes' : 'change'}, over the plate's settings.`
  return (
    <div className="scope-bar">
      <Seg<'plate' | 'objects'>
        label="Settings apply to"
        full
        size="sm"
        className="scope-seg sx-overlay"
        value={scope.kind === 'plate' ? 'plate' : 'objects'}
        onChange={(v) => set({ settingsScope: v })}
        options={[
          { value: 'plate', label: 'Plate', testId: 'slice-scope-plate', tip: { title: 'Plate', body: 'Every object on the plate changes.' } },
          ids
            ? { value: 'objects', label, testId: 'slice-scope-object', tip: { title: name, body: reach } }
            : { value: 'objects', label, testId: 'slice-scope-object', disabled: true, tip: { title: 'Selection', reason: 'Select objects to give them settings of their own.' } },
        ]}
      />
    </div>
  )
}
