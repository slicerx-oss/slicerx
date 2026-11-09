// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Loft and Sweep panels share: the Result choice (New body, Join, Cut) with the body Join and Cut work on, the
// sketch picker the view and the tree hand clicks to, and the start of editing a saved step from either.
import type { PickEvent } from '@slicerx/viewport'
import type { LoftProfile, SketchItem, Step } from '@slicerx/cad-history'
import { useEffect, useMemo, useRef } from 'react'
import { useApp, type PlateEntry } from '../state/store'
import { Choice, Note, useProbe, type ChoiceOption } from './panel-kit'
import { defaultTarget } from './sketches'
import { setSketchPicker } from './sketch-pick'
import { nowOf } from './history/ops'
import { BED_FRAME } from './cad-ops'

export type Result = 'new' | 'join' | 'cut'
export type Target = { objectId: string; partIndex: number }

const RESULTS: readonly ChoiceOption<Result>[] = [
  { value: 'new', label: 'New body', tip: { title: 'New body', body: 'The solid is its own part on the plate.' }, testId: 'solid-result-new' },
  { value: 'join', label: 'Join', tip: { title: 'Join', body: 'The solid merges into the body.' }, testId: 'solid-result-join' },
  { value: 'cut', label: 'Cut', tip: { title: 'Cut', body: 'The solid is taken out of the body.' }, testId: 'solid-result-cut' },
]

/** The live sketches of the timeline, for picks and for matching a saved step back to them. */
export function useLiveSketches(): SketchItem[] {
  const t = useApp((s) => s.timeline)
  return useMemo(() => t.items.slice(0, t.marker).filter((i): i is SketchItem => i.kind === 'sketch'), [t])
}

/**
 * The body Join and Cut work on and what the panel offers: editing a step, the step's own body (and New body only for
 * a step that made one); else the body under the first picked sketch, or the only body. `chosen` is what the person
 * picked; before that, a sketch drawn on the body joins it, as Extrude does.
 */
export function useResult(first: SketchItem | null, chosen: Result | null, edit: { target: Target; operation: Result } | null): { op: Result; target: Target | null; options: ChoiceOption<Result>[]; canInto: boolean } {
  const plate = useApp((s) => s.plate) as readonly PlateEntry[]
  const target = edit ? edit.target : first ? defaultTarget(first, plate) : plate.length === 1 ? { objectId: plate[0]!.id, partIndex: 0 } : null
  const canInto = edit ? edit.operation !== 'new' : target !== null
  const auto: Result = edit ? edit.operation : target && first?.on?.body === target.objectId ? 'join' : 'new'
  const want = chosen ?? auto
  const op: Result = edit ? (edit.operation === 'new' ? 'new' : want === 'new' ? edit.operation : want) : canInto ? want : 'new'
  const options = RESULTS.map((o) => (o.value === 'new' ? (edit && edit.operation !== 'new' ? { ...o, disabled: true } : o) : canInto ? o : { ...o, disabled: true }))
  return { op, target, options, canInto }
}

/** The Result choice and, while Join and Cut are off, why. */
export function ResultChoice({ id, value, onChange, options, canInto, editing }: { id: string; value: Result; onChange: (v: Result) => void; options: readonly ChoiceOption<Result>[]; canInto: boolean; editing: boolean }) {
  return (
    <>
      <Choice id={id} label="Result" value={value} onChange={onChange} options={options} />
      {canInto ? null : <Note testId="solid-result-reason">{editing ? 'This step made its own body, so it stays a new body.' : 'Join and Cut need a body: pick a sketch drawn on one, or keep one body on the plate.'}</Note>}
    </>
  )
}

/**
 * Hands the view's and the tree's sketch clicks to `onSketch` while the panel is open, and the view's other clicks to
 * `onOther`; `marks` says what each picked sketch shows beside it.
 */
export function useSketchPicks(marks: ReadonlyMap<string, string>, onSketch: (id: string) => void, onOther?: (hit: PickEvent) => void): void {
  const latest = useRef({ onSketch, onOther })
  latest.current = { onSketch, onOther }
  useEffect(() => {
    setSketchPicker({ pick: (id) => latest.current.onSketch(id), marks })
  }, [marks])
  useEffect(() => () => setSketchPicker(null), [])
  useProbe((hit) => {
    if (hit.sketch) latest.current.onSketch(hit.sketch)
    else latest.current.onOther?.(hit)
  }, false)
}

/** A saved profile (or path on a plane) moved from where the step ran to where its body stands now. */
export function profileNow<T extends { frame?: LoftProfile['frame'] }>(p: T, step: Pick<Step, 'transform'>, transform: number[]): T {
  return { ...p, frame: nowOf(step, transform).frame(p.frame ?? BED_FRAME) }
}
