// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { modifierSettings } from '../src/export/project-settings'
import { readProject, unzipEntries, ProjectReadError } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { bake } from '../src/plate/mesh-ops'
import { bounds, compose, identity } from '../src/plate/transform'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

function plates(): PlateMeta[] {
  const part = boxMesh(20, 20, 20)
  const vol = boxMesh(4, 4, 4)
  const obj: PlateEntry = {
    id: 'a',
    name: 'Widget',
    handle: handle('a'),
    parts: [part],
    colors: ['#bd93f9'],
    transform: compose({ position: [100, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    volumes: [
      { id: 'v1', name: 'Negative volume 1', role: 'negative', handle: handle('v1'), part: vol, local: compose({ position: [2, 3, 10], rotation: [0, 0, 0], scale: [1, 1, 1] }) },
      { id: 'v2', name: 'Support blocker 1', role: 'support_blocker', handle: handle('v2'), part: vol, local: compose({ position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }) },
    ],
  }
  return [{ id: 'p1', name: 'Plate 1', objects: [obj], settings: { sequence: 'by-object' } }]
}

describe('volumes in a 3MF project', () => {
  it('writes them as parts with Orca subtypes', () => {
    const cfg = String(projectFiles({ plates: plates(), bed, settings: {} }).find((f) => f.name === 'Metadata/model_settings.config')!.data)
    expect(cfg).toContain('subtype="normal_part"')
    expect(cfg).toContain('subtype="negative_part"')
    expect(cfg).toContain('subtype="support_blocker"')
  })

  it('reads them back: parts, volumes in object coordinates, transform, plate settings', async () => {
    const p = await readProject(writeProject({ plates: plates(), bed, settings: {} }), bed)
    expect(p.plates).toHaveLength(1)
    expect(p.plates[0]!.sequence).toBe('by-object')
    const o = p.plates[0]!.objects[0]!
    expect(o.name).toBe('Widget')
    expect(o.parts).toHaveLength(1)
    expect(o.volumes.map((v) => v.role)).toEqual(['negative', 'support_blocker'])
    expect(o.transform[12]).toBeCloseTo(100)
    expect(o.transform[13]).toBeCloseTo(90)
    // The first volume sits where the object put it: baked local placement.
    const want = bounds([bake(boxMesh(4, 4, 4), compose({ position: [2, 3, 10], rotation: [0, 0, 0], scale: [1, 1, 1] }))], identity())!
    const got = bounds([o.volumes[0]!.part], identity())!
    for (let i = 0; i < 3; i++) {
      expect(got.min[i]).toBeCloseTo(want.min[i]!, 4)
      expect(got.max[i]).toBeCloseTo(want.max[i]!, 4)
    }
  })

  it('writes a modifier as modifier_part with its settings and reads them back as plain values', async () => {
    const pl = plates()
    pl[0]!.objects[0]!.volumes = [{ id: 'm', name: 'Modifier 1', role: 'modifier', handle: handle('m'), part: boxMesh(4, 4, 4), local: compose({ position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }), settings: { sparse_infill_density: '60%', wall_loops: 5 } }]
    const cfg = String(projectFiles({ plates: pl, bed, settings: {} }).find((f) => f.name === 'Metadata/model_settings.config')!.data)
    expect(cfg).toContain('subtype="modifier_part"')
    expect(cfg).toContain('key="wall_loops" value="5"')
    const back = await readProject(writeProject({ plates: pl, bed, settings: {} }), bed)
    const v = back.plates[0]!.objects[0]!.volumes[0]!
    expect(v.role).toBe('modifier')
    expect(modifierSettings(v.rawSettings!)).toMatchObject({ wall_loops: 5 })
    // A file cannot smuggle G-code or scripts in through a modifier.
    expect(modifierSettings({ machine_start_gcode: 'M104 S300', post_process: 'rm -rf /', wall_loops: '3' })).toEqual({ wall_loops: 3 })
  })

  it('keeps an object that does not print and a part moved to another filament', async () => {
    const pl = plates()
    const o = pl[0]!.objects[0]!
    pl[0]!.objects[0] = { ...o, printable: false, slotOverrides: { [o.parts[0]!.name]: 3 } }
    const cfg = String(projectFiles({ plates: pl, bed, settings: {} }).find((f) => f.name === 'Metadata/model_settings.config')!.data)
    expect(cfg).toContain('<metadata key="extruder" value="3"/>')
    const model = String(projectFiles({ plates: pl, bed, settings: {} }).find((f) => f.name === '3D/3dmodel.model')!.data)
    expect(model).toContain('printable="0"')
    const back = await readProject(writeProject({ plates: pl, bed, settings: {} }), bed)
    const r = back.plates[0]!.objects[0]!
    expect(r.printable).toBe(false)
    expect(r.parts[0]!.slot).toBe(3)
  })

  it('writes one file per object past the size limit, and reads it back the same', async () => {
    const files = projectFiles({ plates: plates(), bed, settings: {} }, 1)
    const names = files.map((f) => f.name)
    expect(names).toContain('3D/_rels/3dmodel.model.rels')
    expect(names.some((n) => /^3D\/Objects\/object_\d+\.model$/.test(n))).toBe(true)
    expect(String(files.find((f) => f.name === '3D/3dmodel.model')!.data)).toContain('p:path="/3D/Objects/object_')
    const p = await readProject(zip(files), bed)
    const o = p.plates[0]!.objects[0]!
    expect(o.parts).toHaveLength(1)
    expect(o.volumes.map((v) => v.role)).toEqual(['negative', 'support_blocker'])
    expect(o.transform[12]).toBeCloseTo(100)
  })

  it('reads a deflated archive', async () => {
    const data = new TextEncoder().encode('hello hello hello hello hello hello')
    const packed = new Uint8Array(await new Response(new ReadableStream({ start: (c) => (c.enqueue(data), c.close()) }).pipeThrough(new CompressionStream('deflate-raw') as never)).arrayBuffer())
    const name = new TextEncoder().encode('a.txt')
    const local = new Uint8Array(30 + name.length + packed.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, 8, true)
    lv.setUint32(18, packed.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(packed, 30 + name.length)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(20, packed.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, 0, true)
    central.set(name, 46)
    const end = new Uint8Array(22)
    const ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(10, 1, true)
    ev.setUint32(12, central.length, true)
    ev.setUint32(16, local.length, true)
    const file = new Uint8Array([...local, ...central, ...end])
    const out = await unzipEntries(file)
    expect(new TextDecoder().decode(out.get('a.txt')!)).toBe('hello hello hello hello hello hello')
    // A header that claims less than the data inflates to is refused.
    new DataView(file.buffer).setUint32(local.length + 24, 3, true)
    await expect(unzipEntries(file)).rejects.toThrow(/inflates to more/)
  })

  it('refuses unsafe archives with a plain message', async () => {
    const evil = zip([{ name: '../x.model', data: 'x' }])
    await expect(unzipEntries(evil)).rejects.toThrow(/unsafe path/)
    await expect(unzipEntries(new Uint8Array(64))).rejects.toBeInstanceOf(ProjectReadError)
    const none = zip([{ name: 'readme.txt', data: 'hi' }])
    await expect(readProject(none, bed)).rejects.toThrow(/no model file/)
  })
})
