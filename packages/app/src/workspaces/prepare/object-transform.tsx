// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Numeric position, rotation, scale and size for the selected object, the way Bambu Studio and
// OrcaSlicer show them under the object list. Fields commit on Enter or blur, and a drag on an axis
// letter moves the object live, so one edit or one drag is one undo step.
import { MoreButton, useMore } from '../../shell/more'
import { setRotateSpace, useRotateSpace, useTool } from '../../plate/tools'
import { Button, ScrubNumber, Seg, VectorField } from '@slicerx/ui'
import { useState } from 'react'
import { centerSelected, dropSelectedToBed, fillBed, instanceCount, mirrorSelected, scaleSelectedToSize, setInstanceCount, setTrs } from '../../plate/edit'
import { plateScrub } from '../../plate/scrub'
import { bounds, decompose, sizeOf, type Vec3 } from '../../plate/transform'
import { useApp } from '../../state/store'

const AXES = ['X', 'Y', 'Z'] as const

const fmt = (n: number | undefined): string => String(Math.round((n ?? 0) * 10) / 10)

export function ObjectTransform() {
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const count = useApp((s) => {
    const e = s.plate.find((p) => p.id === s.selection)
    const root = e ? (e.instanceOf ?? e.id) : null
    return root ? s.plate.filter((p) => (p.instanceOf ?? p.id) === root).length : 0
  })
  const [uniform, setUniform] = useState(true)
  const tool = useTool()
  const space = useRotateSpace()
  const more = useMore('object')
  if (!entry) return null
  const t = decompose(entry.transform)
  const b = bounds(entry.parts, entry.transform)
  const size = b ? sizeOf(b) : ([0, 0, 0] as Vec3)
  const bottom = b ? b.min[2] : 0
  const scrub = (i: number, onAxis: (axis: 0 | 1 | 2, v: number) => void) => plateScrub(entry.id, (v) => onAxis(i as 0 | 1 | 2, v))
  const row = (name: string, unit: string, values: Vec3, onAxis: (axis: 0 | 1 | 2, v: number) => void, opts: { digits?: number; min?: number } = {}) => (
    <VectorField
      className="tf-row"
      id={`tf-${name}`.toLowerCase().replace(/\s+/g, '-')}
      label={name}
      unit={unit}
      values={values}
      onCommit={(i, v) => scrub(i, onAxis).onCommit(v)}
      onPreview={(i, v) => scrub(i, onAxis).onPreview(v)}
      onCancel={(i) => scrub(i, onAxis).onCancel()}
      {...opts}
    />
  )
  return (
    <div className="tf" data-section="transform">
      {!more && tool !== 'rotate' && tool !== 'scale' ? (
        <p className="tf-readout" aria-label="Position">
          X {fmt(t.position[0])} Y {fmt(t.position[1])} Z {fmt(t.position[2])} mm
        </p>
      ) : row('Position', 'mm', t.position, (i, v) => {
        const p = [...t.position] as Vec3
        p[i] = v
        setTrs({ position: p })
      })}
      {more || tool === 'rotate' ? row('Rotation', '°', t.rotation, (i, v) => {
        const r = [...t.rotation] as Vec3
        r[i] = v
        setTrs({ rotation: r })
      }, { digits: 1 }) : null}
      {tool === 'rotate' ? (
        <div className="tf-row" role="group" aria-label="Rotate rings">
          <span className="tf-name">Rings</span>
          <Seg label="Rotate about" size="sm" value={space} onChange={setRotateSpace} options={[{ value: 'world', label: 'Bed axes' }, { value: 'local', label: 'Object axes' }]} />
        </div>
      ) : null}
      {more || tool === 'scale' ? row('Scale', '%', t.scale.map((s) => s * 100) as Vec3, (i, v) => {
        const f = v / 100
        const cur = t.scale[i] ?? 1
        setTrs({ scale: uniform ? (t.scale.map((s) => (s * f) / cur) as Vec3) : (t.scale.map((s, k) => (k === i ? f : s)) as Vec3) })
      }, { digits: 1, min: 0.1 }) : null}
      {more || tool === 'scale' ? row('Size', 'mm', size, (i, v) => void scaleSelectedToSize(i, v, uniform), { min: 0.01 }) : null}
      {more ? <div className="tf-row tf-inst" role="group" aria-label="Instances">
        <span className="tf-name">Instances</span>
        <span className="tf-stepper">
          <Button size="sm" variant="ghost" icon="minus" aria-label="Remove an instance" disabled={count <= 1} onClick={() => setInstanceCount(entry.id, instanceCount(entry.id) - 1)} />
          <ScrubNumber id="tf-instances" ariaLabel="Number of instances" digits={0} min={1} value={count} onCommit={(v) => void setInstanceCount(entry.id, Math.round(v))} />
          <Button size="sm" variant="ghost" icon="plus" aria-label="Add an instance" onClick={() => setInstanceCount(entry.id, instanceCount(entry.id) + 1)} />
        </span>
        <Button size="sm" variant="ghost" icon="grid" onClick={() => void fillBed(entry.id)}>
          Fill bed
        </Button>
      </div> : null}
      <div className="tf-actions">
        {more || tool === 'scale' ? <label className="tf-lock">
          <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} /> Uniform scale
        </label> : null}
        {more ? <>
        <Button size="sm" variant="ghost" icon="arrow-down" onClick={() => dropSelectedToBed()} disabled={Math.abs(bottom) < 0.001}>
          Drop to bed
        </Button>
        <Button size="sm" variant="ghost" icon="fit" onClick={() => centerSelected()}>
          Center
        </Button>
        </> : null}
        {more ? <span className="tf-mirror" role="group" aria-label="Mirror">
          {AXES.map((a, i) => (
            <Button key={a} size="sm" variant="ghost" icon="mirror" onClick={() => mirrorSelected(i as 0 | 1 | 2)} tip={{ title: `Mirror along ${a}`, body: `Flip the object across the ${a} axis.` }}>
              {a}
            </Button>
          ))}
        </span> : null}
        <MoreButton id="object" />
      </div>
    </div>
  )
}
