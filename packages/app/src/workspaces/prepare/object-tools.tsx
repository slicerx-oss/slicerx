// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Geometry tools: auto orient, repair, simplify, hollow and subtract a shape ask for their few
// numbers in a dialog and run on sx-geom in a worker. Cut, shape, text, array and measure work in
// the 3D view; choosing one here opens its panel in the sidebar (cut-panel.tsx and cad/cad-panel.tsx,
// loaded on first use).
import { Button, Menu, MenuAnchor, MenuItem, MenuSeparator } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useState } from 'react'
import { editionHasCad, useEdition } from '../../edition'
import { useHost } from '../../host'
import { orientSelected, repairSelected } from '../../plate/geom-ops'
import { isCadTool, set, toast, useApp, type CadTool } from '../../state/store'

type DialogTool = 'simplify' | 'hollow' | 'hole'
type ToolId = 'cut' | DialogTool

const ToolDialog = lazy(() => import('./tool-dialog').then((m) => ({ default: m.ToolDialog })))

export function ObjectTools() {
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  const [open, setOpen] = useState(false)
  const tool = useApp((s) => s.objectTool)
  const cad = useApp((s) => s.cadTools)
  const modeling = editionHasCad(useEdition())
  // Steps that follow a named value catch up when the values, the built-ins or the plate in view change.
  // The table and what the built-ins read (the printer, its nozzle, the measured fits), by reference.
  const plate = useApp((s) => s.activePlate)
  const table = useApp((s) => s.namedValues)
  const presets = useApp((s) => s.userPresets)
  const profile = useApp((s) => s.profile)
  const printer = useApp((s) => s.printerId)
  useEffect(() => {
    if (!modeling) return
    // Loaded on demand: the history code stays out of the startup bundle.
    void import('../../cad/value-ops').then((m) => m.refreshBound(host.slicer)).then(
      (r) => r.broken.length && toast(`A step could not follow its value: ${r.broken[0]}`, 'warn'),
      (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'),
    )
  }, [plate, table, presets, profile, printer, modeling, host])
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
              <MenuItem icon="svg-face" data-tip="cad.svgFace" onClick={() => pick('facesvg')}>SVG on a face</MenuItem>
              <MenuItem icon="push-pull" data-tip="cad.push" onClick={() => pick('push')}>Push and pull</MenuItem>
              <MenuItem icon="fillet-edge" data-tip="cad.fillet" onClick={() => pick('fillet')}>Fillet and chamfer</MenuItem>
              <MenuItem icon="hole-fit" onClick={() => pick('holefit')}>Hole for a screw or insert</MenuItem>
              <MenuItem icon="thread-bolt" onClick={() => pick('thread')}>Thread</MenuItem>
              <MenuItem icon="shell-open" onClick={() => pick('shell')}>Shell with open faces</MenuItem>
              <MenuItem icon="named-values" onClick={() => pick('values')}>Named values</MenuItem>
            </>
          ) : null}
          {cad ? (
            <>
              <MenuSeparator />
              {modeling ? <MenuItem icon="on-face" onClick={() => pick('shape')}>Shape on a face</MenuItem> : null}
              {modeling ? <MenuItem icon="text" onClick={() => pick('facetext')}>Text on a face</MenuItem> : null}
              <MenuItem icon="subtract-shape" disabled={!hasSel} onClick={() => pick('hole')}>Subtract a shape</MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem icon="hollow" disabled={!hasSel} onClick={() => pick('hollow')}>Hollow</MenuItem>
          <MenuItem icon="settings-reset" disabled={!hasSel} onClick={() => direct(() => repairSelected(host.slicer))}>Repair mesh</MenuItem>
          <MenuItem icon="simplify-mesh" disabled={!hasSel} onClick={() => pick('simplify')}>Simplify mesh</MenuItem>
        </Menu>
      </MenuAnchor>
      {tool && !isCadTool(tool) && tool !== 'cut' ? <Suspense fallback={null}><ToolDialog tool={tool} onClose={() => setTool(null)} /></Suspense> : null}
    </>
  )
}
