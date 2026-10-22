// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The small dialogs of the Tools menu (simplify, hollow, subtract a shape), loaded when one opens. Sizes take
// named values (cad/values.ts); the hollow's wall thickness can follow one.
import { Button, Dialog, Seg } from '@slicerx/ui'
import { useState, type ReactNode } from 'react'
import { bindNext } from '../../cad/history/record'
import { Num, Row } from '../../cad/panel-kit'
import { sizeWords } from '../../cad/op-preview'
import { sentence } from '../../cad/tool-panel'
import { typedNumber } from '../../cad/value-table'
import { useHost } from '../../host'
import { hollowSelected, simplifySelected, subtractFromSelected } from '../../plate/geom-ops'
import { toast } from '../../state/store'

export type DialogTool = 'simplify' | 'hollow' | 'hole'

const num = (s: string) => typedNumber(s)

/** A number row like a tool panel's: the label with its unit once, and a 96 px field at the right edge (spec 2). */
const NumberField = Num

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
      // the engine's words with the field names a person reads, never its keys
      toast(sizeWords(sentence(err instanceof Error ? err.message : String(err))), 'error')
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
          <Row label="Shape" labelId="hole-shape-label">
            <Seg label="Shape" size="sm" value={shape} onChange={setShape} options={[{ value: 'cylinder', label: 'Cylinder' }, { value: 'box', label: 'Box' }]} />
          </Row>
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
