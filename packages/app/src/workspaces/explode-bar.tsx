// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Spread control over the view: with an object of 2 parts or more selected, a slider draws its parts moved apart
// (0 to 100 percent) and four options pick the direction. Display only (plate/explode.ts). It sits last in the view's
// top left column, so showing it moves nothing above it, and its parts keep their size whatever is picked.
import { Range, Seg, type SegOption } from '@slicerx/ui'
import { explodeShown, setExplode, type ExplodeAxis } from '../plate/explode'
import { useApp } from '../state/store'
import './explode-bar.css'

const AXES: readonly SegOption<ExplodeAxis>[] = [
  { value: 'radial', label: 'Radial', tip: { title: 'Radial', body: 'Parts move out from the middle of the object.' }, testId: 'explode-axis-radial' },
  { value: 'x', label: 'X', tip: { title: 'Along X', body: 'Parts spread left and right, in their order.' }, testId: 'explode-axis-x' },
  { value: 'y', label: 'Y', tip: { title: 'Along Y', body: 'Parts spread front to back, in their order.' }, testId: 'explode-axis-y' },
  { value: 'z', label: 'Z', tip: { title: 'Along Z', body: 'The lowest part stays and the others rise above it.' }, testId: 'explode-axis-z' },
]

/** `toolpaths`: the view draws the slice in place of the models, so there is nothing to spread. */
export function ExplodeBar({ toolpaths }: { toolpaths: boolean }) {
  const shown = useApp((s) => explodeShown(s, toolpaths))
  const spread = useApp((s) => s.explode.spread)
  const axis = useApp((s) => s.explode.axis)
  if (!shown) return null
  return (
    <div className="explode-bar sx-overlay" role="group" aria-label="Exploded view" data-testid="explode-bar">
      <label className="explode-label" htmlFor="explode-spread">
        Spread
      </label>
      <Range id="explode-spread" className="explode-range" min={0} max={100} step={1} value={spread} unit="%" data-testid="explode-spread" onChange={(v) => setExplode({ spread: v })} />
      <output className="explode-value" htmlFor="explode-spread" aria-live="off">
        {spread}%
      </output>
      <Seg label="Spread direction" size="sm" className="explode-axis" value={axis} onChange={(v) => setExplode({ axis: v })} options={AXES} />
    </div>
  )
}
