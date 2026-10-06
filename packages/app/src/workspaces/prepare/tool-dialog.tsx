// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The small dialogs of the Tools menu (simplify, hollow, subtract a shape), loaded when one opens. Sizes take
// named values (cad/values.ts); the hollow's wall thickness can follow one.
import { Button, Dialog, Field, Input, Seg } from '@slicerx/ui'
import { useState, type ReactNode } from 'react'
import { bindNext } from '../../cad/history/record'
import { typedNumber } from '../../cad/value-table'
import { useHost } from '../../host'
import { hollowSelected, simplifySelected, subtractFromSelected } from '../../plate/geom-ops'
import { toast } from '../../state/store'

export type DialogTool = 'simplify' | 'hollow' | 'hole'

const num = (s: string) => typedNumber(s)

function NumberField({ id, label, unit, value, onChange }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field htmlFor={id} label={label}>
      <Input id={id} mono unit={unit} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export function ToolDialog({ tool, onClose }: { tool: DialogTool; onClose: () => void }) {
  const host = useHost()
  const [busy, setBusy] = useState(false)
  const [ratio, setRatio] = useState('50')
  const [wall, setWall] = useState('2')
  const [shape, setShape] = useState<'cylinder' | 'box'>('cylinder')
  const [size, setSize] = useState('5')
  const [depth, setDepth] = useState('5')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const titles: Record<DialogTool, string> = { simplify: 'Simplify the mesh', hollow: 'Hollow', hole: 'Subtract a shape' }
  let body: ReactNode
  let go: () => Promise<unknown>
  switch (tool) {
    case 'simplify':
      body = <NumberField id="simp" label="Keep this share of the triangles" unit="%" value={ratio} onChange={setRatio} />
      go = () => simplifySelected(host.slicer, Math.min(1, Math.max(0.01, num(ratio) / 100)))
      break
    case 'hollow':
      body = <NumberField id="hollow" label="Wall thickness" unit="mm" value={wall} onChange={setWall} />
      go = () => {
        bindNext(wall)
        return hollowSelected(host.slicer, num(wall))
      }
      break
    case 'hole':
      body = (
        <>
          <div className="tool-row">
            <span>Shape</span>
            <Seg label="Shape" size="sm" value={shape} onChange={setShape} options={[{ value: 'cylinder', label: 'Cylinder' }, { value: 'box', label: 'Box' }]} />
          </div>
          <NumberField id="hole-size" label={shape === 'cylinder' ? 'Diameter' : 'Width'} unit="mm" value={size} onChange={setSize} />
          <NumberField id="hole-depth" label="Depth from the top" unit="mm" value={depth} onChange={setDepth} />
          <p className="sx-small sx-muted">Cut into the object from the top, centered.</p>
        </>
      )
      go = () => subtractFromSelected(host.slicer, { shape, sizeMm: num(size), depthMm: num(depth), offset: [0, 0] })
      break
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={titles[tool]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run(go)} disabled={busy}>
            {busy ? 'Working' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="tool-form">{body}</div>
    </Dialog>
  )
}
