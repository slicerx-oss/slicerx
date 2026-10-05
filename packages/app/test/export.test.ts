// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { md5Hex } from '../src/export/md5'
import { projectFiles, transformAttr, writeProject } from '../src/export/threemf'
import { crc32, unzipStored, zip } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

function obj(id: string, x: number): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: `Part ${id}`, handle, parts: [{ ...boxMesh(10, 10, 10), name: 'body', slot: 2 }], colors: ['#fff', '#000'], transform: compose({ position: [x, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('export writers', () => {
  it('checksums match known vectors', () => {
    expect(crc32(enc('123456789')).toString(16)).toBe('cbf43926')
    expect(md5Hex(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex(enc('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6')
  })

  it('zips and reads back', () => {
    const bytes = zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }])
    const files = unzipStored(bytes)
    expect(dec(files.get('a.txt'))).toBe('hello')
    expect([...files.get('dir/b.bin')!]).toEqual([1, 2, 3])
  })

  it('writes the 3MF transform as the first three rows of each column', () => {
    expect(transformAttr(compose({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 1, 1] }))).toBe('2 0 0 0 1 0 0 0 1 1 2 3')
  })

  it('writes a Bambu and Orca style project with plates, settings and G-code', () => {
    const plates: PlateMeta[] = [
      { id: 'p1', name: 'Plate 1', objects: [obj('a', 40)], settings: { sequence: 'by-layer', bedType: 'textured-pei' } },
      { id: 'p2', name: 'Brackets', objects: [obj('b', 60)], settings: { sequence: 'by-object', filamentOrder: [2, 1] } },
    ]
    const files = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: { layer_height: '0.2' }, objectSettings: { a: { wall_loops: 4 } }, gcode: { 1: 'G28\n' } }))
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/project_settings.config', 'Metadata/plate_2.gcode', 'Metadata/plate_2.gcode.md5']))
    const model = dec(files.get('3D/3dmodel.model'))
    expect(model.match(/<item /g)).toHaveLength(2)
    expect(model).toContain('<components>')
    const cfg = dec(files.get('Metadata/model_settings.config'))
    expect(cfg).toContain('<metadata key="plater_name" value="Brackets"/>')
    expect(cfg).toContain('<metadata key="print_sequence" value="by object"/>')
    expect(cfg).toContain('<metadata key="curr_bed_type" value="Textured PEI Plate"/>')
    expect(cfg).toContain('<metadata key="wall_loops" value="4"/>')
    expect(cfg).toContain('<metadata key="extruder" value="2"/>')
    expect(JSON.parse(dec(files.get('Metadata/project_settings.config')))).toEqual({ layer_height: '0.2' })
    expect(dec(files.get('Metadata/plate_2.gcode.md5'))).toBe(md5Hex(enc('G28\n')).toUpperCase())
    expect(projectFiles({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {} }).some((f) => f.name.endsWith('.gcode'))).toBe(false)
  })

  it('writes slice_info.config with the objects the printer can skip, by the ids the G-code labels', () => {
    const a = obj('a', 40)
    const hidden = { ...obj('h', 60), printable: false }
    const b = obj('b', 80)
    const plates: PlateMeta[] = [{ id: 'p1', name: 'Plate 1', objects: [a, hidden, b], settings: { sequence: 'by-layer' } }]
    const gcode = '; model label id: 1,2\n; start printing object, unique label id: 1\nG1 X1 E1\n; estimated printing time (normal mode) = 1h 2m 3s\n; total filament used [g] = 4.50\n'
    const files = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {}, gcode: { 0: gcode } }))
    const info = dec(files.get('Metadata/slice_info.config'))
    expect(info).toContain('<metadata key="index" value="1"/>')
    expect(info).toContain('<metadata key="prediction" value="3723"/>')
    expect(info).toContain('<metadata key="weight" value="4.50"/>')
    expect(info).toContain('<metadata key="label_object_enabled" value="true"/>')
    expect(info).toContain('<object identify_id="1" name="Part a" skipped="false" />')
    expect(info).toContain('<object identify_id="2" name="Part b" skipped="false" />')
    expect(info).not.toContain('Part h')
    // No labels in the file: no objects, and the file says so.
    const plain = dec(unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {}, gcode: { 0: 'G28\n' } })).get('Metadata/slice_info.config'))
    expect(plain).toContain('<metadata key="label_object_enabled" value="false"/>')
    expect(plain).not.toContain('<object ')
    expect(projectFiles({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {} }).some((f) => f.name === 'Metadata/slice_info.config')).toBe(false)
  })

  it('an sx3mf carries the model, creator and exporting user ids and keeps the geometry', () => {
    const a = { ...obj('a', 40), source: { modelId: 'lst_1', creatorId: 'cr_1' } }
    const plates: PlateMeta[] = [{ id: 'p1', name: 'Plate 1', objects: [a], settings: { sequence: 'by-layer' } }]
    const plain = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {} }))
    const sx = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {}, sx: { modelId: 'lst_1', creatorId: 'cr_1', exportedBy: 'usr_9' } }))
    const model = dec(sx.get('3D/3dmodel.model'))
    expect(model).toContain('xmlns:sx="https://slicerx.app/schemas/sx3mf/2026"')
    expect(model).toContain('<metadata name="sx:Listing">lst_1</metadata>')
    expect(model).toContain('<metadata name="sx:Creator">cr_1</metadata>')
    expect(model).toContain('<metadata name="sx:ExportedBy">usr_9</metadata>')
    expect(dec(sx.get('Metadata/model_settings.config'))).toContain('<metadata key="sx:Listing" value="lst_1"/>')
    // Same meshes and build items as the plain file.
    const body = (m: string) => m.slice(m.indexOf('<resources>'))
    expect(body(model)).toBe(body(dec(plain.get('3D/3dmodel.model'))))
    const anon = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: {}, sx: { exportedBy: '' } }))
    expect(dec(anon.get('3D/3dmodel.model'))).toContain('<metadata name="sx:ExportedBy"></metadata>')
  })
})
