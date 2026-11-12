// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-inspect-replies', { freshCache: true })
beforeAll(() => useDesignHost({ loadParts: async (id: string): Promise<MeshHandle> => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

/** The tray is built around the origin and lands in the middle of the 256 mm bed as a whole; its coordinates stay around the origin. */
const MID = 0
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
  const shelled = await runCall('geom.shell', { design, open: [{ at: [MID, MID, 8], normal: [0, 0, 1] }], wall_mm: 1 })
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
  // a tray a person put at (40, 50), with no landing move kept: its coordinates are the plate's
  const landed = get().plate[0]!
  const { placed: _landed, ...history } = landed.history!
  const entry = { ...landed, history }
  const transform = [...entry.transform]
  transform[12] = 40
  transform[13] = 50
  const moved = { ...entry, transform }
  // a step open for editing, whole: the object as it was before the view rolled back is kept beside it
  set({ plate: [moved], historyEdit: { objectId: design, index: 0, original: moved } })
  const result = await runCall('geom.measure', { design, a: { at: [40, 50, 8], normal: [0, 0, 1] }, b: { at: [40, 50, 0], normal: [0, 0, -1] } })
  expect(result).toMatchObject({ output: { measurement: { distanceMm: 8 } } })
  expect(JSON.stringify(result)).not.toMatch(/positions|indices/)
  await expect(runCall('geom.shell', { design, wall_mm: 1 })).rejects.toMatchObject({ code: 'busy' })
  await expect(runCall('geom.measure', { design, a: { at: [500, 500, 500] } })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(runCall('geom.info', { design, step: 7 })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate[0]?.history?.steps).toHaveLength(1)
})

it('reads the gaps of a body for print in place, with the plate profile, without changing it', async () => {
  const design = await box()
  const before = get().plate[0]
  const result = (await runCall('geom.fit_check', { design })) as { summary: string; output: { pieces: number; gaps: unknown[]; limits: { side_mm: number; vertical_mm: number; layer_height_mm: number } } }
  expect(result.output).toMatchObject({ pieces: 1, gaps: [], limits: { side_mm: 0.3, vertical_mm: 0.4 } })
  expect(result.summary).toBe('1 piece; no gap under 0.3 mm side by side or 0.4 mm above or below')
  expect(JSON.stringify(result)).not.toMatch(/positions|indices/)
  expect(get().plate[0]).toBe(before)
  await expect(runCall('geom.fit_check', { design, part: [3] })).rejects.toMatchObject({ code: 'invalid_input' })
})

it('holds print-in-place gaps to the plate layer height and filament, in geom.fit_check and design.check', async () => {
  const design = await box()
  set({ overrides: { layer_height: 0.28 }, slotSetup: { 1: { type: 'PETG', brand: '', color: '#50fa7b' } } })
  try {
    const fit = (await runCall('geom.fit_check', { design })) as { output: { limits: Record<string, unknown> } }
    expect(fit.output.limits).toEqual({ side_mm: 0.4, vertical_mm: 0.84, material: 'PETG', nozzle_mm: 0.4, layer_height_mm: 0.28 })
    mimirPlans.put({ planId: 'pip-app', part: 'Tray', units: 'mm', features: [{ name: 'Tray', kind: 'extrude', sizes: { size: 20 } }], assumptions: [], questions: [], printInPlace: ['Lid', 'Tray'] }, design, 'client')
    const check = (await runCall('design.check', { planId: 'pip-app' })) as { output: { items: { name: string; want: string }[] } }
    expect(check.output.items.find((i) => i.name === 'gaps')?.want).toBe('at least 0.4 mm side by side and 0.84 mm above or below between moving pieces (PETG, 0.4 mm nozzle, 0.28 mm layers)')
  } finally {
    set({ overrides: {}, slotSetup: {} })
  }
})

it('refuses an impossible shell without changing the body or its steps', async () => {
  const design = await box()
  const before = get().plate[0]
  await expect(runCall('geom.shell', { design, open: [{ at: [MID, MID, 8], normal: [0, 0, 1] }], wall_mm: 100 })).rejects.toMatchObject({ code: 'refused' })
  expect(get().plate[0]).toBe(before)
  await expect(runCall('geom.info', { design: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
})
