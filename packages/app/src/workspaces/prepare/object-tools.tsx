// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Geometry tools: auto orient, repair, simplify, hollow and subtract a shape ask for their few
// numbers in a dialog and run on sx-geom in a worker. Cut, shape, text, array and measure work in
// the 3D view; choosing one here opens its panel in the sidebar (cut-panel.tsx and cad/cad-panel.tsx,
// loaded on first use).
import { Button, Dialog, Field, Input, Menu, MenuAnchor, MenuItem, MenuSeparator, Seg, Select } from '@slicerx/ui'
import { useState, type ReactNode } from 'react'
import { editionHasCad, useEdition } from '../../edition'
import { useHost } from '../../host'
import { hollowSelected, orientSelected, repairSelected, simplifySelected, subtractFromSelected } from '../../plate/geom-ops'
import { isCadTool, set, toast, useApp, type CadTool } from '../../state/store'

type DialogTool = 'simplify' | 'hollow' | 'hole'
type ToolId = 'cut' | DialogTool

const num = (s: string) => Number(s.replace(',', '.'))

function NumberField({ id, label, unit, value, onChange }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field htmlFor={id} label={label}>
      <Input id={id} mono unit={unit} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

function ToolDialog({ tool, onClose }: { tool: DialogTool; onClose: () => void }) {
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
      go = () => hollowSelected(host.slicer, num(wall))
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

export function ObjectTools() {
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  const [open, setOpen] = useState(false)
  const tool = useApp((s) => s.objectTool)
  const cad = useApp((s) => s.cadTools)
  const modeling = editionHasCad(useEdition())
  const setTool = (t: ToolId | CadTool | null) => set({ objectTool: t })
  const direct = (fn: () => Promise<unknown>) => {
    setOpen(false)
    void fn().catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
  }
  const pick = (t: ToolId | CadTool) => {
    setOpen(false)
    setTool(t)
  }
  return (
    <>
      <MenuAnchor>
        <Button size="sm" variant="ghost" icon="magic-wand" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Tools
        </Button>
        <Menu open={open} onClose={() => setOpen(false)} label="Object tools" align="end">
          <MenuItem icon="cut" disabled={!hasSel} onClick={() => pick('cut')}>Cut</MenuItem>
          <MenuItem icon="orient" disabled={!hasSel} onClick={() => direct(() => orientSelected())}>Auto orient</MenuItem>
          <MenuSeparator />
          <MenuItem icon="measure" onClick={() => pick('measure')}>Measure</MenuItem>
          <MenuItem icon="grid" disabled={!hasSel} onClick={() => pick('array')}>Array</MenuItem>
          {modeling ? (
            <>
              <MenuItem icon="ruler" data-tip="sketch.enter" onClick={() => pick('sketch')}>Sketch</MenuItem>
              <MenuItem icon="import" data-tip="cad.svgFace" onClick={() => pick('facesvg')}>SVG on a face</MenuItem>
              <MenuItem icon="move" data-tip="cad.push" onClick={() => pick('push')}>Push and pull</MenuItem>
              <MenuItem icon="shapes" data-tip="cad.fillet" onClick={() => pick('fillet')}>Fillet and chamfer</MenuItem>
              <MenuItem icon="shapes" onClick={() => pick('holefit')}>Hole for a screw or insert</MenuItem>
            </>
          ) : null}
          {cad ? (
            <>
              <MenuSeparator />
              {modeling ? <MenuItem icon="shapes" onClick={() => pick('shape')}>Shape on a face</MenuItem> : null}
              {modeling ? <MenuItem icon="text" onClick={() => pick('facetext')}>Text on a face</MenuItem> : null}
              <MenuItem icon="hollow" disabled={!hasSel} onClick={() => pick('hole')}>Subtract a shape</MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem icon="hollow" disabled={!hasSel} onClick={() => pick('hollow')}>Hollow</MenuItem>
          <MenuItem icon="settings-reset" disabled={!hasSel} onClick={() => direct(() => repairSelected(host.slicer))}>Repair mesh</MenuItem>
          <MenuItem icon="shapes" disabled={!hasSel} onClick={() => pick('simplify')}>Simplify mesh</MenuItem>
        </Menu>
      </MenuAnchor>
      {tool && !isCadTool(tool) && tool !== 'cut' ? <ToolDialog tool={tool} onClose={() => setTool(null)} /> : null}
    </>
  )
}
