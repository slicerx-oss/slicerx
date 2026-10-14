// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-inspect-replies')
beforeAll(() => useDesignHost({ loadParts: async (id: string): Promise<MeshHandle> => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

async function box() {
  const result = await runCall('design.new', { name: 'Tray' }) as { output: { design: string } }
  const design = result.output.design
  await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 8 })
  return design
}

it('shells a live body and reads current and historical volume without changing its history', async () => {
  const design = await box()
  const solid = await runCall('geom.info', { design }) as { output: { design: string; parts: { watertight: boolean; volumeMm3: number }[] } }
  expect(solid).toMatchObject({ output: { design, parts: [{ watertight: true, volumeMm3: expect.closeTo(1600, 4) }] } })
  const shelled = await runCall('geom.shell', { design, open: [{ at: [0, 0, 8], normal: [0, 0, 1] }], wall_mm: 1 })
  expect(shelled).toMatchObject({ output: { design, steps: 2, sizeMm: [20, 10, 8] } })
  const before = get().plate[0]!
  const current = await runCall('geom.info', { design })
  expect(current).toMatchObject({ output: { parts: [{ watertight: true, volumeMm3: expect.closeTo(592, 4) }] } })
  expect(await runCall('geom.info', { design, step: 1 })).toMatchObject(solid)
  expect(get().plate[0]).toBe(before)
  expect(JSON.stringify([shelled, current])).not.toMatch(/positions|indices/)
  await runCall('design.undo', { design })
  expect(await runCall('geom.info', { design })).toMatchObject(solid)
})

it('measures faces in world coordinates and permits readback while a step is being edited', async () => {
  const design = await box()
  const entry = get().plate[0]!
  const transform = [...entry.transform]
  transform[12] = 40
  transform[13] = 50
  set({ plate: [{ ...entry, transform }], historyEdit: { objectId: design } as never })
  const result = await runCall('geom.measure', { design, a: { at: [40, 50, 8], normal: [0, 0, 1] }, b: { at: [40, 50, 0], normal: [0, 0, -1] } })
  expect(result).toMatchObject({ output: { measurement: { distanceMm: 8 } } })
  expect(JSON.stringify(result)).not.toMatch(/positions|indices/)
  await expect(runCall('geom.shell', { design, wall_mm: 1 })).rejects.toMatchObject({ code: 'busy' })
  await expect(runCall('geom.measure', { design, a: { at: [500, 500, 500] } })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(runCall('geom.info', { design, step: 7 })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate[0]?.history?.steps).toHaveLength(1)
})

it('refuses an impossible shell without changing the body or its steps', async () => {
  const design = await box()
  const before = get().plate[0]
  await expect(runCall('geom.shell', { design, open: [{ at: [0, 0, 8], normal: [0, 0, 1] }], wall_mm: 100 })).rejects.toMatchObject({ code: 'refused' })
  expect(get().plate[0]).toBe(before)
  await expect(runCall('geom.info', { design: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
})
