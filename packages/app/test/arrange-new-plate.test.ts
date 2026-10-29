// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange with more objects than the bed holds: the ones it cannot place move to a new plate, arranged there, in the
// same undo step as the arrange, and a toast says how many moved and where; it stays until dismissed, and Show opens
// the first new plate. Before, they stayed where they were and overlapped the placed ones or stood inside their
// clearance, so the slice failed or merged them. Runs the box packer (no geometry engine here), as the app does when
// the engine cannot run; the e2e runs the nest.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { arrangePlate, movedToPlatesNotice } from '../src/plate/edit'
import { installPrintMargins } from '../src/plate/footprint'
import { history } from '../src/plate/history'
import { clearanceProblems, sequenceProblem } from '../src/plate/sequence-check'
import { get, set, type PlateEntry } from '../src/state/store'

vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))

/** A closed box, `s` mm on each side, its footprint's corner at the origin. */
function cube(s: number) {
  const p = [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  return { name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }
}

/** `n` cubes of `s` mm in a start grid of `cols` columns, `pitch` mm apart from `x0`, `y0`, as an opened project lays them. */
function grid(n: number, s: number, cols: number, pitch: number, x0: number, y0: number): PlateEntry[] {
  return Array.from({ length: n }, (_, k) => {
    const id = `c${k + 1}`
    const handle = { id, hash: id, name: `Cube ${k + 1}`, triangles: 12, bboxMm: [s, s, s], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
    const x = x0 + (k % cols) * pitch
    const y = y0 + Math.floor(k / cols) * pitch
    return { id, name: `Cube ${k + 1}`, handle, parts: [cube(s)], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] } as unknown as PlateEntry
  })
}

/** The A1 as a Bambu Studio project carries it: 73 mm max radius, the rod 25 mm up, no brim or skirt. */
const A1 = { printer_model: 'Bambu Lab A1', extruder_clearance_radius: 40, extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 25, extruder_clearance_dist_to_rod: 56.5, extruder_clearance_height_to_lid: 256, nozzle_height: 4.76, brim_type: 'no_brim', skirt_loops: 0 }
const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }

type Box = { x0: number; y0: number; x1: number; y1: number }
const boxOf = (e: PlateEntry, s: number): Box => ({ x0: e.transform[12]!, y0: e.transform[13]!, x1: e.transform[12]! + s, y1: e.transform[13]! + s })
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6
const inBed = (b: Box) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= BED.widthMm && b.y1 <= BED.depthMm

/** Each plate's objects, the shown plate's from `plate`. */
const platesNow = () => get().plates.map((p) => (p.id === get().activePlate ? get().plate : p.objects))

function start(entries: PlateEntry[], sequence: 'by-object' | 'by-layer') {
  installPrintMargins(get)
  set({ bed: BED, plate: entries, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence } }], activePlate: 'p1', overrides: { ...A1 }, profile: { printerId: 'bambu-a1' } as never, selection: null, selectedIds: [], toast: null })
  history().clear()
}

function expectClean(s: number, byObject: boolean) {
  for (const objects of platesNow()) {
    const boxes = objects.map((e) => boxOf(e, s))
    for (const b of boxes) expect(inBed(b), JSON.stringify(b)).toBe(true)
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), JSON.stringify([boxes[i], boxes[j]])).toBe(false)
    if (byObject) expect(clearanceProblems(objects, A1, 'bambu-a1')).toEqual([])
  }
}

describe('arrange with more objects than the bed holds', () => {
  beforeEach(() => set({ plates: [], toast: null }))

  it('by object, 10 cubes of 20 mm on an A1: the ones that do not fit move to Plate 2, every plate clear', async () => {
    const start10 = grid(10, 20, 5, 30, 63, 103)
    start(start10, 'by-object')
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const [one, two] = platesNow()
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2'])
    expect(two!.length).toBeGreaterThan(0)
    expect(one!.length + two!.length).toBe(10)
    expect(get().activePlate).toBe('p1')
    expect(get().plates[1]!.settings.sequence).toBe('by-object')
    expect(sequenceProblem(get())).toBeNull()
    expectClean(20, true)
    expect(get().toast?.text).toBe(movedToPlatesNotice([{ name: 'Plate 2', count: two!.length }]))
    // One undo puts back the start grid on one plate.
    expect(history().undo()).toBe(true)
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1'])
    expect(get().plate.map((e) => [e.id, e.transform[12], e.transform[13]])).toEqual(start10.map((e) => [e.id, e.transform[12], e.transform[13]]))
  })

  it('by layer, 42 cubes of 30 mm: nothing is left overlapping a placed cube', async () => {
    const start42 = grid(42, 30, 7, 34, 10, 10)
    start(start42, 'by-layer')
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const [one, two] = platesNow()
    expect(get().plates).toHaveLength(2)
    expect(one!.length + two!.length).toBe(42)
    expectClean(30, false)
    expect(get().toast?.text).toBe(movedToPlatesNotice([{ name: 'Plate 2', count: two!.length }]))
    expect(history().undo()).toBe(true)
    expect(get().plates).toHaveLength(1)
    expect(get().plate.map((e) => e.transform[13])).toEqual(start42.map((e) => e.transform[13]))
  })

  it('Move it clear on a full plate moves the object to a new plate, not back into no room', async () => {
    start(grid(10, 20, 5, 30, 63, 103), 'by-object')
    await arrangePlate('all', { gapMm: 6, rotate: false })
    // A cube dropped on top of a placed one: Move it clear arranges the selection.
    const [placed] = platesNow()
    const t = [...placed![0]!.transform]
    const extra = { ...grid(1, 20, 1, 0, t[12]!, t[13]!)[0]!, id: 'x', name: 'Extra' } as PlateEntry
    set({ plate: [...get().plate, extra], selection: 'x', selectedIds: ['x'] })
    await arrangePlate('selection', { gapMm: 6, rotate: false })
    expect(get().plate.some((e) => e.id === 'x')).toBe(false)
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2', 'Plate 3'])
    expect(get().plates[2]!.objects.map((e) => e.id)).toEqual(['x'])
    expect(get().toast?.text).toBe('1 object did not fit, so it moved to Plate 3.')
    expectClean(20, true)
  })

  it('keeps the notice until it is dismissed, and Show opens the first new plate', async () => {
    start(grid(10, 20, 5, 30, 63, 103), 'by-object')
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const t = get().toast
    // Information that would otherwise fade: it stays until dismissed or shown, with the dismiss button a warning has.
    expect(t).toMatchObject({ tone: 'info', persist: true, action: { label: 'Show' } })
    expect(t?.dismissible).toBeUndefined()
    expect(get().activePlate).toBe('p1')
    t!.action!.run()
    expect(get().activePlate).toBe(get().plates[1]!.id)
    expect(get().plate).toHaveLength(platesNow()[1]!.length)
    expect(get().plate.length).toBeGreaterThan(0)
  })

  it('says how many moved and where, one plate or several', () => {
    expect(movedToPlatesNotice([{ name: 'Plate 2', count: 1 }])).toBe('1 object did not fit, so it moved to Plate 2.')
    expect(movedToPlatesNotice([{ name: 'Plate 2', count: 2 }])).toBe('2 objects did not fit, so they moved to Plate 2.')
    expect(movedToPlatesNotice([{ name: 'Plate 2', count: 30 }, { name: 'Plate 3', count: 5 }])).toBe('35 objects did not fit, so they moved to Plate 2 and Plate 3.')
    expect(movedToPlatesNotice([{ name: 'Plate 2', count: 30 }, { name: 'Plate 3', count: 30 }, { name: 'Plate 4', count: 1 }])).toBe('61 objects did not fit, so they moved to Plate 2, Plate 3 and Plate 4.')
  })
})
