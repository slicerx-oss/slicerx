// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Spread control over the view: with an object of 2 parts or more selected, a slider draws its parts moved apart
// (0 to 100 percent) and four options pick the direction. Display only (plate/explode.ts). It sits last in the view's
// top left column, so showing it moves nothing above it, and its parts keep their size whatever is picked.
import { Range, Seg, type SegOption } from '@slicerx/ui'
import { explodeShown, setExplode, toolpathsDrawn, type ExplodeAxis } from '../plate/explode'
import { useApp } from '../state/store'
import './explode-bar.css'

const AXES: readonly SegOption<ExplodeAxis>[] = [
  { value: 'radial', label: 'Radial', tip: { title: 'Radial', body: 'Parts move out from the middle of the object.' }, testId: 'explode-axis-radial' },
  { value: 'x', label: 'X', tip: { title: 'Along X', body: 'Parts spread left and right, in their order.' }, testId: 'explode-axis-x' },
  { value: 'y', label: 'Y', tip: { title: 'Along Y', body: 'Parts spread front to back, in their order.' }, testId: 'explode-axis-y' },
  { value: 'z', label: 'Z', tip: { title: 'Along Z', body: 'The lowest part stays and the others rise above it.' }, testId: 'explode-axis-z' },
]

/**
 * Shows while the selection has 2 parts or more and the view draws models. Spread is for looking: while an edit tool is
 * on (lay on face, paint, brim, measure, the Model tools) the parts stay where they print, so the controls wait,
 * disabled at the same size, with a line under them saying why; a drag of a model or its handles puts them back too.
 */
export function ExplodeBar() {
  const shown = useApp((s) => explodeShown(s, toolpathsDrawn(s)))
  const spread = useApp((s) => s.explode.spread)
  const axis = useApp((s) => s.explode.axis)
  const held = useApp((s) => s.explodeHeld)
  if (!shown) return null
  return (
    <div className="explode-bar sx-overlay" role="group" aria-label="Exploded view" data-testid="explode-bar" data-held={held || undefined}>
      <label className="explode-label" htmlFor="explode-spread">
        Spread
      </label>
      <Range id="explode-spread" className="explode-range" min={0} max={100} step={1} value={held ? 0 : spread} unit="%" disabled={held} data-testid="explode-spread" onChange={(v) => setExplode({ spread: v })} />
      <output className="explode-value" htmlFor="explode-spread" aria-live="off">
        {held ? 0 : spread}%
      </output>
      <Seg label="Spread direction" size="sm" className="explode-axis" value={axis} onChange={(v) => setExplode({ axis: v })} options={held ? AXES.map((o) => ({ ...o, disabled: true })) : AXES} />
      {held ? (
        <p className="explode-hint" data-testid="explode-hint">
          Editing puts the parts back in place.
        </p>
      ) : null}
    </div>
  )
}
