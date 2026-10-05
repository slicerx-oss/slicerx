// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printable area that does not start at 0, 0 (Snapmaker U1 at 0.5, 1; the FLSUN V400 delta centered on 0, 0): the
// plate counts from its front left corner and the engine gets machine coordinates, so the middle of the plate prints
// in the middle of the machine. The tower, the preview offset, the no-print areas and 3MF projects follow.
import { afterEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { resolveConfig, setProfileLayer } from '../src/adapters/config'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { slotConfig } from '../src/filament/slots'
import { areaOrigin, polygonsToPlate, towerToPlate } from '../src/plate/bed-origin'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { plateObjects } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

afterEach(() => {
  set({ printerModel: null, plate: [], tower: { auto: true, x: 0, y: 0 } })
  setProfileLayer(null, [])
})

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const slicer = { loadModel: async () => handle('m') }
const at = (x: number, y: number): PlateEntry => ({ id: 'o1', name: 'Cube', handle: handle('o1'), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: compose({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

describe('the printable area origin', () => {
  it('reads the front left corner of number pairs and of Orca text', () => {
    expect(areaOrigin([[0.5, 1], [270.5, 1], [270.5, 271], [0.5, 271]])).toEqual([0.5, 1])
    expect(areaOrigin(['0.5x1', '270.5x1', '270.5x271', '0.5x271'])).toEqual([0.5, 1])
    expect(areaOrigin('-150x-150,150x-150,150x150')).toEqual([-150, -150])
    expect(areaOrigin(undefined)).toEqual([0, 0])
  })

  it.each([
    ['Snapmaker', 'U1', [0.5, 1], [135.5, 136]],
    ['FLSUN', 'V400', [-150, -150], [0, 0]],
    ['Bambu Lab', 'A1 mini', [0, 0], [90, 90]],
  ] as const)('%s %s: the middle of the plate slices in the middle of the machine', async (vendor, model, origin, middle) => {
    set({ printerModel: { vendor, model } })
    await profileReady()
    const s = get()
    const cfg = resolveConfig(s.easy, s.overrides)
    expect(areaOrigin(cfg['printable_area'])).toEqual(origin)
    const [obj] = await plateObjects(slicer, s, undefined, [at(s.bed.widthMm / 2, s.bed.depthMm / 2)])
    expect(obj!.transform[12]).toBeCloseTo(middle[0], 3)
    expect(obj!.transform[13]).toBeCloseTo(middle[1], 3)
  })

  it('the tower goes out on the machine and comes back on the plate', async () => {
    set({ printerModel: { vendor: 'Snapmaker', model: 'U1' } })
    await profileReady()
    // Two filaments, so the plate has a tower.
    const two = at(100, 100)
    const parts = [{ ...boxMesh(20, 20, 20), name: 'a', slot: 1 }, { ...boxMesh(10, 10, 30), name: 'b', slot: 2 }]
    set({ plate: [{ ...two, parts, handle: { ...two.handle, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: 12 })) } }], tower: { auto: false, x: 100, y: 200 } })
    const cfg = slotConfig(get())
    expect(cfg['wipe_tower_x']).toBeCloseTo(100.5, 3)
    expect(cfg['wipe_tower_y']).toBeCloseTo(201, 3)
    expect(towerToPlate({ x: 100.5, y: 201, width: 35, depth: 35, angle: 0, reason: 'kept' }, [0.5, 1])).toMatchObject({ x: 100, y: 200 })
  })

  it('no-print areas land on the plate', () => {
    expect(polygonsToPlate([[[-150, -150], [-100, -150], [-100, -100]]], [-150, -150])).toEqual([[[0, 0], [50, 0], [50, 50]]])
  })

  it('a project keeps its plate places and stores machine places, as Orca does', async () => {
    const bed = { widthMm: 300, depthMm: 300 }
    const settings = { printable_area: ['-150x-150', '150x-150', '150x150', '-150x150'] }
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [at(150, 150)], settings: { sequence: 'by-layer' } }], bed, settings })
    const model = new TextDecoder().decode((await import('../src/export/zip')).unzipStored(bytes).get('3D/3dmodel.model'))
    expect(model).toMatch(/<item objectid="\d+" transform="1 0 0 0 1 0 0 0 1 0 0 0"/)
    const back = await readProject(bytes, bed)
    const t = back.plates[0]!.objects[0]!.transform
    expect([t[12], t[13]]).toEqual([150, 150])
  })
})
