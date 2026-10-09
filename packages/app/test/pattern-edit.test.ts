// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step patterned at points has no fields to type, but editing the step again keeps the points: the panel says
// "Points, N copies (edit the points from the sketch)" and the pattern stays unless the person picks another mode.
// Runs against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { CadPanel } from '../src/cad/cad-panel'
import type { History, StepParams } from '../src/cad/history/model'
import { beginEdit, cancelEdit } from '../src/cad/history/ops'
import { patternFromFields, type Pattern } from '../src/cad/pattern'
import { fieldsOf } from '../src/cad/pattern-fields'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('pattern-edit-replies')

// jsdom has no layout; the tool panel scrolls itself into view when it opens.
Element.prototype.scrollIntoView = () => {}

const POINTS: Pattern = { kind: 'points', offsets: [[10, 0], [0, 8]] }
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const slicer = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never

afterEach(() => {
  cancelEdit()
  cleanup()
  set({ plate: [], historyEdit: null, objectTool: null })
})

describe('a points pattern', () => {
  it('reads back from its fields unchanged', () => {
    const f = fieldsOf(POINTS)
    expect(f.kind).toBe('points')
    expect(patternFromFields(f, Number)).toEqual(POINTS)
  })

  it('stays when its step is edited again and saved', async () => {
    const params: StepParams = {
      op: 'shape.extrude',
      frame: { origin: [100, 100, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
      shape: { type: 'circle', diameterMm: 3 },
      placement: { center: [-10, -5], rotationDeg: 0 },
      spec: { distanceMm: 10, operation: 'cut' },
      name: 'Circle',
      pattern: POINTS,
    }
    const history: History = { version: 1, base: [boxMesh(40, 30, 10)], steps: [{ id: 's1', part: 0, transform: T, params }] }
    set({ plate: [{ id: 'o1', name: 'Plate', handle: handle('o1'), parts: [boxMesh(40, 30, 10)] as MeshPart[], colors: ['#888888'], transform: T, history }] })
    await act(() => beginEdit(slicer, 'o1', 0))
    expect(get().objectTool).toBe('shape')
    render(createElement(HostContext.Provider, { value: HOST }, createElement(CadPanel, { tool: 'shape' })))
    await screen.findByText('Points, 3 copies (edit the points from the sketch)')
    // Change the depth only; the points stay.
    fireEvent.change(document.getElementById('cad-dist')!, { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cut' }))
    await waitFor(() => expect(get().historyEdit).toBeNull(), { timeout: 30_000 })
    const step = get().plate.find((p) => p.id === 'o1')!.history!.steps[0]!
    expect(step.params).toMatchObject({ op: 'shape.extrude', spec: { distanceMm: 6 }, pattern: POINTS })
  })
})
