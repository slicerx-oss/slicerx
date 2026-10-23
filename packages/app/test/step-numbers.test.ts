// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step has one number wherever it is named: the tree, the timeline, sketch mode's "Editing step N" and the toast
// after a save all count the design's timeline, where a sketch takes a number of its own. Against the geometry engine
// (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { applyExtrude } from '../src/cad/cad-ops'
import { CadPanel } from '../src/cad/cad-panel'
import { HistorySteps } from '../src/cad/history/history-panel'
import { applyShell } from '../src/cad/holes'
import { beginEdit, cancelEdit } from '../src/cad/history/ops'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { startTimeline } from '../src/plate/timeline'
import { compose } from '../src/plate/transform'
import { sketchMode } from '../src/cad/sketch-mode'
import { get, set, type CadTool } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('step-numbers-replies', { compressed: true })

Element.prototype.scrollIntoView = () => {}

type V3 = [number, number, number]
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const slicer = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never
const TOP = { origin: [100, 100, 10] as V3, normal: [0, 0, 1] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3 }
const square = (r: [number, number]) => [{ start: [-r[0], -r[1]] as [number, number], segments: [{ type: 'line' as const, to: [r[0], -r[1]] as [number, number] }, { type: 'line' as const, to: [r[0], r[1]] as [number, number] }, { type: 'line' as const, to: [-r[0], r[1]] as [number, number] }, { type: 'line' as const, to: [-r[0], -r[1]] as [number, number] }] }]
const entry = () => get().plate.find((p) => p.id === 'a')!

let stop: (() => void) | null = null
beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, objectTool: null, toast: null })
  stop = startTimeline()
})

afterEach(() => {
  cancelEdit()
  cleanup()
  stop?.()
  set({ plate: [], historyEdit: null, objectTool: null, toast: null })
})

/** The numbers the tree shows for the object's steps, in order. */
function treeNumbers(): string[] {
  const el = render(createElement(HostContext.Provider, { value: HOST }, createElement(HistorySteps, { objectId: 'a', tree: true }))).container
  return [...el.querySelectorAll('[data-testid="model-tree-step"]')].map((row) => row.querySelector('button')!.textContent!.trim())
}

describe('with a sketch in the timeline', () => {
  it('the tree, the tool and the toast give a step the same number', async () => {
    // a block, a sketched rectangle cut 2 mm into its top (its sketch is item 1, the cut item 2), a 3 mm shell (item 3)
    set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'] })
    await applyExtrude(slicer, { frame: TOP, shape: { type: 'sketch', loops: square([20, 15]) }, placement: {}, spec: { distanceMm: 2, operation: 'cut' }, target: { objectId: 'a', partIndex: 0 }, name: 'Sketch cut' })
    await applyShell(slicer, 'a', 0, { op: 'shell', open: [], wallMm: 3 })
    expect(entry().history!.steps.map((s) => s.broken ?? 'ok')).toEqual(['ok', 'ok'])
    expect(get().timeline.items.map((i) => i.kind)).toEqual(['sketch', 'feature', 'feature'])
    expect(treeNumbers()).toEqual(['2', '3'])
    cleanup()

    // the cut opened from the history: sketch mode's pill names it as the tree does
    await act(() => beginEdit(slicer, 'a', 0))
    render(createElement(HostContext.Provider, { value: HOST }, createElement(CadPanel, { tool: get().objectTool as CadTool })))
    await waitFor(() => expect(sketchMode()?.label).toBe('Editing step 2'), { timeout: 30_000 })
    // cut 5 mm deep, the 5 mm left is too thin for the 3 mm shell
    const input = await waitFor(() => {
      const el = document.getElementById('sk-dist')
      if (!el) throw new Error('no distance field')
      return el
    }, { timeout: 30_000 })
    fireEvent.change(input, { target: { value: '5' } })
    const b = await waitFor(() => {
      const el = screen.getByRole('button', { name: 'Extrude' }) as HTMLButtonElement
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Extrude is off')
      return el
    }, { timeout: 30_000 })
    fireEvent.click(b)
    await waitFor(() => expect(get().historyEdit).toBeNull(), { timeout: 30_000 })
    expect(get().toast).toMatchObject({ tone: 'warn', text: 'Step 2 changed; step 3 is now broken: the wall is too thick for this body; try a thinner one.' })
    cleanup()
    expect(treeNumbers()).toEqual(['2', '3'])
  })

  it('the shell tool says the step it changed as the tree numbers it', async () => {
    set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'] })
    await applyExtrude(slicer, { frame: TOP, shape: { type: 'sketch', loops: square([20, 15]) }, placement: {}, spec: { distanceMm: 2, operation: 'cut' }, target: { objectId: 'a', partIndex: 0 }, name: 'Sketch cut' })
    await applyShell(slicer, 'a', 0, { op: 'shell', open: [], wallMm: 2 })
    await act(() => beginEdit(slicer, 'a', 1))
    render(createElement(HostContext.Provider, { value: HOST }, createElement(CadPanel, { tool: get().objectTool as CadTool })))
    const input = await waitFor(() => {
      const el = document.getElementById('shell-wall')
      if (!el) throw new Error('no wall field')
      return el
    }, { timeout: 30_000 })
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make shell' }))
    await waitFor(() => expect(get().historyEdit).toBeNull(), { timeout: 30_000 })
    expect(get().toast).toMatchObject({ tone: 'ok', text: 'Changed step 3 and ran the steps after it.' })
  })
})
