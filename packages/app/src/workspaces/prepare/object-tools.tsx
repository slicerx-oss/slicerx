// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Geometry tools: auto orient, repair, simplify, hollow and subtract a shape ask for their few
// numbers in a dialog and run on sx-geom in a worker. Cut, shape, text, array and measure work in
// the 3D view; choosing one here opens its panel in the sidebar (cut-panel.tsx and cad/cad-panel.tsx,
// loaded on first use).
import { Button, Menu, MenuAnchor, MenuItem, MenuSeparator } from '@slicerx/ui'
import { Fragment, lazy, Suspense, useEffect, useState } from 'react'
import { editionHasCad, useEdition } from '../../edition'
import { useHost } from '../../host'
import { orientSelected, repairSelected } from '../../plate/geom-ops'
import { isCadTool, set, toast, useApp } from '../../state/store'
import { openTool } from '../design/open-tool'
import { availableTools, type ShelfTool, type ToolId } from '../design/shelf-tools'

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
  const setTool = (t: ToolId | null) => (t ? openTool(t) : set({ objectTool: null }))
  const direct = (fn: () => Promise<unknown>) => {
    setOpen(false)
    void fn().catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
  }
  const pick = (t: ToolId) => {
    setOpen(false)
    setTool(t)
  }
  const tools = availableTools({ modeling, drawing: cad })
  const choose = (t: ShelfTool) => {
    if (t.run === 'orient') return direct(() => orientSelected())
    if (t.run === 'repair') return direct(() => repairSelected(host.slicer))
    if (t.tool) pick(t.tool)
  }
  return (
    <>
      <MenuAnchor>
        <Button size="sm" variant="ghost" icon="magic-wand" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Tools
        </Button>
        <Menu open={open} onClose={() => setOpen(false)} label="Object tools" align="end">
          {tools.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && tools[i - 1]!.menu !== t.menu ? <MenuSeparator /> : null}
              <MenuItem icon={t.icon} {...(t.tip ? { 'data-tip': t.tip } : {})} disabled={t.needsSelection && !hasSel} onClick={() => choose(t)}>
                {t.label}
              </MenuItem>
            </Fragment>
          ))}
        </Menu>
      </MenuAnchor>
      {tool && !isCadTool(tool) && tool !== 'cut' ? <Suspense fallback={null}><ToolDialog tool={tool} onClose={() => setTool(null)} /></Suspense> : null}
    </>
  )
}
