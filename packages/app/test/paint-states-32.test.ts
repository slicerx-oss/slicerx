// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint on filaments 17 to 32. A project saves it in paint_color and, when any color paint is on 17 or higher, also in
// Metadata/Slic3r_facets_annotation.json, which writes states 17 and up the other way (E and an 8-bit value). It opens
// as saved; paint past the project's filaments, or that does not read, opens unpainted with one note. A save with
// paint above 16 says in its toast that one slicer can't show it.
import type { FileRef, Host } from '@slicerx/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveProject } from '../src/export/actions'
import { readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { get, set, type PlateEntry } from '../src/state/store'

const FACETS = 'Metadata/Slic3r_facets_annotation.json'
const bed = { widthMm: 256, depthMm: 256 }

function entry(paint: PlateEntry['paint']): PlateEntry {
  return {
    id: 'a',
    name: 'Widget',
    handle: { id: 'h1', hash: 'h1', name: 'h1', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] },
    parts: [boxMesh(20, 20, 20)],
    colors: ['#bd93f9'],
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1],
    ...(paint ? { paint } : {}),
  }
}

const plateOf = (paint: PlateEntry['paint']) => ({ id: 'p', name: 'Plate 1', settings: { sequence: 'by-layer' as const }, objects: [entry(paint)] })
const fileText = (files: ReturnType<typeof projectFiles>, name: string) => {
  const f = files.find((e) => e.name === name)
  return f ? String(f.data) : undefined
}
const filaments = (n: number) => ({ filament_colour: Array.from({ length: n }, () => '#FFFFFF') })

describe('saving paint on filaments 17 to 32', () => {
  it('writes paint_color as before and the facets JSON in its own scheme, version 2', () => {
    // Filament 32 on a whole triangle, 19 in half of one, a support enforcer.
    const files = projectFiles({ plates: [plateOf({ 0: { color: { 3: 'EFC', 4: '01FC9' }, support: { 5: '4' } } })], bed, settings: {} })
    const model = fileText(files, '3D/3dmodel.model')!
    expect(model).toContain('paint_color="EFC"')
    expect(model).toContain('paint_color="01FC9"')
    expect(model).toContain('paint_supports="4"')
    expect(model).not.toContain('slic3rpe:')
    expect(JSON.parse(fileText(files, FACETS)!)).toEqual([
      {
        id: 1,
        mmSegmentationFacets: [{ triangle: 3, dividing: '0FEC' }, { triangle: 4, dividing: '002EC9' }],
        mmSegmentationFacetsVersion: 2,
        supportedFacets: [{ triangle: 5, dividing: '4' }],
        supportedFacetsVersion: 1,
      },
    ])
    expect(files.map((f) => f.name)).toContain(FACETS)
  })

  it('writes one entry per part, each numbering its own triangles from 0', () => {
    const two = { ...entry({ 0: { color: { 11: '8' } }, 1: { color: { 0: '1FC' } } }), parts: [boxMesh(20, 20, 20), boxMesh(10, 10, 10)] }
    const plate = { id: 'p', name: 'Plate 1', settings: { sequence: 'by-layer' as const }, objects: [two] }
    const files = projectFiles({ plates: [plate], bed, settings: {} })
    // Parts are mesh objects 1 and 2, and object 3 holds them as its components.
    expect(fileText(files, '3D/3dmodel.model')).toContain('<object id="3" type="model" name="Widget"><components><component objectid="1"/><component objectid="2"/></components>')
    expect(JSON.parse(fileText(files, FACETS)!)).toEqual([
      { id: 1, mmSegmentationFacets: [{ triangle: 11, dividing: '8' }], mmSegmentationFacetsVersion: 2 },
      { id: 2, mmSegmentationFacets: [{ triangle: 0, dividing: '02EC' }], mmSegmentationFacetsVersion: 2 },
    ])
  })

  it('never shares a mesh between parts, so a copy with other paint keeps its own facets entry', () => {
    // A copy of the object (an instance, the same mesh) painted differently: each part gets a mesh object of its own.
    const a = entry({ 0: { color: { 0: '1FC' } } })
    const b = { ...a, id: 'b', instanceOf: 'a', paint: { 0: { color: { 0: 'EFC' } } } }
    const plate = { id: 'p', name: 'Plate 1', settings: { sequence: 'by-layer' as const }, objects: [a, b] }
    const files = projectFiles({ plates: [plate], bed, settings: {} })
    const model = fileText(files, '3D/3dmodel.model')!
    expect(model.match(/<mesh>/g)).toHaveLength(2)
    expect(model).toContain('<object id="2" type="model" name="Widget"><components><component objectid="1"/></components>')
    expect(model).toContain('<object id="4" type="model" name="Widget"><components><component objectid="3"/></components>')
    expect(JSON.parse(fileText(files, FACETS)!)).toEqual([
      { id: 1, mmSegmentationFacets: [{ triangle: 0, dividing: '02EC' }], mmSegmentationFacetsVersion: 2 },
      { id: 3, mmSegmentationFacets: [{ triangle: 0, dividing: '0FEC' }], mmSegmentationFacetsVersion: 2 },
    ])
  })

  it('writes no facets JSON while every color state is 16 or lower', () => {
    const files = projectFiles({ plates: [plateOf({ 0: { color: { 3: 'DC', 4: '481' }, seam: { 1: '8' } } })], bed, settings: {} })
    expect(fileText(files, FACETS)).toBeUndefined()
    expect(fileText(files, '3D/3dmodel.model')).toContain('paint_color="DC"')
  })

  it('opens filament 17 to 32 paint as it was saved', async () => {
    const paint = { 0: { color: { 2: 'EC', 3: 'EFC', 4: '01FC9', 5: '0FC0C10DFC6' } } }
    const back = await readProject(writeProject({ plates: [plateOf(paint)], bed, settings: filaments(32) }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual(paint)
    expect(back.paintNote).toBeUndefined()
  })
})

describe('opening paint the project cannot show', () => {
  it('leaves paint past the project filaments off, with one note', async () => {
    // Four filaments: 4 stays, 5 goes, and a split keeps its filament 1 half.
    const paint = { 0: { color: { 1: '1C', 2: '2C', 3: '2C41' } } }
    const back = await readProject(writeProject({ plates: [plateOf(paint)], bed, settings: filaments(4) }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual({ 0: { color: { 1: '1C', 3: '041' } } })
    expect(back.paintNote).toBe('Paint on filament 5 and up opens unpainted: this project has 4 filaments.')
  })

  it('leaves paint past filament 32, and paint that does not read, off with one note', async () => {
    const paint = { 0: { color: { 1: '4', 2: '0FFC', 3: '0fc', 4: 'FFC' }, seam: { 5: '8', 6: 'zz' } } }
    const back = await readProject(writeProject({ plates: [plateOf(paint)], bed, settings: {} }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual({ 0: { color: { 1: '4' }, seam: { 5: '8' } } })
    expect(back.paintNote).toBe('Paint on filaments above 32 opens unpainted. Some paint in the file could not be read and opens unpainted.')
  })

  it('opens paint with codes past its tree, ignoring them, with one note', async () => {
    const paint = { 0: { color: { 1: '48', 2: '8048C4C3', 3: '4' }, seam: { 4: '4444443' } } }
    const back = await readProject(writeProject({ plates: [plateOf(paint)], bed, settings: {} }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual(paint)
    expect(back.paintNote).toBe('3 painted triangles have codes past their paint, which are ignored.')
  })
})

describe('the save toast', () => {
  const host = () => {
    const ref: FileRef = { id: '1', name: 'box.sx3mf', size: 3, path: '/p/box.sx3mf' }
    return { files: { save: vi.fn(async () => ref), saveTo: vi.fn(async () => ref) } } as unknown as Host
  }
  beforeEach(() => set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', projectFile: null }))

  it('says one slicer cannot show paint above filament 16', async () => {
    set({ plate: [entry({ 0: { color: { 3: 'EC' } } })] })
    expect(await saveProject(host())).toBe(true)
    expect(get().toast).toMatchObject({ text: "Saved box.sx3mf. OrcaSlicer can't show paint on filaments above 16.", tone: 'warn' })
  })

  it('is the plain saved line for paint up to filament 16', async () => {
    set({ plate: [entry({ 0: { color: { 3: 'DC' } } })] })
    expect(await saveProject(host())).toBe(true)
    expect(get().toast).toMatchObject({ text: 'Saved box.sx3mf', tone: 'ok' })
  })
})
