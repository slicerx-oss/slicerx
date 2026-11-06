// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_project_object_nozzle as a client drives it: on a printer whose nozzles differ in size, print an object
// with another nozzle and read it back through slicerx_project_show; a filament two objects share is refused until
// the call says what to do; with the real engine the slice reads back each object's nozzle size.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { paintedFilaments } from '../src/object-nozzle'
import { connect, data, noSx, sxBin, sxTimeout, text, type Harness } from './helpers'

type Obj = { id: string; name: string; filament?: number; nozzle?: number | null; nozzleMm?: number; nozzleConflict?: string }
type Project = { objects: Obj[]; nozzles?: { nozzle: number; name: string; mm: number }[]; filament_map?: { mode: string; map: number[] }; filaments: { slot: number; type: string; color: string }[] }
type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }

async function call<T = { project: Project }>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError, ...(r.isError ? { summary: text(r) } : {}) } as Res<T>
}
const show = async (h: Harness): Promise<Project> => (await call<Project>(h, 'slicerx_project_show')).output

const H2D = { printer_model: 'Bambu Lab H2D', single_extruder_multi_material: true, master_extruder_id: 2 }
const U1 = { printer_model: 'Snapmaker U1', single_extruder_multi_material: false }

/** Two cubes on a printer set to `machine` with `sizes`, and `filaments` filaments. */
async function project(machine: Record<string, unknown>, sizes: number[], filaments: number, opts: Parameters<typeof connect>[0] = {}): Promise<Harness> {
  const h = await connect(opts)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
  for (let i = 1; i < filaments; i++) await call(h, 'slicerx_project_add_filament', { color: ['#0a2989', '#22cc66', '#eeeeee'][i - 1] })
  const set = await call(h, 'slicerx_project_set_overrides', { changes: { ...machine, nozzle_diameter: sizes } })
  expect(set.ok, set.summary).toBe(true)
  return h
}

describe('the filaments color paint uses', () => {
  it('reads the painted states of each triangle, not its own filament, and stops at a malformed text', () => {
    // "8" is one leaf painted filament 2; "1C" is filament 4 (3 plus the extension digit); "0" is unpainted.
    expect(paintedFilaments({ 0: '8', 1: '1C', 2: '0' })).toEqual([2, 4])
    // A split triangle with leaves on filaments 1 and 2 (child codes are read from the end).
    expect(paintedFilaments({ 0: '0841' })).toEqual([1, 2])
    expect(paintedFilaments({ 0: 'zz' })).toEqual([])
    expect(paintedFilaments(undefined)).toEqual([])
  })
})

describe('slicerx_project_object_nozzle', () => {
  it('on a tool changer moves the object to the filament on that tool, and show reads its nozzle back', async () => {
    const h = await project(U1, [0.4, 0.6, 0.4, 0.4], 2)
    try {
      const before = await show(h)
      expect(before.nozzles?.map((n) => [n.name, n.mm])).toEqual([['Tool 1', 0.4], ['Tool 2', 0.6], ['Tool 3', 0.4], ['Tool 4', 0.4]])
      expect(before.objects.map((o) => [o.id, o.nozzle, o.nozzleMm])).toEqual([['obj-1', 1, 0.4], ['obj-2', 1, 0.4]])
      const r = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 2 })
      expect(r.ok, r.summary).toBe(true)
      expect(r.summary).toBe('cube.stl prints with Tool 2, 0.6 mm (filament 2)')
      const after = await show(h)
      expect(after.objects.map((o) => [o.id, o.filament ?? null, o.nozzle, o.nozzleMm])).toEqual([['obj-1', null, 1, 0.4], ['obj-2', 2, 2, 0.6]])
      // The filament named must be the tool's own; one past the project's filaments is refused.
      const wrong = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 2, filament: 1 })
      expect(wrong.ok).toBe(false)
      expect(wrong.summary).toMatch(/Filament 1 prints on tool 1, not tool 2\. Send filament 2/)
      const missing = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 3 })
      expect(missing.summary).toMatch(/project has 2 filaments/)
      expect((await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 2, new_filament: true })).summary).toMatch(/do not apply/)
    } finally { await h.client.close() }
  })

  it('on a two-extruder printer refuses to split a shared filament until told how, then reads back the map', async () => {
    const h = await project(H2D, [0.4, 0.6], 1)
    try {
      const before = await show(h)
      // No map set: every filament on the master (right) nozzle, sent by hand and read back as seeded.
      expect(before.filament_map).toEqual({ mode: 'seeded', map: [2] })
      expect(before.objects.map((o) => o.nozzleMm)).toEqual([0.6, 0.6])
      const refused = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 1 })
      expect(refused.ok).toBe(false)
      expect(refused.summary).toMatch(/Filament 1 also prints cube\.stl, and one filament prints on one nozzle\. Send new_filament: true .* move_filament: true .* or filament/)
      expect((await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 1, new_filament: true, move_filament: true })).summary).toMatch(/not several/)
      const split = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 1, new_filament: true })
      expect(split.ok, split.summary).toBe(true)
      const after = await show(h)
      expect(after.filaments.length).toBe(2)
      expect(after.filaments[1]?.color).toBe(after.filaments[0]?.color)
      expect(after.filament_map).toEqual({ mode: 'manual', map: [2, 1] })
      expect(after.objects.map((o) => [o.filament ?? null, o.nozzle, o.nozzleMm])).toEqual([[null, 2, 0.6], [2, 1, 0.4]])
      // Moving the filament with every object on it.
      const moved = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-1', nozzle: 1, move_filament: true })
      expect(moved.ok, moved.summary).toBe(true)
      expect((await show(h)).filament_map).toEqual({ mode: 'manual', map: [1, 1] })
    } finally { await h.client.close() }
  })

  it('refuses on a printer whose nozzles are one size', async () => {
    const h = await project(H2D, [0.4, 0.4], 1)
    try {
      const p = await show(h)
      expect(p.nozzles).toBeUndefined()
      expect(p.objects[0]?.nozzle).toBeUndefined()
      const r = await call(h, 'slicerx_project_object_nozzle', { object: 'obj-1', nozzle: 2 })
      expect(r.ok).toBe(false)
      expect(r.summary).toMatch(/one size/)
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('slicerx_slice with nozzles of two sizes', { timeout: sxTimeout }, () => {
  it('reads back each object\'s nozzle size', async () => {
    const h = await project(U1, [0.4, 0.6, 0.4, 0.4], 2, { engine: 'sx', sxBin })
    try {
      await call(h, 'slicerx_project_object_nozzle', { object: 'obj-2', nozzle: 2 })
      const r = await h.call('slicerx_slice', {})
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<{ output: { plates: { featureFilaments?: { name: string; nozzleMm?: number }[] }[] } }>(r).output
      const rows = out.plates.flatMap((p) => p.featureFilaments ?? [])
      expect(rows.map((f) => f.nozzleMm)).toEqual([0.4, 0.6])
    } finally { await h.client.close() }
  })
})
