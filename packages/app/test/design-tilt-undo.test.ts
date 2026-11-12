// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A lean given through design.edit_step lands in the object's history as an edit of the same steps, the leaning one
// and the one built on it, so one undo takes it back: both lose their lean and the body on the plate stands upright.
// Runs against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { StepParams } from '@slicerx/cad-history'
import { beforeEach, describe, expect, it } from 'vitest'
import { designToolset } from '@slicerx/mcp/toolset'
import { appDesignHost } from '../src/cad/design-host'
import { createHistory } from '../src/plate/history'
import { bounds } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('design-tilt-undo-replies', { freshCache: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const BED = { normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
/** A 40 mm square block, 5 mm tall, on the bed at (128, 128). */
const base: StepParams = { op: 'shape.extrude', frame: { origin: [128, 128, 0], ...BED }, shape: { type: 'rectangle', widthMm: 40, heightMm: 40 }, placement: {}, spec: { distanceMm: 5, operation: 'new' }, name: 'Block' }
/** A post 4 mm across and 20 mm tall on its top, 16 mm right of its middle. */
const post: StepParams = { op: 'shape.extrude', frame: { origin: [128, 128, 5], ...BED }, shape: { type: 'circle', diameterMm: 4 }, placement: { center: [16, 0] }, spec: { distanceMm: 20, operation: 'join' } }
/** A cap 6 mm across and 2 mm tall on the post's top. */
const cap: StepParams = { op: 'shape.extrude', frame: { origin: [128, 128, 25], ...BED }, shape: { type: 'circle', diameterMm: 6 }, placement: { center: [16, 0] }, spec: { distanceMm: 2, operation: 'join' } }

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { widthMm: 256, depthMm: 256, heightMm: 256 } }))

describe('undoing a lean', () => {
  it('takes the step, the cap built on it and the body on the plate back upright', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Stand', [])
    await host.add(d, 0, base)
    await host.add(d, 0, post)
    await host.add(d, 0, cap)
    const entry = () => get().plate.find((p) => p.id === d.id)!
    const right = () => bounds(entry().parts, entry().transform)!.max[0]
    const upright = right()
    const history = createHistory()
    try {
      const edit = designToolset(host).find((t) => t.name === 'design.edit_step')!
      await edit.run({ design: d.id, step: 2, tilt: { toward: 'x', degrees: 20 } } as never, {} as never)
      expect(entry().history?.steps).toHaveLength(3)
      expect(entry().history?.steps[1]?.tilt?.degrees).toBe(20)
      expect(entry().history?.steps[2]?.tilt?.degrees).toBe(20)
      // the block ends 4 mm past the post's foot; the cap's far top edge, 22 mm up at 20 degrees, reaches past it
      expect(right()).toBeCloseTo(upright - 4 + 22 * Math.sin((20 * Math.PI) / 180) + 3 * Math.cos((20 * Math.PI) / 180), 1)
      history.undo()
      expect(entry().history?.steps).toHaveLength(3)
      expect(entry().history?.steps[1]?.tilt).toBeUndefined()
      expect(entry().history?.steps[2]?.tilt).toBeUndefined()
      expect(right()).toBeCloseTo(upright, 3)
      history.redo()
      expect(entry().history?.steps[1]?.tilt?.degrees).toBe(20)
      expect(entry().history?.steps[2]?.tilt?.degrees).toBe(20)
    } finally {
      history.dispose()
    }
  })
})
