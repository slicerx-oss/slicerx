// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What Arrange says when the engine finds no room for some objects: one notice, in plain words, naming them. Objects
// larger than the bed stay where they were; objects with no room beside the others move to new plates, laid out there
// by the engine too, and the notice says where they went with Show; any that no new plate holds stay, named. No
// setting key or engine reason code reaches the page, and a plate the engine refuses moves nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshHandle, PlateArrangement, SliceRequest, SlicerHost } from '@slicerx/contracts'
import { arrangePlate, namesOf } from '../src/plate/edit'
import { setArrangeEngine } from '../src/plate/engine-arrange'
import { history } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'

vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))

const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }

function box(w: number, d: number, h: number) {
  const p = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  return { name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }
}

function entry(id: string, name: string, w: number, x: number): PlateEntry {
  const handle = { id: `m-${id}`, hash: id, name, triangles: 12, bboxMm: [w, 40, 5], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] } as MeshHandle
  return { id, name, handle, parts: [box(w, 40, 5)], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 20, 0, 1] }
}

const at = (x: number, y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]

/** The engine's layout for a request: `place` gives each object its spot, or null for no room. */
function layout(req: SliceRequest, place: (id: string, k: number) => { x: number; y: number } | 'no_room' | 'too_large'): PlateArrangement {
  const objects: PlateArrangement['objects'] = []
  const notFit: PlateArrangement['notFit'] = []
  req.plate.objects.forEach((o, k) => {
    const p = place(o.id, k)
    if (typeof p === 'string') notFit.push({ id: o.id, name: o.name ?? o.id, reason: p })
    else objects.push({ id: o.id, name: o.name ?? o.id, centerMm: [p.x, p.y], turnDeg: 0, transform: at(p.x, p.y) })
  })
  return { byObject: false, spacingMm: 6, rotate: true, lanes: false, keepOut: ['wrap-check-zone'], objects, notFit }
}

let stop: (() => void) | null = null
function engine(answer: (req: SliceRequest, call: number) => PlateArrangement | Promise<PlateArrangement>) {
  let calls = 0
  const arrangePlateCall = vi.fn(async (req: SliceRequest) => answer(req, ++calls))
  stop = setArrangeEngine({ loadModel: async () => ({}), loadParts: async () => ({}), arrangePlate: arrangePlateCall } as unknown as SlicerHost)
  return arrangePlateCall
}

/** Nothing in a notice a person would not say: no setting key, no engine reason code, no internal names. */
function plain(text: string): void {
  expect(text).not.toMatch(/no_room|too_large|notFit|plate\.arrange|placement|config key|_/)
}

beforeAll(async () => void (await Promise.all([import('../src/state/slice-plate'), import('../src/plate/layer-ranges'), import('../src/plate/layer-marks'), import('../src/plate/engine-check'), import('../src/plate/engine-arrange')])))

beforeEach(() => {
  set({ bed: BED, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }] as never, activePlate: 'p1', overrides: { skirt_loops: 0 }, profile: { printerId: 'bambu-a1' } as never, selection: null, selectedIds: [], toast: null, calibration: {}, layerMarks: {}, slice: { status: 'idle' } })
  history().clear()
})
afterEach(() => {
  stop?.()
  stop = null
})

describe('when the engine finds no room for some objects', () => {
  it('names the object larger than the bed and the ones that moved to a new plate, in one notice with Show', async () => {
    set({ plate: [entry('plank', 'Plank', 300, 0), entry('a', 'Tile A', 40, 10), entry('b', 'Tile B', 40, 20), entry('c', 'Tile C', 40, 30)] })
    // One call: the engine lays the two with no room out on a new plate itself.
    const ask = engine((req) => ({ ...layout(req, (id, k) => (id === 'plank' ? 'too_large' : id !== 'a' ? 'no_room' : { x: 30 + 50 * k, y: 30 })), plates: [{ objects: [
      { id: 'b', name: 'Tile B', centerMm: [60, 60], turnDeg: 0, transform: at(60, 60) },
      { id: 'c', name: 'Tile C', centerMm: [120, 60], turnDeg: 0, transform: at(120, 60) },
    ] }] }))
    const left = await arrangePlate('all')
    expect(left).toBe(3)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0].plate.arrange).toMatchObject({ newPlates: true })
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2'])
    expect(get().plate.map((p) => p.id)).toEqual(['plank', 'a'])
    expect(get().plate.find((p) => p.id === 'plank')!.transform).toEqual(entry('plank', 'Plank', 300, 0).transform)
    expect((get().plates[1]!.objects as PlateEntry[]).map((p) => p.id)).toEqual(['b', 'c'])
    const t = get().toast!
    expect(t.text).toBe('Plank is larger than this bed and stayed where it was. Make it smaller or choose a bigger printer. 2 objects did not fit, so they moved to Plate 2.')
    expect(t.tone).toBe('warn')
    expect(t.action?.label).toBe('Show')
    expect(t.persist).toBe(true)
    plain(t.text)
  })

  it('names the objects no new plate holds either, and keeps them where they were', async () => {
    set({ plate: [entry('a', 'Tile A', 40, 10), entry('b', 'Tile B', 40, 20), entry('c', 'Tile C', 40, 30), entry('d', 'Tile D', 40, 40), entry('e', 'Tile E', 40, 50)] })
    engine((req) => ({ ...layout(req, (id) => (id === 'a' ? { x: 60, y: 60 } : 'no_room')), plates: [] }))
    await arrangePlate('all')
    expect(get().plates).toHaveLength(1)
    expect(get().plate.find((p) => p.id === 'b')!.transform).toEqual(entry('b', 'Tile B', 40, 20).transform)
    const t = get().toast!
    expect(t.text).toBe('Tile B, Tile C and 2 more do not fit on the bed and stayed where they were.')
    expect(t.tone).toBe('warn')
    plain(t.text)
  })

  it('shows the first layout from the engine at once and lands the last as one undo step', async () => {
    set({ plate: [entry('a', 'Tile A', 40, 10), entry('b', 'Tile B', 40, 20)] })
    const before = get().plate.map((p) => p.transform)
    let land: () => void = () => undefined
    const arrangePlateCall = vi.fn(async (req: SliceRequest, opts?: { onLayout?: (first: PlateArrangement) => void }) => {
      opts?.onLayout?.(layout(req, (_, k) => ({ x: 30 + 60 * k, y: 30 })))
      await new Promise<void>((r) => (land = r))
      return layout(req, (_, k) => ({ x: 30 + 70 * k, y: 40 }))
    })
    stop = setArrangeEngine({ loadModel: async () => ({}), loadParts: async () => ({}), arrangePlate: arrangePlateCall } as unknown as SlicerHost)
    const done = arrangePlate('all')
    // The first layout is on the plate while the engine still checks it.
    await vi.waitFor(() => expect(get().plate.find((p) => p.id === 'b')!.transform).toEqual(at(90, 30)))
    expect(get().arranging).not.toBeNull()
    land()
    await done
    expect(get().plate.find((p) => p.id === 'b')!.transform).toEqual(at(100, 40))
    expect(get().arranging).toBeNull()
    // One undo puts the plate back as it was before Arrange.
    history().undo()
    expect(get().plate.map((p) => p.transform)).toEqual(before)
  })

  it('says why in plain words and moves nothing when the engine refuses the plate', async () => {
    set({ plate: [entry('a', 'Tile A', 40, 10), entry('b', 'Tile B', 40, 20)] })
    const before = get().plate
    engine(() => Promise.reject(new Error('config key plate.arrange.keep: the plate has no object x')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await arrangePlate('all')
    warn.mockRestore()
    expect(get().plate).toBe(before)
    expect(get().arranging).toBeNull()
    const t = get().toast!
    expect(t.text).toBe('Arrange could not lay out this plate, so nothing moved.')
    plain(t.text)
  })

  it('lists names as a person would', () => {
    const plate = ['A', 'B', 'C', 'D', 'E'].map((n) => ({ id: n.toLowerCase(), name: `Part ${n}` }))
    expect(namesOf(['a'], plate)).toBe('Part A')
    expect(namesOf(['a', 'b'], plate)).toBe('Part A and Part B')
    expect(namesOf(['a', 'b', 'c'], plate)).toBe('Part A, Part B and Part C')
    expect(namesOf(['a', 'b', 'c', 'd', 'e'], plate)).toBe('Part A, Part B and 3 more')
  })
})
