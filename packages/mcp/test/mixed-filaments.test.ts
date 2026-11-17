// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mixed filaments over MCP, as a client makes them: add one to a plate, read it back, change it, put an object on it,
// slice, and delete it. The slice request carries the plate's mixes and the object's filament.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, type Harness } from './helpers'

type Mix = { id: number; name: string; components: [number, number]; ratio: [number, number]; color: string; colors: [string, string]; cycle: number[] }
type Res<T> = { ok: boolean; summary: string; output: T }

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}

function lastRequest(h: Harness): { plate: { objects: Record<string, unknown>[] }; config: Record<string, unknown> } {
  const dir = join(h.dir, 'out', 'plates')
  const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
  return JSON.parse(readFileSync(join(newest, 'request.json'), 'utf8'))
}

describe('mixed filaments over MCP', () => {
  it('adds, lists, changes, assigns, slices and deletes a mix', async () => {
    const h = await connect()
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_set_filament', { slot: 1, color: '#ff0000' })
    await call(h, 'slicerx_project_add_filament', { color: '#0000ff' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })

    const added = await call<{ mix: Mix; mixes: Mix[] }>(h, 'slicerx_project_add_mixed_filament', { filaments: [1, 2], ratio: [2, 1], name: 'Purple' })
    expect(added.ok, added.summary).toBe(true)
    expect(added.output.mix).toMatchObject({ id: 32, name: 'Purple', components: [1, 2], ratio: [2, 1], colors: ['#ff0000', '#0000ff'] })
    expect(added.output.mixes[0]!.cycle).toEqual([1, 1, 2])

    const changed = await call<{ mixes: Mix[] }>(h, 'slicerx_project_set_mixed_filament', { id: 32, ratio: [1, 1] })
    expect(changed.output.mixes).toEqual([expect.objectContaining({ id: 32, ratio: [1, 1], color: '#bc00bc', cycle: [1, 2] })])
    const listed = await call<{ mixes: Mix[] }>(h, 'slicerx_project_mixed_filaments')
    expect(listed.output.mixes.map((m) => m.id)).toEqual([32])

    const assigned = await call<{ filament: number; filaments: number[] }>(h, 'slicerx_project_set_object_filament', { objectId: 'obj-1', filament: 32 })
    expect(assigned.ok, assigned.summary).toBe(true)
    expect(assigned.output).toMatchObject({ filament: 32, filaments: [32] })
    const shown = await call<{ objects: { id: string; filament?: number }[]; mixed_filaments?: Mix[] }>(h, 'slicerx_project_show')
    expect(shown.output.objects[0]!.filament).toBe(32)
    expect(shown.output.mixed_filaments?.map((m) => m.name)).toEqual(['Purple'])

    const removed = await call<{ moved: number; mixes: Mix[] }>(h, 'slicerx_project_remove_mixed_filament', { id: 32 })
    expect(removed.output).toMatchObject({ moved: 1, mixes: [] })
    const after = await call<{ objects: { filament?: number }[] }>(h, 'slicerx_project_show')
    expect(after.output.objects[0]!.filament).toBe(1)
  })

  it.skipIf(noSx())(
    'slices an object on a mix with the engine, the layers alternating between the two filaments',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_set_filament', { slot: 1, color: '#ff0000' })
      await call(h, 'slicerx_project_add_filament', { color: '#0000ff' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
      await call(h, 'slicerx_project_add_mixed_filament', { filaments: [1, 2], ratio: [1, 1], name: 'Purple' })
      await call(h, 'slicerx_project_set_object_filament', { objectId: 'obj-1', filament: 32 })
      const sliced = await call(h, 'slicerx_slice')
      expect(sliced.ok, sliced.summary).toBe(true)
      const req = lastRequest(h)
      expect(req.config['mixed_filaments']).toEqual(['32:1,2:1,1:Purple'])
      expect(Object.values(req.plate.objects[0]!['slotOverrides'] as Record<string, number>)).toEqual([32])
      // Layer by layer the cube prints filament 1, then 2, then 1: the 1:1 pattern, read from the G-code.
      const dir = join(h.dir, 'out', 'plates')
      const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
      const gcode = readdirSync(newest).find((f) => f.endsWith('.gcode'))
      expect(gcode).toBeDefined()
      const layers: string[][] = []
      let tool = 'T0'
      let feature = ''
      for (const raw of readFileSync(join(newest, gcode!), 'utf8').split('\n')) {
        const l = raw.trim()
        if (l === '; CHANGE_LAYER') layers.push([])
        else if (l.startsWith('; FEATURE: ')) feature = l.slice(11)
        else if (/^T([0-9]|1[0-5])$/.test(l)) tool = l
        else if (layers.length && /^G1 .*[XY].*E[0-9.]+/.test(l) && !/E-/.test(l) && !['Prime tower', 'Custom', ''].includes(feature) && !layers.at(-1)!.includes(tool)) layers.at(-1)!.push(tool)
      }
      const printed = layers.filter((t) => t.length)
      expect(printed.length).toBeGreaterThan(20)
      expect(printed).toEqual(printed.map((_, i) => [i % 2 === 0 ? 'T0' : 'T1']))
    },
    sxTimeout,
  )

  it('caps a project at four mixes and keeps added filaments off their numbers', async () => {
    const h = await connect()
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    // Without a color each takes its number's default, so none is refused as the same as another.
    for (let k = 0; k < 27; k++) expect((await call(h, 'slicerx_project_add_filament', {})).ok).toBe(true)
    const ids: number[] = []
    for (let k = 0; k < 4; k++) {
      const r = await call<{ mix: Mix }>(h, 'slicerx_project_add_mixed_filament', { filaments: [1, 2], ratio: [k + 1, 1] })
      expect(r.ok, r.summary).toBe(true)
      ids.push(r.output.mix.id)
    }
    expect(ids).toEqual([32, 31, 30, 29])
    const fifth = await call(h, 'slicerx_project_add_mixed_filament', { filaments: [1, 2], ratio: [9, 1] })
    expect(fifth.ok).toBe(false)
    expect(fifth.summary).toMatch(/no free number/)
    // 28 filaments loaded: a 29th would take mix 29's number, so it is refused until that mix goes.
    const grow = await call(h, 'slicerx_project_add_filament', {})
    expect(grow.ok).toBe(false)
    expect(grow.summary).toMatch(/Filament 29 is the number of mixed filament/)
    await call(h, 'slicerx_project_remove_mixed_filament', { id: 29 })
    expect((await call(h, 'slicerx_project_add_filament', {})).ok).toBe(true)
  })

  it("gives the slice the mixes a plate uses and the object's filament without the engine", async () => {
    const { McpProject } = await import('../src/project')
    const { ProfileCatalog } = await import('../src/profiles')
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { createNodeSlicerHost } = await import('../src/slicerhost')
    const { createStubSlicer } = await import('../src/slicer')
    const store = new DataStore(resolveDataPaths())
    const project = new McpProject({ name: 'Mix', profiles: [], printer: 'bambu_p1s' }, store, new ProfileCatalog(store), createNodeSlicerHost(createStubSlicer(), '/tmp/slicerx-mcp-test-mixes'))
    project.addFilament({ color: '#0000ff' })
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10])
    await project.addObject({ id: 'obj-9', name: 'tet', bboxMm: [10, 10, 10], mesh: async () => [] }, [{ name: 'tet', slot: 1, positions, indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) }])
    const plate = project.plates().find((p) => p.items.some((i) => i.objectId === 'obj-9'))!.index
    const m = project.addMix({ components: [1, 2], ratio: [2, 1], name: 'Sunset' })
    project.setObjectFilament('obj-9', m.id)
    expect((project.config(plate) as Record<string, unknown>)['mixed_filaments']).toEqual(['32:1,2:2,1:Sunset'])
    expect((await project.plate(plate)).objects[0]!.slotOverrides).toEqual({ tet: 32 })
    // The nozzle map and every count read the mix as its two filaments.
    expect(project.printedFilaments('obj-9')).toEqual([1, 2])
  })

  it('keeps a mix one mix on every plate: moved, duplicated and arranged objects need no remap', async () => {
    const { McpProject } = await import('../src/project')
    const { ProfileCatalog } = await import('../src/profiles')
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { createNodeSlicerHost } = await import('../src/slicerhost')
    const { createStubSlicer } = await import('../src/slicer')
    const store = new DataStore(resolveDataPaths())
    const project = new McpProject({ name: 'Plates', profiles: [], printer: 'bambu_p1s' }, store, new ProfileCatalog(store), createNodeSlicerHost(createStubSlicer(), '/tmp/slicerx-mcp-test-mix-plates'))
    project.addFilament({ color: '#0000ff' })
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10])
    const indices = Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])
    await project.addObject({ id: 'obj-9', name: 'tet', bboxMm: [10, 10, 10], mesh: async () => [] }, [{ name: 'tet', slot: 1, positions, indices }])
    const from = project.plates().find((p) => p.items.some((i) => i.objectId === 'obj-9'))!.index
    const to = project.addPlate()
    const m = project.addMix({ components: [1, 2], ratio: [2, 1], name: 'Sunset' })
    project.setObjectFilament('obj-9', m.id)
    // Plate 'to' has nothing on the mix yet, so its slice sends none.
    expect((project.config(to) as Record<string, unknown>)['mixed_filaments']).toBeUndefined()
    project.moveToPlate('obj-9', to)
    expect((project.config(to) as Record<string, unknown>)['mixed_filaments']).toEqual(['32:1,2:2,1:Sunset'])
    expect((project.config(from) as Record<string, unknown>)['mixed_filaments']).toBeUndefined()
    expect((await project.plate(to)).objects[0]!.slotOverrides).toEqual({ tet: 32 })
    // Removing its plate into another keeps it on the mix too.
    project.removePlate(to, from)
    expect((await project.plate(from)).objects[0]!.slotOverrides).toEqual({ tet: 32 })
    // A duplicate prints with its original's filaments.
    const dup = await project.duplicate('obj-9', 1)
    const copyId = dup.ids[0]!
    const shown = project.describe() as { objects: { id: string; filament?: number }[] }
    expect(shown.objects.find((o) => o.id === copyId)?.filament).toBe(32)
    // Removing the mix puts every object on it back on its first filament.
    expect(project.removeMix(32).moved).toBe(2)
    expect(project.mixes()).toEqual([])
  })

  it('refuses a mix of one filament, of a filament not loaded, and a filament the project does not have', async () => {
    const h = await connect()
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_filament', { color: '#0000ff' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    expect((await h.call('slicerx_project_add_mixed_filament', { filaments: [1, 1], ratio: [1, 1] })).isError).toBe(true)
    const notLoaded = await call(h, 'slicerx_project_add_mixed_filament', { filaments: [1, 3], ratio: [1, 1] })
    expect(notLoaded.ok).toBe(false)
    expect(notLoaded.summary).toMatch(/2 loaded filaments/)
    const none = await call(h, 'slicerx_project_set_object_filament', { objectId: 'obj-1', filament: 31 })
    expect(none.ok).toBe(false)
    expect(none.summary).toMatch(/No filament 31: the project has 2/)
    // A mix number outside the numbers mixes take never reaches the project.
    expect((await h.call('slicerx_project_remove_mixed_filament', { id: 28 })).isError).toBe(true)
  })

  it('reads a number left on a deleted mix as the filament it prints with, and sends the mixes so the slice does too', async () => {
    const { McpProject } = await import('../src/project')
    const { ProfileCatalog } = await import('../src/profiles')
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { createNodeSlicerHost } = await import('../src/slicerhost')
    const { createStubSlicer } = await import('../src/slicer')
    const store = new DataStore(resolveDataPaths())
    const project = new McpProject({ name: 'Left', profiles: [], printer: 'bambu_p1s' }, store, new ProfileCatalog(store), createNodeSlicerHost(createStubSlicer(), '/tmp/slicerx-mcp-test-mix-left'))
    project.addFilament({ color: '#0000ff' })
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10])
    await project.addObject({ id: 'obj-9', name: 'tet', bboxMm: [10, 10, 10], mesh: async () => [] }, [{ name: 'tet', slot: 1, positions, indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) }])
    const plate = project.plates().find((p) => p.items.some((i) => i.objectId === 'obj-9'))!.index
    // The object left on 31, as a project file can leave it (a client can only pick a loaded filament or a mix).
    ;(project as unknown as { entries: Map<string, { filament?: number }> }).entries.get('obj-9')!.filament = 31
    // Without mixes 31 is a filament of its own, as before.
    expect(project.printedFilaments('obj-9')).toEqual([31])
    expect((project.config(plate) as Record<string, unknown>)['mixed_filaments']).toBeUndefined()
    project.addMix({ components: [1, 2], ratio: [1, 1], name: 'Even' })
    expect(project.printedFilaments('obj-9')).toEqual([1])
    expect((project.config(plate) as Record<string, unknown>)['mixed_filaments']).toEqual(['32:1,2:1,1:Even'])
  })
})
