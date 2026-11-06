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
import { checkOpenedPaint } from '../src/export/paint-check'
import { projectFiles, writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { openModelBytes } from '../src/state/actions'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

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
    const read = back.plates[0]!.objects[0]!.paint!
    expect(checkOpenedPaint([read], 32)).toBeNull()
    expect(read).toEqual(paint)
  })
})

describe('opening paint the project cannot show', () => {
  // The open checks the paint against the filaments the project has once it is open (open-project.ts).
  const opened = async (paint: NonNullable<PlateEntry['paint']>, filaments: number) => {
    const back = (await readProject(writeProject({ plates: [plateOf(paint)], bed, settings: {} }), bed)).plates[0]!.objects[0]!.paint!
    return { paint: back, note: checkOpenedPaint([back], filaments) }
  }

  it('leaves paint past the project filaments off, with one note', async () => {
    // Four filaments: 4 stays, 5 goes, and a split keeps its filament 1 half.
    const paint = { 0: { color: { 1: '1C', 2: '2C', 3: '2C41' } } }
    const back = await opened(paint, 4)
    expect(back.paint).toEqual({ 0: { color: { 1: '1C', 3: '041' } } })
    expect(back.note).toBe('Paint on filament 5 and up opens unpainted: this project has 4 filaments.')
    expect((await opened({ 0: { color: { 1: '8' } } }, 1)).note).toBe('Paint on filament 2 and up opens unpainted: this project has 1 filament.')
  })

  it('leaves paint past filament 32, and paint that does not read, off with one note', async () => {
    const paint = { 0: { color: { 1: '4', 2: '0FFC', 3: '0fc', 4: 'FFC' }, seam: { 5: '8', 6: 'zz' } } }
    const back = await opened(paint, 0)
    expect(back.paint).toEqual({ 0: { color: { 1: '4' }, seam: { 5: '8' } } })
    expect(back.note).toBe('Paint on filaments above 32 opens unpainted. Some paint in the file could not be read and opens unpainted.')
  })

  it('opens paint with codes past its tree, ignoring them, with one note', async () => {
    const paint = { 0: { color: { 1: '48', 2: '8048C4C3', 3: '4' }, seam: { 4: '4444443' } } }
    const back = await opened(paint, 0)
    expect(back.paint).toEqual(paint)
    expect(back.note).toBe('3 painted triangles have codes past their paint, which are ignored.')
  })
})

describe('reopening a saved project in the app', () => {
  // The save lists filament_colour for the filaments parts use only, so the open counts the filaments on the rail once
  // the project is open (added by hand, the printer's, the parts'), not that list.
  const saved: { blob?: Blob } = {}
  const host = {
    kind: 'web',
    capabilities: { threads: 1 },
    files: { save: vi.fn(async (_name: string, blob: Blob) => ((saved.blob = blob), { id: '1', name: 'box.sx3mf', size: blob.size })) },
    slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) },
  } as unknown as Host
  const slots = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: '#FFFFFF' }]))
  /** Two parts in filaments 1 and 2, as Layered X has them: the save lists those two in filament_colour. */
  const twoParts = (paint: PlateEntry['paint']): PlateEntry => {
    const e = entry(paint)
    return { ...e, handle: { ...e.handle, parts: [{ name: 'Box', slot: 1, triangles: 12 }, { name: 'Box 2', slot: 2, triangles: 12 }] }, parts: [boxMesh(20, 20, 20), { ...boxMesh(10, 10, 10), name: 'Box 2', slot: 2 }], colors: ['#bd93f9', '#303241'] }
  }
  /** Saves `paint` with `rail` filaments added by hand, then opens the file with `reopen` on the rail. */
  async function roundTrip(paint: NonNullable<PlateEntry['paint']>, rail: number, reopen = rail): Promise<{ paint: PlateEntry['paint']; toasts: string[]; listed: number }> {
    set({ plate: [twoParts(paint)], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', projectFile: null, printerId: null, printerSlots: [], slotSetup: slots(rail), fileSlotColors: [], layerMarks: {}, toast: null })
    expect(await saveProject(host)).toBe(true)
    const bytes = new Uint8Array(await saved.blob!.arrayBuffer())
    const listed = ((await readProject(bytes, bed)).settings['filament_colour'] as unknown[] | undefined)?.length ?? 0
    set({ plate: [], slotSetup: slots(reopen), toast: null })
    const toasts: string[] = []
    const stop = appStore.subscribe((s, prev) => void (s.toast && s.toast !== prev.toast && toasts.push(s.toast.text)))
    try {
      await openModelBytes(host, 'box.sx3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, undefined, { fresh: true })
    } finally {
      stop()
    }
    return { paint: get().plate[0]?.paint, toasts, listed }
  }
  const unpainted = (toasts: string[]) => toasts.filter((t) => /opens unpainted|this project has/.test(t))

  it('keeps paint on filament 25 of 32 that no part uses, with no note', async () => {
    const paint = { 0: { color: { 2: '7FC', 3: '7FC' } } }
    const back = await roundTrip(paint, 32)
    // the save lists the two filaments the parts use
    expect(back.listed).toBe(2)
    expect(back.paint).toEqual(paint)
    expect(unpainted(back.toasts)).toEqual([])
  })

  it('keeps paint on filament 3 of 4 that no part uses, with no note', async () => {
    const paint = { 0: { color: { 2: '0C', 5: '0C' } } }
    const back = await roundTrip(paint, 4)
    expect(back.listed).toBe(2)
    expect(back.paint).toEqual(paint)
    expect(unpainted(back.toasts)).toEqual([])
  })

  it('still leaves paint on a filament the open project does not have off, with its note', async () => {
    // Saved with 4 filaments, opened where the rail has the parts' 2 only (another machine): paint on 3 goes, on 2 stays.
    const back = await roundTrip({ 0: { color: { 2: '0C', 5: '8' } } }, 4, 2)
    expect(back.paint).toEqual({ 0: { color: { 5: '8' } } })
    expect(unpainted(back.toasts)).toEqual(['Paint on filament 3 and up opens unpainted: this project has 2 filaments.'])
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
    // On two lines: the save, then the warning, which Details would otherwise hide.
    expect(get().toast).toMatchObject({ text: "Saved box.sx3mf. OrcaSlicer can't show paint on filaments above 16.", tone: 'warn', secondLine: true })
  })

  it('is the plain saved line for paint up to filament 16', async () => {
    set({ plate: [entry({ 0: { color: { 3: 'DC' } } })] })
    expect(await saveProject(host())).toBe(true)
    expect(get().toast).toMatchObject({ text: 'Saved box.sx3mf', tone: 'ok' })
    expect(get().toast!.secondLine).toBeUndefined()
  })
})
