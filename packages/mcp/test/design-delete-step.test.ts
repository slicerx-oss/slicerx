// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client deletes one feature, then reads the surviving history and solid back independently.
import { expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-delete-step-replies')
type Row = { id: string; index: number; name: string; state: string }

it('deletes a middle feature by id and keeps later features and geometry', async () => {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const call = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, text(r)).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const { design } = await call<{ design: string }>('slicerx_design_new', { name: 'Two holes' })
  await call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, distance_mm: 10 })
  for (const [x, size] of [[-8, 4], [8, 2]]) await call('slicerx_geom_extrude', { design, frame: { origin: [x, 0, 10], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: size, heightMm: size }, distance_mm: 10, operation: 'cut' })
  const before = await call<{ steps: Row[] }>('slicerx_design_steps', { design })
  expect((await h.call('slicerx_design_delete_step', { design, step: before.steps[1]!.name })).isError).toBe(true)
  expect((await call<{ steps: Row[] }>('slicerx_design_steps', { design })).steps).toEqual(before.steps)
  const out = await call<{ removed: { id: string; index: number }; steps: Row[]; volumeMm3: number }>('slicerx_design_delete_step', { design, step: before.steps[1]!.id })
  expect(out.removed).toMatchObject({ id: before.steps[1]!.id, index: 2 })
  expect(out.steps.map((s) => [s.id, s.state])).toEqual([before.steps[0], before.steps[2]].map((s) => [s!.id, 'done']))
  expect(out.volumeMm3).toBeCloseTo(5960, 2)
  expect((await call<{ steps: Row[] }>('slicerx_design_steps', { design })).steps).toEqual(out.steps)
  const info = await call<{ parts: { volumeMm3: number; watertight: boolean }[] }>('slicerx_geom_info', { design })
  expect(info.parts[0]).toMatchObject({ watertight: true })
  expect(info.parts[0]!.volumeMm3).toBeCloseTo(5960, 2)
  const invalid = await h.call('slicerx_design_delete_step', { design, step: 99 })
  expect(invalid.isError).toBe(true)
  expect((await call<{ steps: Row[] }>('slicerx_design_steps', { design })).steps).toEqual(out.steps)
  await h.client.close()
})

it('clears an undone tail and the old STL read-back when the final feature is deleted', async () => {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const created = await h.call('slicerx_design_new', { name: 'Block' })
  const design = data<{ output: { design: string } }>(created).output.design
  for (const size of [10, 4]) {
    const result = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: size, heightMm: size }, distance_mm: 3 })
    expect(result.isError, text(result)).toBeFalsy()
  }
  expect((await h.call('slicerx_design_undo', { design })).isError).toBeFalsy()
  const deleted = await h.call('slicerx_design_delete_step', { design, step: 1 })
  expect(deleted.isError, text(deleted)).toBeFalsy()
  const out = data<{ output: { parts: unknown[]; steps: Row[]; stlPath?: string } }>(deleted).output
  expect(out.parts).toEqual([])
  expect(out.steps).toEqual([])
  expect(out.stlPath).toBeUndefined()
  expect((await h.call('slicerx_design_redo', { design })).isError).toBe(true)
  await h.client.close()
})
