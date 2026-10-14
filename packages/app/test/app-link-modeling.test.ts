// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-modeling-replies', { compressed: true })
beforeAll(() => useDesignHost({ loadParts: async (id: string): Promise<MeshHandle> => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

type Body = { design: string; steps: number; minMm: number[]; sizeMm: number[]; volumeMm3: number; parts: { minMm: number[]; volumeMm3: number }[]; lastStep: { state: string } }
async function output(name: string, args: Record<string, unknown>): Promise<Body> {
  const reply = await runCall(name, args) as { output: Body }
  expect(JSON.stringify(reply)).not.toMatch(/positions|indices/)
  return reply.output
}
async function box(empty = false) {
  const { design } = await output('design.new', { name: 'Modeling block' })
  if (!empty) await output('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 8 })
  return design
}

const cases: { name: string; args: Record<string, unknown>; parts: number; volume?: number }[] = [
  { name: 'cut', args: { plane: { axis: 'z', at: 4 }, keep: 'both' }, parts: 2, volume: 1600 },
  { name: 'split', args: { build_volume_mm: [12, 12, 12], margin_mm: 0 }, parts: 2, volume: 1600 },
  { name: 'mirror', args: { plane: { axis: 'x', at: 20 }, copy: false }, parts: 1, volume: 1600 },
  { name: 'array', args: { spec: { kind: 'linear', count: 3, step: [25, 0, 0] }, merge: false }, parts: 3, volume: 4800 },
  { name: 'repair', args: {}, parts: 1, volume: 1600 },
  { name: 'hollow', args: { wall_mm: 1 }, parts: 1 },
  { name: 'emboss', args: { text: 'X', point: [0, 0, 8], normal: [0, 0, 1], size_mm: 3, depth_mm: 1 }, parts: 1 },
  { name: 'build', args: { solids: [{ type: 'box', min: [-10, -5, 0], max: [10, 5, 8] }] }, parts: 1, volume: 1600 },
  { name: 'subtract', args: { solids: [{ type: 'box', min: [-2, -2, 4], max: [2, 2, 10] }] }, parts: 1, volume: 1536 },
]

it.each(cases)('$name edits a live body and returns its geometry and undoable history', async ({ name, args, parts, volume }) => {
  const design = await box(name === 'build')
  const before = get().plate.find((entry) => entry.id === design)
  const out = await output(`geom.${name}`, { ...args, design })
  expect(out.parts).toHaveLength(parts)
  expect(out.steps).toBe(name === 'build' ? 1 : 2)
  expect(out.lastStep.state).toBe('done')
  if (volume !== undefined) expect(out.volumeMm3).toBeCloseTo(volume, 1)
  if (name === 'hollow') { expect(out.volumeMm3).toBeGreaterThan(0); expect(out.volumeMm3).toBeLessThan(1600) }
  if (name === 'emboss') { expect(out.volumeMm3).toBeGreaterThan(1600); expect(out.sizeMm[2]).toBeCloseTo(9, 3) }
  if (name === 'mirror') expect(out.minMm).toEqual([30, -5, 0])
  expect(get().plate.find((entry) => entry.id === design)?.history?.steps.length).toBe(out.steps)
  await runCall('design.undo', { design })
  if (!before) expect(get().plate).toHaveLength(0)
  else {
    const restored = await runCall('design.list', {}) as { output: { designs: Body[] } }
    expect(restored.output.designs.find((d) => d.design === design)).toMatchObject({ steps: 1, sizeMm: [20, 10, 8], volumeMm3: 1600 })
  }
}, 60_000)

it('places separate array copies and built solids in world coordinates on a moved body', async () => {
  const design = await box()
  const entry = get().plate[0]!
  const transform = [...entry.transform]
  transform[12] = 50
  transform[13] = 50
  set({ plate: [{ ...entry, transform }] })
  const copies = await output('geom.array', { design, spec: { kind: 'linear', count: 3, step: [25, 0, 0] }, merge: false })
  expect(copies).toMatchObject({ minMm: [40, 45, 0], sizeMm: [70, 10, 8], volumeMm3: 4800 })
  const built = await output('geom.build', { design, solids: [{ type: 'box', min: [80, 45, 0], max: [90, 55, 8] }] })
  expect(built.parts.at(-1)).toMatchObject({ minMm: [80, 45, 0], volumeMm3: 800 })
})

it('refuses unsupported options, invalid planes and edits during a live step edit', async () => {
  const design = await box()
  const before = get().plate[0]
  for (const [name, args] of [
    ['cut', { plane: { point: [0, 0, 4], normal: [0, 0, 0] } }],
    ['split', { build_volume_mm: [12, 12, 12], connector: { kind: 'pin' } }],
    ['hollow', { wall_mm: 1, voxel_mm: 1 }],
    ['repair', { close_holes: true }],
  ] as const) await expect(runCall(`geom.${name}`, { design, ...args })).rejects.toBeTruthy()
  expect(get().plate[0]).toBe(before)
  set({ historyEdit: { objectId: design } as never })
  for (const { name, args } of cases) await expect(runCall(`geom.${name}`, { design, ...args })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate[0]).toBe(before)
})
